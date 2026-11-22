#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "agent discovery, manifest hashing, and profile registration live together"
    )
)]

use crate::broker_supervisor::clean_stale_broker_ownership;
use crate::config::{
    allocate_broker_replacement_ports, allocate_port_pair, allocate_preview_port, format_host,
    runtime_executable_available, validate_workspace,
};
use crate::platform;
use crate::secrets::{BridgeSecret, SecretStore};
use crate::store::{
    atomic_private_write, profile_id_for, remove_file_if_exists, AppPaths, BrokerSettings,
    ConfigSideEffects, FileLease, Profile, ProfileAgent,
};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "matches persisted ACP agent manifest JSON schema"
    )
)]
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
        if self.secret_created.take().unwrap_or(false) {
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
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        perfectionist::too_many_local_bindings,
        reason = "transactional profile registration coordinates validation, port allocation, and rollback"
    )
)]
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
            request.executable.display(),
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
    // Keep the selected entry, not just its versioned symlink target.
    let launcher_path = std::path::absolute(&request.executable)?;

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
                            broker.connect_url,
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
                launcher_path: Some(launcher_path.clone()),
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
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    directories.extend(platform::agent_search_roots());
    discover_agent_in(agent_id, directories)
}

fn discover_agent_in(agent_id: &str, directories: Vec<PathBuf>) -> Option<PathBuf> {
    let executable_name = platform::agent_executable_name(agent_id);
    directories
        .into_iter()
        .map(|directory| directory.join(&executable_name))
        .filter(|candidate| candidate.is_file())
        .find(|candidate| runtime_executable_available(candidate))
        .map(std::path::absolute)
        .and_then(Result::ok)
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
/// Re-registration follows the explicitly selected launcher. Legacy registrations can discover a
/// launcher only in platform-trusted directories, never the worker's PATH. The bridge still checks
/// the refreshed digest independently before spawning; installation changes during launch fail
/// closed and can be retried.
pub fn refresh_registered_agent(
    paths: &AppPaths,
    profile_id: &str,
) -> Result<Option<AgentRefresh>> {
    refresh_registered_agent_within(paths, profile_id, &platform::agent_search_roots())
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        perfectionist::too_many_local_bindings,
        reason = "transactional agent refresh verifies digest and rewrites manifest and config under one lock"
    )
)]
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
    let launcher_path = agent.launcher_path.clone().or_else(|| {
        let name = platform::agent_executable_name(&agent.agent_id);
        search_roots
            .iter()
            .map(|root| root.join(&name))
            .find(|candidate| trusted_agent_target(candidate).is_some())
    });
    let Some(launcher_path) = launcher_path else {
        if registered_agent_is_current(&agent) {
            return Ok(None);
        }
        bail!(
            "the registered {} executable is no longer installed and no trusted replacement was found; run setup again",
            agent.agent_id,
        );
    };
    let executable = trusted_agent_target(&launcher_path).with_context(|| {
        format!(
            "the registered {} launcher is missing, not executable, or writable by another user: {}; retry after the update finishes or run setup again",
            agent.agent_id, launcher_path.display(),
        )
    })?;
    let verified_digest = file_digest(&executable)?;
    let unchanged = executable == agent.executable && verified_digest == agent.verified_digest;
    if unchanged && agent.launcher_path.as_ref() == Some(&launcher_path) {
        return Ok(None);
    }
    let manifest_path = paths.manifest_path(profile_id);
    let expected_manifest = fs::read(&manifest_path)
        .with_context(|| format!("failed to read {}", manifest_path.display()))?;
    refreshable_agent(
        &mut serde_json::from_slice(&expected_manifest)?,
        &agent.agent_id,
    )?;
    let resolved_version = if unchanged {
        agent.resolved_version.clone()
    } else {
        executable_version(&executable)
    };
    if trusted_agent_target(&launcher_path).as_ref() != Some(&executable)
        || file_digest(&executable)? != verified_digest
    {
        bail!("agent installation changed during refresh; retry after the update finishes");
    }

    let mut side_effects = ManifestRefreshSideEffects {
        paths,
        profile_id,
        agent_id: agent.agent_id.clone(),
        executable: executable.clone(),
        resolved_version: resolved_version.clone(),
        verified_digest: verified_digest.clone(),
        expected_manifest,
        previous_manifest: None,
    };
    let owned_profile_id = profile_id.to_string();
    let recorded_executable = executable.clone();
    let recorded_version = resolved_version.clone();
    let expected_agent = agent.clone();
    paths.update_config_with_side_effects(
        move |config| {
            let profile = config
                .profiles
                .iter_mut()
                .find(|profile| profile.profile_id == owned_profile_id)
                .with_context(|| {
                    format!("workspace profile {owned_profile_id} disappeared during agent refresh")
                })?;
            if profile.agent != expected_agent {
                bail!("agent registration changed during refresh; retry with the current profile");
            }
            profile.agent.executable = recorded_executable;
            profile.agent.launcher_path = Some(launcher_path);
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
    expected_manifest: Vec<u8>,
    previous_manifest: Option<Vec<u8>>,
}

fn refreshable_agent<'a>(
    manifest: &'a mut serde_json::Value,
    agent_id: &str,
) -> Result<&'a mut serde_json::Map<String, serde_json::Value>> {
    let entry = manifest
        .get_mut("agents")
        .and_then(serde_json::Value::as_array_mut)
        .context("the agent manifest does not list any agents")?
        .iter_mut()
        .filter_map(serde_json::Value::as_object_mut)
        .find(|entry| entry.get("agentId").and_then(serde_json::Value::as_str) == Some(agent_id))
        .with_context(|| format!("the agent manifest has no {agent_id} entry"))?;
    if entry
        .get("integrity")
        .and_then(|integrity| integrity.get("kind"))
        .and_then(serde_json::Value::as_str)
        != Some("executable")
    {
        bail!("automatic agent refresh requires executable integrity; run setup again");
    }
    Ok(entry)
}

impl ConfigSideEffects for ManifestRefreshSideEffects<'_> {
    type Output = ();

    fn apply(&mut self) -> Result<()> {
        let manifest_path = self.paths.manifest_path(self.profile_id);
        let contents = fs::read(&manifest_path)
            .with_context(|| format!("failed to read {}", manifest_path.display()))?;
        if contents != self.expected_manifest {
            bail!("agent manifest changed during refresh; retry with the current manifest");
        }
        let mut manifest: serde_json::Value = serde_json::from_slice(&contents)
            .with_context(|| format!("invalid agent manifest at {}", manifest_path.display()))?;
        let entry = refreshable_agent(&mut manifest, &self.agent_id)?;
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

/// Checks the selected launcher and its resolved target before accepting an installation update.
fn trusted_agent_target(launcher: &Path) -> Option<PathBuf> {
    if !launcher.is_absolute() {
        return None;
    }
    let canonical = launcher.canonicalize().ok()?;
    (canonical.is_file()
        && runtime_executable_available(&canonical)
        && launcher
            .ancestors()
            .chain(canonical.ancestors())
            .all(|path| !is_writable_by_other_users(path)))
    .then_some(canonical)
}

#[cfg(unix)]
fn is_writable_by_other_users(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    fs::metadata(path)
        .map(|metadata| {
            let root_owned = metadata.uid() == 0;
            // SAFETY: geteuid takes no arguments and does not access Rust memory.
            let owned = root_owned || metadata.uid() == unsafe { libc::geteuid() };
            // Root-owned sticky temporary directories cannot replace a user's existing entries.
            let sticky_root = metadata.is_dir() && root_owned && metadata.mode() & 0o1000 != 0;
            // Homebrew uses group-writable directories owned by macOS's built-in admin group.
            let admin_directory =
                cfg!(target_os = "macos") && metadata.is_dir() && metadata.gid() == 80;
            let write_mask = if admin_directory { 0o002 } else { 0o022 };
            !owned || (metadata.mode() & write_mask != 0 && !sticky_root)
        })
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
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

fn executable_version(executable: &Path) -> String {
    match executable_version_with_timeout(executable, Duration::from_secs(2)) {
        Ok(version) => version,
        Err(error) => {
            eprintln!("agent version probe unavailable; using local version metadata: {error:#}");
            "local".to_string()
        }
    }
}

fn executable_version_with_timeout(executable: &Path, wait: Duration) -> Result<String> {
    // Setup is also called from async hosts; keep the bounded probe off their runtime thread.
    std::thread::scope(|scope| {
        scope
            .spawn(|| -> Result<String> {
                use tokio::io::AsyncReadExt;

                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?
                    .block_on(async {
                        let mut child = tokio::process::Command::new(executable)
                            .arg("--version")
                            .stdin(Stdio::null())
                            .stdout(Stdio::piped())
                            .stderr(Stdio::null())
                            .kill_on_drop(true)
                            .spawn()?;
                        let mut stdout = child
                            .stdout
                            .take()
                            .context("agent version stdout missing")?
                            .take(2049);
                        let mut bytes = Vec::new();
                        let result = tokio::time::timeout(wait, async {
                            stdout.read_to_end(&mut bytes).await?;
                            if bytes.len() > 2048 {
                                bail!("agent version output exceeded 2048 bytes");
                            }
                            if !child.wait().await?.success() {
                                bail!("agent version command failed");
                            }
                            let version = String::from_utf8_lossy(&bytes)
                                .lines()
                                .next()
                                .unwrap_or_default()
                                .trim()
                                .to_string();
                            if version.is_empty() {
                                bail!("agent version command returned no version");
                            }
                            Ok(version)
                        })
                        .await;
                        if child.try_wait()?.is_none() {
                            child.kill().await?;
                        }
                        result.context("agent version command timed out")?
                    })
            })
            .join()
            .map_err(|_| anyhow::anyhow!("agent version probe panicked"))?
    })
}

fn now_iso8601() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = seconds / 86_400;
    let time_of_day = seconds % 86_400;
    let days = i64::try_from(days).expect("seconds since the epoch fit in signed days");
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
    )
}

/// Howard Hinnant's civil-from-days algorithm, so a timestamp needs no extra dependency.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted_days = days + 719_468;
    let era = if shifted_days >= 0 {
        shifted_days
    } else {
        shifted_days - 146_096
    } / 146_097;
    let day_of_era = shifted_days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = u32::try_from(day_of_year - (153 * shifted_month + 2) / 5 + 1)
        .expect("calendar day fits in u32");
    let month = u32::try_from(if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    })
    .expect("calendar month fits in u32");
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "setup_tests.rs"]
mod tests;
