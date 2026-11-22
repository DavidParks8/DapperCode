#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "central store schema, locking, and atomic persistence live together"
    )
)]

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::phone_call::PhoneCallSettings;
use crate::platform;

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

pub(crate) trait ConfigSideEffects {
    type Output;

    fn apply(&mut self) -> Result<Self::Output>;
    fn rollback(&mut self) -> Result<()>;
}

impl AppPaths {
    pub fn discover() -> Result<Self> {
        #[cfg(not(test))]
        let data_dir = std::env::var_os("DAPPERCODE_DATA_DIR");
        #[cfg(test)]
        let data_dir = crate::test_env::var_os("DAPPERCODE_DATA_DIR");
        let base = match data_dir {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => platform::data_dir()?,
        };
        if !base.is_absolute() {
            bail!(
                "DapperCode data directory must be an absolute path: {}",
                base.display(),
            );
        }
        create_private_dir(&base)?;
        Ok(Self { base })
    }

    #[cfg(any(test, feature = "test-support"))]
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

    pub fn secret_vault_file_path(&self) -> PathBuf {
        self.base.join("secrets").join("bridge-auth-vault.json")
    }

    pub fn sip_secret_file_path(&self) -> PathBuf {
        self.base.join("secrets").join("phone-call-sip.json")
    }

    pub fn secret_vault_lock_path(&self) -> PathBuf {
        self.base.join("runtime").join("bridge-auth-vault.lock")
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

    pub fn load_config_with_revision(&self) -> Result<(AppConfig, Option<[u8; 32]>)> {
        read_config_with_revision(&self.config_path())
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
                path.display(),
            ),
        }
    }

    /// Reads, mutates, and writes `config.json` while holding the global lock so that concurrent
    /// operator invocations from different worktrees serialize instead of clobbering each other.
    pub fn update_config<Outcome>(
        &self,
        mutate: impl FnOnce(&mut AppConfig) -> Result<Outcome>,
    ) -> Result<Outcome> {
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

    pub(crate) fn update_config_with_side_effects<Outcome, Effects>(
        &self,
        mutate: impl FnOnce(&mut AppConfig) -> Result<Outcome>,
        side_effects: &mut Effects,
    ) -> Result<(Outcome, Effects::Output)>
    where
        Effects: ConfigSideEffects,
    {
        let _lease = self.acquire_config_lease()?;
        let mut config = read_config(&self.config_path())?;
        let outcome = mutate(&mut config)?;
        config
            .profiles
            .sort_by(|a, b| a.profile_id.cmp(&b.profile_id));
        config.validate()?;
        let bytes = serde_json::to_vec_pretty(&config)?;
        let side_effect_outcome = match side_effects.apply() {
            Ok(outcome) => outcome,
            Err(error) => {
                return Err(Self::with_rollback_error(error, side_effects.rollback()));
            }
        };
        if let Err(error) = atomic_private_write(&self.config_path(), &bytes) {
            return Err(Self::with_rollback_error(error, side_effects.rollback()));
        }
        Ok((outcome, side_effect_outcome))
    }

    pub fn update_config_then<Outcome>(
        &self,
        mutate: impl FnOnce(&mut AppConfig) -> Result<Outcome>,
        after_commit: impl FnOnce() -> Result<()>,
    ) -> Result<Outcome> {
        let _lease = self.acquire_config_lease()?;
        let mut config = read_config(&self.config_path())?;
        let outcome = mutate(&mut config)?;
        config
            .profiles
            .sort_by(|a, b| a.profile_id.cmp(&b.profile_id));
        config.validate()?;
        atomic_private_write(&self.config_path(), &serde_json::to_vec_pretty(&config)?)?;
        after_commit()?;
        Ok(outcome)
    }

    pub fn acquire_config_lease(&self) -> Result<FileLease> {
        FileLease::acquire(&self.config_lock_path())
    }

    pub(crate) fn with_rollback_error(
        primary: anyhow::Error,
        rollback: Result<()>,
    ) -> anyhow::Error {
        match rollback {
            Ok(()) => primary,
            Err(rollback) => anyhow!("{primary:#}; side-effect rollback also failed: {rollback:#}"),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub version: u32,
    #[serde(default)]
    pub broker: Option<BrokerSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone_call: Option<PhoneCallSettings>,
    #[serde(default)]
    pub profiles: Vec<Profile>,
}

impl AppConfig {
    pub(crate) fn empty() -> Self {
        Self {
            version: CONFIG_VERSION,
            broker: None,
            phone_call: None,
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
                self.version,
            );
        }
        if let Some(broker) = &self.broker {
            broker.validate()?;
        } else if !self.profiles.is_empty() {
            bail!("configured workspaces require broker settings");
        }
        if let Some(phone_call) = &self.phone_call {
            phone_call.validate()?;
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
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "matches persisted broker settings schema in config.json"
    )
)]
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
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "matches persisted workspace profile schema in config.json"
    )
)]
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

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileAgent {
    pub agent_id: String,
    pub display_name: String,
    pub executable: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launcher_path: Option<PathBuf>,
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
    let fingerprint: String = hex::encode(digest).chars().take(12).collect();
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
    read_config_with_revision(path).map(|(config, _)| config)
}

fn read_config_with_revision(path: &Path) -> Result<(AppConfig, Option<[u8; 32]>)> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((AppConfig::empty(), None))
        }
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()))
        }
    };
    let revision = Some(Sha256::digest(&contents).into());
    let config: AppConfig = serde_json::from_slice(&contents)
        .with_context(|| format!("invalid DapperCode configuration at {}", path.display()))?;
    if config.version != CONFIG_VERSION {
        bail!(
            "unsupported DapperCode configuration version {} at {}",
            config.version,
            path.display(),
        );
    }
    config.validate()?;
    Ok((config, revision))
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
        platform::configure_private_file_options(&mut options);
        let file = options
            .open(path)
            .with_context(|| format!("failed to open {}", path.display()))?;
        platform::secure_private_file(path, &file)
            .with_context(|| format!("failed to secure {}", path.display()))?;
        file.lock()
            .with_context(|| format!("failed to lock {}", path.display()))?;
        Ok(Self { file })
    }
}

impl Drop for FileLease {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

pub(crate) fn create_private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("failed to create {}", path.display()))?;
    platform::secure_private_directory(path)
        .with_context(|| format!("failed to secure {}", path.display()))?;
    Ok(())
}

fn secure_existing_private_file(path: &Path) -> Result<()> {
    let mut options = OpenOptions::new();
    options.read(true);
    platform::configure_private_file_options(&mut options);
    match options.open(path) {
        Ok(file) => platform::secure_private_file(path, &file)
            .with_context(|| format!("failed to secure existing {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).with_context(|| format!("failed to open existing {}", path.display()))
        }
    }
}

/// Writes `contents` to `path` atomically with owner-only permissions.
pub(crate) fn atomic_private_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path.parent().context("generated file has no parent")?;
    create_private_dir(parent)?;
    secure_existing_private_file(path)?;
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
        nonce,
    ));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        platform::configure_private_file_options(&mut options);
        let mut file = options.open(&temporary)?;
        platform::secure_private_file(&temporary, &file)
            .with_context(|| format!("failed to secure {}", temporary.display()))?;
        file.write_all(contents)?;
        if !contents.ends_with(b"\n") {
            file.write_all(b"\n")?;
        }
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        if let Err(error) = platform::sync_parent_directory(parent) {
            eprintln!(
                "warning: {} was replaced, but its directory metadata could not be synced: {error}",
                path.display(),
            );
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub(crate) fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to remove {}", path.display())),
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "store_tests.rs"]
mod tests;
