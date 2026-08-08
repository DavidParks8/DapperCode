use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CONFIG_VERSION: u32 = 2;
const LEGACY_CONFIG_VERSION: u32 = 1;
const CONFIG_FILE_NAME: &str = "config.json";
const DEFAULT_MAX_WORKERS: usize = 12;
const DEFAULT_MAX_IDLE_WORKERS: usize = 2;
const DEFAULT_WORKER_IDLE_GRACE_MS: u64 = 60_000;
const DEFAULT_WORKER_START_TIMEOUT_MS: u64 = 60_000;

/// Filesystem layout for the central, app-owned data directory.
///
/// Nothing the desktop app owns is written into a user's repository. Every profile keeps its
/// configuration, manifest, logs, and runtime state beneath this directory so that many bridges can
/// run in parallel without contending for the same files.
#[derive(Clone, Debug)]
pub struct AppPaths {
    base: PathBuf,
}

impl AppPaths {
    pub fn discover() -> Result<Self> {
        let base = match std::env::var_os("DAPPERCODE_DATA_DIR") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => platform_data_dir()?,
        };
        if !base.is_absolute() {
            bail!(
                "DapperCode data directory must be an absolute path: {}",
                base.display()
            );
        }
        create_private_dir(&base)?;
        Ok(Self { base })
    }

    #[cfg(test)]
    pub fn for_tests(base: PathBuf) -> Self {
        Self { base }
    }

    pub fn config_path(&self) -> PathBuf {
        self.base.join(CONFIG_FILE_NAME)
    }

    pub fn base_dir(&self) -> &Path {
        &self.base
    }

    pub fn config_lock_path(&self) -> PathBuf {
        self.base.join("runtime").join("config.lock")
    }

    pub fn secret_file_path(&self, profile_id: &str) -> PathBuf {
        self.base.join("secrets").join(format!("{profile_id}.json"))
    }

    pub fn profile_dir(&self, profile_id: &str) -> PathBuf {
        self.base.join("profiles").join(profile_id)
    }

    pub fn manifest_path(&self, profile_id: &str) -> PathBuf {
        self.profile_dir(profile_id).join("agents.json")
    }

    pub fn log_path(&self, profile_id: &str) -> PathBuf {
        self.profile_dir(profile_id).join("bridge.log")
    }

    pub fn runtime_dir(&self, profile_id: &str) -> PathBuf {
        self.profile_dir(profile_id).join("runtime")
    }

    pub fn ownership_path(&self, profile_id: &str) -> PathBuf {
        self.runtime_dir(profile_id).join("process.json")
    }

    pub fn transition_lock_path(&self, profile_id: &str) -> PathBuf {
        self.runtime_dir(profile_id).join("transition.lock")
    }

    pub fn broker_runtime_dir(&self) -> PathBuf {
        self.base.join("runtime").join("broker")
    }

    pub fn broker_ownership_path(&self) -> PathBuf {
        self.broker_runtime_dir().join("process.json")
    }

    pub fn broker_transition_lock_path(&self) -> PathBuf {
        self.broker_runtime_dir().join("transition.lock")
    }

    pub fn broker_log_path(&self) -> PathBuf {
        self.base.join("broker.log")
    }

    pub fn state_dir(&self, profile_id: &str) -> PathBuf {
        self.profile_dir(profile_id).join("state")
    }

    pub fn attachments_dir(&self, profile_id: &str) -> PathBuf {
        self.profile_dir(profile_id).join("attachments")
    }

    /// Creates every directory a running bridge needs for the given profile.
    pub fn prepare_profile(&self, profile_id: &str) -> Result<()> {
        for directory in [
            self.profile_dir(profile_id),
            self.runtime_dir(profile_id),
            self.state_dir(profile_id),
            self.attachments_dir(profile_id),
        ] {
            create_private_dir(&directory)?;
        }
        Ok(())
    }

    pub fn load_config(&self) -> Result<AppConfig> {
        read_config(&self.config_path())
    }

    /// Upgrades the previous per-workspace-listener layout before strict config reads run.
    ///
    /// Version 1 assigned every profile its own public ports. Version 2 deterministically chooses
    /// the lexicographically first profile as the canonical broker endpoint, preserves every
    /// workspace identity/token/state directory, and points all pairing payloads at that endpoint.
    pub fn migrate_config(&self) -> Result<bool> {
        let _lease = self.acquire_config_lease()?;
        let path = self.config_path();
        let contents = match fs::read(&path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(error).with_context(|| format!("failed to read {}", path.display()))
            }
        };
        let mut config: AppConfig = serde_json::from_slice(&contents)
            .with_context(|| format!("invalid DapperCode configuration at {}", path.display()))?;
        match config.version {
            CONFIG_VERSION => Ok(false),
            LEGACY_CONFIG_VERSION => {
                config.upgrade_from_v1()?;
                atomic_private_write(&path, &serde_json::to_vec_pretty(&config)?)?;
                Ok(true)
            }
            version => bail!(
                "unsupported DapperCode configuration version {version} at {}",
                path.display()
            ),
        }
    }

    /// Reads, mutates, and writes `config.json` while holding the global lock so that concurrent
    /// operator invocations from different worktrees serialize instead of clobbering each other.
    pub fn update_config<T>(&self, mutate: impl FnOnce(&mut AppConfig) -> Result<T>) -> Result<T> {
        let _lease = self.acquire_config_lease()?;
        let mut config = read_config(&self.config_path())?;
        let outcome = mutate(&mut config)?;
        config
            .profiles
            .sort_by(|a, b| a.profile_id.cmp(&b.profile_id));
        config.validate()?;
        atomic_private_write(&self.config_path(), &serde_json::to_vec_pretty(&config)?)?;
        Ok(outcome)
    }

    pub fn acquire_config_lease(&self) -> Result<FileLease> {
        FileLease::acquire(&self.config_lock_path())
    }
}

#[cfg(target_os = "macos")]
fn platform_data_dir() -> Result<PathBuf> {
    Ok(home_dir()?
        .join("Library/Application Support")
        .join("dev.dappercode.desktop"))
}

#[cfg(target_os = "windows")]
fn platform_data_dir() -> Result<PathBuf> {
    match std::env::var_os("APPDATA") {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value).join("DapperCode")),
        _ => bail!("APPDATA is not set; cannot locate the DapperCode data directory"),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_data_dir() -> Result<PathBuf> {
    match std::env::var_os("XDG_DATA_HOME") {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value).join("dappercode")),
        _ => Ok(home_dir()?.join(".local/share/dappercode")),
    }
}

#[cfg(unix)]
fn home_dir() -> Result<PathBuf> {
    match std::env::var_os("HOME") {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value)),
        _ => bail!("HOME is not set; cannot locate the DapperCode data directory"),
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub version: u32,
    #[serde(default)]
    pub broker: Option<BrokerSettings>,
    #[serde(default)]
    pub profiles: Vec<Profile>,
}

impl AppConfig {
    fn empty() -> Self {
        Self {
            version: CONFIG_VERSION,
            broker: None,
            profiles: Vec::new(),
        }
    }

    fn upgrade_from_v1(&mut self) -> Result<()> {
        self.profiles
            .sort_by(|left, right| left.profile_id.cmp(&right.profile_id));
        self.broker = self
            .profiles
            .first()
            .map(|profile| BrokerSettings::from_legacy_profile(profile, &self.profiles));
        if let Some(broker) = &self.broker {
            for profile in &mut self.profiles {
                broker.apply_endpoint(profile);
            }
        }
        self.version = CONFIG_VERSION;
        self.validate()?;
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        if self.version != CONFIG_VERSION {
            bail!(
                "unsupported DapperCode configuration version {}",
                self.version
            );
        }
        if let Some(broker) = &self.broker {
            broker.validate()?;
        } else if !self.profiles.is_empty() {
            bail!("configured workspaces require broker settings");
        }
        Ok(())
    }

    pub fn find(&self, profile_id: &str) -> Option<&Profile> {
        self.profiles
            .iter()
            .find(|profile| profile.profile_id == profile_id)
    }

    pub fn upsert(&mut self, profile: Profile) {
        if self.broker.is_none() {
            self.broker = Some(BrokerSettings::from_legacy_profile(
                &profile,
                std::slice::from_ref(&profile),
            ));
        }
        match self
            .profiles
            .iter_mut()
            .find(|existing| existing.profile_id == profile.profile_id)
        {
            Some(existing) => *existing = profile,
            None => self.profiles.push(profile),
        }
    }

    /// Removes a profile, returning whether it existed.
    pub fn remove(&mut self, profile_id: &str) -> bool {
        let before = self.profiles.len();
        self.profiles
            .retain(|profile| profile.profile_id != profile_id);
        let removed = self.profiles.len() != before;
        if self.profiles.is_empty() {
            self.broker = None;
        }
        removed
    }

    /// Ports already claimed by a profile other than `profile_id`.
    pub fn reserved_ports(&self, profile_id: &str) -> Vec<(u16, &Profile)> {
        self.profiles
            .iter()
            .filter(|profile| profile.profile_id != profile_id)
            .flat_map(|profile| {
                [
                    (profile.bridge_port, profile),
                    (profile.preview_port, profile),
                ]
            })
            .collect()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerSettings {
    pub network_mode: String,
    pub host: String,
    pub bridge_port: u16,
    pub preview_port: u16,
    pub connect_url: String,
    pub preview_connect_url: String,
    #[serde(default)]
    pub legacy_bridge_endpoints: Vec<BrokerEndpoint>,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default = "default_max_workers")]
    pub max_workers: usize,
    #[serde(default = "default_max_idle_workers")]
    pub max_idle_workers: usize,
    #[serde(default = "default_worker_idle_grace_ms")]
    pub worker_idle_grace_ms: u64,
    #[serde(default = "default_worker_start_timeout_ms")]
    pub worker_start_timeout_ms: u64,
}

impl BrokerSettings {
    pub fn new(
        network_mode: String,
        host: String,
        bridge_port: u16,
        preview_port: u16,
        connect_url: String,
        preview_connect_url: String,
    ) -> Result<Self> {
        let settings = Self {
            network_mode,
            host,
            bridge_port,
            preview_port,
            connect_url,
            preview_connect_url,
            legacy_bridge_endpoints: Vec::new(),
            auto_start: false,
            max_workers: DEFAULT_MAX_WORKERS,
            max_idle_workers: DEFAULT_MAX_IDLE_WORKERS,
            worker_idle_grace_ms: DEFAULT_WORKER_IDLE_GRACE_MS,
            worker_start_timeout_ms: DEFAULT_WORKER_START_TIMEOUT_MS,
        };
        settings.validate()?;
        Ok(settings)
    }

    fn from_legacy_profile(profile: &Profile, profiles: &[Profile]) -> Self {
        let mut legacy_bridge_endpoints = profiles
            .iter()
            .filter(|candidate| {
                candidate.bridge_host != profile.bridge_host
                    || candidate.bridge_port != profile.bridge_port
            })
            .map(|candidate| BrokerEndpoint {
                host: candidate.bridge_host.clone(),
                port: candidate.bridge_port,
            })
            .collect::<Vec<_>>();
        legacy_bridge_endpoints.sort_by(|left, right| {
            left.host
                .cmp(&right.host)
                .then_with(|| left.port.cmp(&right.port))
        });
        legacy_bridge_endpoints.dedup();
        Self {
            network_mode: profile.network_mode.clone(),
            host: profile.bridge_host.clone(),
            bridge_port: profile.bridge_port,
            preview_port: profile.preview_port,
            connect_url: profile.connect_url.clone(),
            preview_connect_url: profile.preview_connect_url.clone(),
            legacy_bridge_endpoints,
            auto_start: profiles.iter().any(|profile| profile.auto_start),
            max_workers: DEFAULT_MAX_WORKERS,
            max_idle_workers: DEFAULT_MAX_IDLE_WORKERS,
            worker_idle_grace_ms: DEFAULT_WORKER_IDLE_GRACE_MS,
            worker_start_timeout_ms: DEFAULT_WORKER_START_TIMEOUT_MS,
        }
    }

    pub fn apply_endpoint(&self, profile: &mut Profile) {
        profile.network_mode.clone_from(&self.network_mode);
        profile.bridge_host.clone_from(&self.host);
        profile.bridge_port = self.bridge_port;
        profile.connect_url.clone_from(&self.connect_url);
        let preview_host = if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        profile.preview_connect_url = format!("http://{preview_host}:{}", profile.preview_port);
    }

    pub fn validate(&self) -> Result<()> {
        if self.bridge_port == 0 || self.preview_port == 0 || self.bridge_port == self.preview_port
        {
            bail!("broker ports must be non-zero and distinct");
        }
        if self.host.trim().is_empty()
            || self.connect_url.trim().is_empty()
            || self.preview_connect_url.trim().is_empty()
        {
            bail!("broker host and connect URLs must not be empty");
        }
        if self
            .legacy_bridge_endpoints
            .iter()
            .any(|endpoint| endpoint.host.trim().is_empty() || endpoint.port == 0)
        {
            bail!("legacy broker endpoints must have a host and non-zero port");
        }
        if self.max_workers == 0 {
            bail!("broker maxWorkers must be positive");
        }
        if self.max_idle_workers > self.max_workers {
            bail!("broker maxIdleWorkers must not exceed maxWorkers");
        }
        if self.worker_idle_grace_ms == 0 || self.worker_start_timeout_ms == 0 {
            bail!("broker worker timing values must be positive");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerEndpoint {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub profile_id: String,
    pub workspace: PathBuf,
    pub network_mode: String,
    pub bridge_host: String,
    pub bridge_port: u16,
    pub preview_port: u16,
    pub connect_url: String,
    pub preview_connect_url: String,
    pub auto_start: bool,
    #[serde(default = "default_true")]
    pub allow_query_token_auth: bool,
    #[serde(default = "default_initialize_timeout_ms")]
    pub acp_initialize_timeout_ms: u64,
    pub agent: ProfileAgent,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileAgent {
    pub agent_id: String,
    pub display_name: String,
    pub executable: PathBuf,
    #[serde(default)]
    pub argv: Vec<String>,
    pub resolved_version: String,
    pub verified_digest: String,
}

fn default_true() -> bool {
    true
}

fn default_initialize_timeout_ms() -> u64 {
    15_000
}

fn default_max_workers() -> usize {
    DEFAULT_MAX_WORKERS
}

fn default_max_idle_workers() -> usize {
    DEFAULT_MAX_IDLE_WORKERS
}

fn default_worker_idle_grace_ms() -> u64 {
    DEFAULT_WORKER_IDLE_GRACE_MS
}

fn default_worker_start_timeout_ms() -> u64 {
    DEFAULT_WORKER_START_TIMEOUT_MS
}

/// Stable, human-recognizable identity for a workspace.
///
/// Two worktrees of the same repository canonicalize to different paths, so they receive different
/// profiles and can run their bridges side by side.
pub fn profile_id_for(workspace: &Path) -> String {
    let digest = Sha256::digest(workspace.to_string_lossy().as_bytes());
    let fingerprint: String = format!("{digest:x}").chars().take(12).collect();
    let slug = workspace
        .file_name()
        .and_then(|name| name.to_str())
        .map(sanitize_slug)
        .filter(|slug| !slug.is_empty())
        .unwrap_or_else(|| "workspace".to_string());
    format!("{slug}-{fingerprint}")
}

fn sanitize_slug(value: &str) -> String {
    let slug: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    slug.trim_matches('-')
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(48)
        .collect()
}

fn read_config(path: &Path) -> Result<AppConfig> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(AppConfig::empty()),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()))
        }
    };
    let config: AppConfig = serde_json::from_slice(&contents)
        .with_context(|| format!("invalid DapperCode configuration at {}", path.display()))?;
    if config.version != CONFIG_VERSION {
        bail!(
            "unsupported DapperCode configuration version {} at {}",
            config.version,
            path.display()
        );
    }
    config.validate()?;
    Ok(config)
}

pub struct FileLease {
    file: File,
}

impl FileLease {
    pub fn acquire(path: &Path) -> Result<Self> {
        let parent = path.parent().context("lock file has no parent directory")?;
        create_private_dir(parent)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(path)
            .with_context(|| format!("failed to open {}", path.display()))?;
        file.lock_exclusive()
            .with_context(|| format!("failed to lock {}", path.display()))?;
        Ok(Self { file })
    }
}

impl Drop for FileLease {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

pub fn create_private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("failed to create {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)?.permissions();
        if permissions.mode() & 0o077 != 0 {
            permissions.set_mode(0o700);
            fs::set_permissions(path, permissions)
                .with_context(|| format!("failed to restrict {}", path.display()))?;
        }
    }
    Ok(())
}

/// Writes `contents` to `path` atomically with owner-only permissions.
pub fn atomic_private_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path.parent().context("generated file has no parent")?;
    create_private_dir(parent)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("state"),
        std::process::id(),
        nonce
    ));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(contents)?;
        if !contents.ends_with(b"\n") {
            file.write_all(b"\n")?;
        }
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to remove {}", path.display())),
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_profile(profile_id: &str, port: u16) -> Profile {
        Profile {
            profile_id: profile_id.to_string(),
            workspace: PathBuf::from("/tmp/project"),
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
                agent_id: "opencode".to_string(),
                display_name: "OpenCode".to_string(),
                executable: PathBuf::from("/bin/echo"),
                argv: vec!["acp".to_string()],
                resolved_version: "local".to_string(),
                verified_digest: "sha256:abc".to_string(),
            },
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn profile_ids_differ_per_worktree_and_stay_stable() {
        let first = profile_id_for(Path::new("/Users/dev/code/project"));
        let second = profile_id_for(Path::new("/Users/dev/worktrees/project"));
        assert_ne!(first, second);
        assert_eq!(first, profile_id_for(Path::new("/Users/dev/code/project")));
        assert!(first.starts_with("project-"));
        assert!(profile_id_for(Path::new("/Users/dev/My Repo!")).starts_with("my-repo-"));
    }

    #[test]
    fn round_trips_config_and_reports_other_profile_ports() {
        let temp = tempdir().unwrap();
        let paths = AppPaths {
            base: temp.path().to_path_buf(),
        };

        paths
            .update_config(|config| {
                config.upsert(sample_profile("alpha-000000000001", 8787));
                config.upsert(sample_profile("beta-000000000002", 8789));
                Ok(())
            })
            .unwrap();

        let config = paths.load_config().unwrap();
        assert_eq!(config.version, CONFIG_VERSION);
        assert_eq!(config.profiles.len(), 2);
        assert_eq!(config.find("alpha-000000000001").unwrap().bridge_port, 8787);

        let reserved: Vec<u16> = config
            .reserved_ports("alpha-000000000001")
            .into_iter()
            .map(|(port, _)| port)
            .collect();
        assert_eq!(reserved, vec![8789, 8790]);
    }

    #[test]
    fn rewrites_an_existing_profile_instead_of_duplicating_it() {
        let temp = tempdir().unwrap();
        let paths = AppPaths {
            base: temp.path().to_path_buf(),
        };

        paths
            .update_config(|config| {
                config.upsert(sample_profile("alpha-000000000001", 8787));
                Ok(())
            })
            .unwrap();
        paths
            .update_config(|config| {
                config.upsert(sample_profile("alpha-000000000001", 9001));
                Ok(())
            })
            .unwrap();

        let config = paths.load_config().unwrap();
        assert_eq!(config.profiles.len(), 1);
        assert_eq!(config.profiles[0].bridge_port, 9001);
    }

    #[test]
    fn persists_the_profile_autostart_intent_and_rejects_missing_current_fields() {
        let temp = tempdir().unwrap();
        let paths = AppPaths {
            base: temp.path().to_path_buf(),
        };

        paths
            .update_config(|config| {
                let mut profile = sample_profile("alpha-000000000001", 8787);
                profile.auto_start = true;
                config.upsert(profile);
                Ok(())
            })
            .unwrap();

        assert!(
            paths
                .load_config()
                .unwrap()
                .find("alpha-000000000001")
                .unwrap()
                .auto_start
        );

        let mut incomplete =
            serde_json::to_value(sample_profile("incomplete-000000000002", 8789)).unwrap();
        incomplete.as_object_mut().unwrap().remove("autoStart");
        assert!(serde_json::from_value::<Profile>(incomplete).is_err());
    }

    #[test]
    fn rejects_configuration_written_by_a_newer_version() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("config.json");
        fs::write(&path, br#"{"version":99,"profiles":[]}"#).unwrap();
        assert!(read_config(&path)
            .unwrap_err()
            .to_string()
            .contains("unsupported DapperCode configuration version"));
    }

    #[test]
    fn migrates_v1_profiles_to_one_deterministic_broker_endpoint() {
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let mut alpha = sample_profile("alpha-000000000001", 8787);
        alpha.auto_start = false;
        let mut beta = sample_profile("beta-000000000002", 9797);
        beta.auto_start = true;
        beta.bridge_host = "192.168.1.20".to_string();
        beta.connect_url = "http://192.168.1.20:9797".to_string();
        beta.preview_connect_url = "http://192.168.1.20:9798".to_string();
        fs::write(
            paths.config_path(),
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "profiles": [beta, alpha],
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(paths.migrate_config().unwrap());
        assert!(!paths.migrate_config().unwrap());
        let migrated = paths.load_config().unwrap();
        let broker = migrated.broker.unwrap();
        assert_eq!(broker.bridge_port, 8787);
        assert_eq!(broker.preview_port, 8788);
        assert!(broker.auto_start);
        assert_eq!(
            broker.legacy_bridge_endpoints,
            vec![BrokerEndpoint {
                host: "192.168.1.20".to_string(),
                port: 9797,
            }]
        );
        assert_eq!(
            migrated
                .profiles
                .iter()
                .map(|profile| profile.profile_id.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha-000000000001", "beta-000000000002"]
        );
        assert!(migrated.profiles.iter().all(|profile| {
            profile.bridge_port == 8787 && profile.connect_url == "http://127.0.0.1:8787"
        }));
        assert_eq!(
            migrated
                .profiles
                .iter()
                .map(|profile| profile.preview_port)
                .collect::<Vec<_>>(),
            vec![8788, 9798]
        );
        assert!(migrated
            .profiles
            .iter()
            .all(|profile| profile.preview_connect_url.starts_with("http://127.0.0.1:")));
    }

    #[test]
    fn broker_settings_validate_all_resource_and_endpoint_boundaries() {
        let valid = BrokerSettings::new(
            "local".to_string(),
            "127.0.0.1".to_string(),
            8787,
            8788,
            "http://127.0.0.1:8787".to_string(),
            "http://127.0.0.1:8788".to_string(),
        )
        .unwrap();

        let mut invalid = valid.clone();
        invalid.bridge_port = 0;
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.preview_port = 0;
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.preview_port = invalid.bridge_port;
        assert!(invalid.validate().is_err());

        let mut invalid = valid.clone();
        invalid.host = " ".to_string();
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.connect_url = " ".to_string();
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.preview_connect_url = " ".to_string();
        assert!(invalid.validate().is_err());

        let mut invalid = valid.clone();
        invalid.legacy_bridge_endpoints = vec![BrokerEndpoint {
            host: " ".to_string(),
            port: 8789,
        }];
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.legacy_bridge_endpoints = vec![BrokerEndpoint {
            host: "127.0.0.1".to_string(),
            port: 0,
        }];
        assert!(invalid.validate().is_err());

        let mut invalid = valid.clone();
        invalid.max_workers = 0;
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.max_idle_workers = invalid.max_workers + 1;
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.worker_idle_grace_ms = 0;
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.worker_start_timeout_ms = 0;
        assert!(invalid.validate().is_err());

        let mut ipv6 = valid;
        ipv6.host = "::1".to_string();
        ipv6.connect_url = "http://[::1]:8787".to_string();
        let mut profile = sample_profile("ipv6-000000000003", 9797);
        ipv6.apply_endpoint(&mut profile);
        assert_eq!(profile.bridge_host, "::1");
        assert_eq!(profile.bridge_port, 8787);
        assert_eq!(profile.preview_connect_url, "http://[::1]:9798");

        ipv6.host = "[::1]".to_string();
        ipv6.apply_endpoint(&mut profile);
        assert_eq!(profile.preview_connect_url, "http://[::1]:9798");
    }

    #[test]
    fn app_config_requires_broker_settings_and_tracks_profile_lifecycle() {
        let mut wrong_version = AppConfig::empty();
        wrong_version.version = CONFIG_VERSION + 1;
        assert!(wrong_version.validate().is_err());

        let mut missing_broker = AppConfig::empty();
        missing_broker
            .profiles
            .push(sample_profile("alpha-000000000001", 8787));
        assert!(missing_broker.validate().is_err());

        let mut config = AppConfig::empty();
        assert!(config.validate().is_ok());
        let mut alpha = sample_profile("alpha-000000000001", 8787);
        config.upsert(alpha.clone());
        assert!(config.broker.is_some());
        alpha.updated_at = "updated".to_string();
        config.upsert(alpha);
        config.upsert(sample_profile("beta-000000000002", 8787));
        assert_eq!(config.profiles.len(), 2);
        assert!(config.remove("alpha-000000000001"));
        assert!(config.broker.is_some());
        assert!(!config.remove("missing"));
        assert!(config.remove("beta-000000000002"));
        assert!(config.broker.is_none());
    }

    #[test]
    fn prepares_every_profile_directory_privately() {
        let temp = tempdir().unwrap();
        let paths = AppPaths {
            base: temp.path().to_path_buf(),
        };
        paths.prepare_profile("alpha-000000000001").unwrap();

        for directory in [
            paths.profile_dir("alpha-000000000001"),
            paths.runtime_dir("alpha-000000000001"),
            paths.state_dir("alpha-000000000001"),
            paths.attachments_dir("alpha-000000000001"),
        ] {
            assert!(directory.is_dir(), "{} should exist", directory.display());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(&directory).unwrap().permissions().mode();
                assert_eq!(mode & 0o077, 0, "{} should be private", directory.display());
            }
        }
    }

    #[test]
    fn atomic_write_leaves_no_temporary_files_behind() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("nested").join("state.json");
        atomic_private_write(&path, b"{}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}\n");

        let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn atomic_write_preserves_a_trailing_newline_it_was_given() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("state.json");
        atomic_private_write(&path, b"{}\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}\n");
        assert!(atomic_private_write(Path::new("/"), b"{}").is_err());
    }

    #[test]
    fn removing_a_missing_file_succeeds() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("absent");
        remove_file_if_exists(&path).unwrap();

        fs::write(&path, b"x").unwrap();
        remove_file_if_exists(&path).unwrap();
        assert!(!path.exists());

        // A directory cannot be unlinked, so the error is surfaced rather than swallowed.
        assert!(remove_file_if_exists(temp.path())
            .unwrap_err()
            .to_string()
            .contains("failed to remove"));
    }

    #[test]
    fn locates_the_home_directory_or_explains_why_it_cannot() {
        struct Guard(Option<std::ffi::OsString>);
        impl Drop for Guard {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(value) => std::env::set_var("HOME", value),
                    None => std::env::remove_var("HOME"),
                }
            }
        }
        let _guard = Guard(std::env::var_os("HOME"));

        std::env::set_var("HOME", "/tmp/dappercode-home");
        assert_eq!(home_dir().unwrap(), PathBuf::from("/tmp/dappercode-home"));

        std::env::set_var("HOME", "");
        assert!(home_dir()
            .unwrap_err()
            .to_string()
            .contains("HOME is not set"));

        std::env::remove_var("HOME");
        assert!(home_dir().is_err());
    }

    #[test]
    fn surfaces_a_configuration_read_failure_that_is_not_a_missing_file() {
        let temp = tempdir().unwrap();
        // Reading a directory as a file fails with something other than NotFound.
        assert!(read_config(temp.path())
            .unwrap_err()
            .to_string()
            .contains("failed to read"));
    }

    #[test]
    fn honours_the_data_directory_override_and_rejects_relative_paths() {
        struct Guard;
        impl Drop for Guard {
            fn drop(&mut self) {
                std::env::remove_var("DAPPERCODE_DATA_DIR");
            }
        }
        let _guard = Guard;
        let temp = tempdir().unwrap();

        std::env::set_var("DAPPERCODE_DATA_DIR", temp.path());
        let paths = AppPaths::discover().unwrap();
        assert_eq!(paths.config_path(), temp.path().join("config.json"));
        assert_eq!(
            paths.config_lock_path(),
            temp.path().join("runtime").join("config.lock")
        );

        std::env::set_var("DAPPERCODE_DATA_DIR", "relative/path");
        assert!(AppPaths::discover()
            .unwrap_err()
            .to_string()
            .contains("must be an absolute path"));

        // An empty override falls through to the platform default. That default is only inspected,
        // never created, so the test does not touch the real user data directory.
        std::env::set_var("DAPPERCODE_DATA_DIR", "");
        assert!(platform_data_dir().unwrap().is_absolute());
    }

    #[test]
    fn removes_a_profile_only_when_it_exists() {
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        paths
            .update_config(|config| {
                config.upsert(sample_profile("alpha-000000000001", 8787));
                Ok(())
            })
            .unwrap();

        assert!(paths
            .update_config(|config| Ok(config.remove("alpha-000000000001")))
            .unwrap());
        assert!(!paths
            .update_config(|config| Ok(config.remove("alpha-000000000001")))
            .unwrap());
        let empty = paths.load_config().unwrap();
        assert!(empty.profiles.is_empty());
        assert!(empty.broker.is_none());
        assert!(paths
            .load_config()
            .unwrap()
            .find("alpha-000000000001")
            .is_none());
    }

    #[test]
    fn reports_malformed_configuration_instead_of_silently_resetting_it() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("config.json");
        fs::write(&path, b"{ not json").unwrap();
        assert!(read_config(&path)
            .unwrap_err()
            .to_string()
            .contains("invalid DapperCode configuration"));
    }

    #[test]
    fn treats_an_absent_configuration_as_empty() {
        let temp = tempdir().unwrap();
        let config = read_config(&temp.path().join("absent.json")).unwrap();
        assert_eq!(config.version, CONFIG_VERSION);
        assert!(config.profiles.is_empty());
        assert!(config.reserved_ports("anything").is_empty());
    }

    #[test]
    fn propagates_a_failed_configuration_mutation_without_writing() {
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());

        let error = paths
            .update_config(|_| Err::<(), _>(anyhow::anyhow!("mutation refused")))
            .unwrap_err();
        assert_eq!(error.to_string(), "mutation refused");
        assert!(!paths.config_path().exists());
    }

    #[test]
    fn sanitizes_workspace_names_into_readable_slugs() {
        assert!(profile_id_for(Path::new("/")).starts_with("workspace-"));
        assert!(profile_id_for(Path::new("/tmp/---")).starts_with("workspace-"));
        assert!(profile_id_for(Path::new("/tmp/UPPER Case")).starts_with("upper-case-"));
        let long = profile_id_for(Path::new(&format!("/tmp/{}", "a".repeat(80))));
        assert_eq!(long.split('-').next().unwrap().len(), 48);
    }

    #[test]
    fn a_lock_cannot_be_taken_twice_but_is_released_on_drop() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("runtime").join("config.lock");
        let lease = FileLease::acquire(&path).unwrap();
        drop(lease);
        FileLease::acquire(&path).unwrap();
        assert!(FileLease::acquire(temp.path()).is_err());
    }

    #[test]
    fn tightens_permissions_on_an_over_shared_directory() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("loose");
        fs::create_dir_all(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o777)).unwrap();
            create_private_dir(&path).unwrap();
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0);
            // Re-running must be a no-op rather than churning permissions.
            create_private_dir(&path).unwrap();
        }
        #[cfg(not(unix))]
        create_private_dir(&path).unwrap();
    }
}
