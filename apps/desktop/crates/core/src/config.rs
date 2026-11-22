use anyhow::{bail, Context, Result};
use std::collections::BTreeMap;
use std::fs;
use std::net::{SocketAddr, TcpListener, ToSocketAddrs};
use std::path::{Path, PathBuf};

use crate::platform;
use crate::secrets::SecretBackend;
use crate::store::{AppConfig, AppPaths, Profile};

#[cfg(debug_assertions)]
fn discovery_env(name: &str) -> Option<std::ffi::OsString> {
    #[cfg(test)]
    {
        crate::test_env::var_os(name)
    }
    #[cfg(not(test))]
    {
        std::env::var_os(name)
    }
}

#[derive(Clone, Debug)]
pub struct RuntimePaths {
    pub package_root: PathBuf,
}

#[cfg(debug_assertions)]
fn find_package_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|candidate| candidate.join("services/rust-bridge/Cargo.toml").is_file())
        .map(Path::to_path_buf)
}

impl RuntimePaths {
    pub fn discover() -> Result<Self> {
        let mut candidates = Vec::new();
        if let Ok(executable) = std::env::current_exe() {
            candidates.extend(platform::runtime_candidates(&executable));
        }

        #[cfg(debug_assertions)]
        {
            if let Some(package_root) = discovery_env("DAPPERCODE_PACKAGE_ROOT") {
                candidates.push(PathBuf::from(package_root));
            }
            if let Some(package_root) = find_package_root(Path::new(env!("CARGO_MANIFEST_DIR"))) {
                candidates.push(package_root);
            }
            if let Ok(current_dir) = std::env::current_dir() {
                candidates.push(current_dir);
            }
        }

        for candidate in candidates {
            let Ok(package_root) = candidate.canonicalize() else {
                continue;
            };
            let contains_bridge = contains_bundled_bridge(&package_root)
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
        let binary_name = platform::bridge_binary_name();
        vec![self.package_root.join("bin").join(binary_name)]
    }

    #[cfg(debug_assertions)]
    pub fn bridge_binary_candidates(&self) -> Vec<PathBuf> {
        let binary_name = platform::bridge_binary_name();
        let mut candidates = vec![self.package_root.join("bin").join(binary_name)];
        if let Some(target) = runtime_target() {
            candidates.push(
                self.package_root
                    .join("vendor/bridge-binaries")
                    .join(target)
                    .join(binary_name),
            );
        }
        if let (true, Some(target_dir)) = (
            self.package_root
                .join("services/rust-bridge/Cargo.toml")
                .is_file(),
            discovery_env("CARGO_TARGET_DIR"),
        ) {
            candidates.push(PathBuf::from(target_dir).join("release").join(binary_name));
        }
        candidates.push(
            self.package_root
                .join("services/rust-bridge/target/release")
                .join(binary_name),
        );
        candidates
    }
}

pub fn runtime_executable_available(path: &Path) -> bool {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
        Err(_) => return true,
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

fn contains_bundled_bridge(package_root: &Path) -> bool {
    ["dappercode-bridge", "dappercode-bridge.exe"]
        .iter()
        .any(|binary| package_root.join("bin").join(binary).is_file())
}

#[cfg(debug_assertions)]
fn runtime_target() -> Option<&'static str> {
    runtime_target_for(std::env::consts::OS, std::env::consts::ARCH)
}

#[cfg(debug_assertions)]
fn runtime_target_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("windows", "x86_64") => Some("win32-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        _ => None,
    }
}

/// The environment a bridge child process runs with, materialized in memory.
///
/// The auth token never touches disk outside the keychain (or its private fallback file), so there
/// is no `.env.secure` to leak into a repository.
#[derive(Clone)]
pub struct BridgeRuntimeConfig {
    pub values: BTreeMap<String, String>,
    pub host: String,
    pub port: u16,
    pub connect_url: String,
    pub auth_token: String,
    pub secret_backend: SecretBackend,
}

impl std::fmt::Debug for BridgeRuntimeConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BridgeRuntimeConfig")
            .field("values", &"[REDACTED]")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("connect_url", &self.connect_url)
            .field("auth_token", &"[REDACTED]")
            .field("secret_backend", &self.secret_backend)
            .finish()
    }
}

impl BridgeRuntimeConfig {
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "maps every validated profile setting into bridge environment variables in one table"
        )
    )]
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
                workspace.display(),
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
        insert_env(&mut values, "BRIDGE_HOST", profile.bridge_host.clone())?;
        insert_env(&mut values, "BRIDGE_PORT", profile.bridge_port.to_string())?;
        insert_env(
            &mut values,
            "BRIDGE_PREVIEW_HOST",
            profile.bridge_host.clone(),
        )?;
        insert_env(
            &mut values,
            "BRIDGE_PREVIEW_PORT",
            profile.preview_port.to_string(),
        )?;
        insert_env(
            &mut values,
            "BRIDGE_CONNECT_URL",
            profile.connect_url.clone(),
        )?;
        insert_env(
            &mut values,
            "BRIDGE_PREVIEW_CONNECT_URL",
            profile.preview_connect_url.clone(),
        )?;
        insert_env(&mut values, "BRIDGE_AUTH_TOKEN", token.to_string())?;
        insert_env(
            &mut values,
            "BRIDGE_ALLOW_QUERY_TOKEN_AUTH",
            profile.allow_query_token_auth.to_string(),
        )?;
        insert_env(&mut values, "BRIDGE_WORKDIR", path_value(&workspace)?)?;
        insert_env(
            &mut values,
            "BRIDGE_STATE_DIR",
            path_value(&paths.state_dir(&profile.profile_id))?,
        )?;
        insert_env(
            &mut values,
            "BRIDGE_ATTACHMENTS_DIR",
            path_value(&paths.attachments_dir(&profile.profile_id))?,
        )?;
        insert_env(
            &mut values,
            "ACP_AGENT_MANIFEST",
            path_value(&manifest_path)?,
        )?;
        insert_env(&mut values, "ACP_AGENT_ROOTS", path_value(executable_root)?)?;
        insert_env(
            &mut values,
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

    pub fn pairing_payload(&self, workspace_id: &str) -> Result<String> {
        Self::pairing_payload_for(&self.connect_url, workspace_id, &self.auth_token)
    }

    pub(crate) fn pairing_payload_for(
        connect_url: &str,
        workspace_id: &str,
        token: &str,
    ) -> Result<String> {
        Ok(serde_json::to_string(&serde_json::json!({
            "type": "dappercode-bridge-pair",
            "brokerProtocolVersion": 1,
            "workspaceId": workspace_id,
            "bridgeUrl": connect_url,
            "bridgeToken": token,
        }))?)
    }
}

pub(crate) fn insert_env(
    values: &mut BTreeMap<String, String>,
    key: impl Into<String>,
    value: String,
) -> Result<()> {
    if value.contains(['\n', '\r', '\0']) {
        bail!("generated configuration value contains a control character");
    }
    values.insert(key.into(), value);
    Ok(())
}

fn path_value(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .with_context(|| format!("path is not valid UTF-8: {}", path.display()))
}

pub(crate) fn format_host(host: &str) -> String {
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
pub(crate) fn allocate_port_pair(
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
                "port {port} is already assigned to the workspace at {workspace}; choose another --port",
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

pub(crate) fn allocate_broker_replacement_ports(
    config: &AppConfig,
    host: &str,
    current_bridge_port: u16,
    current_preview_port: u16,
    requested_port: Option<u16>,
) -> Result<(u16, u16)> {
    let bridge_port = requested_port.unwrap_or(current_bridge_port);
    if config
        .profiles
        .iter()
        .any(|profile| profile.preview_port == bridge_port)
    {
        bail!(
            "port {bridge_port} is already assigned to a workspace browser preview; choose another --port",
        );
    }
    if !port_is_bindable(host, bridge_port) {
        bail!("port {bridge_port} is already in use on {host}");
    }
    Ok((bridge_port, current_preview_port))
}

pub(crate) fn allocate_preview_port(
    config: &AppConfig,
    profile_id: &str,
    host: &str,
    start: u16,
) -> Result<u16> {
    if let Some(existing) = config.find(profile_id) {
        return Ok(existing.preview_port);
    }
    let mut reserved = config
        .profiles
        .iter()
        .flat_map(|profile| [profile.bridge_port, profile.preview_port])
        .collect::<std::collections::HashSet<_>>();
    if let Some(broker) = &config.broker {
        reserved.extend(
            broker
                .legacy_bridge_endpoints
                .iter()
                .map(|endpoint| endpoint.port),
        );
    }
    let mut candidate = start.max(1);
    loop {
        if !reserved.contains(&candidate) && port_is_bindable(host, candidate) {
            return Ok(candidate);
        }
        candidate = candidate
            .checked_add(1)
            .context("no free browser preview port is available")?;
    }
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
#[path = "config_tests.rs"]
mod tests;
