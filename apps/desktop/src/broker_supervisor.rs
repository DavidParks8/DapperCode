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
    config::BridgeRuntimeConfig,
    platform::{detach_process, process_start_identity, request_process_stop, ProcessStopRequest},
    secrets::SecretStore,
    store::{
        atomic_private_write, remove_file_if_exists, AppPaths, BrokerSettings, FileLease, Profile,
    },
    supervisor::{BridgeSnapshot, BridgeState},
};

const START_TIMEOUT: Duration = Duration::from_secs(30);
const START_POLL_INTERVAL: Duration = Duration::from_millis(200);
const STOP_TIMEOUT: Duration = Duration::from_secs(12);
const OWNERSHIP_VERSION: u32 = 1;

#[derive(Clone, Debug)]
pub struct BrokerSupervisor {
    profile: Profile,
    settings: BrokerSettings,
    paths: AppPaths,
    secrets: SecretStore,
    owner_pid: Option<u32>,
}

#[derive(Clone, Copy)]
pub enum BrokerLifecycleAction {
    Start,
    Stop,
    Restart,
}

#[derive(Debug, PartialEq, Eq)]
enum BrokerStartupWait {
    Healthy,
    Exited,
    TimedOut,
}

fn wait_for_broker_start(
    timeout: Duration,
    poll_interval: Duration,
    elapsed: &mut dyn FnMut() -> Duration,
    fetch_health: &mut dyn FnMut() -> bool,
    process_matches: &mut dyn FnMut() -> bool,
    sleep: &mut dyn FnMut(Duration),
) -> BrokerStartupWait {
    while elapsed() < timeout {
        if fetch_health() {
            return BrokerStartupWait::Healthy;
        }
        if !process_matches() {
            return if fetch_health() {
                BrokerStartupWait::Healthy
            } else {
                BrokerStartupWait::Exited
            };
        }
        sleep(poll_interval);
    }
    if fetch_health() {
        BrokerStartupWait::Healthy
    } else if !process_matches() {
        if fetch_health() {
            BrokerStartupWait::Healthy
        } else {
            BrokerStartupWait::Exited
        }
    } else {
        BrokerStartupWait::TimedOut
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrokerHealth {
    status: String,
    uptime_sec: u64,
    configured_workspaces: usize,
    running_workers: usize,
    connected_clients: usize,
    busy_workers: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrokerOwnershipRecord {
    version: u32,
    pid: u32,
    started_at_epoch_sec: u64,
    executable: PathBuf,
    data_dir: PathBuf,
    config_sha256: String,
    #[serde(default)]
    owner_pid: Option<u32>,
}

impl BrokerSupervisor {
    pub fn new(
        profile: Profile,
        settings: BrokerSettings,
        paths: AppPaths,
        secrets: SecretStore,
        owner_pid: Option<u32>,
    ) -> Self {
        Self {
            profile,
            settings,
            paths,
            secrets,
            owner_pid,
        }
    }

    pub fn profile(&self) -> &Profile {
        &self.profile
    }

    pub fn runtime_config(&self) -> Result<BridgeRuntimeConfig> {
        let secret = self
            .secrets
            .get(&self.paths, &self.profile.profile_id)?
            .context("no stored workspace credential; start the broker or run setup again")?;
        BridgeRuntimeConfig::from_profile(&self.profile, &secret.token, secret.backend, &self.paths)
    }

    pub fn snapshot(&self) -> BridgeSnapshot {
        match self.fetch_health() {
            Ok(health) => BridgeSnapshot {
                state: BridgeState::Running,
                headline: "Broker running".to_string(),
                detail: format!(
                    "{} workspace{} configured · {} worker{} running · {} busy · {} connected device{}",
                    health.configured_workspaces,
                    plural(health.configured_workspaces),
                    health.running_workers,
                    plural(health.running_workers),
                    health.busy_workers,
                    health.connected_clients,
                    plural(health.connected_clients),
                ),
                url: Some(self.settings.connect_url.clone()),
                uptime_sec: Some(health.uptime_sec),
                connected_clients: health.connected_clients,
                ready_agents: health.running_workers.saturating_sub(health.busy_workers),
                total_agents: health.running_workers,
                recent_error_count: 0,
                managed_process: self.owns_running_process(),
            },
            Err(error) if self.owns_running_process() => BridgeSnapshot {
                state: BridgeState::Inaccessible,
                headline: "Broker starting".to_string(),
                detail: format!("The broker process is running but not reachable yet: {error}"),
                url: Some(self.settings.connect_url.clone()),
                uptime_sec: None,
                connected_clients: 0,
                ready_agents: 0,
                total_agents: 0,
                recent_error_count: 0,
                managed_process: true,
            },
            Err(_) => BridgeSnapshot {
                state: BridgeState::Stopped,
                headline: "Broker stopped".to_string(),
                detail: "Start DapperCode to make every configured workspace reachable.".to_string(),
                url: Some(self.settings.connect_url.clone()),
                uptime_sec: None,
                connected_clients: 0,
                ready_agents: 0,
                total_agents: 0,
                recent_error_count: 0,
                managed_process: false,
            },
        }
    }

    fn start_locked(&self) -> Result<BridgeSnapshot> {
        if self.fetch_health().is_ok() {
            if self.owns_running_process() {
                return Ok(self.snapshot());
            }
            bail!("a broker is already listening but is not owned by this desktop app");
        }
        if self.owns_running_process() {
            bail!("the owned broker process is running but its health endpoint is unavailable");
        }
        self.clean_stale_ownership()?;
        let executable = std::env::current_exe()?.canonicalize()?;
        let log_path = self.paths.broker_log_path();
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .with_context(|| format!("failed to open {}", log_path.display()))?;
        let stderr = stdout.try_clone()?;
        let mut command = Command::new(&executable);
        command
            .arg("__broker")
            .current_dir(self.paths.base_dir())
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        if let Some(owner_pid) = self.owner_pid {
            command.args(["--owner-pid", &owner_pid.to_string()]);
        }
        detach_process(&mut command);
        let mut child = command.spawn().context("failed to start desktop broker")?;
        let ownership = match process_identity(
            child.id(),
            &executable,
            self.paths.base_dir(),
            &settings_digest(&self.settings),
            self.owner_pid,
        ) {
            Ok(ownership) => ownership,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error).context("failed to establish broker process ownership");
            }
        };
        if let Err(error) = write_ownership(&self.paths.broker_ownership_path(), &ownership) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        thread::spawn(move || {
            let _ = child.wait();
        });

        let started = Instant::now();
        let mut elapsed = || started.elapsed();
        let mut fetch_health = || self.fetch_health().is_ok();
        let mut process_alive = || process_matches(&ownership);
        let mut sleep = thread::sleep;
        match wait_for_broker_start(
            START_TIMEOUT,
            START_POLL_INTERVAL,
            &mut elapsed,
            &mut fetch_health,
            &mut process_alive,
            &mut sleep,
        ) {
            BrokerStartupWait::Healthy => return Ok(self.snapshot()),
            BrokerStartupWait::Exited => {
                let _ = remove_file_if_exists(&self.paths.broker_ownership_path());
                bail!(
                    "broker exited before becoming healthy; inspect {}",
                    log_path.display()
                );
            }
            BrokerStartupWait::TimedOut => {}
        }
        if let Err(error) = stop_owned_process(&ownership, &self.paths.broker_ownership_path()) {
            bail!(
                "broker did not become healthy within {} seconds and could not be stopped cleanly: {error:#}; inspect {}",
                START_TIMEOUT.as_secs(),
                log_path.display()
            );
        }
        bail!(
            "broker did not become healthy within {} seconds; inspect {}",
            START_TIMEOUT.as_secs(),
            log_path.display()
        )
    }

    pub fn stop(&self) -> Result<BridgeSnapshot> {
        let _lease = self.acquire_transition_lease()?;
        self.stop_locked()
    }

    fn stop_locked(&self) -> Result<BridgeSnapshot> {
        let Some(ownership) = read_ownership(&self.paths.broker_ownership_path())? else {
            if self.fetch_health().is_ok() {
                bail!("a broker is running but is not owned by this desktop app");
            }
            return Ok(self.snapshot());
        };
        if !process_matches(&ownership) {
            remove_file_if_exists(&self.paths.broker_ownership_path())?;
            return Ok(self.snapshot());
        }
        stop_owned_process(&ownership, &self.paths.broker_ownership_path())?;
        Ok(self.snapshot())
    }

    fn restart_locked(&self) -> Result<BridgeSnapshot> {
        if let Some(ownership) = read_ownership(&self.paths.broker_ownership_path())? {
            if process_matches(&ownership) {
                stop_owned_process(&ownership, &self.paths.broker_ownership_path())?;
            } else {
                remove_file_if_exists(&self.paths.broker_ownership_path())?;
            }
        }
        self.start_locked()
    }

    pub fn transition_and_remember(
        &self,
        action: BrokerLifecycleAction,
    ) -> Result<(BridgeSnapshot, bool)> {
        let _lease = self.acquire_transition_lease()?;
        let was_running = self.owns_running_process();
        let snapshot = match action {
            BrokerLifecycleAction::Start => self.start_locked()?,
            BrokerLifecycleAction::Stop => self.stop_locked()?,
            BrokerLifecycleAction::Restart => self.restart_locked()?,
        };
        let auto_start = !matches!(action, BrokerLifecycleAction::Stop);
        let profile_id = self.profile.profile_id.clone();
        let snapshot = Self::persist_transition_or_restore(
            snapshot,
            was_running,
            || {
                self.paths.update_config(|config| {
                    config.find(&profile_id).with_context(|| {
                        format!("profile {profile_id} disappeared during broker transition")
                    })?;
                    let broker = config
                        .broker
                        .as_mut()
                        .context("broker settings disappeared during broker transition")?;
                    broker.auto_start = auto_start;
                    for profile in &mut config.profiles {
                        profile.auto_start = auto_start;
                    }
                    Ok(())
                })
            },
            |should_be_running| self.restore_process_state_locked(should_be_running),
        )?;
        Ok((snapshot, auto_start))
    }

    fn restore_process_state_locked(&self, should_be_running: bool) -> Result<()> {
        match (should_be_running, self.owns_running_process()) {
            (true, false) => self.start_locked().map(|_| ()),
            (false, true) => self.stop_locked().map(|_| ()),
            _ => Ok(()),
        }
    }

    pub fn owns_running_process(&self) -> bool {
        read_ownership(&self.paths.broker_ownership_path())
            .ok()
            .flatten()
            .is_some_and(|record| process_matches(&record))
    }

    fn persist_transition_or_restore<T>(
        outcome: T,
        was_running: bool,
        persist: impl FnOnce() -> Result<()>,
        restore: impl FnOnce(bool) -> Result<()>,
    ) -> Result<T> {
        match persist() {
            Ok(()) => Ok(outcome),
            Err(error) => match restore(was_running) {
                Ok(()) => Err(error),
                Err(rollback) => Err(anyhow!(
                    "{error:#}; restoring the prior broker process state also failed: {rollback:#}"
                )),
            },
        }
    }

    fn fetch_health(&self) -> Result<BrokerHealth> {
        let host = match self.settings.host.as_str() {
            "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
            host => host,
        };
        let url = format!(
            "http://{}:{}/health",
            crate::config::format_host(host),
            self.settings.bridge_port
        );
        let mut response = http_agent()
            .get(&url)
            .call()
            .with_context(|| format!("broker health unavailable at {url}"))?;
        let body = response
            .body_mut()
            .with_config()
            .limit(1024 * 1024)
            .read_to_string()
            .context("broker health response was invalid")?;
        let health: BrokerHealth =
            serde_json::from_str(&body).context("broker returned malformed health JSON")?;
        if health.status != "ok" {
            bail!("broker reported status {}", health.status);
        }
        Ok(health)
    }

    fn acquire_transition_lease(&self) -> Result<FileLease> {
        FileLease::acquire(&self.paths.broker_transition_lock_path())
    }

    fn clean_stale_ownership(&self) -> Result<()> {
        let Some(record) = read_ownership(&self.paths.broker_ownership_path())? else {
            return Ok(());
        };
        if !process_matches(&record) {
            remove_file_if_exists(&self.paths.broker_ownership_path())?;
            return Ok(());
        }
        let executable = std::env::current_exe()?.canonicalize()?;
        if record.executable != executable
            || record.data_dir != self.paths.base_dir().canonicalize()?
            || record.config_sha256 != settings_digest(&self.settings)
        {
            bail!("broker configuration changed while its managed process was running");
        }
        Ok(())
    }
}

pub fn clean_stale_broker_ownership(paths: &AppPaths) -> Result<bool> {
    let Some(record) = read_ownership(&paths.broker_ownership_path())? else {
        return Ok(false);
    };
    if process_matches(&record) {
        return Ok(true);
    }
    remove_file_if_exists(&paths.broker_ownership_path())?;
    Ok(false)
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

fn settings_digest(settings: &BrokerSettings) -> String {
    let encoded = serde_json::to_vec(settings).expect("broker settings serialize");
    format!("sha256:{:x}", Sha256::digest(encoded))
}

fn process_identity(
    pid: u32,
    executable: &Path,
    data_dir: &Path,
    config_sha256: &str,
    owner_pid: Option<u32>,
) -> Result<BrokerOwnershipRecord> {
    let mut system = System::new();
    let pid_value = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid_value]),
        true,
        ProcessRefreshKind::everything(),
    );
    let process = system
        .process(pid_value)
        .ok_or_else(|| anyhow!("broker process {pid} no longer exists"))?;
    let actual_executable = process
        .exe()
        .context("broker executable identity is unavailable")?
        .canonicalize()?;
    let actual_data_dir = process
        .cwd()
        .context("broker working directory identity is unavailable")?
        .canonicalize()?;
    if actual_executable != executable.canonicalize()? {
        bail!("broker executable identity did not match the launched binary");
    }
    if actual_data_dir != data_dir.canonicalize()? {
        bail!("broker working directory identity did not match the data directory");
    }
    let started_at_epoch_sec = process_start_identity(pid, process.start_time())?;
    if started_at_epoch_sec == 0 {
        bail!("broker process start time is unavailable");
    }
    Ok(BrokerOwnershipRecord {
        version: OWNERSHIP_VERSION,
        pid,
        started_at_epoch_sec,
        executable: actual_executable,
        data_dir: actual_data_dir,
        config_sha256: config_sha256.to_string(),
        owner_pid,
    })
}

fn process_matches(record: &BrokerOwnershipRecord) -> bool {
    let mut system = System::new();
    let pid = Pid::from_u32(record.pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::everything(),
    );
    let Some(process) = system.process(pid) else {
        return false;
    };
    process_start_identity(record.pid, process.start_time()).ok()
        == Some(record.started_at_epoch_sec)
        && process.exe().and_then(|path| path.canonicalize().ok())
            == Some(record.executable.clone())
        && process.cwd().and_then(|path| path.canonicalize().ok()) == Some(record.data_dir.clone())
}

fn read_ownership(path: &Path) -> Result<Option<BrokerOwnershipRecord>> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let record: BrokerOwnershipRecord = serde_json::from_slice(&contents)
        .with_context(|| format!("invalid broker ownership record at {}", path.display()))?;
    if record.version != OWNERSHIP_VERSION
        || record.pid == 0
        || record.config_sha256.len() != 71
        || !record.config_sha256.starts_with("sha256:")
    {
        bail!("unsupported broker ownership record at {}", path.display());
    }
    Ok(Some(record))
}

fn write_ownership(path: &Path, record: &BrokerOwnershipRecord) -> Result<()> {
    atomic_private_write(path, &serde_json::to_vec_pretty(record)?)
}

fn stop_owned_process(record: &BrokerOwnershipRecord, ownership_path: &Path) -> Result<()> {
    if !process_matches(record) {
        if !process_exists(record.pid) {
            remove_file_if_exists(ownership_path)?;
            return Ok(());
        }
        bail!(
            "refusing to stop PID {} because its process identity changed",
            record.pid
        );
    }
    if request_process_stop(
        record.pid,
        record.started_at_epoch_sec,
        ProcessStopRequest::Graceful,
    )? {
        let started = Instant::now();
        while started.elapsed() < STOP_TIMEOUT {
            if !process_matches(record) {
                remove_file_if_exists(ownership_path)?;
                return Ok(());
            }
            thread::sleep(Duration::from_millis(200));
        }
    }
    if process_matches(record) {
        request_process_stop(
            record.pid,
            record.started_at_epoch_sec,
            ProcessStopRequest::Force,
        )?;
    }
    let forced = Instant::now();
    while forced.elapsed() < Duration::from_secs(3) {
        if !process_matches(record) {
            remove_file_if_exists(ownership_path)?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    bail!("broker process {} did not stop", record.pid)
}

fn process_exists(pid: u32) -> bool {
    let mut system = System::new();
    let pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).is_some()
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    const BROKER_LIFECYCLE_CHILD: &str = "__broker_lifecycle_child";

    fn test_supervisor(
        paths: &AppPaths,
        bridge_port: u16,
        owner_pid: Option<u32>,
    ) -> BrokerSupervisor {
        let preview_port = if bridge_port == u16::MAX {
            bridge_port - 1
        } else {
            bridge_port + 1
        };
        let settings = BrokerSettings::new(
            "local".to_string(),
            "127.0.0.1".to_string(),
            bridge_port,
            preview_port,
            format!("http://127.0.0.1:{bridge_port}"),
            format!("http://127.0.0.1:{preview_port}"),
        )
        .unwrap();
        let profile = Profile {
            profile_id: "workspace-a".to_string(),
            workspace: paths.base_dir().to_path_buf(),
            network_mode: "local".to_string(),
            bridge_host: "127.0.0.1".to_string(),
            bridge_port,
            preview_port,
            connect_url: settings.connect_url.clone(),
            preview_connect_url: settings.preview_connect_url.clone(),
            auto_start: false,
            allow_query_token_auth: true,
            acp_initialize_timeout_ms: 15_000,
            agent: crate::store::ProfileAgent {
                agent_id: "agent".to_string(),
                display_name: "Agent".to_string(),
                executable: std::env::current_exe().unwrap(),
                argv: Vec::new(),
                resolved_version: "test".to_string(),
                verified_digest: format!("sha256:{}", "a".repeat(64)),
            },
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };
        BrokerSupervisor::new(
            profile,
            settings,
            paths.clone(),
            SecretStore::file_backend_for_tests(),
            owner_pid,
        )
    }

    fn closed_port() -> u16 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        port
    }

    fn health_server(body: &'static str, requests: usize) -> (u16, thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            for _ in 0..requests {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request);
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        (port, server)
    }

    fn delayed_health_server(
        port: u16,
        body: &'static str,
        requests: usize,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(250));
            let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
            for _ in 0..requests {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request);
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        })
    }

    fn spawn_owned_fixture(
        cwd: &Path,
        config_sha256: &str,
    ) -> (std::process::Child, BrokerOwnershipRecord) {
        let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
        let mut command = Command::new(&executable);
        command
            .arg(BROKER_LIFECYCLE_CHILD)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::platform::detach_process(&mut command);
        let child = command.spawn().unwrap();
        let record = process_identity(child.id(), &executable, cwd, config_sha256, None).unwrap();
        (child, record)
    }

    #[test]
    fn __broker_child_stays_alive_for_process_lifecycle_fixtures() {
        if std::env::args().any(|argument| argument == "__broker") {
            thread::sleep(Duration::from_millis(800));
        }
    }

    #[test]
    fn __broker_lifecycle_child() {
        if std::env::args().any(|argument| argument == BROKER_LIFECYCLE_CHILD) {
            thread::sleep(Duration::from_secs(30));
        }
    }

    #[test]
    fn startup_wait_accepts_late_and_boundary_health_without_false_timeout() {
        let ready_at = |ready_at: Duration| {
            let elapsed = std::cell::Cell::new(Duration::ZERO);
            let mut read_elapsed = || elapsed.get();
            let mut fetch_health = || elapsed.get() >= ready_at;
            let mut process_alive = || true;
            let mut sleep = |duration| elapsed.set(elapsed.get() + duration);
            wait_for_broker_start(
                START_TIMEOUT,
                Duration::from_secs(1),
                &mut read_elapsed,
                &mut fetch_health,
                &mut process_alive,
                &mut sleep,
            )
        };

        assert!(START_TIMEOUT > Duration::from_secs(15));
        assert_eq!(
            ready_at(Duration::from_secs(16)),
            BrokerStartupWait::Healthy
        );
        assert_eq!(ready_at(START_TIMEOUT), BrokerStartupWait::Healthy);

        let overshot = std::cell::Cell::new(Duration::ZERO);
        let mut read_overshot = || overshot.get();
        let mut fetch_overshot_health =
            || overshot.get() >= START_TIMEOUT - Duration::from_millis(100);
        let mut overshot_process_alive = || true;
        let mut overshooting_sleep =
            |_| overshot.set(overshot.get() + Duration::from_millis(1_200));
        assert_eq!(
            wait_for_broker_start(
                START_TIMEOUT,
                START_POLL_INTERVAL,
                &mut read_overshot,
                &mut fetch_overshot_health,
                &mut overshot_process_alive,
                &mut overshooting_sleep,
            ),
            BrokerStartupWait::Healthy
        );
        assert!(overshot.get() >= START_TIMEOUT);

        let elapsed = std::cell::Cell::new(Duration::ZERO);
        let mut read_elapsed = || elapsed.get();
        let mut never_healthy = || false;
        let mut process_alive = || true;
        let mut sleep = |duration| elapsed.set(elapsed.get() + duration);
        assert_eq!(
            wait_for_broker_start(
                Duration::from_secs(2),
                Duration::from_secs(1),
                &mut read_elapsed,
                &mut never_healthy,
                &mut process_alive,
                &mut sleep,
            ),
            BrokerStartupWait::TimedOut
        );
        let mut zero_elapsed = || Duration::ZERO;
        let mut never_healthy = || false;
        let mut process_exited = || false;
        let mut no_sleep = |_| {};
        assert_eq!(
            wait_for_broker_start(
                Duration::from_secs(2),
                Duration::from_secs(1),
                &mut zero_elapsed,
                &mut never_healthy,
                &mut process_exited,
                &mut no_sleep,
            ),
            BrokerStartupWait::Exited
        );

        let health_probes = std::cell::Cell::new(0_u8);
        let mut zero_elapsed = || Duration::ZERO;
        let mut eventually_healthy = || {
            health_probes.set(health_probes.get() + 1);
            health_probes.get() == 2
        };
        let mut transient_identity_miss = || false;
        let mut no_sleep = |_| {};
        assert_eq!(
            wait_for_broker_start(
                Duration::from_secs(2),
                Duration::from_secs(1),
                &mut zero_elapsed,
                &mut eventually_healthy,
                &mut transient_identity_miss,
                &mut no_sleep,
            ),
            BrokerStartupWait::Healthy
        );

        let mut at_timeout = || Duration::from_secs(2);
        let mut never_healthy = || false;
        let mut exited_at_boundary = || false;
        let mut no_sleep = |_| {};
        assert_eq!(
            wait_for_broker_start(
                Duration::from_secs(2),
                Duration::from_secs(1),
                &mut at_timeout,
                &mut never_healthy,
                &mut exited_at_boundary,
                &mut no_sleep,
            ),
            BrokerStartupWait::Exited
        );

        let final_health_probes = std::cell::Cell::new(0_u8);
        let mut at_timeout = || Duration::from_secs(2);
        let mut healthy_after_boundary_identity_miss = || {
            final_health_probes.set(final_health_probes.get() + 1);
            final_health_probes.get() == 2
        };
        let mut exited_at_boundary = || false;
        let mut no_sleep = |_| {};
        assert_eq!(
            wait_for_broker_start(
                Duration::from_secs(2),
                Duration::from_secs(1),
                &mut at_timeout,
                &mut healthy_after_boundary_identity_miss,
                &mut exited_at_boundary,
                &mut no_sleep,
            ),
            BrokerStartupWait::Healthy
        );
    }

    #[test]
    fn settings_digest_is_stable_and_contains_no_workspace_credential() {
        let settings = BrokerSettings::new(
            "local".to_string(),
            "127.0.0.1".to_string(),
            8787,
            8788,
            "http://127.0.0.1:8787".to_string(),
            "http://127.0.0.1:8788".to_string(),
        )
        .unwrap();
        let digest = settings_digest(&settings);
        assert!(digest.starts_with("sha256:"));
        assert_eq!(digest.len(), 71);
    }

    #[test]
    fn broker_ownership_round_trips_privately() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime/broker/process.json");
        let record = BrokerOwnershipRecord {
            version: OWNERSHIP_VERSION,
            pid: 123,
            started_at_epoch_sec: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            executable: PathBuf::from("/tmp/dappercode"),
            data_dir: temp.path().to_path_buf(),
            config_sha256: format!("sha256:{}", "a".repeat(64)),
            owner_pid: Some(7),
        };
        write_ownership(&path, &record).unwrap();
        assert_eq!(read_ownership(&path).unwrap(), Some(record));
    }

    #[test]
    fn broker_ownership_validation_and_pluralization_cover_invalid_records() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("process.json");
        assert_eq!(read_ownership(&path).unwrap(), None);
        fs::write(&path, b"{").unwrap();
        assert!(read_ownership(&path).is_err());

        let valid = BrokerOwnershipRecord {
            version: OWNERSHIP_VERSION,
            pid: 123,
            started_at_epoch_sec: 1,
            executable: PathBuf::from("/tmp/dappercode"),
            data_dir: temp.path().to_path_buf(),
            config_sha256: format!("sha256:{}", "a".repeat(64)),
            owner_pid: None,
        };
        for invalid in [
            BrokerOwnershipRecord {
                version: OWNERSHIP_VERSION + 1,
                ..valid.clone()
            },
            BrokerOwnershipRecord {
                pid: 0,
                ..valid.clone()
            },
            BrokerOwnershipRecord {
                config_sha256: "short".to_string(),
                ..valid.clone()
            },
            BrokerOwnershipRecord {
                config_sha256: format!("md5:{}", "a".repeat(67)),
                ..valid
            },
        ] {
            fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(read_ownership(&path).is_err());
        }
        assert_eq!(plural(1), "");
        assert_eq!(plural(0), "s");
    }

    #[test]
    fn snapshots_distinguish_healthy_owned_unreachable_and_stopped_brokers() {
        let data = tempfile::tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let health = r#"{"status":"ok","uptimeSec":7,"configuredWorkspaces":2,"runningWorkers":3,"connectedClients":1,"busyWorkers":1}"#;
        let (port, server) = health_server(health, 1);
        let running = test_supervisor(&paths, port, None).snapshot();
        server.join().unwrap();
        assert_eq!(running.state, BridgeState::Running);
        assert_eq!(running.ready_agents, 2);
        assert!(!running.managed_process);

        let supervisor = test_supervisor(&paths, closed_port(), None);
        let (mut child, ownership) =
            spawn_owned_fixture(paths.base_dir(), &settings_digest(&supervisor.settings));
        write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();
        let inaccessible = supervisor.snapshot();
        assert_eq!(inaccessible.state, BridgeState::Inaccessible);
        assert!(inaccessible.managed_process);
        let _ = child.kill();
        let _ = child.wait();
        remove_file_if_exists(&paths.broker_ownership_path()).unwrap();

        assert_eq!(supervisor.snapshot().state, BridgeState::Stopped);
    }

    #[test]
    fn health_validation_and_start_detect_owned_and_unowned_listeners() {
        let data = tempfile::tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let (bad_port, bad_server) = health_server(
            r#"{"status":"degraded","uptimeSec":1,"configuredWorkspaces":0,"runningWorkers":0,"connectedClients":0,"busyWorkers":0}"#,
            1,
        );
        let bad = test_supervisor(&paths, bad_port, None);
        assert!(bad
            .fetch_health()
            .unwrap_err()
            .to_string()
            .contains("degraded"));
        bad_server.join().unwrap();

        let health = r#"{"status":"ok","uptimeSec":1,"configuredWorkspaces":1,"runningWorkers":0,"connectedClients":0,"busyWorkers":0}"#;
        let (unowned_port, unowned_server) = health_server(health, 1);
        let unowned = test_supervisor(&paths, unowned_port, None);
        assert!(unowned
            .start_locked()
            .unwrap_err()
            .to_string()
            .contains("not owned"));
        unowned_server.join().unwrap();

        let (owned_port, owned_server) = health_server(health, 2);
        let owned = test_supervisor(&paths, owned_port, None);
        let current = process_identity(
            std::process::id(),
            &std::env::current_exe().unwrap(),
            &std::env::current_dir().unwrap(),
            &settings_digest(&owned.settings),
            None,
        )
        .unwrap();
        write_ownership(&paths.broker_ownership_path(), &current).unwrap();
        assert_eq!(owned.start_locked().unwrap().state, BridgeState::Running);
        owned_server.join().unwrap();
        remove_file_if_exists(&paths.broker_ownership_path()).unwrap();
    }

    #[test]
    fn start_detects_owned_unhealthy_and_child_exit_paths() {
        let data = tempfile::tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let owned = test_supervisor(&paths, closed_port(), None);
        let (mut child, ownership) =
            spawn_owned_fixture(paths.base_dir(), &settings_digest(&owned.settings));
        write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();
        assert!(owned
            .start_locked()
            .unwrap_err()
            .to_string()
            .contains("health endpoint"));
        let _ = child.kill();
        let _ = child.wait();
        remove_file_if_exists(&paths.broker_ownership_path()).unwrap();

        let launched = test_supervisor(&paths, closed_port(), None);
        assert!(launched
            .start_locked()
            .unwrap_err()
            .to_string()
            .contains("exited before becoming healthy"));
        assert!(!paths.broker_ownership_path().exists());
    }

    #[test]
    fn start_covers_owner_arguments_ownership_write_failure_and_delayed_health() {
        let owner_data = tempfile::tempdir().unwrap();
        let owner_paths = AppPaths::for_tests(owner_data.path().to_path_buf());
        let with_owner = test_supervisor(&owner_paths, closed_port(), Some(std::process::id()));
        assert!(with_owner.start_locked().is_err());

        let write_data = tempfile::tempdir().unwrap();
        let write_paths = AppPaths::for_tests(write_data.path().to_path_buf());
        fs::create_dir_all(write_paths.broker_ownership_path()).unwrap();
        let write_failure = test_supervisor(&write_paths, closed_port(), None);
        assert!(write_failure.start_locked().is_err());
        fs::remove_dir_all(write_paths.broker_ownership_path()).unwrap();

        let healthy_data = tempfile::tempdir().unwrap();
        let healthy_paths = AppPaths::for_tests(healthy_data.path().to_path_buf());
        let port = closed_port();
        let health = r#"{"status":"ok","uptimeSec":1,"configuredWorkspaces":1,"runningWorkers":0,"connectedClients":0,"busyWorkers":0}"#;
        let server = delayed_health_server(port, health, 2);
        let healthy = test_supervisor(&healthy_paths, port, None);
        assert_eq!(healthy.start_locked().unwrap().state, BridgeState::Running);
        server.join().unwrap();
        assert_eq!(healthy.stop().unwrap().state, BridgeState::Stopped);
    }

    #[test]
    fn restart_handles_missing_stale_and_live_ownership_records() {
        let missing_data = tempfile::tempdir().unwrap();
        let missing_paths = AppPaths::for_tests(missing_data.path().to_path_buf());
        let missing = test_supervisor(&missing_paths, closed_port(), None);
        assert!(missing.restart_locked().is_err());

        let stale_data = tempfile::tempdir().unwrap();
        let stale_paths = AppPaths::for_tests(stale_data.path().to_path_buf());
        let stale = test_supervisor(&stale_paths, closed_port(), None);
        write_ownership(
            &stale_paths.broker_ownership_path(),
            &BrokerOwnershipRecord {
                version: OWNERSHIP_VERSION,
                pid: u32::MAX,
                started_at_epoch_sec: 1,
                executable: PathBuf::from("/missing"),
                data_dir: stale_paths.base_dir().to_path_buf(),
                config_sha256: settings_digest(&stale.settings),
                owner_pid: None,
            },
        )
        .unwrap();
        assert!(stale.restart_locked().is_err());

        let live_data = tempfile::tempdir().unwrap();
        let live_paths = AppPaths::for_tests(live_data.path().to_path_buf());
        let live = test_supervisor(&live_paths, closed_port(), None);
        let (child, ownership) =
            spawn_owned_fixture(live_paths.base_dir(), &settings_digest(&live.settings));
        write_ownership(&live_paths.broker_ownership_path(), &ownership).unwrap();
        let reaper = thread::spawn(move || {
            let mut child = child;
            let _ = child.wait();
        });
        assert!(live.restart_locked().is_err());
        reaper.join().unwrap();
    }

    #[test]
    fn stop_handles_unowned_stale_and_live_owned_processes() {
        let data = tempfile::tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let health = r#"{"status":"ok","uptimeSec":1,"configuredWorkspaces":1,"runningWorkers":0,"connectedClients":0,"busyWorkers":0}"#;
        let (port, server) = health_server(health, 1);
        let unowned = test_supervisor(&paths, port, None);
        assert!(unowned
            .stop()
            .unwrap_err()
            .to_string()
            .contains("not owned"));
        server.join().unwrap();

        let stopped = test_supervisor(&paths, closed_port(), None);
        let stale = BrokerOwnershipRecord {
            version: OWNERSHIP_VERSION,
            pid: u32::MAX,
            started_at_epoch_sec: 1,
            executable: PathBuf::from("/missing"),
            data_dir: paths.base_dir().to_path_buf(),
            config_sha256: settings_digest(&stopped.settings),
            owner_pid: None,
        };
        write_ownership(&paths.broker_ownership_path(), &stale).unwrap();
        assert_eq!(stopped.stop().unwrap().state, BridgeState::Stopped);
        assert!(!paths.broker_ownership_path().exists());

        let (child, ownership) =
            spawn_owned_fixture(paths.base_dir(), &settings_digest(&stopped.settings));
        write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();
        let reaper = thread::spawn(move || {
            let mut child = child;
            let _ = child.wait();
        });
        assert_eq!(stopped.stop().unwrap().state, BridgeState::Stopped);
        reaper.join().unwrap();
        assert!(!paths.broker_ownership_path().exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_broker_stop_uses_the_reliable_process_fallback() {
        let data = tempfile::tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let supervisor = test_supervisor(&paths, closed_port(), None);
        let (mut child, ownership) =
            spawn_owned_fixture(paths.base_dir(), &settings_digest(&supervisor.settings));
        write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();

        stop_owned_process(&ownership, &paths.broker_ownership_path()).unwrap();
        child.wait().unwrap();

        assert!(!process_matches(&ownership));
        assert!(!paths.broker_ownership_path().exists());
    }

    #[test]
    fn process_identity_matching_and_stale_cleanup_fail_closed() {
        let current_executable = std::env::current_exe().unwrap().canonicalize().unwrap();
        let current_directory = std::env::current_dir().unwrap().canonicalize().unwrap();
        let current = process_identity(
            std::process::id(),
            &current_executable,
            &current_directory,
            &format!("sha256:{}", "b".repeat(64)),
            Some(42),
        )
        .unwrap();
        assert!(process_matches(&current));
        let different_executable_dir = tempfile::tempdir().unwrap();
        let different_executable = different_executable_dir.path().join("different-executable");
        fs::write(&different_executable, b"not the test executable").unwrap();
        let different_executable = different_executable.canonicalize().unwrap();
        assert!(process_identity(
            std::process::id(),
            &different_executable,
            &current_directory,
            &current.config_sha256,
            None,
        )
        .is_err());
        let other_directory = tempfile::tempdir().unwrap();
        assert!(process_identity(
            std::process::id(),
            &current_executable,
            other_directory.path(),
            &current.config_sha256,
            None,
        )
        .is_err());
        let mut wrong_start = current.clone();
        wrong_start.started_at_epoch_sec = wrong_start.started_at_epoch_sec.saturating_add(1);
        assert!(!process_matches(&wrong_start));
        let mut wrong_executable = current.clone();
        wrong_executable.executable = different_executable;
        assert!(!process_matches(&wrong_executable));
        let stale_record = BrokerOwnershipRecord {
            version: OWNERSHIP_VERSION,
            pid: u32::MAX,
            started_at_epoch_sec: 1,
            executable: PathBuf::from("/missing"),
            data_dir: current_directory.clone(),
            config_sha256: current.config_sha256.clone(),
            owner_pid: None,
        };
        let stale_owner_dir = tempfile::tempdir().unwrap();
        let stale_owner = stale_owner_dir.path().join("process.json");
        write_ownership(&stale_owner, &stale_record).unwrap();
        stop_owned_process(&stale_record, &stale_owner).unwrap();
        assert!(!stale_owner.exists());

        let data = tempfile::tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let supervisor = test_supervisor(&paths, closed_port(), None);
        assert!(supervisor.clean_stale_ownership().is_ok());
        write_ownership(&paths.broker_ownership_path(), &stale_record).unwrap();
        assert!(!clean_stale_broker_ownership(&paths).unwrap());
        assert!(!paths.broker_ownership_path().exists());
        let (mut child, mut ownership) =
            spawn_owned_fixture(paths.base_dir(), &settings_digest(&supervisor.settings));
        write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();
        assert!(clean_stale_broker_ownership(&paths).unwrap());
        assert!(supervisor.clean_stale_ownership().is_ok());
        ownership.config_sha256 = format!("sha256:{}", "c".repeat(64));
        write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();
        assert!(supervisor.clean_stale_ownership().is_err());
        let _ = child.kill();
        let _ = child.wait();
        remove_file_if_exists(&paths.broker_ownership_path()).unwrap();

        let executable_drift_data = tempfile::tempdir().unwrap();
        let executable_drift_paths =
            AppPaths::for_tests(executable_drift_data.path().to_path_buf());
        let executable_drift = test_supervisor(&executable_drift_paths, closed_port(), None);
        let fixture_name = format!("broker-fixture{}", std::env::consts::EXE_SUFFIX);
        let fixture_executable = executable_drift_paths.base_dir().join(fixture_name);
        fs::copy(&current_executable, &fixture_executable).unwrap();
        let fixture_executable = fixture_executable.canonicalize().unwrap();
        let mut drift_child = Command::new(&fixture_executable)
            .arg(BROKER_LIFECYCLE_CHILD)
            .current_dir(executable_drift_paths.base_dir())
            .spawn()
            .unwrap();
        let drift_record = process_identity(
            drift_child.id(),
            &fixture_executable,
            executable_drift_paths.base_dir(),
            &settings_digest(&executable_drift.settings),
            None,
        )
        .unwrap();
        write_ownership(
            &executable_drift_paths.broker_ownership_path(),
            &drift_record,
        )
        .unwrap();
        assert!(executable_drift.clean_stale_ownership().is_err());
        let _ = drift_child.kill();
        let _ = drift_child.wait();

        let source_data = tempfile::tempdir().unwrap();
        let different_data = tempfile::tempdir().unwrap();
        let different_paths = AppPaths::for_tests(different_data.path().to_path_buf());
        let different = test_supervisor(&different_paths, closed_port(), None);
        let (mut different_child, different_record) =
            spawn_owned_fixture(source_data.path(), &settings_digest(&different.settings));
        write_ownership(&different_paths.broker_ownership_path(), &different_record).unwrap();
        assert!(different.clean_stale_ownership().is_err());
        let _ = different_child.kill();
        let _ = different_child.wait();
        remove_file_if_exists(&different_paths.broker_ownership_path()).unwrap();

        fs::create_dir_all(different_paths.broker_ownership_path()).unwrap();
        assert!(read_ownership(&different_paths.broker_ownership_path()).is_err());
        fs::remove_dir_all(different_paths.broker_ownership_path()).unwrap();
    }

    #[test]
    fn stop_transition_persists_broker_and_profile_autostart_under_production_path() {
        let workspace = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let paths = AppPaths::for_tests(data.path().to_path_buf());
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let bridge_port = listener.local_addr().unwrap().port();
        drop(listener);
        let preview_port = if bridge_port == u16::MAX {
            bridge_port - 1
        } else {
            bridge_port + 1
        };
        let settings = BrokerSettings::new(
            "local".to_string(),
            "127.0.0.1".to_string(),
            bridge_port,
            preview_port,
            format!("http://127.0.0.1:{bridge_port}"),
            format!("http://127.0.0.1:{preview_port}"),
        )
        .unwrap();
        let profile = Profile {
            profile_id: "workspace-a".to_string(),
            workspace: workspace.path().to_path_buf(),
            network_mode: "local".to_string(),
            bridge_host: "127.0.0.1".to_string(),
            bridge_port,
            preview_port,
            connect_url: settings.connect_url.clone(),
            preview_connect_url: settings.preview_connect_url.clone(),
            auto_start: true,
            allow_query_token_auth: true,
            acp_initialize_timeout_ms: 15_000,
            agent: crate::store::ProfileAgent {
                agent_id: "agent".to_string(),
                display_name: "Agent".to_string(),
                executable: std::env::current_exe().unwrap(),
                argv: Vec::new(),
                resolved_version: "test".to_string(),
                verified_digest: format!("sha256:{}", "a".repeat(64)),
            },
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let mut saved_settings = settings.clone();
        saved_settings.auto_start = true;
        paths
            .update_config(|config| {
                config.broker = Some(saved_settings);
                config.upsert(profile.clone());
                Ok(())
            })
            .unwrap();
        let supervisor = BrokerSupervisor::new(
            profile,
            settings,
            paths.clone(),
            SecretStore::file_backend_for_tests(),
            None,
        );

        let (_, auto_start) = supervisor
            .transition_and_remember(BrokerLifecycleAction::Stop)
            .unwrap();

        assert!(!auto_start);
        let config = paths.load_config().unwrap();
        assert!(!config.broker.unwrap().auto_start);
        assert!(config.profiles.iter().all(|profile| !profile.auto_start));
    }

    #[test]
    fn failed_autostart_persistence_restores_the_prior_process_state() {
        let running = std::cell::Cell::new(false);
        let error = BrokerSupervisor::persist_transition_or_restore(
            (),
            true,
            || Err(anyhow!("config write failed")),
            |should_be_running| {
                running.set(should_be_running);
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "config write failed");
        assert!(running.get());

        let rollback_error = BrokerSupervisor::persist_transition_or_restore(
            (),
            false,
            || Err(anyhow!("config write failed")),
            |_| Err(anyhow!("process rollback failed")),
        )
        .unwrap_err();
        assert!(rollback_error
            .to_string()
            .contains("restoring the prior broker process state also failed"));
    }
}
