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
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System};

use crate::{
    config::BridgeRuntimeConfig,
    secrets::SecretStore,
    store::{
        atomic_private_write, remove_file_if_exists, AppPaths, BrokerSettings, FileLease, Profile,
    },
    supervisor::{BridgeSnapshot, BridgeState},
};

const START_TIMEOUT: Duration = Duration::from_secs(15);
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
            .context("no stored workspace credential; run setup again")?;
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

    pub fn start(&self) -> Result<BridgeSnapshot> {
        let _lease = self.acquire_transition_lease()?;
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
        while started.elapsed() < START_TIMEOUT {
            if self.fetch_health().is_ok() {
                return Ok(self.snapshot());
            }
            if !process_matches(&ownership) {
                let _ = remove_file_if_exists(&self.paths.broker_ownership_path());
                bail!(
                    "broker exited before becoming healthy; inspect {}",
                    log_path.display()
                );
            }
            thread::sleep(Duration::from_millis(200));
        }
        let _ = stop_owned_process(&ownership, &self.paths.broker_ownership_path());
        bail!(
            "broker did not become healthy within {} seconds; inspect {}",
            START_TIMEOUT.as_secs(),
            log_path.display()
        )
    }

    pub fn stop(&self) -> Result<BridgeSnapshot> {
        let _lease = self.acquire_transition_lease()?;
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

    pub fn restart(&self) -> Result<BridgeSnapshot> {
        let _lease = self.acquire_transition_lease()?;
        if let Some(ownership) = read_ownership(&self.paths.broker_ownership_path())? {
            if process_matches(&ownership) {
                stop_owned_process(&ownership, &self.paths.broker_ownership_path())?;
            } else {
                remove_file_if_exists(&self.paths.broker_ownership_path())?;
            }
        }
        drop(_lease);
        self.start()
    }

    pub fn owns_running_process(&self) -> bool {
        read_ownership(&self.paths.broker_ownership_path())
            .ok()
            .flatten()
            .is_some_and(|record| process_matches(&record))
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
    let started_at_epoch_sec = process.start_time();
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
    process.start_time() == record.started_at_epoch_sec
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
        bail!(
            "refusing to stop PID {} because its process identity changed",
            record.pid
        );
    }
    signal_process(record.pid, Signal::Term)?;
    let started = Instant::now();
    while started.elapsed() < STOP_TIMEOUT {
        if !process_matches(record) {
            remove_file_if_exists(ownership_path)?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    signal_process(record.pid, Signal::Kill)?;
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

fn signal_process(pid: u32, signal: Signal) -> Result<()> {
    let mut system = System::new();
    let pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let process = system
        .process(pid)
        .ok_or_else(|| anyhow!("broker process {} no longer exists", pid.as_u32()))?;
    match process.kill_with(signal) {
        Some(true) => Ok(()),
        Some(false) => bail!(
            "operating system refused to signal broker process {}",
            pid.as_u32()
        ),
        None => bail!("requested broker process signal is unsupported"),
    }
}

#[cfg(unix)]
fn detach_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
fn detach_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const DETACHED_PROCESS: u32 = 0x00000008;
    command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
}

#[cfg(not(any(unix, windows)))]
fn detach_process(_command: &mut Command) {}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

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
}
