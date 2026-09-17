use std::{
    fs, io,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::{
    config::BridgeRuntimeConfig,
    platform::{process_start_identity, request_process_stop, ProcessStopRequest},
    secrets::SecretStore,
    store::{remove_file_if_exists, AppPaths, FileLease, Profile},
};

const STATUS_BODY_LIMIT_BYTES: u64 = 2 * 1024 * 1024;
const STOP_TIMEOUT: Duration = Duration::from_secs(12);
const OWNERSHIP_RECORD_VERSION: u32 = 2;

/// Stops app-owned bridges left by the pre-broker desktop layout during migration.
#[derive(Clone, Debug)]
pub struct BridgeSupervisor {
    profile: Profile,
    paths: AppPaths,
    secrets: SecretStore,
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
}

// Migration only checks whether /status deserializes, so these decoded fields are never read.
// Keep them for Serde's schema validation; removing them would let malformed fields be ignored.
#[allow(dead_code)]
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

// Serde validates lifecycle as a string even though migration never reads its decoded value.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    lifecycle: String,
}

// Serde validates recentErrors as an array even though migration never reads its entries.
#[allow(dead_code)]
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
    pub fn new(profile: Profile, paths: AppPaths, secrets: SecretStore) -> Self {
        Self {
            profile,
            paths,
            secrets,
        }
    }

    fn workspace(&self) -> &Path {
        &self.profile.workspace
    }

    fn runtime_config(&self) -> Result<BridgeRuntimeConfig> {
        let secret = self
            .secrets
            .get(&self.paths, &self.profile.profile_id)?
            .context("no stored bridge token for this workspace; run setup again")?;
        BridgeRuntimeConfig::from_profile(&self.profile, &secret.token, secret.backend, &self.paths)
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

    pub fn owns_running_process(&self) -> bool {
        let Ok(Some(ownership)) = read_ownership_record(&self.ownership_path()) else {
            return false;
        };
        self.workspace()
            .canonicalize()
            .is_ok_and(|workspace| ownership.workspace == workspace)
            && process_matches_ownership(&ownership)
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

    fn ownership_path(&self) -> PathBuf {
        self.paths.ownership_path(&self.profile.profile_id)
    }

    fn transition_lock_path(&self) -> PathBuf {
        self.paths.transition_lock_path(&self.profile.profile_id)
    }

    /// Preserve the old per-profile lock while stopping bridges from the previous layout.
    fn acquire_transition_lease(&self) -> Result<FileLease> {
        FileLease::acquire(&self.transition_lock_path())
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

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(1)))
        .build()
        .into()
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

#[cfg(test)]
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
        .ok_or_else(|| anyhow::anyhow!("bridge process {pid} no longer exists"))?;
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

fn valid_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::store::{atomic_private_write, ProfileAgent};
    use anyhow::anyhow;
    #[cfg(windows)]
    use std::process::Stdio;
    use std::{
        fs::OpenOptions,
        process::Command,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        },
    };
    use tempfile::tempdir;

    const LIFECYCLE_CHILD: &str = "__supervisor_lifecycle_child";

    fn test_executable() -> PathBuf {
        std::env::current_exe().unwrap().canonicalize().unwrap()
    }

    fn write_ownership_record(path: &Path, record: &ProcessOwnershipRecord) -> Result<()> {
        atomic_private_write(path, &serde_json::to_vec_pretty(record)?)
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
                launcher_path: None,
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
    fn ownership_requires_matching_live_process_start_binary_and_workspace() {
        let temp = tempdir().unwrap();
        let binary = test_executable();
        let workspace = std::env::current_dir().unwrap().canonicalize().unwrap();
        let digest = format!("sha256:{}", "a".repeat(64));
        let record =
            process_identity(std::process::id(), &binary, &workspace, &digest, None).unwrap();
        assert!(process_matches_ownership(&record));

        let mut wrong_start = record.clone();
        wrong_start.started_at_epoch_sec += 1;
        assert!(!process_matches_ownership(&wrong_start));

        let mut wrong_binary = record.clone();
        wrong_binary.executable = temp.path().join("different-binary");
        assert!(!process_matches_ownership(&wrong_binary));

        let mut wrong_workspace = record;
        wrong_workspace.workspace = temp.path().canonicalize().unwrap();
        assert!(!process_matches_ownership(&wrong_workspace));
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

    #[test]
    fn migration_stop_waits_for_the_legacy_profile_transition_lease() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18603, false);
        let lease = FileLease::acquire(&supervisor.transition_lock_path()).unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let stopping = thread::spawn(move || {
            entered_tx.send(()).unwrap();
            finished_tx.send(supervisor.stop()).unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(finished_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        drop(lease);
        let error = finished_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("no stored bridge token"));
        stopping.join().unwrap();
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
        BridgeSupervisor::new(profile, paths, secrets)
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
    }

    #[test]
    fn stopped_snapshot_uses_the_configured_connect_url() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18601, true);
        let config = supervisor.runtime_config().unwrap();

        let stopped = BridgeSnapshot::stopped(&config);
        assert_eq!(stopped.state, BridgeState::Stopped);
        assert_eq!(stopped.url.as_deref(), Some("http://127.0.0.1:18601"));
    }

    #[test]
    fn reports_an_error_when_the_profile_has_no_stored_token() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18603, false);

        let error = supervisor.runtime_config().unwrap_err();
        assert!(error.to_string().contains("no stored bridge token"));

        assert!(supervisor
            .stop()
            .unwrap_err()
            .to_string()
            .contains("no stored bridge token"));
    }

    #[test]
    fn stopping_an_idle_profile_reports_stopped_without_touching_processes() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18605, true);

        assert!(!supervisor.owns_running_process());
        assert_eq!(supervisor.stop().unwrap().state, BridgeState::Stopped);
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
    fn status_probe_fails_closed_when_nothing_is_listening() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let supervisor = supervisor_for(workspace.path(), data.path(), 18619, true);
        let config = supervisor.runtime_config().unwrap();

        assert!(supervisor.fetch_status(&config).is_err());
    }

    /// Minimal stand-in for a running bridge, so authenticated status checks can be
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
                            stream
                                .set_read_timeout(Some(Duration::from_secs(1)))
                                .unwrap();
                            let mut reader = BufReader::new(stream.try_clone().unwrap());
                            let mut request_line = String::new();
                            if reader.read_line(&mut request_line).is_err() {
                                continue;
                            }
                            assert!(request_line.starts_with("GET /status "));
                            let mut authorized = false;
                            loop {
                                let mut header = String::new();
                                let bytes = reader.read_line(&mut header).unwrap();
                                if bytes == 0 || header == "\r\n" {
                                    break;
                                }
                                if let Some((name, value)) = header.split_once(':') {
                                    if name.eq_ignore_ascii_case("authorization") {
                                        authorized = value.trim() == "Bearer test-token";
                                    }
                                }
                            }
                            assert!(authorized, "legacy status requests must authenticate");
                            let body = status_body;
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
                handle.join().expect("authenticated status fixture");
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

        let status = supervisor.fetch_status(&config).unwrap();
        assert_eq!(status.status, "ok");
        assert_eq!(status.uptime_sec, 42);
        assert_eq!(status.connected_clients, 1);
        assert_eq!(status.agents[0].lifecycle, "ready");
    }

    #[test]
    fn an_unowned_bridge_on_the_configured_port_cannot_be_stopped() {
        let workspace = tempdir().unwrap();
        let data = tempdir().unwrap();
        let bridge = FakeBridge::start(
            r#"{"status":"ok","uptimeSec":1,"connectedClients":0,"agents":[],"operational":{"recentErrors":[]}}"#,
        );
        let supervisor = supervisor_for(workspace.path(), data.path(), bridge.port, true);

        let error = supervisor.stop().unwrap_err();
        assert!(error.to_string().contains("not owned by this app"));
        assert!(!supervisor.ownership_path().exists());
        assert!(supervisor
            .fetch_status(&supervisor.runtime_config().unwrap())
            .is_ok());
    }

    #[test]
    fn a_listener_without_a_valid_status_contract_is_not_treated_as_a_bridge() {
        for body in [
            "not json",
            "{}",
            r#"{"status":"ok","uptimeSec":"invalid","connectedClients":0}"#,
        ] {
            let workspace = tempdir().unwrap();
            let data = tempdir().unwrap();
            let bridge = FakeBridge::start(body);
            let supervisor = supervisor_for(workspace.path(), data.path(), bridge.port, true);
            let error = supervisor
                .fetch_status(&supervisor.runtime_config().unwrap())
                .unwrap_err();
            assert!(error.to_string().contains("malformed status JSON"));
            assert_eq!(supervisor.stop().unwrap().state, BridgeState::Stopped);
            assert!(!supervisor.ownership_path().exists());
        }
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

        assert!(supervisor.owns_running_process());
        let stopped = supervisor.stop().unwrap();
        assert_eq!(stopped.state, BridgeState::Stopped);
        assert!(!stopped.managed_process);
        child.wait().unwrap();

        assert!(!process_matches_ownership(&ownership));
        assert!(!supervisor.ownership_path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_live_owned_process_can_be_stopped_when_its_configuration_breaks() {
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
        assert!(supervisor.owns_running_process());
        let snapshot = supervisor.stop().unwrap();
        assert_eq!(snapshot.state, BridgeState::Stopped);
        assert!(!snapshot.managed_process);
        assert!(snapshot.detail.contains("needs repair"));
        let _ = child.wait();
        assert!(!supervisor.owns_running_process());
        assert!(!supervisor.ownership_path().exists());
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
        let stopped = supervisor.stop().unwrap();
        assert_eq!(stopped.state, BridgeState::Stopped);
        assert_eq!(stopped.headline, "Bridge stopped");
        assert!(!stopped.managed_process);
        assert!(stopped.uptime_sec.is_none());
        assert_eq!(stopped.connected_clients, 0);
        let _ = child.wait();
        assert!(!process_matches_ownership(&ownership));
        assert!(!supervisor.ownership_path().exists());
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
    fn migration_stop_preserves_profile_data_when_health_is_unavailable() {
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
        paths
            .update_config(|config| {
                config.upsert(profile.clone());
                Ok(())
            })
            .unwrap();
        let config_before = fs::read(paths.config_path()).unwrap();
        let manifest_path = paths.manifest_path(&profile.profile_id);
        let manifest_before = fs::read(&manifest_path).unwrap();
        let log_path = paths.log_path(&profile.profile_id);
        fs::write(&log_path, b"preserved legacy log").unwrap();
        let state_path = paths.state_dir(&profile.profile_id).join("state.json");
        fs::write(&state_path, b"preserved session state").unwrap();
        let supervisor = BridgeSupervisor::new(profile.clone(), paths.clone(), secrets.clone());
        assert!(supervisor.owns_running_process());
        assert!(child.try_wait().unwrap().is_none());

        let stopped = supervisor.stop().unwrap();
        assert_eq!(stopped.state, BridgeState::Stopped);
        assert!(!stopped.managed_process);
        let _ = child.wait();
        assert!(!supervisor.owns_running_process());
        assert!(!ownership_path.exists());
        assert_eq!(fs::read(paths.config_path()).unwrap(), config_before);
        assert_eq!(fs::read(manifest_path).unwrap(), manifest_before);
        assert_eq!(fs::read(log_path).unwrap(), b"preserved legacy log");
        assert_eq!(fs::read(state_path).unwrap(), b"preserved session state");
        assert_eq!(
            secrets
                .get(&paths, &profile.profile_id)
                .unwrap()
                .unwrap()
                .token,
            "test-token"
        );
        drop(FileLease::acquire(&paths.transition_lock_path(&profile.profile_id)).unwrap());
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
