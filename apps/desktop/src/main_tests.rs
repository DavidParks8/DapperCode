use super::{
    default_agent_args, option, owner_pid_arg, take_flag, unconfigured_snapshot,
    with_broker_log_path, AppPaths, CommandResponse, SecretStore,
};
use crate::voice::{clear_voice, configure_voice, voice_status};
use dappercode_desktop_core::BrokerSettings;
use tempfile::tempdir;

#[test]
fn parses_options_and_default_agent_args() {
    let mut args = vec!["--workspace".into(), "/tmp/project".into(), "tail".into()];
    assert_eq!(
        option(&mut args, "--workspace").as_deref(),
        Some("/tmp/project"),
    );
    assert_eq!(args, vec!["tail"]);
    assert_eq!(default_agent_args("opencode"), vec!["acp"]);

    let mut missing_value = vec!["--workspace".into()];
    assert_eq!(option(&mut missing_value, "--workspace"), None);
    assert_eq!(missing_value, vec!["--workspace"]);
}

#[test]
fn parses_and_validates_the_owner_pid() {
    let mut args = vec!["--owner-pid".into(), "4321".into()];
    assert_eq!(owner_pid_arg(&mut args).unwrap(), Some(4321));
    assert!(args.is_empty());

    assert_eq!(owner_pid_arg(&mut Vec::new()).unwrap(), None);
    assert!(owner_pid_arg(&mut vec!["--owner-pid".into(), "0".into()]).is_err());
    assert!(owner_pid_arg(&mut vec!["--owner-pid".into(), "nope".into()]).is_err());
}

#[test]
fn recognizes_the_stop_all_flag_without_consuming_other_arguments() {
    let mut args = vec!["--all".into(), "--workspace".into(), "/tmp/project".into()];
    assert!(take_flag(&mut args, "--all"));
    assert_eq!(
        option(&mut args, "--workspace").as_deref(),
        Some("/tmp/project"),
    );
    assert!(args.is_empty());
    assert!(!take_flag(&mut Vec::new(), "--all"));
}

#[test]
fn primary_operator_snapshot_opens_the_broker_log() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let snapshot = unconfigured_snapshot(workspace.path(), &paths).unwrap();

    assert_eq!(
        with_broker_log_path(snapshot, &paths).log_path,
        paths.broker_log_path(),
    );
}

#[test]
fn unconfigured_workspace_snapshot_exposes_the_shared_endpoint_without_pairing_data() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    paths
        .update_config(|config| {
            config.broker = Some(BrokerSettings::new(
                "local".to_string(),
                "192.168.1.20".to_string(),
                18_787,
                18_788,
                "http://192.168.1.20:18787".to_string(),
                "http://192.168.1.20:18788".to_string(),
            )?);
            Ok(())
        })
        .unwrap();

    let snapshot = unconfigured_snapshot(workspace.path(), &paths).unwrap();

    assert_eq!(snapshot.network_mode.as_deref(), Some("local"));
    assert_eq!(snapshot.bridge_host.as_deref(), Some("192.168.1.20"));
    assert_eq!(snapshot.bridge_port, Some(18_787));
    assert!(snapshot.pairing_payload.is_none());
    let json = serde_json::to_value(snapshot).unwrap();
    assert_eq!(json["networkMode"], "local");
    assert_eq!(json["bridgeHost"], "192.168.1.20");
    assert_eq!(json["bridgePort"], 18_787);
    assert!(json["pairingPayload"].is_null());
}

#[test]
fn voice_cli_configures_updates_reports_and_clears_without_leaking_sip_password() {
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let secrets = SecretStore::file_backend_for_tests();

    let initial = voice_status(&paths, &secrets).unwrap();
    assert!(!initial.configured);
    assert!(!initial.secret_present);
    assert!(initial.settings.is_none());

    let base_args = || {
        vec![
            "--sip-server".to_string(),
            "sip.telnyx.com:5061".to_string(),
            "--sip-username".to_string(),
            "telnyx-user".to_string(),
            "--caller-id".to_string(),
            "+15551234567".to_string(),
            "--display-name".to_string(),
            "David Parks".to_string(),
        ]
    };

    assert!(configure_voice(base_args(), std::io::empty(), &paths, &secrets).is_err());
    assert!(!paths.config_path().exists());

    let bad_e164 = vec![
        "--sip-server".into(),
        "sip.telnyx.com:5061".into(),
        "--sip-username".into(),
        "telnyx-user".into(),
        "--caller-id".into(),
        "5551234567".into(),
        "--display-name".into(),
        "David Parks".into(),
        "--sip-password-stdin".into(),
    ];
    assert!(configure_voice(
        bad_e164,
        std::io::Cursor::new(b"sip-pass-1\n"),
        &paths,
        &secrets,
    )
    .is_err());
    assert_eq!(secrets.load_sip_password(&paths).unwrap(), None);

    let bad_loopback = vec![
        "--sip-server".into(),
        "sip.telnyx.com:5061".into(),
        "--sip-username".into(),
        "telnyx-user".into(),
        "--caller-id".into(),
        "+15551234567".into(),
        "--display-name".into(),
        "David Parks".into(),
        "--llm-base-url".into(),
        "https://api.openai.com/v1".into(),
        "--sip-password-stdin".into(),
    ];
    assert!(configure_voice(
        bad_loopback,
        std::io::Cursor::new(b"sip-pass-1\n"),
        &paths,
        &secrets,
    )
    .is_err());

    let mut create_args = base_args();
    create_args.push("--sip-password-stdin".to_string());
    let configured = configure_voice(
        create_args,
        std::io::Cursor::new(b"sip-s3cr3t-value\r\n"),
        &paths,
        &secrets,
    )
    .unwrap();
    assert!(configured.configured);
    assert!(configured.secret_present);
    assert_eq!(configured.secret_backend.as_deref(), Some("file"));
    assert_eq!(
        secrets.load_sip_password(&paths).unwrap().unwrap().0,
        "sip-s3cr3t-value",
    );

    let json_out = serde_json::to_string(&CommandResponse {
        ok: true,
        result: &configured,
    })
    .unwrap();
    let human_out = serde_json::to_string_pretty(&configured).unwrap();
    let config_disk = std::fs::read_to_string(paths.config_path()).unwrap();
    for surface in [&json_out, &human_out, &config_disk] {
        assert!(!surface.contains("sip-s3cr3t-value"));
    }

    let updated = configure_voice(
        vec![
            "--stt-base-url".into(),
            "http://127.0.0.1:11501/v1".into(),
            "--stt-model".into(),
            "example-stt".into(),
            "--llm-base-url".into(),
            "http://localhost:11502/v1".into(),
            "--llm-model".into(),
            "example-voice".into(),
            "--tts-base-url".into(),
            "http://[::1]:11503/v1".into(),
            "--tts-model".into(),
            "example-tts".into(),
            "--tts-voice".into(),
            "warm".into(),
        ],
        std::io::empty(),
        &paths,
        &secrets,
    )
    .unwrap();
    assert!(updated.configured);
    assert_eq!(updated.settings.as_ref().unwrap().tts_voice, "warm");
    let settings = updated.settings.as_ref().unwrap();
    assert_eq!(settings.stt_base_url, "http://127.0.0.1:11501/v1");
    assert_eq!(settings.stt_model, "example-stt");
    assert_eq!(settings.llm_base_url, "http://localhost:11502/v1");
    assert_eq!(settings.llm_model, "example-voice");
    assert_eq!(settings.tts_base_url, "http://[::1]:11503/v1");
    assert_eq!(settings.tts_model, "example-tts");
    assert_eq!(
        updated.settings.as_ref().unwrap().sip_server,
        "sip.telnyx.com:5061",
    );
    assert_eq!(
        secrets.load_sip_password(&paths).unwrap().unwrap().0,
        "sip-s3cr3t-value",
    );

    let status = voice_status(&paths, &secrets).unwrap();
    assert_eq!(status, updated);

    configure_voice(
        vec![
            "--tts-model".into(),
            "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit".into(),
            "--tts-voice".into(),
            "conversational-female".into(),
        ],
        std::io::empty(),
        &paths,
        &secrets,
    )
    .unwrap();
    let preserved = configure_voice(
        vec!["--display-name".into(), "Updated Caller".into()],
        std::io::empty(),
        &paths,
        &secrets,
    )
    .unwrap()
    .settings
    .unwrap();
    assert_eq!(preserved.tts_voice, "conversational-female");
    assert_eq!(
        preserved.tts_model,
        "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit",
    );
    assert_eq!(preserved.sip_server, "sip.telnyx.com:5061");

    let cleared = clear_voice(&paths, &secrets).unwrap();
    assert!(!cleared.configured);
    assert!(!cleared.secret_present);
    assert!(cleared.settings.is_none());
    assert!(paths.load_config().unwrap().phone_call.is_none());
    assert_eq!(secrets.load_sip_password(&paths).unwrap(), None);
}
