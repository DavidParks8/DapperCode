#[cfg(any(target_os = "macos", target_os = "windows"))]
use anyhow::Context;
use anyhow::{bail, Result};

#[cfg(any(target_os = "macos", target_os = "windows"))]
const KEYCHAIN_SERVICE: &str = "dev.dappercode.desktop";

#[derive(Clone, Copy, Debug)]
pub(crate) struct Keychain {
    pub(crate) get: fn(&str) -> Result<Option<String>>,
    pub(crate) set: fn(&str, &str) -> Result<()>,
    #[cfg(any(target_os = "windows", test))]
    pub(crate) delete: fn(&str) -> Result<()>,
}

impl Keychain {
    pub(crate) fn system() -> Self {
        Self {
            get: keychain_get,
            set: keychain_set,
            #[cfg(any(target_os = "windows", all(target_os = "macos", test)))]
            delete: keychain_delete,
            #[cfg(all(test, not(any(target_os = "macos", target_os = "windows"))))]
            delete: |_| Ok(()),
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keychain_entry(account: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).context("keychain is unavailable on this system")
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keychain_get(account: &str) -> Result<Option<String>> {
    keychain_password_result(keychain_entry(account)?.get_password())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keychain_password_result(credential: keyring::Result<String>) -> Result<Option<String>> {
    match credential {
        Ok(token) if !token.trim().is_empty() => Ok(Some(token)),
        Ok(_) => bail!("stored bridge credential vault is empty"),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error).context("failed to read the bridge credential vault"),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keychain_set(account: &str, token: &str) -> Result<()> {
    let entry = keychain_entry(account)?;
    entry
        .set_password(token)
        .context("failed to store the bridge token in the keychain")
}

#[cfg(any(target_os = "windows", all(target_os = "macos", test)))]
fn keychain_delete(account: &str) -> Result<()> {
    let entry = keychain_entry(account)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("failed to remove the bridge token from the keychain"),
    }
}

// Headless Unix must use the private-file vault, not keyring's in-memory mock or Secret Service.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn keychain_get(_account: &str) -> Result<Option<String>> {
    Ok(None)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn keychain_set(_account: &str, _token: &str) -> Result<()> {
    bail!("native credential storage is unavailable on this platform")
}

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
#[path = "credentials_tests.rs"]
mod tests;
