use super::{
    allocate_broker_replacement_ports, allocate_port_pair, allocate_preview_port,
    contains_bundled_bridge, format_host, platform, port_is_bindable, runtime_target,
    runtime_target_for, validate_workspace, wildcard_port_is_bindable, AppConfig, AppPaths,
    BTreeMap, BridgeRuntimeConfig, Path, PathBuf, Profile, RuntimePaths, SecretBackend,
    TcpListener,
};
use crate::store::ProfileAgent;
use tempfile::tempdir;

fn profile(profile_id: &str, workspace: &Path, port: u16) -> Profile {
    Profile {
        profile_id: profile_id.to_string(),
        workspace: workspace.to_path_buf(),
        network_mode: "local".to_string(),
        bridge_host: "127.0.0.1".to_string(),
        bridge_port: port,
        preview_port: port + 1,
        connect_url: format!("http://127.0.0.1:{port}"),
        preview_connect_url: format!("http://127.0.0.1:{}", port + 1),
        auto_start: false,
        allow_query_token_auth: true,
        acp_initialize_timeout_ms: 15_000,
        agent: ProfileAgent {
            agent_id: "echo".to_string(),
            display_name: "Echo".to_string(),
            executable: PathBuf::from("/bin/echo"),
            launcher_path: None,
            argv: vec!["acp".to_string()],
            resolved_version: "local".to_string(),
            verified_digest: "sha256:abc".to_string(),
        },
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

#[test]
fn runtime_config_debug_redacts_credentials_and_environment_values() {
    let config = BridgeRuntimeConfig {
        values: BTreeMap::from([
            (
                "BRIDGE_AUTH_TOKEN".to_string(),
                "token-for-test".to_string(),
            ),
            (
                "OTHER_SETTING".to_string(),
                "environment-secret".to_string(),
            ),
        ]),
        host: "127.0.0.1".to_string(),
        port: 8787,
        connect_url: "http://127.0.0.1:8787".to_string(),
        auth_token: "token-for-test".to_string(),
        secret_backend: SecretBackend::File,
    };
    for output in [format!("{config:?}"), format!("{config:#?}")] {
        assert!(!output.contains("token-for-test"));
        assert!(!output.contains("environment-secret"));
        assert!(output.contains("[REDACTED]"));
        assert!(output.contains("127.0.0.1"));
    }
}

#[test]
fn builds_a_child_environment_without_writing_the_token_to_disk() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let profile = profile("alpha-000000000001", workspace.path(), 18787);
    paths.prepare_profile(&profile.profile_id).unwrap();
    std::fs::write(paths.manifest_path(&profile.profile_id), b"{}").unwrap();

    let config =
        BridgeRuntimeConfig::from_profile(&profile, "secret", SecretBackend::File, &paths).unwrap();

    assert_eq!(config.values["BRIDGE_AUTH_TOKEN"], "secret");
    assert_eq!(config.values["BRIDGE_PORT"], "18787");
    assert_eq!(config.values["BRIDGE_PREVIEW_PORT"], "18788");
    assert_eq!(
        config.values["BRIDGE_STATE_DIR"],
        paths.state_dir(&profile.profile_id).to_str().unwrap(),
    );
    assert_eq!(
        config.values["BRIDGE_ATTACHMENTS_DIR"],
        paths.attachments_dir(&profile.profile_id).to_str().unwrap(),
    );
    assert!(!workspace.path().join(".env.secure").exists());
}

#[test]
fn rejects_a_profile_whose_manifest_disappeared() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let profile = profile("alpha-000000000001", workspace.path(), 18787);

    let error = BridgeRuntimeConfig::from_profile(&profile, "secret", SecretBackend::File, &paths)
        .unwrap_err();
    assert!(error.to_string().contains("manifest"));
}

#[test]
fn builds_ipv6_pairing_payload() {
    let config = BridgeRuntimeConfig {
        values: BTreeMap::new(),
        host: "::1".to_string(),
        port: 8787,
        connect_url: "http://[::1]:8787".to_string(),
        auth_token: "secret".to_string(),
        secret_backend: SecretBackend::Keychain,
    };

    let payload: serde_json::Value =
        serde_json::from_str(&config.pairing_payload("workspace-1").unwrap()).unwrap();
    assert_eq!(payload["type"], "dappercode-bridge-pair");
    assert_eq!(payload["workspaceId"], "workspace-1");
    assert_eq!(payload["brokerProtocolVersion"], 1);
    assert_eq!(payload["bridgeToken"], "secret");
}

#[test]
fn allocates_a_free_pair_that_skips_ports_owned_by_other_profiles() {
    let workspace = tempdir().unwrap();
    let mut config = AppConfig::empty();
    config.upsert(profile("beta-000000000002", workspace.path(), 18801));

    let (bridge, preview) = allocate_port_pair(
        &config,
        "alpha-000000000001",
        "127.0.0.1",
        Some(18801),
        false,
    )
    .unwrap();
    assert_eq!(preview, bridge + 1);
    assert!(bridge > 18802, "expected to skip the reserved pair");
}

#[test]
fn reuses_the_requested_pair_when_nothing_else_claims_it() {
    let config = AppConfig::empty();
    let (bridge, preview) = allocate_port_pair(
        &config,
        "alpha-000000000001",
        "127.0.0.1",
        Some(18901),
        false,
    )
    .unwrap();
    assert_eq!((bridge, preview), (18901, 18902));
}

#[test]
fn rejects_an_explicit_port_that_another_workspace_owns() {
    let workspace = tempdir().unwrap();
    let mut config = AppConfig::empty();
    config.upsert(profile("beta-000000000002", workspace.path(), 18811));

    let error = allocate_port_pair(
        &config,
        "alpha-000000000001",
        "127.0.0.1",
        Some(18811),
        true,
    )
    .unwrap_err();
    assert!(error
        .to_string()
        .contains("already assigned to the workspace"));
    assert!(error
        .to_string()
        .contains(&workspace.path().display().to_string()));
}

#[test]
fn brackets_ipv6_hosts_for_urls() {
    assert_eq!(format_host("fd00::1"), "[fd00::1]");
    assert_eq!(format_host("127.0.0.1"), "127.0.0.1");
}

#[test]
fn rejects_a_profile_that_cannot_produce_a_usable_environment() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let base = profile("alpha-000000000001", workspace.path(), 18787);
    paths.prepare_profile(&base.profile_id).unwrap();
    std::fs::write(paths.manifest_path(&base.profile_id), b"{}").unwrap();

    let blank_token =
        BridgeRuntimeConfig::from_profile(&base, "   ", SecretBackend::File, &paths).unwrap_err();
    assert!(blank_token.to_string().contains("token"));

    let mut zero_port = base.clone();
    zero_port.bridge_port = 0;
    assert!(
        BridgeRuntimeConfig::from_profile(&zero_port, "secret", SecretBackend::File, &paths)
            .unwrap_err()
            .to_string()
            .contains("invalid bridge port"),
    );

    let mut zero_preview = base.clone();
    zero_preview.preview_port = 0;
    assert!(
        BridgeRuntimeConfig::from_profile(&zero_preview, "s", SecretBackend::File, &paths).is_err(),
    );

    let mut missing_workspace = base.clone();
    missing_workspace.workspace = workspace.path().join("gone");
    assert!(BridgeRuntimeConfig::from_profile(
        &missing_workspace,
        "s",
        SecretBackend::File,
        &paths
    )
    .unwrap_err()
    .to_string()
    .contains("no longer exists"));

    let mut missing_agent = base;
    missing_agent.agent.executable = workspace.path().join("gone").join("agent");
    assert!(
        BridgeRuntimeConfig::from_profile(&missing_agent, "s", SecretBackend::File, &paths)
            .unwrap_err()
            .to_string()
            .contains("no longer installed"),
    );
}

#[test]
fn validates_that_a_workspace_is_an_existing_directory() {
    let temp = tempdir().unwrap();
    assert_eq!(
        validate_workspace(temp.path()).unwrap(),
        temp.path().canonicalize().unwrap(),
    );
    assert!(validate_workspace(&temp.path().join("missing"))
        .unwrap_err()
        .to_string()
        .contains("workspace does not exist"));

    let file = temp.path().join("file.txt");
    std::fs::write(&file, b"x").unwrap();
    assert!(validate_workspace(&file)
        .unwrap_err()
        .to_string()
        .contains("must be a directory"));
}

#[test]
fn refuses_to_allocate_when_the_port_range_is_exhausted() {
    let config = AppConfig::empty();
    let error = allocate_port_pair(
        &config,
        "alpha-000000000001",
        "127.0.0.1",
        Some(u16::MAX),
        false,
    )
    .unwrap_err();
    assert!(error.to_string().contains("no free bridge port pair"));

    assert!(allocate_port_pair(
        &config,
        "alpha-000000000001",
        "127.0.0.1",
        Some(u16::MAX),
        true
    )
    .is_err());
}

#[test]
fn rejects_an_explicit_pair_that_a_process_already_holds() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let taken = listener.local_addr().unwrap().port();
    let config = AppConfig::empty();

    let error = allocate_port_pair(
        &config,
        "alpha-000000000001",
        "127.0.0.1",
        Some(taken),
        true,
    )
    .unwrap_err();
    assert!(error.to_string().contains("already in use"));
}

#[test]
fn defaults_to_the_standard_pair_when_no_port_is_requested() {
    let config = AppConfig::empty();
    let (bridge, preview) =
        allocate_port_pair(&config, "alpha-000000000001", "127.0.0.1", None, false).unwrap();
    assert_eq!(preview, bridge + 1);
    assert!(bridge >= 8787);
}

#[test]
fn falls_back_to_the_wildcard_probe_for_an_unresolvable_host() {
    assert!(port_is_bindable(
        "dappercode.invalid.example",
        wildcard_free_port()
    ));
}

#[test]
fn discovers_runtime_resources_from_an_explicit_package_root() {
    let temp = tempdir().unwrap();

    // A candidate that holds neither a bundled binary nor a bridge source tree is skipped, and
    // discovery falls through to the repository checkout this test runs from.
    let _package_root = crate::test_env::set("DAPPERCODE_PACKAGE_ROOT", temp.path());
    let runtime = RuntimePaths::discover().unwrap();
    assert_ne!(runtime.package_root, temp.path());

    std::fs::create_dir_all(temp.path().join("services/rust-bridge")).unwrap();
    std::fs::write(temp.path().join("services/rust-bridge/Cargo.toml"), b"x").unwrap();
    let runtime = RuntimePaths::discover().unwrap();
    assert_eq!(runtime.package_root, temp.path().canonicalize().unwrap());

    let candidates = runtime.bridge_binary_candidates();
    assert!(candidates.iter().any(
        |candidate| candidate.ends_with(Path::new("bin").join(platform::bridge_binary_name()))
    ));
    assert!(runtime_target().is_some(), "this platform should be mapped");

    let managed_target = temp.path().join("managed-target");
    let _target_dir = crate::test_env::set("CARGO_TARGET_DIR", &managed_target);
    let candidates = runtime.bridge_binary_candidates();
    assert!(candidates
        .iter()
        .filter(|candidate| candidate.starts_with(&managed_target))
        .filter_map(|candidate| candidate.parent())
        .any(|parent| parent.ends_with("release")));

    // A package root that cannot be canonicalized is skipped rather than failing discovery.
    let _missing = crate::test_env::set("DAPPERCODE_PACKAGE_ROOT", temp.path().join("missing"));
    assert!(RuntimePaths::discover().is_ok());
}

#[test]
fn recognizes_the_windows_release_bridge_and_arm64_runtime() {
    let temp = tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join("bin")).unwrap();
    std::fs::write(temp.path().join("bin/dappercode-bridge.exe"), b"bridge").unwrap();

    assert!(contains_bundled_bridge(temp.path()));
    assert_eq!(
        runtime_target_for("windows", "aarch64"),
        Some("win32-arm64"),
    );
    assert_eq!(runtime_target_for("windows", "x86_64"), Some("win32-x64"));
}

#[test]
fn discovers_windows_runtime_from_operator_bin_layouts() {
    assert_eq!(
        platform::windows_support::windows_runtime_candidates(Path::new(
            "package/bin/dappercode.exe"
        ))[0],
        PathBuf::from("package"),
    );
    assert_eq!(
        platform::windows_support::windows_runtime_candidates(Path::new(
            "package/runtime/bin/dappercode.exe"
        ))[0],
        PathBuf::from("package/runtime"),
    );
}

#[test]
fn rejects_configuration_values_containing_control_characters() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let mut profile = profile("alpha-000000000001", workspace.path(), 18791);
    profile.connect_url = "http://127.0.0.1\nBRIDGE_AUTH_TOKEN=stolen".to_string();
    paths.prepare_profile(&profile.profile_id).unwrap();
    std::fs::write(paths.manifest_path(&profile.profile_id), b"{}").unwrap();

    let error = BridgeRuntimeConfig::from_profile(&profile, "secret", SecretBackend::File, &paths)
        .unwrap_err();
    assert!(error.to_string().contains("control character"));
}

#[test]
fn leaves_an_already_bracketed_ipv6_host_alone() {
    assert_eq!(format_host("[fd00::1]"), "[fd00::1]");
}

#[test]
fn rejects_an_explicit_port_whose_preview_slot_another_workspace_owns() {
    let workspace = tempdir().unwrap();
    let mut config = AppConfig::empty();
    config.upsert(profile("beta-000000000002", workspace.path(), 18861));

    // 18860 is free, but its preview slot 18861 belongs to the other workspace.
    let error = allocate_port_pair(
        &config,
        "alpha-000000000001",
        "127.0.0.1",
        Some(18860),
        true,
    )
    .unwrap_err();
    assert!(error.to_string().contains("18861"));
}

#[test]
fn preview_allocation_skips_migrated_broker_alias_ports() {
    let alias_port = wildcard_free_port();
    let mut broker = crate::store::BrokerSettings::new(
        "local".to_string(),
        "127.0.0.1".to_string(),
        8787,
        8788,
        "http://127.0.0.1:8787".to_string(),
        "http://127.0.0.1:8788".to_string(),
    )
    .unwrap();
    broker
        .legacy_bridge_endpoints
        .push(crate::store::BrokerEndpoint {
            host: "127.0.0.1".to_string(),
            port: alias_port,
        });
    let config = AppConfig {
        broker: Some(broker),
        ..AppConfig::empty()
    };

    assert_ne!(
        allocate_preview_port(&config, "new-profile", "127.0.0.1", alias_port).unwrap(),
        alias_port,
    );
}

fn wildcard_free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

#[test]
fn treats_a_host_that_is_not_local_as_probeable_via_the_wildcard_address() {
    // 192.0.2.1 is TEST-NET-1 and is never assigned to a local interface, so binding it fails
    // with AddrNotAvailable rather than AddrInUse.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let taken = listener.local_addr().unwrap().port();
    assert!(port_is_bindable("192.0.2.1", taken) == wildcard_port_is_bindable(taken));

    let config = AppConfig::empty();
    let (bridge, preview) = allocate_port_pair(
        &config,
        "alpha-000000000001",
        "192.0.2.1",
        Some(18941),
        false,
    )
    .unwrap();
    assert_eq!((bridge, preview), (18941, 18942));
}

#[test]
fn skips_a_port_that_another_process_already_holds() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let taken = listener.local_addr().unwrap().port();
    assert!(!port_is_bindable("127.0.0.1", taken));

    let config = AppConfig::empty();
    let (bridge, _) = allocate_port_pair(
        &config,
        "alpha-000000000001",
        "127.0.0.1",
        Some(taken),
        false,
    )
    .unwrap();
    assert_ne!(bridge, taken);
}

#[test]
fn broker_replacement_ignores_shared_bridge_copies_but_keeps_preview_reservations() {
    let first = tempdir().unwrap();
    let second = tempdir().unwrap();
    let mut config = AppConfig {
        profiles: vec![
            profile("alpha-000000000001", first.path(), 18_871),
            profile("beta-000000000002", second.path(), 18_871),
        ],
        ..AppConfig::empty()
    };
    config.profiles[0].preview_port = 18_872;
    config.profiles[1].preview_port = 18_873;

    assert_eq!(
        allocate_broker_replacement_ports(&config, "127.0.0.1", 18_871, 18_872, Some(18_871),)
            .unwrap(),
        (18_871, 18_872),
    );
    assert!(
        allocate_broker_replacement_ports(&config, "127.0.0.1", 18_871, 18_872, Some(18_873),)
            .unwrap_err()
            .to_string()
            .contains("browser preview"),
    );
}

#[test]
fn apply_phone_call_populates_exact_worker_env_keys_and_redacts_debug_output() {
    use crate::{PhoneCallSettings, SecretStore};
    let directory = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(directory.path().to_path_buf());
    let secrets = SecretStore::file_backend_for_tests();
    let mut config = BridgeRuntimeConfig {
        values: BTreeMap::new(),
        host: "127.0.0.1".to_string(),
        port: 8787,
        connect_url: "http://127.0.0.1:8787".to_string(),
        auth_token: "bridge-token".to_string(),
        secret_backend: SecretBackend::File,
    };
    let settings = PhoneCallSettings {
        sip_server: "sip.telnyx.com:5061".to_string(),
        sip_transport: "tls".to_string(),
        sip_username: "sip-user".to_string(),
        caller_id: "+15559876543".to_string(),
        user_display_name: "Operator User".to_string(),
        stt_base_url: "http://127.0.0.1:11434/v1".to_string(),
        stt_model: "gemma4:e4b".to_string(),
        llm_base_url: "http://localhost:11434/v1".to_string(),
        llm_model: "gemma4:e4b".to_string(),
        tts_base_url: "http://[::1]:11434/v1".to_string(),
        tts_model: "phonon".to_string(),
        tts_voice: "default".to_string(),
    };

    let sip_password = crate::secrets::generate_token();
    assert!(secrets
        .store_sip_password(&paths, &(sip_password.clone() + "\nline"))
        .is_err());
    assert!(config.values.is_empty());

    paths
        .configure_phone_call(&secrets, Some(&sip_password), |_| Ok(settings))
        .unwrap();
    config.apply_phone_call(&paths, &secrets).unwrap();
    assert_eq!(
        config.values["PHONE_CALL_SIP_SERVER"],
        "sip.telnyx.com:5061",
    );
    assert_eq!(config.values["PHONE_CALL_SIP_TRANSPORT"], "tls");
    assert_eq!(config.values["PHONE_CALL_SIP_USERNAME"], "sip-user");
    assert_eq!(config.values["PHONE_CALL_SIP_PASSWORD"], sip_password);
    assert_eq!(config.values["PHONE_CALL_CALLER_ID"], "+15559876543");
    assert_eq!(
        config.values["PHONE_CALL_USER_DISPLAY_NAME"],
        "Operator User",
    );
    assert_eq!(
        config.values["PHONE_CALL_STT_BASE_URL"],
        "http://127.0.0.1:11434/v1",
    );
    assert_eq!(config.values["PHONE_CALL_STT_MODEL"], "gemma4:e4b");
    assert_eq!(
        config.values["PHONE_CALL_LLM_BASE_URL"],
        "http://localhost:11434/v1",
    );
    assert_eq!(config.values["PHONE_CALL_LLM_MODEL"], "gemma4:e4b");
    assert_eq!(
        config.values["PHONE_CALL_TTS_BASE_URL"],
        "http://[::1]:11434/v1",
    );
    assert_eq!(config.values["PHONE_CALL_TTS_MODEL"], "phonon");
    assert_eq!(config.values["PHONE_CALL_TTS_VOICE"], "default");

    for debug_repr in [format!("{config:?}"), format!("{config:#?}")] {
        assert!(!debug_repr.contains(&sip_password));
        assert!(debug_repr.contains("[REDACTED]"));
    }
}
