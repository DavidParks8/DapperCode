#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "secret store vault and keychain fallback logic live together"
    )
)]

use anyhow::{bail, Context, Result};
use getrandom::fill as fill_random;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::platform::{self, CredentialLayout, Keychain};
use crate::store::{atomic_private_write, remove_file_if_exists, AppPaths, FileLease};

fn secrets_env(name: &str) -> Result<String, std::env::VarError> {
    #[cfg(test)]
    {
        crate::test_env::var(name)
    }
    #[cfg(not(test))]
    {
        std::env::var(name)
    }
}

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

#[derive(Clone)]
pub struct BridgeSecret {
    pub token: String,
    pub backend: SecretBackend,
}

impl std::fmt::Debug for BridgeSecret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BridgeSecret")
            .field("token", &"[REDACTED]")
            .field("backend", &self.backend)
            .finish()
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SecretVault {
    pub(crate) version: u32,
    pub(crate) bridge_auth_tokens: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) sip_password: Option<String>,
}

impl Default for SecretVault {
    fn default() -> Self {
        Self {
            version: VAULT_VERSION,
            bridge_auth_tokens: BTreeMap::new(),
            sip_password: None,
        }
    }
}

impl SecretVault {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.version != VAULT_VERSION {
            bail!(
                "unsupported bridge credential vault version {}",
                self.version,
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
        if let Some(sip_password) = &self.sip_password {
            validate_sip_password(sip_password)?;
        }
        Ok(())
    }
}

pub(crate) fn validate_sip_password(password: &str) -> Result<()> {
    if password.trim().is_empty()
        || password.len() > MAX_TOKEN_BYTES
        || password.contains(['\n', '\r', '\0'])
    {
        bail!("SIP password must be non-empty, at most {MAX_TOKEN_BYTES} bytes, and free of control characters");
    }
    Ok(())
}

#[derive(Clone)]
struct VaultState {
    vault: SecretVault,
    backend: SecretBackend,
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
        let prefer_file = secrets_env("DAPPERCODE_SECRETS_BACKEND")
            .map(|value| value.trim().eq_ignore_ascii_case("file"))
            .unwrap_or(false);
        Self {
            prefer_file,
            keychain: Keychain::system(),
            credential_layout: platform::credential_layout(),
            vault_cache: Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn file_backend_for_tests() -> Self {
        Self {
            prefer_file: true,
            keychain: Keychain::system(),
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
        let cached = self
            .vault_cache
            .lock()
            .expect("bridge credential vault cache poisoned")
            .clone();
        if let Some(cached) = cached {
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

    #[cfg(any(test, feature = "test-support"))]
    pub fn set_for_tests(
        &self,
        paths: &AppPaths,
        profile_id: &str,
        token: &str,
    ) -> Result<BridgeSecret> {
        platform::secret_set(
            self.effective_credential_layout(),
            self,
            paths,
            profile_id,
            token,
        )
    }

    #[cfg(any(test, feature = "test-support"))]
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
        Ok(())
    }

    pub fn store_sip_password(&self, paths: &AppPaths, password: &str) -> Result<SecretBackend> {
        validate_sip_password(password)?;
        platform::secret_store_sip_password(
            self.effective_credential_layout(),
            self,
            paths,
            password,
        )
    }

    pub(crate) fn store_sip_password_shared(
        &self,
        paths: &AppPaths,
        password: String,
    ) -> Result<SecretBackend> {
        let _lease = FileLease::acquire(&paths.secret_vault_lock_path())?;
        let existing = self.load_vault_fresh(paths)?;
        let previous_backend = existing.as_ref().map(|state| state.backend);
        let mut vault = existing.map(|state| state.vault).unwrap_or_default();
        vault.sip_password = Some(password);
        self.persist_vault(paths, vault, previous_backend)
    }

    pub fn load_sip_password(&self, paths: &AppPaths) -> Result<Option<(String, SecretBackend)>> {
        platform::secret_load_sip_password(self.effective_credential_layout(), self, paths)
    }

    pub(crate) fn load_sip_password_shared(
        &self,
        paths: &AppPaths,
    ) -> Result<Option<(String, SecretBackend)>> {
        let Some(state) = self.load_vault_fresh(paths)? else {
            return Ok(None);
        };
        Ok(state
            .vault
            .sip_password
            .map(|password| (password, state.backend)))
    }

    pub fn delete_sip_password(&self, paths: &AppPaths) -> Result<()> {
        platform::secret_delete_sip_password(self.effective_credential_layout(), self, paths)
    }

    pub(crate) fn delete_sip_password_shared(&self, paths: &AppPaths) -> Result<()> {
        let _lease = FileLease::acquire(&paths.secret_vault_lock_path())?;
        if let Some(state) = self.load_vault_fresh(paths)? {
            let mut vault = state.vault;
            if vault.sip_password.take().is_some() {
                self.persist_vault(paths, vault, Some(state.backend))?;
            }
        }
        Ok(())
    }
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
#[path = "secrets_tests.rs"]
mod tests;
