use super::{
    anyhow, async_trait, bail, bearer_header, broker_client_metadata, client_heartbeat_expired,
    config_revision, insert_client_metadata_headers, parse_broker_query, random_token,
    refreshed_workspace_profile, sleep, timeout, upstream_url, AppPaths, Arc, BridgeRuntimeConfig,
    BrokerQuery, BrokerSettings, Duration, HashMap, HeaderMap, HeaderName, HeaderValue,
    ManagedWorker, Mutex, Ordering, OwnerIdentity, PathBuf, Profile, Result, SecretBackend,
    SecretStore, StatusCode, Uri, WorkerLauncher, WorkerPool, WorkerRuntimeActivity, WorkerTarget,
    WorkspaceAccess, WorkspaceRegistry, AUTHORIZATION, CLIENT_FOREGROUND_HEADER,
    CLIENT_HEARTBEAT_INTERVAL, CLIENT_HEARTBEAT_TIMEOUT, CLIENT_NAME_HEADER, CLIENT_TYPE_HEADER,
    WORKSPACE_HEADER,
};
#[cfg(unix)]
use super::{
    get, runtime_executable_available, wait_for_runtime_executable_loss, wait_for_worker,
    worker_http_client, Command, Json, ProcessWorker, Router,
};
use dappercode_desktop_core::ProfileAgent;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use tempfile::tempdir;

#[tokio::test]
async fn dependency_upgrade_owner_watch_retries_inspection_failures_until_confirmed_exit() {
    let owner = OwnerIdentity {
        pid: Some(42),
        started_at: Some(123),
    };
    let mut observations = [
        Err(anyhow!("inspection unavailable")),
        Ok(Some(123)),
        Err(anyhow!("inspection unavailable again")),
        Ok(None),
    ]
    .into_iter();
    let mut samples = 0;
    timeout(
        Duration::from_secs(1),
        owner.wait_for_exit_with(
            |pid| {
                assert_eq!(pid, 42);
                samples += 1;
                observations
                    .next()
                    .expect("watch must stop when the owner exits")
            },
            Duration::from_millis(1),
        ),
    )
    .await
    .expect("watch must detect the confirmed exit");
    assert_eq!(samples, 4);

    let running = OwnerIdentity::capture(Some(std::process::id())).unwrap();
    assert!(running.started_at.is_some());
    assert!(OwnerIdentity::capture(Some(u32::MAX)).is_err());
    assert!(timeout(
        Duration::from_millis(10),
        OwnerIdentity::capture(None).unwrap().wait_for_exit(),
    )
    .await
    .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn dependency_upgrade_owner_watch_detects_a_terminated_unreaped_process() {
    let mut child = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let owner = OwnerIdentity::capture(Some(child.id())).unwrap();
    child.kill().unwrap();
    let settled = timeout(Duration::from_secs(2), owner.wait_for_exit()).await;
    child.wait().unwrap();
    assert!(
        settled.is_ok(),
        "watch must recognize a terminated owner before reaping",
    );
}

#[cfg(unix)]
#[tokio::test]
async fn worker_runtime_watch_detects_executable_removal() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempdir().unwrap();
    let executable = root.path().join("dappercode-bridge");
    std::fs::write(&executable, b"fixture").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(runtime_executable_available(&executable));

    let watch = tokio::spawn(wait_for_runtime_executable_loss(
        executable.clone(),
        Duration::from_millis(10),
        2,
    ));
    sleep(Duration::from_millis(25)).await;
    std::fs::remove_file(&executable).unwrap();

    timeout(Duration::from_secs(1), watch)
        .await
        .expect("runtime watch should settle")
        .expect("runtime watch task should succeed");
}

fn profile(id: &str, workspace: PathBuf) -> Profile {
    Profile {
        profile_id: id.to_string(),
        workspace,
        network_mode: "local".to_string(),
        bridge_host: "127.0.0.1".to_string(),
        bridge_port: 8787,
        preview_port: 8788,
        connect_url: "http://127.0.0.1:8787".to_string(),
        preview_connect_url: "http://127.0.0.1:8788".to_string(),
        auto_start: true,
        allow_query_token_auth: true,
        acp_initialize_timeout_ms: 15_000,
        agent: ProfileAgent {
            agent_id: "agent".to_string(),
            display_name: "Agent".to_string(),
            executable: PathBuf::from("/bin/echo"),
            launcher_path: None,
            argv: vec!["acp".to_string()],
            resolved_version: "1".to_string(),
            verified_digest: "sha256:test".to_string(),
        },
        updated_at: "now".to_string(),
    }
}

#[tokio::test]
async fn worker_launch_reloads_registration_even_if_another_launch_already_refreshed_it() {
    use sha2::{Digest, Sha256};

    let root = tempdir().unwrap();
    let paths = AppPaths::for_tests(root.path().to_path_buf());
    let mut stale = profile("workspace", root.path().to_path_buf());
    stale.agent.executable = root.path().join("removed-release");
    let mut current = stale.clone();
    current.agent.executable = std::env::current_exe().unwrap();
    current.agent.verified_digest = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(
            std::fs::read(&current.agent.executable).unwrap()
        )),
    );
    paths
        .update_config(|config| {
            config.upsert(current.clone());
            Ok(())
        })
        .unwrap();

    let refreshed = refreshed_workspace_profile(&paths, &stale).await.unwrap();
    assert_eq!(refreshed.agent.executable, current.agent.executable);
    assert_eq!(
        refreshed.agent.verified_digest,
        current.agent.verified_digest,
    );
}

#[cfg(unix)]
#[tokio::test]
async fn unavailable_agent_is_not_admitted_and_a_later_ready_launch_recovers() {
    let ready = Arc::new(AtomicBool::new(false));
    let server_ready = ready.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/status",
        get(move || {
            let ready = server_ready.load(Ordering::SeqCst);
            async move {
                Json(serde_json::json!({
                    "status": if ready { "ok" } else { "unhealthy" },
                    "runtime": WorkerRuntimeActivity::default(),
                }))
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let create_worker = || {
        Arc::new(ProcessWorker {
            target: WorkerTarget {
                http_base: format!("http://{address}/"),
                websocket_base: format!("ws://{address}"),
                internal_token: "fixture-token".into(),
            },
            child: Mutex::new(
                Command::new("/bin/sleep")
                    .arg("30")
                    .kill_on_drop(true)
                    .spawn()
                    .unwrap(),
            ),
            http: worker_http_client().unwrap(),
        })
    };
    let failed = create_worker();
    let error = wait_for_worker(failed.clone(), Duration::from_secs(2))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("agent failed to initialize"));
    failed.stop().await.unwrap();
    assert!(!failed.is_running().await);
    ready.store(true, Ordering::SeqCst);
    let recovered = create_worker();
    wait_for_worker(recovered.clone(), Duration::from_secs(2))
        .await
        .unwrap();
    assert!(recovered.is_running().await);
    recovered.stop().await.unwrap();
    assert!(!recovered.is_running().await);
    server.abort();
}

struct FakeWorker {
    target: WorkerTarget,
    running: AtomicBool,
    busy: AtomicBool,
    activity_failures_remaining: AtomicUsize,
    stops: AtomicUsize,
}

impl FakeWorker {
    fn new(id: usize) -> Self {
        Self {
            target: WorkerTarget {
                http_base: format!("http://worker-{id}/"),
                websocket_base: format!("ws://worker-{id}"),
                internal_token: format!("internal-{id}"),
            },
            running: AtomicBool::new(true),
            busy: AtomicBool::new(false),
            activity_failures_remaining: AtomicUsize::new(0),
            stops: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl ManagedWorker for FakeWorker {
    fn target(&self) -> WorkerTarget {
        self.target.clone()
    }

    async fn activity(&self) -> Result<WorkerRuntimeActivity> {
        if self
            .activity_failures_remaining
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            bail!("worker status unavailable");
        }
        Ok(if self.busy.load(Ordering::SeqCst) {
            WorkerRuntimeActivity::busy()
        } else {
            WorkerRuntimeActivity {
                can_retire: true,
                ..WorkerRuntimeActivity::default()
            }
        })
    }

    async fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    async fn stop(&self) -> Result<()> {
        self.running.store(false, Ordering::SeqCst);
        self.stops.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[derive(Default)]
struct FakeLauncher {
    launches: AtomicUsize,
    workers: Mutex<HashMap<String, Arc<FakeWorker>>>,
}

#[async_trait]
impl WorkerLauncher for FakeLauncher {
    async fn launch(&self, access: &WorkspaceAccess) -> Result<Arc<dyn ManagedWorker>> {
        let sequence = self.launches.fetch_add(1, Ordering::SeqCst) + 1;
        let worker = Arc::new(FakeWorker::new(sequence));
        self.workers
            .lock()
            .await
            .insert(access.profile.profile_id.clone(), worker.clone());
        Ok(worker)
    }
}

struct ConcurrentLauncher {
    barrier: tokio::sync::Barrier,
    launches: AtomicUsize,
}

struct BlockingStopWorker {
    target: WorkerTarget,
    running: AtomicBool,
    stop_started: tokio::sync::Notify,
    allow_stop: tokio::sync::Notify,
}

#[async_trait]
impl ManagedWorker for BlockingStopWorker {
    fn target(&self) -> WorkerTarget {
        self.target.clone()
    }

    async fn activity(&self) -> Result<WorkerRuntimeActivity> {
        Ok(WorkerRuntimeActivity {
            can_retire: true,
            ..WorkerRuntimeActivity::default()
        })
    }

    async fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    async fn stop(&self) -> Result<()> {
        self.stop_started.notify_one();
        self.allow_stop.notified().await;
        self.running.store(false, Ordering::SeqCst);
        Ok(())
    }
}

struct RetirementRaceLauncher {
    first: Arc<BlockingStopWorker>,
    launches: AtomicUsize,
}

struct CancellationLauncher {
    calls: AtomicUsize,
    first_started: tokio::sync::Notify,
}

#[async_trait]
impl WorkerLauncher for CancellationLauncher {
    async fn launch(&self, _access: &WorkspaceAccess) -> Result<Arc<dyn ManagedWorker>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            self.first_started.notify_one();
            std::future::pending::<()>().await;
            unreachable!();
        }
        Ok(Arc::new(FakeWorker::new(call + 1)))
    }
}

#[async_trait]
impl WorkerLauncher for RetirementRaceLauncher {
    async fn launch(&self, _access: &WorkspaceAccess) -> Result<Arc<dyn ManagedWorker>> {
        let sequence = self.launches.fetch_add(1, Ordering::SeqCst) + 1;
        if sequence == 1 {
            return Ok(self.first.clone());
        }
        Ok(Arc::new(FakeWorker::new(sequence)))
    }
}

#[async_trait]
impl WorkerLauncher for ConcurrentLauncher {
    async fn launch(&self, _access: &WorkspaceAccess) -> Result<Arc<dyn ManagedWorker>> {
        let sequence = self.launches.fetch_add(1, Ordering::SeqCst) + 1;
        self.barrier.wait().await;
        Ok(Arc::new(FakeWorker::new(sequence)))
    }
}

fn access(id: &str, workspace: PathBuf) -> WorkspaceAccess {
    WorkspaceAccess {
        profile: profile(id, workspace),
    }
}

#[tokio::test]
async fn dormant_submission_wakes_once_and_busy_disconnect_survives_until_reconnect() {
    let launcher = Arc::new(FakeLauncher::default());
    let pool = Arc::new(WorkerPool::new(
        launcher.clone(),
        4,
        0,
        Duration::from_millis(5),
    ));
    let workspace = tempdir().unwrap();
    let access = access("workspace-a", workspace.path().to_path_buf());

    let first = pool.acquire_client(access.clone()).await.unwrap();
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 1);
    let worker = launcher
        .workers
        .lock()
        .await
        .get("workspace-a")
        .cloned()
        .unwrap();
    worker.busy.store(true, Ordering::SeqCst);
    first.release().await;
    sleep(Duration::from_millis(8)).await;
    pool.sweep(false).await.unwrap();
    assert!(pool.contains("workspace-a").await);
    assert_eq!(worker.stops.load(Ordering::SeqCst), 0);

    worker.busy.store(false, Ordering::SeqCst);
    pool.sweep(false).await.unwrap();
    let reconnect = pool.acquire_client(access).await.unwrap();
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 1);
    reconnect.release().await;
}

#[tokio::test]
async fn lru_never_evicts_busy_workers_and_only_retires_after_grace() {
    let launcher = Arc::new(FakeLauncher::default());
    let pool = Arc::new(WorkerPool::new(
        launcher.clone(),
        3,
        1,
        Duration::from_millis(10),
    ));
    let first_dir = tempdir().unwrap();
    let second_dir = tempdir().unwrap();
    let third_dir = tempdir().unwrap();
    let first = pool
        .acquire_client(access("first", first_dir.path().to_path_buf()))
        .await
        .unwrap();
    first.release().await;
    let second = pool
        .acquire_client(access("second", second_dir.path().to_path_buf()))
        .await
        .unwrap();
    let busy = launcher
        .workers
        .lock()
        .await
        .get("second")
        .cloned()
        .unwrap();
    busy.busy.store(true, Ordering::SeqCst);
    second.release().await;
    let third = pool
        .acquire_client(access("third", third_dir.path().to_path_buf()))
        .await
        .unwrap();
    third.release().await;

    pool.sweep(false).await.unwrap();
    assert!(pool.contains("first").await);
    assert!(pool.contains("third").await);
    sleep(Duration::from_millis(12)).await;
    pool.sweep(false).await.unwrap();
    assert!(!pool.contains("first").await);
    assert!(pool.contains("third").await);
    assert!(pool.contains("second").await);
    assert_eq!(busy.stops.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn disconnected_active_worker_survives_failed_probes_and_reconnects_without_restart() {
    let launcher = Arc::new(FakeLauncher::default());
    let pool = Arc::new(WorkerPool::new(
        launcher.clone(),
        1,
        0,
        Duration::from_millis(1),
    ));
    let workspace = tempdir().unwrap();
    let access = access("active", workspace.path().to_path_buf());
    let client = pool.acquire_client(access.clone()).await.unwrap();
    let worker = launcher
        .workers
        .lock()
        .await
        .get("active")
        .cloned()
        .unwrap();
    worker.busy.store(true, Ordering::SeqCst);
    client.release().await;
    pool.sweep(false).await.unwrap();
    assert_eq!(pool.snapshot().await.connected_clients, 0);
    assert_eq!(pool.snapshot().await.busy_workers, 1);

    worker
        .activity_failures_remaining
        .store(6, Ordering::SeqCst);
    for capacity_pressure in [false, true, false, true, false, true] {
        pool.sweep(capacity_pressure).await.unwrap();
        assert!(
            pool.contains("active").await,
            "failed probes must not stop an accepted disconnected turn",
        );
        assert!(worker.running.load(Ordering::SeqCst));
        assert_eq!(worker.stops.load(Ordering::SeqCst), 0);
        assert_eq!(pool.snapshot().await.busy_workers, 1);
    }

    let reconnected = pool.acquire_client(access).await.unwrap();
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 1);
    assert_eq!(pool.snapshot().await.connected_clients, 1);
    worker.busy.store(false, Ordering::SeqCst);
    reconnected.release().await;
    pool.sweep(false).await.unwrap();
    assert_eq!(pool.snapshot().await.busy_workers, 0);
    sleep(Duration::from_millis(2)).await;
    pool.sweep(false).await.unwrap();
    assert!(!pool.contains("active").await);
    assert_eq!(worker.stops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unreachable_live_workers_are_preserved_but_exited_workers_release_capacity() {
    let launcher = Arc::new(FakeLauncher::default());
    let pool = Arc::new(WorkerPool::new(
        launcher.clone(),
        1,
        1,
        Duration::from_secs(60),
    ));
    let first_dir = tempdir().unwrap();
    let first = pool
        .acquire_client(access("first", first_dir.path().to_path_buf()))
        .await
        .unwrap();
    first.release().await;
    let first_worker = launcher.workers.lock().await.get("first").cloned().unwrap();

    first_worker
        .activity_failures_remaining
        .store(2, Ordering::SeqCst);
    pool.sweep(false).await.unwrap();
    pool.sweep(false).await.unwrap();
    assert!(pool.contains("first").await);
    assert_eq!(first_worker.stops.load(Ordering::SeqCst), 0);

    pool.sweep(false).await.unwrap();
    assert!(pool.contains("first").await);
    first_worker
        .activity_failures_remaining
        .store(6, Ordering::SeqCst);
    for _ in 0..6 {
        pool.sweep(false).await.unwrap();
    }
    assert!(pool.contains("first").await);
    assert_eq!(first_worker.stops.load(Ordering::SeqCst), 0);

    first_worker.running.store(false, Ordering::SeqCst);
    pool.sweep(false).await.unwrap();
    assert!(!pool.contains("first").await);
    assert_eq!(first_worker.stops.load(Ordering::SeqCst), 0);

    let replacement_dir = tempdir().unwrap();
    let replacement = pool
        .acquire_client(access("replacement", replacement_dir.path().to_path_buf()))
        .await
        .expect("confirmed worker exit releases capacity");
    replacement.release().await;
}

#[tokio::test]
async fn unrelated_cold_workspaces_launch_concurrently() {
    let launcher = Arc::new(ConcurrentLauncher {
        barrier: tokio::sync::Barrier::new(2),
        launches: AtomicUsize::new(0),
    });
    let pool = Arc::new(WorkerPool::new(
        launcher.clone(),
        2,
        1,
        Duration::from_secs(1),
    ));
    let first_dir = tempdir().unwrap();
    let second_dir = tempdir().unwrap();
    let first_access = access("first", first_dir.path().to_path_buf());
    let second_access = access("second", second_dir.path().to_path_buf());
    let first_pool = pool.clone();
    let second_pool = pool.clone();

    let (first, second) = timeout(Duration::from_secs(1), async move {
        let first_request = first_pool.acquire_client(first_access);
        let second_request = second_pool.acquire_client(second_access);
        tokio::join!(first_request, second_request)
    })
    .await
    .expect("cold launches should not serialize behind one workspace");
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 2);
    first.release().await;
    second.release().await;
}

#[tokio::test]
async fn acquisition_never_receives_a_worker_already_marked_for_retirement() {
    let first = Arc::new(BlockingStopWorker {
        target: WorkerTarget {
            http_base: "http://worker-first/".to_string(),
            websocket_base: "ws://worker-first".to_string(),
            internal_token: "first".to_string(),
        },
        running: AtomicBool::new(true),
        stop_started: tokio::sync::Notify::new(),
        allow_stop: tokio::sync::Notify::new(),
    });
    let launcher = Arc::new(RetirementRaceLauncher {
        first: first.clone(),
        launches: AtomicUsize::new(0),
    });
    let pool = Arc::new(WorkerPool::new(
        launcher.clone(),
        1,
        0,
        Duration::from_millis(2),
    ));
    let workspace = tempdir().unwrap();
    let access = access("workspace", workspace.path().to_path_buf());
    let initial = pool.acquire_client(access.clone()).await.unwrap();
    initial.release().await;
    pool.sweep(false).await.unwrap();
    sleep(Duration::from_millis(3)).await;

    let sweep_pool = pool.clone();
    let sweep = tokio::spawn(async move { sweep_pool.sweep(false).await });
    first.stop_started.notified().await;
    let acquire_pool = pool.clone();
    let acquire = tokio::spawn(async move { acquire_pool.acquire_client(access).await });
    assert!(timeout(Duration::from_millis(20), async {
        while !acquire.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_err());

    first.allow_stop.notify_one();
    sweep.await.unwrap().unwrap();
    let replacement = acquire.await.unwrap().unwrap();
    assert_ne!(replacement.worker.target().internal_token, "first");
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 2);
    replacement.release().await;
}

#[tokio::test]
async fn cancelled_launches_and_dropped_leases_release_capacity() {
    let launcher = Arc::new(CancellationLauncher {
        calls: AtomicUsize::new(0),
        first_started: tokio::sync::Notify::new(),
    });
    let pool = Arc::new(WorkerPool::new(
        launcher.clone(),
        1,
        1,
        Duration::from_secs(1),
    ));
    let workspace = tempdir().unwrap();
    let access = access("workspace", workspace.path().to_path_buf());
    let cancelled_pool = pool.clone();
    let cancelled_access = access.clone();
    let launch = tokio::spawn(async move { cancelled_pool.acquire_client(cancelled_access).await });
    launcher.first_started.notified().await;
    launch.abort();
    let _ = launch.await;
    assert_eq!(pool.launching.load(Ordering::Acquire), 0);

    let session = pool.acquire_client(access).await.unwrap();
    assert_eq!(pool.snapshot().await.connected_clients, 1);
    drop(session);
    timeout(Duration::from_secs(1), async {
        loop {
            if pool.snapshot().await.connected_clients == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropped client lease should release");
}

#[tokio::test]
async fn five_hundred_profiles_authenticate_without_starting_workers() {
    let root = tempdir().unwrap();
    let paths = AppPaths::for_tests(root.path().to_path_buf());
    let secrets = SecretStore::file_backend_for_tests();
    paths
        .update_config(|config| {
            config.broker = Some(BrokerSettings::new(
                "local".to_string(),
                "127.0.0.1".to_string(),
                8787,
                8788,
                "http://127.0.0.1:8787".to_string(),
                "http://127.0.0.1:8788".to_string(),
            )?);
            for index in 0..500 {
                let workspace = root.path().join(format!("workspace-{index}"));
                std::fs::create_dir_all(&workspace)?;
                let profile = profile(&format!("profile-{index:03}"), workspace);
                secrets.set_for_tests(&paths, &profile.profile_id, &format!("token-{index}"))?;
                config.upsert(profile);
            }
            Ok(())
        })
        .unwrap();
    let registry = WorkspaceRegistry::load(paths, secrets).await.unwrap();
    assert_eq!(registry.snapshot().await.workspace_count, 500);

    let launcher = Arc::new(FakeLauncher::default());
    let pool = WorkerPool::new(launcher.clone(), 12, 2, Duration::from_secs(1));
    assert_eq!(pool.snapshot().await.running_workers, 0);
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn authentication_and_workspace_match_happen_before_worker_allocation() {
    let root = tempdir().unwrap();
    let paths = AppPaths::for_tests(root.path().to_path_buf());
    let secrets = SecretStore::file_backend_for_tests();
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let mut configured = profile("profile-a", workspace);
    configured.allow_query_token_auth = false;
    paths
        .update_config(|config| {
            config.upsert(configured.clone());
            Ok(())
        })
        .unwrap();
    secrets
        .set_for_tests(&paths, "profile-a", "token-a")
        .unwrap();
    let registry = WorkspaceRegistry::load(paths, secrets).await.unwrap();
    let launcher = Arc::new(FakeLauncher::default());
    let pool = WorkerPool::new(launcher.clone(), 4, 1, Duration::from_secs(1));
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, bearer_header("token-a").unwrap());
    headers.insert(
        HeaderName::from_static(WORKSPACE_HEADER),
        HeaderValue::from_static("profile-b"),
    );
    let query = BrokerQuery {
        token: None,
        workspace: None,
        ..BrokerQuery::default()
    };

    let mismatch = registry.authenticate(&headers, &query).await;
    assert_eq!(mismatch.unwrap_err().status(), StatusCode::FORBIDDEN);
    assert_eq!(pool.snapshot().await.running_workers, 0);
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 0);

    let query_auth = registry
        .authenticate(
            &HeaderMap::new(),
            &BrokerQuery {
                token: Some("token-a".to_string()),
                workspace: Some("profile-a".to_string()),
                ..BrokerQuery::default()
            },
        )
        .await;
    assert_eq!(query_auth.unwrap_err().status(), StatusCode::UNAUTHORIZED);
    let mut authorized_headers = HeaderMap::new();
    authorized_headers.insert(AUTHORIZATION, bearer_header("token-a").unwrap());
    authorized_headers.insert(
        HeaderName::from_static(WORKSPACE_HEADER),
        HeaderValue::from_static("profile-a"),
    );
    assert!(registry
        .authenticate(
            &authorized_headers,
            &BrokerQuery {
                token: None,
                workspace: None,
                ..BrokerQuery::default()
            },
        )
        .await
        .is_ok());
}

#[tokio::test]
async fn registry_refresh_failure_keeps_existing_workspace_authentication_available() {
    let root = tempdir().unwrap();
    let paths = AppPaths::for_tests(root.path().to_path_buf());
    let secrets = SecretStore::file_backend_for_tests();
    let workspace_a = root.path().join("workspace-a");
    let workspace_b = root.path().join("workspace-b");
    std::fs::create_dir_all(&workspace_a).unwrap();
    std::fs::create_dir_all(&workspace_b).unwrap();
    paths
        .update_config(|config| {
            config.upsert(profile("profile-a", workspace_a));
            Ok(())
        })
        .unwrap();
    secrets
        .set_for_tests(&paths, "profile-a", "token-a")
        .unwrap();
    let registry = WorkspaceRegistry::load(paths.clone(), secrets)
        .await
        .unwrap();
    std::fs::write(paths.secret_vault_file_path(), b"{").unwrap();
    paths
        .update_config(|config| {
            config.upsert(profile("profile-b", workspace_b));
            Ok(())
        })
        .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, bearer_header("token-a").unwrap());
    headers.insert(
        HeaderName::from_static(WORKSPACE_HEADER),
        HeaderValue::from_static("profile-a"),
    );

    assert!(registry
        .authenticate(
            &headers,
            &BrokerQuery {
                token: None,
                workspace: None,
                ..BrokerQuery::default()
            },
        )
        .await
        .is_ok());
    assert_eq!(registry.snapshot().await.workspace_count, 1);
}

#[test]
fn broker_forwards_sanitized_query_client_metadata_and_prefers_headers() {
    let uri: Uri = "/broker/rpc?clientType=mobile&clientName=Phone%0AOne&clientForeground=true"
        .parse()
        .unwrap();
    let query = parse_broker_query(&uri);
    let (client_type, client_name, client_foreground) =
        broker_client_metadata(&HeaderMap::new(), &query);
    assert_eq!(client_type.as_deref(), Some("mobile"));
    assert_eq!(client_name.as_deref(), Some("PhoneOne"));
    assert_eq!(client_foreground, Some(true));

    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static(CLIENT_TYPE_HEADER),
        HeaderValue::from_static("desktop-monitor"),
    );
    headers.insert(
        HeaderName::from_static(CLIENT_NAME_HEADER),
        HeaderValue::from_static("DapperCode"),
    );
    headers.insert(
        HeaderName::from_static(CLIENT_FOREGROUND_HEADER),
        HeaderValue::from_static("false"),
    );
    let (client_type, client_name, client_foreground) = broker_client_metadata(&headers, &query);
    assert_eq!(client_type.as_deref(), Some("desktop-monitor"));
    assert_eq!(client_name.as_deref(), Some("DapperCode"));
    assert_eq!(client_foreground, Some(false));

    let mut worker_headers = HeaderMap::new();
    insert_client_metadata_headers(
        &mut worker_headers,
        client_type,
        client_name,
        client_foreground,
    )
    .unwrap();
    assert_eq!(
        worker_headers
            .get(CLIENT_TYPE_HEADER)
            .map(HeaderValue::to_str)
            .and_then(Result::ok),
        Some("desktop-monitor"),
    );
    assert_eq!(
        worker_headers
            .get(CLIENT_NAME_HEADER)
            .map(HeaderValue::to_str)
            .and_then(Result::ok),
        Some("DapperCode"),
    );
    assert_eq!(
        worker_headers
            .get(CLIENT_FOREGROUND_HEADER)
            .map(HeaderValue::to_str)
            .and_then(Result::ok),
        Some("false"),
    );
}

#[test]
fn broker_client_heartbeat_has_a_bounded_expiry() {
    assert!(CLIENT_HEARTBEAT_TIMEOUT > CLIENT_HEARTBEAT_INTERVAL);
    let last_activity = tokio::time::Instant::now();
    assert!(!client_heartbeat_expired(
        last_activity,
        last_activity + CLIENT_HEARTBEAT_TIMEOUT - Duration::from_millis(1),
    ));
    assert!(client_heartbeat_expired(
        last_activity,
        last_activity + CLIENT_HEARTBEAT_TIMEOUT,
    ));
}

#[test]
fn bridge_proxy_strips_external_routing_credentials() {
    let url = upstream_url(
        "http://127.0.0.1:9000/",
        "/frame",
        Some("value=kept&token=external&workspace=profile"),
        &["token", "workspace"],
    )
    .unwrap();
    assert_eq!(url.as_str(), "http://127.0.0.1:9000/frame?value=kept");
    let malicious = upstream_url(
        "http://127.0.0.1:9000/",
        "/http://169.254.169.254/latest/meta-data",
        None,
        &[],
    )
    .unwrap();
    assert_eq!(malicious.host_str(), Some("127.0.0.1"));
    assert_eq!(malicious.path(), "/http://169.254.169.254/latest/meta-data");
}

#[test]
fn registry_revision_hash_changes_even_for_same_size_rewrites() {
    let root = tempdir().unwrap();
    let paths = AppPaths::for_tests(root.path().to_path_buf());
    assert_eq!(config_revision(&paths), None);
    std::fs::write(paths.config_path(), b"revision-a").unwrap();
    let first = config_revision(&paths).unwrap();
    std::fs::write(paths.config_path(), b"revision-b").unwrap();
    let second = config_revision(&paths).unwrap();
    assert_ne!(first, second);
}

#[test]
fn worker_phone_call_env_requires_both_settings_and_stored_sip_password() {
    use dappercode_desktop_core::PhoneCallSettings;

    let root = tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let paths = AppPaths::for_tests(root.path().to_path_buf());
    let secrets = SecretStore::file_backend_for_tests();
    let mut prof = profile("workspace-1", workspace);
    prof.agent.executable = std::env::current_exe().unwrap();
    paths.prepare_profile(&prof.profile_id).unwrap();
    std::fs::write(paths.manifest_path(&prof.profile_id), b"{}").unwrap();

    let base_config = || {
        BridgeRuntimeConfig::from_profile(&prof, "internal-token", SecretBackend::File, &paths)
            .unwrap()
    };

    let mut unconfigured = base_config();
    unconfigured.apply_phone_call(&paths, &secrets).unwrap();
    assert!(!unconfigured.values.contains_key("PHONE_CALL_SIP_SERVER"));

    let settings = PhoneCallSettings {
        sip_server: "sip.telnyx.com:5061".to_string(),
        sip_transport: "tls".to_string(),
        sip_username: "telnyx-user".to_string(),
        caller_id: "+15551234567".to_string(),
        user_display_name: "Caller".to_string(),
        stt_base_url: "http://127.0.0.1:11434/v1".to_string(),
        stt_model: "gemma4:e4b".to_string(),
        llm_base_url: "http://127.0.0.1:11434/v1".to_string(),
        llm_model: "gemma4:e4b".to_string(),
        tts_base_url: "http://127.0.0.1:11434/v1".to_string(),
        tts_model: "phonon".to_string(),
        tts_voice: "Harper".to_string(),
    };
    paths
        .update_config(|config| {
            config.phone_call = Some(settings.clone());
            Ok(())
        })
        .unwrap();

    let mut missing_secret = base_config();
    missing_secret.apply_phone_call(&paths, &secrets).unwrap();
    assert!(!missing_secret
        .values
        .contains_key("PHONE_CALL_SIP_PASSWORD"));

    let sip_password = random_token().unwrap();
    secrets.store_sip_password(&paths, &sip_password).unwrap();
    let mut ready = base_config();
    ready.apply_phone_call(&paths, &secrets).unwrap();
    assert_eq!(ready.values["PHONE_CALL_SIP_SERVER"], "sip.telnyx.com:5061");
    assert_eq!(ready.values["PHONE_CALL_SIP_PASSWORD"], sip_password);
    assert_eq!(ready.values["PHONE_CALL_CALLER_ID"], "+15551234567");
}
