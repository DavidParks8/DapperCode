use super::{
    atomic_private_write, bail, generate_token, parse_vault, remove_file_if_exists, vault_file_get,
    vault_file_set, AppPaths, BTreeMap, BridgeSecret, FileLease, Keychain, Result, SecretBackend,
    SecretStore, SecretVault, MAX_TOKEN_BYTES, MAX_VAULT_BYTES, MAX_VAULT_PROFILES,
    VAULT_ENTRY_ACCOUNT,
};

#[test]
fn bridge_secret_debug_redacts_the_token() {
    let secret = BridgeSecret {
        token: "sensitive-test-token".to_string(),
        backend: SecretBackend::File,
    };
    for output in [format!("{secret:?}"), format!("{secret:#?}")] {
        assert!(!output.contains(&secret.token));
        assert!(output.contains("[REDACTED]"));
        assert!(output.contains("File"));
    }
}
use crate::platform::windows_credentials::{
    validate_windows_token, windows_profile_entry_account, MAX_WINDOWS_CREDENTIAL_UTF16_UNITS,
    WINDOWS_LAYOUT_ENTRY_ACCOUNT, WINDOWS_LAYOUT_MARKER, WINDOWS_SIP_PASSWORD_ACCOUNT,
    WINDOWS_TOKEN_ENTRY_PREFIX,
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
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn dependency_upgrade_headless_unix_persists_credentials_across_store_recreation() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempdir().unwrap();
    let paths = AppPaths::for_tests(directory.path().to_path_buf());
    let first = SecretStore::discover()
        .get_or_create(&paths, "unix-profile")
        .unwrap();
    assert_eq!(first.backend, SecretBackend::File);
    let restarted = SecretStore::discover();
    let restored = restarted.get(&paths, "unix-profile").unwrap().unwrap();
    assert_eq!(restored.token, first.token);
    assert_eq!(restored.backend, SecretBackend::File);
    assert_eq!(
        std::fs::metadata(paths.secret_vault_file_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600,
    );
    restarted.delete(&paths, "unix-profile").unwrap();
    assert!(SecretStore::discover()
        .get(&paths, "unix-profile")
        .unwrap()
        .is_none());
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
        beta.token,
    );
}

#[test]
fn uses_one_keychain_vault_for_every_workspace() {
    static GETS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    static SETS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    #[expect(clippy::panic_in_result_fn, reason = "Test callback asserts its input")]
    fn get(account: &str) -> Result<Option<String>> {
        assert_eq!(account, VAULT_ENTRY_ACCOUNT);
        GETS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(None)
    }
    #[expect(clippy::panic_in_result_fn, reason = "Test callback asserts its input")]
    fn set(account: &str, contents: &str) -> Result<()> {
        assert_eq!(account, VAULT_ENTRY_ACCOUNT);
        assert_eq!(
            parse_vault(contents, "test keychain")?
                .bridge_auth_tokens
                .len(),
            500,
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
        Some(SecretBackend::Keychain),
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
fn windows_profile_account_preserves_existing_digest_format() {
    assert_eq!(
        windows_profile_entry_account("profile-56"),
        "bridge-auth-token:v2:0038851cbd37beeb49b6cbf6893d248ac90536f123ace1fa818a90c255b91dc1",
    );
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
        Some(SecretBackend::Keychain),
    );

    let keychain = WINDOWS_MEMORY_KEYCHAIN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_eq!(
        keychain.entries.get(WINDOWS_LAYOUT_ENTRY_ACCOUNT),
        Some(&WINDOWS_LAYOUT_MARKER.to_string()),
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
            .contains("Credential Manager size limit"),
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
    assert!(store.set_for_tests(&paths, "alpha", " ").is_err());
    assert!(store
        .set_for_tests(&paths, "alpha", &"x".repeat(MAX_TOKEN_BYTES + 1))
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
fn windows_reuses_current_entries_without_importing_obsolete_credentials() {
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
        Some(SecretBackend::Keychain),
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
    assert_eq!(
        store.get(&paths, "alpha").unwrap().unwrap().token,
        "alpha-token",
    );
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
        SecretBackend::File,
    );
    store.get_or_create_with_status(&paths, "beta").unwrap();
    assert_eq!(
        store
            .ensure_profiles(&paths, &["alpha".to_string(), "gamma".to_string()])
            .unwrap(),
        Some(SecretBackend::File),
    );

    store.delete(&paths, "missing").unwrap();
    store.delete(&paths, "alpha").unwrap();
    assert!(store.get(&paths, "alpha").unwrap().is_none());
    assert!(store.get(&paths, "beta").unwrap().is_some());
}

#[test]
fn windows_rejects_conflicts_between_current_file_and_native_credentials() {
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
    assert_eq!(
        store
            .ensure_profiles(&paths, &["alpha".to_string()])
            .unwrap(),
        Some(SecretBackend::Keychain),
    );

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
        Some(SecretBackend::Keychain),
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
        Some(SecretBackend::Keychain),
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
fn windows_deletes_current_credentials_without_touching_obsolete_entries() {
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
    assert!(remaining.bridge_auth_tokens.contains_key("alpha"));
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
fn windows_ignores_obsolete_shared_vaults_and_leaves_their_contents_untouched() {
    let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    reset_windows_memory_keychain();
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());
    let store = SecretStore::with_windows_keychain(windows_memory_keychain());
    let old_token = generate_token();
    let mut obsolete_vault = SecretVault::default();
    obsolete_vault
        .bridge_auth_tokens
        .insert("alpha".to_string(), old_token.clone());
    obsolete_vault.sip_password = Some(generate_token());
    let original = serde_json::to_string(&obsolete_vault).unwrap();
    {
        let mut keychain = WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        keychain
            .entries
            .insert(VAULT_ENTRY_ACCOUNT.to_string(), original.clone());
        keychain
            .fail_deletes
            .insert(VAULT_ENTRY_ACCOUNT.to_string());
    }

    assert!(store.get(&paths, "alpha").unwrap().is_none());
    assert!(store.load_sip_password(&paths).unwrap().is_none());
    assert_eq!(
        store
            .ensure_profiles(&paths, &["alpha".to_string(), "beta".to_string()])
            .unwrap(),
        Some(SecretBackend::Keychain),
    );
    assert_ne!(
        store.get(&paths, "alpha").unwrap().unwrap().token,
        old_token,
    );
    store.delete(&paths, "alpha").unwrap();
    assert!(store.get(&paths, "alpha").unwrap().is_none());
    assert!(store.get(&paths, "beta").unwrap().is_some());
    let keychain = WINDOWS_MEMORY_KEYCHAIN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_eq!(keychain.entries.get(VAULT_ENTRY_ACCOUNT), Some(&original));
    assert_eq!(
        keychain.entries.get(WINDOWS_LAYOUT_ENTRY_ACCOUNT),
        Some(&WINDOWS_LAYOUT_MARKER.to_string()),
    );
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
        Some(SecretBackend::File),
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
        Some(SecretBackend::Keychain),
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
    store.set_for_tests(&paths, "alpha", "alpha-token").unwrap();
    store.set_for_tests(&paths, "beta", "beta-token").unwrap();
    let alpha_account = windows_profile_entry_account("alpha");
    {
        let mut keychain = WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        keychain.fail_sets.insert(alpha_account.clone());
    }

    assert!(store.set_for_tests(&paths, "alpha", "replacement").is_err());
    assert_eq!(
        store.get(&paths, "alpha").unwrap().unwrap().token,
        "alpha-token",
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
        "alpha-token",
    );
    assert_eq!(
        store.get(&paths, "beta").unwrap().unwrap().token,
        "beta-token",
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
        "beta-token",
    );
}

#[test]
fn obsolete_token_files_are_not_read_or_deleted_during_current_credential_operations() {
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());
    let store = file_store();
    let profile_id = "alpha-000000000001";
    let obsolete_path = temp
        .path()
        .join("secrets")
        .join(format!("{profile_id}.json"));
    let obsolete_contents = br#"{"bridgeAuthToken":"obsolete-token"}"#;
    atomic_private_write(&obsolete_path, obsolete_contents).unwrap();
    let original_contents = std::fs::read(&obsolete_path).unwrap();

    store
        .ensure_profiles(&paths, &[profile_id.to_string()])
        .unwrap();

    let current = store.get(&paths, profile_id).unwrap().unwrap();
    assert_ne!(current.token, "obsolete-token");
    store.delete(&paths, profile_id).unwrap();
    assert!(store.get(&paths, profile_id).unwrap().is_none());
    assert_eq!(std::fs::read(&obsolete_path).unwrap(), original_contents);
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
    setup_store
        .set_for_tests(&paths, "beta", "beta-token")
        .unwrap();

    broker_store
        .ensure_profiles(&paths, &["alpha".to_string(), "beta".to_string()])
        .unwrap();

    assert_eq!(
        broker_store.get(&paths, "beta").unwrap().unwrap().token,
        "beta-token",
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
        "beta-token",
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
        let result = SecretStore::file_backend_for_tests().set_for_tests(
            &worker_paths,
            "alpha",
            "alpha-token",
        );
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
        assert!(store.set_for_tests(&paths, &profile_id, &token).is_err());
    }
    store.set_for_tests(&paths, "alpha", "alpha-token").unwrap();
    store.delete(&paths, "missing").unwrap();
    assert!(vault_file_get(temp.path()).is_err());
    assert!(parse_vault(&"x".repeat(MAX_VAULT_BYTES + 1), "oversized").is_err());
}

#[test]
fn existing_keychain_vault_never_downgrades_after_write_failure() {
    #[expect(clippy::panic_in_result_fn, reason = "Test callback asserts its input")]
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
    assert!(store.set_for_tests(&paths, "alpha", "replacement").is_err());
    assert!(!paths.secret_vault_file_path().exists());
    assert_eq!(
        store.get(&paths, "alpha").unwrap().unwrap().token,
        "alpha-token",
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
    let paths = AppPaths::for_tests(temp.path().to_path_buf());
    atomic_private_write(&paths.secret_vault_file_path(), b"not json").unwrap();
    assert!(file_store()
        .get(&paths, "alpha")
        .unwrap_err()
        .to_string()
        .contains("invalid stored bridge credential vault"));
}

#[test]
fn rejects_empty_current_vault_tokens_and_recovers_after_a_valid_write() {
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());
    let store = file_store();
    atomic_private_write(
        &paths.secret_vault_file_path(),
        br#"{"version":1,"bridgeAuthTokens":{"alpha":"   "}}"#,
    )
    .unwrap();
    assert!(store.get(&paths, "alpha").is_err());
    let token = generate_token();
    let mut vault = SecretVault::default();
    vault
        .bridge_auth_tokens
        .insert("alpha".to_string(), token.clone());
    vault_file_set(&paths.secret_vault_file_path(), &vault).unwrap();
    assert_eq!(store.get(&paths, "alpha").unwrap().unwrap().token, token);
}

#[test]
fn reports_a_missing_secret_file_as_absent() {
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());
    assert!(file_store().get(&paths, "alpha").unwrap().is_none());
}

#[test]
fn chooses_the_backend_from_the_environment() {
    {
        let _guard = crate::test_env::set("DAPPERCODE_SECRETS_BACKEND", " FILE ");
        assert!(SecretStore::discover().prefer_file);
    }
    {
        let _guard = crate::test_env::set("DAPPERCODE_SECRETS_BACKEND", "keychain");
        assert!(!SecretStore::discover().prefer_file);
    }
    {
        let _guard = crate::test_env::unset("DAPPERCODE_SECRETS_BACKEND");
        assert!(!SecretStore::discover().prefer_file);
    }
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
    let stored = store
        .set_for_tests(&paths, "alpha-000000000001", "fresh")
        .unwrap();

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
    let account = format!("dappercode-test-absent-{}", generate_token());
    assert_eq!((Keychain::system().get)(&account).unwrap(), None);
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
        .set_for_tests(&paths, "alpha-000000000001", "explicit-token")
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
        "explicit-token",
    );
}

#[test]
fn shared_vault_deserializes_legacy_v1_and_round_trips_sip_password_in_single_item() {
    MEMORY_KEYCHAIN.lock().unwrap().clear();
    MEMORY_KEYCHAIN.lock().unwrap().insert(
        VAULT_ENTRY_ACCOUNT.to_string(),
        r#"{"version":1,"bridgeAuthTokens":{"alpha":"legacy-token"}}"#.to_string(),
    );
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());
    let store = SecretStore::with_keychain(memory_keychain());
    let sip_password = generate_token();

    assert_eq!(store.load_sip_password(&paths).unwrap(), None);
    assert_eq!(
        store.get(&paths, "alpha").unwrap().unwrap().token,
        "legacy-token",
    );

    assert_eq!(
        store.store_sip_password(&paths, &sip_password).unwrap(),
        SecretBackend::Keychain,
    );
    assert_eq!(MEMORY_KEYCHAIN.lock().unwrap().len(), 1);
    assert!(MEMORY_KEYCHAIN
        .lock()
        .unwrap()
        .contains_key(VAULT_ENTRY_ACCOUNT));
    assert_eq!(
        store.load_sip_password(&paths).unwrap(),
        Some((sip_password.clone(), SecretBackend::Keychain)),
    );
    assert_eq!(
        store.get(&paths, "alpha").unwrap().unwrap().token,
        "legacy-token",
    );

    store.delete_sip_password(&paths).unwrap();
    assert_eq!(store.load_sip_password(&paths).unwrap(), None);
    assert_eq!(
        store.get(&paths, "alpha").unwrap().unwrap().token,
        "legacy-token",
    );
    let persisted = MEMORY_KEYCHAIN
        .lock()
        .unwrap()
        .get(VAULT_ENTRY_ACCOUNT)
        .cloned()
        .unwrap();
    assert!(!persisted.contains("sipPassword"));
}

#[test]
fn windows_stores_sip_password_under_dedicated_entry_and_file_fallback() {
    let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    reset_windows_memory_keychain();
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());
    let store = SecretStore::with_windows_keychain(windows_memory_keychain());
    let sip_password = generate_token();
    let fallback_password = generate_token();

    assert_eq!(
        store.store_sip_password(&paths, &sip_password).unwrap(),
        SecretBackend::Keychain,
    );
    assert_eq!(
        WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entries
            .get(WINDOWS_SIP_PASSWORD_ACCOUNT)
            .map(String::as_str),
        Some(sip_password.as_str()),
    );
    assert_eq!(
        store.load_sip_password(&paths).unwrap(),
        Some((sip_password.clone(), SecretBackend::Keychain)),
    );
    store.delete_sip_password(&paths).unwrap();
    assert_eq!(store.load_sip_password(&paths).unwrap(), None);

    WINDOWS_MEMORY_KEYCHAIN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .reject_all_sets = true;
    assert_eq!(
        store
            .store_sip_password(&paths, &fallback_password)
            .unwrap(),
        SecretBackend::File,
    );
    assert!(paths.sip_secret_file_path().is_file());
    assert_eq!(
        store.load_sip_password(&paths).unwrap(),
        Some((fallback_password.clone(), SecretBackend::File)),
    );
    store.delete_sip_password(&paths).unwrap();
    assert!(!paths.sip_secret_file_path().exists());
    assert_eq!(store.load_sip_password(&paths).unwrap(), None);
}

#[test]
fn windows_recovers_oversized_sip_passwords_without_blocking_workspace_credentials() {
    let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    for sip_read_first in [false, true] {
        reset_windows_memory_keychain();
        WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .max_password_bytes = Some(MAX_WINDOWS_CREDENTIAL_UTF16_UNITS * 2);
        let directory = tempdir().unwrap();
        let paths = AppPaths::for_tests(directory.path().to_path_buf());
        let file = SecretStore::file_backend_for_tests();
        let token = file.get_or_create(&paths, "alpha").unwrap().token;
        let mut password = generate_token().repeat(32);
        password.truncate(MAX_WINDOWS_CREDENTIAL_UTF16_UNITS + 1);
        file.store_sip_password(&paths, &password).unwrap();

        let native = SecretStore::with_windows_keychain(windows_memory_keychain());
        if sip_read_first {
            assert_eq!(
                native.load_sip_password(&paths).unwrap(),
                Some((password.clone(), SecretBackend::File)),
            );
        }
        let (credential, created) = native.get_or_create_with_status(&paths, "alpha").unwrap();
        assert!(!created);
        assert_eq!(credential.token, token);
        assert_eq!(credential.backend, SecretBackend::Keychain);
        assert!(!paths.secret_vault_file_path().exists());
        assert!(paths.sip_secret_file_path().exists());
        assert!(!WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entries
            .contains_key(WINDOWS_SIP_PASSWORD_ACCOUNT));
        let restarted = SecretStore::with_windows_keychain(windows_memory_keychain());
        assert_eq!(
            restarted.load_sip_password(&paths).unwrap(),
            Some((password, SecretBackend::File)),
        );
        assert_eq!(
            restarted.get(&paths, "alpha").unwrap().unwrap().token,
            token,
        );
    }
}

#[test]
fn windows_moves_sip_passwords_between_native_capacity_and_private_fallback() {
    let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    reset_windows_memory_keychain();
    let directory = tempdir().unwrap();
    let paths = AppPaths::for_tests(directory.path().to_path_buf());
    let store = SecretStore::with_windows_keychain(windows_memory_keychain());
    let small = generate_token();
    store.store_sip_password(&paths, &small).unwrap();
    let large = format!(
        "{small}{}",
        "𐀀".repeat(MAX_WINDOWS_CREDENTIAL_UTF16_UNITS / 2),
    );
    assert_eq!(
        store.store_sip_password(&paths, &large).unwrap(),
        SecretBackend::File,
    );
    assert_eq!(
        store.load_sip_password(&paths).unwrap(),
        Some((large, SecretBackend::File)),
    );
    assert!(!WINDOWS_MEMORY_KEYCHAIN
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entries
        .contains_key(WINDOWS_SIP_PASSWORD_ACCOUNT));
    assert_eq!(
        store.store_sip_password(&paths, &small).unwrap(),
        SecretBackend::Keychain,
    );
    assert!(!paths.sip_secret_file_path().exists());
    assert_eq!(
        store.load_sip_password(&paths).unwrap(),
        Some((small, SecretBackend::Keychain)),
    );
}

#[test]
fn windows_failed_native_retirement_restores_the_previous_sip_fallback() {
    let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    for previous_fallback in [false, true] {
        reset_windows_memory_keychain();
        let directory = tempdir().unwrap();
        let paths = AppPaths::for_tests(directory.path().to_path_buf());
        let store = SecretStore::with_windows_keychain(windows_memory_keychain());
        let previous = generate_token();
        store.store_sip_password(&paths, &previous).unwrap();
        if previous_fallback {
            atomic_private_write(
                &paths.sip_secret_file_path(),
                &serde_json::to_vec(&serde_json::json!({ "sipPassword": previous })).unwrap(),
            )
            .unwrap();
        }
        WINDOWS_MEMORY_KEYCHAIN
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .fail_deletes
            .insert(WINDOWS_SIP_PASSWORD_ACCOUNT.to_string());
        let oversized = generate_token().repeat(32);
        assert!(store.store_sip_password(&paths, &oversized).is_err());
        assert_eq!(
            store.load_sip_password(&paths).unwrap(),
            Some((previous.clone(), SecretBackend::Keychain)),
        );
        if previous_fallback {
            let saved: serde_json::Value =
                serde_json::from_slice(&std::fs::read(paths.sip_secret_file_path()).unwrap())
                    .unwrap();
            assert_eq!(saved["sipPassword"], previous);
        } else {
            assert!(!paths.sip_secret_file_path().exists());
        }
    }
}

#[test]
fn rejects_invalid_sip_passwords() {
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());
    let store = file_store();
    let generated = generate_token();
    for invalid in [
        String::new(),
        String::new() + "   ",
        generated.clone() + "\nline",
        generated.clone() + "\rline",
        generated.clone() + "\0null",
        generated.repeat(MAX_TOKEN_BYTES),
    ] {
        assert!(store.store_sip_password(&paths, &invalid).is_err());
    }
}

#[test]
fn windows_preserves_sip_password_when_switching_from_the_file_backend() {
    let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    for native_sip_write_fails in [false, true] {
        reset_windows_memory_keychain();
        let directory = tempdir().unwrap();
        let paths = AppPaths::for_tests(directory.path().to_path_buf());
        let file = SecretStore::file_backend_for_tests();
        let password = generate_token();
        let token = file.get_or_create(&paths, "alpha").unwrap().token;
        file.store_sip_password(&paths, &password).unwrap();
        if native_sip_write_fails {
            WINDOWS_MEMORY_KEYCHAIN
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .fail_sets
                .insert(WINDOWS_SIP_PASSWORD_ACCOUNT.to_string());
        }
        let native = SecretStore::with_windows_keychain(windows_memory_keychain());
        let backend = if native_sip_write_fails {
            SecretBackend::File
        } else {
            SecretBackend::Keychain
        };
        assert_eq!(
            native.load_sip_password(&paths).unwrap(),
            Some((password.clone(), backend)),
        );
        assert!(!paths.secret_vault_file_path().exists());
        assert_eq!(native.get(&paths, "alpha").unwrap().unwrap().token, token);
        let restarted = SecretStore::with_windows_keychain(windows_memory_keychain());
        assert_eq!(
            restarted.load_sip_password(&paths).unwrap(),
            Some((password, backend)),
        );
        restarted.delete_sip_password(&paths).unwrap();
        assert_eq!(restarted.load_sip_password(&paths).unwrap(), None);
        assert_eq!(
            restarted.get(&paths, "alpha").unwrap().unwrap().token,
            token,
        );
    }
}

#[test]
fn windows_profile_migration_keeps_the_shared_sip_secret_until_it_is_persisted() {
    let _serial = WINDOWS_MEMORY_KEYCHAIN_TEST
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    reset_windows_memory_keychain();
    let directory = tempdir().unwrap();
    let paths = AppPaths::for_tests(directory.path().to_path_buf());
    let file = SecretStore::file_backend_for_tests();
    let password = generate_token();
    let token = file.get_or_create(&paths, "alpha").unwrap().token;
    file.store_sip_password(&paths, &password).unwrap();
    let native = SecretStore::with_windows_keychain(windows_memory_keychain());
    native
        .ensure_profiles(&paths, &["alpha".to_string()])
        .unwrap();
    assert!(!paths.secret_vault_file_path().exists());
    assert_eq!(native.get(&paths, "alpha").unwrap().unwrap().token, token);
    assert_eq!(
        native.load_sip_password(&paths).unwrap(),
        Some((password, SecretBackend::Keychain)),
    );
}
