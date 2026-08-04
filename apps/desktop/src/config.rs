use std::{
    collections::BTreeMap,
    net::{SocketAddr, TcpListener, ToSocketAddrs},
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};

use crate::{
    secrets::SecretBackend,
    store::{AppConfig, AppPaths, Profile},
};

#[derive(Clone, Debug)]
pub struct RuntimePaths {
    pub package_root: PathBuf,
}

impl RuntimePaths {
    pub fn discover() -> Result<Self> {
        let mut candidates = Vec::new();
        if let Ok(executable) = std::env::current_exe() {
            candidates.extend(platform_runtime_candidates(&executable));
        }

        #[cfg(debug_assertions)]
        {
            if let Some(package_root) = std::env::var_os("DAPPERCODE_PACKAGE_ROOT") {
                candidates.push(PathBuf::from(package_root));
            }
            candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."));
            if let Ok(current_dir) = std::env::current_dir() {
                candidates.push(current_dir);
            }
        }

        for candidate in candidates {
            let Ok(package_root) = candidate.canonicalize() else {
                continue;
            };
            let contains_bridge = package_root.join("bin/dappercode-bridge").is_file()
                || cfg!(debug_assertions)
                    && package_root
                        .join("services/rust-bridge/Cargo.toml")
                        .is_file();
            if !contains_bridge {
                continue;
            }
            return Ok(Self { package_root });
        }

        bail!("DapperCode runtime resources were not found; reinstall the desktop app")
    }

    #[cfg(not(debug_assertions))]
    pub fn bridge_binary_candidates(&self) -> Vec<PathBuf> {
        let binary_name = if cfg!(windows) {
            "dappercode-bridge.exe"
        } else {
            "dappercode-bridge"
        };
        vec![self.package_root.join("bin").join(binary_name)]
    }

    #[cfg(debug_assertions)]
    pub fn bridge_binary_candidates(&self) -> Vec<PathBuf> {
        let binary_name = if cfg!(windows) {
            "dappercode-bridge.exe"
        } else {
            "dappercode-bridge"
        };
        let mut candidates = vec![self.package_root.join("bin").join(binary_name)];
        if let Some(target) = runtime_target() {
            candidates.push(
                self.package_root
                    .join("vendor/bridge-binaries")
                    .join(target)
                    .join(binary_name),
            );
        }
        candidates.push(
            self.package_root
                .join("services/rust-bridge/target/release")
                .join(binary_name),
        );
        candidates
    }
}

#[cfg(target_os = "macos")]
fn platform_runtime_candidates(executable: &Path) -> Vec<PathBuf> {
    executable
        .parent()
        .and_then(Path::parent)
        .map(|resources| vec![resources.to_path_buf()])
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn platform_runtime_candidates(executable: &Path) -> Vec<PathBuf> {
    executable
        .parent()
        .map(|directory| vec![directory.join("runtime")])
        .unwrap_or_default()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_runtime_candidates(executable: &Path) -> Vec<PathBuf> {
    executable
        .parent()
        .map(|directory| {
            vec![
                directory.join("../share/dappercode/runtime"),
                directory.join("runtime"),
            ]
        })
        .unwrap_or_default()
}

#[cfg(debug_assertions)]
fn runtime_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("windows", "x86_64") => Some("win32-x64"),
        _ => None,
    }
}

/// The environment a bridge child process runs with, materialized in memory.
///
/// The auth token never touches disk outside the keychain (or its private fallback file), so there
/// is no `.env.secure` to leak into a repository.
#[derive(Clone, Debug)]
pub struct BridgeRuntimeConfig {
    pub values: BTreeMap<String, String>,
    pub host: String,
    pub port: u16,
    pub connect_url: String,
    pub auth_token: String,
    pub secret_backend: SecretBackend,
}

impl BridgeRuntimeConfig {
    pub fn from_profile(
        profile: &Profile,
        token: &str,
        secret_backend: SecretBackend,
        paths: &AppPaths,
    ) -> Result<Self> {
        if token.trim().is_empty() {
            bail!("the stored bridge token for this workspace is empty; run setup again");
        }
        if profile.bridge_port == 0 || profile.preview_port == 0 {
            bail!("this workspace has an invalid bridge port; run setup again");
        }

        let workspace = profile.workspace.clone();
        if !workspace.is_dir() {
            bail!(
                "the configured workspace no longer exists: {}",
                workspace.display()
            );
        }
        let manifest_path = paths.manifest_path(&profile.profile_id);
        if !manifest_path.is_file() {
            bail!("the ACP agent manifest for this workspace is missing; run setup again");
        }
        let executable_root = profile
            .agent
            .executable
            .parent()
            .context("the registered agent executable has no parent directory")?;
        if !executable_root.is_dir() {
            bail!("the registered agent executable is no longer installed; run setup again");
        }

        paths.prepare_profile(&profile.profile_id)?;

        let mut values = BTreeMap::new();
        let mut insert = |key: &str, value: String| -> Result<()> {
            if value.contains(['\n', '\r', '\0']) {
                bail!("generated configuration value contains a control character");
            }
            values.insert(key.to_string(), value);
            Ok(())
        };

        insert("BRIDGE_HOST", profile.bridge_host.clone())?;
        insert("BRIDGE_PORT", profile.bridge_port.to_string())?;
        insert("BRIDGE_PREVIEW_HOST", profile.bridge_host.clone())?;
        insert("BRIDGE_PREVIEW_PORT", profile.preview_port.to_string())?;
        insert("BRIDGE_CONNECT_URL", profile.connect_url.clone())?;
        insert(
            "BRIDGE_PREVIEW_CONNECT_URL",
            profile.preview_connect_url.clone(),
        )?;
        insert("BRIDGE_AUTH_TOKEN", token.to_string())?;
        insert(
            "BRIDGE_ALLOW_QUERY_TOKEN_AUTH",
            profile.allow_query_token_auth.to_string(),
        )?;
        insert("BRIDGE_WORKDIR", path_value(&workspace)?)?;
        insert(
            "BRIDGE_STATE_DIR",
            path_value(&paths.state_dir(&profile.profile_id))?,
        )?;
        insert(
            "BRIDGE_ATTACHMENTS_DIR",
            path_value(&paths.attachments_dir(&profile.profile_id))?,
        )?;
        insert("ACP_AGENT_MANIFEST", path_value(&manifest_path)?)?;
        insert("ACP_AGENT_ROOTS", path_value(executable_root)?)?;
        insert(
            "ACP_INITIALIZE_TIMEOUT_MS",
            profile.acp_initialize_timeout_ms.to_string(),
        )?;

        Ok(Self {
            values,
            host: profile.bridge_host.clone(),
            port: profile.bridge_port,
            connect_url: profile.connect_url.trim_end_matches('/').to_string(),
            auth_token: token.to_string(),
            secret_backend,
        })
    }

    pub fn local_base_url(&self) -> String {
        let host = match self.host.as_str() {
            "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
            host => host,
        };
        format!("http://{}:{}", format_host(host), self.port)
    }

    pub fn pairing_payload(&self) -> Result<String> {
        Ok(serde_json::to_string(&serde_json::json!({
            "type": "dappercode-bridge-pair",
            "bridgeUrl": self.connect_url,
            "bridgeToken": self.auth_token,
        }))?)
    }

    /// Stable fingerprint of the configuration a running bridge was started with, excluding the
    /// token so that the digest can be recorded in a plain ownership record.
    pub fn fingerprint_source(&self) -> String {
        self.values
            .iter()
            .filter(|(key, _)| key.as_str() != "BRIDGE_AUTH_TOKEN")
            .map(|(key, value)| format!("{key}={value}\n"))
            .collect()
    }
}

fn path_value(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .with_context(|| format!("path is not valid UTF-8: {}", path.display()))
}

pub fn format_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

pub fn validate_workspace(path: &Path) -> Result<PathBuf> {
    let canonical = path
        .canonicalize()
        .with_context(|| format!("workspace does not exist: {}", path.display()))?;
    if !canonical.is_dir() {
        bail!("workspace must be a directory");
    }
    Ok(canonical)
}

/// Picks a free consecutive `(bridge, preview)` port pair for a profile.
///
/// Several worktrees run their bridges at the same time, so ports are allocated rather than
/// defaulted. Pairs already owned by another profile are skipped, and each candidate is bind-probed
/// so ports held by unrelated processes are skipped too.
pub fn allocate_port_pair(
    config: &AppConfig,
    profile_id: &str,
    host: &str,
    requested_port: Option<u16>,
    explicit: bool,
) -> Result<(u16, u16)> {
    let reserved: Vec<(u16, String)> = config
        .reserved_ports(profile_id)
        .into_iter()
        .map(|(port, profile)| (port, profile.workspace.display().to_string()))
        .collect();
    let start = requested_port.unwrap_or(8787).max(1);

    if explicit {
        let preview = start
            .checked_add(1)
            .context("bridge port must leave room for the adjacent preview port")?;
        if let Some((port, workspace)) = reserved
            .iter()
            .find(|(port, _)| *port == start || *port == preview)
        {
            bail!(
                "port {port} is already assigned to the workspace at {workspace}; choose another --port"
            );
        }
        if !pair_is_bindable(host, start, preview) {
            bail!("ports {start} and {preview} are already in use on {host}");
        }
        return Ok((start, preview));
    }

    let mut candidate = start;
    while let Some(preview) = candidate.checked_add(1) {
        let taken = reserved
            .iter()
            .any(|(port, _)| *port == candidate || *port == preview);
        if !taken && pair_is_bindable(host, candidate, preview) {
            return Ok((candidate, preview));
        }
        match candidate.checked_add(2) {
            Some(next) => candidate = next,
            None => break,
        }
    }
    bail!("no free bridge port pair is available on {host} at or above {start}")
}

fn pair_is_bindable(host: &str, bridge_port: u16, preview_port: u16) -> bool {
    port_is_bindable(host, bridge_port) && port_is_bindable(host, preview_port)
}

/// Probes whether a port can actually be bound.
///
/// The configured host may not be assigned to this machine yet (a tailnet address that has not come
/// up, or a LAN address that changed), which is not the same as the port being taken. Only a real
/// "address in use" result rules a port out; anything else falls back to probing the wildcard
/// address so setup still succeeds.
fn port_is_bindable(host: &str, port: u16) -> bool {
    let addresses: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map(|addresses| addresses.collect())
        .unwrap_or_default();
    if addresses.is_empty() {
        return wildcard_port_is_bindable(port);
    }
    for address in addresses {
        match TcpListener::bind(address) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => return false,
            Err(_) => return wildcard_port_is_bindable(port),
        }
    }
    true
}

fn wildcard_port_is_bindable(port: u16) -> bool {
    TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).is_ok()
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::store::ProfileAgent;
    use tempfile::tempdir;

    fn profile(profile_id: &str, workspace: &Path, port: u16) -> Profile {
        Profile {
            profile_id: profile_id.to_string(),
            workspace: workspace.to_path_buf(),
            network_mode: "local".to_string(),
            bridge_host: "127.0.0.1".to_string(),
            bridge_port: port,
            preview_port: port + 1,
            connect_url: format!("http://127.0.0.1:{port}"),
            preview_connect_url: format!("http://127.0.0.1:{}", port + 1),
            auto_start: false,
            allow_query_token_auth: true,
            acp_initialize_timeout_ms: 15_000,
            agent: ProfileAgent {
                agent_id: "echo".to_string(),
                display_name: "Echo".to_string(),
                executable: PathBuf::from("/bin/echo"),
                argv: vec!["acp".to_string()],
                resolved_version: "local".to_string(),
                verified_digest: "sha256:abc".to_string(),
            },
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn builds_a_child_environment_without_writing_the_token_to_disk() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let profile = profile("alpha-000000000001", workspace.path(), 18787);
        paths.prepare_profile(&profile.profile_id).unwrap();
        std::fs::write(paths.manifest_path(&profile.profile_id), b"{}").unwrap();

        let config =
            BridgeRuntimeConfig::from_profile(&profile, "secret", SecretBackend::File, &paths)
                .unwrap();

        assert_eq!(config.values["BRIDGE_AUTH_TOKEN"], "secret");
        assert_eq!(config.values["BRIDGE_PORT"], "18787");
        assert_eq!(config.values["BRIDGE_PREVIEW_PORT"], "18788");
        assert_eq!(
            config.values["BRIDGE_STATE_DIR"],
            paths.state_dir(&profile.profile_id).to_str().unwrap()
        );
        assert_eq!(
            config.values["BRIDGE_ATTACHMENTS_DIR"],
            paths.attachments_dir(&profile.profile_id).to_str().unwrap()
        );
        assert!(!workspace.path().join(".env.secure").exists());
        assert!(!config.fingerprint_source().contains("secret"));
    }

    #[test]
    fn rejects_a_profile_whose_manifest_disappeared() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let profile = profile("alpha-000000000001", workspace.path(), 18787);

        let error =
            BridgeRuntimeConfig::from_profile(&profile, "secret", SecretBackend::File, &paths)
                .unwrap_err();
        assert!(error.to_string().contains("manifest"));
    }

    #[test]
    fn builds_ipv6_local_url_and_pairing_payload() {
        let config = BridgeRuntimeConfig {
            values: BTreeMap::new(),
            host: "::1".to_string(),
            port: 8787,
            connect_url: "http://[::1]:8787".to_string(),
            auth_token: "secret".to_string(),
            secret_backend: SecretBackend::Keychain,
        };

        assert_eq!(config.local_base_url(), "http://[::1]:8787");
        let payload: serde_json::Value =
            serde_json::from_str(&config.pairing_payload().unwrap()).unwrap();
        assert_eq!(payload["type"], "dappercode-bridge-pair");
        assert_eq!(payload["bridgeToken"], "secret");
    }

    #[test]
    fn allocates_a_free_pair_that_skips_ports_owned_by_other_profiles() {
        let workspace = tempdir().unwrap();
        let mut config = AppConfig {
            version: 1,
            profiles: Vec::new(),
        };
        config.upsert(profile("beta-000000000002", workspace.path(), 18801));

        let (bridge, preview) = allocate_port_pair(
            &config,
            "alpha-000000000001",
            "127.0.0.1",
            Some(18801),
            false,
        )
        .unwrap();
        assert_eq!(preview, bridge + 1);
        assert!(bridge > 18802, "expected to skip the reserved pair");
    }

    #[test]
    fn reuses_the_requested_pair_when_nothing_else_claims_it() {
        let config = AppConfig {
            version: 1,
            profiles: Vec::new(),
        };
        let (bridge, preview) = allocate_port_pair(
            &config,
            "alpha-000000000001",
            "127.0.0.1",
            Some(18901),
            false,
        )
        .unwrap();
        assert_eq!((bridge, preview), (18901, 18902));
    }

    #[test]
    fn rejects_an_explicit_port_that_another_workspace_owns() {
        let workspace = tempdir().unwrap();
        let mut config = AppConfig {
            version: 1,
            profiles: Vec::new(),
        };
        config.upsert(profile("beta-000000000002", workspace.path(), 18811));

        let error = allocate_port_pair(
            &config,
            "alpha-000000000001",
            "127.0.0.1",
            Some(18811),
            true,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("already assigned to the workspace"));
        assert!(error
            .to_string()
            .contains(&workspace.path().display().to_string()));
    }

    #[test]
    fn brackets_ipv6_hosts_for_urls() {
        assert_eq!(format_host("fd00::1"), "[fd00::1]");
        assert_eq!(format_host("127.0.0.1"), "127.0.0.1");
    }

    #[test]
    fn rejects_a_profile_that_cannot_produce_a_usable_environment() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let base = profile("alpha-000000000001", workspace.path(), 18787);
        paths.prepare_profile(&base.profile_id).unwrap();
        std::fs::write(paths.manifest_path(&base.profile_id), b"{}").unwrap();

        let blank_token =
            BridgeRuntimeConfig::from_profile(&base, "   ", SecretBackend::File, &paths)
                .unwrap_err();
        assert!(blank_token.to_string().contains("token"));

        let mut zero_port = base.clone();
        zero_port.bridge_port = 0;
        assert!(BridgeRuntimeConfig::from_profile(
            &zero_port,
            "secret",
            SecretBackend::File,
            &paths
        )
        .unwrap_err()
        .to_string()
        .contains("invalid bridge port"));

        let mut zero_preview = base.clone();
        zero_preview.preview_port = 0;
        assert!(
            BridgeRuntimeConfig::from_profile(&zero_preview, "s", SecretBackend::File, &paths)
                .is_err()
        );

        let mut missing_workspace = base.clone();
        missing_workspace.workspace = workspace.path().join("gone");
        assert!(BridgeRuntimeConfig::from_profile(
            &missing_workspace,
            "s",
            SecretBackend::File,
            &paths
        )
        .unwrap_err()
        .to_string()
        .contains("no longer exists"));

        let mut missing_agent = base;
        missing_agent.agent.executable = workspace.path().join("gone").join("agent");
        assert!(BridgeRuntimeConfig::from_profile(
            &missing_agent,
            "s",
            SecretBackend::File,
            &paths
        )
        .unwrap_err()
        .to_string()
        .contains("no longer installed"));
    }

    #[test]
    fn collapses_wildcard_bind_hosts_to_loopback_for_local_probes() {
        for host in ["0.0.0.0", "::", "[::]"] {
            let config = BridgeRuntimeConfig {
                values: BTreeMap::new(),
                host: host.to_string(),
                port: 8787,
                connect_url: "http://example.invalid:8787/".to_string(),
                auth_token: "secret".to_string(),
                secret_backend: SecretBackend::File,
            };
            assert_eq!(config.local_base_url(), "http://127.0.0.1:8787");
        }
    }

    #[test]
    fn fingerprint_is_stable_and_ordered() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let profile = profile("alpha-000000000001", workspace.path(), 18789);
        paths.prepare_profile(&profile.profile_id).unwrap();
        std::fs::write(paths.manifest_path(&profile.profile_id), b"{}").unwrap();

        let config =
            BridgeRuntimeConfig::from_profile(&profile, "secret", SecretBackend::Keychain, &paths)
                .unwrap();
        let fingerprint = config.fingerprint_source();

        assert_eq!(config.secret_backend, SecretBackend::Keychain);
        assert!(fingerprint.starts_with("ACP_AGENT_MANIFEST="));
        assert!(fingerprint.contains("BRIDGE_PORT=18789\n"));
        assert_eq!(fingerprint, config.fingerprint_source());
    }

    #[test]
    fn validates_that_a_workspace_is_an_existing_directory() {
        let temp = tempdir().unwrap();
        assert_eq!(
            validate_workspace(temp.path()).unwrap(),
            temp.path().canonicalize().unwrap()
        );
        assert!(validate_workspace(&temp.path().join("missing"))
            .unwrap_err()
            .to_string()
            .contains("workspace does not exist"));

        let file = temp.path().join("file.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_workspace(&file)
            .unwrap_err()
            .to_string()
            .contains("must be a directory"));
    }

    #[test]
    fn refuses_to_allocate_when_the_port_range_is_exhausted() {
        let config = AppConfig {
            version: 1,
            profiles: Vec::new(),
        };
        let error = allocate_port_pair(
            &config,
            "alpha-000000000001",
            "127.0.0.1",
            Some(u16::MAX),
            false,
        )
        .unwrap_err();
        assert!(error.to_string().contains("no free bridge port pair"));

        assert!(allocate_port_pair(
            &config,
            "alpha-000000000001",
            "127.0.0.1",
            Some(u16::MAX),
            true
        )
        .is_err());
    }

    #[test]
    fn rejects_an_explicit_pair_that_a_process_already_holds() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let taken = listener.local_addr().unwrap().port();
        let config = AppConfig {
            version: 1,
            profiles: Vec::new(),
        };

        let error = allocate_port_pair(
            &config,
            "alpha-000000000001",
            "127.0.0.1",
            Some(taken),
            true,
        )
        .unwrap_err();
        assert!(error.to_string().contains("already in use"));
    }

    #[test]
    fn defaults_to_the_standard_pair_when_no_port_is_requested() {
        let config = AppConfig {
            version: 1,
            profiles: Vec::new(),
        };
        let (bridge, preview) =
            allocate_port_pair(&config, "alpha-000000000001", "127.0.0.1", None, false).unwrap();
        assert_eq!(preview, bridge + 1);
        assert!(bridge >= 8787);
    }

    #[test]
    fn falls_back_to_the_wildcard_probe_for_an_unresolvable_host() {
        assert!(port_is_bindable(
            "dappercode.invalid.example",
            wildcard_free_port()
        ));
    }

    #[test]
    fn discovers_runtime_resources_from_an_explicit_package_root() {
        struct Guard;
        impl Drop for Guard {
            fn drop(&mut self) {
                std::env::remove_var("DAPPERCODE_PACKAGE_ROOT");
            }
        }
        let _guard = Guard;
        let temp = tempdir().unwrap();

        // A candidate that holds neither a bundled binary nor a bridge source tree is skipped, and
        // discovery falls through to the repository checkout this test runs from.
        std::env::set_var("DAPPERCODE_PACKAGE_ROOT", temp.path());
        let runtime = RuntimePaths::discover().unwrap();
        assert_ne!(runtime.package_root, temp.path());

        std::fs::create_dir_all(temp.path().join("services/rust-bridge")).unwrap();
        std::fs::write(temp.path().join("services/rust-bridge/Cargo.toml"), b"x").unwrap();
        let runtime = RuntimePaths::discover().unwrap();
        assert_eq!(runtime.package_root, temp.path().canonicalize().unwrap());

        let candidates = runtime.bridge_binary_candidates();
        assert!(candidates
            .iter()
            .any(|candidate| candidate.ends_with("bin/dappercode-bridge")));
        assert!(runtime_target().is_some(), "this platform should be mapped");

        // A package root that cannot be canonicalized is skipped rather than failing discovery.
        std::env::set_var("DAPPERCODE_PACKAGE_ROOT", temp.path().join("missing"));
        assert!(RuntimePaths::discover().is_ok());
    }

    #[test]
    fn rejects_configuration_values_containing_control_characters() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let mut profile = profile("alpha-000000000001", workspace.path(), 18791);
        profile.connect_url = "http://127.0.0.1\nBRIDGE_AUTH_TOKEN=stolen".to_string();
        paths.prepare_profile(&profile.profile_id).unwrap();
        std::fs::write(paths.manifest_path(&profile.profile_id), b"{}").unwrap();

        let error =
            BridgeRuntimeConfig::from_profile(&profile, "secret", SecretBackend::File, &paths)
                .unwrap_err();
        assert!(error.to_string().contains("control character"));
    }

    #[test]
    fn leaves_an_already_bracketed_ipv6_host_alone() {
        assert_eq!(format_host("[fd00::1]"), "[fd00::1]");
    }

    #[test]
    fn rejects_an_explicit_port_whose_preview_slot_another_workspace_owns() {
        let workspace = tempdir().unwrap();
        let mut config = AppConfig {
            version: 1,
            profiles: Vec::new(),
        };
        config.upsert(profile("beta-000000000002", workspace.path(), 18861));

        // 18860 is free, but its preview slot 18861 belongs to the other workspace.
        let error = allocate_port_pair(
            &config,
            "alpha-000000000001",
            "127.0.0.1",
            Some(18860),
            true,
        )
        .unwrap_err();
        assert!(error.to_string().contains("18861"));
    }

    fn wildcard_free_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        port
    }

    #[test]
    fn treats_a_host_that_is_not_local_as_probeable_via_the_wildcard_address() {
        // 192.0.2.1 is TEST-NET-1 and is never assigned to a local interface, so binding it fails
        // with AddrNotAvailable rather than AddrInUse.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let taken = listener.local_addr().unwrap().port();
        assert!(port_is_bindable("192.0.2.1", taken) == wildcard_port_is_bindable(taken));

        let config = AppConfig {
            version: 1,
            profiles: Vec::new(),
        };
        let (bridge, preview) = allocate_port_pair(
            &config,
            "alpha-000000000001",
            "192.0.2.1",
            Some(18941),
            false,
        )
        .unwrap();
        assert_eq!((bridge, preview), (18941, 18942));
    }

    #[test]
    fn skips_a_port_that_another_process_already_holds() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let taken = listener.local_addr().unwrap().port();
        assert!(!port_is_bindable("127.0.0.1", taken));

        let config = AppConfig {
            version: 1,
            profiles: Vec::new(),
        };
        let (bridge, _) = allocate_port_pair(
            &config,
            "alpha-000000000001",
            "127.0.0.1",
            Some(taken),
            false,
        )
        .unwrap();
        assert_ne!(bridge, taken);
    }
}
