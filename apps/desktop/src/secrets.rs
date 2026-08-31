use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};

use anyhow::{bail, Context, Result};
use getrandom::fill as fill_random;
use serde::{Deserialize, Serialize};

use crate::{
    platform::{self, CredentialLayout},
    store::{atomic_private_write, remove_file_if_exists, AppPaths, FileLease},
};

const KEYCHAIN_SERVICE: &str = "dev.dappercode.desktop";
const LEGACY_TOKEN_ENTRY_PREFIX: &str = "bridge-auth-token";
pub(crate) const VAULT_ENTRY_ACCOUNT: &str = "bridge-auth-vault:v1";
pub(crate) const VAULT_VERSION: u32 = 1;
const MAX_VAULT_BYTES: usize = 1024 * 1024;
const MAX_VAULT_PROFILES: usize = 5_000;
pub(crate) const MAX_TOKEN_BYTES: usize = 4096;

/// Where a profile's bridge token is actually stored.
///
/// macOS keeps all profile tokens in one keychain vault, so a rebuilt ad-hoc app requests access to
/// one item rather than prompting once per workspace. Windows uses one bounded Credential Manager
/// item per profile because Generic Credential blobs are limited to 2560 bytes. The file backend
/// exists so that headless environments (CI, Linux without a secret service) and the test suite keep
/// working without silently dropping the secret or prompting for a login keychain that does not
/// exist.
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

#[cfg(test)]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretFile {
    bridge_auth_token: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SecretVault {
    pub(crate) version: u32,
    pub(crate) bridge_auth_tokens: BTreeMap<String, String>,
}

impl Default for SecretVault {
    fn default() -> Self {
        Self {
            version: VAULT_VERSION,
            bridge_auth_tokens: BTreeMap::new(),
        }
    }
}

impl SecretVault {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.version != VAULT_VERSION {
            bail!(
                "unsupported bridge credential vault version {}",
                self.version
            );
        }
        if self.bridge_auth_tokens.len() > MAX_VAULT_PROFILES {
            bail!("bridge credential vault exceeds its profile limit");
        }
        for (profile_id, token) in &self.bridge_auth_tokens {
            if profile_id.trim().is_empty()
                || profile_id.len() > MAX_TOKEN_BYTES
                || token.trim().is_empty()
                || token.len() > MAX_TOKEN_BYTES
            {
                bail!("bridge credential vault contains an invalid profile credential");
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
struct VaultState {
    vault: SecretVault,
    backend: SecretBackend,
}

/// Indirection over the OS keychain so the fallback logic can be exercised without touching a real
/// login keychain during tests.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Keychain {
    pub(crate) get: fn(&str) -> Result<Option<String>>,
    pub(crate) set: fn(&str, &str) -> Result<()>,
    pub(crate) delete: fn(&str) -> Result<()>,
}

impl Keychain {
    const SYSTEM: Self = Self {
        get: keychain_get,
        set: keychain_set,
        delete: keychain_delete,
    };
}

#[derive(Clone)]
pub struct SecretStore {
    prefer_file: bool,
    pub(crate) keychain: Keychain,
    credential_layout: CredentialLayout,
    vault_cache: Arc<Mutex<Option<VaultState>>>,
}

impl std::fmt::Debug for SecretStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut debug = formatter.debug_struct("SecretStore");
        debug
            .field("prefer_file", &self.prefer_file)
            .field("keychain", &self.keychain)
            .field("credential_layout", &self.credential_layout)
            .field(
                "vault_cached",
                &self
                    .vault_cache
                    .lock()
                    .expect("bridge credential vault cache poisoned")
                    .is_some(),
            )
            .finish()
    }
}

impl SecretStore {
    pub fn discover() -> Self {
        let prefer_file = std::env::var("DAPPERCODE_SECRETS_BACKEND")
            .map(|value| value.trim().eq_ignore_ascii_case("file"))
            .unwrap_or(false);
        Self {
            prefer_file,
            keychain: Keychain::SYSTEM,
            credential_layout: platform::credential_layout(),
            vault_cache: Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(test)]
    pub fn file_backend_for_tests() -> Self {
        Self {
            prefer_file: true,
            keychain: Keychain::SYSTEM,
            credential_layout: platform::credential_layout(),
            vault_cache: Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(test)]
    fn with_keychain(keychain: Keychain) -> Self {
        Self {
            prefer_file: false,
            keychain,
            credential_layout: CredentialLayout::SharedVault,
            vault_cache: Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(test)]
    fn with_windows_keychain(keychain: Keychain) -> Self {
        Self {
            prefer_file: false,
            keychain,
            credential_layout: CredentialLayout::WindowsPerProfile,
            vault_cache: Arc::new(Mutex::new(None)),
        }
    }

    fn effective_credential_layout(&self) -> CredentialLayout {
        if self.prefer_file {
            CredentialLayout::SharedVault
        } else {
            self.credential_layout
        }
    }

    fn load_vault(&self, paths: &AppPaths) -> Result<Option<VaultState>> {
        if let Some(cached) = self
            .vault_cache
            .lock()
            .expect("bridge credential vault cache poisoned")
            .clone()
        {
            return Ok(Some(cached));
        }
        self.load_vault_fresh(paths)
    }

    fn load_vault_fresh(&self, paths: &AppPaths) -> Result<Option<VaultState>> {
        if !self.prefer_file {
            if let Some(contents) = (self.keychain.get)(VAULT_ENTRY_ACCOUNT)? {
                let vault = parse_vault(&contents, "keychain")?;
                let state = VaultState {
                    vault,
                    backend: SecretBackend::Keychain,
                };
                *self
                    .vault_cache
                    .lock()
                    .expect("bridge credential vault cache poisoned") = Some(state.clone());
                return Ok(Some(state));
            }
        }
        let state = match vault_file_get(&paths.secret_vault_file_path())? {
            Some(vault) => {
                let state = VaultState {
                    vault,
                    backend: SecretBackend::File,
                };
                *self
                    .vault_cache
                    .lock()
                    .expect("bridge credential vault cache poisoned") = Some(state.clone());
                Some(state)
            }
            None => None,
        };
        if state.is_none() {
            self.clear_vault_cache();
        }
        Ok(state)
    }

    fn persist_vault(
        &self,
        paths: &AppPaths,
        vault: SecretVault,
        previous_backend: Option<SecretBackend>,
    ) -> Result<SecretBackend> {
        vault.validate()?;
        let contents = serde_json::to_string(&vault)?;
        if contents.len() > MAX_VAULT_BYTES {
            bail!("bridge credential vault exceeds its byte limit");
        }
        let backend = if !self.prefer_file {
            match (self.keychain.set)(VAULT_ENTRY_ACCOUNT, &contents) {
                Ok(()) => {
                    remove_file_if_exists(&paths.secret_vault_file_path())?;
                    SecretBackend::Keychain
                }
                Err(error) if previous_backend == Some(SecretBackend::Keychain) => {
                    return Err(error).context("failed to update the bridge credential vault");
                }
                Err(_) => {
                    vault_file_set(&paths.secret_vault_file_path(), &vault)?;
                    SecretBackend::File
                }
            }
        } else {
            vault_file_set(&paths.secret_vault_file_path(), &vault)?;
            SecretBackend::File
        };
        self.set_vault_cache(vault, backend);
        Ok(backend)
    }

    pub(crate) fn clear_vault_cache(&self) {
        *self
            .vault_cache
            .lock()
            .expect("bridge credential vault cache poisoned") = None;
    }

    pub(crate) fn set_vault_cache(&self, vault: SecretVault, backend: SecretBackend) {
        *self
            .vault_cache
            .lock()
            .expect("bridge credential vault cache poisoned") = Some(VaultState { vault, backend });
    }
}

impl SecretStore {
    /// Returns a profile token already stored in the shared vault without touching legacy items.
    pub fn get_vault(&self, paths: &AppPaths, profile_id: &str) -> Result<Option<BridgeSecret>> {
        platform::secret_get_vault(self.effective_credential_layout(), self, paths, profile_id)
    }

    pub(crate) fn get_shared_vault(
        &self,
        paths: &AppPaths,
        profile_id: &str,
    ) -> Result<Option<BridgeSecret>> {
        let Some(state) = self.load_vault(paths)? else {
            return Ok(None);
        };
        Ok(state
            .vault
            .bridge_auth_tokens
            .get(profile_id)
            .cloned()
            .map(|token| BridgeSecret {
                token,
                backend: state.backend,
            }))
    }

    /// Returns a profile token from the shared vault.
    pub fn get(&self, paths: &AppPaths, profile_id: &str) -> Result<Option<BridgeSecret>> {
        self.get_vault(paths, profile_id)
    }

    /// Returns the existing token, generating and persisting a new one when absent.
    #[cfg(test)]
    pub fn get_or_create(&self, paths: &AppPaths, profile_id: &str) -> Result<BridgeSecret> {
        self.get_or_create_with_status(paths, profile_id)
            .map(|(secret, _)| secret)
    }

    pub fn get_or_create_with_status(
        &self,
        paths: &AppPaths,
        profile_id: &str,
    ) -> Result<(BridgeSecret, bool)> {
        platform::secret_get_or_create(self.effective_credential_layout(), self, paths, profile_id)
    }

    pub(crate) fn get_or_create_shared(
        &self,
        paths: &AppPaths,
        profile_id: &str,
    ) -> Result<(BridgeSecret, bool)> {
        let _lease = FileLease::acquire(&paths.secret_vault_lock_path())?;
        let existing = self.load_vault_fresh(paths)?;
        if let Some(state) = &existing {
            if let Some(token) = state.vault.bridge_auth_tokens.get(profile_id) {
                return Ok((
                    BridgeSecret {
                        token: token.clone(),
                        backend: state.backend,
                    },
                    false,
                ));
            }
        }
        let previous_backend = existing.as_ref().map(|state| state.backend);
        let mut vault = existing.map(|state| state.vault).unwrap_or_default();
        let token = generate_token();
        vault
            .bridge_auth_tokens
            .insert(profile_id.to_string(), token.clone());
        let backend = self.persist_vault(paths, vault, previous_backend)?;
        Ok((BridgeSecret { token, backend }, true))
    }

    pub fn ensure_profiles(
        &self,
        paths: &AppPaths,
        profile_ids: &[String],
    ) -> Result<Option<SecretBackend>> {
        platform::secret_ensure_profiles(
            self.effective_credential_layout(),
            self,
            paths,
            profile_ids,
        )
    }

    pub(crate) fn ensure_shared_profiles(
        &self,
        paths: &AppPaths,
        profile_ids: &[String],
    ) -> Result<Option<SecretBackend>> {
        if profile_ids.is_empty() {
            return Ok(None);
        }
        let _lease = FileLease::acquire(&paths.secret_vault_lock_path())?;
        let existing = self.load_vault_fresh(paths)?;
        let previous_backend = existing.as_ref().map(|state| state.backend);
        let mut vault = existing.map(|state| state.vault).unwrap_or_default();
        let mut changed = previous_backend.is_none();
        for profile_id in profile_ids {
            if !vault.bridge_auth_tokens.contains_key(profile_id) {
                vault
                    .bridge_auth_tokens
                    .insert(profile_id.clone(), generate_token());
                changed = true;
            }
        }
        let backend = if changed {
            self.persist_vault(paths, vault, previous_backend)?
        } else {
            previous_backend.expect("unchanged credential vault has a backend")
        };
        Ok(Some(backend))
    }

    pub fn refresh(&self, paths: &AppPaths) -> Result<()> {
        platform::secret_refresh(self.effective_credential_layout(), self, paths)
    }

    pub(crate) fn refresh_shared(&self, paths: &AppPaths) -> Result<()> {
        self.load_vault_fresh(paths).map(|_| ())
    }

    #[cfg(test)]
    pub fn set(&self, paths: &AppPaths, profile_id: &str, token: &str) -> Result<BridgeSecret> {
        platform::secret_set(
            self.effective_credential_layout(),
            self,
            paths,
            profile_id,
            token,
        )
    }

    #[cfg(test)]
    pub(crate) fn set_shared(
        &self,
        paths: &AppPaths,
        profile_id: &str,
        token: &str,
    ) -> Result<BridgeSecret> {
        if profile_id.trim().is_empty()
            || profile_id.len() > MAX_TOKEN_BYTES
            || token.trim().is_empty()
            || token.len() > MAX_TOKEN_BYTES
        {
            bail!("profile credential is invalid");
        }
        let _lease = FileLease::acquire(&paths.secret_vault_lock_path())?;
        let existing = self.load_vault_fresh(paths)?;
        let previous_backend = existing.as_ref().map(|state| state.backend);
        let mut vault = existing.map(|state| state.vault).unwrap_or_default();
        vault
            .bridge_auth_tokens
            .insert(profile_id.to_string(), token.to_string());
        let backend = self.persist_vault(paths, vault, previous_backend)?;
        Ok(BridgeSecret {
            token: token.to_string(),
            backend,
        })
    }

    pub fn delete(&self, paths: &AppPaths, profile_id: &str) -> Result<()> {
        platform::secret_delete(self.effective_credential_layout(), self, paths, profile_id)
    }

    pub(crate) fn delete_shared(&self, paths: &AppPaths, profile_id: &str) -> Result<()> {
        let _lease = FileLease::acquire(&paths.secret_vault_lock_path())?;
        if let Some(state) = self.load_vault_fresh(paths)? {
            let mut vault = state.vault;
            if vault.bridge_auth_tokens.remove(profile_id).is_some() {
                self.persist_vault(paths, vault, Some(state.backend))?;
            }
        }
        if !self.prefer_file {
            let _ = (self.keychain.delete)(&legacy_entry_account(profile_id));
        }
        remove_file_if_exists(&paths.secret_file_path(profile_id))
    }
}

pub(crate) fn legacy_entry_account(profile_id: &str) -> String {
    format!("{LEGACY_TOKEN_ENTRY_PREFIX}:{profile_id}")
}

fn keychain_get(account: &str) -> Result<Option<String>> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .context("keychain is unavailable on this system")?;
    match entry.get_password() {
        Ok(token) if !token.trim().is_empty() => Ok(Some(token)),
        Ok(_) => bail!("stored bridge credential vault is empty"),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error).context("failed to read the bridge credential vault"),
    }
}

fn keychain_set(account: &str, token: &str) -> Result<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .context("keychain is unavailable on this system")?;
    entry
        .set_password(token)
        .context("failed to store the bridge token in the keychain")
}

fn keychain_delete(account: &str) -> Result<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .context("keychain is unavailable on this system")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("failed to remove the bridge token from the keychain"),
    }
}

#[cfg(test)]
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

#[cfg(test)]
fn file_set(path: &Path, token: &str) -> Result<()> {
    let contents = serde_json::to_vec_pretty(&SecretFile {
        bridge_auth_token: token.to_string(),
    })?;
    atomic_private_write(path, &contents)
}

pub(crate) fn parse_vault(contents: &str, source: &str) -> Result<SecretVault> {
    if contents.len() > MAX_VAULT_BYTES {
        bail!("stored bridge credential vault in {source} exceeds its byte limit");
    }
    let vault: SecretVault = serde_json::from_str(contents)
        .with_context(|| format!("invalid stored bridge credential vault in {source}"))?;
    vault.validate()?;
    Ok(vault)
}

pub(crate) fn vault_file_get(path: &Path) -> Result<Option<SecretVault>> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()))
        }
    };
    parse_vault(&contents, &path.display().to_string()).map(Some)
}

pub(crate) fn vault_file_set(path: &Path, vault: &SecretVault) -> Result<()> {
    vault.validate()?;
    let contents = serde_json::to_vec_pretty(vault)?;
    if contents.len() > MAX_VAULT_BYTES {
        bail!("bridge credential vault exceeds its byte limit");
    }
    atomic_private_write(path, &contents)
}

pub(crate) fn generate_token() -> String {
    let mut bytes = [0u8; 24];
    fill_random(&mut bytes).expect("operating system random source is unavailable");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::platform::windows_credentials::{
        validate_windows_token, windows_profile_entry_account, MAX_WINDOWS_CREDENTIAL_UTF16_UNITS,
        WINDOWS_LAYOUT_ENTRY_ACCOUNT, WINDOWS_LAYOUT_MARKER, WINDOWS_TOKEN_ENTRY_PREFIX,
    };
    use std::collections::BTreeSet;
    use tempfile::tempdir;

    static MEMORY_KEYCHAIN: std::sync::LazyLock<std::sync::Mutex<BTreeMap<String, String>>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(BTreeMap::new()));

    #[derive(Default)]
    struct WindowsMemoryKeychain {
        entries: BTreeMap<String, String>,
        fail_sets: BTreeSet<String>,
        fail_deletes: BTreeSet<String>,
        reject_all_sets: bool,
        max_password_bytes: Option<usize>,
    }

    static WINDOWS_MEMORY_KEYCHAIN: std::sync::LazyLock<std::sync::Mutex<WindowsMemoryKeychain>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(WindowsMemoryKeychain::default()));
    static WINDOWS_MEMORY_KEYCHAIN_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn memory_keychain_get(account: &str) -> Result<Option<String>> {
        Ok(MEMORY_KEYCHAIN.lock().unwrap().get(account).cloned())
    }

    fn memory_keychain_set(account: &str, contents: &str) -> Result<()> {
        MEMORY_KEYCHAIN
            .lock()
            .unwrap()
            .insert(account.to_string(), contents.to_string());
        Ok(())
    }

    fn memory_keychain_delete(account: &str) -> Result<()> {
        MEMORY_KEYCHAIN.lock().unwrap().remove(account);
        Ok(())
    }

    fn memory_keychain() -> Keychain {
        Keychain {
            get: memory_keychain_get,
            set: memory_keychain_set,
            delete: memory_keychain_delete,
        }
    }

    fn windows_memory_keychain_get(account: &str) -> Result<Option<String>> {
        Ok(WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entries
            .get(account)
            .cloned())
    }

    fn windows_memory_keychain_set(account: &str, contents: &str) -> Result<()> {
        let mut keychain = WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if keychain.reject_all_sets || keychain.fail_sets.contains(account) {
            bail!("simulated Windows Credential Manager write failure");
        }
        let encoded_bytes = contents.encode_utf16().count() * 2;
        if keychain
            .max_password_bytes
            .is_some_and(|limit| encoded_bytes > limit)
        {
            bail!("simulated Windows Generic Credential blob limit");
        }
        keychain
            .entries
            .insert(account.to_string(), contents.to_string());
        Ok(())
    }

    fn windows_memory_keychain_delete(account: &str) -> Result<()> {
        let mut keychain = WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if keychain.fail_deletes.contains(account) {
            bail!("simulated Windows Credential Manager delete failure");
        }
        keychain.entries.remove(account);
        Ok(())
    }

    fn windows_memory_keychain() -> Keychain {
        Keychain {
            get: windows_memory_keychain_get,
            set: windows_memory_keychain_set,
            delete: windows_memory_keychain_delete,
        }
    }

    fn reset_windows_memory_keychain() {
        *WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = WindowsMemoryKeychain {
            max_password_bytes: Some(2560),
            ..WindowsMemoryKeychain::default()
        };
    }

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

        let (_, newly_created) = store
            .get_or_create_with_status(&paths, "beta-000000000002")
            .unwrap();
        let (_, already_existed) = store
            .get_or_create_with_status(&paths, "beta-000000000002")
            .unwrap();
        assert!(newly_created);
        assert!(!already_existed);
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
    fn uses_one_keychain_vault_for_every_workspace() {
        static GETS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        static SETS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        fn get(account: &str) -> Result<Option<String>> {
            assert_eq!(account, VAULT_ENTRY_ACCOUNT);
            GETS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(None)
        }
        fn set(account: &str, contents: &str) -> Result<()> {
            assert_eq!(account, VAULT_ENTRY_ACCOUNT);
            assert_eq!(
                parse_vault(contents, "test keychain")?
                    .bridge_auth_tokens
                    .len(),
                500
            );
            SETS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
        fn delete(_account: &str) -> Result<()> {
            Ok(())
        }

        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_keychain(Keychain { get, set, delete });
        GETS.store(0, std::sync::atomic::Ordering::SeqCst);
        SETS.store(0, std::sync::atomic::Ordering::SeqCst);
        let profile_ids = (0..500)
            .map(|index| format!("profile-{index:03}"))
            .collect::<Vec<_>>();

        assert_eq!(
            store.ensure_profiles(&paths, &profile_ids).unwrap(),
            Some(SecretBackend::Keychain)
        );
        assert_eq!(GETS.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(SETS.load(std::sync::atomic::Ordering::SeqCst), 1);
        let alpha = store.get(&paths, &profile_ids[0]).unwrap().unwrap();
        let beta = store.get(&paths, &profile_ids[1]).unwrap().unwrap();
        assert_ne!(alpha.token, beta.token);
        assert_eq!(alpha.backend, SecretBackend::Keychain);
        assert_eq!(beta.backend, SecretBackend::Keychain);
        assert_eq!(GETS.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(SETS.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn windows_uses_bounded_credentials_for_many_profiles() {
        let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_windows_memory_keychain();
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_windows_keychain(windows_memory_keychain());
        let profile_ids = (0..500)
            .map(|index| format!("windows-profile-{index:03}"))
            .collect::<Vec<_>>();

        assert_eq!(
            store.ensure_profiles(&paths, &profile_ids).unwrap(),
            Some(SecretBackend::Keychain)
        );

        let keychain = WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(
            keychain.entries.get(WINDOWS_LAYOUT_ENTRY_ACCOUNT),
            Some(&WINDOWS_LAYOUT_MARKER.to_string())
        );
        assert!(!keychain.entries.contains_key(VAULT_ENTRY_ACCOUNT));
        let profile_entries = keychain
            .entries
            .iter()
            .filter(|(account, _)| account.starts_with(WINDOWS_TOKEN_ENTRY_PREFIX))
            .collect::<Vec<_>>();
        assert_eq!(profile_entries.len(), profile_ids.len());
        assert!(profile_entries
            .iter()
            .all(|(_, token)| token.encode_utf16().count() * 2 <= 2560));
        drop(keychain);

        for profile_id in [&profile_ids[0], &profile_ids[499]] {
            let secret = store.get(&paths, profile_id).unwrap().unwrap();
            assert_eq!(secret.backend, SecretBackend::Keychain);
            assert_eq!(secret.backend.as_str(), "keychain");
            assert_eq!(secret.token.len(), 48);
        }
        assert!(!paths.secret_vault_file_path().exists());
    }

    #[test]
    fn windows_rejects_tokens_that_exceed_credential_manager_capacity() {
        assert!(
            validate_windows_token(&"x".repeat(MAX_WINDOWS_CREDENTIAL_UTF16_UNITS + 1))
                .unwrap_err()
                .to_string()
                .contains("Credential Manager size limit")
        );
    }

    #[test]
    fn windows_validates_layout_profiles_and_tokens() {
        let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_windows_memory_keychain();
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_windows_keychain(windows_memory_keychain());

        assert!(store.get(&paths, "").is_err());
        assert!(store.get(&paths, &"p".repeat(MAX_TOKEN_BYTES + 1)).is_err());
        assert!(store.set(&paths, "alpha", " ").is_err());
        assert!(store
            .set(&paths, "alpha", &"x".repeat(MAX_TOKEN_BYTES + 1))
            .is_err());
        assert_eq!(store.ensure_profiles(&paths, &[]).unwrap(), None);
        store.refresh(&paths).unwrap();

        {
            let mut keychain = WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            keychain.entries.insert(
                VAULT_ENTRY_ACCOUNT.to_string(),
                serde_json::to_string(&SecretVault::default()).unwrap(),
            );
        }
        store.refresh(&paths).unwrap();
        let mut keychain = WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        keychain.entries.remove(VAULT_ENTRY_ACCOUNT);
        keychain.entries.insert(
            WINDOWS_LAYOUT_ENTRY_ACCOUNT.to_string(),
            "unsupported-layout".to_string(),
        );
        drop(keychain);
        assert!(store
            .get(&paths, "alpha")
            .unwrap_err()
            .to_string()
            .contains("unsupported Windows bridge credential layout marker"));
    }

    #[test]
    fn windows_reuses_existing_entries_and_detects_legacy_conflicts() {
        let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_windows_memory_keychain();
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_windows_keychain(windows_memory_keychain());
        let alpha_account = windows_profile_entry_account("alpha");
        {
            let mut keychain = WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            keychain
                .entries
                .insert(alpha_account.clone(), "alpha-token".to_string());
        }

        let (alpha, created) = store.get_or_create_with_status(&paths, "alpha").unwrap();
        assert!(!created);
        assert_eq!(alpha.token, "alpha-token");
        assert_eq!(
            store
                .ensure_profiles(&paths, &["alpha".to_string(), "beta".to_string()])
                .unwrap(),
            Some(SecretBackend::Keychain)
        );
        assert!(store.get(&paths, "beta").unwrap().is_some());

        {
            let mut keychain = WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            keychain.entries.remove(WINDOWS_LAYOUT_ENTRY_ACCOUNT);
            let mut legacy = SecretVault::default();
            legacy
                .bridge_auth_tokens
                .insert("alpha".to_string(), "different-token".to_string());
            keychain.entries.insert(
                VAULT_ENTRY_ACCOUNT.to_string(),
                serde_json::to_string(&legacy).unwrap(),
            );
        }
        assert!(store
            .get(&paths, "alpha")
            .unwrap_err()
            .to_string()
            .contains("conflicting Windows bridge credentials"));
        assert!(store.get(&paths, "missing").unwrap().is_none());
    }

    #[test]
    fn windows_reuses_and_deletes_file_fallback_entries() {
        let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_windows_memory_keychain();
        WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reject_all_sets = true;
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_windows_keychain(windows_memory_keychain());

        let (alpha, created) = store.get_or_create_with_status(&paths, "alpha").unwrap();
        assert!(created);
        assert_eq!(alpha.backend, SecretBackend::File);
        let (reused, created) = store.get_or_create_with_status(&paths, "alpha").unwrap();
        assert!(!created);
        assert_eq!(reused.token, alpha.token);
        assert_eq!(
            store.get(&paths, "alpha").unwrap().unwrap().backend,
            SecretBackend::File
        );
        store.get_or_create_with_status(&paths, "beta").unwrap();
        assert_eq!(
            store
                .ensure_profiles(&paths, &["alpha".to_string(), "gamma".to_string()])
                .unwrap(),
            Some(SecretBackend::File)
        );

        store.delete(&paths, "missing").unwrap();
        store.delete(&paths, "alpha").unwrap();
        assert!(store.get(&paths, "alpha").unwrap().is_none());
        assert!(store.get(&paths, "beta").unwrap().is_some());
    }

    #[test]
    fn windows_rejects_conflicting_legacy_and_file_migrations() {
        let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_windows_memory_keychain();
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_windows_keychain(windows_memory_keychain());
        let mut legacy = SecretVault::default();
        legacy
            .bridge_auth_tokens
            .insert("alpha".to_string(), "legacy-token".to_string());
        {
            let mut keychain = WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            keychain.entries.insert(
                windows_profile_entry_account("alpha"),
                "direct-token".to_string(),
            );
            keychain.entries.insert(
                VAULT_ENTRY_ACCOUNT.to_string(),
                serde_json::to_string(&legacy).unwrap(),
            );
        }
        assert!(store
            .ensure_profiles(&paths, &["alpha".to_string()])
            .unwrap_err()
            .to_string()
            .contains("conflicting Windows bridge credentials"));

        WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entries
            .remove(VAULT_ENTRY_ACCOUNT);
        vault_file_set(&paths.secret_vault_file_path(), &legacy).unwrap();
        assert!(store
            .ensure_profiles(&paths, &["alpha".to_string()])
            .unwrap_err()
            .to_string()
            .contains("conflicting file and Windows credentials"));
        assert!(store
            .get(&paths, "alpha")
            .unwrap_err()
            .to_string()
            .contains("conflicting file and Windows credentials"));
    }

    #[test]
    fn windows_file_migration_fails_closed_after_existing_credentials() {
        let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_windows_memory_keychain();
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_windows_keychain(windows_memory_keychain());
        let mut vault = SecretVault::default();
        vault
            .bridge_auth_tokens
            .insert("alpha".to_string(), "alpha-token".to_string());
        vault
            .bridge_auth_tokens
            .insert("beta".to_string(), "beta-token".to_string());
        vault_file_set(&paths.secret_vault_file_path(), &vault).unwrap();
        {
            let mut keychain = WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            keychain.entries.insert(
                windows_profile_entry_account("alpha"),
                "alpha-token".to_string(),
            );
            keychain
                .fail_sets
                .insert(windows_profile_entry_account("beta"));
        }

        assert!(store
            .ensure_profiles(&paths, &["alpha".to_string(), "beta".to_string()])
            .unwrap_err()
            .to_string()
            .contains("after Windows credentials existed"));
    }

    #[test]
    fn windows_covers_existing_and_duplicate_profile_extension_paths() {
        let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_windows_memory_keychain();
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_windows_keychain(windows_memory_keychain());
        {
            let mut keychain = WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            keychain.entries.insert(
                windows_profile_entry_account("alpha"),
                "alpha-token".to_string(),
            );
        }

        assert_eq!(
            store
                .ensure_profiles(&paths, &["alpha".to_string(), "beta".to_string()])
                .unwrap(),
            Some(SecretBackend::Keychain)
        );
        let (_, created) = store.get_or_create_with_status(&paths, "alpha").unwrap();
        assert!(!created);
        let (_, created) = store.get_or_create_with_status(&paths, "alpha").unwrap();
        assert!(!created);
        store.refresh(&paths).unwrap();

        reset_windows_memory_keychain();
        assert_eq!(
            store
                .ensure_profiles(&paths, &["duplicate".to_string(), "duplicate".to_string()])
                .unwrap(),
            Some(SecretBackend::Keychain)
        );
    }

    #[test]
    fn windows_extending_existing_entries_fails_closed() {
        let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_windows_memory_keychain();
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_windows_keychain(windows_memory_keychain());
        {
            let mut keychain = WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            keychain.entries.insert(
                windows_profile_entry_account("alpha"),
                "alpha-token".to_string(),
            );
            keychain
                .fail_sets
                .insert(windows_profile_entry_account("beta"));
        }

        assert!(store
            .ensure_profiles(&paths, &["alpha".to_string(), "beta".to_string()])
            .unwrap_err()
            .to_string()
            .contains("failed to extend an existing Windows"));
        assert!(!paths.secret_vault_file_path().exists());
    }

    #[test]
    fn windows_delete_cleans_legacy_file_and_direct_entries() {
        let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_windows_memory_keychain();
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_windows_keychain(windows_memory_keychain());
        let mut legacy = SecretVault::default();
        legacy
            .bridge_auth_tokens
            .insert("alpha".to_string(), "alpha-token".to_string());
        legacy
            .bridge_auth_tokens
            .insert("beta".to_string(), "beta-token".to_string());
        let mut fallback = SecretVault::default();
        fallback
            .bridge_auth_tokens
            .insert("alpha".to_string(), "alpha-token".to_string());
        {
            let mut keychain = WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            keychain.entries.insert(
                WINDOWS_LAYOUT_ENTRY_ACCOUNT.to_string(),
                WINDOWS_LAYOUT_MARKER.to_string(),
            );
            keychain.entries.insert(
                VAULT_ENTRY_ACCOUNT.to_string(),
                serde_json::to_string(&legacy).unwrap(),
            );
            keychain.entries.insert(
                windows_profile_entry_account("alpha"),
                "alpha-token".to_string(),
            );
        }
        vault_file_set(&paths.secret_vault_file_path(), &fallback).unwrap();

        store.delete(&paths, "missing").unwrap();
        store.delete(&paths, "alpha").unwrap();
        let keychain = WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(!keychain
            .entries
            .contains_key(&windows_profile_entry_account("alpha")));
        let remaining = parse_vault(
            keychain.entries.get(VAULT_ENTRY_ACCOUNT).unwrap(),
            "test keychain",
        )
        .unwrap();
        assert!(remaining.bridge_auth_tokens.contains_key("beta"));
        drop(keychain);

        remove_file_if_exists(&paths.secret_vault_file_path()).unwrap();
        reset_windows_memory_keychain();
        WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entries
            .insert(
                windows_profile_entry_account("alpha"),
                "alpha-token".to_string(),
            );
        store.delete(&paths, "alpha").unwrap();
        assert!(store.get(&paths, "alpha").unwrap().is_none());
    }

    #[test]
    fn windows_migrates_a_shared_vault_without_losing_partial_progress() {
        let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_windows_memory_keychain();
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_windows_keychain(windows_memory_keychain());
        let mut legacy_vault = SecretVault::default();
        for (profile_id, token) in [
            ("alpha", "alpha-token"),
            ("beta", "beta-token"),
            ("gamma", "gamma-token"),
        ] {
            legacy_vault
                .bridge_auth_tokens
                .insert(profile_id.to_string(), token.to_string());
        }
        {
            let mut keychain = WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            keychain.entries.insert(
                VAULT_ENTRY_ACCOUNT.to_string(),
                serde_json::to_string(&legacy_vault).unwrap(),
            );
            keychain
                .fail_sets
                .insert(windows_profile_entry_account("beta"));
        }

        let error = store
            .ensure_profiles(
                &paths,
                &["alpha".to_string(), "beta".to_string(), "gamma".to_string()],
            )
            .unwrap_err();
        assert!(error.to_string().contains("failed to migrate"));
        {
            let keychain = WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(keychain.entries.contains_key(VAULT_ENTRY_ACCOUNT));
            assert!(!keychain.entries.contains_key(WINDOWS_LAYOUT_ENTRY_ACCOUNT));
            assert_eq!(
                keychain
                    .entries
                    .get(&windows_profile_entry_account("alpha"))
                    .map(String::as_str),
                Some("alpha-token")
            );
        }
        assert_eq!(
            store.get(&paths, "beta").unwrap().unwrap().token,
            "beta-token"
        );

        WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .fail_sets
            .clear();
        assert_eq!(
            store
                .ensure_profiles(
                    &paths,
                    &["alpha".to_string(), "beta".to_string(), "gamma".to_string()],
                )
                .unwrap(),
            Some(SecretBackend::Keychain)
        );
        let keychain = WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(!keychain.entries.contains_key(VAULT_ENTRY_ACCOUNT));
        assert_eq!(
            keychain.entries.get(WINDOWS_LAYOUT_ENTRY_ACCOUNT),
            Some(&WINDOWS_LAYOUT_MARKER.to_string())
        );
        for (profile_id, token) in [
            ("alpha", "alpha-token"),
            ("beta", "beta-token"),
            ("gamma", "gamma-token"),
        ] {
            assert_eq!(
                keychain
                    .entries
                    .get(&windows_profile_entry_account(profile_id))
                    .map(String::as_str),
                Some(token)
            );
        }
    }

    #[test]
    fn windows_file_fallback_migrates_when_credential_manager_recovers() {
        let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_windows_memory_keychain();
        WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reject_all_sets = true;
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_windows_keychain(windows_memory_keychain());
        let profile_ids = (0..100)
            .map(|index| format!("fallback-profile-{index:03}"))
            .collect::<Vec<_>>();

        assert_eq!(
            store.ensure_profiles(&paths, &profile_ids).unwrap(),
            Some(SecretBackend::File)
        );
        assert!(paths.secret_vault_file_path().is_file());
        let first = store.get(&paths, &profile_ids[0]).unwrap().unwrap();
        assert_eq!(first.backend, SecretBackend::File);
        assert_eq!(first.backend.as_str(), "file");
        {
            let keychain = WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(keychain.entries.is_empty());
        }

        WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reject_all_sets = false;
        assert_eq!(
            store.ensure_profiles(&paths, &profile_ids).unwrap(),
            Some(SecretBackend::Keychain)
        );
        assert!(!paths.secret_vault_file_path().exists());
        let migrated = store.get(&paths, &profile_ids[0]).unwrap().unwrap();
        assert_eq!(migrated.token, first.token);
        assert_eq!(migrated.backend, SecretBackend::Keychain);
    }

    #[test]
    fn windows_update_and_delete_fail_closed() {
        let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_windows_memory_keychain();
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_windows_keychain(windows_memory_keychain());
        store.set(&paths, "alpha", "alpha-token").unwrap();
        store.set(&paths, "beta", "beta-token").unwrap();
        let alpha_account = windows_profile_entry_account("alpha");
        {
            let mut keychain = WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            keychain.fail_sets.insert(alpha_account.clone());
        }

        assert!(store.set(&paths, "alpha", "replacement").is_err());
        assert_eq!(
            store.get(&paths, "alpha").unwrap().unwrap().token,
            "alpha-token"
        );
        assert!(!paths.secret_vault_file_path().exists());

        {
            let mut keychain = WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            keychain.fail_sets.clear();
            keychain.fail_deletes.insert(alpha_account.clone());
        }
        assert!(store.delete(&paths, "alpha").is_err());
        assert_eq!(
            store.get(&paths, "alpha").unwrap().unwrap().token,
            "alpha-token"
        );
        assert_eq!(
            store.get(&paths, "beta").unwrap().unwrap().token,
            "beta-token"
        );

        WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .fail_deletes
            .clear();
        store.delete(&paths, "alpha").unwrap();
        assert!(store.get(&paths, "alpha").unwrap().is_none());
        assert_eq!(
            store.get(&paths, "beta").unwrap().unwrap().token,
            "beta-token"
        );
    }

    #[test]
    fn rotates_legacy_tokens_without_reading_or_deleting_them() {
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = file_store();
        let profile_id = "alpha-000000000001";
        file_set(&paths.secret_file_path(profile_id), "legacy-token").unwrap();

        store
            .ensure_profiles(&paths, &[profile_id.to_string()])
            .unwrap();

        let current = store.get(&paths, profile_id).unwrap().unwrap();
        assert_ne!(current.token, "legacy-token");
        assert_eq!(
            file_get(&paths.secret_file_path(profile_id))
                .unwrap()
                .as_deref(),
            Some("legacy-token")
        );
    }

    #[test]
    fn refreshes_a_stale_cache_before_adding_profiles() {
        MEMORY_KEYCHAIN.lock().unwrap().clear();
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let broker_store = SecretStore::with_keychain(memory_keychain());
        let setup_store = SecretStore::with_keychain(memory_keychain());
        broker_store
            .ensure_profiles(&paths, &["alpha".to_string()])
            .unwrap();
        setup_store.set(&paths, "beta", "beta-token").unwrap();

        broker_store
            .ensure_profiles(&paths, &["alpha".to_string(), "beta".to_string()])
            .unwrap();

        assert_eq!(
            broker_store.get(&paths, "beta").unwrap().unwrap().token,
            "beta-token"
        );
        let stored = MEMORY_KEYCHAIN
            .lock()
            .unwrap()
            .get(VAULT_ENTRY_ACCOUNT)
            .cloned()
            .unwrap();
        assert_eq!(
            parse_vault(&stored, "memory keychain")
                .unwrap()
                .bridge_auth_tokens["beta"],
            "beta-token"
        );
    }

    #[test]
    fn vault_mutations_serialize_on_the_cross_process_lease() {
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let lease = FileLease::acquire(&paths.secret_vault_lock_path()).unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker_paths = paths.clone();
        let worker = std::thread::spawn(move || {
            let result =
                SecretStore::file_backend_for_tests().set(&worker_paths, "alpha", "alpha-token");
            done_tx.send(result).unwrap();
        });

        assert!(done_rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        drop(lease);
        done_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap()
            .unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn vault_validation_and_storage_errors_fail_closed() {
        let mut invalid_version = SecretVault::default();
        invalid_version.version += 1;
        assert!(invalid_version.validate().is_err());

        let mut too_many = SecretVault::default();
        for index in 0..=MAX_VAULT_PROFILES {
            too_many
                .bridge_auth_tokens
                .insert(format!("profile-{index}"), "token".to_string());
        }
        assert!(too_many.validate().is_err());

        for (profile_id, token) in [
            (String::new(), "token".to_string()),
            ("x".repeat(MAX_TOKEN_BYTES + 1), "token".to_string()),
            ("profile".to_string(), " ".to_string()),
            ("profile".to_string(), "x".repeat(MAX_TOKEN_BYTES + 1)),
        ] {
            let mut vault = SecretVault::default();
            vault.bridge_auth_tokens.insert(profile_id, token);
            assert!(vault.validate().is_err());
        }

        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = file_store();
        assert_eq!(store.ensure_profiles(&paths, &[]).unwrap(), None);
        for (profile_id, token) in [
            (String::new(), "token".to_string()),
            ("x".repeat(MAX_TOKEN_BYTES + 1), "token".to_string()),
            ("profile".to_string(), " ".to_string()),
            ("profile".to_string(), "x".repeat(MAX_TOKEN_BYTES + 1)),
        ] {
            assert!(store.set(&paths, &profile_id, &token).is_err());
        }
        store.set(&paths, "alpha", "alpha-token").unwrap();
        store.delete(&paths, "missing").unwrap();
        assert!(vault_file_get(temp.path()).is_err());
        assert!(parse_vault(&"x".repeat(MAX_VAULT_BYTES + 1), "oversized").is_err());
    }

    #[test]
    fn existing_keychain_vault_never_downgrades_after_write_failure() {
        fn get(account: &str) -> Result<Option<String>> {
            assert_eq!(account, VAULT_ENTRY_ACCOUNT);
            let mut vault = SecretVault::default();
            vault
                .bridge_auth_tokens
                .insert("alpha".to_string(), "alpha-token".to_string());
            Ok(Some(serde_json::to_string(&vault)?))
        }
        fn set(_account: &str, _contents: &str) -> Result<()> {
            Err(anyhow::anyhow!("keychain write denied"))
        }
        fn delete(_account: &str) -> Result<()> {
            Ok(())
        }

        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_keychain(Keychain { get, set, delete });
        assert!(store.set(&paths, "alpha", "replacement").is_err());
        assert!(!paths.secret_vault_file_path().exists());
        assert_eq!(
            store.get(&paths, "alpha").unwrap().unwrap().token,
            "alpha-token"
        );
    }

    #[test]
    fn stores_the_fallback_secret_with_owner_only_permissions() {
        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        file_store()
            .get_or_create(&paths, "alpha-000000000001")
            .unwrap();

        let path = paths.secret_vault_file_path();
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
        fn get(_account: &str) -> Result<Option<String>> {
            Ok(None)
        }
        fn set(_account: &str, _token: &str) -> Result<()> {
            Ok(())
        }
        fn delete(_account: &str) -> Result<()> {
            Ok(())
        }

        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_keychain(Keychain { get, set, delete });

        // A leftover vault from a run without a keychain must not survive a successful keychain write.
        let mut stale = SecretVault::default();
        stale
            .bridge_auth_tokens
            .insert("alpha-000000000001".to_string(), "stale".to_string());
        vault_file_set(&paths.secret_vault_file_path(), &stale).unwrap();
        let stored = store.set(&paths, "alpha-000000000001", "fresh").unwrap();

        assert_eq!(stored.backend, SecretBackend::Keychain);
        assert!(!paths.secret_vault_file_path().exists());

        let loaded = store.get(&paths, "alpha-000000000001").unwrap().unwrap();
        assert_eq!(loaded.backend, SecretBackend::Keychain);
        assert_eq!(loaded.token, "fresh");

        store.delete(&paths, "alpha-000000000001").unwrap();
    }

    #[test]
    fn falls_back_to_a_private_file_when_the_keychain_refuses() {
        fn get(_account: &str) -> Result<Option<String>> {
            Ok(None)
        }
        fn set(_account: &str, _token: &str) -> Result<()> {
            Err(anyhow::anyhow!("keychain is unavailable"))
        }
        fn delete(_account: &str) -> Result<()> {
            Err(anyhow::anyhow!("keychain is unavailable"))
        }

        let temp = tempdir().unwrap();
        let paths = AppPaths::for_tests(temp.path().to_path_buf());
        let store = SecretStore::with_keychain(Keychain { get, set, delete });

        let created = store.get_or_create(&paths, "alpha-000000000001").unwrap();
        assert_eq!(created.backend, SecretBackend::File);
        assert!(paths.secret_vault_file_path().is_file());

        let reloaded = store.get(&paths, "alpha-000000000001").unwrap().unwrap();
        assert_eq!(reloaded.token, created.token);
        assert_eq!(reloaded.backend, SecretBackend::File);

        // A failing legacy-item delete must still remove the profile from the fallback vault.
        store.delete(&paths, "alpha-000000000001").unwrap();
        assert!(paths.secret_vault_file_path().is_file());
        assert!(store.get(&paths, "alpha-000000000001").unwrap().is_none());
    }

    #[test]
    fn surfaces_a_keychain_read_failure_instead_of_inventing_a_token() {
        fn get(_account: &str) -> Result<Option<String>> {
            Err(anyhow::anyhow!("keychain read failed"))
        }
        fn set(_account: &str, _token: &str) -> Result<()> {
            Ok(())
        }
        fn delete(_account: &str) -> Result<()> {
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
        let account = legacy_entry_account(&profile_id);
        assert_eq!(keychain_get(&account).unwrap(), None);
        assert!(account.starts_with("bridge-auth-token:"));
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
