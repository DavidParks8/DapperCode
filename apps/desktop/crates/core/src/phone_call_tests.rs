use super::{
    AppPaths, BridgeRuntimeConfig, PhoneCallSettings, SecretBackend, SecretStore,
    DEFAULT_VOICE_AUDIO_BASE_URL, DEFAULT_VOICE_STT_MODEL, DEFAULT_VOICE_TTS_MODEL,
    DEFAULT_VOICE_TTS_VOICE,
};
use crate::secrets::generate_token;
use crate::store::atomic_private_write;
use std::collections::BTreeMap;
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn realtime_voice_settings_persist_and_apply_to_bridge_runtime_config() {
    let directory = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(directory.path().to_path_buf());
    let secrets = SecretStore::file_backend_for_tests();
    let settings: PhoneCallSettings = serde_json::from_value(serde_json::json!({
        "sipServer": "sip.example.test:5061", "sipUsername": "test-account",
        "callerId": "+15551234567", "userDisplayName": "Example Caller",
        "ttsModel": DEFAULT_VOICE_TTS_MODEL, "ttsVoice": DEFAULT_VOICE_TTS_VOICE
    }))
    .unwrap();
    let secret = generate_token();
    paths
        .configure_phone_call(&secrets, Some(&secret), |_| Ok(settings.clone()))
        .unwrap();
    let mut runtime = BridgeRuntimeConfig {
        values: BTreeMap::new(),
        host: "127.0.0.1".to_string(),
        port: 8787,
        connect_url: "http://127.0.0.1:8787".to_string(),
        auth_token: generate_token(),
        secret_backend: SecretBackend::File,
    };
    runtime.apply_phone_call(&paths, &secrets).unwrap();
    assert_eq!(runtime.values["PHONE_CALL_TTS_MODEL"], settings.tts_model);
    assert_eq!(runtime.values["PHONE_CALL_TTS_VOICE"], settings.tts_voice);
    assert_eq!(paths.load_config().unwrap().phone_call, Some(settings));
}

#[test]
fn worker_phone_call_settings_and_password_wait_for_the_same_config_commit() {
    let directory = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(directory.path().to_path_buf());
    let secrets = SecretStore::file_backend_for_tests();
    let settings: PhoneCallSettings = serde_json::from_value(serde_json::json!({
        "sipServer": "sip.example.test:5061", "sipUsername": "old-account",
        "callerId": "+15551234567", "userDisplayName": "Example Caller"
    }))
    .unwrap();
    paths
        .configure_phone_call(&secrets, Some(&generate_token()), |_| Ok(settings))
        .unwrap();

    // Pause account reconfiguration after its secret write but before the config commit.
    let lease = paths.acquire_config_lease().unwrap();
    let next_password = generate_token();
    secrets.store_sip_password(&paths, &next_password).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (completed_tx, completed_rx) = mpsc::channel();
    let worker_paths = paths.clone();
    let worker = std::thread::spawn(move || {
        let mut runtime = BridgeRuntimeConfig {
            values: BTreeMap::new(),
            host: "127.0.0.1".to_string(),
            port: 8787,
            connect_url: "http://127.0.0.1:8787".to_string(),
            auth_token: generate_token(),
            secret_backend: SecretBackend::File,
        };
        entered_tx.send(()).unwrap();
        let outcome =
            runtime.apply_phone_call(&worker_paths, &SecretStore::file_backend_for_tests());
        completed_tx.send((outcome, runtime)).unwrap();
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let blocked = completed_rx.recv_timeout(Duration::from_millis(100));
    let mut next = paths.load_config().unwrap();
    next.phone_call.as_mut().unwrap().sip_username = "new-account".to_string();
    atomic_private_write(
        &paths.config_path(),
        &serde_json::to_vec_pretty(&next).unwrap(),
    )
    .unwrap();
    drop(lease);
    assert!(matches!(blocked, Err(mpsc::RecvTimeoutError::Timeout)));
    let (outcome, runtime) = completed_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    outcome.unwrap();
    worker.join().unwrap();
    assert_eq!(DEFAULT_VOICE_AUDIO_BASE_URL, "http://127.0.0.1:8000/v1");
    assert_eq!(DEFAULT_VOICE_STT_MODEL, "LiquidAI/LFM3-Audio-2B-GGUF:Q8_0");
    assert_eq!(DEFAULT_VOICE_TTS_MODEL, "LiquidAI/LFM3-Audio-2B-GGUF:Q8_0");
    assert_eq!(DEFAULT_VOICE_TTS_VOICE, "female");
    assert_eq!(runtime.values["PHONE_CALL_SIP_USERNAME"], "new-account");
    assert_eq!(runtime.values["PHONE_CALL_SIP_PASSWORD"], next_password);
    assert_eq!(
        runtime.values["PHONE_CALL_STT_BASE_URL"],
        "http://127.0.0.1:8000/v1",
    );
    assert_eq!(
        runtime.values["PHONE_CALL_STT_MODEL"],
        "LiquidAI/LFM3-Audio-2B-GGUF:Q8_0",
    );
    assert_eq!(
        runtime.values["PHONE_CALL_LLM_BASE_URL"],
        "http://127.0.0.1:8000/v1",
    );
    assert_eq!(
        runtime.values["PHONE_CALL_TTS_BASE_URL"],
        "http://127.0.0.1:8000/v1",
    );
    assert_eq!(
        runtime.values["PHONE_CALL_TTS_MODEL"],
        "LiquidAI/LFM3-Audio-2B-GGUF:Q8_0",
    );
    assert_eq!(runtime.values["PHONE_CALL_TTS_VOICE"], "female");
}
