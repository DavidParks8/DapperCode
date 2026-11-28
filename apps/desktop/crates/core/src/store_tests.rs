use super::{
    atomic_private_write, create_private_dir, fs, platform, profile_id_for, read_config,
    remove_file_if_exists, AppConfig, AppPaths, BrokerEndpoint, BrokerSettings, ConfigSideEffects,
    FileLease, Path, PathBuf, PhoneCallSettings, Profile, ProfileAgent, Result, CONFIG_VERSION,
};
use crate::phone_call::{
    DEFAULT_VOICE_AUDIO_BASE_URL, DEFAULT_VOICE_BASE_URL, DEFAULT_VOICE_LLM_MODEL,
    DEFAULT_VOICE_STT_MODEL, DEFAULT_VOICE_TTS_MODEL, DEFAULT_VOICE_TTS_VOICE,
};
use tempfile::tempdir;

struct FailingCommitSideEffects {
    marker: PathBuf,
    config_path: PathBuf,
    original_config: Vec<u8>,
    rolled_back: bool,
}

impl ConfigSideEffects for FailingCommitSideEffects {
    type Output = ();

    fn apply(&mut self) -> Result<Self::Output> {
        fs::write(&self.marker, b"applied")?;
        fs::remove_file(&self.config_path)?;
        fs::create_dir(&self.config_path)?;
        Ok(())
    }

    fn rollback(&mut self) -> Result<()> {
        fs::remove_dir(&self.config_path)?;
        atomic_private_write(&self.config_path, &self.original_config)?;
        remove_file_if_exists(&self.marker)?;
        self.rolled_back = true;
        Ok(())
    }
}

fn sample_profile(profile_id: &str, port: u16) -> Profile {
    Profile {
        profile_id: profile_id.to_string(),
        workspace: PathBuf::from("/tmp/project"),
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
            agent_id: "opencode".to_string(),
            display_name: "OpenCode".to_string(),
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
fn profile_ids_differ_per_worktree_and_stay_stable() {
    let first = profile_id_for(Path::new("/Users/dev/code/project"));
    let second = profile_id_for(Path::new("/Users/dev/worktrees/project"));
    assert_ne!(first, second);
    assert_eq!(first, profile_id_for(Path::new("/Users/dev/code/project")));
    assert_eq!(first, "project-41d136b16318");
    assert!(first.starts_with("project-"));
    assert!(profile_id_for(Path::new("/Users/dev/My Repo!")).starts_with("my-repo-"));
}

#[test]
fn round_trips_config_and_reports_other_profile_ports() {
    let temp = tempdir().unwrap();
    let paths = AppPaths {
        base: temp.path().to_path_buf(),
    };

    paths
        .update_config(|config| {
            config.upsert(sample_profile("alpha-000000000001", 8787));
            config.upsert(sample_profile("beta-000000000002", 8789));
            Ok(())
        })
        .unwrap();

    let config = paths.load_config().unwrap();
    assert_eq!(config.version, CONFIG_VERSION);
    assert_eq!(config.profiles.len(), 2);
    assert_eq!(config.find("alpha-000000000001").unwrap().bridge_port, 8787);

    let reserved: Vec<u16> = config
        .reserved_ports("alpha-000000000001")
        .into_iter()
        .map(|(port, _)| port)
        .collect();
    assert_eq!(reserved, vec![8789, 8790]);
}

#[test]
fn rewrites_an_existing_profile_instead_of_duplicating_it() {
    let temp = tempdir().unwrap();
    let paths = AppPaths {
        base: temp.path().to_path_buf(),
    };

    paths
        .update_config(|config| {
            config.upsert(sample_profile("alpha-000000000001", 8787));
            Ok(())
        })
        .unwrap();
    paths
        .update_config(|config| {
            config.upsert(sample_profile("alpha-000000000001", 9001));
            Ok(())
        })
        .unwrap();

    let config = paths.load_config().unwrap();
    assert_eq!(config.profiles.len(), 1);
    assert_eq!(config.profiles[0].bridge_port, 9001);
}

#[test]
fn persists_the_profile_autostart_intent_and_rejects_missing_current_fields() {
    let temp = tempdir().unwrap();
    let paths = AppPaths {
        base: temp.path().to_path_buf(),
    };

    paths
        .update_config(|config| {
            let mut profile = sample_profile("alpha-000000000001", 8787);
            profile.auto_start = true;
            config.upsert(profile);
            Ok(())
        })
        .unwrap();

    assert!(
        paths
            .load_config()
            .unwrap()
            .find("alpha-000000000001")
            .unwrap()
            .auto_start,
    );

    let mut incomplete =
        serde_json::to_value(sample_profile("incomplete-000000000002", 8789)).unwrap();
    incomplete.as_object_mut().unwrap().remove("autoStart");
    assert!(serde_json::from_value::<Profile>(incomplete).is_err());
}

#[test]
fn rejects_configuration_written_by_a_newer_version() {
    let temp = tempdir().unwrap();
    let path = temp.path().join("config.json");
    fs::write(&path, br#"{"version":99,"profiles":[]}"#).unwrap();
    assert!(read_config(&path)
        .unwrap_err()
        .to_string()
        .contains("unsupported DapperCode configuration version"));
}

#[test]
fn migrates_v1_profiles_to_one_deterministic_broker_endpoint() {
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());
    let mut alpha = sample_profile("alpha-000000000001", 8787);
    alpha.auto_start = false;
    let mut beta = sample_profile("beta-000000000002", 9797);
    beta.auto_start = true;
    beta.bridge_host = "192.168.1.20".to_string();
    beta.connect_url = "http://192.168.1.20:9797".to_string();
    beta.preview_connect_url = "http://192.168.1.20:9798".to_string();
    fs::write(
        paths.config_path(),
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 1,
            "profiles": [beta, alpha],
        }))
        .unwrap(),
    )
    .unwrap();

    assert!(paths.migrate_config().unwrap());
    assert!(!paths.migrate_config().unwrap());
    let migrated = paths.load_config().unwrap();
    let broker = migrated.broker.unwrap();
    assert_eq!(broker.bridge_port, 8787);
    assert_eq!(broker.preview_port, 8788);
    assert!(broker.auto_start);
    assert_eq!(
        broker.legacy_bridge_endpoints,
        vec![BrokerEndpoint {
            host: "192.168.1.20".to_string(),
            port: 9797,
        }],
    );
    assert_eq!(
        migrated
            .profiles
            .iter()
            .map(|profile| profile.profile_id.as_str())
            .collect::<Vec<_>>(),
        vec!["alpha-000000000001", "beta-000000000002"],
    );
    assert!(migrated.profiles.iter().all(|profile| {
        profile.bridge_port == 8787 && profile.connect_url == "http://127.0.0.1:8787"
    }));
    assert_eq!(
        migrated
            .profiles
            .iter()
            .map(|profile| profile.preview_port)
            .collect::<Vec<_>>(),
        vec![8788, 9798],
    );
    assert!(migrated
        .profiles
        .iter()
        .all(|profile| profile.preview_connect_url.starts_with("http://127.0.0.1:")));
}

#[test]
fn broker_settings_validate_all_resource_and_endpoint_boundaries() {
    let valid = BrokerSettings::new(
        "local".to_string(),
        "127.0.0.1".to_string(),
        8787,
        8788,
        "http://127.0.0.1:8787".to_string(),
        "http://127.0.0.1:8788".to_string(),
    )
    .unwrap();

    let mut invalid = valid.clone();
    invalid.bridge_port = 0;
    assert!(invalid.validate().is_err());
    let mut invalid = valid.clone();
    invalid.preview_port = 0;
    assert!(invalid.validate().is_err());
    let mut invalid = valid.clone();
    invalid.preview_port = invalid.bridge_port;
    assert!(invalid.validate().is_err());

    let mut invalid = valid.clone();
    invalid.host = " ".to_string();
    assert!(invalid.validate().is_err());
    let mut invalid = valid.clone();
    invalid.connect_url = " ".to_string();
    assert!(invalid.validate().is_err());
    let mut invalid = valid.clone();
    invalid.preview_connect_url = " ".to_string();
    assert!(invalid.validate().is_err());

    let mut invalid = valid.clone();
    invalid.legacy_bridge_endpoints = vec![BrokerEndpoint {
        host: " ".to_string(),
        port: 8789,
    }];
    assert!(invalid.validate().is_err());
    let mut invalid = valid.clone();
    invalid.legacy_bridge_endpoints = vec![BrokerEndpoint {
        host: "127.0.0.1".to_string(),
        port: 0,
    }];
    assert!(invalid.validate().is_err());

    let mut invalid = valid.clone();
    invalid.max_workers = 0;
    assert!(invalid.validate().is_err());
    let mut invalid = valid.clone();
    invalid.max_idle_workers = invalid.max_workers + 1;
    assert!(invalid.validate().is_err());
    let mut invalid = valid.clone();
    invalid.worker_idle_grace_ms = 0;
    assert!(invalid.validate().is_err());
    let mut invalid = valid.clone();
    invalid.worker_start_timeout_ms = 0;
    assert!(invalid.validate().is_err());

    let mut ipv6 = valid;
    ipv6.host = "::1".to_string();
    ipv6.connect_url = "http://[::1]:8787".to_string();
    let mut profile = sample_profile("ipv6-000000000003", 9797);
    ipv6.apply_endpoint(&mut profile);
    assert_eq!(profile.bridge_host, "::1");
    assert_eq!(profile.bridge_port, 8787);
    assert_eq!(profile.preview_connect_url, "http://[::1]:9798");

    ipv6.host = "[::1]".to_string();
    ipv6.apply_endpoint(&mut profile);
    assert_eq!(profile.preview_connect_url, "http://[::1]:9798");
}

#[test]
fn app_config_requires_broker_settings_and_tracks_profile_lifecycle() {
    let mut wrong_version = AppConfig::empty();
    wrong_version.version = CONFIG_VERSION + 1;
    assert!(wrong_version.validate().is_err());

    let mut missing_broker = AppConfig::empty();
    missing_broker
        .profiles
        .push(sample_profile("alpha-000000000001", 8787));
    assert!(missing_broker.validate().is_err());

    let mut config = AppConfig::empty();
    assert!(config.validate().is_ok());
    let mut alpha = sample_profile("alpha-000000000001", 8787);
    config.upsert(alpha.clone());
    assert!(config.broker.is_some());
    alpha.updated_at = "updated".to_string();
    config.upsert(alpha);
    config.upsert(sample_profile("beta-000000000002", 8787));
    assert_eq!(config.profiles.len(), 2);
    assert!(config.remove("alpha-000000000001"));
    assert!(config.broker.is_some());
    assert!(!config.remove("missing"));
    assert!(config.remove("beta-000000000002"));
    assert!(config.broker.is_none());
}

#[test]
fn prepares_current_profile_directories_without_legacy_runtime() {
    let temp = tempdir().unwrap();
    let paths = AppPaths {
        base: temp.path().to_path_buf(),
    };
    paths.prepare_profile("alpha-000000000001").unwrap();

    for directory in [
        paths.profile_dir("alpha-000000000001"),
        paths.state_dir("alpha-000000000001"),
        paths.attachments_dir("alpha-000000000001"),
    ] {
        assert!(directory.is_dir(), "{} should exist", directory.display());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&directory).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "{} should be private", directory.display());
        }
    }
    assert!(!paths
        .profile_dir("alpha-000000000001")
        .join("runtime")
        .exists());
}

#[test]
fn atomic_write_leaves_no_temporary_files_behind() {
    let temp = tempdir().unwrap();
    let path = temp.path().join("nested").join("state.json");
    atomic_private_write(&path, b"{}").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "{}\n");

    let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty());
}

#[test]
fn atomic_write_preserves_a_trailing_newline_it_was_given() {
    let temp = tempdir().unwrap();
    let path = temp.path().join("state.json");
    atomic_private_write(&path, b"{}\n").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "{}\n");
    assert!(atomic_private_write(Path::new("/"), b"{}").is_err());
}

#[test]
fn removing_a_missing_file_succeeds() {
    let temp = tempdir().unwrap();
    let path = temp.path().join("absent");
    remove_file_if_exists(&path).unwrap();

    fs::write(&path, b"x").unwrap();
    remove_file_if_exists(&path).unwrap();
    assert!(!path.exists());

    // A directory cannot be unlinked, so the error is surfaced rather than swallowed.
    assert!(remove_file_if_exists(temp.path())
        .unwrap_err()
        .to_string()
        .contains("failed to remove"));
}

#[cfg(unix)]
#[test]
fn locates_the_home_directory_or_explains_why_it_cannot() {
    {
        let _guard = crate::test_env::set("HOME", "/tmp/dappercode-home");
        assert_eq!(
            platform::home_dir().unwrap(),
            PathBuf::from("/tmp/dappercode-home"),
        );
    }
    {
        let _guard = crate::test_env::set("HOME", "");
        assert!(platform::home_dir()
            .unwrap_err()
            .to_string()
            .contains("HOME is not set"));
    }
    {
        let _guard = crate::test_env::unset("HOME");
        assert!(platform::home_dir().is_err());
    }
}

#[test]
fn surfaces_a_configuration_read_failure_that_is_not_a_missing_file() {
    let temp = tempdir().unwrap();
    // Reading a directory as a file fails with something other than NotFound.
    assert!(read_config(temp.path())
        .unwrap_err()
        .to_string()
        .contains("failed to read"));
}

#[test]
fn honours_the_data_directory_override_and_rejects_relative_paths() {
    let temp = tempdir().unwrap();

    {
        let _guard = crate::test_env::set("DAPPERCODE_DATA_DIR", temp.path());
        let paths = AppPaths::discover().unwrap();
        assert_eq!(paths.config_path(), temp.path().join("config.json"));
        assert_eq!(
            paths.config_lock_path(),
            temp.path().join("runtime").join("config.lock"),
        );
    }
    {
        let _guard = crate::test_env::set("DAPPERCODE_DATA_DIR", "relative/path");
        assert!(AppPaths::discover()
            .unwrap_err()
            .to_string()
            .contains("must be an absolute path"));
    }
    {
        // Only inspect the platform default; do not create the real user data directory.
        let _guard = crate::test_env::set("DAPPERCODE_DATA_DIR", "");
        assert!(platform::data_dir().unwrap().is_absolute());
    }
}

#[test]
fn removes_a_profile_only_when_it_exists() {
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());
    paths
        .update_config(|config| {
            config.upsert(sample_profile("alpha-000000000001", 8787));
            Ok(())
        })
        .unwrap();

    assert!(paths
        .update_config(|config| Ok(config.remove("alpha-000000000001")))
        .unwrap());
    assert!(!paths
        .update_config(|config| Ok(config.remove("alpha-000000000001")))
        .unwrap());
    let empty = paths.load_config().unwrap();
    assert!(empty.profiles.is_empty());
    assert!(empty.broker.is_none());
    assert!(paths
        .load_config()
        .unwrap()
        .find("alpha-000000000001")
        .is_none());
}

#[test]
fn reports_malformed_configuration_instead_of_silently_resetting_it() {
    let temp = tempdir().unwrap();
    let path = temp.path().join("config.json");
    fs::write(&path, b"{ not json").unwrap();
    assert!(read_config(&path)
        .unwrap_err()
        .to_string()
        .contains("invalid DapperCode configuration"));
}

#[test]
fn treats_an_absent_configuration_as_empty() {
    let temp = tempdir().unwrap();
    let config = read_config(&temp.path().join("absent.json")).unwrap();
    assert_eq!(config.version, CONFIG_VERSION);
    assert!(config.profiles.is_empty());
    assert!(config.reserved_ports("anything").is_empty());
}

#[test]
fn propagates_a_failed_configuration_mutation_without_writing() {
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());

    let error = paths
        .update_config(|_| Err::<(), _>(anyhow::anyhow!("mutation refused")))
        .unwrap_err();
    assert_eq!(error.to_string(), "mutation refused");
    assert!(!paths.config_path().exists());
}

#[test]
fn migration_is_a_noop_for_absent_and_current_empty_configuration() {
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());

    assert!(!paths.migrate_config().unwrap());
    paths.update_config(|_| Ok(())).unwrap();
    assert!(!paths.migrate_config().unwrap());
    AppConfig::empty().validate().unwrap();
    fs::remove_file(paths.config_path()).unwrap();
    fs::create_dir(paths.config_path()).unwrap();
    assert!(paths.migrate_config().is_err());
}

#[test]
fn configuration_commit_failure_rolls_back_staged_side_effects() {
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());
    paths
        .update_config(|config| {
            config.upsert(sample_profile("existing", 18_787));
            Ok(())
        })
        .unwrap();
    let original_config = fs::read(paths.config_path()).unwrap();
    let marker = temp.path().join("side-effect");
    let mut side_effects = FailingCommitSideEffects {
        marker: marker.clone(),
        config_path: paths.config_path(),
        original_config: original_config.clone(),
        rolled_back: false,
    };

    let error = paths
        .update_config_with_side_effects(
            |config| {
                config.upsert(sample_profile("new", 18_797));
                Ok(())
            },
            &mut side_effects,
        )
        .unwrap_err();

    assert!(!error.to_string().is_empty());
    assert!(side_effects.rolled_back);
    assert!(!marker.exists());
    assert_eq!(fs::read(paths.config_path()).unwrap(), original_config);
}

#[test]
fn post_commit_side_effects_keep_setup_from_racing_past_forget() {
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());
    let (side_effect_entered_tx, side_effect_entered_rx) = std::sync::mpsc::channel();
    let (release_side_effect_tx, release_side_effect_rx) = std::sync::mpsc::channel();
    let first_paths = paths.clone();
    let first = std::thread::spawn(move || {
        first_paths
            .update_config_then(
                |_| Ok(()),
                || {
                    side_effect_entered_tx.send(()).unwrap();
                    release_side_effect_rx.recv().unwrap();
                    Ok(())
                },
            )
            .unwrap();
    });
    side_effect_entered_rx.recv().unwrap();

    let (second_done_tx, second_done_rx) = std::sync::mpsc::channel();
    let second_paths = paths.clone();
    let second = std::thread::spawn(move || {
        second_paths.update_config(|_| Ok(())).unwrap();
        second_done_tx.send(()).unwrap();
    });
    assert!(second_done_rx
        .recv_timeout(std::time::Duration::from_millis(50))
        .is_err());

    release_side_effect_tx.send(()).unwrap();
    first.join().unwrap();
    second_done_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap();
    second.join().unwrap();
}

#[test]
fn sanitizes_workspace_names_into_readable_slugs() {
    assert!(profile_id_for(Path::new("/")).starts_with("workspace-"));
    assert!(profile_id_for(Path::new("/tmp/---")).starts_with("workspace-"));
    assert!(profile_id_for(Path::new("/tmp/UPPER Case")).starts_with("upper-case-"));
    let long = profile_id_for(Path::new(&format!("/tmp/{}", "a".repeat(80))));
    assert_eq!(long.split('-').next().unwrap().len(), 48);
}

#[test]
fn a_lock_cannot_be_taken_twice_but_is_released_on_drop() {
    let temp = tempdir().unwrap();
    let path = temp.path().join("runtime").join("config.lock");
    let lease = FileLease::acquire(&path).unwrap();
    drop(lease);
    FileLease::acquire(&path).unwrap();
    assert!(FileLease::acquire(temp.path()).is_err());
}

#[test]
fn tightens_permissions_on_an_over_shared_directory() {
    let temp = tempdir().unwrap();
    let path = temp.path().join("loose");
    fs::create_dir_all(&path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o777)).unwrap();
        create_private_dir(&path).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
        // Re-running must be a no-op rather than churning permissions.
        create_private_dir(&path).unwrap();
    }
    #[cfg(not(unix))]
    create_private_dir(&path).unwrap();
}

fn sample_phone_call_settings() -> PhoneCallSettings {
    PhoneCallSettings {
        sip_server: "sip.telnyx.com:5061".to_string(),
        sip_transport: "tls".to_string(),
        sip_username: "telnyx-user".to_string(),
        caller_id: "+15551234567".to_string(),
        user_display_name: "David Parks".to_string(),
        stt_base_url: DEFAULT_VOICE_AUDIO_BASE_URL.to_string(),
        stt_model: DEFAULT_VOICE_STT_MODEL.to_string(),
        llm_base_url: DEFAULT_VOICE_BASE_URL.to_string(),
        llm_model: DEFAULT_VOICE_LLM_MODEL.to_string(),
        tts_base_url: DEFAULT_VOICE_AUDIO_BASE_URL.to_string(),
        tts_model: DEFAULT_VOICE_TTS_MODEL.to_string(),
        tts_voice: DEFAULT_VOICE_TTS_VOICE.to_string(),
    }
}

#[test]
fn phone_call_settings_preserve_v2_config_compatibility_and_defaults() {
    let temp = tempdir().unwrap();
    let paths = AppPaths::for_tests(temp.path().to_path_buf());
    fs::write(paths.config_path(), br#"{"version":2,"profiles":[]}"#).unwrap();

    let loaded = paths.load_config().unwrap();
    assert!(loaded.phone_call.is_none());
    paths.update_config(|_| Ok(())).unwrap();
    let raw = fs::read_to_string(paths.config_path()).unwrap();
    assert!(!raw.contains("phoneCall"));

    let minimal: PhoneCallSettings = serde_json::from_value(serde_json::json!({
        "sipServer": "sip.telnyx.com:5061",
        "sipTransport": "udp",
        "sipUsername": "alice",
        "callerId": "+15551234567",
        "userDisplayName": "Alice",
    }))
    .unwrap();
    minimal.validate().unwrap();
    assert_eq!(minimal.stt_base_url, "http://127.0.0.1:8000/v1");
    assert_eq!(minimal.stt_model, "LiquidAI/LFM3-Audio-2B-GGUF:Q8_0");
    assert_eq!(minimal.llm_base_url, "http://127.0.0.1:8000/v1");
    assert_eq!(minimal.llm_model, "LiquidAI/LFM3-Audio-2B-GGUF:Q8_0");
    assert_eq!(minimal.tts_base_url, "http://127.0.0.1:8000/v1");
    assert_eq!(minimal.tts_model, "LiquidAI/LFM3-Audio-2B-GGUF:Q8_0");
    assert_eq!(minimal.tts_voice, "female");

    assert!(
        serde_json::from_value::<PhoneCallSettings>(serde_json::json!({
            "sipServer": "sip.telnyx.com:5061",
            "sipTransport": "tls",
            "sipUsername": "alice",
            "callerId": "+15551234567",
            "userDisplayName": "Alice",
            "sipPassword": "forbidden-secret-in-config"
        }))
        .is_err(),
    );
}

#[test]
fn phone_call_settings_validate_e164_sip_endpoints_and_loopback_urls() {
    let valid = sample_phone_call_settings();
    valid.validate().unwrap();

    for loopback in [
        "http://127.0.0.1:11434/v1",
        "https://localhost:11434/v1",
        "http://LOCALHOST/v1",
        "http://[::1]:11434/v1",
        "https://[::1]/v1",
    ] {
        let mut candidate = valid.clone();
        candidate.stt_base_url = loopback.to_string();
        candidate.llm_base_url = loopback.to_string();
        candidate.tts_base_url = loopback.to_string();
        candidate.validate().unwrap();
    }

    let mut ipv6_sip = valid.clone();
    ipv6_sip.sip_server = "[::1]:5060".to_string();
    ipv6_sip.sip_transport = "udp".to_string();
    ipv6_sip.validate().unwrap();

    for bad_caller_id in [
        "",
        "15551234567",
        "+123456",
        "+1234567890123456",
        "+1-555-123-4567",
        "+1555123456a",
    ] {
        let mut invalid = valid.clone();
        invalid.caller_id = bad_caller_id.to_string();
        assert!(
            invalid.validate().is_err(),
            "expected E.164 rejection for {bad_caller_id}",
        );
    }

    for bad_url in [
        "https://api.openai.com/v1",
        "http://192.168.1.20:11434/v1",
        "http://0.0.0.0:11434/v1",
        "http://127.0.0.2:11434/v1",
        "ftp://127.0.0.1:11434/v1",
        "http://127.0.0.1@evil.com:11434/v1",
        "http://127.0.0.1:0/v1",
        "http://[2001:db8::1]:11434/v1",
        "",
        &format!("http://127.0.0.1/{}", "v".repeat(1024)),
        "http://127.0.0.1:11434/\tv1",
        "http://127.0.0.1 :11434/v1",
        "127.0.0.1:11434/v1",
        "http:///v1",
        "http://[::2]/v1",
        "http://[::1/v1",
    ] {
        let mut invalid = valid.clone();
        invalid.llm_base_url = bad_url.to_string();
        assert!(
            invalid.validate().is_err(),
            "expected URL rejection for {bad_url}",
        );
    }

    for bad_server in [
        "",
        "sip.telnyx.com",
        "sip.telnyx.com:0",
        ":5061",
        "http://sip.telnyx.com:5061",
        "999.999.999.999:5060",
        "sip.telnyx.com:5061\n",
        &format!("{}.example:5060", "a".repeat(260)),
        "sip..telnyx.com:5061",
        ".sip.telnyx.com:5061",
        "-sip.telnyx.com:5061",
        "sip.telnyx.com-:5061",
        "sip_telnyx.com:5061",
    ] {
        let mut invalid = valid.clone();
        invalid.sip_server = bad_server.to_string();
        assert!(
            invalid.validate().is_err(),
            "expected SIP server rejection for {bad_server}",
        );
    }

    let mut bad_transport = valid.clone();
    bad_transport.sip_transport = "tcp".to_string();
    assert!(bad_transport.validate().is_err());

    let mut long_user = valid.clone();
    long_user.sip_username = "u".repeat(257);
    assert!(long_user.validate().is_err());

    let mut bad_display = valid;
    bad_display.user_display_name = "Name\nInjected".to_string();
    assert!(bad_display.validate().is_err());
    bad_display.user_display_name = "n".repeat(129);
    assert!(bad_display.validate().is_err());
}
