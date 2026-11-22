use super::{
    parse_push_event_preferences, truncate_chars, BridgeError, PathBuf, PushDeviceRegistration,
    PushEventPreferences, PushRegistry, PushRegistryStore, PUSH_DEVICE_NAME_MAX_BYTES,
    PUSH_ID_MAX_BYTES, PUSH_PLATFORM_MAX_BYTES, PUSH_REGISTRY_FILE_NAME, PUSH_REGISTRY_MAX_BYTES,
    PUSH_REGISTRY_MAX_DEVICES, PUSH_TOKEN_MAX_BYTES,
};
use serde_json::json;
use std::fs;
use uuid::Uuid;

fn temp_dir() -> PathBuf {
    let path = std::env::temp_dir().join(format!("dappercode-push-{}", Uuid::new_v4()));
    fs::create_dir(&path).expect("create temporary directory");
    path
}

fn registration(profile: &str, id: &str, token: &str) -> PushDeviceRegistration {
    PushDeviceRegistration {
        profile_id: profile.to_string(),
        registration_id: id.to_string(),
        token: token.to_string(),
        platform: "ios".to_string(),
        device_name: "phone".to_string(),
        events: PushEventPreferences::default(),
        created_at: "created".to_string(),
        updated_at: "updated".to_string(),
    }
}

#[test]
fn registration_and_registry_debug_redact_push_tokens() {
    let device = registration("profile", "registration", "push-secret-for-test");
    let registry = PushRegistry {
        devices: vec![device.clone()],
    };
    for output in [
        format!("{device:?}"),
        format!("{device:#?}"),
        format!("{registry:?}"),
    ] {
        assert!(!output.contains("push-secret-for-test"));
        assert!(output.contains("[REDACTED]"));
    }
}

async fn register(
    store: &PushRegistryStore,
    profile: &str,
    id: &str,
    token: &str,
) -> Result<usize, BridgeError> {
    store
        .register(
            profile.to_string(),
            id.to_string(),
            token.to_string(),
            "ios".to_string(),
            "phone".to_string(),
            PushEventPreferences::default(),
        )
        .await
}

#[tokio::test]
async fn load_handles_missing_malformed_oversized_and_filtered_registries() {
    let dir = temp_dir();
    let store = PushRegistryStore::load(&dir).await;
    assert!(store.snapshot().await.devices.is_empty());

    let path = dir.join(PUSH_REGISTRY_FILE_NAME);
    fs::write(&path, b"not json").unwrap();
    assert!(PushRegistryStore::load(&dir)
        .await
        .snapshot()
        .await
        .devices
        .is_empty());

    fs::write(&path, vec![b'x'; PUSH_REGISTRY_MAX_BYTES + 1]).unwrap();
    assert!(PushRegistryStore::load(&dir)
        .await
        .snapshot()
        .await
        .devices
        .is_empty());

    let mut devices = vec![registration("profile", "valid", "token")];
    let mut invalid = registration("profile", "empty-token", "");
    devices.push(invalid);
    invalid = registration("", "empty-profile", "token-2");
    devices.push(invalid);
    invalid = registration("profile", "", "token-3");
    devices.push(invalid);
    invalid = registration(
        &"p".repeat(PUSH_ID_MAX_BYTES + 1),
        "long-profile",
        "token-4",
    );
    devices.push(invalid);
    invalid = registration("profile", &"r".repeat(PUSH_ID_MAX_BYTES + 1), "token-5");
    devices.push(invalid);
    invalid = registration(
        "profile",
        "long-token",
        &"t".repeat(PUSH_TOKEN_MAX_BYTES + 1),
    );
    devices.push(invalid);
    invalid = registration("profile", "long-platform", "token-6");
    invalid.platform = "p".repeat(PUSH_PLATFORM_MAX_BYTES + 1);
    devices.push(invalid);
    invalid = registration("profile", "long-name", "token-7");
    invalid.device_name = "n".repeat(PUSH_DEVICE_NAME_MAX_BYTES + 1);
    devices.push(invalid);
    for index in 0..PUSH_REGISTRY_MAX_DEVICES {
        devices.push(registration(
            "profile",
            &format!("extra-{index}"),
            &format!("token-extra-{index}"),
        ));
    }
    fs::write(
        &path,
        serde_json::to_vec(&PushRegistry { devices }).unwrap(),
    )
    .unwrap();
    let loaded = PushRegistryStore::load(&dir).await.snapshot().await;
    assert_eq!(loaded.devices.len(), PUSH_REGISTRY_MAX_DEVICES);
    assert_eq!(loaded.devices[0].registration_id, "valid");
    let _ = fs::remove_dir_all(dir);
}

#[tokio::test]
async fn register_updates_deduplicates_and_rejects_conflicts_and_limits() {
    let dir = temp_dir();
    let store = PushRegistryStore::load(&dir).await;
    assert_eq!(register(&store, "one", "first", "shared").await.unwrap(), 1);
    assert_eq!(
        register(&store, "one", "second", "shared").await.unwrap(),
        1,
    );
    assert_eq!(store.snapshot().await.devices[0].registration_id, "second");

    assert_eq!(
        register(&store, "one", "second", "updated").await.unwrap(),
        1,
    );
    let snapshot = store.snapshot().await;
    assert_eq!(snapshot.devices[0].token, "updated");
    assert!(register(&store, "other", "second", "nope").await.is_err());

    let mut full = Vec::new();
    for index in 0..PUSH_REGISTRY_MAX_DEVICES {
        full.push(registration(
            "profile",
            &format!("id-{index}"),
            &format!("token-{index}"),
        ));
    }
    *store.registry.write().await = PushRegistry { devices: full };
    assert!(register(&store, "profile", "overflow", "overflow")
        .await
        .is_err());
    let _ = fs::remove_dir_all(dir);
}

#[tokio::test]
async fn unregister_operations_persist_and_leave_state_unchanged_on_failure() {
    let dir = temp_dir();
    let store = PushRegistryStore::load(&dir).await;
    register(&store, "profile", "one", "token-one")
        .await
        .unwrap();
    register(&store, "profile", "two", "token-two")
        .await
        .unwrap();
    assert!(!store.unregister("other", "one").await.unwrap());
    assert!(store.unregister("profile", "one").await.unwrap());
    assert!(!store.unregister_token("missing").await.unwrap());
    assert!(store.unregister_token("token-two").await.unwrap());
    assert!(PushRegistryStore::load(&dir)
        .await
        .snapshot()
        .await
        .devices
        .is_empty());

    let missing = dir.join("missing");
    let broken = PushRegistryStore::load(&missing).await;
    assert!(register(&broken, "profile", "id", "token").await.is_err());
    assert!(broken.snapshot().await.devices.is_empty());
    let _ = fs::remove_dir_all(dir);
}

#[tokio::test]
async fn persistence_rejects_an_oversized_snapshot() {
    let dir = temp_dir();
    let store = PushRegistryStore::load(&dir).await;
    let snapshot = PushRegistry {
        devices: vec![registration(
            "profile",
            "id",
            &"x".repeat(PUSH_REGISTRY_MAX_BYTES),
        )],
    };
    assert!(store.persist_snapshot(&snapshot).await.is_err());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn preferences_use_defaults_for_missing_or_invalid_values() {
    let defaults = parse_push_event_preferences(None);
    assert!(defaults.turn_completed && defaults.approval_requested);
    let parsed = parse_push_event_preferences(Some(&json!({
        "turnCompleted": false,
        "approvalRequested": "invalid"
    })));
    assert!(!parsed.turn_completed && parsed.approval_requested);
}

#[test]
fn truncation_and_suffix_are_unicode_safe_at_boundaries() {
    assert_eq!(truncate_chars("short", 5), "short");
    assert_eq!(truncate_chars("abc", 0), "");
    assert_eq!(truncate_chars("ab  cd", 4), "ab…");
    assert_eq!(truncate_chars("éclair", 3), "éc…");
}
