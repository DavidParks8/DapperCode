use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

use crate::{
    secrets::{
        generate_token, legacy_entry_account, parse_vault, validate_sip_password, vault_file_get,
        vault_file_set, BridgeSecret, SecretBackend, SecretStore, SecretVault, VAULT_ENTRY_ACCOUNT,
        VAULT_VERSION,
    },
    store::{atomic_private_write, remove_file_if_exists, AppPaths, FileLease},
};

pub(crate) const WINDOWS_TOKEN_ENTRY_PREFIX: &str = "bridge-auth-token:v2";
pub(crate) const WINDOWS_LAYOUT_ENTRY_ACCOUNT: &str = "bridge-auth-vault:v2";
pub(crate) const WINDOWS_LAYOUT_MARKER: &str = "per-profile-v1";
pub(crate) const MAX_WINDOWS_CREDENTIAL_UTF16_UNITS: usize = 1_200;
pub(crate) const WINDOWS_SIP_PASSWORD_ACCOUNT: &str = "__phone-call-sip-password";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SipPasswordFile {
    sip_password: String,
}

enum WindowsPreparation {
    Keychain,
    File(SecretVault),
    Uninitialized,
}

fn layout_is_active(store: &SecretStore) -> Result<bool> {
    match (store.keychain.get)(WINDOWS_LAYOUT_ENTRY_ACCOUNT)? {
        None => Ok(false),
        Some(marker) if marker == WINDOWS_LAYOUT_MARKER => Ok(true),
        Some(_) => bail!("unsupported Windows bridge credential layout marker"),
    }
}

fn profile_get(store: &SecretStore, profile_id: &str) -> Result<Option<String>> {
    let token = (store.keychain.get)(&windows_profile_entry_account(profile_id))?;
    if let Some(token) = &token {
        validate_windows_token(token).context("invalid Windows bridge profile credential")?;
    }
    Ok(token)
}

fn profile_set(store: &SecretStore, profile_id: &str, token: &str) -> Result<()> {
    validate_profile_id(profile_id)?;
    validate_windows_token(token)?;
    (store.keychain.set)(&windows_profile_entry_account(profile_id), token)
        .context("failed to store the Windows bridge profile credential")
}

fn activate_layout(store: &SecretStore) -> Result<()> {
    (store.keychain.set)(WINDOWS_LAYOUT_ENTRY_ACCOUNT, WINDOWS_LAYOUT_MARKER)
        .context("failed to activate the Windows per-profile credential layout")
}

fn rollback_entries(store: &SecretStore, accounts: &[String]) -> Result<()> {
    for account in accounts.iter().rev() {
        (store.keychain.delete)(account)
            .with_context(|| format!("failed to roll back Windows credential {account}"))?;
    }
    Ok(())
}

fn migrate_keychain_vault(
    store: &SecretStore,
    paths: &AppPaths,
    vault: &SecretVault,
) -> Result<()> {
    for (profile_id, token) in &vault.bridge_auth_tokens {
        match profile_get(store, profile_id)? {
            Some(existing) if existing != *token => {
                bail!("conflicting Windows bridge credentials for profile {profile_id}")
            }
            Some(_) => {}
            None => {
                profile_set(store, profile_id, token).with_context(|| {
                    format!("failed to migrate Windows bridge credential for {profile_id}")
                })?;
            }
        }
    }

    migrate_sip_password(store, paths, vault)?;
    (store.keychain.delete)(VAULT_ENTRY_ACCOUNT)
        .context("failed to remove the migrated Windows bridge credential vault")?;
    remove_file_if_exists(&paths.secret_vault_file_path())
        .context("failed to remove the stale bridge credential fallback")?;
    activate_layout(store)?;
    store.clear_vault_cache();
    Ok(())
}

fn migrate_file_vault(
    store: &SecretStore,
    paths: &AppPaths,
    vault: SecretVault,
) -> Result<WindowsPreparation> {
    let mut missing = Vec::new();
    let mut has_existing_windows_entry = false;
    for (profile_id, token) in &vault.bridge_auth_tokens {
        match profile_get(store, profile_id)? {
            Some(existing) if existing != *token => {
                bail!("conflicting file and Windows credentials for profile {profile_id}")
            }
            Some(_) => has_existing_windows_entry = true,
            None => missing.push((profile_id, token)),
        }
    }

    let mut created_accounts = Vec::new();
    for (profile_id, token) in missing {
        if let Err(error) = profile_set(store, profile_id, token) {
            if has_existing_windows_entry {
                return Err(error).context(
                    "failed to migrate the file-backed vault after Windows credentials existed",
                );
            }
            rollback_entries(store, &created_accounts)
                .context("failed to roll back an incomplete Windows credential migration")?;
            return Ok(WindowsPreparation::File(vault));
        }
        created_accounts.push(windows_profile_entry_account(profile_id));
    }

    migrate_sip_password(store, paths, &vault)?;
    remove_file_if_exists(&paths.secret_vault_file_path())
        .context("failed to remove the migrated bridge credential fallback")?;
    activate_layout(store)?;
    store.clear_vault_cache();
    Ok(WindowsPreparation::Keychain)
}

fn prepare_keychain(store: &SecretStore, paths: &AppPaths) -> Result<WindowsPreparation> {
    let active = layout_is_active(store)?;

    if !active {
        if let Some(contents) = (store.keychain.get)(VAULT_ENTRY_ACCOUNT)? {
            let vault = parse_vault(&contents, "Windows Credential Manager")?;
            migrate_keychain_vault(store, paths, &vault)?;
            return Ok(WindowsPreparation::Keychain);
        }
    }

    if let Some(vault) = vault_file_get(&paths.secret_vault_file_path())? {
        return migrate_file_vault(store, paths, vault);
    }

    Ok(if active {
        WindowsPreparation::Keychain
    } else {
        WindowsPreparation::Uninitialized
    })
}

fn persist_file_vault(store: &SecretStore, paths: &AppPaths, vault: SecretVault) -> Result<()> {
    vault_file_set(&paths.secret_vault_file_path(), &vault)?;
    store.set_vault_cache(vault, SecretBackend::File);
    Ok(())
}

pub(crate) fn get(
    store: &SecretStore,
    paths: &AppPaths,
    profile_id: &str,
) -> Result<Option<BridgeSecret>> {
    validate_profile_id(profile_id)?;
    let active = layout_is_active(store)?;
    let direct_token = profile_get(store, profile_id)?;
    let file_vault = vault_file_get(&paths.secret_vault_file_path())?;
    if active && file_vault.is_none() {
        return Ok(direct_token.map(|token| BridgeSecret {
            token,
            backend: SecretBackend::Keychain,
        }));
    }

    let shared_contents = if active {
        None
    } else {
        (store.keychain.get)(VAULT_ENTRY_ACCOUNT)?
    };
    if let Some(contents) = shared_contents {
        let vault = parse_vault(&contents, "Windows Credential Manager")?;
        let Some(token) = vault.bridge_auth_tokens.get(profile_id) else {
            return Ok(direct_token.map(|token| BridgeSecret {
                token,
                backend: SecretBackend::Keychain,
            }));
        };
        if direct_token.as_ref().is_some_and(|direct| direct != token) {
            bail!("conflicting Windows bridge credentials for profile {profile_id}");
        }
        return Ok(Some(BridgeSecret {
            token: token.clone(),
            backend: SecretBackend::Keychain,
        }));
    }

    if let Some(vault) = file_vault {
        if let Some(token) = vault.bridge_auth_tokens.get(profile_id) {
            if direct_token.as_ref().is_some_and(|direct| direct != token) {
                bail!("conflicting file and Windows credentials for profile {profile_id}");
            }
            return Ok(Some(BridgeSecret {
                token: token.clone(),
                backend: SecretBackend::File,
            }));
        }
    }
    Ok(direct_token.map(|token| BridgeSecret {
        token,
        backend: SecretBackend::Keychain,
    }))
}

pub(crate) fn get_or_create(
    store: &SecretStore,
    paths: &AppPaths,
    profile_id: &str,
) -> Result<(BridgeSecret, bool)> {
    validate_profile_id(profile_id)?;
    let _lease = FileLease::acquire(&paths.secret_vault_lock_path())?;
    match prepare_keychain(store, paths)? {
        WindowsPreparation::Keychain => {
            if let Some(token) = profile_get(store, profile_id)? {
                return Ok((
                    BridgeSecret {
                        token,
                        backend: SecretBackend::Keychain,
                    },
                    false,
                ));
            }
            let token = generate_token();
            profile_set(store, profile_id, &token)?;
            Ok((
                BridgeSecret {
                    token,
                    backend: SecretBackend::Keychain,
                },
                true,
            ))
        }
        WindowsPreparation::File(mut vault) => {
            if let Some(token) = vault.bridge_auth_tokens.get(profile_id) {
                return Ok((
                    BridgeSecret {
                        token: token.clone(),
                        backend: SecretBackend::File,
                    },
                    false,
                ));
            }
            let token = generate_token();
            vault
                .bridge_auth_tokens
                .insert(profile_id.to_string(), token.clone());
            persist_file_vault(store, paths, vault)?;
            Ok((
                BridgeSecret {
                    token,
                    backend: SecretBackend::File,
                },
                true,
            ))
        }
        WindowsPreparation::Uninitialized => {
            if let Some(token) = profile_get(store, profile_id)? {
                activate_layout(store)?;
                return Ok((
                    BridgeSecret {
                        token,
                        backend: SecretBackend::Keychain,
                    },
                    false,
                ));
            }

            let token = generate_token();
            match profile_set(store, profile_id, &token) {
                Ok(()) => {
                    activate_layout(store)?;
                    Ok((
                        BridgeSecret {
                            token,
                            backend: SecretBackend::Keychain,
                        },
                        true,
                    ))
                }
                Err(_) => {
                    let mut vault = SecretVault::default();
                    vault
                        .bridge_auth_tokens
                        .insert(profile_id.to_string(), token.clone());
                    persist_file_vault(store, paths, vault)?;
                    Ok((
                        BridgeSecret {
                            token,
                            backend: SecretBackend::File,
                        },
                        true,
                    ))
                }
            }
        }
    }
}

pub(crate) fn ensure_profiles(
    store: &SecretStore,
    paths: &AppPaths,
    profile_ids: &[String],
) -> Result<Option<SecretBackend>> {
    if profile_ids.is_empty() {
        return Ok(None);
    }
    for profile_id in profile_ids {
        validate_profile_id(profile_id)?;
    }

    let _lease = FileLease::acquire(&paths.secret_vault_lock_path())?;
    match prepare_keychain(store, paths)? {
        WindowsPreparation::Keychain => {
            for profile_id in profile_ids {
                if profile_get(store, profile_id)?.is_none() {
                    profile_set(store, profile_id, &generate_token())?;
                }
            }
            Ok(Some(SecretBackend::Keychain))
        }
        WindowsPreparation::File(mut vault) => {
            for profile_id in profile_ids {
                if !vault.bridge_auth_tokens.contains_key(profile_id) {
                    vault
                        .bridge_auth_tokens
                        .insert(profile_id.clone(), generate_token());
                }
            }
            persist_file_vault(store, paths, vault)?;
            Ok(Some(SecretBackend::File))
        }
        WindowsPreparation::Uninitialized => {
            let mut tokens = std::collections::BTreeMap::new();
            let mut missing = Vec::new();
            let mut has_existing_windows_entry = false;
            for profile_id in profile_ids {
                if let Some(token) = profile_get(store, profile_id)? {
                    has_existing_windows_entry = true;
                    tokens.insert(profile_id.clone(), token);
                } else if !tokens.contains_key(profile_id) {
                    let token = generate_token();
                    tokens.insert(profile_id.clone(), token.clone());
                    missing.push((profile_id, token));
                }
            }

            let mut created_accounts = Vec::new();
            for (profile_id, token) in missing {
                if let Err(error) = profile_set(store, profile_id, &token) {
                    if has_existing_windows_entry {
                        return Err(error).context(
                            "failed to extend an existing Windows per-profile credential vault",
                        );
                    }
                    rollback_entries(store, &created_accounts)
                        .context("failed to roll back newly created Windows profile credentials")?;
                    let vault = SecretVault {
                        version: VAULT_VERSION,
                        bridge_auth_tokens: tokens,
                        sip_password: None,
                    };
                    persist_file_vault(store, paths, vault)?;
                    return Ok(Some(SecretBackend::File));
                }
                created_accounts.push(windows_profile_entry_account(profile_id));
            }
            activate_layout(store)?;
            Ok(Some(SecretBackend::Keychain))
        }
    }
}

pub(crate) fn refresh(store: &SecretStore, paths: &AppPaths) -> Result<()> {
    store.clear_vault_cache();
    if !layout_is_active(store)? {
        if let Some(contents) = (store.keychain.get)(VAULT_ENTRY_ACCOUNT)? {
            parse_vault(&contents, "Windows Credential Manager")?;
        }
        vault_file_get(&paths.secret_vault_file_path())?;
    }
    Ok(())
}

#[cfg(any(test, feature = "test-support"))]
pub(crate) fn set(
    store: &SecretStore,
    paths: &AppPaths,
    profile_id: &str,
    token: &str,
) -> Result<BridgeSecret> {
    validate_profile_id(profile_id)?;
    validate_token(token)?;
    let _lease = FileLease::acquire(&paths.secret_vault_lock_path())?;
    match prepare_keychain(store, paths)? {
        WindowsPreparation::Keychain => {
            profile_set(store, profile_id, token)?;
            remove_file_if_exists(&paths.secret_vault_file_path())?;
            Ok(BridgeSecret {
                token: token.to_string(),
                backend: SecretBackend::Keychain,
            })
        }
        WindowsPreparation::File(mut vault) => {
            vault
                .bridge_auth_tokens
                .insert(profile_id.to_string(), token.to_string());
            persist_file_vault(store, paths, vault)?;
            Ok(BridgeSecret {
                token: token.to_string(),
                backend: SecretBackend::File,
            })
        }
        WindowsPreparation::Uninitialized => {
            let existed = profile_get(store, profile_id)?.is_some();
            match profile_set(store, profile_id, token) {
                Ok(()) => {
                    activate_layout(store)?;
                    Ok(BridgeSecret {
                        token: token.to_string(),
                        backend: SecretBackend::Keychain,
                    })
                }
                Err(error) if existed => {
                    Err(error).context("failed to update an existing Windows profile credential")
                }
                Err(_) => {
                    let mut vault = SecretVault::default();
                    vault
                        .bridge_auth_tokens
                        .insert(profile_id.to_string(), token.to_string());
                    persist_file_vault(store, paths, vault)?;
                    Ok(BridgeSecret {
                        token: token.to_string(),
                        backend: SecretBackend::File,
                    })
                }
            }
        }
    }
}

fn delete_from_legacy_vault(store: &SecretStore, profile_id: &str) -> Result<()> {
    let Some(contents) = (store.keychain.get)(VAULT_ENTRY_ACCOUNT)? else {
        return Ok(());
    };
    let mut vault = parse_vault(&contents, "Windows Credential Manager")?;
    if vault.bridge_auth_tokens.remove(profile_id).is_none() {
        return Ok(());
    }
    if vault.bridge_auth_tokens.is_empty() && vault.sip_password.is_none() {
        (store.keychain.delete)(VAULT_ENTRY_ACCOUNT)
            .context("failed to remove the empty legacy Windows credential vault")
    } else {
        let contents = serde_json::to_string(&vault)?;
        (store.keychain.set)(VAULT_ENTRY_ACCOUNT, &contents)
            .context("failed to remove a profile from the legacy Windows credential vault")
    }
}

fn migrate_sip_password(store: &SecretStore, paths: &AppPaths, vault: &SecretVault) -> Result<()> {
    let Some(password) = vault.sip_password.as_deref() else {
        return Ok(());
    };
    let existing = (store.keychain.get)(WINDOWS_SIP_PASSWORD_ACCOUNT)?
        .or(sip_password_file_get(&paths.sip_secret_file_path())?);
    if existing.as_deref().is_some_and(|value| value != password) {
        bail!("conflicting SIP passwords in the shared and Windows credential stores");
    }
    store_sip_password_locked(store, paths, password)?;
    Ok(())
}

pub(crate) fn store_sip_password(
    store: &SecretStore,
    paths: &AppPaths,
    password: &str,
) -> Result<SecretBackend> {
    let _lease = FileLease::acquire(&paths.secret_vault_lock_path())?;
    match prepare_keychain(store, paths)? {
        WindowsPreparation::File(mut vault) => {
            vault.sip_password = Some(password.to_string());
            persist_file_vault(store, paths, vault)?;
            Ok(SecretBackend::File)
        }
        WindowsPreparation::Keychain | WindowsPreparation::Uninitialized => {
            store_sip_password_locked(store, paths, password)
        }
    }
}

fn store_sip_password_locked(
    store: &SecretStore,
    paths: &AppPaths,
    password: &str,
) -> Result<SecretBackend> {
    validate_sip_password(password)?;
    let existed = (store.keychain.get)(WINDOWS_SIP_PASSWORD_ACCOUNT)?.is_some();
    if password.encode_utf16().count() > MAX_WINDOWS_CREDENTIAL_UTF16_UNITS {
        let previous_fallback = sip_password_file_get(&paths.sip_secret_file_path())?;
        sip_password_file_set(paths, password)?;
        if existed {
            if let Err(error) = (store.keychain.delete)(WINDOWS_SIP_PASSWORD_ACCOUNT) {
                let rollback = match previous_fallback {
                    Some(previous) => sip_password_file_set(paths, &previous),
                    None => remove_file_if_exists(&paths.sip_secret_file_path()),
                };
                return Err(AppPaths::with_rollback_error(error, rollback)).context(
                    "failed to move the Windows SIP password to its private-file fallback",
                );
            }
        }
        return Ok(SecretBackend::File);
    }
    match (store.keychain.set)(WINDOWS_SIP_PASSWORD_ACCOUNT, password) {
        Ok(()) => {
            remove_file_if_exists(&paths.sip_secret_file_path())?;
            Ok(SecretBackend::Keychain)
        }
        Err(error) if existed => {
            Err(error).context("failed to update the Windows SIP password credential")
        }
        Err(_) => {
            sip_password_file_set(paths, password)?;
            Ok(SecretBackend::File)
        }
    }
}

fn sip_password_file_set(paths: &AppPaths, password: &str) -> Result<()> {
    let contents = serde_json::to_vec_pretty(&SipPasswordFile {
        sip_password: password.to_string(),
    })?;
    atomic_private_write(&paths.sip_secret_file_path(), &contents)
}

pub(crate) fn load_sip_password(
    store: &SecretStore,
    paths: &AppPaths,
) -> Result<Option<(String, SecretBackend)>> {
    let _lease = FileLease::acquire(&paths.secret_vault_lock_path())?;
    let shared_password = match prepare_keychain(store, paths)? {
        WindowsPreparation::File(vault) => vault.sip_password,
        WindowsPreparation::Keychain | WindowsPreparation::Uninitialized => None,
    };
    if let Some(password) = shared_password {
        return Ok(Some((password, SecretBackend::File)));
    }
    if let Some(password) = (store.keychain.get)(WINDOWS_SIP_PASSWORD_ACCOUNT)? {
        validate_sip_password(&password)?;
        return Ok(Some((password, SecretBackend::Keychain)));
    }
    Ok(sip_password_file_get(&paths.sip_secret_file_path())?
        .map(|password| (password, SecretBackend::File)))
}

pub(crate) fn delete_sip_password(store: &SecretStore, paths: &AppPaths) -> Result<()> {
    let _lease = FileLease::acquire(&paths.secret_vault_lock_path())?;
    if let WindowsPreparation::File(mut vault) = prepare_keychain(store, paths)? {
        if vault.sip_password.take().is_some() {
            persist_file_vault(store, paths, vault)?;
        }
    }
    if (store.keychain.get)(WINDOWS_SIP_PASSWORD_ACCOUNT)?.is_some() {
        (store.keychain.delete)(WINDOWS_SIP_PASSWORD_ACCOUNT)
            .context("failed to remove the Windows SIP password credential")?;
    }
    remove_file_if_exists(&paths.sip_secret_file_path())
}

fn sip_password_file_get(path: &Path) -> Result<Option<String>> {
    let contents = match std::fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()))
        }
    };
    let file: SipPasswordFile = serde_json::from_slice(&contents)
        .with_context(|| format!("invalid stored SIP secret at {}", path.display()))?;
    validate_sip_password(&file.sip_password)?;
    Ok(Some(file.sip_password))
}

fn delete_from_file_vault(store: &SecretStore, paths: &AppPaths, profile_id: &str) -> Result<()> {
    let Some(mut vault) = vault_file_get(&paths.secret_vault_file_path())? else {
        return Ok(());
    };
    if vault.bridge_auth_tokens.remove(profile_id).is_some() {
        persist_file_vault(store, paths, vault)?;
    }
    Ok(())
}

pub(crate) fn delete(store: &SecretStore, paths: &AppPaths, profile_id: &str) -> Result<()> {
    validate_profile_id(profile_id)?;
    let _lease = FileLease::acquire(&paths.secret_vault_lock_path())?;
    match prepare_keychain(store, paths)? {
        WindowsPreparation::File(mut vault) => {
            if vault.bridge_auth_tokens.remove(profile_id).is_some() {
                persist_file_vault(store, paths, vault)?;
            }
            let _ = (store.keychain.delete)(&windows_profile_entry_account(profile_id));
        }
        WindowsPreparation::Keychain => {
            delete_from_legacy_vault(store, profile_id)?;
            delete_from_file_vault(store, paths, profile_id)?;
            if profile_get(store, profile_id)?.is_some() {
                (store.keychain.delete)(&windows_profile_entry_account(profile_id))
                    .context("failed to remove the Windows bridge profile credential")?;
            }
        }
        WindowsPreparation::Uninitialized => {
            if profile_get(store, profile_id)?.is_some() {
                (store.keychain.delete)(&windows_profile_entry_account(profile_id))
                    .context("failed to remove the Windows bridge profile credential")?;
            }
        }
    }
    let _ = (store.keychain.delete)(&legacy_entry_account(profile_id));
    remove_file_if_exists(&paths.secret_file_path(profile_id))
}

pub(crate) fn windows_profile_entry_account(profile_id: &str) -> String {
    let digest = Sha256::digest(profile_id.as_bytes());
    format!("{WINDOWS_TOKEN_ENTRY_PREFIX}:{digest:x}")
}

fn validate_profile_id(profile_id: &str) -> Result<()> {
    if profile_id.trim().is_empty() || profile_id.len() > crate::secrets::MAX_TOKEN_BYTES {
        bail!("profile credential has an invalid profile ID");
    }
    Ok(())
}

pub(crate) fn validate_windows_token(token: &str) -> Result<()> {
    validate_token(token)?;
    if token.encode_utf16().count() > MAX_WINDOWS_CREDENTIAL_UTF16_UNITS {
        bail!("Windows bridge credential exceeds the Credential Manager size limit");
    }
    Ok(())
}

fn validate_token(token: &str) -> Result<()> {
    if token.trim().is_empty() || token.len() > crate::secrets::MAX_TOKEN_BYTES {
        bail!("profile credential has an invalid token");
    }
    Ok(())
}
