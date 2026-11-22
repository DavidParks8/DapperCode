use super::{
    anyhow, bail, clean_stale_broker_ownership, fs, legacy_settings_digest, plural,
    process_identity, process_matches, process_path_matches, read_ownership, remove_file_if_exists,
    settings_digest, settings_digest_matches, stop_owned_process, thread, wait_for_broker_start,
    write_ownership, AppPaths, BridgeSnapshot, BridgeState, BrokerLifecycleAction,
    BrokerOwnershipRecord, BrokerSettings, BrokerStartupWait, BrokerSupervisor, Command, Duration,
    Path, PathBuf, Profile, SecretStore, Stdio, FAIL_NEXT_PROCESS_INSPECTION, OWNERSHIP_VERSION,
    START_POLL_INTERVAL, START_TIMEOUT,
};
#[cfg(unix)]
use super::{
    io, process_exists, process_matches_for_recovery, request_process_stop,
    runtime_executable_available, stop_owned_process_for_recovery, ProcessStopRequest,
};
use std::io::{Read, Write};

const BROKER_LIFECYCLE_CHILD: &str = "__broker_lifecycle_child";

#[test]
fn snapshot_constructors_describe_setup_and_errors() {
    let workspace = tempfile::tempdir().unwrap();
    let needs_setup = BridgeSnapshot::needs_setup(workspace.path());
    assert_eq!(needs_setup.state, BridgeState::NeedsSetup);
    assert!(needs_setup.detail.contains("DapperCode"));
    assert!(needs_setup.url.is_none());
    assert!(!needs_setup.managed_process);

    let error = BridgeSnapshot::error("broken");
    assert_eq!(error.state, BridgeState::Error);
    assert_eq!(error.detail, "broken");
}

fn test_supervisor(paths: &AppPaths, bridge_port: u16, owner_pid: Option<u32>) -> BrokerSupervisor {
    let preview_port = if bridge_port == u16::MAX {
        bridge_port - 1
    } else {
        bridge_port + 1
    };
    let settings = BrokerSettings::new(
        "local".to_string(),
        "127.0.0.1".to_string(),
        bridge_port,
        preview_port,
        format!("http://127.0.0.1:{bridge_port}"),
        format!("http://127.0.0.1:{preview_port}"),
    )
    .unwrap();
    let profile = Profile {
        profile_id: "workspace-a".to_string(),
        workspace: paths.base_dir().to_path_buf(),
        network_mode: "local".to_string(),
        bridge_host: "127.0.0.1".to_string(),
        bridge_port,
        preview_port,
        connect_url: settings.connect_url.clone(),
        preview_connect_url: settings.preview_connect_url.clone(),
        auto_start: false,
        allow_query_token_auth: true,
        acp_initialize_timeout_ms: 15_000,
        agent: crate::store::ProfileAgent {
            agent_id: "agent".to_string(),
            display_name: "Agent".to_string(),
            executable: std::env::current_exe().unwrap(),
            launcher_path: None,
            argv: Vec::new(),
            resolved_version: "test".to_string(),
            verified_digest: format!("sha256:{}", "a".repeat(64)),
        },
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    };
    BrokerSupervisor::new(
        profile,
        settings,
        paths.clone(),
        SecretStore::file_backend_for_tests(),
        owner_pid,
    )
}

fn closed_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

#[test]
fn pairing_survives_removal_of_the_registered_agent_release() {
    let root = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(root.path().to_path_buf());
    let mut supervisor = test_supervisor(&paths, closed_port(), None);
    supervisor
        .secrets
        .get_or_create(&paths, &supervisor.profile.profile_id)
        .unwrap();
    let executable = root.path().join("obsolete-agent");
    fs::write(&executable, b"fixture").unwrap();
    supervisor.profile.agent.executable = executable.clone();
    let before = supervisor.pairing().unwrap();
    fs::remove_file(&executable).unwrap();
    assert_eq!(supervisor.pairing().unwrap(), before);
}

fn health_server(body: &'static str, requests: usize) -> (u16, thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        for _ in 0..requests {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body,
            )
            .unwrap();
        }
    });
    (port, server)
}

fn delayed_health_server(port: u16, body: &'static str, requests: usize) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(250));
        let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        for _ in 0..requests {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body,
            )
            .unwrap();
        }
    })
}

fn spawn_owned_fixture(
    cwd: &Path,
    config_sha256: &str,
) -> (std::process::Child, BrokerOwnershipRecord) {
    let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
    spawn_owned_fixture_from(&executable, cwd, config_sha256)
}

fn spawn_owned_fixture_from(
    executable: &Path,
    cwd: &Path,
    config_sha256: &str,
) -> (std::process::Child, BrokerOwnershipRecord) {
    let mut command = Command::new(executable);
    command
        .arg(BROKER_LIFECYCLE_CHILD)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::platform::detach_process(&mut command);
    let child = command.spawn().unwrap();
    let record = process_identity(child.id(), executable, cwd, config_sha256, None).unwrap();
    (child, record)
}

#[cfg(unix)]
fn copied_lifecycle_executable(directory: &Path, name: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let executable = directory.join(name);
    fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    executable.canonicalize().unwrap()
}

#[test]
fn __broker_child_stays_alive_for_process_lifecycle_fixtures() {
    if std::env::args().any(|argument| argument == "__broker") {
        thread::sleep(Duration::from_millis(800));
    }
}

#[test]
fn __broker_lifecycle_child() {
    if std::env::args().any(|argument| argument == BROKER_LIFECYCLE_CHILD) {
        thread::sleep(Duration::from_secs(30));
    }
}

#[test]
fn startup_wait_accepts_late_and_boundary_health_without_false_timeout() {
    let ready_at = |ready_at: Duration| {
        let elapsed = std::cell::Cell::new(Duration::ZERO);
        let mut read_elapsed = || elapsed.get();
        let mut fetch_health = || elapsed.get() >= ready_at;
        let mut process_alive = || Ok(true);
        let mut sleep = |duration| elapsed.set(elapsed.get() + duration);
        wait_for_broker_start(
            START_TIMEOUT,
            Duration::from_secs(1),
            &mut read_elapsed,
            &mut fetch_health,
            &mut process_alive,
            &mut sleep,
        )
        .unwrap()
    };

    assert!(START_TIMEOUT > Duration::from_secs(15));
    assert_eq!(
        ready_at(Duration::from_secs(16)),
        BrokerStartupWait::Healthy,
    );
    assert_eq!(ready_at(START_TIMEOUT), BrokerStartupWait::Healthy);

    let overshot = std::cell::Cell::new(Duration::ZERO);
    let mut read_overshot = || overshot.get();
    let threshold = START_TIMEOUT
        .checked_sub(Duration::from_millis(100))
        .expect("startup timeout must exceed the test margin");
    let mut fetch_overshot_health = || overshot.get() >= threshold;
    let mut overshot_process_alive = || Ok(true);
    let mut overshooting_sleep = |_| overshot.set(overshot.get() + Duration::from_millis(1_200));
    assert_eq!(
        wait_for_broker_start(
            START_TIMEOUT,
            START_POLL_INTERVAL,
            &mut read_overshot,
            &mut fetch_overshot_health,
            &mut overshot_process_alive,
            &mut overshooting_sleep,
        )
        .unwrap(),
        BrokerStartupWait::Healthy,
    );
    assert!(overshot.get() >= START_TIMEOUT);

    let elapsed = std::cell::Cell::new(Duration::ZERO);
    let mut read_elapsed = || elapsed.get();
    let mut never_healthy = || false;
    let mut process_alive = || Ok(true);
    let mut sleep = |duration| elapsed.set(elapsed.get() + duration);
    assert_eq!(
        wait_for_broker_start(
            Duration::from_secs(2),
            Duration::from_secs(1),
            &mut read_elapsed,
            &mut never_healthy,
            &mut process_alive,
            &mut sleep,
        )
        .unwrap(),
        BrokerStartupWait::TimedOut,
    );
    let mut zero_elapsed = || Duration::ZERO;
    let mut never_healthy = || false;
    let mut process_exited = || Ok(false);
    let mut no_sleep = |_| {};
    assert_eq!(
        wait_for_broker_start(
            Duration::from_secs(2),
            Duration::from_secs(1),
            &mut zero_elapsed,
            &mut never_healthy,
            &mut process_exited,
            &mut no_sleep,
        )
        .unwrap(),
        BrokerStartupWait::Exited,
    );

    let health_probes = std::cell::Cell::new(0_u8);
    let mut zero_elapsed = || Duration::ZERO;
    let mut eventually_healthy = || {
        health_probes.set(health_probes.get() + 1);
        health_probes.get() == 2
    };
    let mut transient_identity_miss = || Ok(false);
    let mut no_sleep = |_| {};
    assert_eq!(
        wait_for_broker_start(
            Duration::from_secs(2),
            Duration::from_secs(1),
            &mut zero_elapsed,
            &mut eventually_healthy,
            &mut transient_identity_miss,
            &mut no_sleep,
        )
        .unwrap(),
        BrokerStartupWait::Healthy,
    );

    let mut at_timeout = || Duration::from_secs(2);
    let mut never_healthy = || false;
    let mut exited_at_boundary = || Ok(false);
    let mut no_sleep = |_| {};
    assert_eq!(
        wait_for_broker_start(
            Duration::from_secs(2),
            Duration::from_secs(1),
            &mut at_timeout,
            &mut never_healthy,
            &mut exited_at_boundary,
            &mut no_sleep,
        )
        .unwrap(),
        BrokerStartupWait::Exited,
    );

    let final_health_probes = std::cell::Cell::new(0_u8);
    let mut at_timeout = || Duration::from_secs(2);
    let mut healthy_after_boundary_identity_miss = || {
        final_health_probes.set(final_health_probes.get() + 1);
        final_health_probes.get() == 2
    };
    let mut exited_at_boundary = || Ok(false);
    let mut no_sleep = |_| {};
    assert_eq!(
        wait_for_broker_start(
            Duration::from_secs(2),
            Duration::from_secs(1),
            &mut at_timeout,
            &mut healthy_after_boundary_identity_miss,
            &mut exited_at_boundary,
            &mut no_sleep,
        )
        .unwrap(),
        BrokerStartupWait::Healthy,
    );
}

#[test]
fn dependency_upgrade_startup_inspection_failure_is_not_reported_as_an_exited_broker() {
    for elapsed_value in [Duration::ZERO, START_TIMEOUT] {
        let mut elapsed = || elapsed_value;
        let mut health = || false;
        let mut inspect = || bail!("process inspection unavailable");
        let mut sleep = |_| panic!("must propagate inspection failure before sleeping");
        let error = wait_for_broker_start(
            START_TIMEOUT,
            START_POLL_INTERVAL,
            &mut elapsed,
            &mut health,
            &mut inspect,
            &mut sleep,
        )
        .unwrap_err();
        assert!(error.to_string().contains("process inspection unavailable"));
    }
}

#[test]
fn dependency_upgrade_inspection_failure_preserves_live_ownership_across_lifecycle_actions() {
    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let supervisor = test_supervisor(&paths, closed_port(), None);
    let (mut child, record) =
        spawn_owned_fixture(paths.base_dir(), &settings_digest(&supervisor.settings));
    write_ownership(&paths.broker_ownership_path(), &record).unwrap();
    let original = fs::read(paths.broker_ownership_path()).unwrap();

    for action in [
        BrokerSupervisor::start_locked,
        BrokerSupervisor::stop_locked,
        BrokerSupervisor::restart_locked,
    ] {
        FAIL_NEXT_PROCESS_INSPECTION.set(true);
        let error = action(&supervisor).unwrap_err();
        assert!(error.to_string().contains("initialize process inspection"));
        assert_eq!(fs::read(paths.broker_ownership_path()).unwrap(), original);
        assert!(child.try_wait().unwrap().is_none());
    }
    FAIL_NEXT_PROCESS_INSPECTION.set(true);
    assert!(supervisor
        .transition_and_remember(BrokerLifecycleAction::Stop)
        .is_err());
    FAIL_NEXT_PROCESS_INSPECTION.set(true);
    assert!(clean_stale_broker_ownership(&paths).is_err());
    FAIL_NEXT_PROCESS_INSPECTION.set(true);
    assert!(stop_owned_process(&record, &paths.broker_ownership_path()).is_err());
    FAIL_NEXT_PROCESS_INSPECTION.set(true);
    let snapshot = supervisor.snapshot();
    assert_eq!(snapshot.state, BridgeState::Error);
    assert_eq!(snapshot.headline, "Bridge needs attention");
    assert!(snapshot.detail.contains("initialize process inspection"));
    assert_eq!(fs::read(paths.broker_ownership_path()).unwrap(), original);
    assert!(child.try_wait().unwrap().is_none());
    assert!(supervisor.owns_running_process().unwrap());

    stop_owned_process(&record, &paths.broker_ownership_path()).unwrap();
    child.wait().unwrap();
    assert!(!paths.broker_ownership_path().exists());
}

#[cfg(unix)]
#[test]
fn dependency_upgrade_terminated_unreaped_broker_is_stopped_without_metadata_errors() {
    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let supervisor = test_supervisor(&paths, closed_port(), None);
    let (mut child, record) =
        spawn_owned_fixture(paths.base_dir(), &settings_digest(&supervisor.settings));
    write_ownership(&paths.broker_ownership_path(), &record).unwrap();
    assert!(supervisor.owns_running_process().unwrap());
    assert!(request_process_stop(
        record.pid,
        record.started_at_epoch_sec,
        ProcessStopRequest::Graceful,
    )
    .unwrap());

    let mut status = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
    // SAFETY: this is our child PID and status is writable; WNOWAIT leaves it unreaped.
    let settled = unsafe {
        libc::waitid(
            libc::P_PID,
            record.pid,
            status.as_mut_ptr(),
            libc::WEXITED | libc::WNOWAIT,
        )
    };
    assert_eq!(
        settled,
        0,
        "wait for owned child: {}",
        io::Error::last_os_error(),
    );
    assert!(!process_matches(&record).unwrap());
    assert!(!process_exists(record.pid).unwrap());
    let snapshot = supervisor.snapshot();
    assert_eq!(snapshot.state, BridgeState::Stopped);
    assert_eq!(snapshot.headline, "Broker stopped");
    assert!(!snapshot.managed_process);
    assert_eq!(
        snapshot.url.as_deref(),
        Some(supervisor.settings.connect_url.as_str()),
    );
    assert!(paths.broker_ownership_path().exists());

    stop_owned_process(&record, &paths.broker_ownership_path()).unwrap();
    assert!(!paths.broker_ownership_path().exists());
    child.wait().unwrap();
}

#[test]
fn settings_digest_is_stable_across_autostart_and_accepts_legacy_records() {
    let mut settings = BrokerSettings::new(
        "local".to_string(),
        "127.0.0.1".to_string(),
        8787,
        8788,
        "http://127.0.0.1:8787".to_string(),
        "http://127.0.0.1:8788".to_string(),
    )
    .unwrap();
    let digest = settings_digest(&settings);
    assert_eq!(
        digest,
        "sha256:f62ef72b793a5c2c9820f2c985ad4104746edd3f4455bc3db4a9d4ede2fc6e4c",
    );
    assert!(digest.starts_with("sha256:"));
    assert_eq!(digest.len(), 71);
    assert!(settings_digest_matches(&digest, &settings));

    settings.auto_start = true;
    assert_eq!(settings_digest(&settings), digest);
    let legacy = legacy_settings_digest(&settings);
    assert_ne!(legacy, digest);
    assert!(settings_digest_matches(&legacy, &settings));
}

#[test]
fn broker_ownership_round_trips_privately() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime/broker/process.json");
    let record = BrokerOwnershipRecord {
        version: OWNERSHIP_VERSION,
        pid: 123,
        started_at_epoch_sec: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        executable: PathBuf::from("/tmp/dappercode"),
        data_dir: temp.path().to_path_buf(),
        config_sha256: format!("sha256:{}", "a".repeat(64)),
        owner_pid: Some(7),
    };
    write_ownership(&path, &record).unwrap();
    assert_eq!(read_ownership(&path).unwrap(), Some(record));
}

#[test]
fn broker_ownership_validation_and_pluralization_cover_invalid_records() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("process.json");
    assert_eq!(read_ownership(&path).unwrap(), None);
    fs::write(&path, b"{").unwrap();
    assert!(read_ownership(&path).is_err());

    let valid = BrokerOwnershipRecord {
        version: OWNERSHIP_VERSION,
        pid: 123,
        started_at_epoch_sec: 1,
        executable: PathBuf::from("/tmp/dappercode"),
        data_dir: temp.path().to_path_buf(),
        config_sha256: format!("sha256:{}", "a".repeat(64)),
        owner_pid: None,
    };
    for invalid in [
        BrokerOwnershipRecord {
            version: OWNERSHIP_VERSION + 1,
            ..valid.clone()
        },
        BrokerOwnershipRecord {
            pid: 0,
            ..valid.clone()
        },
        BrokerOwnershipRecord {
            config_sha256: "short".to_string(),
            ..valid.clone()
        },
        BrokerOwnershipRecord {
            config_sha256: format!("md5:{}", "a".repeat(67)),
            ..valid
        },
    ] {
        fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(read_ownership(&path).is_err());
    }
    assert_eq!(plural(1), "");
    assert_eq!(plural(0), "s");
}

#[test]
fn snapshots_distinguish_healthy_owned_unreachable_and_stopped_brokers() {
    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let health = r#"{"status":"ok","uptimeSec":7,"configuredWorkspaces":2,"runningWorkers":3,"connectedClients":1,"busyWorkers":1}"#;
    let (port, server) = health_server(health, 1);
    let running = test_supervisor(&paths, port, None).snapshot();
    server.join().unwrap();
    assert_eq!(running.state, BridgeState::Running);
    assert_eq!(running.ready_agents, 2);
    assert!(!running.managed_process);

    let supervisor = test_supervisor(&paths, closed_port(), None);
    let (mut child, ownership) =
        spawn_owned_fixture(paths.base_dir(), &settings_digest(&supervisor.settings));
    write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();
    let inaccessible = supervisor.snapshot();
    assert_eq!(inaccessible.state, BridgeState::Inaccessible);
    assert!(inaccessible.managed_process);
    let _ = child.kill();
    let _ = child.wait();
    remove_file_if_exists(&paths.broker_ownership_path()).unwrap();

    assert_eq!(supervisor.snapshot().state, BridgeState::Stopped);
}

#[test]
fn health_validation_and_start_detect_owned_and_unowned_listeners() {
    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let (bad_port, bad_server) = health_server(
        r#"{"status":"degraded","uptimeSec":1,"configuredWorkspaces":0,"runningWorkers":0,"connectedClients":0,"busyWorkers":0}"#,
        1,
    );
    let bad = test_supervisor(&paths, bad_port, None);
    assert!(bad
        .fetch_health()
        .unwrap_err()
        .to_string()
        .contains("degraded"));
    bad_server.join().unwrap();

    let health = r#"{"status":"ok","uptimeSec":1,"configuredWorkspaces":1,"runningWorkers":0,"connectedClients":0,"busyWorkers":0}"#;
    let (unowned_port, unowned_server) = health_server(health, 1);
    let unowned = test_supervisor(&paths, unowned_port, None);
    assert!(unowned
        .start_locked()
        .unwrap_err()
        .to_string()
        .contains("not owned"));
    unowned_server.join().unwrap();

    let (owned_port, owned_server) = health_server(health, 2);
    let owned = test_supervisor(&paths, owned_port, None);
    let (mut current_process, current) =
        spawn_owned_fixture(paths.base_dir(), &settings_digest(&owned.settings));
    write_ownership(&paths.broker_ownership_path(), &current).unwrap();
    assert_eq!(owned.start_locked().unwrap().state, BridgeState::Running);
    owned_server.join().unwrap();
    let _ = current_process.kill();
    let _ = current_process.wait();
    remove_file_if_exists(&paths.broker_ownership_path()).unwrap();
}

#[test]
fn reconcile_rechecks_health_before_rejecting_a_stale_ownership_record() {
    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let health = r#"{"status":"ok","uptimeSec":1,"configuredWorkspaces":1,"runningWorkers":0,"connectedClients":0,"busyWorkers":0}"#;
    let (port, server) = health_server(health, 1);
    let supervisor = test_supervisor(&paths, port, None);
    write_ownership(
        &paths.broker_ownership_path(),
        &BrokerOwnershipRecord {
            version: OWNERSHIP_VERSION,
            pid: u32::MAX,
            started_at_epoch_sec: 1,
            executable: PathBuf::from("/missing"),
            data_dir: paths.base_dir().to_path_buf(),
            config_sha256: settings_digest(&supervisor.settings),
            owner_pid: None,
        },
    )
    .unwrap();

    assert!(!supervisor.reconcile_existing_process().unwrap());
    server.join().unwrap();
    assert!(!paths.broker_ownership_path().exists());
}

#[cfg(unix)]
#[test]
fn missing_recorded_executable_remains_safe_to_identify_and_stop() {
    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let executable = copied_lifecycle_executable(paths.base_dir(), "obsolete-dappercode");
    let config_sha256 = format!("sha256:{}", "a".repeat(64));
    let (mut child, ownership) =
        spawn_owned_fixture_from(&executable, paths.base_dir(), &config_sha256);
    write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();
    let moved_executable = paths.base_dir().join("moved-dappercode");
    fs::rename(&executable, &moved_executable).unwrap();

    assert!(process_matches_for_recovery(&ownership).unwrap());
    assert!(!runtime_executable_available(&ownership.executable));
    stop_owned_process_for_recovery(&ownership, &paths.broker_ownership_path()).unwrap();
    child.wait().unwrap();
    fs::remove_file(moved_executable).unwrap();
    assert!(!paths.broker_ownership_path().exists());
}

#[cfg(unix)]
#[test]
fn snapshot_marks_deleted_owned_runtime_for_replacement() {
    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let health = r#"{"status":"ok","uptimeSec":7,"configuredWorkspaces":2,"runningWorkers":0,"connectedClients":0,"busyWorkers":0}"#;
    let (port, server) = health_server(health, 1);
    let supervisor = test_supervisor(&paths, port, None);
    let executable = copied_lifecycle_executable(paths.base_dir(), "deleted-dappercode");
    let (mut child, mut ownership) = spawn_owned_fixture_from(
        &executable,
        paths.base_dir(),
        &settings_digest(&supervisor.settings),
    );
    ownership.config_sha256 = format!("sha256:{}", "c".repeat(64));
    write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();
    let moved_executable = paths.base_dir().join("moved-dappercode");
    fs::rename(&executable, &moved_executable).unwrap();

    let snapshot = supervisor.snapshot();
    assert_eq!(snapshot.state, BridgeState::Stopped);
    assert_eq!(snapshot.headline, "Broker update required");
    assert!(snapshot.detail.contains("runtime bundle is unavailable"));
    assert!(snapshot.managed_process);
    assert_eq!(snapshot.connected_clients, 0);
    assert_eq!(snapshot.total_agents, 0);

    let _ = child.kill();
    let _ = child.wait();
    remove_file_if_exists(&paths.broker_ownership_path()).unwrap();
    fs::remove_file(moved_executable).unwrap();
    server.join().unwrap();
}

#[cfg(unix)]
#[test]
fn reconcile_stops_a_healthy_owned_broker_after_its_runtime_disappears() {
    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let health = r#"{"status":"ok","uptimeSec":7,"configuredWorkspaces":2,"runningWorkers":0,"connectedClients":0,"busyWorkers":0}"#;
    let (port, server) = health_server(health, 1);
    let supervisor = test_supervisor(&paths, port, None);
    let executable = copied_lifecycle_executable(paths.base_dir(), "deleted-dappercode");
    let (mut child, mut ownership) = spawn_owned_fixture_from(
        &executable,
        paths.base_dir(),
        &settings_digest(&supervisor.settings),
    );
    ownership.config_sha256 = format!("sha256:{}", "c".repeat(64));
    write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();
    let moved_executable = paths.base_dir().join("moved-dappercode");
    fs::rename(&executable, &moved_executable).unwrap();

    assert!(!supervisor.reconcile_existing_process().unwrap());
    child.wait().unwrap();
    fs::remove_file(moved_executable).unwrap();
    server.join().unwrap();
    assert!(!paths.broker_ownership_path().exists());
}

#[cfg(unix)]
#[test]
fn healthy_owned_runtime_from_another_existing_bundle_is_kept() {
    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let health = r#"{"status":"ok","uptimeSec":7,"configuredWorkspaces":1,"runningWorkers":0,"connectedClients":0,"busyWorkers":0}"#;
    let (port, server) = health_server(health, 1);
    let supervisor = test_supervisor(&paths, port, None);
    let executable = copied_lifecycle_executable(paths.base_dir(), "other-dappercode");
    let (mut child, ownership) = spawn_owned_fixture_from(
        &executable,
        paths.base_dir(),
        &settings_digest(&supervisor.settings),
    );
    write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();

    assert!(supervisor.reconcile_existing_process().unwrap());
    assert!(child.try_wait().unwrap().is_none());

    stop_owned_process(&ownership, &paths.broker_ownership_path()).unwrap();
    child.wait().unwrap();
    server.join().unwrap();
}

#[test]
fn start_detects_owned_unhealthy_and_child_exit_paths() {
    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let owned = test_supervisor(&paths, closed_port(), None);
    let (mut child, ownership) =
        spawn_owned_fixture(paths.base_dir(), &settings_digest(&owned.settings));
    write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();
    assert!(owned
        .start_locked()
        .unwrap_err()
        .to_string()
        .contains("health endpoint"));
    let _ = child.kill();
    let _ = child.wait();
    remove_file_if_exists(&paths.broker_ownership_path()).unwrap();

    let launched = test_supervisor(&paths, closed_port(), None);
    assert!(launched
        .start_locked()
        .unwrap_err()
        .to_string()
        .contains("exited before becoming healthy"));
    assert!(!paths.broker_ownership_path().exists());
}

#[test]
fn start_covers_owner_arguments_ownership_write_failure_and_delayed_health() {
    let owner_data = tempfile::tempdir().unwrap();
    let owner_paths = AppPaths::for_tests(owner_data.path().to_path_buf());
    let with_owner = test_supervisor(&owner_paths, closed_port(), Some(std::process::id()));
    assert!(with_owner.start_locked().is_err());

    let write_data = tempfile::tempdir().unwrap();
    let write_paths = AppPaths::for_tests(write_data.path().to_path_buf());
    fs::create_dir_all(write_paths.broker_ownership_path()).unwrap();
    let write_failure = test_supervisor(&write_paths, closed_port(), None);
    assert!(write_failure.start_locked().is_err());
    fs::remove_dir_all(write_paths.broker_ownership_path()).unwrap();

    let healthy_data = tempfile::tempdir().unwrap();
    let healthy_paths = AppPaths::for_tests(healthy_data.path().to_path_buf());
    let port = closed_port();
    let health = r#"{"status":"ok","uptimeSec":1,"configuredWorkspaces":1,"runningWorkers":0,"connectedClients":0,"busyWorkers":0}"#;
    let server = delayed_health_server(port, health, 2);
    let healthy = test_supervisor(&healthy_paths, port, None);
    assert_eq!(healthy.start_locked().unwrap().state, BridgeState::Running);
    server.join().unwrap();
    assert_eq!(healthy.stop().unwrap().state, BridgeState::Stopped);
}

#[test]
fn restart_handles_missing_stale_and_live_ownership_records() {
    let missing_data = tempfile::tempdir().unwrap();
    let missing_paths = AppPaths::for_tests(missing_data.path().to_path_buf());
    let missing = test_supervisor(&missing_paths, closed_port(), None);
    assert!(missing.restart_locked().is_err());

    let stale_data = tempfile::tempdir().unwrap();
    let stale_paths = AppPaths::for_tests(stale_data.path().to_path_buf());
    let stale = test_supervisor(&stale_paths, closed_port(), None);
    write_ownership(
        &stale_paths.broker_ownership_path(),
        &BrokerOwnershipRecord {
            version: OWNERSHIP_VERSION,
            pid: u32::MAX,
            started_at_epoch_sec: 1,
            executable: PathBuf::from("/missing"),
            data_dir: stale_paths.base_dir().to_path_buf(),
            config_sha256: settings_digest(&stale.settings),
            owner_pid: None,
        },
    )
    .unwrap();
    assert!(stale.restart_locked().is_err());

    let live_data = tempfile::tempdir().unwrap();
    let live_paths = AppPaths::for_tests(live_data.path().to_path_buf());
    let live = test_supervisor(&live_paths, closed_port(), None);
    let (child, ownership) =
        spawn_owned_fixture(live_paths.base_dir(), &settings_digest(&live.settings));
    write_ownership(&live_paths.broker_ownership_path(), &ownership).unwrap();
    let reaper = thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    assert!(live.restart_locked().is_err());
    reaper.join().unwrap();
}

#[test]
fn stop_handles_unowned_stale_and_live_owned_processes() {
    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let health = r#"{"status":"ok","uptimeSec":1,"configuredWorkspaces":1,"runningWorkers":0,"connectedClients":0,"busyWorkers":0}"#;
    let (port, server) = health_server(health, 1);
    let unowned = test_supervisor(&paths, port, None);
    assert!(unowned
        .stop()
        .unwrap_err()
        .to_string()
        .contains("not owned"));
    server.join().unwrap();

    let stopped = test_supervisor(&paths, closed_port(), None);
    let stale = BrokerOwnershipRecord {
        version: OWNERSHIP_VERSION,
        pid: u32::MAX,
        started_at_epoch_sec: 1,
        executable: PathBuf::from("/missing"),
        data_dir: paths.base_dir().to_path_buf(),
        config_sha256: settings_digest(&stopped.settings),
        owner_pid: None,
    };
    write_ownership(&paths.broker_ownership_path(), &stale).unwrap();
    assert_eq!(stopped.stop().unwrap().state, BridgeState::Stopped);
    assert!(!paths.broker_ownership_path().exists());

    let (child, ownership) =
        spawn_owned_fixture(paths.base_dir(), &settings_digest(&stopped.settings));
    write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();
    let reaper = thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    assert_eq!(stopped.stop().unwrap().state, BridgeState::Stopped);
    reaper.join().unwrap();
    assert!(!paths.broker_ownership_path().exists());
}

#[cfg(windows)]
#[test]
fn windows_broker_stop_uses_the_reliable_process_fallback() {
    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let supervisor = test_supervisor(&paths, closed_port(), None);
    let (mut child, ownership) =
        spawn_owned_fixture(paths.base_dir(), &settings_digest(&supervisor.settings));
    write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();

    stop_owned_process(&ownership, &paths.broker_ownership_path()).unwrap();
    child.wait().unwrap();

    assert!(!process_matches(&ownership).unwrap());
    assert!(!paths.broker_ownership_path().exists());
}

#[test]
fn process_identity_matching_and_stale_cleanup_fail_closed() {
    let current_executable = std::env::current_exe().unwrap().canonicalize().unwrap();
    let current_directory = std::env::current_dir().unwrap().canonicalize().unwrap();
    let current = process_identity(
        std::process::id(),
        &current_executable,
        &current_directory,
        format!("sha256:{}", "b".repeat(64)),
        Some(42),
    )
    .unwrap();
    assert!(process_matches(&current).unwrap());
    let different_executable_dir = tempfile::tempdir().unwrap();
    let different_executable = different_executable_dir.path().join("different-executable");
    fs::write(&different_executable, b"not the test executable").unwrap();
    let different_executable = different_executable.canonicalize().unwrap();
    assert!(process_path_matches(
        &different_executable_dir
            .path()
            .join("unavailable-executable"),
        &current_executable,
    )
    .is_err());
    assert!(process_identity(
        std::process::id(),
        &different_executable,
        &current_directory,
        &current.config_sha256,
        None,
    )
    .is_err());
    let other_directory = tempfile::tempdir().unwrap();
    assert!(process_identity(
        std::process::id(),
        &current_executable,
        other_directory.path(),
        &current.config_sha256,
        None,
    )
    .is_err());
    let mut wrong_start = current.clone();
    wrong_start.started_at_epoch_sec = wrong_start.started_at_epoch_sec.saturating_add(1);
    assert!(!process_matches(&wrong_start).unwrap());
    let mut wrong_executable = current.clone();
    wrong_executable.executable = different_executable;
    assert!(!process_matches(&wrong_executable).unwrap());
    let stale_record = BrokerOwnershipRecord {
        version: OWNERSHIP_VERSION,
        pid: u32::MAX,
        started_at_epoch_sec: 1,
        executable: PathBuf::from("/missing"),
        data_dir: current_directory.clone(),
        config_sha256: current.config_sha256.clone(),
        owner_pid: None,
    };
    let stale_owner_dir = tempfile::tempdir().unwrap();
    let stale_owner = stale_owner_dir.path().join("process.json");
    write_ownership(&stale_owner, &stale_record).unwrap();
    stop_owned_process(&stale_record, &stale_owner).unwrap();
    assert!(!stale_owner.exists());

    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let supervisor = test_supervisor(&paths, closed_port(), None);
    assert!(supervisor.clean_stale_ownership().is_ok());
    write_ownership(&paths.broker_ownership_path(), &stale_record).unwrap();
    assert!(!clean_stale_broker_ownership(&paths).unwrap());
    assert!(!paths.broker_ownership_path().exists());
    let (mut child, mut ownership) =
        spawn_owned_fixture(paths.base_dir(), &settings_digest(&supervisor.settings));
    write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();
    assert!(clean_stale_broker_ownership(&paths).unwrap());
    assert!(supervisor.clean_stale_ownership().is_ok());
    ownership.config_sha256 = format!("sha256:{}", "c".repeat(64));
    write_ownership(&paths.broker_ownership_path(), &ownership).unwrap();
    assert!(supervisor.clean_stale_ownership().is_err());
    let _ = child.kill();
    let _ = child.wait();
    remove_file_if_exists(&paths.broker_ownership_path()).unwrap();

    let executable_drift_data = tempfile::tempdir().unwrap();
    let executable_drift_paths = AppPaths::for_tests(executable_drift_data.path().to_path_buf());
    let executable_drift = test_supervisor(&executable_drift_paths, closed_port(), None);
    let fixture_name = format!("broker-fixture{}", std::env::consts::EXE_SUFFIX);
    let fixture_executable = executable_drift_paths.base_dir().join(fixture_name);
    fs::copy(&current_executable, &fixture_executable).unwrap();
    let fixture_executable = fixture_executable.canonicalize().unwrap();
    let mut drift_child = Command::new(&fixture_executable)
        .arg(BROKER_LIFECYCLE_CHILD)
        .current_dir(executable_drift_paths.base_dir())
        .spawn()
        .unwrap();
    let drift_record = process_identity(
        drift_child.id(),
        &fixture_executable,
        executable_drift_paths.base_dir(),
        settings_digest(&executable_drift.settings),
        None,
    )
    .unwrap();
    write_ownership(
        &executable_drift_paths.broker_ownership_path(),
        &drift_record,
    )
    .unwrap();
    assert!(executable_drift.clean_stale_ownership().is_err());
    let _ = drift_child.kill();
    let _ = drift_child.wait();

    let source_data = tempfile::tempdir().unwrap();
    let different_data = tempfile::tempdir().unwrap();
    let different_paths = AppPaths::for_tests(different_data.path().to_path_buf());
    let different = test_supervisor(&different_paths, closed_port(), None);
    let (mut different_child, different_record) =
        spawn_owned_fixture(source_data.path(), &settings_digest(&different.settings));
    write_ownership(&different_paths.broker_ownership_path(), &different_record).unwrap();
    assert!(different.clean_stale_ownership().is_err());
    let _ = different_child.kill();
    let _ = different_child.wait();
    remove_file_if_exists(&different_paths.broker_ownership_path()).unwrap();

    fs::create_dir_all(different_paths.broker_ownership_path()).unwrap();
    assert!(read_ownership(&different_paths.broker_ownership_path()).is_err());
    fs::remove_dir_all(different_paths.broker_ownership_path()).unwrap();
}

#[test]
fn stop_transition_persists_broker_and_profile_autostart_under_production_path() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let paths = AppPaths::for_tests(data.path().to_path_buf());
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let bridge_port = listener.local_addr().unwrap().port();
    drop(listener);
    let preview_port = if bridge_port == u16::MAX {
        bridge_port - 1
    } else {
        bridge_port + 1
    };
    let settings = BrokerSettings::new(
        "local".to_string(),
        "127.0.0.1".to_string(),
        bridge_port,
        preview_port,
        format!("http://127.0.0.1:{bridge_port}"),
        format!("http://127.0.0.1:{preview_port}"),
    )
    .unwrap();
    let profile = Profile {
        profile_id: "workspace-a".to_string(),
        workspace: workspace.path().to_path_buf(),
        network_mode: "local".to_string(),
        bridge_host: "127.0.0.1".to_string(),
        bridge_port,
        preview_port,
        connect_url: settings.connect_url.clone(),
        preview_connect_url: settings.preview_connect_url.clone(),
        auto_start: true,
        allow_query_token_auth: true,
        acp_initialize_timeout_ms: 15_000,
        agent: crate::store::ProfileAgent {
            agent_id: "agent".to_string(),
            display_name: "Agent".to_string(),
            executable: std::env::current_exe().unwrap(),
            launcher_path: None,
            argv: Vec::new(),
            resolved_version: "test".to_string(),
            verified_digest: format!("sha256:{}", "a".repeat(64)),
        },
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    };
    let mut saved_settings = settings.clone();
    saved_settings.auto_start = true;
    paths
        .update_config(|config| {
            config.broker = Some(saved_settings);
            config.upsert(profile.clone());
            Ok(())
        })
        .unwrap();
    let supervisor = BrokerSupervisor::new(
        profile,
        settings,
        paths.clone(),
        SecretStore::file_backend_for_tests(),
        None,
    );

    let (_, auto_start) = supervisor
        .transition_and_remember(BrokerLifecycleAction::Stop)
        .unwrap();

    assert!(!auto_start);
    let config = paths.load_config().unwrap();
    assert!(!config.broker.unwrap().auto_start);
    assert!(config.profiles.iter().all(|profile| !profile.auto_start));
}

#[test]
fn failed_autostart_persistence_restores_the_prior_process_state() {
    let running = std::cell::Cell::new(false);
    let error = BrokerSupervisor::persist_transition_or_restore(
        (),
        true,
        || Err(anyhow!("config write failed")),
        |should_be_running| {
            running.set(should_be_running);
            Ok(())
        },
    )
    .unwrap_err();

    assert_eq!(error.to_string(), "config write failed");
    assert!(running.get());

    let rollback_error = BrokerSupervisor::persist_transition_or_restore(
        (),
        false,
        || Err(anyhow!("config write failed")),
        |_| Err(anyhow!("process rollback failed")),
    )
    .unwrap_err();
    assert!(rollback_error
        .to_string()
        .contains("restoring the prior broker process state also failed"));
}
