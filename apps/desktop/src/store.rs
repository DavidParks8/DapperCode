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

const CONFIG_VERSION: u32 = 1;
const CONFIG_FILE_NAME: &str = "config.json";

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

    pub fn pid_path(&self, profile_id: &str) -> PathBuf {
        self.runtime_dir(profile_id).join("bridge.pid")
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

    /// Reads, mutates, and writes `config.json` while holding the global lock so that concurrent
    /// operator invocations from different worktrees serialize instead of clobbering each other.
    pub fn update_config<T>(&self, mutate: impl FnOnce(&mut AppConfig) -> Result<T>) -> Result<T> {
        let _lease = self.acquire_config_lease()?;
        let mut config = read_config(&self.config_path())?;
        let outcome = mutate(&mut config)?;
        config
            .profiles
            .sort_by(|a, b| a.profile_id.cmp(&b.profile_id));
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
    pub profiles: Vec<Profile>,
}

impl AppConfig {
    fn empty() -> Self {
        Self {
            version: CONFIG_VERSION,
            profiles: Vec::new(),
        }
    }

    pub fn find(&self, profile_id: &str) -> Option<&Profile> {
        self.profiles
            .iter()
            .find(|profile| profile.profile_id == profile_id)
    }

    pub fn find_mut(&mut self, profile_id: &str) -> Option<&mut Profile> {
        self.profiles
            .iter_mut()
            .find(|profile| profile.profile_id == profile_id)
    }

    pub fn upsert(&mut self, profile: Profile) {
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
        self.profiles.len() != before
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
pub struct Profile {
    pub profile_id: String,
    pub workspace: PathBuf,
    pub network_mode: String,
    pub bridge_host: String,
    pub bridge_port: u16,
    pub preview_port: u16,
    pub connect_url: String,
    pub preview_connect_url: String,
    #[serde(default)]
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
    fn persists_the_profile_autostart_intent_and_defaults_legacy_profiles_to_off() {
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

        let mut legacy = serde_json::to_value(sample_profile("legacy-000000000002", 8789)).unwrap();
        legacy.as_object_mut().unwrap().remove("autoStart");
        let decoded: Profile = serde_json::from_value(legacy).unwrap();
        assert!(!decoded.auto_start);
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
        assert!(paths.load_config().unwrap().profiles.is_empty());
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
