use anyhow::{bail, Context, Result};

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
            #[cfg(any(target_os = "windows", test))]
            delete: keychain_delete,
        }
    }
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

#[cfg(any(target_os = "windows", test))]
fn keychain_delete(account: &str) -> Result<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .context("keychain is unavailable on this system")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("failed to remove the bridge token from the keychain"),
    }
}
