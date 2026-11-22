#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "broker process lifecycle, ownership verification, and health checks live together"
    )
)]

use crate::config::{runtime_executable_available, BridgeRuntimeConfig};
use crate::platform::{
    detach_process, process_start_identity, request_process_stop, ProcessStopRequest,
};
use crate::secrets::{SecretBackend, SecretStore};
use crate::store::{
    atomic_private_write, remove_file_if_exists, AppPaths, BrokerSettings, FileLease, Profile,
};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::{io, thread};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

const START_TIMEOUT: Duration = Duration::from_secs(30);
const START_POLL_INTERVAL: Duration = Duration::from_millis(200);
const STOP_TIMEOUT: Duration = Duration::from_secs(12);
const OWNERSHIP_VERSION: u32 = 1;

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
                workspace.display(),
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
    process_matches: &mut dyn FnMut() -> Result<bool>,
    sleep: &mut dyn FnMut(Duration),
) -> Result<BrokerStartupWait> {
    while elapsed() < timeout {
        if fetch_health() {
            return Ok(BrokerStartupWait::Healthy);
        }
        if !process_matches()? {
            return Ok(if fetch_health() {
                BrokerStartupWait::Healthy
            } else {
                BrokerStartupWait::Exited
            });
        }
        sleep(poll_interval);
    }
    Ok(if fetch_health() {
        BrokerStartupWait::Healthy
    } else if !process_matches()? {
        if fetch_health() {
            BrokerStartupWait::Healthy
        } else {
            BrokerStartupWait::Exited
        }
    } else {
        BrokerStartupWait::TimedOut
    })
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

    pub fn pairing(&self) -> Result<(String, SecretBackend)> {
        let secret = self
            .secrets
            .get(&self.paths, &self.profile.profile_id)?
            .context("no stored workspace credential; start the broker or run setup again")?;
        let payload = BridgeRuntimeConfig::pairing_payload_for(
            &self.settings.connect_url,
            &self.profile.profile_id,
            &secret.token,
        )?;
        Ok((payload, secret.backend))
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "maps every broker health and ownership state into a single BridgeSnapshot"
        )
    )]
    pub fn snapshot(&self) -> BridgeSnapshot {
        let replacement_required = match self.owned_runtime_unavailable() {
            Ok(value) => value,
            Err(error) => return BridgeSnapshot::error(format!("{error:#}")),
        };
        let managed_process = match self.owns_running_process() {
            Ok(value) => value,
            Err(error) => return BridgeSnapshot::error(format!("{error:#}")),
        };
        match self.fetch_health() {
            Ok(_) if replacement_required => self.runtime_replacement_snapshot(),
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
                managed_process,
            },
            Err(_) if replacement_required => self.runtime_replacement_snapshot(),
            Err(error) if managed_process => BridgeSnapshot {
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

    fn runtime_replacement_snapshot(&self) -> BridgeSnapshot {
        BridgeSnapshot {
            state: BridgeState::Stopped,
            headline: "Broker update required".to_string(),
            detail: "The running broker's runtime bundle is unavailable. DapperCode will replace it before accepting devices.".to_string(),
            url: Some(self.settings.connect_url.clone()),
            uptime_sec: None,
            connected_clients: 0,
            ready_agents: 0,
            total_agents: 0,
            recent_error_count: 1,
            managed_process: true,
        }
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "orchestrates spawn, ownership persistence, rollback, and readiness polling sequentially"
        )
    )]
    fn start_locked(&self) -> Result<BridgeSnapshot> {
        if self.reconcile_existing_process()? {
            return Ok(self.snapshot());
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
            settings_digest(&self.settings),
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
        )? {
            BrokerStartupWait::Healthy => return Ok(self.snapshot()),
            BrokerStartupWait::Exited => {
                let _ = remove_file_if_exists(&self.paths.broker_ownership_path());
                bail!(
                    "broker exited before becoming healthy; inspect {}",
                    log_path.display(),
                );
            }
            BrokerStartupWait::TimedOut => {}
        }
        if let Err(error) = stop_owned_process(&ownership, &self.paths.broker_ownership_path()) {
            bail!(
                "broker did not become healthy within {} seconds and could not be stopped cleanly: {error:#}; inspect {}",
                START_TIMEOUT.as_secs(),
                log_path.display(),
            );
        }
        bail!(
            "broker did not become healthy within {} seconds; inspect {}",
            START_TIMEOUT.as_secs(),
            log_path.display(),
        )
    }

    /// Keep a healthy broker while its recorded runtime still exists. A broker whose executable
    /// disappeared cannot launch its lazily-created workers, so stop only that exactly identified
    /// owned process and let the current operator replace it.
    fn reconcile_existing_process(&self) -> Result<bool> {
        let health_available = self.fetch_health().is_ok();
        let Some(ownership) = read_ownership(&self.paths.broker_ownership_path())? else {
            if health_available {
                bail!("a broker is already listening but is not owned by this desktop app");
            }
            return Ok(false);
        };
        if !process_matches_for_recovery(&ownership)? {
            if health_available && self.fetch_health().is_ok() {
                bail!("a broker is already listening but its ownership record is stale");
            }
            remove_file_if_exists(&self.paths.broker_ownership_path())?;
            return Ok(false);
        }
        self.validate_ownership_data_dir(&ownership)?;
        if runtime_executable_unavailable_for_recovery(&ownership.executable) {
            stop_owned_process_for_recovery(&ownership, &self.paths.broker_ownership_path())?;
            return Ok(false);
        }
        if health_available {
            return Ok(true);
        }
        bail!("the owned broker process is running but its health endpoint is unavailable");
    }

    fn validate_ownership_data_dir(&self, record: &BrokerOwnershipRecord) -> Result<()> {
        if record.data_dir != self.paths.base_dir().canonicalize()? {
            bail!("broker data directory changed while its managed process was running");
        }
        Ok(())
    }

    fn owned_runtime_unavailable(&self) -> Result<bool> {
        let Some(record) = read_ownership(&self.paths.broker_ownership_path())? else {
            return Ok(false);
        };
        if !process_matches_for_recovery(&record)? {
            return Ok(false);
        }
        self.validate_ownership_data_dir(&record)?;
        Ok(runtime_executable_unavailable_for_recovery(
            &record.executable,
        ))
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
        if !process_matches(&ownership)? {
            remove_file_if_exists(&self.paths.broker_ownership_path())?;
            return Ok(self.snapshot());
        }
        stop_owned_process(&ownership, &self.paths.broker_ownership_path())?;
        Ok(self.snapshot())
    }

    fn restart_locked(&self) -> Result<BridgeSnapshot> {
        if let Some(ownership) = read_ownership(&self.paths.broker_ownership_path())? {
            if process_matches(&ownership)? {
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
        let was_running = self.owns_running_process()?;
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
        match (should_be_running, self.owns_running_process()?) {
            (true, false) => self.start_locked().map(|_| ()),
            (false, true) => self.stop_locked().map(|_| ()),
            _ => Ok(()),
        }
    }

    pub fn owns_running_process(&self) -> Result<bool> {
        match read_ownership(&self.paths.broker_ownership_path())? {
            Some(record) => process_matches(&record),
            None => Ok(false),
        }
    }

    fn persist_transition_or_restore<Outcome>(
        outcome: Outcome,
        was_running: bool,
        persist: impl FnOnce() -> Result<()>,
        restore: impl FnOnce(bool) -> Result<()>,
    ) -> Result<Outcome> {
        match persist() {
            Ok(()) => Ok(outcome),
            Err(error) => match restore(was_running) {
                Ok(()) => Err(error),
                Err(rollback) => Err(anyhow!(
                    "{error:#}; restoring the prior broker process state also failed: {rollback:#}",
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
            self.settings.bridge_port,
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
        if !process_matches(&record)? {
            remove_file_if_exists(&self.paths.broker_ownership_path())?;
            return Ok(());
        }
        let executable = std::env::current_exe()?.canonicalize()?;
        if record.executable != executable
            || record.data_dir != self.paths.base_dir().canonicalize()?
            || !settings_digest_matches(&record.config_sha256, &self.settings)
        {
            bail!("broker configuration changed while its managed process was running");
        }
        Ok(())
    }
}

pub(crate) fn clean_stale_broker_ownership(paths: &AppPaths) -> Result<bool> {
    let Some(record) = read_ownership(&paths.broker_ownership_path())? else {
        return Ok(false);
    };
    if process_matches(&record)? {
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
    let mut runtime_settings = settings.clone();
    runtime_settings.auto_start = false;
    digest_settings(&runtime_settings)
}

fn legacy_settings_digest(settings: &BrokerSettings) -> String {
    digest_settings(settings)
}

fn digest_settings(settings: &BrokerSettings) -> String {
    let encoded = serde_json::to_vec(settings).expect("broker settings serialize");
    format!("sha256:{}", hex::encode(Sha256::digest(encoded)))
}

fn settings_digest_matches(recorded: &str, settings: &BrokerSettings) -> bool {
    recorded == settings_digest(settings) || recorded == legacy_settings_digest(settings)
}

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_PROCESS_INSPECTION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn new_process_system() -> Result<System> {
    #[cfg(test)]
    if FAIL_NEXT_PROCESS_INSPECTION.replace(false) {
        bail!("failed to initialize process inspection: injected failure");
    }
    System::new().context("failed to initialize process inspection")
}

fn process_identity(
    pid: u32,
    executable: &Path,
    data_dir: &Path,
    config_sha256: impl Into<String>,
    owner_pid: Option<u32>,
) -> Result<BrokerOwnershipRecord> {
    let mut system = new_process_system()?;
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
        config_sha256: config_sha256.into(),
        owner_pid,
    })
}

fn process_matches(record: &BrokerOwnershipRecord) -> Result<bool> {
    process_matches_with(record, false)
}

fn process_matches_with(
    record: &BrokerOwnershipRecord,
    allow_unlinked_executable: bool,
) -> Result<bool> {
    let mut system = new_process_system()?;
    let pid = Pid::from_u32(record.pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::everything(),
    );
    let Some(process) = system.process(pid) else {
        return Ok(false);
    };
    if process.status() == sysinfo::ProcessStatus::Zombie {
        return Ok(false);
    }
    let matches = (|| {
        if process_start_identity(record.pid, process.start_time())? != record.started_at_epoch_sec
        {
            return Ok(false);
        }
        let executable_matches = if allow_unlinked_executable && !record.executable.exists() {
            true
        } else {
            process_path_matches(
                process
                    .exe()
                    .context("broker executable identity is unavailable")?,
                &record.executable,
            )?
        };
        let actual_data_dir = process
            .cwd()
            .context("broker working directory identity is unavailable")?
            .canonicalize()
            .context("failed to resolve broker working directory identity")?;
        Ok(executable_matches && actual_data_dir == record.data_dir)
    })();
    if matches.is_err() {
        // A process can exit between the status sample and executable/cwd inspection.
        system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        if system
            .process(pid)
            .is_none_or(|process| process.status() == sysinfo::ProcessStatus::Zombie)
        {
            return Ok(false);
        }
    }
    matches
}

fn process_matches_for_recovery(record: &BrokerOwnershipRecord) -> Result<bool> {
    // macOS can resolve an unlinked executable to its new vnode path. Recovery still requires the
    // private record's exact PID start identity and canonical central-data cwd.
    process_matches_with_retry(record, true)
}

fn process_matches_with_retry(
    record: &BrokerOwnershipRecord,
    allow_unlinked_executable: bool,
) -> Result<bool> {
    for attempt in 0..3 {
        if process_matches_with(record, allow_unlinked_executable)? {
            return Ok(true);
        }
        if attempt < 2 {
            thread::sleep(Duration::from_millis(10));
        }
    }
    Ok(false)
}

fn runtime_executable_unavailable_for_recovery(path: &Path) -> bool {
    for attempt in 0..3 {
        if runtime_executable_available(path) {
            return false;
        }
        if attempt < 2 {
            thread::sleep(Duration::from_millis(10));
        }
    }
    true
}

fn process_path_matches(observed: &Path, recorded: &Path) -> Result<bool> {
    if observed == recorded {
        return Ok(true);
    }
    #[cfg(target_os = "macos")]
    {
        let observed = observed.to_string_lossy();
        let recorded = recorded.to_string_lossy();
        if observed
            .strip_prefix("/var/")
            .is_some_and(|suffix| recorded == format!("/private/var/{suffix}"))
            || observed
                .strip_prefix("/tmp/")
                .is_some_and(|suffix| recorded == format!("/private/tmp/{suffix}"))
        {
            return Ok(true);
        }
    }
    Ok(observed
        .canonicalize()
        .context("failed to resolve broker executable identity")?
        == recorded)
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
    stop_owned_process_with(record, ownership_path, false)
}

fn stop_owned_process_for_recovery(
    record: &BrokerOwnershipRecord,
    ownership_path: &Path,
) -> Result<()> {
    stop_owned_process_with(record, ownership_path, true)
}

fn stop_owned_process_with(
    record: &BrokerOwnershipRecord,
    ownership_path: &Path,
    allow_unlinked_executable: bool,
) -> Result<()> {
    let process_matches = |record: &BrokerOwnershipRecord| {
        process_matches_with_retry(record, allow_unlinked_executable)
    };
    if !process_matches(record)? {
        if !process_exists(record.pid)? {
            remove_file_if_exists(ownership_path)?;
            return Ok(());
        }
        bail!(
            "refusing to stop PID {} because its process identity changed",
            record.pid,
        );
    }
    if request_process_stop(
        record.pid,
        record.started_at_epoch_sec,
        ProcessStopRequest::Graceful,
    )? {
        let started = Instant::now();
        while started.elapsed() < STOP_TIMEOUT {
            if !process_matches(record)? {
                remove_file_if_exists(ownership_path)?;
                return Ok(());
            }
            thread::sleep(Duration::from_millis(200));
        }
    }
    if process_matches(record)? {
        request_process_stop(
            record.pid,
            record.started_at_epoch_sec,
            ProcessStopRequest::Force,
        )?;
    }
    let forced = Instant::now();
    while forced.elapsed() < Duration::from_secs(3) {
        if !process_matches(record)? {
            remove_file_if_exists(ownership_path)?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    bail!("broker process {} did not stop", record.pid)
}

fn process_exists(pid: u32) -> Result<bool> {
    let mut system = new_process_system()?;
    let pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    Ok(system
        .process(pid)
        .is_some_and(|process| process.status() != sysinfo::ProcessStatus::Zombie))
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "broker_supervisor_tests.rs"]
mod tests;
