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
            #[cfg(any(target_os = "windows", test))]
            delete: keychain_delete,
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

#[cfg(all(test, not(any(target_os = "macos", target_os = "windows"))))]
fn keychain_delete(_account: &str) -> Result<()> {
    Ok(())
}

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod tests {
    use super::*;

    #[test]
    fn dependency_upgrade_native_entry_preserves_service_and_account_without_opening_the_store() {
        for account in [
            "bridge-auth-vault:v1",
            "bridge-auth-vault:v2",
            "bridge-auth-token:v2:0038851cbd37beeb49b6cbf6893d248ac90536f123ace1fa818a90c255b91dc1",
            "__phone-call-sip-password",
        ] {
            // Entry construction only builds a descriptor; no keychain lookup, write, or delete.
            let entry = keychain_entry(account).unwrap();
            assert_eq!(
                entry.inner.get_specifiers(),
                Some(("dev.dappercode.desktop".to_string(), account.to_string()))
            );
            #[cfg(target_os = "windows")]
            assert!(format!("{:?}", entry.inner).contains(&format!(
                "target_name: \"{account}.dev.dappercode.desktop\""
            )));
            #[cfg(target_os = "windows")]
            assert!(format!("{:?}", entry.inner).contains("persistence: Enterprise"));
            #[cfg(target_os = "macos")]
            assert!(format!("{:?}", entry.inner).contains("domain: User"));
        }
    }

    #[test]
    fn dependency_upgrade_password_results_preserve_absence_payload_and_read_errors() {
        assert_eq!(
            keychain_password_result(Err(keyring::Error::NoEntry)).unwrap(),
            None
        );
        let token = crate::secrets::generate_token();
        let sip_secret = format!("{}\u{00e9}\u{1f510}", crate::secrets::generate_token());
        let payload = serde_json::json!({
            "version": 1,
            "bridgeAuthTokens": {"alpha": token},
            "sipPassword": sip_secret,
        })
        .to_string();
        assert_eq!(
            keychain_password_result(Ok(payload.clone())).unwrap(),
            Some(payload)
        );
        assert!(keychain_password_result(Ok("   ".to_string())).is_err());
        assert!(keychain_password_result(Err(keyring::Error::BadEncoding(vec![0xff]))).is_err());
    }
}
