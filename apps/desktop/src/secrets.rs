use std::path::Path;

use anyhow::{Context, Result};
use getrandom::fill as fill_random;
use serde::{Deserialize, Serialize};

use crate::store::{atomic_private_write, remove_file_if_exists, AppPaths};

const KEYCHAIN_SERVICE: &str = "dev.dappercode.desktop";
const TOKEN_ENTRY_PREFIX: &str = "bridge-auth-token";

/// Where a profile's bridge token is actually stored.
///
/// The keychain is always preferred. The file backend exists so that headless environments (CI,
/// Linux without a secret service) and the test suite keep working without silently dropping the
/// secret or prompting for a login keychain that does not exist.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretBackend {
    Keychain,
    File,
}

impl SecretBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Keychain => "keychain",
            Self::File => "file",
        }
    }
}

#[derive(Clone, Debug)]
pub struct BridgeSecret {
    pub token: String,
    pub backend: SecretBackend,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretFile {
    bridge_auth_token: String,
}

/// Indirection over the OS keychain so the fallback logic can be exercised without touching a real
/// login keychain during tests.
#[derive(Clone, Copy, Debug)]
struct Keychain {
    get: fn(&str) -> Result<Option<String>>,
    set: fn(&str, &str) -> Result<()>,
    delete: fn(&str) -> Result<()>,
}

impl Keychain {
    const SYSTEM: Self = Self {
        get: keychain_get,
        set: keychain_set,
        delete: keychain_delete,
    };
}

#[derive(Clone, Debug)]
pub struct SecretStore {
    prefer_file: bool,
    keychain: Keychain,
}

impl SecretStore {
    pub fn discover() -> Self {
        let prefer_file = std::env::var("DAPPERCODE_SECRETS_BACKEND")
            .map(|value| value.trim().eq_ignore_ascii_case("file"))
            .unwrap_or(false);
        Self {
            prefer_file,
            keychain: Keychain::SYSTEM,
        }
    }

    #[cfg(test)]
    pub fn file_backend_for_tests() -> Self {
        Self {
            prefer_file: true,
            keychain: Keychain::SYSTEM,
        }
    }

    #[cfg(test)]
    fn with_keychain(keychain: Keychain) -> Self {
        Self {
            prefer_file: false,
            keychain,
        }
    }

    /// Returns the stored token, or `None` when the profile has never been set up.
    pub fn get(&self, paths: &AppPaths, profile_id: &str) -> Result<Option<BridgeSecret>> {
        if !self.prefer_file {
            if let Some(token) = (self.keychain.get)(profile_id)? {
                return Ok(Some(BridgeSecret {
                    token,
                    backend: SecretBackend::Keychain,
                }));
            }
        }
        match file_get(&paths.secret_file_path(profile_id))? {
            Some(token) => Ok(Some(BridgeSecret {
                token,
                backend: SecretBackend::File,
            })),
            None => Ok(None),
        }
    }

    /// Returns the existing token, generating and persisting a new one when absent.
    pub fn get_or_create(&self, paths: &AppPaths, profile_id: &str) -> Result<BridgeSecret> {
        if let Some(secret) = self.get(paths, profile_id)? {
            return Ok(secret);
        }
        self.set(paths, profile_id, &generate_token())
    }

    pub fn set(&self, paths: &AppPaths, profile_id: &str, token: &str) -> Result<BridgeSecret> {
        if !self.prefer_file && (self.keychain.set)(profile_id, token).is_ok() {
            // Drop any stale fallback copy so the token only lives in one place.
            remove_file_if_exists(&paths.secret_file_path(profile_id))?;
            return Ok(BridgeSecret {
                token: token.to_string(),
                backend: SecretBackend::Keychain,
            });
        }
        file_set(&paths.secret_file_path(profile_id), token)?;
        Ok(BridgeSecret {
            token: token.to_string(),
            backend: SecretBackend::File,
        })
    }

    pub fn delete(&self, paths: &AppPaths, profile_id: &str) -> Result<()> {
        if !self.prefer_file {
            let _ = (self.keychain.delete)(profile_id);
        }
        remove_file_if_exists(&paths.secret_file_path(profile_id))
    }
}

fn entry_account(profile_id: &str) -> String {
    format!("{TOKEN_ENTRY_PREFIX}:{profile_id}")
}

fn keychain_get(profile_id: &str) -> Result<Option<String>> {
    let account = entry_account(profile_id);
    let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &account) else {
        return Ok(None);
    };
    match entry.get_password() {
        Ok(token) if !token.trim().is_empty() => Ok(Some(token)),
        _ => Ok(None),
    }
}

fn keychain_set(profile_id: &str, token: &str) -> Result<()> {
    let account = entry_account(profile_id);
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &account)
        .context("keychain is unavailable on this system")?;
    entry
        .set_password(token)
        .context("failed to store the bridge token in the keychain")
}

fn keychain_delete(profile_id: &str) -> Result<()> {
    let account = entry_account(profile_id);
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &account)
        .context("keychain is unavailable on this system")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("failed to remove the bridge token from the keychain"),
    }
}

fn file_get(path: &Path) -> Result<Option<String>> {
    let contents = match std::fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()))
        }
    };
    let file: SecretFile = serde_json::from_slice(&contents)
        .with_context(|| format!("invalid stored bridge secret at {}", path.display()))?;
    Ok(Some(file.bridge_auth_token).filter(|token| !token.trim().is_empty()))
}

fn file_set(path: &Path, token: &str) -> Result<()> {
    let contents = serde_json::to_vec_pretty(&SecretFile {
        bridge_auth_token: token.to_string(),
    })?;
    atomic_private_write(path, &contents)
}

fn generate_token() -> String {
    let mut bytes = [0u8; 24];
    fill_random(&mut bytes).expect("operating system random source is unavailable");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn file_store() -> SecretStore {
        SecretStore::file_backend_for_tests()
    }

    #[test]
    fn creates_then_reuses_a_token_for_a_profile() {
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = file_store();

        let created = store.get_or_create(&paths, "alpha-000000000001").unwrap();
        assert_eq!(created.backend, SecretBackend::File);
        assert_eq!(created.token.len(), 48);

        let reused = store.get_or_create(&paths, "alpha-000000000001").unwrap();
        assert_eq!(created.token, reused.token);
    }

    #[test]
    fn keeps_profile_tokens_isolated_and_deletable() {
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = file_store();

        let alpha = store.get_or_create(&paths, "alpha-000000000001").unwrap();
        let beta = store.get_or_create(&paths, "beta-000000000002").unwrap();
        assert_ne!(alpha.token, beta.token);

        store.delete(&paths, "alpha-000000000001").unwrap();
        assert!(store.get(&paths, "alpha-000000000001").unwrap().is_none());
        assert_eq!(
            store
                .get(&paths, "beta-000000000002")
                .unwrap()
                .unwrap()
                .token,
            beta.token
        );
    }

    #[test]
    fn stores_the_fallback_secret_with_owner_only_permissions() {
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        file_store()
            .get_or_create(&paths, "alpha-000000000001")
            .unwrap();

        let path = paths.secret_file_path("alpha-000000000001");
        assert!(path.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0);
        }
    }

    #[test]
    fn rejects_a_corrupt_secret_file() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("alpha.json");
        std::fs::write(&path, b"not json").unwrap();
        assert!(file_get(&path)
            .unwrap_err()
            .to_string()
            .contains("invalid stored bridge secret"));
    }

    #[test]
    fn treats_an_empty_stored_token_as_absent() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("alpha.json");
        file_set(&path, "   ").unwrap();
        assert_eq!(file_get(&path).unwrap(), None);

        file_set(&path, "real-token").unwrap();
        assert_eq!(file_get(&path).unwrap().as_deref(), Some("real-token"));
    }

    #[test]
    fn reports_a_missing_secret_file_as_absent() {
        let temp = tempdir().unwrap();
        assert_eq!(file_get(&temp.path().join("absent.json")).unwrap(), None);
    }

    #[test]
    fn chooses_the_backend_from_the_environment() {
        struct Guard;
        impl Drop for Guard {
            fn drop(&mut self) {
                std::env::remove_var("DAPPERCODE_SECRETS_BACKEND");
            }
        }
        let _guard = Guard;

        std::env::set_var("DAPPERCODE_SECRETS_BACKEND", " FILE ");
        assert!(SecretStore::discover().prefer_file);

        std::env::set_var("DAPPERCODE_SECRETS_BACKEND", "keychain");
        assert!(!SecretStore::discover().prefer_file);

        std::env::remove_var("DAPPERCODE_SECRETS_BACKEND");
        assert!(!SecretStore::discover().prefer_file);
    }

    #[test]
    fn names_backends_for_the_desktop_app() {
        assert_eq!(SecretBackend::Keychain.as_str(), "keychain");
        assert_eq!(SecretBackend::File.as_str(), "file");
    }

    #[test]
    fn prefers_the_keychain_and_clears_a_stale_fallback_file() {
        fn get(_profile_id: &str) -> Result<Option<String>> {
            Ok(Some("keychain-token".to_string()))
        }
        fn set(_profile_id: &str, _token: &str) -> Result<()> {
            Ok(())
        }
        fn delete(_profile_id: &str) -> Result<()> {
            Ok(())
        }

        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_keychain(Keychain { get, set, delete });

        // A leftover file from a run without a keychain must not survive a successful keychain write.
        file_set(&paths.secret_file_path("alpha-000000000001"), "stale").unwrap();
        let stored = store.set(&paths, "alpha-000000000001", "fresh").unwrap();

        assert_eq!(stored.backend, SecretBackend::Keychain);
        assert!(!paths.secret_file_path("alpha-000000000001").exists());

        let loaded = store.get(&paths, "alpha-000000000001").unwrap().unwrap();
        assert_eq!(loaded.backend, SecretBackend::Keychain);
        assert_eq!(loaded.token, "keychain-token");

        store.delete(&paths, "alpha-000000000001").unwrap();
    }

    #[test]
    fn falls_back_to_a_private_file_when_the_keychain_refuses() {
        fn get(_profile_id: &str) -> Result<Option<String>> {
            Ok(None)
        }
        fn set(_profile_id: &str, _token: &str) -> Result<()> {
            Err(anyhow::anyhow!("keychain is unavailable"))
        }
        fn delete(_profile_id: &str) -> Result<()> {
            Err(anyhow::anyhow!("keychain is unavailable"))
        }

        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_keychain(Keychain { get, set, delete });

        let created = store.get_or_create(&paths, "alpha-000000000001").unwrap();
        assert_eq!(created.backend, SecretBackend::File);
        assert!(paths.secret_file_path("alpha-000000000001").is_file());

        let reloaded = store.get(&paths, "alpha-000000000001").unwrap().unwrap();
        assert_eq!(reloaded.token, created.token);
        assert_eq!(reloaded.backend, SecretBackend::File);

        // A failing keychain delete must still clear the fallback copy.
        store.delete(&paths, "alpha-000000000001").unwrap();
        assert!(!paths.secret_file_path("alpha-000000000001").exists());
        assert!(store.get(&paths, "alpha-000000000001").unwrap().is_none());
    }

    #[test]
    fn surfaces_a_keychain_read_failure_instead_of_inventing_a_token() {
        fn get(_profile_id: &str) -> Result<Option<String>> {
            Err(anyhow::anyhow!("keychain read failed"))
        }
        fn set(_profile_id: &str, _token: &str) -> Result<()> {
            Ok(())
        }
        fn delete(_profile_id: &str) -> Result<()> {
            Ok(())
        }

        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_keychain(Keychain { get, set, delete });

        assert!(store
            .get(&paths, "alpha-000000000001")
            .unwrap_err()
            .to_string()
            .contains("keychain read failed"));
    }

    #[test]
    fn reading_an_unknown_keychain_entry_reports_no_secret() {
        // Reading a non-existent item never prompts, so this is safe to exercise directly.
        let profile_id = format!("dappercode-test-absent-{}", std::process::id());
        assert_eq!(keychain_get(&profile_id).unwrap(), None);
        assert!(entry_account(&profile_id).starts_with("bridge-auth-token:"));
    }

    #[test]
    fn deleting_an_absent_secret_is_a_no_op() {
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = file_store();

        store.delete(&paths, "alpha-000000000001").unwrap();
        assert!(store.get(&paths, "alpha-000000000001").unwrap().is_none());
    }

    #[test]
    fn overwrites_an_existing_token_when_one_is_supplied() {
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = file_store();

        let first = store.get_or_create(&paths, "alpha-000000000001").unwrap();
        let replaced = store
            .set(&paths, "alpha-000000000001", "explicit-token")
            .unwrap();

        assert_ne!(first.token, replaced.token);
        assert_eq!(replaced.token, "explicit-token");
        assert_eq!(replaced.backend, SecretBackend::File);
        assert_eq!(
            store
                .get(&paths, "alpha-000000000001")
                .unwrap()
                .unwrap()
                .token,
            "explicit-token"
        );
    }
}
