#![cfg_attr(coverage_nightly, feature(coverage_attribute))]

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use dappercode_broker::BrokerServer;
#[cfg(test)]
use dappercode_desktop_core::BrokerSettings;
use dappercode_desktop_core::{
    discover_agent_executable, profile_id_for, resolve_bridge_host, setup_profile,
    validate_workspace, AppPaths, BridgeSnapshot, BridgeState,
    BridgeSupervisor as LegacyBridgeSupervisor, BrokerLifecycleAction, BrokerSupervisor, FileLease,
    NetworkMode, Profile, RuntimePaths, SecretStore, SetupRequest,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResponse<T: Serialize> {
    ok: bool,
    result: T,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperatorSnapshot {
    state: String,
    headline: String,
    detail: String,
    bridge_url: Option<String>,
    uptime_sec: Option<u64>,
    connected_clients: usize,
    ready_agents: usize,
    total_agents: usize,
    recent_error_count: usize,
    managed_process: bool,
    auto_start: bool,
    workspace: PathBuf,
    profile_id: String,
    network_mode: Option<String>,
    bridge_host: Option<String>,
    bridge_port: Option<u16>,
    pairing_payload: Option<String>,
    log_path: PathBuf,
    config_path: PathBuf,
    secret_backend: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StopAllResult {
    stopped: usize,
    results: Vec<StopOutcome>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StopOutcome {
    profile_id: String,
    workspace: PathBuf,
    ok: bool,
    detail: String,
}

fn main() {
    if let Err(error) = run() {
        let response = serde_json::json!({
            "ok": false,
            "error": format!("{error:#}"),
        });
        eprintln!("{}", serde_json::to_string(&response).unwrap());
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    let human = take_flag(&mut args, "--human");
    let command = args
        .first()
        .cloned()
        .unwrap_or_else(|| "status".to_string());
    if !args.is_empty() {
        args.remove(0);
    }

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        print_help();
        return Ok(());
    }
    if matches!(command.as_str(), "version" | "--version" | "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    let paths = AppPaths::discover()?;
    let secrets = SecretStore::discover();
    paths.migrate_config()?;

    if command == "__broker" {
        let owner_pid = owner_pid_arg(&mut args)?;
        ensure_no_args(&args)?;
        let settings = paths
            .load_config()?
            .broker
            .context("the desktop broker is not configured; run setup first")?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .context("failed to create broker runtime")?;
        runtime.block_on(BrokerServer::new(paths, secrets, settings, owner_pid).serve())?;
        return Ok(());
    }

    match command.as_str() {
        "list" => {
            let owner_pid = owner_pid_arg(&mut args)?;
            ensure_no_args(&args)?;
            emit(list_profiles(&paths, &secrets, owner_pid)?, human)
        }
        "stop" if take_flag(&mut args, "--all") => {
            let _ = workspace_arg(&mut args)?;
            ensure_no_args(&args)?;
            emit(stop_all(&paths, &secrets)?, human)
        }
        _ => {
            let workspace = workspace_arg(&mut args)?;
            run_workspace_command(&command, workspace, args, human, &paths, &secrets)
        }
    }
}

fn run_workspace_command(
    command: &str,
    workspace: PathBuf,
    mut args: Vec<String>,
    human: bool,
    paths: &AppPaths,
    secrets: &SecretStore,
) -> Result<()> {
    match command {
        "status" => {
            ensure_no_args(&args)?;
            match supervisor(workspace.clone(), paths, secrets, None)? {
                Some(supervisor) => emit(
                    operator_snapshot(&supervisor, supervisor.snapshot(), paths),
                    human,
                ),
                None => emit(unconfigured_snapshot(&workspace, paths)?, human),
            }
        }
        "start" | "stop" | "restart" => {
            let owner_pid = owner_pid_arg(&mut args)?;
            ensure_no_args(&args)?;
            let Some(supervisor) = supervisor(workspace.clone(), paths, secrets, owner_pid)? else {
                bail!("this workspace is not set up yet; run 'dappercode setup' first");
            };
            stop_legacy_bridges(paths, secrets)?;
            let action = match command {
                "start" => BrokerLifecycleAction::Start,
                "stop" => BrokerLifecycleAction::Stop,
                _ => BrokerLifecycleAction::Restart,
            };
            let (snapshot, auto_start) = supervisor.transition_and_remember(action)?;
            let mut response = operator_snapshot(&supervisor, snapshot, paths);
            response.auto_start = auto_start;
            emit(response, human)
        }
        "setup" => run_setup(workspace, args, human, paths, secrets),
        "forget" => {
            ensure_no_args(&args)?;
            emit(forget_profile(workspace, paths, secrets)?, human)
        }
        "discover-agent" => {
            let agent_id = option(&mut args, "--agent-id").unwrap_or_else(|| "opencode".into());
            ensure_no_args(&args)?;
            let executable = discover_agent_executable(&agent_id).with_context(|| {
                format!("{agent_id} is not installed in a standard executable path")
            })?;
            emit(
                serde_json::json!({ "agentId": agent_id, "executable": executable }),
                human,
            )
        }
        _ => bail!("unknown command '{command}'; run 'dappercode help'"),
    }
}

fn run_setup(
    workspace: PathBuf,
    mut args: Vec<String>,
    human: bool,
    paths: &AppPaths,
    secrets: &SecretStore,
) -> Result<()> {
    let network_mode = option(&mut args, "--network").unwrap_or_else(|| "tailscale".into());
    let mode = match network_mode.as_str() {
        "local" => NetworkMode::Local,
        "tailscale" => NetworkMode::Tailscale,
        _ => bail!("--network must be local or tailscale"),
    };
    let host = option(&mut args, "--host")
        .map(Ok)
        .unwrap_or_else(|| resolve_bridge_host(mode, None))?;
    let bridge_port = option(&mut args, "--port")
        .map(|value| {
            value
                .parse::<u16>()
                .context("--port must be a valid TCP port")
        })
        .transpose()?;
    let replace_broker_endpoint = take_flag(&mut args, "--replace-broker-endpoint");
    let agent_id = option(&mut args, "--agent-id").unwrap_or_else(|| "opencode".into());
    let display_name = option(&mut args, "--display-name").unwrap_or_else(|| agent_id.clone());
    let executable = option(&mut args, "--agent-executable")
        .map(PathBuf::from)
        .or_else(|| discover_agent_executable(&agent_id))
        .with_context(|| format!("{agent_id} is not installed; pass --agent-executable"))?;
    let agent_args = option(&mut args, "--agent-args")
        .map(|value| split_args(&value))
        .unwrap_or_else(|| default_agent_args(&agent_id));
    ensure_no_args(&args)?;

    let result = setup_profile(
        SetupRequest {
            workspace,
            network_mode,
            bridge_host: host,
            bridge_port,
            replace_broker_endpoint,
            agent_id,
            display_name,
            executable,
            argv: agent_args,
        },
        paths,
        secrets,
    )?;
    emit(result, human)
}

/// Removes a workspace's profile entirely: its stored token, its profile directory, and its entry
/// in `config.json`. Refuses while that profile's bridge is still running.
fn forget_profile(
    workspace: PathBuf,
    paths: &AppPaths,
    secrets: &SecretStore,
) -> Result<serde_json::Value> {
    let workspace = validate_workspace(&workspace)?;
    let profile_id = profile_id_for(&workspace);
    stop_legacy_bridges(paths, secrets)?;
    let _transition_lease = FileLease::acquire(&paths.broker_transition_lock_path())?;
    let config = paths.load_config()?;
    if let (Some(profile), Some(settings)) =
        (config.find(&profile_id).cloned(), config.broker.clone())
    {
        let broker = BrokerSupervisor::new(profile, settings, paths.clone(), secrets.clone(), None);
        if broker.owns_running_process() {
            bail!("stop the desktop broker before forgetting a workspace");
        }
    }
    let profile_dir = paths.profile_dir(&profile_id);
    let existed = paths.update_config_then(
        |config| Ok(config.remove(&profile_id)),
        || {
            let mut failures = Vec::new();
            if let Err(error) = secrets.delete(paths, &profile_id) {
                failures.push(format!("credential: {error:#}"));
            }
            if profile_dir.exists() {
                if let Err(error) = std::fs::remove_dir_all(&profile_dir)
                    .with_context(|| format!("failed to remove {}", profile_dir.display()))
                {
                    failures.push(format!("profile data: {error:#}"));
                }
            }
            if failures.is_empty() {
                Ok(())
            } else {
                bail!("{}", failures.join("; "))
            }
        },
    )?;

    Ok(serde_json::json!({
        "workspace": workspace,
        "profileId": profile_id,
        "removed": existed,
    }))
}

/// Every configured profile, so the desktop app can show all parallel bridges at once.
fn list_profiles(
    paths: &AppPaths,
    secrets: &SecretStore,
    owner_pid: Option<u32>,
) -> Result<Vec<OperatorSnapshot>> {
    let config = paths.load_config()?;
    let settings = config.broker.clone();
    let shared_snapshot = config.profiles.first().and_then(|profile| {
        settings.clone().map(|settings| {
            BrokerSupervisor::new(
                profile.clone(),
                settings,
                paths.clone(),
                secrets.clone(),
                owner_pid,
            )
            .snapshot()
        })
    });
    let mut snapshots = Vec::new();
    for profile in config.profiles {
        let Some(settings) = settings.clone() else {
            snapshots.push(profile_snapshot(
                &profile,
                BridgeSnapshot::error("DapperCode broker settings were not found."),
                paths,
                None,
                None,
            ));
            continue;
        };
        let supervisor = BrokerSupervisor::new(
            profile.clone(),
            settings,
            paths.clone(),
            secrets.clone(),
            owner_pid,
        );
        let snapshot = shared_snapshot
            .clone()
            .unwrap_or_else(|| supervisor.snapshot());
        snapshots.push(profile_snapshot(&profile, snapshot, paths, None, None));
    }
    Ok(snapshots)
}

/// Stops every bridge this app owns. Used when the desktop app quits, so parallel bridges from
/// different worktrees are all torn down. One failing profile does not abort the rest.
fn stop_all(paths: &AppPaths, secrets: &SecretStore) -> Result<StopAllResult> {
    let config = paths.load_config()?;
    let profiles = config.profiles;
    let mut results = Vec::new();
    let mut stopped = 0;
    if let (Some(profile), Some(settings)) = (profiles.first(), config.broker) {
        let supervisor = BrokerSupervisor::new(
            profile.clone(),
            settings,
            paths.clone(),
            secrets.clone(),
            None,
        );
        if supervisor.owns_running_process() {
            match supervisor.stop() {
                Ok(snapshot) => {
                    stopped = 1;
                    results.push(StopOutcome {
                        profile_id: "broker".to_string(),
                        workspace: profile.workspace.clone(),
                        ok: true,
                        detail: snapshot.headline,
                    });
                }
                Err(error) => results.push(StopOutcome {
                    profile_id: "broker".to_string(),
                    workspace: profile.workspace.clone(),
                    ok: false,
                    detail: format!("{error:#}"),
                }),
            }
        }
    }
    stop_legacy_bridges(paths, secrets)?;
    Ok(StopAllResult { stopped, results })
}

fn stop_legacy_bridges(paths: &AppPaths, secrets: &SecretStore) -> Result<()> {
    let runtime = RuntimePaths::discover()?;
    for profile in paths.load_config()?.profiles {
        let supervisor = LegacyBridgeSupervisor::new(
            profile,
            paths.clone(),
            secrets.clone(),
            runtime.clone(),
            None,
        );
        if supervisor.owns_running_process() {
            supervisor.stop()?;
        }
    }
    Ok(())
}

fn supervisor(
    workspace: PathBuf,
    paths: &AppPaths,
    secrets: &SecretStore,
    owner_pid: Option<u32>,
) -> Result<Option<BrokerSupervisor>> {
    let workspace = validate_workspace(&workspace)?;
    let profile_id = profile_id_for(&workspace);
    let Some(profile) = paths.load_config()?.find(&profile_id).cloned() else {
        return Ok(None);
    };
    let settings = paths
        .load_config()?
        .broker
        .context("broker settings are missing; run setup again")?;
    Ok(Some(BrokerSupervisor::new(
        profile,
        settings,
        paths.clone(),
        secrets.clone(),
        owner_pid,
    )))
}

fn unconfigured_snapshot(workspace: &Path, paths: &AppPaths) -> Result<OperatorSnapshot> {
    let workspace = validate_workspace(workspace)?;
    let profile_id = profile_id_for(&workspace);
    let snapshot = BridgeSnapshot::needs_setup(&workspace);
    let broker = paths.load_config()?.broker;
    Ok(OperatorSnapshot {
        state: state_name(&snapshot.state).to_string(),
        headline: snapshot.headline,
        detail: snapshot.detail,
        bridge_url: None,
        uptime_sec: None,
        connected_clients: 0,
        ready_agents: 0,
        total_agents: 0,
        recent_error_count: 0,
        managed_process: false,
        auto_start: false,
        workspace,
        profile_id,
        network_mode: broker
            .as_ref()
            .map(|settings| settings.network_mode.clone()),
        bridge_host: broker.as_ref().map(|settings| settings.host.clone()),
        bridge_port: broker.as_ref().map(|settings| settings.bridge_port),
        pairing_payload: None,
        log_path: PathBuf::new(),
        config_path: paths.config_path(),
        secret_backend: None,
    })
}

fn operator_snapshot(
    supervisor: &BrokerSupervisor,
    snapshot: BridgeSnapshot,
    paths: &AppPaths,
) -> OperatorSnapshot {
    let runtime_config = supervisor.runtime_config().ok();
    let snapshot = profile_snapshot(
        supervisor.profile(),
        snapshot,
        paths,
        runtime_config.as_ref().and_then(|config| {
            config
                .pairing_payload(&supervisor.profile().profile_id)
                .ok()
        }),
        runtime_config
            .as_ref()
            .map(|config| config.secret_backend.as_str().to_string()),
    );
    with_broker_log_path(snapshot, paths)
}

fn with_broker_log_path(mut snapshot: OperatorSnapshot, paths: &AppPaths) -> OperatorSnapshot {
    snapshot.log_path = paths.broker_log_path();
    snapshot
}

fn profile_snapshot(
    profile: &Profile,
    snapshot: BridgeSnapshot,
    paths: &AppPaths,
    pairing_payload: Option<String>,
    secret_backend: Option<String>,
) -> OperatorSnapshot {
    OperatorSnapshot {
        state: state_name(&snapshot.state).to_string(),
        headline: snapshot.headline,
        detail: snapshot.detail,
        bridge_url: snapshot.url,
        uptime_sec: snapshot.uptime_sec,
        connected_clients: snapshot.connected_clients,
        ready_agents: snapshot.ready_agents,
        total_agents: snapshot.total_agents,
        recent_error_count: snapshot.recent_error_count,
        managed_process: snapshot.managed_process,
        auto_start: profile.auto_start,
        workspace: profile.workspace.clone(),
        profile_id: profile.profile_id.clone(),
        network_mode: Some(profile.network_mode.clone()),
        bridge_host: Some(profile.bridge_host.clone()),
        bridge_port: Some(profile.bridge_port),
        pairing_payload,
        log_path: paths.log_path(&profile.profile_id),
        config_path: paths.config_path(),
        secret_backend,
    }
}

fn state_name(state: &BridgeState) -> &'static str {
    match state {
        BridgeState::NeedsSetup => "needsSetup",
        BridgeState::Stopped => "stopped",
        BridgeState::Running => "running",
        BridgeState::Degraded => "degraded",
        BridgeState::Unhealthy => "unhealthy",
        BridgeState::Inaccessible => "inaccessible",
        BridgeState::Error => "error",
    }
}

fn emit<T: Serialize>(value: T, human: bool) -> Result<()> {
    if human {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        println!(
            "{}",
            serde_json::to_string(&CommandResponse {
                ok: true,
                result: value
            })?
        );
    }
    Ok(())
}

fn workspace_arg(args: &mut Vec<String>) -> Result<PathBuf> {
    let workspace = option(args, "--workspace")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("DAPPERCODE_WORKSPACE_ROOT").map(PathBuf::from))
        .unwrap_or(std::env::current_dir()?);
    Ok(workspace)
}

fn owner_pid_arg(args: &mut Vec<String>) -> Result<Option<u32>> {
    option(args, "--owner-pid")
        .map(|value| {
            let pid = value
                .parse::<u32>()
                .context("--owner-pid must be a process ID")?;
            if pid == 0 {
                bail!("--owner-pid must be a process ID");
            }
            Ok(pid)
        })
        .transpose()
}

fn option(args: &mut Vec<String>, name: &str) -> Option<String> {
    let index = args.iter().position(|argument| argument == name)?;
    if index + 1 >= args.len() {
        return None;
    }
    args.remove(index);
    Some(args.remove(index))
}

fn take_flag(args: &mut Vec<String>, name: &str) -> bool {
    if let Some(index) = args.iter().position(|argument| argument == name) {
        args.remove(index);
        true
    } else {
        false
    }
}

fn ensure_no_args(args: &[String]) -> Result<()> {
    if let Some(argument) = args.first() {
        bail!("unexpected argument '{argument}'");
    }
    Ok(())
}

fn default_agent_args(agent_id: &str) -> Vec<String> {
    match agent_id {
        "opencode" => vec!["acp".to_string()],
        _ => Vec::new(),
    }
}

fn split_args(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn print_help() {
    println!(
        "DapperCode operator\n\n\
Usage: dappercode <command> [--workspace PATH] [--human]\n\n\
Commands:\n\
  status\n\
  list [--owner-pid PID]\n\
  start [--owner-pid PID]\n\
  stop [--all]\n\
  restart [--owner-pid PID]\n\
  setup --host HOST [--network local|tailscale] [--port 8787] [--replace-broker-endpoint]\n\
        [--agent-id opencode] [--agent-executable PATH] [--agent-args 'acp']\n\
  forget\n\
  discover-agent [--agent-id opencode]\n\
  version\n\n\
Configuration lives in the DapperCode data directory, never in your repositories.\n\
Bridge ports are allocated per workspace so several worktrees can run at once.\n"
    );
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_options_and_default_agent_args() {
        let mut args = vec!["--workspace".into(), "/tmp/project".into(), "tail".into()];
        assert_eq!(
            option(&mut args, "--workspace").as_deref(),
            Some("/tmp/project")
        );
        assert_eq!(args, vec!["tail"]);
        assert_eq!(default_agent_args("opencode"), vec!["acp"]);

        let mut missing_value = vec!["--workspace".into()];
        assert_eq!(option(&mut missing_value, "--workspace"), None);
        assert_eq!(missing_value, vec!["--workspace"]);
    }

    #[test]
    fn parses_and_validates_the_owner_pid() {
        let mut args = vec!["--owner-pid".into(), "4321".into()];
        assert_eq!(owner_pid_arg(&mut args).unwrap(), Some(4321));
        assert!(args.is_empty());

        assert_eq!(owner_pid_arg(&mut Vec::new()).unwrap(), None);
        assert!(owner_pid_arg(&mut vec!["--owner-pid".into(), "0".into()]).is_err());
        assert!(owner_pid_arg(&mut vec!["--owner-pid".into(), "nope".into()]).is_err());
    }

    #[test]
    fn recognizes_the_stop_all_flag_without_consuming_other_arguments() {
        let mut args = vec!["--all".into(), "--workspace".into(), "/tmp/project".into()];
        assert!(take_flag(&mut args, "--all"));
        assert_eq!(
            option(&mut args, "--workspace").as_deref(),
            Some("/tmp/project")
        );
        assert!(args.is_empty());
        assert!(!take_flag(&mut Vec::new(), "--all"));
    }

    #[test]
    fn primary_operator_snapshot_opens_the_broker_log() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let snapshot = unconfigured_snapshot(workspace.path(), &paths).unwrap();

        assert_eq!(
            with_broker_log_path(snapshot, &paths).log_path,
            paths.broker_log_path()
        );
    }

    #[test]
    fn unconfigured_workspace_snapshot_exposes_the_shared_endpoint_without_pairing_data() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        paths
            .update_config(|config| {
                config.broker = Some(BrokerSettings::new(
                    "local".to_string(),
                    "192.168.1.20".to_string(),
                    18_787,
                    18_788,
                    "http://192.168.1.20:18787".to_string(),
                    "http://192.168.1.20:18788".to_string(),
                )?);
                Ok(())
            })
            .unwrap();

        let snapshot = unconfigured_snapshot(workspace.path(), &paths).unwrap();

        assert_eq!(snapshot.network_mode.as_deref(), Some("local"));
        assert_eq!(snapshot.bridge_host.as_deref(), Some("192.168.1.20"));
        assert_eq!(snapshot.bridge_port, Some(18_787));
        assert!(snapshot.pairing_payload.is_none());
        let json = serde_json::to_value(snapshot).unwrap();
        assert_eq!(json["networkMode"], "local");
        assert_eq!(json["bridgeHost"], "192.168.1.20");
        assert_eq!(json["bridgePort"], 18_787);
        assert!(json["pairingPayload"].is_null());
    }
}
