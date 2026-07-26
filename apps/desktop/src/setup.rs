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
    config::{allocate_port_pair, format_host, validate_workspace},
    secrets::SecretStore,
    store::{atomic_private_write, profile_id_for, AppPaths, Profile, ProfileAgent},
};

#[derive(Clone, Debug)]
pub struct SetupRequest {
    pub workspace: PathBuf,
    pub network_mode: String,
    pub bridge_host: String,
    pub bridge_port: Option<u16>,
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
    atomic_private_write(
        &paths.manifest_path(&profile_id),
        &serde_json::to_vec_pretty(&manifest)?,
    )?;

    let secret = secrets.get_or_create(paths, &profile_id)?;

    let profile = paths.update_config(|config| {
        // Reuse the ports this workspace already owns unless the caller asked for a specific port.
        let requested = request
            .bridge_port
            .or_else(|| config.find(&profile_id).map(|profile| profile.bridge_port));
        let explicit = request.bridge_port.is_some();
        let (bridge_port, preview_port) =
            allocate_port_pair(config, &profile_id, &host, requested, explicit)?;

        let authority = format_host(&host);
        let profile = Profile {
            profile_id: profile_id.clone(),
            workspace: workspace.clone(),
            network_mode: request.network_mode.clone(),
            bridge_host: host.clone(),
            bridge_port,
            preview_port,
            connect_url: format!("http://{authority}:{bridge_port}"),
            preview_connect_url: format!("http://{authority}:{preview_port}"),
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
    })?;

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
    let executable_name = if cfg!(windows) {
        format!("{agent_id}.exe")
    } else {
        agent_id.to_string()
    };
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if cfg!(target_os = "macos") {
        directories.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ]);
    }
    directories
        .into_iter()
        .map(|directory| directory.join(&executable_name))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| candidate.canonicalize().ok())
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
    fn gives_parallel_worktrees_distinct_profiles_and_ports() {
        let alpha = tempdir().unwrap();
        let beta = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let secrets = store();

        let first = setup_profile(request(alpha.path(), None), &paths, &secrets).unwrap();
        let second = setup_profile(request(beta.path(), None), &paths, &secrets).unwrap();

        assert_ne!(first.profile_id, second.profile_id);
        assert_ne!(first.bridge_port, second.bridge_port);
        assert_ne!(first.bridge_port, second.preview_port);
        assert_ne!(first.preview_port, second.bridge_port);
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
    fn refuses_a_port_another_workspace_already_owns() {
        let alpha = tempdir().unwrap();
        let beta = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let secrets = store();

        setup_profile(request(alpha.path(), Some(18847)), &paths, &secrets).unwrap();
        let error = setup_profile(request(beta.path(), Some(18847)), &paths, &secrets).unwrap_err();

        assert!(error
            .to_string()
            .contains("already assigned to the workspace"));
        assert_eq!(paths.load_config().unwrap().profiles.len(), 1);
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
}
