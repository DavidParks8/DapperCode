#[cfg(unix)]
use super::{
    atomic_private_write, discover_agent_in, executable_version_with_timeout, file_digest,
    refresh_registered_agent_within, trusted_agent_target, Duration,
};
use super::{
    civil_from_days, discover_agent_executable, executable_version, fs, normalize_host,
    now_iso8601, profile_id_for, setup_profile, valid_agent_id, AppPaths, ConfigSideEffects,
    FileLease, Path, PathBuf, SecretStore, SetupRequest, SetupSideEffects,
};
use tempfile::tempdir;

fn store() -> SecretStore {
    SecretStore::file_backend_for_tests()
}

fn request(workspace: &Path, port: Option<u16>) -> SetupRequest {
    SetupRequest {
        workspace: workspace.to_path_buf(),
        network_mode: "local".to_string(),
        bridge_host: "192.168.1.20".to_string(),
        bridge_port: port,
        replace_broker_endpoint: false,
        agent_id: "echo-agent".to_string(),
        display_name: "Echo Agent".to_string(),
        executable: PathBuf::from("/bin/echo"),
        argv: vec!["acp".to_string()],
    }
}

#[test]
fn writes_the_profile_centrally_and_leaves_the_workspace_untouched() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());

    let result = setup_profile(request(workspace.path(), Some(18787)), &paths, &store()).unwrap();

    assert_eq!(result.bridge_port, 18787);
    assert_eq!(result.preview_port, 18788);
    assert_eq!(result.bridge_url, "http://192.168.1.20:18787");
    assert!(!workspace.path().join(".env.secure").exists());
    assert!(!workspace.path().join(".dappercode").exists());

    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(paths.manifest_path(&result.profile_id)).unwrap())
            .unwrap();
    assert_eq!(manifest["preferredAgentId"], "echo-agent");
    assert_eq!(manifest["agents"][0]["integrity"]["kind"], "executable");
    assert!(manifest["agents"][0]["verifiedDigest"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
}

#[test]
fn reuses_the_token_and_ports_across_repeated_setups() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let secrets = store();

    let first = setup_profile(request(workspace.path(), Some(18821)), &paths, &secrets).unwrap();
    let first_token = secrets
        .get(&paths, &first.profile_id)
        .unwrap()
        .unwrap()
        .token;

    let second = setup_profile(request(workspace.path(), None), &paths, &secrets).unwrap();
    let second_token = secrets
        .get(&paths, &second.profile_id)
        .unwrap()
        .unwrap()
        .token;

    assert_eq!(first.profile_id, second.profile_id);
    assert_eq!(first.bridge_port, second.bridge_port);
    assert_eq!(first_token, second_token);
    assert_eq!(paths.load_config().unwrap().profiles.len(), 1);
}

#[test]
fn gives_parallel_worktrees_distinct_profiles_on_one_broker_endpoint() {
    let alpha = tempdir().unwrap();
    let beta = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let secrets = store();

    let first = setup_profile(request(alpha.path(), None), &paths, &secrets).unwrap();
    let second = setup_profile(request(beta.path(), None), &paths, &secrets).unwrap();

    assert_ne!(first.profile_id, second.profile_id);
    assert_eq!(first.bridge_port, second.bridge_port);
    assert_ne!(first.preview_port, second.preview_port);
    assert_ne!(
        secrets
            .get(&paths, &first.profile_id)
            .unwrap()
            .unwrap()
            .token,
        secrets
            .get(&paths, &second.profile_id)
            .unwrap()
            .unwrap()
            .token,
    );
    assert_eq!(paths.load_config().unwrap().profiles.len(), 2);
}

#[test]
fn normalizes_bracketed_ipv6_before_building_urls() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let mut input = request(workspace.path(), Some(18831));
    input.bridge_host = "[::1]".to_string();

    let result = setup_profile(input, &paths, &store()).unwrap();
    let config = paths.load_config().unwrap();
    let profile = config.find(&result.profile_id).unwrap();

    assert_eq!(profile.bridge_host, "::1");
    assert_eq!(profile.connect_url, "http://[::1]:18831");
    assert_eq!(profile.preview_connect_url, "http://[::1]:18832");
    assert!(normalize_host("[::1").is_err());
    assert!(normalize_host("::1]").is_err());
}

#[test]
fn formats_timestamps_as_utc_iso8601() {
    let value = now_iso8601();
    assert_eq!(value.len(), 20);
    assert!(value.ends_with('Z'));
    assert_eq!(civil_from_days(0), (1970, 1, 1));
    assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    assert_eq!(civil_from_days(-1), (1969, 12, 31));
    assert_eq!(civil_from_days(59), (1970, 3, 1));
}

#[test]
fn rejects_invalid_agent_identity_and_network_settings() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let secrets = store();

    type Mutation = Box<dyn Fn(&mut SetupRequest)>;
    let cases: [(Mutation, &str); 7] = [
        (
            Box::new(|request| request.agent_id = "bad id".to_string()),
            "agent ID",
        ),
        (
            Box::new(|request| request.agent_id = "..".to_string()),
            "agent ID",
        ),
        (
            Box::new(|request| request.display_name = "  ".to_string()),
            "display name",
        ),
        (
            Box::new(|request| request.network_mode = "carrier-pigeon".to_string()),
            "network mode",
        ),
        (
            Box::new(|request| request.bridge_port = Some(0)),
            "bridge port",
        ),
        (
            Box::new(|request| request.bridge_port = Some(u16::MAX)),
            "bridge port",
        ),
        (
            Box::new(|request| request.argv = vec!["bad\narg".to_string()]),
            "control characters",
        ),
    ];

    for (mutate, expected) in cases {
        let mut input = request(workspace.path(), Some(18841));
        mutate(&mut input);
        let error = setup_profile(input, &paths, &secrets).unwrap_err();
        assert!(
            error.to_string().contains(expected),
            "expected {expected:?} in {error}",
        );
    }
    assert!(paths.load_config().unwrap().profiles.is_empty());
}

#[test]
fn rejects_hosts_that_are_not_concrete_addresses() {
    for host in ["", "   ", "host name", "user@host", "host/path", "ho\nst"] {
        assert!(normalize_host(host).is_err(), "accepted {host:?}");
    }
    assert!(normalize_host("[not-ipv6]").is_err());
    assert_eq!(normalize_host(" 127.0.0.1 ").unwrap(), "127.0.0.1");
    assert_eq!(normalize_host("[fd00::1]").unwrap(), "fd00::1");
}

#[test]
fn rejects_an_agent_executable_that_is_missing_or_not_a_file() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());

    let mut missing = request(workspace.path(), Some(18843));
    missing.executable = workspace.path().join("no-such-agent");
    assert!(setup_profile(missing, &paths, &store())
        .unwrap_err()
        .to_string()
        .contains("agent executable not found"));

    let mut directory = request(workspace.path(), Some(18843));
    directory.executable = workspace.path().to_path_buf();
    assert!(setup_profile(directory, &paths, &store())
        .unwrap_err()
        .to_string()
        .contains("must be a regular file"));
}

#[test]
fn rejects_a_workspace_that_does_not_exist() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let mut input = request(&workspace.path().join("missing"), Some(18845));
    input.bridge_port = Some(18845);

    assert!(setup_profile(input, &paths, &store())
        .unwrap_err()
        .to_string()
        .contains("workspace does not exist"));
}

#[test]
fn refuses_a_second_workspace_that_requests_a_different_broker_port() {
    let alpha = tempdir().unwrap();
    let beta = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let secrets = store();

    setup_profile(request(alpha.path(), Some(18847)), &paths, &secrets).unwrap();
    let error = setup_profile(request(beta.path(), Some(18849)), &paths, &secrets).unwrap_err();

    assert!(error.to_string().contains("pass --replace-broker-endpoint"));
    assert_eq!(paths.load_config().unwrap().profiles.len(), 1);
    let mut host_change = request(alpha.path(), Some(18847));
    host_change.bridge_host = "127.0.0.1".to_string();
    assert!(setup_profile(host_change, &paths, &secrets)
        .unwrap_err()
        .to_string()
        .contains("pass --replace-broker-endpoint"));

    let profile_id = profile_id_for(&alpha.path().canonicalize().unwrap());
    let manifest_path = paths.manifest_path(&profile_id);
    let manifest_before = fs::read(&manifest_path).unwrap();
    let mut rejected = request(alpha.path(), Some(18849));
    rejected.agent_id = "replacement-agent".to_string();
    rejected.display_name = "Replacement Agent".to_string();
    rejected.argv = vec!["replacement".to_string()];
    assert!(setup_profile(rejected, &paths, &secrets).is_err());
    assert_eq!(fs::read(manifest_path).unwrap(), manifest_before);
}

#[test]
fn setup_side_effect_rollback_restores_manifest_and_removes_new_credential() {
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let secrets = store();
    let profile_id = "rollback-profile";
    paths.prepare_profile(profile_id).unwrap();
    let manifest_path = paths.manifest_path(profile_id);
    fs::write(&manifest_path, b"previous manifest\n").unwrap();
    let mut side_effects = SetupSideEffects {
        paths: &paths,
        secrets: &secrets,
        profile_id,
        manifest: b"replacement manifest".to_vec(),
        previous_manifest: None,
        secret_created: None,
    };

    side_effects.apply().unwrap();
    assert_eq!(fs::read(&manifest_path).unwrap(), b"replacement manifest\n");
    assert!(secrets.get(&paths, profile_id).unwrap().is_some());

    side_effects.rollback().unwrap();
    assert_eq!(fs::read(&manifest_path).unwrap(), b"previous manifest\n");
    assert!(secrets.get(&paths, profile_id).unwrap().is_none());
}

#[test]
fn setup_serializes_endpoint_changes_with_broker_transitions() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let transition = FileLease::acquire(&paths.broker_transition_lock_path()).unwrap();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let worker_paths = paths.clone();
    let workspace_path = workspace.path().to_path_buf();
    let setup = std::thread::spawn(move || {
        let result = setup_profile(request(&workspace_path, None), &worker_paths, &store());
        done_tx.send(result).unwrap();
    });

    assert!(done_rx
        .recv_timeout(std::time::Duration::from_millis(50))
        .is_err());
    drop(transition);
    done_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap()
        .unwrap();
    setup.join().unwrap();
}

#[test]
fn replaces_a_stopped_broker_endpoint_and_preserves_the_old_alias() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let secrets = store();
    setup_profile(request(workspace.path(), Some(18847)), &paths, &secrets).unwrap();

    let mut replacement = request(workspace.path(), Some(18857));
    replacement.bridge_host = "127.0.0.1".to_string();
    replacement.replace_broker_endpoint = true;
    let ownership_path = paths.broker_ownership_path();
    fs::create_dir_all(ownership_path.parent().unwrap()).unwrap();
    fs::write(&ownership_path, b"owned").unwrap();
    assert!(setup_profile(replacement.clone(), &paths, &secrets)
        .unwrap_err()
        .to_string()
        .contains("invalid broker ownership record"));
    fs::remove_file(ownership_path).unwrap();
    let result = setup_profile(replacement, &paths, &secrets).unwrap();
    let config = paths.load_config().unwrap();
    let broker = config.broker.unwrap();

    assert_eq!(result.bridge_url, "http://127.0.0.1:18857");
    assert_eq!(broker.bridge_port, 18857);
    assert!(broker
        .legacy_bridge_endpoints
        .iter()
        .any(|endpoint| endpoint.host == "192.168.1.20" && endpoint.port == 18847));
    assert!(config.profiles[0]
        .preview_connect_url
        .starts_with("http://127.0.0.1:"));
}

#[test]
fn replaces_a_shared_endpoint_without_treating_other_profile_copies_as_conflicts() {
    let first_workspace = tempdir().unwrap();
    let second_workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let secrets = store();
    setup_profile(
        request(first_workspace.path(), Some(18_867)),
        &paths,
        &secrets,
    )
    .unwrap();
    setup_profile(
        request(second_workspace.path(), Some(18_867)),
        &paths,
        &secrets,
    )
    .unwrap();

    let mut replacement = request(second_workspace.path(), Some(18_867));
    replacement.bridge_host = "127.0.0.2".to_string();
    replacement.replace_broker_endpoint = true;
    let result = setup_profile(replacement, &paths, &secrets).unwrap();

    assert_eq!(result.bridge_port, 18_867);
    let config = paths.load_config().unwrap();
    assert_eq!(config.profiles.len(), 2);
    assert!(config
        .profiles
        .iter()
        .all(|profile| profile.bridge_port == 18_867));
    assert!(config
        .profiles
        .iter()
        .all(|profile| profile.bridge_host == "127.0.0.2"));
}

#[test]
fn records_the_reported_agent_version_and_digest() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());

    // `/bin/echo --version` prints its argument rather than failing, so this exercises the
    // successful version-probe path.
    let result = setup_profile(request(workspace.path(), Some(18849)), &paths, &store()).unwrap();
    assert_eq!(result.agent_version, "--version");
    assert_eq!(result.secret_backend, "file");
    assert_eq!(result.config_path, paths.config_path());

    let profile = paths
        .load_config()
        .unwrap()
        .find(&result.profile_id)
        .cloned()
        .unwrap();
    assert!(profile.agent.verified_digest.starts_with("sha256:"));
    assert_eq!(profile.agent.argv, vec!["acp".to_string()]);
    assert_eq!(profile.acp_initialize_timeout_ms, 15_000);
    assert!(profile.allow_query_token_auth);
}

#[test]
fn falls_back_to_a_local_version_when_the_agent_cannot_report_one() {
    let temp = tempdir().unwrap();
    let broken = temp.path().join("broken-agent");
    std::fs::write(&broken, b"not an executable").unwrap();
    assert_eq!(executable_version(&broken), "local");
    assert_eq!(executable_version(&PathBuf::from("/bin/false")), "local");
    // A command that succeeds but prints nothing also falls back.
    assert_eq!(executable_version(&PathBuf::from("/usr/bin/true")), "local");
}

#[test]
fn converts_days_before_and_after_the_epoch() {
    assert_eq!(civil_from_days(-719_468), (0, 3, 1));
    assert_eq!(civil_from_days(-719_528), (0, 1, 1));
    assert_eq!(civil_from_days(-1_000_000), (-768, 2, 4));
    assert_eq!(civil_from_days(365), (1971, 1, 1));
}

#[test]
fn discovers_an_agent_on_the_path_but_not_a_fictional_one() {
    assert!(discover_agent_executable("echo").is_some());
    assert!(discover_agent_executable("dappercode-not-a-real-agent").is_none());
}

#[test]
fn accepts_only_safe_agent_identifiers() {
    assert!(valid_agent_id("opencode"));
    assert!(valid_agent_id("open.code_v2-1"));
    assert!(!valid_agent_id(""));
    assert!(!valid_agent_id("."));
    assert!(!valid_agent_id(".."));
    assert!(!valid_agent_id("has/slash"));
    assert!(!valid_agent_id(&"a".repeat(129)));
}

/// Publishes a versioned release the way a package manager does, returning its executable.
#[cfg(unix)]
fn publish_release(install_root: &Path, version: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let release = install_root.join("pkg").join(version).join("bin");
    fs::create_dir_all(&release).unwrap();
    let executable = release.join("agent");
    fs::write(&executable, format!("#!/bin/sh\necho {version}\n")).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    executable
}

#[cfg(unix)]
fn register_launcher_agent(
    paths: &AppPaths,
    workspace: &Path,
    launcher: &Path,
    port: u16,
) -> String {
    let mut setup_request = request(workspace, Some(port));
    setup_request.agent_id = "agent".to_string();
    setup_request.display_name = "Agent".to_string();
    setup_request.executable = launcher.to_path_buf();
    setup_request.argv = Vec::new();
    setup_profile(setup_request, paths, &store())
        .unwrap()
        .profile_id
}

#[cfg(unix)]
#[test]
fn an_upgraded_agent_is_re_registered_from_its_trusted_launcher_directory() {
    use std::os::unix::fs::symlink;

    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let install = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let launcher_dir = install.path().join("bin");
    fs::create_dir_all(&launcher_dir).unwrap();
    let launcher = launcher_dir.join("agent");
    let first = publish_release(install.path(), "1.0");
    symlink(&first, &launcher).unwrap();

    let profile_id = register_launcher_agent(&paths, workspace.path(), &launcher, 18871);
    let search_roots = vec![launcher_dir.clone()];
    assert!(
        refresh_registered_agent_within(&paths, &profile_id, &search_roots)
            .unwrap()
            .is_none(),
        "an unchanged installation must not be re-registered",
    );

    // A package-manager upgrade publishes a new versioned release, repoints the stable launcher
    // entry at it, and removes the release the profile pinned.
    let second = publish_release(install.path(), "2.0");
    fs::remove_file(&launcher).unwrap();
    symlink(&second, &launcher).unwrap();
    fs::remove_dir_all(install.path().join("pkg").join("1.0")).unwrap();

    let refresh = refresh_registered_agent_within(&paths, &profile_id, &search_roots)
        .unwrap()
        .expect("an upgraded agent must be re-registered");
    let upgraded = second.canonicalize().unwrap();
    assert_eq!(refresh.agent_id, "agent");
    assert_eq!(refresh.executable, upgraded);
    assert_ne!(refresh.previous_version, refresh.resolved_version);

    let profile = paths
        .load_config()
        .unwrap()
        .find(&profile_id)
        .cloned()
        .unwrap();
    let upgraded_digest = file_digest(&upgraded).unwrap();
    assert_eq!(profile.agent.executable, upgraded);
    assert_eq!(profile.agent.verified_digest, upgraded_digest);
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(paths.manifest_path(&profile_id)).unwrap()).unwrap();
    assert_eq!(
        manifest["agents"][0]["verifiedDigest"].as_str(),
        Some(upgraded_digest.as_str()),
    );
    assert_eq!(
        manifest["agents"][0]["executable"].as_str(),
        upgraded.to_str(),
    );

    // Building the runtime again is what actually unblocks a waiting device.
    crate::config::BridgeRuntimeConfig::from_profile(
        &profile,
        "token",
        crate::secrets::SecretBackend::File,
        &paths,
    )
    .unwrap();
    assert!(
        refresh_registered_agent_within(&paths, &profile_id, &search_roots)
            .unwrap()
            .is_none(),
        "re-registration must be idempotent",
    );
}

#[cfg(unix)]
#[test]
fn an_upgrade_follows_the_launcher_even_when_the_old_release_still_exists() {
    use std::os::unix::fs::symlink;

    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let install = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let launcher_dir = install.path().join("bin");
    fs::create_dir_all(&launcher_dir).unwrap();
    let launcher = launcher_dir.join("agent");
    let first = publish_release(install.path(), "1.0");
    symlink(&first, &launcher).unwrap();
    let profile_id = register_launcher_agent(&paths, workspace.path(), &launcher, 18875);

    let second = publish_release(install.path(), "2.0");
    fs::remove_file(&launcher).unwrap();
    symlink(&second, &launcher).unwrap();
    let refresh = refresh_registered_agent_within(&paths, &profile_id, &[launcher_dir])
        .unwrap()
        .expect("the launcher's new release must supersede the retained old release");
    assert_eq!(refresh.executable, second.canonicalize().unwrap());
    assert!(first.is_file());
}

#[cfg(unix)]
#[test]
fn updates_to_a_selected_custom_launcher_recover_without_path_discovery() {
    use std::os::unix::fs::symlink;

    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let install = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let launcher = install.path().join("custom-launcher");
    let first = publish_release(install.path(), "1.0");
    symlink(&first, &launcher).unwrap();
    let profile_id = register_launcher_agent(&paths, workspace.path(), &launcher, 18877);
    let secret = store().get(&paths, &profile_id).unwrap().unwrap().token;

    // An installer can temporarily remove its entry; that must not corrupt the registration.
    fs::remove_file(&launcher).unwrap();
    fs::remove_file(&first).unwrap();
    let before = fs::read(paths.config_path()).unwrap();
    assert!(refresh_registered_agent_within(&paths, &profile_id, &[]).is_err());
    assert_eq!(fs::read(paths.config_path()).unwrap(), before);

    let second = publish_release(install.path(), "2.0");
    symlink(&second, &launcher).unwrap();
    let refresh = refresh_registered_agent_within(&paths, &profile_id, &[])
        .unwrap()
        .expect("the selected launcher must recover without global discovery");
    assert_eq!(refresh.executable, second.canonicalize().unwrap());

    // Self-updaters also replace a binary in place without changing its path.
    fs::write(&second, "#!/bin/sh\necho 2.1\n").unwrap();
    let refresh = refresh_registered_agent_within(&paths, &profile_id, &[])
        .unwrap()
        .expect("an in-place update must refresh the digest");
    assert_eq!(refresh.resolved_version, "2.1");
    let profile = paths
        .load_config()
        .unwrap()
        .find(&profile_id)
        .unwrap()
        .clone();
    assert_eq!(profile.agent.verified_digest, file_digest(&second).unwrap());
    assert_eq!(
        store().get(&paths, &profile_id).unwrap().unwrap().token,
        secret,
    );
    assert!(refresh_registered_agent_within(&paths, &profile_id, &[])
        .unwrap()
        .is_none());
}

#[cfg(unix)]
#[test]
fn an_uninstalled_agent_without_a_trusted_replacement_still_fails_closed() {
    use std::os::unix::fs::symlink;

    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let install = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let launcher_dir = install.path().join("bin");
    fs::create_dir_all(&launcher_dir).unwrap();
    let launcher = launcher_dir.join("agent");
    let release = publish_release(install.path(), "1.0");
    symlink(&release, &launcher).unwrap();

    let profile_id = register_launcher_agent(&paths, workspace.path(), &launcher, 18873);
    fs::remove_file(&launcher).unwrap();
    fs::remove_dir_all(install.path().join("pkg").join("1.0")).unwrap();

    let error = refresh_registered_agent_within(&paths, &profile_id, &[launcher_dir])
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("run setup again"),
        "unexpected error: {error}",
    );
}

/// A replacement other users can rewrite is never trusted automatically.
#[cfg(unix)]
#[test]
fn a_world_writable_replacement_is_not_trusted() {
    use std::os::unix::fs::PermissionsExt;

    let install = tempdir().unwrap();
    let launcher_dir = install.path().join("bin");
    fs::create_dir_all(&launcher_dir).unwrap();
    let executable = launcher_dir.join("agent");
    fs::write(&executable, "#!/bin/sh\necho hi\n").unwrap();

    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(trusted_agent_target(&executable).is_some());

    fs::set_permissions(&executable, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(trusted_agent_target(&executable).is_none());

    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&launcher_dir, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(trusted_agent_target(&executable).is_none());
}

#[cfg(unix)]
#[test]
fn discovery_preserves_the_launcher_instead_of_the_versioned_target() {
    use std::os::unix::fs::symlink;

    let install = tempdir().unwrap();
    let target = publish_release(install.path(), "1.0");
    let launcher = install.path().join("agent");
    symlink(&target, &launcher).unwrap();
    assert_eq!(
        discover_agent_in("agent", vec![install.path().to_path_buf()]),
        Some(launcher),
    );
}

#[cfg(unix)]
#[test]
fn legacy_registrations_learn_the_trusted_launcher_and_follow_future_updates() {
    use std::os::unix::fs::symlink;

    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let install = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let launcher = install.path().join("agent");
    let first = publish_release(install.path(), "1.0");
    symlink(&first, &launcher).unwrap();
    let id = register_launcher_agent(&paths, workspace.path(), &launcher, 18879);
    paths
        .update_config(|config| {
            config
                .profiles
                .iter_mut()
                .find(|profile| profile.profile_id == id)
                .unwrap()
                .agent
                .launcher_path = None;
            Ok(())
        })
        .unwrap();
    let roots = vec![install.path().to_path_buf()];
    refresh_registered_agent_within(&paths, &id, &roots)
        .unwrap()
        .unwrap();
    assert_eq!(
        paths
            .load_config()
            .unwrap()
            .find(&id)
            .unwrap()
            .agent
            .launcher_path,
        Some(launcher.clone()),
    );
    let second = publish_release(install.path(), "2.0");
    fs::remove_file(&launcher).unwrap();
    symlink(&second, &launcher).unwrap();
    assert_eq!(
        refresh_registered_agent_within(&paths, &id, &[])
            .unwrap()
            .unwrap()
            .executable,
        second.canonicalize().unwrap(),
    );
}

#[cfg(unix)]
#[test]
fn version_probes_are_bounded_and_do_not_block_upgrades() {
    use std::os::unix::fs::PermissionsExt;

    let install = tempdir().unwrap();
    let executable = install.path().join("agent");
    fs::write(&executable, "#!/bin/sh\nexec /bin/sleep 60\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let start = std::time::Instant::now();
    let error =
        executable_version_with_timeout(&executable, Duration::from_millis(50)).unwrap_err();
    assert!(error.to_string().contains("timed out"), "{error:#}");
    assert!(start.elapsed() < Duration::from_secs(2));
    fs::write(
        &executable,
        "#!/bin/sh\nwhile :; do printf 'too much output'; done\n",
    )
    .unwrap();
    assert!(
        executable_version_with_timeout(&executable, Duration::from_secs(1))
            .unwrap_err()
            .to_string()
            .contains("exceeded"),
    );
}

#[cfg(unix)]
#[test]
fn refresh_preserves_manifest_options_and_rejects_tree_integrity_without_partial_writes() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let install = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let executable = publish_release(install.path(), "1.0");
    let id = register_launcher_agent(&paths, workspace.path(), &executable, 18881);
    let manifest_path = paths.manifest_path(&id);
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["agents"][0]["environment"] = serde_json::json!({
        "LANG": { "kind": "literal", "value": "en_US.UTF-8" }
    });
    atomic_private_write(&manifest_path, &serde_json::to_vec(&manifest).unwrap()).unwrap();
    fs::write(&executable, "#!/bin/sh\necho 2.0\n").unwrap();
    refresh_registered_agent_within(&paths, &id, &[])
        .unwrap()
        .unwrap();
    let refreshed: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    assert_eq!(
        refreshed["agents"][0]["environment"],
        manifest["agents"][0]["environment"],
    );
    assert_eq!(
        refreshed["agents"][0]["argv"],
        manifest["agents"][0]["argv"],
    );

    manifest = refreshed;
    manifest["agents"][0]["integrity"] = serde_json::json!({
        "kind": "tree", "root": install.path(), "treeSha256": "sha256:fixture"
    });
    atomic_private_write(&manifest_path, &serde_json::to_vec(&manifest).unwrap()).unwrap();
    fs::write(&executable, "#!/bin/sh\necho 3.0\n").unwrap();
    let config_before = fs::read(paths.config_path()).unwrap();
    let manifest_before = fs::read(&manifest_path).unwrap();
    assert!(refresh_registered_agent_within(&paths, &id, &[])
        .unwrap_err()
        .to_string()
        .contains("requires executable integrity"));
    assert_eq!(fs::read(paths.config_path()).unwrap(), config_before);
    assert_eq!(fs::read(&manifest_path).unwrap(), manifest_before);
}

#[cfg(unix)]
#[test]
fn refresh_does_not_overwrite_setup_that_changes_registration_during_the_version_probe() {
    let workspace = tempdir().unwrap();
    let data = tempdir().unwrap();
    let install = tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let executable = publish_release(install.path(), "1.0");
    let id = register_launcher_agent(&paths, workspace.path(), &executable, 18883);
    let manifest_before = fs::read(paths.manifest_path(&id)).unwrap();
    let mut concurrent = paths.load_config().unwrap();
    concurrent
        .profiles
        .iter_mut()
        .find(|profile| profile.profile_id == id)
        .unwrap()
        .agent
        .argv = vec!["new-acp-mode".into()];
    let concurrent_path = install.path().join("concurrent-config.json");
    let concurrent_bytes = serde_json::to_vec_pretty(&concurrent).unwrap();
    fs::write(&concurrent_path, &concurrent_bytes).unwrap();
    fs::write(
        &executable,
        format!(
            "#!/bin/sh\ncp '{}' '{}'\necho 2.0\n",
            concurrent_path.display(),
            paths.config_path().display(),
        ),
    )
    .unwrap();

    let error = refresh_registered_agent_within(&paths, &id, &[]).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("registration changed during refresh"),
        "{error:#}",
    );
    assert_eq!(fs::read(paths.config_path()).unwrap(), concurrent_bytes);
    assert_eq!(fs::read(paths.manifest_path(&id)).unwrap(), manifest_before);
}
