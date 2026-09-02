use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    broker_supervisor::clean_stale_broker_ownership,
    config::{
        allocate_broker_replacement_ports, allocate_port_pair, allocate_preview_port, format_host,
        validate_workspace,
    },
    platform,
    secrets::{BridgeSecret, SecretStore},
    store::{
        atomic_private_write, profile_id_for, remove_file_if_exists, AppPaths, BrokerSettings,
        ConfigSideEffects, FileLease, Profile, ProfileAgent,
    },
};

#[derive(Clone, Debug)]
pub struct SetupRequest {
    pub workspace: PathBuf,
    pub network_mode: String,
    pub bridge_host: String,
    pub bridge_port: Option<u16>,
    pub replace_broker_endpoint: bool,
    pub agent_id: String,
    pub display_name: String,
    pub executable: PathBuf,
    pub argv: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    pub workspace: PathBuf,
    pub profile_id: String,
    pub bridge_url: String,
    pub bridge_port: u16,
    pub preview_port: u16,
    pub agent_id: String,
    pub agent_version: String,
    pub executable: PathBuf,
    pub config_path: PathBuf,
    pub secret_backend: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentManifestSet {
    preferred_agent_id: String,
    agents: Vec<AgentManifest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentManifest {
    enabled: bool,
    display_name: String,
    icon: Option<String>,
    agent_id: String,
    executable: PathBuf,
    argv: Vec<String>,
    environment: BTreeMap<String, serde_json::Value>,
    resolved_version: String,
    provenance: String,
    verified_digest: String,
    integrity: ExecutableIntegrity,
}

#[derive(Serialize)]
struct ExecutableIntegrity {
    kind: &'static str,
}

struct SetupSideEffects<'a> {
    paths: &'a AppPaths,
    secrets: &'a SecretStore,
    profile_id: &'a str,
    manifest: Vec<u8>,
    previous_manifest: Option<Option<Vec<u8>>>,
    secret_created: Option<bool>,
}

impl ConfigSideEffects for SetupSideEffects<'_> {
    type Output = BridgeSecret;

    fn apply(&mut self) -> Result<Self::Output> {
        let manifest_path = self.paths.manifest_path(self.profile_id);
        let previous_manifest = match fs::read(&manifest_path) {
            Ok(contents) => Some(contents),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to read {}", manifest_path.display()))
            }
        };
        self.previous_manifest = Some(previous_manifest);

        let (secret, created) = self
            .secrets
            .get_or_create_with_status(self.paths, self.profile_id)?;
        self.secret_created = Some(created);
        atomic_private_write(&manifest_path, &self.manifest)?;
        Ok(secret)
    }

    fn rollback(&mut self) -> Result<()> {
        let mut failures = Vec::new();
        if let Some(previous_manifest) = self.previous_manifest.take() {
            let path = self.paths.manifest_path(self.profile_id);
            let result = match previous_manifest {
                Some(contents) => atomic_private_write(&path, &contents),
                None => remove_file_if_exists(&path),
            };
            if let Err(error) = result {
                failures.push(format!("manifest: {error:#}"));
            }
        }
        if self.secret_created.take() == Some(true) {
            if let Err(error) = self.secrets.delete(self.paths, self.profile_id) {
                failures.push(format!("credential: {error:#}"));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            bail!("{}", failures.join("; "))
        }
    }
}

/// Registers a workspace with the central store.
///
/// Nothing is written into the workspace itself: the manifest lands in the profile directory, the
/// non-secret settings land in `config.json`, and the bridge token lands in the keychain.
pub fn setup_profile(
    request: SetupRequest,
    paths: &AppPaths,
    secrets: &SecretStore,
) -> Result<SetupResult> {
    if !valid_agent_id(&request.agent_id) {
        bail!("agent ID may contain only letters, numbers, dots, underscores, and dashes");
    }
    if request.display_name.trim().is_empty() {
        bail!("agent display name must not be empty");
    }
    if !matches!(request.network_mode.as_str(), "local" | "tailscale") {
        bail!("network mode must be local or tailscale");
    }
    if matches!(request.bridge_port, Some(port) if port == 0 || port == u16::MAX) {
        bail!("bridge port must leave room for the adjacent preview port");
    }
    let host = normalize_host(&request.bridge_host)?;
    for argument in &request.argv {
        if argument.contains(['\n', '\r', '\0']) {
            bail!("agent arguments must not contain control characters");
        }
    }

    let workspace = validate_workspace(&request.workspace)?;
    let executable = request.executable.canonicalize().with_context(|| {
        format!(
            "agent executable not found: {}",
            request.executable.display()
        )
    })?;
    if !executable.is_file() {
        bail!("agent executable must be a regular file");
    }
    executable
        .parent()
        .context("agent executable has no parent directory")?;
    let digest = file_digest(&executable)?;
    let version = executable_version(&executable);

    let profile_id = profile_id_for(&workspace);
    paths.prepare_profile(&profile_id)?;

    let manifest = AgentManifestSet {
        preferred_agent_id: request.agent_id.clone(),
        agents: vec![AgentManifest {
            enabled: true,
            display_name: request.display_name.trim().to_string(),
            icon: None,
            agent_id: request.agent_id.clone(),
            executable: executable.clone(),
            argv: request.argv.clone(),
            environment: BTreeMap::new(),
            resolved_version: version.clone(),
            provenance: "registered by DapperCode desktop operator".to_string(),
            verified_digest: digest.clone(),
            integrity: ExecutableIntegrity { kind: "executable" },
        }],
    };
    let mut side_effects = SetupSideEffects {
        paths,
        secrets,
        profile_id: &profile_id,
        manifest: serde_json::to_vec_pretty(&manifest)?,
        previous_manifest: None,
        secret_created: None,
    };
    let _transition_lease = FileLease::acquire(&paths.broker_transition_lock_path())?;
    let (profile, secret) = paths.update_config_with_side_effects(
        |config| {
        let broker = match config.broker.clone() {
            Some(mut broker) => {
                let endpoint_changed = request
                    .bridge_port
                    .is_some_and(|port| port != broker.bridge_port)
                    || host != broker.host
                    || request.network_mode != broker.network_mode;
                if endpoint_changed && request.replace_broker_endpoint {
                    if clean_stale_broker_ownership(paths)? {
                        bail!("stop the desktop broker before replacing its endpoint");
                    }
                    let (bridge_port, preview_port) = allocate_broker_replacement_ports(
                        config,
                        &host,
                        broker.bridge_port,
                        broker.preview_port,
                        request.bridge_port,
                    )?;
                    let authority = format_host(&host);
                    let mut replacement = BrokerSettings::new(
                        request.network_mode.clone(),
                        host.clone(),
                        bridge_port,
                        preview_port,
                        format!("http://{authority}:{bridge_port}"),
                        format!("http://{authority}:{preview_port}"),
                    )?;
                    replacement.auto_start = broker.auto_start;
                    replacement.max_workers = broker.max_workers;
                    replacement.max_idle_workers = broker.max_idle_workers;
                    replacement.worker_idle_grace_ms = broker.worker_idle_grace_ms;
                    replacement.worker_start_timeout_ms = broker.worker_start_timeout_ms;
                    replacement
                        .legacy_bridge_endpoints
                        .append(&mut broker.legacy_bridge_endpoints);
                    replacement.legacy_bridge_endpoints.push(
                        crate::store::BrokerEndpoint {
                            host: broker.host,
                            port: broker.bridge_port,
                        },
                    );
                    replacement.legacy_bridge_endpoints.sort_by(|left, right| {
                        left.host
                            .cmp(&right.host)
                            .then_with(|| left.port.cmp(&right.port))
                    });
                    replacement.legacy_bridge_endpoints.dedup();
                    for existing in &mut config.profiles {
                        replacement.apply_endpoint(existing);
                    }
                    config.broker = Some(replacement.clone());
                    replacement
                } else {
                    if endpoint_changed {
                        bail!(
                            "all workspaces use the desktop broker at {}; pass --replace-broker-endpoint while it is stopped to change it",
                            broker.connect_url
                        );
                    }
                    broker
                }
            }
            None => {
                let (bridge_port, preview_port) =
                    allocate_port_pair(
                        config,
                        &profile_id,
                        &host,
                        request.bridge_port,
                        request.bridge_port.is_some(),
                    )?;
                let authority = format_host(&host);
                let broker = BrokerSettings::new(
                    request.network_mode.clone(),
                    host.clone(),
                    bridge_port,
                    preview_port,
                    format!("http://{authority}:{bridge_port}"),
                    format!("http://{authority}:{preview_port}"),
                )?;
                config.broker = Some(broker.clone());
                broker
            }
        };
        let preview_port = allocate_preview_port(
            config,
            &profile_id,
            &broker.host,
            broker.preview_port,
        )?;
        let authority = format_host(&broker.host);
        let profile = Profile {
            profile_id: profile_id.clone(),
            workspace: workspace.clone(),
            network_mode: broker.network_mode.clone(),
            bridge_host: broker.host.clone(),
            bridge_port: broker.bridge_port,
            preview_port,
            connect_url: broker.connect_url.clone(),
            preview_connect_url: format!("http://{authority}:{preview_port}"),
            auto_start: config
                .find(&profile_id)
                .map(|profile| profile.auto_start)
                .unwrap_or(false),
            allow_query_token_auth: true,
            acp_initialize_timeout_ms: 15_000,
            agent: ProfileAgent {
                agent_id: request.agent_id.clone(),
                display_name: request.display_name.trim().to_string(),
                executable: executable.clone(),
                argv: request.argv.clone(),
                resolved_version: version.clone(),
                verified_digest: digest.clone(),
            },
            updated_at: now_iso8601(),
        };
        config.upsert(profile.clone());
        Ok(profile)
    },
        &mut side_effects,
    )?;

    Ok(SetupResult {
        workspace,
        profile_id,
        bridge_url: profile.connect_url,
        bridge_port: profile.bridge_port,
        preview_port: profile.preview_port,
        agent_id: request.agent_id,
        agent_version: version,
        executable,
        config_path: paths.config_path(),
        secret_backend: secret.backend.as_str(),
    })
}

pub fn discover_agent_executable(agent_id: &str) -> Option<PathBuf> {
    let executable_name = platform::agent_executable_name(agent_id);
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    directories.extend(platform::agent_search_roots());
    directories
        .into_iter()
        .map(|directory| directory.join(&executable_name))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| candidate.canonicalize().ok())
}

/// The re-registration performed after an installed agent changed underneath a workspace.
#[derive(Clone, Debug)]
pub struct AgentRefresh {
    pub agent_id: String,
    pub previous_version: String,
    pub resolved_version: String,
    pub executable: PathBuf,
}

/// Re-registers a workspace's agent when its installed executable changed, such as after a
/// package-manager upgrade.
///
/// Setup pins the canonical executable path and digest, but package managers install each release
/// under a versioned directory and only keep the launcher directory stable. An upgrade therefore
/// invalidates both halves of the pin at once and would otherwise brick every workspace runtime
/// until setup was rerun by hand.
///
/// Re-registration stays an operator decision rather than becoming implicit trust: the replacement
/// must be published by one of the platform's trusted agent directories and must not be writable by
/// other users. The bridge still recomputes and fails closed on the digest it is handed, so a
/// tampered binary at an unchanged path is still rejected.
pub fn refresh_registered_agent(
    paths: &AppPaths,
    profile_id: &str,
) -> Result<Option<AgentRefresh>> {
    refresh_registered_agent_within(paths, profile_id, &platform::agent_search_roots())
}

fn refresh_registered_agent_within(
    paths: &AppPaths,
    profile_id: &str,
    search_roots: &[PathBuf],
) -> Result<Option<AgentRefresh>> {
    let agent = paths
        .load_config()?
        .find(profile_id)
        .with_context(|| format!("workspace profile {profile_id} is not configured"))?
        .agent
        .clone();
    if registered_agent_is_current(&agent) {
        return Ok(None);
    }

    let executable = trusted_agent_executable(&agent.agent_id, search_roots).with_context(|| {
        format!(
            "the registered {} executable is no longer installed and no trusted replacement was found; run setup again",
            agent.agent_id
        )
    })?;
    let verified_digest = file_digest(&executable)?;
    if executable == agent.executable && verified_digest == agent.verified_digest {
        return Ok(None);
    }
    let resolved_version = executable_version(&executable);

    let mut side_effects = ManifestRefreshSideEffects {
        paths,
        profile_id,
        agent_id: agent.agent_id.clone(),
        executable: executable.clone(),
        resolved_version: resolved_version.clone(),
        verified_digest: verified_digest.clone(),
        previous_manifest: None,
    };
    let owned_profile_id = profile_id.to_string();
    let recorded_executable = executable.clone();
    let recorded_version = resolved_version.clone();
    paths.update_config_with_side_effects(
        move |config| {
            let profile = config
                .profiles
                .iter_mut()
                .find(|profile| profile.profile_id == owned_profile_id)
                .with_context(|| {
                    format!("workspace profile {owned_profile_id} disappeared during agent refresh")
                })?;
            profile.agent.executable = recorded_executable;
            profile.agent.resolved_version = recorded_version;
            profile.agent.verified_digest = verified_digest;
            Ok(())
        },
        &mut side_effects,
    )?;

    Ok(Some(AgentRefresh {
        agent_id: agent.agent_id,
        previous_version: agent.resolved_version,
        resolved_version,
        executable,
    }))
}

/// Rewrites only the refreshed agent's identity fields so unrelated manifest entries survive.
struct ManifestRefreshSideEffects<'a> {
    paths: &'a AppPaths,
    profile_id: &'a str,
    agent_id: String,
    executable: PathBuf,
    resolved_version: String,
    verified_digest: String,
    previous_manifest: Option<Vec<u8>>,
}

impl ConfigSideEffects for ManifestRefreshSideEffects<'_> {
    type Output = ();

    fn apply(&mut self) -> Result<()> {
        let manifest_path = self.paths.manifest_path(self.profile_id);
        let contents = fs::read(&manifest_path)
            .with_context(|| format!("failed to read {}", manifest_path.display()))?;
        let mut manifest: serde_json::Value = serde_json::from_slice(&contents)
            .with_context(|| format!("invalid agent manifest at {}", manifest_path.display()))?;
        let agents = manifest
            .get_mut("agents")
            .and_then(serde_json::Value::as_array_mut)
            .context("the agent manifest does not list any agents")?;
        let entry = agents
            .iter_mut()
            .filter_map(serde_json::Value::as_object_mut)
            .find(|entry| {
                entry.get("agentId").and_then(serde_json::Value::as_str) == Some(&self.agent_id)
            })
            .with_context(|| format!("the agent manifest has no {} entry", self.agent_id))?;
        entry.insert(
            "executable".to_string(),
            serde_json::Value::String(path_to_manifest_string(&self.executable)?),
        );
        entry.insert(
            "resolvedVersion".to_string(),
            serde_json::Value::String(self.resolved_version.clone()),
        );
        entry.insert(
            "verifiedDigest".to_string(),
            serde_json::Value::String(self.verified_digest.clone()),
        );
        self.previous_manifest = Some(contents);
        atomic_private_write(&manifest_path, &serde_json::to_vec_pretty(&manifest)?)
    }

    fn rollback(&mut self) -> Result<()> {
        let Some(previous_manifest) = self.previous_manifest.take() else {
            return Ok(());
        };
        atomic_private_write(
            &self.paths.manifest_path(self.profile_id),
            &previous_manifest,
        )
    }
}

fn path_to_manifest_string(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .context("agent executable path is not valid UTF-8")
}

fn registered_agent_is_current(agent: &ProfileAgent) -> bool {
    agent.executable.is_file()
        && file_digest(&agent.executable)
            .map(|digest| digest == agent.verified_digest)
            .unwrap_or(false)
}

/// Resolves the agent through a platform-trusted launcher directory.
///
/// The launcher entry is the part a package manager keeps stable across upgrades, so it is the only
/// location an automatic re-registration will accept. The resolved target must still be a regular
/// file that other users cannot rewrite.
fn trusted_agent_executable(agent_id: &str, search_roots: &[PathBuf]) -> Option<PathBuf> {
    let executable_name = platform::agent_executable_name(agent_id);
    search_roots
        .iter()
        .map(|directory| directory.join(&executable_name))
        .filter(|candidate| candidate.is_file())
        .find_map(|candidate| {
            let canonical = candidate.canonicalize().ok()?;
            (canonical.is_file() && !is_writable_by_other_users(&canonical)).then_some(canonical)
        })
}

#[cfg(unix)]
fn is_writable_by_other_users(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path)
        .map(|metadata| metadata.permissions().mode() & 0o022 != 0)
        .unwrap_or(true)
}

#[cfg(not(unix))]
fn is_writable_by_other_users(_path: &Path) -> bool {
    false
}

fn normalize_host(host: &str) -> Result<String> {
    let host = host.trim();
    if host.trim().is_empty()
        || host.contains(['\n', '\r', '\0', '/', '@'])
        || host.chars().any(char::is_whitespace)
    {
        bail!("bridge host must be a concrete IP address or hostname");
    }
    if host.starts_with('[') || host.ends_with(']') {
        if !(host.starts_with('[') && host.ends_with(']')) {
            bail!("bridge host has malformed IPv6 brackets");
        }
        let inner = &host[1..host.len() - 1];
        if inner.parse::<std::net::Ipv6Addr>().is_err() {
            bail!("bracketed bridge host must be a valid IPv6 address");
        }
        return Ok(inner.to_string());
    }
    Ok(host.to_string())
}

fn valid_agent_id(agent_id: &str) -> bool {
    !agent_id.is_empty()
        && agent_id.len() <= 128
        && agent_id != "."
        && agent_id != ".."
        && agent_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
}

fn file_digest(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn executable_version(executable: &Path) -> String {
    Command::new(executable)
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            let value = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            (!value.is_empty() && value.len() <= 2048).then_some(value)
        })
        .unwrap_or_else(|| "local".to_string())
}

fn now_iso8601() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = seconds / 86_400;
    let time_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60
    )
}

/// Howard Hinnant's civil-from-days algorithm, so a timestamp needs no extra dependency.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = (z - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> SecretStore {
        SecretStore::file_backend_for_tests()
    }

    fn request(workspace: &Path, port: Option<u16>) -> SetupRequest {
        SetupRequest {
            workspace: workspace.to_path_buf(),
            network_mode: "local".to_string(),
            bridge_host: "192.168.1.20".to_string(),
            bridge_port: port,
            replace_broker_endpoint: false,
            agent_id: "echo-agent".to_string(),
            display_name: "Echo Agent".to_string(),
            executable: PathBuf::from("/bin/echo"),
            argv: vec!["acp".to_string()],
        }
    }

    #[test]
    fn writes_the_profile_centrally_and_leaves_the_workspace_untouched() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());

        let result =
            setup_profile(request(workspace.path(), Some(18787)), &paths, &store()).unwrap();

        assert_eq!(result.bridge_port, 18787);
        assert_eq!(result.preview_port, 18788);
        assert_eq!(result.bridge_url, "http://192.168.1.20:18787");
        assert!(!workspace.path().join(".env.secure").exists());
        assert!(!workspace.path().join(".dappercode").exists());

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(paths.manifest_path(&result.profile_id)).unwrap())
                .unwrap();
        assert_eq!(manifest["preferredAgentId"], "echo-agent");
        assert_eq!(manifest["agents"][0]["integrity"]["kind"], "executable");
        assert!(manifest["agents"][0]["verifiedDigest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
    }

    #[test]
    fn reuses_the_token_and_ports_across_repeated_setups() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let secrets = store();

        let first =
            setup_profile(request(workspace.path(), Some(18821)), &paths, &secrets).unwrap();
        let first_token = secrets
            .get(&paths, &first.profile_id)
            .unwrap()
            .unwrap()
            .token;

        let second = setup_profile(request(workspace.path(), None), &paths, &secrets).unwrap();
        let second_token = secrets
            .get(&paths, &second.profile_id)
            .unwrap()
            .unwrap()
            .token;

        assert_eq!(first.profile_id, second.profile_id);
        assert_eq!(first.bridge_port, second.bridge_port);
        assert_eq!(first_token, second_token);
        assert_eq!(paths.load_config().unwrap().profiles.len(), 1);
    }

    #[test]
    fn gives_parallel_worktrees_distinct_profiles_on_one_broker_endpoint() {
        let alpha = tempdir().unwrap();
        let beta = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let secrets = store();

        let first = setup_profile(request(alpha.path(), None), &paths, &secrets).unwrap();
        let second = setup_profile(request(beta.path(), None), &paths, &secrets).unwrap();

        assert_ne!(first.profile_id, second.profile_id);
        assert_eq!(first.bridge_port, second.bridge_port);
        assert_ne!(first.preview_port, second.preview_port);
        assert_ne!(
            secrets
                .get(&paths, &first.profile_id)
                .unwrap()
                .unwrap()
                .token,
            secrets
                .get(&paths, &second.profile_id)
                .unwrap()
                .unwrap()
                .token
        );
        assert_eq!(paths.load_config().unwrap().profiles.len(), 2);
    }

    #[test]
    fn normalizes_bracketed_ipv6_before_building_urls() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let mut input = request(workspace.path(), Some(18831));
        input.bridge_host = "[::1]".to_string();

        let result = setup_profile(input, &paths, &store()).unwrap();
        let config = paths.load_config().unwrap();
        let profile = config.find(&result.profile_id).unwrap();

        assert_eq!(profile.bridge_host, "::1");
        assert_eq!(profile.connect_url, "http://[::1]:18831");
        assert_eq!(profile.preview_connect_url, "http://[::1]:18832");
        assert!(normalize_host("[::1").is_err());
        assert!(normalize_host("::1]").is_err());
    }

    #[test]
    fn formats_timestamps_as_utc_iso8601() {
        let value = now_iso8601();
        assert_eq!(value.len(), 20);
        assert!(value.ends_with('Z'));
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(59), (1970, 3, 1));
    }

    #[test]
    fn rejects_invalid_agent_identity_and_network_settings() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let secrets = store();

        type Mutation = Box<dyn Fn(&mut SetupRequest)>;
        let cases: [(Mutation, &str); 7] = [
            (
                Box::new(|request| request.agent_id = "bad id".to_string()),
                "agent ID",
            ),
            (
                Box::new(|request| request.agent_id = "..".to_string()),
                "agent ID",
            ),
            (
                Box::new(|request| request.display_name = "  ".to_string()),
                "display name",
            ),
            (
                Box::new(|request| request.network_mode = "carrier-pigeon".to_string()),
                "network mode",
            ),
            (
                Box::new(|request| request.bridge_port = Some(0)),
                "bridge port",
            ),
            (
                Box::new(|request| request.bridge_port = Some(u16::MAX)),
                "bridge port",
            ),
            (
                Box::new(|request| request.argv = vec!["bad\narg".to_string()]),
                "control characters",
            ),
        ];

        for (mutate, expected) in cases {
            let mut input = request(workspace.path(), Some(18841));
            mutate(&mut input);
            let error = setup_profile(input, &paths, &secrets).unwrap_err();
            assert!(
                error.to_string().contains(expected),
                "expected {expected:?} in {error}"
            );
        }
        assert!(paths.load_config().unwrap().profiles.is_empty());
    }

    #[test]
    fn rejects_hosts_that_are_not_concrete_addresses() {
        for host in ["", "   ", "host name", "user@host", "host/path", "ho\nst"] {
            assert!(normalize_host(host).is_err(), "accepted {host:?}");
        }
        assert!(normalize_host("[not-ipv6]").is_err());
        assert_eq!(normalize_host(" 127.0.0.1 ").unwrap(), "127.0.0.1");
        assert_eq!(normalize_host("[fd00::1]").unwrap(), "fd00::1");
    }

    #[test]
    fn rejects_an_agent_executable_that_is_missing_or_not_a_file() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());

        let mut missing = request(workspace.path(), Some(18843));
        missing.executable = workspace.path().join("no-such-agent");
        assert!(setup_profile(missing, &paths, &store())
            .unwrap_err()
            .to_string()
            .contains("agent executable not found"));

        let mut directory = request(workspace.path(), Some(18843));
        directory.executable = workspace.path().to_path_buf();
        assert!(setup_profile(directory, &paths, &store())
            .unwrap_err()
            .to_string()
            .contains("must be a regular file"));
    }

    #[test]
    fn rejects_a_workspace_that_does_not_exist() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let mut input = request(&workspace.path().join("missing"), Some(18845));
        input.bridge_port = Some(18845);

        assert!(setup_profile(input, &paths, &store())
            .unwrap_err()
            .to_string()
            .contains("workspace does not exist"));
    }

    #[test]
    fn refuses_a_second_workspace_that_requests_a_different_broker_port() {
        let alpha = tempdir().unwrap();
        let beta = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let secrets = store();

        setup_profile(request(alpha.path(), Some(18847)), &paths, &secrets).unwrap();
        let error = setup_profile(request(beta.path(), Some(18849)), &paths, &secrets).unwrap_err();

        assert!(error.to_string().contains("pass --replace-broker-endpoint"));
        assert_eq!(paths.load_config().unwrap().profiles.len(), 1);
        let mut host_change = request(alpha.path(), Some(18847));
        host_change.bridge_host = "127.0.0.1".to_string();
        assert!(setup_profile(host_change, &paths, &secrets)
            .unwrap_err()
            .to_string()
            .contains("pass --replace-broker-endpoint"));

        let profile_id = profile_id_for(&alpha.path().canonicalize().unwrap());
        let manifest_path = paths.manifest_path(&profile_id);
        let manifest_before = fs::read(&manifest_path).unwrap();
        let mut rejected = request(alpha.path(), Some(18849));
        rejected.agent_id = "replacement-agent".to_string();
        rejected.display_name = "Replacement Agent".to_string();
        rejected.argv = vec!["replacement".to_string()];
        assert!(setup_profile(rejected, &paths, &secrets).is_err());
        assert_eq!(fs::read(manifest_path).unwrap(), manifest_before);
    }

    #[test]
    fn setup_side_effect_rollback_restores_manifest_and_removes_new_credential() {
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let secrets = store();
        let profile_id = "rollback-profile";
        paths.prepare_profile(profile_id).unwrap();
        let manifest_path = paths.manifest_path(profile_id);
        fs::write(&manifest_path, b"previous manifest\n").unwrap();
        let mut side_effects = SetupSideEffects {
            paths: &paths,
            secrets: &secrets,
            profile_id,
            manifest: b"replacement manifest".to_vec(),
            previous_manifest: None,
            secret_created: None,
        };

        side_effects.apply().unwrap();
        assert_eq!(fs::read(&manifest_path).unwrap(), b"replacement manifest\n");
        assert!(secrets.get(&paths, profile_id).unwrap().is_some());

        side_effects.rollback().unwrap();
        assert_eq!(fs::read(&manifest_path).unwrap(), b"previous manifest\n");
        assert!(secrets.get(&paths, profile_id).unwrap().is_none());
    }

    #[test]
    fn setup_serializes_endpoint_changes_with_broker_transitions() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let transition = FileLease::acquire(&paths.broker_transition_lock_path()).unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker_paths = paths.clone();
        let workspace_path = workspace.path().to_path_buf();
        let setup = std::thread::spawn(move || {
            let result = setup_profile(request(&workspace_path, None), &worker_paths, &store());
            done_tx.send(result).unwrap();
        });

        assert!(done_rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        drop(transition);
        done_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
            .unwrap();
        setup.join().unwrap();
    }

    #[test]
    fn replaces_a_stopped_broker_endpoint_and_preserves_the_old_alias() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let secrets = store();
        setup_profile(request(workspace.path(), Some(18847)), &paths, &secrets).unwrap();

        let mut replacement = request(workspace.path(), Some(18857));
        replacement.bridge_host = "127.0.0.1".to_string();
        replacement.replace_broker_endpoint = true;
        let ownership_path = paths.broker_ownership_path();
        fs::create_dir_all(ownership_path.parent().unwrap()).unwrap();
        fs::write(&ownership_path, b"owned").unwrap();
        assert!(setup_profile(replacement.clone(), &paths, &secrets)
            .unwrap_err()
            .to_string()
            .contains("invalid broker ownership record"));
        fs::remove_file(ownership_path).unwrap();
        let result = setup_profile(replacement, &paths, &secrets).unwrap();
        let config = paths.load_config().unwrap();
        let broker = config.broker.unwrap();

        assert_eq!(result.bridge_url, "http://127.0.0.1:18857");
        assert_eq!(broker.bridge_port, 18857);
        assert!(broker
            .legacy_bridge_endpoints
            .iter()
            .any(|endpoint| endpoint.host == "192.168.1.20" && endpoint.port == 18847));
        assert!(config.profiles[0]
            .preview_connect_url
            .starts_with("http://127.0.0.1:"));
    }

    #[test]
    fn replaces_a_shared_endpoint_without_treating_other_profile_copies_as_conflicts() {
        let first_workspace = tempdir().unwrap();
        let second_workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let secrets = store();
        setup_profile(
            request(first_workspace.path(), Some(18_867)),
            &paths,
            &secrets,
        )
        .unwrap();
        setup_profile(
            request(second_workspace.path(), Some(18_867)),
            &paths,
            &secrets,
        )
        .unwrap();

        let mut replacement = request(second_workspace.path(), Some(18_867));
        replacement.bridge_host = "127.0.0.2".to_string();
        replacement.replace_broker_endpoint = true;
        let result = setup_profile(replacement, &paths, &secrets).unwrap();

        assert_eq!(result.bridge_port, 18_867);
        let config = paths.load_config().unwrap();
        assert_eq!(config.profiles.len(), 2);
        assert!(config
            .profiles
            .iter()
            .all(|profile| profile.bridge_port == 18_867));
        assert!(config
            .profiles
            .iter()
            .all(|profile| profile.bridge_host == "127.0.0.2"));
    }

    #[test]
    fn records_the_reported_agent_version_and_digest() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());

        // `/bin/echo --version` prints its argument rather than failing, so this exercises the
        // successful version-probe path.
        let result =
            setup_profile(request(workspace.path(), Some(18849)), &paths, &store()).unwrap();
        assert_eq!(result.agent_version, "--version");
        assert_eq!(result.secret_backend, "file");
        assert_eq!(result.config_path, paths.config_path());

        let profile = paths
            .load_config()
            .unwrap()
            .find(&result.profile_id)
            .cloned()
            .unwrap();
        assert!(profile.agent.verified_digest.starts_with("sha256:"));
        assert_eq!(profile.agent.argv, vec!["acp".to_string()]);
        assert_eq!(profile.acp_initialize_timeout_ms, 15_000);
        assert!(profile.allow_query_token_auth);
    }

    #[test]
    fn falls_back_to_a_local_version_when_the_agent_cannot_report_one() {
        let temp = tempdir().unwrap();
        let broken = temp.path().join("broken-agent");
        std::fs::write(&broken, b"not an executable").unwrap();
        assert_eq!(executable_version(&broken), "local");
        assert_eq!(executable_version(&PathBuf::from("/bin/false")), "local");
        // A command that succeeds but prints nothing also falls back.
        assert_eq!(executable_version(&PathBuf::from("/usr/bin/true")), "local");
    }

    #[test]
    fn converts_days_before_and_after_the_epoch() {
        assert_eq!(civil_from_days(-719_468), (0, 3, 1));
        assert_eq!(civil_from_days(-719_528), (0, 1, 1));
        assert_eq!(civil_from_days(-1_000_000), (-768, 2, 4));
        assert_eq!(civil_from_days(365), (1971, 1, 1));
    }

    #[test]
    fn discovers_an_agent_on_the_path_but_not_a_fictional_one() {
        assert!(discover_agent_executable("echo").is_some());
        assert!(discover_agent_executable("dappercode-not-a-real-agent").is_none());
    }

    #[test]
    fn accepts_only_safe_agent_identifiers() {
        assert!(valid_agent_id("opencode"));
        assert!(valid_agent_id("open.code_v2-1"));
        assert!(!valid_agent_id(""));
        assert!(!valid_agent_id("."));
        assert!(!valid_agent_id(".."));
        assert!(!valid_agent_id("has/slash"));
        assert!(!valid_agent_id(&"a".repeat(129)));
    }

    /// Publishes a versioned release the way a package manager does, returning its executable.
    #[cfg(unix)]
    fn publish_release(install_root: &Path, version: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let release = install_root.join("pkg").join(version).join("bin");
        fs::create_dir_all(&release).unwrap();
        let executable = release.join("agent");
        fs::write(&executable, format!("#!/bin/sh\necho {version}\n")).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        executable
    }

    #[cfg(unix)]
    fn register_launcher_agent(
        paths: &AppPaths,
        workspace: &Path,
        launcher: &Path,
        port: u16,
    ) -> String {
        let mut setup_request = request(workspace, Some(port));
        setup_request.agent_id = "agent".to_string();
        setup_request.display_name = "Agent".to_string();
        setup_request.executable = launcher.to_path_buf();
        setup_request.argv = Vec::new();
        setup_profile(setup_request, paths, &store())
            .unwrap()
            .profile_id
    }

    #[cfg(unix)]
    #[test]
    fn an_upgraded_agent_is_re_registered_from_its_trusted_launcher_directory() {
        use std::os::unix::fs::symlink;

        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let install = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let launcher_dir = install.path().join("bin");
        fs::create_dir_all(&launcher_dir).unwrap();
        let launcher = launcher_dir.join("agent");
        let first = publish_release(install.path(), "1.0");
        symlink(&first, &launcher).unwrap();

        let profile_id = register_launcher_agent(&paths, workspace.path(), &launcher, 18871);
        let search_roots = vec![launcher_dir.clone()];
        assert!(
            refresh_registered_agent_within(&paths, &profile_id, &search_roots)
                .unwrap()
                .is_none(),
            "an unchanged installation must not be re-registered"
        );

        // A package-manager upgrade publishes a new versioned release, repoints the stable launcher
        // entry at it, and removes the release the profile pinned.
        let second = publish_release(install.path(), "2.0");
        fs::remove_file(&launcher).unwrap();
        symlink(&second, &launcher).unwrap();
        fs::remove_dir_all(install.path().join("pkg").join("1.0")).unwrap();

        let refresh = refresh_registered_agent_within(&paths, &profile_id, &search_roots)
            .unwrap()
            .expect("an upgraded agent must be re-registered");
        let upgraded = second.canonicalize().unwrap();
        assert_eq!(refresh.agent_id, "agent");
        assert_eq!(refresh.executable, upgraded);
        assert_ne!(refresh.previous_version, refresh.resolved_version);

        let profile = paths
            .load_config()
            .unwrap()
            .find(&profile_id)
            .cloned()
            .unwrap();
        let upgraded_digest = file_digest(&upgraded).unwrap();
        assert_eq!(profile.agent.executable, upgraded);
        assert_eq!(profile.agent.verified_digest, upgraded_digest);
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(paths.manifest_path(&profile_id)).unwrap()).unwrap();
        assert_eq!(
            manifest["agents"][0]["verifiedDigest"].as_str(),
            Some(upgraded_digest.as_str())
        );
        assert_eq!(
            manifest["agents"][0]["executable"].as_str(),
            upgraded.to_str()
        );

        // Building the runtime again is what actually unblocks a waiting device.
        crate::config::BridgeRuntimeConfig::from_profile(
            &profile,
            "token",
            crate::secrets::SecretBackend::File,
            &paths,
        )
        .unwrap();
        assert!(
            refresh_registered_agent_within(&paths, &profile_id, &search_roots)
                .unwrap()
                .is_none(),
            "re-registration must be idempotent"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_uninstalled_agent_without_a_trusted_replacement_still_fails_closed() {
        use std::os::unix::fs::symlink;

        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let install = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let launcher_dir = install.path().join("bin");
        fs::create_dir_all(&launcher_dir).unwrap();
        let launcher = launcher_dir.join("agent");
        let release = publish_release(install.path(), "1.0");
        symlink(&release, &launcher).unwrap();

        let profile_id = register_launcher_agent(&paths, workspace.path(), &launcher, 18873);
        fs::remove_file(&launcher).unwrap();
        fs::remove_dir_all(install.path().join("pkg").join("1.0")).unwrap();

        let error = refresh_registered_agent_within(&paths, &profile_id, &[launcher_dir])
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("run setup again"),
            "unexpected error: {error}"
        );
    }

    /// A replacement other users can rewrite is never trusted automatically.
    #[cfg(unix)]
    #[test]
    fn a_world_writable_replacement_is_not_trusted() {
        use std::os::unix::fs::PermissionsExt;

        let install = tempdir().unwrap();
        let launcher_dir = install.path().join("bin");
        fs::create_dir_all(&launcher_dir).unwrap();
        let executable = launcher_dir.join("agent");
        fs::write(&executable, "#!/bin/sh\necho hi\n").unwrap();

        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(trusted_agent_executable("agent", std::slice::from_ref(&launcher_dir)).is_some());

        fs::set_permissions(&executable, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(trusted_agent_executable("agent", &[launcher_dir]).is_none());
    }
}
