use std::{
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::{
    config::{BridgeRuntimeConfig, RuntimePaths},
    platform::{detach_process, process_start_identity, request_process_stop, ProcessStopRequest},
    secrets::SecretStore,
    store::{atomic_private_write, remove_file_if_exists, AppPaths, FileLease, Profile},
};

const STATUS_BODY_LIMIT_BYTES: u64 = 2 * 1024 * 1024;
const START_TIMEOUT: Duration = Duration::from_secs(60);
const STOP_TIMEOUT: Duration = Duration::from_secs(12);
const OWNERSHIP_RECORD_VERSION: u32 = 2;

#[derive(Clone, Debug)]
pub struct BridgeSupervisor {
    profile: Profile,
    paths: AppPaths,
    secrets: SecretStore,
    runtime: RuntimePaths,
    owner_pid: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BridgeState {
    NeedsSetup,
    Stopped,
    Running,
    Degraded,
    Unhealthy,
    Inaccessible,
    Error,
}

#[derive(Clone, Debug)]
pub struct BridgeSnapshot {
    pub state: BridgeState,
    pub headline: String,
    pub detail: String,
    pub url: Option<String>,
    pub uptime_sec: Option<u64>,
    pub connected_clients: usize,
    pub ready_agents: usize,
    pub total_agents: usize,
    pub recent_error_count: usize,
    pub managed_process: bool,
}

impl BridgeSnapshot {
    pub fn needs_setup(workspace: &Path) -> Self {
        Self {
            state: BridgeState::NeedsSetup,
            headline: "Setup required".to_string(),
            detail: format!(
                "Install an ACP agent and register {} with DapperCode.",
                workspace.display()
            ),
            url: None,
            uptime_sec: None,
            connected_clients: 0,
            ready_agents: 0,
            total_agents: 0,
            recent_error_count: 0,
            managed_process: false,
        }
    }

    pub fn stopped(config: &BridgeRuntimeConfig) -> Self {
        Self {
            state: BridgeState::Stopped,
            headline: "Bridge stopped".to_string(),
            detail: "Start the bridge to connect your phone.".to_string(),
            url: Some(config.connect_url.clone()),
            uptime_sec: None,
            connected_clients: 0,
            ready_agents: 0,
            total_agents: 0,
            recent_error_count: 0,
            managed_process: false,
        }
    }

    pub fn stopped_with_config_error(error: &anyhow::Error) -> Self {
        Self {
            state: BridgeState::Stopped,
            headline: "Bridge stopped".to_string(),
            detail: format!("Bridge stopped, but stored configuration needs repair: {error}"),
            url: None,
            uptime_sec: None,
            connected_clients: 0,
            ready_agents: 0,
            total_agents: 0,
            recent_error_count: 0,
            managed_process: false,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            state: BridgeState::Error,
            headline: "Bridge needs attention".to_string(),
            detail: message.into(),
            url: None,
            uptime_sec: None,
            connected_clients: 0,
            ready_agents: 0,
            total_agents: 0,
            recent_error_count: 0,
            managed_process: false,
        }
    }

    fn owned_config_error(error: &anyhow::Error) -> Self {
        Self {
            state: BridgeState::Inaccessible,
            headline: "Bridge configuration unavailable".to_string(),
            detail: format!(
                "The owned bridge is still running, but stored configuration needs repair: {error}"
            ),
            url: None,
            uptime_sec: None,
            connected_clients: 0,
            ready_agents: 0,
            total_agents: 0,
            recent_error_count: 0,
            managed_process: true,
        }
    }

    fn inaccessible(config: &BridgeRuntimeConfig, detail: String, managed_process: bool) -> Self {
        Self {
            state: BridgeState::Inaccessible,
            headline: "Bridge access failed".to_string(),
            detail,
            url: Some(config.connect_url.clone()),
            uptime_sec: None,
            connected_clients: 0,
            ready_agents: 0,
            total_agents: 0,
            recent_error_count: 0,
            managed_process,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStatusResponse {
    status: String,
    uptime_sec: u64,
    connected_clients: usize,
    #[serde(default)]
    agents: Vec<AgentStatus>,
    #[serde(default)]
    operational: OperationalStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    lifecycle: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationalStatus {
    #[serde(default)]
    recent_errors: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessOwnershipRecord {
    version: u32,
    pid: u32,
    started_at_epoch_sec: u64,
    executable: PathBuf,
    workspace: PathBuf,
    config_sha256: String,
    #[serde(default)]
    owner_pid: Option<u32>,
}

impl BridgeSupervisor {
    pub fn new(
        profile: Profile,
        paths: AppPaths,
        secrets: SecretStore,
        runtime: RuntimePaths,
        owner_pid: Option<u32>,
    ) -> Self {
        Self {
            profile,
            paths,
            secrets,
            runtime,
            owner_pid,
        }
    }

    pub fn profile(&self) -> &Profile {
        &self.profile
    }

    pub fn workspace(&self) -> &Path {
        &self.profile.workspace
    }

    pub fn runtime_config(&self) -> Result<BridgeRuntimeConfig> {
        let secret = self
            .secrets
            .get(&self.paths, &self.profile.profile_id)?
            .context("no stored bridge token for this workspace; run setup again")?;
        BridgeRuntimeConfig::from_profile(&self.profile, &secret.token, secret.backend, &self.paths)
    }

    pub fn snapshot(&self) -> BridgeSnapshot {
        let config = match self.runtime_config() {
            Ok(config) => config,
            Err(error) if self.owns_running_process() => {
                return BridgeSnapshot::owned_config_error(&error);
            }
            Err(error) => return BridgeSnapshot::error(error.to_string()),
        };

        let managed_process = self.owns_running_process();
        if !self.probe_health(&config) {
            if managed_process {
                return BridgeSnapshot::inaccessible(
                    &config,
                    "The owned bridge process is running, but its health endpoint is temporarily unavailable."
                        .to_string(),
                    true,
                );
            }
            return BridgeSnapshot::stopped(&config);
        }

        match self.fetch_status(&config) {
            Ok(status) => self.project_status(&config, status),
            Err(error) => BridgeSnapshot::inaccessible(
                &config,
                format!("A bridge is listening, but authenticated status failed: {error}"),
                managed_process,
            ),
        }
    }

    pub fn start(&self) -> Result<BridgeSnapshot> {
        let _lease = self.acquire_transition_lease()?;
        self.start_locked()
    }

    fn start_locked(&self) -> Result<BridgeSnapshot> {
        let config = self.runtime_config()?;
        if self.owns_running_process() {
            return Ok(BridgeSnapshot::inaccessible(
                &config,
                "The owned bridge process is already running; wait for health to recover or stop/restart it."
                    .to_string(),
                true,
            ));
        }
        if self.fetch_status(&config).is_ok() {
            return Ok(self.snapshot());
        }
        if self.probe_health(&config) {
            bail!("a bridge is already listening, but authenticated status is unavailable");
        }

        let bridge_binary = self.resolve_bridge_binary()?;
        self.clean_stale_ownership(&bridge_binary, &config)?;
        let log_path = self.log_path();
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .with_context(|| format!("failed to open {}", log_path.display()))?;
        let stderr = stdout.try_clone()?;

        let mut command = Command::new(&bridge_binary);
        command
            .current_dir(self.workspace())
            .envs(config.values.iter())
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        if let Some(owner_pid) = self.owner_pid {
            // The bridge exits on its own when this process disappears, so a force-quit or crash of
            // the desktop app cannot leave an authenticated bridge listening.
            command.env("BRIDGE_OWNER_PID", owner_pid.to_string());
        }
        detach_process(&mut command);
        let mut child = command.spawn().with_context(|| {
            format!("failed to start bridge binary {}", bridge_binary.display())
        })?;
        let pid = child.id();
        let ownership = match process_identity(
            pid,
            &bridge_binary,
            self.workspace(),
            &config_digest(&config),
            self.owner_pid,
        ) {
            Ok(ownership) => ownership,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error).context("failed to establish bridge process ownership");
            }
        };
        if let Err(error) = write_ownership_record(&self.ownership_path(), &ownership) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = self.remove_ownership_if_matches(&ownership);
            return Err(error).context("failed to publish bridge process ownership");
        }
        thread::spawn(move || {
            let _ = child.wait();
        });

        let started_at = Instant::now();
        while started_at.elapsed() < START_TIMEOUT {
            if let Ok(status) = self.fetch_status(&config) {
                return Ok(self.project_status(&config, status));
            }
            if !process_matches_ownership(&ownership) {
                let _ = self.remove_ownership_if_matches(&ownership);
                bail!(
                    "bridge exited before becoming healthy; inspect {}",
                    log_path.display()
                );
            }
            thread::sleep(Duration::from_millis(350));
        }

        let _ = self.stop_owned_process(&ownership);
        bail!(
            "bridge did not become healthy within {} seconds; inspect {}",
            START_TIMEOUT.as_secs(),
            log_path.display()
        )
    }

    pub fn stop(&self) -> Result<BridgeSnapshot> {
        let _lease = self.acquire_transition_lease()?;
        self.stop_locked()
    }

    fn stop_locked(&self) -> Result<BridgeSnapshot> {
        let Some(ownership) = read_ownership_record(&self.ownership_path())? else {
            let config = self.runtime_config()?;
            if self.fetch_status(&config).is_ok() {
                bail!("a bridge is running at the configured address but is not owned by this app");
            }
            return Ok(BridgeSnapshot::stopped(&config));
        };
        if ownership.workspace != self.workspace().canonicalize()? {
            bail!("bridge ownership record belongs to a different workspace");
        }
        if !process_matches_ownership(&ownership) {
            self.remove_ownership_if_matches(&ownership)?;
            if let Ok(config) = self.runtime_config() {
                if self.fetch_status(&config).is_ok() {
                    bail!("a bridge is running at the configured address but its process identity does not match this app");
                }
                return Ok(BridgeSnapshot::stopped(&config));
            }
            return Ok(BridgeSnapshot::error(
                "The recorded bridge process is no longer running, and stored configuration needs repair.",
            ));
        }

        self.stop_owned_process(&ownership)?;
        match self.runtime_config() {
            Ok(config) => Ok(BridgeSnapshot::stopped(&config)),
            Err(error) => Ok(BridgeSnapshot::stopped_with_config_error(&error)),
        }
    }

    pub fn restart(&self) -> Result<BridgeSnapshot> {
        let _lease = self.acquire_transition_lease()?;
        if read_ownership_record(&self.ownership_path())?.is_some() {
            self.stop_locked()?;
        }
        self.start_locked()
    }

    pub fn owns_running_process(&self) -> bool {
        let Ok(Some(ownership)) = read_ownership_record(&self.ownership_path()) else {
            return false;
        };
        self.workspace()
            .canonicalize()
            .is_ok_and(|workspace| ownership.workspace == workspace)
            && process_matches_ownership(&ownership)
    }

    pub fn log_path(&self) -> PathBuf {
        self.paths.log_path(&self.profile.profile_id)
    }

    fn fetch_status(&self, config: &BridgeRuntimeConfig) -> Result<BridgeStatusResponse> {
        let agent = http_agent();
        let url = format!("{}/status", config.local_base_url());
        let mut response = agent
            .get(&url)
            .header("Authorization", &format!("Bearer {}", config.auth_token))
            .call()
            .with_context(|| format!("bridge status unavailable at {url}"))?;
        let body = response
            .body_mut()
            .with_config()
            .limit(STATUS_BODY_LIMIT_BYTES)
            .read_to_string()
            .context("bridge status response was invalid or too large")?;
        serde_json::from_str(&body).context("bridge returned malformed status JSON")
    }

    fn probe_health(&self, config: &BridgeRuntimeConfig) -> bool {
        let url = format!("{}/health", config.local_base_url());
        match http_agent().get(&url).call() {
            Ok(_) => true,
            Err(ureq::Error::StatusCode(503)) => true,
            Err(_) => false,
        }
    }

    fn project_status(
        &self,
        config: &BridgeRuntimeConfig,
        status: BridgeStatusResponse,
    ) -> BridgeSnapshot {
        let ready_agents = status
            .agents
            .iter()
            .filter(|agent| agent.lifecycle == "ready")
            .count();
        let state = match status.status.as_str() {
            "ok" => BridgeState::Running,
            "degraded" => BridgeState::Degraded,
            "unhealthy" => BridgeState::Unhealthy,
            _ => BridgeState::Error,
        };
        let headline = match state {
            BridgeState::Running => "Bridge running",
            BridgeState::Degraded => "Bridge degraded",
            BridgeState::Unhealthy => "Bridge unhealthy",
            _ => "Unknown bridge status",
        }
        .to_string();
        let detail = format!(
            "{} connected device{} · {}/{} agent{} ready",
            status.connected_clients,
            plural(status.connected_clients),
            ready_agents,
            status.agents.len(),
            plural(status.agents.len())
        );
        BridgeSnapshot {
            state,
            headline,
            detail,
            url: Some(config.connect_url.clone()),
            uptime_sec: Some(status.uptime_sec),
            connected_clients: status.connected_clients,
            ready_agents,
            total_agents: status.agents.len(),
            recent_error_count: status.operational.recent_errors.len(),
            managed_process: self.owns_running_process(),
        }
    }

    fn resolve_bridge_binary(&self) -> Result<PathBuf> {
        let candidates = self.runtime.bridge_binary_candidates();
        resolve_existing_executable(&candidates).ok_or_else(|| {
            anyhow!(
                "bridge binary is not installed; build it with 'pnpm run cargo build --locked --release --manifest-path services/rust-bridge/Cargo.toml' or reinstall DapperCode"
            )
        })
    }

    fn ownership_path(&self) -> PathBuf {
        self.paths.ownership_path(&self.profile.profile_id)
    }

    fn transition_lock_path(&self) -> PathBuf {
        self.paths.transition_lock_path(&self.profile.profile_id)
    }

    /// Each profile locks independently, so starting one worktree's bridge never blocks another's.
    fn acquire_transition_lease(&self) -> Result<FileLease> {
        FileLease::acquire(&self.transition_lock_path())
    }

    fn clean_stale_ownership(
        &self,
        bridge_binary: &Path,
        config: &BridgeRuntimeConfig,
    ) -> Result<()> {
        let Some(ownership) = read_ownership_record(&self.ownership_path())? else {
            return Ok(());
        };
        if !process_matches_ownership(&ownership) {
            self.remove_ownership_if_matches(&ownership)?;
            return Ok(());
        }
        if !ownership_matches_expected(
            &ownership,
            bridge_binary,
            self.workspace(),
            &config_digest(config),
        )? {
            bail!("bridge configuration changed while the managed process was running; restore the original configuration before starting another bridge");
        }
        Ok(())
    }

    fn remove_ownership_if_matches(&self, expected: &ProcessOwnershipRecord) -> Result<()> {
        if read_ownership_record(&self.ownership_path())?.as_ref() == Some(expected) {
            remove_file_if_exists(&self.ownership_path())?;
        }
        Ok(())
    }

    fn stop_owned_process(&self, ownership: &ProcessOwnershipRecord) -> Result<()> {
        if !process_matches_ownership(ownership) {
            bail!(
                "refusing to stop PID {} because its process identity changed",
                ownership.pid
            );
        }
        if request_process_stop(
            ownership.pid,
            ownership.started_at_epoch_sec,
            ProcessStopRequest::Graceful,
        )? {
            let started_at = Instant::now();
            while started_at.elapsed() < STOP_TIMEOUT {
                if !process_matches_ownership(ownership) {
                    self.remove_ownership_if_matches(ownership)?;
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(200));
            }
        }
        if process_matches_ownership(ownership) {
            request_process_stop(
                ownership.pid,
                ownership.started_at_epoch_sec,
                ProcessStopRequest::Force,
            )?;
        }
        let forced_at = Instant::now();
        while forced_at.elapsed() < Duration::from_secs(3) {
            if !process_matches_ownership(ownership) {
                self.remove_ownership_if_matches(ownership)?;
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
        bail!("bridge process {} did not stop", ownership.pid)
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(1)))
        .build()
        .into()
}

fn resolve_existing_executable(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| candidate.canonicalize().ok())
}

fn read_ownership_record(path: &Path) -> Result<Option<ProcessOwnershipRecord>> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let record: ProcessOwnershipRecord = serde_json::from_slice(&contents).with_context(|| {
        format!(
            "invalid desktop bridge process record at {}",
            path.display()
        )
    })?;
    if record.version != OWNERSHIP_RECORD_VERSION
        || record.pid == 0
        || !valid_sha256_digest(&record.config_sha256)
    {
        bail!(
            "unsupported desktop bridge process record at {}",
            path.display()
        );
    }
    Ok(Some(record))
}

fn write_ownership_record(path: &Path, record: &ProcessOwnershipRecord) -> Result<()> {
    atomic_private_write(path, &serde_json::to_vec_pretty(record)?)
}

fn process_identity(
    pid: u32,
    expected_binary: &Path,
    workspace: &Path,
    config_sha256: &str,
    owner_pid: Option<u32>,
) -> Result<ProcessOwnershipRecord> {
    let mut system = System::new();
    let sysinfo_pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[sysinfo_pid]),
        true,
        ProcessRefreshKind::everything(),
    );
    let process = system
        .process(sysinfo_pid)
        .ok_or_else(|| anyhow!("bridge process {pid} no longer exists"))?;
    let executable = process
        .exe()
        .context("bridge executable identity is unavailable")?
        .canonicalize()?;
    let expected_binary = expected_binary.canonicalize()?;
    if executable != expected_binary {
        bail!("bridge executable identity did not match the launched binary");
    }
    let process_workspace = process
        .cwd()
        .context("bridge working directory identity is unavailable")?
        .canonicalize()?;
    let workspace = workspace.canonicalize()?;
    if process_workspace != workspace {
        bail!("bridge working directory identity did not match the selected workspace");
    }
    let started_at_epoch_sec = process_start_identity(pid, process.start_time())?;
    if started_at_epoch_sec == 0 {
        bail!("bridge process start time is unavailable");
    }
    Ok(ProcessOwnershipRecord {
        version: OWNERSHIP_RECORD_VERSION,
        pid,
        started_at_epoch_sec,
        executable,
        workspace,
        config_sha256: config_sha256.to_string(),
        owner_pid,
    })
}

fn ownership_matches_expected(
    record: &ProcessOwnershipRecord,
    expected_binary: &Path,
    workspace: &Path,
    config_sha256: &str,
) -> Result<bool> {
    Ok(record.version == OWNERSHIP_RECORD_VERSION
        && record.executable == expected_binary.canonicalize()?
        && record.workspace == workspace.canonicalize()?
        && record.config_sha256 == config_sha256)
}

fn process_matches_ownership(record: &ProcessOwnershipRecord) -> bool {
    let mut system = System::new();
    let sysinfo_pid = Pid::from_u32(record.pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[sysinfo_pid]),
        true,
        ProcessRefreshKind::everything(),
    );
    let Some(process) = system.process(sysinfo_pid) else {
        return false;
    };
    let Some(executable) = process.exe().and_then(|path| path.canonicalize().ok()) else {
        return false;
    };
    let Some(workspace) = process.cwd().and_then(|path| path.canonicalize().ok()) else {
        return false;
    };
    process_start_identity(record.pid, process.start_time()).ok()
        == Some(record.started_at_epoch_sec)
        && executable == record.executable
        && workspace == record.workspace
}

/// Digest of everything the bridge was started with except the token, so the ownership record can
/// detect configuration drift without ever containing a secret.
fn config_digest(config: &BridgeRuntimeConfig) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(config.fingerprint_source().as_bytes())
    )
}

fn valid_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::store::ProfileAgent;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };
    use tempfile::tempdir;

    const LIFECYCLE_CHILD: &str = "__supervisor_lifecycle_child";

    fn test_executable() -> PathBuf {
        std::env::current_exe().unwrap().canonicalize().unwrap()
    }

    #[cfg(windows)]
    fn spawn_lifecycle_child(cwd: &Path) -> std::process::Child {
        let mut command = Command::new(test_executable());
        command
            .arg(LIFECYCLE_CHILD)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::platform::detach_process(&mut command);
        command.spawn().expect("spawn lifecycle fixture")
    }

    #[test]
    fn __supervisor_lifecycle_child() {
        if std::env::args().any(|argument| argument == LIFECYCLE_CHILD) {
            thread::sleep(Duration::from_secs(30));
        }
    }

    fn profile(workspace: &Path, port: u16) -> Profile {
        Profile {
            profile_id: "alpha-000000000001".to_string(),
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
                executable: test_executable(),
                argv: vec!["acp".to_string()],
                resolved_version: "local".to_string(),
                verified_digest: format!("sha256:{}", "a".repeat(64)),
            },
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn record(workspace: &Path) -> ProcessOwnershipRecord {
        ProcessOwnershipRecord {
            version: OWNERSHIP_RECORD_VERSION,
            pid: 42,
            started_at_epoch_sec: 1234,
            executable: test_executable(),
            workspace: workspace.to_path_buf(),
            config_sha256: format!("sha256:{}", "a".repeat(64)),
            owner_pid: Some(7),
        }
    }

    #[test]
    fn selects_the_first_existing_bridge_binary() {
        let temp = tempdir().unwrap();
        let missing = temp.path().join("missing");
        let existing = temp.path().join("bridge");
        fs::write(&existing, "binary").unwrap();

        assert_eq!(
            resolve_existing_executable(&[missing, existing.clone()]),
            Some(existing.canonicalize().unwrap())
        );
    }

    #[test]
    fn ownership_record_round_trips_privately_with_the_owner_pid() {
        let temp = tempdir().unwrap();
        let record_path = temp.path().join("process.json");
        let record = record(temp.path());

        write_ownership_record(&record_path, &record).unwrap();
        let loaded = read_ownership_record(&record_path).unwrap().unwrap();
        assert_eq!(loaded.owner_pid, Some(7));
        assert_eq!(loaded, record);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(record_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn rejects_an_ownership_record_written_by_an_older_layout() {
        let temp = tempdir().unwrap();
        let record_path = temp.path().join("process.json");
        let executable = test_executable();
        fs::write(
            &record_path,
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "pid": 42,
                "startedAtEpochSec": 1234,
                "executable": executable,
                "workspace": temp.path(),
                "configSha256": format!("sha256:{}", "a".repeat(64)),
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(read_ownership_record(&record_path)
            .unwrap_err()
            .to_string()
            .contains("unsupported desktop bridge process record"));
    }

    #[test]
    fn ownership_requires_matching_workspace_binary_and_config() {
        let temp = tempdir().unwrap();
        let binary = test_executable();
        let digest = format!("sha256:{}", "a".repeat(64));
        let mut record = record(&temp.path().canonicalize().unwrap());
        record.executable = binary.clone();

        assert!(ownership_matches_expected(&record, &binary, temp.path(), &digest).unwrap());
        let other = format!("sha256:{}", "b".repeat(64));
        assert!(!ownership_matches_expected(&record, &binary, temp.path(), &other).unwrap());

        let mut wrong_start = record;
        wrong_start.started_at_epoch_sec += 1;
        assert!(!process_matches_ownership(&wrong_start));
    }

    #[test]
    fn config_digest_ignores_the_token() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let profile = profile(workspace.path(), 18787);
        paths.prepare_profile(&profile.profile_id).unwrap();
        fs::write(paths.manifest_path(&profile.profile_id), b"{}").unwrap();

        let first = BridgeRuntimeConfig::from_profile(
            &profile,
            "first-token",
            crate::secrets::SecretBackend::File,
            &paths,
        )
        .unwrap();
        let second = BridgeRuntimeConfig::from_profile(
            &profile,
            "second-token",
            crate::secrets::SecretBackend::File,
            &paths,
        )
        .unwrap();

        assert_eq!(config_digest(&first), config_digest(&second));
        assert!(valid_sha256_digest(&config_digest(&first)));
    }

    #[test]
    fn sha256_digest_validation_rejects_each_malformed_component() {
        assert!(!valid_sha256_digest(""));
        assert!(!valid_sha256_digest(&format!("sha512:{}", "a".repeat(64))));
        assert!(!valid_sha256_digest(&format!("sha256:{}", "g".repeat(64))));
        assert!(valid_sha256_digest(&format!("sha256:{}", "A0".repeat(32))));
    }

    #[test]
    fn transition_lease_serializes_profile_mutations() {
        let temp = tempdir().unwrap();
        let lock_path = temp.path().join("transition.lock");
        let first = FileLease::acquire(&lock_path).unwrap();

        let (acquired_tx, acquired_rx) = mpsc::channel();
        let contender_path = lock_path.clone();
        let contender = thread::spawn(move || {
            let second = OpenOptions::new()
                .read(true)
                .write(true)
                .open(contender_path)
                .unwrap();
            second.lock().unwrap();
            acquired_tx.send(()).unwrap();
            second.unlock().unwrap();
        });

        assert!(acquired_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err());
        drop(first);
        acquired_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        contender.join().unwrap();
    }

    #[test]
    fn separate_profiles_do_not_block_each_other() {
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let _alpha = FileLease::acquire(&paths.transition_lock_path("alpha-1")).unwrap();
        let _beta = FileLease::acquire(&paths.transition_lock_path("beta-2")).unwrap();
    }

    fn supervisor_for(
        workspace: &Path,
        data: &Path,
        port: u16,
        with_secret: bool,
    ) -> BridgeSupervisor {
        let paths = AppPaths::for_tests(data.to_path_buf());
        let secrets = SecretStore::file_backend_for_tests();
        let profile = profile(workspace, port);
        paths.prepare_profile(&profile.profile_id).unwrap();
        fs::write(paths.manifest_path(&profile.profile_id), b"{}\n").unwrap();
        if with_secret {
            secrets
                .set_for_tests(&paths, &profile.profile_id, "test-token")
                .unwrap();
        }
        BridgeSupervisor::new(
            profile,
            paths,
            secrets,
            RuntimePaths {
                package_root: data.to_path_buf(),
            },
            None,
        )
    }

    #[test]
    fn snapshot_constructors_describe_every_state() {
        let temp = tempdir().unwrap();
        let needs_setup = BridgeSnapshot::needs_setup(temp.path());
        assert_eq!(needs_setup.state, BridgeState::NeedsSetup);
        assert!(needs_setup.detail.contains("DapperCode"));
        assert!(needs_setup.url.is_none());
        assert!(!needs_setup.managed_process);

        let error = BridgeSnapshot::error("broken");
        assert_eq!(error.state, BridgeState::Error);
        assert_eq!(error.detail, "broken");

        let failure = anyhow!("token missing");
        let stopped = BridgeSnapshot::stopped_with_config_error(&failure);
        assert_eq!(stopped.state, BridgeState::Stopped);
        assert!(stopped.detail.contains("token missing"));

        let owned = BridgeSnapshot::owned_config_error(&failure);
        assert_eq!(owned.state, BridgeState::Inaccessible);
        assert!(owned.managed_process);
        assert!(owned.detail.contains("token missing"));
    }

    #[test]
    fn snapshot_and_stop_use_the_configured_connect_url() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18601, true);
        let config = supervisor.runtime_config().unwrap();

        let stopped = BridgeSnapshot::stopped(&config);
        assert_eq!(stopped.state, BridgeState::Stopped);
        assert_eq!(stopped.url.as_deref(), Some("http://127.0.0.1:18601"));

        let inaccessible = BridgeSnapshot::inaccessible(&config, "unreachable".to_string(), true);
        assert_eq!(inaccessible.state, BridgeState::Inaccessible);
        assert!(inaccessible.managed_process);
        assert_eq!(inaccessible.detail, "unreachable");
    }

    #[test]
    fn reports_an_error_when_the_profile_has_no_stored_token() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18603, false);

        let error = supervisor.runtime_config().unwrap_err();
        assert!(error.to_string().contains("no stored bridge token"));

        let snapshot = supervisor.snapshot();
        assert_eq!(snapshot.state, BridgeState::Error);
        assert!(!snapshot.managed_process);
        assert!(supervisor.start().is_err());
    }

    #[test]
    fn stopping_an_idle_profile_reports_stopped_without_touching_processes() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18605, true);

        assert!(!supervisor.owns_running_process());
        assert_eq!(supervisor.snapshot().state, BridgeState::Stopped);
        assert_eq!(supervisor.stop().unwrap().state, BridgeState::Stopped);
        // Restarting an idle profile still fails, because no bridge binary is installed here.
        assert!(supervisor.restart().is_err());
    }

    #[test]
    fn starting_without_an_installed_bridge_binary_explains_how_to_build_it() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18607, true);

        let error = supervisor.start().unwrap_err();
        assert!(error.to_string().contains("bridge binary is not installed"));
        assert!(resolve_existing_executable(&[]).is_none());
    }

    #[test]
    fn log_path_lives_in_the_profile_directory_not_the_workspace() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18609, true);

        let log_path = supervisor.log_path();
        assert!(log_path.starts_with(data.path()));
        assert!(!log_path.starts_with(workspace.path()));
        assert_eq!(supervisor.workspace(), workspace.path());
        assert_eq!(supervisor.profile().bridge_port, 18609);
    }

    #[test]
    fn rejects_ownership_records_that_are_missing_or_malformed() {
        let temp = tempdir().unwrap();
        let missing = temp.path().join("absent.json");
        assert_eq!(read_ownership_record(&missing).unwrap(), None);

        let malformed = temp.path().join("malformed.json");
        fs::write(&malformed, b"{ not json").unwrap();
        assert!(read_ownership_record(&malformed)
            .unwrap_err()
            .to_string()
            .contains("invalid desktop bridge process record"));

        for mutate in [
            |record: &mut ProcessOwnershipRecord| record.pid = 0,
            |record: &mut ProcessOwnershipRecord| record.config_sha256 = "sha256:short".to_string(),
        ] {
            let path = temp.path().join("record.json");
            let mut record = record(temp.path());
            mutate(&mut record);
            write_ownership_record(&path, &record).unwrap();
            assert!(read_ownership_record(&path).is_err());
        }
    }

    #[test]
    fn validates_digest_shape_before_trusting_a_record() {
        assert!(valid_sha256_digest(&format!("sha256:{}", "a".repeat(64))));
        assert!(!valid_sha256_digest(&format!("sha256:{}", "z".repeat(64))));
        assert!(!valid_sha256_digest(&format!("sha1:{}", "a".repeat(64))));
        assert!(!valid_sha256_digest("sha256:abc"));
    }

    #[test]
    fn ownership_comparison_rejects_a_different_binary_or_workspace() {
        let temp = tempdir().unwrap();
        let other = tempdir().unwrap();
        let binary = test_executable();
        let digest = format!("sha256:{}", "a".repeat(64));
        let mut record = record(&temp.path().canonicalize().unwrap());
        record.executable = binary.clone();

        assert!(ownership_matches_expected(&record, &binary, temp.path(), &digest).unwrap());
        assert!(!ownership_matches_expected(&record, &binary, other.path(), &digest).unwrap());

        let different_binary = temp.path().join("different-binary");
        fs::write(&different_binary, b"not the test executable").unwrap();
        let different_binary = different_binary.canonicalize().unwrap();
        assert!(
            !ownership_matches_expected(&record, &different_binary, temp.path(), &digest).unwrap()
        );

        let mut old_version = record;
        old_version.version = OWNERSHIP_RECORD_VERSION + 1;
        assert!(!ownership_matches_expected(&old_version, &binary, temp.path(), &digest).unwrap());
    }

    #[test]
    fn refuses_to_signal_a_process_whose_identity_changed() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18611, true);
        let mut stale = record(&workspace.path().canonicalize().unwrap());
        stale.pid = u32::MAX - 1;

        let error = supervisor.stop_owned_process(&stale).unwrap_err();
        assert!(error.to_string().contains("process identity changed"));
    }

    #[test]
    fn stopping_a_record_from_another_workspace_is_refused() {
        let workspace = tempdir().unwrap();
        let other = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18613, true);
        let record = record(&other.path().canonicalize().unwrap());
        write_ownership_record(&supervisor.ownership_path(), &record).unwrap();

        let error = supervisor.stop().unwrap_err();
        assert!(error.to_string().contains("different workspace"));
        assert!(!supervisor.owns_running_process());
    }

    #[test]
    fn a_dead_ownership_record_is_cleared_and_reported_as_stopped() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18615, true);
        let mut dead = record(&workspace.path().canonicalize().unwrap());
        dead.pid = u32::MAX - 1;
        write_ownership_record(&supervisor.ownership_path(), &dead).unwrap();

        assert_eq!(supervisor.stop().unwrap().state, BridgeState::Stopped);
        assert!(!supervisor.ownership_path().exists());
    }

    #[test]
    fn projects_every_reported_bridge_status() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18617, true);
        let config = supervisor.runtime_config().unwrap();

        let cases = [
            ("ok", BridgeState::Running, "Bridge running"),
            ("degraded", BridgeState::Degraded, "Bridge degraded"),
            ("unhealthy", BridgeState::Unhealthy, "Bridge unhealthy"),
            ("surprising", BridgeState::Error, "Unknown bridge status"),
        ];
        for (status, expected_state, expected_headline) in cases {
            let projected = supervisor.project_status(
                &config,
                BridgeStatusResponse {
                    status: status.to_string(),
                    uptime_sec: 61,
                    connected_clients: 1,
                    agents: vec![
                        AgentStatus {
                            lifecycle: "ready".to_string(),
                        },
                        AgentStatus {
                            lifecycle: "starting".to_string(),
                        },
                    ],
                    operational: OperationalStatus::default(),
                },
            );
            assert_eq!(projected.state, expected_state);
            assert_eq!(projected.headline, expected_headline);
            assert_eq!(projected.ready_agents, 1);
            assert_eq!(projected.total_agents, 2);
            assert_eq!(projected.uptime_sec, Some(61));
            assert_eq!(projected.detail, "1 connected device · 1/2 agents ready");
        }
    }

    #[test]
    fn pluralizes_only_counts_other_than_one() {
        assert_eq!(plural(0), "s");
        assert_eq!(plural(1), "");
        assert_eq!(plural(2), "s");
    }

    #[test]
    fn health_and_status_probes_fail_closed_when_nothing_is_listening() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18619, true);
        let config = supervisor.runtime_config().unwrap();

        assert!(!supervisor.probe_health(&config));
        assert!(supervisor.fetch_status(&config).is_err());
    }

    #[test]
    fn stale_ownership_is_cleared_before_a_new_start() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18621, true);
        let config = supervisor.runtime_config().unwrap();
        let binary = test_executable();

        supervisor.clean_stale_ownership(&binary, &config).unwrap();

        let mut dead = record(&workspace.path().canonicalize().unwrap());
        dead.pid = u32::MAX - 1;
        write_ownership_record(&supervisor.ownership_path(), &dead).unwrap();
        supervisor.clean_stale_ownership(&binary, &config).unwrap();
        assert!(!supervisor.ownership_path().exists());
    }

    /// Minimal stand-in for a running bridge, so health and authenticated status paths can be
    /// exercised without building a real bridge binary.
    struct FakeBridge {
        port: u16,
        shutdown: Arc<AtomicBool>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl FakeBridge {
        fn start(status_body: &'static str) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            listener.set_nonblocking(true).unwrap();
            let shutdown = Arc::new(AtomicBool::new(false));
            let stop = shutdown.clone();

            let handle = thread::spawn(move || {
                use std::io::{BufRead, BufReader, Write};
                while !stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            stream.set_nonblocking(false).unwrap();
                            let mut reader = BufReader::new(stream.try_clone().unwrap());
                            let mut request_line = String::new();
                            if reader.read_line(&mut request_line).is_err() {
                                continue;
                            }
                            let body = if request_line.contains("/status") {
                                status_body
                            } else {
                                "{}"
                            };
                            let _ = write!(
                                stream,
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            );
                            let _ = stream.flush();
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            });

            Self {
                port,
                shutdown,
                handle: Some(handle),
            }
        }
    }

    impl Drop for FakeBridge {
        fn drop(&mut self) {
            self.shutdown.store(true, Ordering::Relaxed);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    #[test]
    fn reads_authenticated_status_from_a_listening_bridge() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let bridge = FakeBridge::start(
            r#"{"status":"ok","uptimeSec":42,"connectedClients":1,"agents":[{"lifecycle":"ready"}],"operational":{"recentErrors":[]}}"#,
        );
        let supervisor = supervisor_for(workspace.path(), data.path(), bridge.port, true);
        let config = supervisor.runtime_config().unwrap();

        assert!(supervisor.probe_health(&config));
        let status = supervisor.fetch_status(&config).unwrap();
        assert_eq!(status.status, "ok");
        assert_eq!(status.uptime_sec, 42);

        let snapshot = supervisor.snapshot();
        assert_eq!(snapshot.state, BridgeState::Running);
        assert_eq!(snapshot.connected_clients, 1);
        assert_eq!(snapshot.ready_agents, 1);
        assert!(!snapshot.managed_process);
    }

    #[test]
    fn an_unowned_bridge_on_the_configured_port_cannot_be_started_or_stopped() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let bridge = FakeBridge::start(
            r#"{"status":"ok","uptimeSec":1,"connectedClients":0,"agents":[],"operational":{"recentErrors":[]}}"#,
        );
        let supervisor = supervisor_for(workspace.path(), data.path(), bridge.port, true);

        // Starting must not spawn a second bridge over one that is already answering.
        assert_eq!(supervisor.start().unwrap().state, BridgeState::Running);

        let error = supervisor.stop().unwrap_err();
        assert!(error.to_string().contains("not owned by this app"));
    }

    #[test]
    fn a_listener_without_valid_status_is_reported_as_inaccessible() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let bridge = FakeBridge::start("not json");
        let supervisor = supervisor_for(workspace.path(), data.path(), bridge.port, true);

        let snapshot = supervisor.snapshot();
        assert_eq!(snapshot.state, BridgeState::Inaccessible);
        assert!(snapshot.detail.contains("authenticated status failed"));

        let error = supervisor.start().unwrap_err();
        assert!(error
            .to_string()
            .contains("authenticated status is unavailable"));
    }

    #[test]
    fn an_ownership_record_that_is_not_ours_is_left_in_place() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18641, true);
        let stored = record(&workspace.path().canonicalize().unwrap());
        write_ownership_record(&supervisor.ownership_path(), &stored).unwrap();

        let mut different = stored.clone();
        different.pid = stored.pid + 1;
        supervisor.remove_ownership_if_matches(&different).unwrap();
        assert!(supervisor.ownership_path().is_file());

        supervisor.remove_ownership_if_matches(&stored).unwrap();
        assert!(!supervisor.ownership_path().exists());
    }

    #[test]
    fn an_unreadable_ownership_path_is_an_error_not_a_missing_record() {
        let temp = tempdir().unwrap();
        assert!(read_ownership_record(temp.path()).is_err());
    }

    #[test]
    fn a_dead_record_pointing_at_a_live_unowned_bridge_is_refused() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let bridge = FakeBridge::start(
            r#"{"status":"ok","uptimeSec":5,"connectedClients":0,"agents":[],"operational":{"recentErrors":[]}}"#,
        );
        let supervisor = supervisor_for(workspace.path(), data.path(), bridge.port, true);
        let mut dead = record(&workspace.path().canonicalize().unwrap());
        dead.pid = u32::MAX - 1;
        write_ownership_record(&supervisor.ownership_path(), &dead).unwrap();

        let error = supervisor.stop().unwrap_err();
        assert!(error
            .to_string()
            .contains("process identity does not match this app"));
        assert!(!supervisor.ownership_path().exists());
    }

    #[cfg(windows)]
    fn wait_for_windows_fixture_identity(
        pid: u32,
        binary: &Path,
        workspace: &Path,
        digest: &str,
    ) -> ProcessOwnershipRecord {
        (0..40)
            .find_map(|_| {
                let identity =
                    process_identity(pid, binary, workspace, digest, Some(std::process::id())).ok();
                if identity.is_none() {
                    thread::sleep(Duration::from_millis(25));
                }
                identity
            })
            .expect("process identity should become visible")
    }

    #[cfg(windows)]
    #[test]
    fn windows_force_stop_terminates_the_exact_same_user_process() {
        let workspace = tempdir().unwrap();
        let mut child = spawn_lifecycle_child(workspace.path());
        let executable = test_executable();
        let digest = format!("sha256:{}", "a".repeat(64));
        let ownership =
            wait_for_windows_fixture_identity(child.id(), &executable, workspace.path(), &digest);

        request_process_stop(
            ownership.pid,
            ownership.started_at_epoch_sec,
            ProcessStopRequest::Force,
        )
        .unwrap();
        child.wait().unwrap();

        assert!(!process_matches_ownership(&ownership));
    }

    #[cfg(windows)]
    #[test]
    fn windows_supervisor_stop_clears_live_process_ownership() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18649, true);
        let mut child = spawn_lifecycle_child(workspace.path());
        let executable = test_executable();
        let digest = format!("sha256:{}", "b".repeat(64));
        let ownership =
            wait_for_windows_fixture_identity(child.id(), &executable, workspace.path(), &digest);
        write_ownership_record(&supervisor.ownership_path(), &ownership).unwrap();

        supervisor.stop_owned_process(&ownership).unwrap();
        child.wait().unwrap();

        assert!(!process_matches_ownership(&ownership));
        assert!(!supervisor.ownership_path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_matching_live_owner_passes_the_pre_start_ownership_check() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18647, true);
        let config = supervisor.runtime_config().unwrap();

        let sleep_binary = PathBuf::from("/bin/sleep").canonicalize().unwrap();
        let mut child = Command::new(&sleep_binary)
            .arg("30")
            .current_dir(workspace.path())
            .spawn()
            .unwrap();
        let ownership = wait_for_identity(
            child.id(),
            &sleep_binary,
            workspace.path(),
            &config_digest(&config),
        );
        write_ownership_record(&supervisor.ownership_path(), &ownership).unwrap();

        // The recorded configuration still matches, so the check passes and the record survives.
        supervisor
            .clean_stale_ownership(&sleep_binary, &config)
            .unwrap();
        assert!(supervisor.ownership_path().is_file());

        supervisor.stop_owned_process(&ownership).unwrap();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn a_live_owned_process_keeps_reporting_when_its_configuration_breaks() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18643, true);

        let sleep_binary = PathBuf::from("/bin/sleep").canonicalize().unwrap();
        let mut child = Command::new(&sleep_binary)
            .arg("30")
            .current_dir(workspace.path())
            .spawn()
            .unwrap();
        let digest = format!("sha256:{}", "a".repeat(64));
        let ownership = wait_for_identity(child.id(), &sleep_binary, workspace.path(), &digest);
        write_ownership_record(&supervisor.ownership_path(), &ownership).unwrap();

        // Losing the manifest breaks configuration while the owned process is still alive.
        fs::remove_file(
            supervisor
                .paths
                .manifest_path(&supervisor.profile.profile_id),
        )
        .unwrap();
        let snapshot = supervisor.snapshot();

        assert_eq!(snapshot.state, BridgeState::Inaccessible);
        assert!(snapshot.managed_process);
        assert!(snapshot.detail.contains("needs repair"));

        supervisor.stop_owned_process(&ownership).unwrap();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn stopping_a_dead_process_whose_configuration_also_broke_reports_an_error() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18645, true);
        let mut dead = record(&workspace.path().canonicalize().unwrap());
        dead.pid = u32::MAX - 1;
        write_ownership_record(&supervisor.ownership_path(), &dead).unwrap();
        fs::remove_file(
            supervisor
                .paths
                .manifest_path(&supervisor.profile.profile_id),
        )
        .unwrap();

        let snapshot = supervisor.stop().unwrap();
        assert_eq!(snapshot.state, BridgeState::Error);
        assert!(snapshot.detail.contains("needs repair"));
    }

    #[cfg(unix)]
    #[test]
    fn a_live_owned_bridge_is_stopped_and_its_records_cleared() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18631, true);

        let sleep_binary = PathBuf::from("/bin/sleep").canonicalize().unwrap();
        let mut child = Command::new(&sleep_binary)
            .arg("30")
            .current_dir(workspace.path())
            .spawn()
            .unwrap();
        let digest = format!("sha256:{}", "a".repeat(64));
        let ownership = wait_for_identity(child.id(), &sleep_binary, workspace.path(), &digest);

        write_ownership_record(&supervisor.ownership_path(), &ownership).unwrap();

        assert!(supervisor.owns_running_process());
        assert!(process_matches_ownership(&ownership));
        assert_eq!(supervisor.snapshot().state, BridgeState::Inaccessible);

        supervisor.stop_owned_process(&ownership).unwrap();
        let _ = child.wait();
        assert!(!process_matches_ownership(&ownership));
        assert!(!supervisor.ownership_path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn restarting_a_live_bridge_stops_it_before_reporting_a_missing_binary() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18633, true);

        let sleep_binary = PathBuf::from("/bin/sleep").canonicalize().unwrap();
        let mut child = Command::new(&sleep_binary)
            .arg("30")
            .current_dir(workspace.path())
            .spawn()
            .unwrap();
        let digest = format!("sha256:{}", "a".repeat(64));
        let ownership = wait_for_identity(child.id(), &sleep_binary, workspace.path(), &digest);
        write_ownership_record(&supervisor.ownership_path(), &ownership).unwrap();

        let error = supervisor.restart().unwrap_err();
        let _ = child.wait();

        assert!(error.to_string().contains("bridge binary is not installed"));
        assert!(!process_matches_ownership(&ownership));
        assert!(!supervisor.ownership_path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn configuration_drift_blocks_starting_a_second_bridge() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18635, true);
        let config = supervisor.runtime_config().unwrap();

        let sleep_binary = PathBuf::from("/bin/sleep").canonicalize().unwrap();
        let mut child = Command::new(&sleep_binary)
            .arg("30")
            .current_dir(workspace.path())
            .spawn()
            .unwrap();
        let stale_digest = format!("sha256:{}", "b".repeat(64));
        let ownership =
            wait_for_identity(child.id(), &sleep_binary, workspace.path(), &stale_digest);
        write_ownership_record(&supervisor.ownership_path(), &ownership).unwrap();

        let error = supervisor
            .clean_stale_ownership(&sleep_binary, &config)
            .unwrap_err();
        assert!(error.to_string().contains("configuration changed"));

        supervisor.stop_owned_process(&ownership).unwrap();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn process_identity_rejects_a_mismatched_binary_or_workspace() {
        let workspace = tempdir().unwrap();
        let other = tempdir().unwrap();
        let sleep_binary = PathBuf::from("/bin/sleep").canonicalize().unwrap();
        let echo_binary = PathBuf::from("/bin/echo").canonicalize().unwrap();
        let digest = format!("sha256:{}", "a".repeat(64));

        let mut child = Command::new(&sleep_binary)
            .arg("30")
            .current_dir(workspace.path())
            .spawn()
            .unwrap();
        wait_for_identity(child.id(), &sleep_binary, workspace.path(), &digest);

        assert!(
            process_identity(child.id(), &echo_binary, workspace.path(), &digest, None)
                .unwrap_err()
                .to_string()
                .contains("executable identity")
        );
        assert!(
            process_identity(child.id(), &sleep_binary, other.path(), &digest, None)
                .unwrap_err()
                .to_string()
                .contains("working directory identity")
        );

        child.kill().unwrap();
        let _ = child.wait();
        assert!(
            process_identity(child.id(), &sleep_binary, workspace.path(), &digest, None).is_err()
        );
    }

    #[cfg(unix)]
    fn wait_for_identity(
        pid: u32,
        binary: &Path,
        workspace: &Path,
        digest: &str,
    ) -> ProcessOwnershipRecord {
        (0..40)
            .find_map(|_| {
                let identity =
                    process_identity(pid, binary, workspace, digest, Some(std::process::id())).ok();
                if identity.is_none() {
                    thread::sleep(Duration::from_millis(25));
                }
                identity
            })
            .expect("process identity should become visible")
    }

    #[cfg(unix)]
    #[test]
    fn live_owned_process_with_failed_health_cannot_start_again() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let secrets = SecretStore::file_backend_for_tests();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let profile = profile(workspace.path(), port);
        paths.prepare_profile(&profile.profile_id).unwrap();
        fs::write(paths.manifest_path(&profile.profile_id), b"{}\n").unwrap();
        secrets
            .set_for_tests(&paths, &profile.profile_id, "test-token")
            .unwrap();

        let sleep_binary = PathBuf::from("/bin/sleep").canonicalize().unwrap();
        let mut child = Command::new(&sleep_binary)
            .arg("30")
            .current_dir(workspace.path())
            .spawn()
            .unwrap();
        let digest = format!("sha256:{}", "a".repeat(64));
        let ownership = (0..20)
            .find_map(|_| {
                let identity = process_identity(
                    child.id(),
                    &sleep_binary,
                    workspace.path(),
                    &digest,
                    Some(std::process::id()),
                )
                .ok();
                if identity.is_none() {
                    thread::sleep(Duration::from_millis(25));
                }
                identity
            })
            .expect("sleep process identity");
        let ownership_path = paths.ownership_path(&profile.profile_id);
        write_ownership_record(&ownership_path, &ownership).unwrap();
        let before = fs::read(&ownership_path).unwrap();

        let runtime = RuntimePaths {
            package_root: workspace.path().to_path_buf(),
        };
        let supervisor =
            BridgeSupervisor::new(profile, paths, secrets, runtime, Some(std::process::id()));
        let snapshot = supervisor.snapshot();
        assert_eq!(snapshot.state, BridgeState::Inaccessible);
        assert!(snapshot.managed_process);

        let start_result = supervisor.start().unwrap();
        assert_eq!(start_result.state, BridgeState::Inaccessible);
        assert!(start_result.managed_process);
        assert_eq!(fs::read(&ownership_path).unwrap(), before);
        assert!(child.try_wait().unwrap().is_none());

        let stopped = supervisor.stop().unwrap();
        assert_eq!(stopped.state, BridgeState::Stopped);
        let _ = child.wait();
        assert!(!ownership_path.exists());
        drop(listener);
    }

    #[test]
    fn parses_the_bounded_status_contract() {
        let status: BridgeStatusResponse = serde_json::from_str(
            r#"{
                "status":"degraded",
                "uptimeSec":61,
                "connectedClients":2,
                "agents":[{"lifecycle":"ready"},{"lifecycle":"unavailable"}],
                "operational":{"recentErrors":[{}]}
            }"#,
        )
        .unwrap();

        assert_eq!(status.status, "degraded");
        assert_eq!(status.connected_clients, 2);
        assert_eq!(status.agents.len(), 2);
        assert_eq!(status.operational.recent_errors.len(), 1);
    }
}
