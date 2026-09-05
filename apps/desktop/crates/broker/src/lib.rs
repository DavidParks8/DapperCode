#![cfg_attr(coverage_nightly, feature(coverage_attribute))]
// LLVM 21 crashes while exporting this Axum crate's coverage instantiation groups. Broker tests
// still run in coverage jobs; only the broken compiler mapping is disabled.
#![cfg_attr(coverage_nightly, coverage(off))]

//! Authenticated broker and worker proxy used by the desktop operator.

use std::{
    collections::HashMap,
    fs::OpenOptions,
    future::IntoFuture,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Weak,
    },
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use axum::{
    body::Body,
    extract::{
        ws::{Message as AxumMessage, WebSocket},
        Query, Request, State, WebSocketUpgrade,
    },
    http::{
        header::{AUTHORIZATION, CONNECTION, CONTENT_LENGTH, HOST, TRANSFER_ENCODING, UPGRADE},
        HeaderMap, HeaderName, HeaderValue, StatusCode, Uri,
    },
    response::{IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use getrandom::fill as fill_random;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tokio::{
    process::{Child, Command},
    sync::{Mutex, RwLock},
    time::{sleep, timeout},
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message as TungsteniteMessage},
};

use dappercode_desktop_core::{
    process_start_identity, refresh_registered_agent, runtime_executable_available, stop_child,
    wait_for_shutdown_signal, AppPaths, BridgeRuntimeConfig, BrokerSettings, Profile, RuntimePaths,
    SecretBackend, SecretStore,
};

const WORKSPACE_HEADER: &str = "x-dappercode-workspace";
const CLIENT_TYPE_HEADER: &str = "x-dappercode-client-type";
const CLIENT_NAME_HEADER: &str = "x-dappercode-client-name";
const CLIENT_FOREGROUND_HEADER: &str = "x-dappercode-client-foreground";
const CLIENT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const CLIENT_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(45);
const WORKER_POLL_INTERVAL: Duration = Duration::from_millis(200);
const WORKER_WEBSOCKET_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const WORKER_RUNTIME_WATCH_INTERVAL: Duration = Duration::from_secs(1);
const WORKER_RUNTIME_MISSING_SAMPLES: u8 = 3;
const BROKER_GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const SWEEP_INTERVAL: Duration = Duration::from_secs(5);
const MAX_CREDENTIAL_BYTES: usize = 4096;
const MAX_WEBSOCKET_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone)]
pub struct BrokerServer {
    paths: AppPaths,
    secrets: SecretStore,
    settings: BrokerSettings,
    owner_pid: Option<u32>,
}

impl BrokerServer {
    pub fn new(
        paths: AppPaths,
        secrets: SecretStore,
        settings: BrokerSettings,
        owner_pid: Option<u32>,
    ) -> Self {
        Self {
            paths,
            secrets,
            settings,
            owner_pid,
        }
    }

    pub async fn serve(self) -> Result<()> {
        self.settings.validate()?;
        let owner = OwnerIdentity::capture(self.owner_pid)?;
        let registry =
            Arc::new(WorkspaceRegistry::load(self.paths.clone(), self.secrets.clone()).await?);
        let bridge_binary = RuntimePaths::discover()?
            .bridge_binary_candidates()
            .into_iter()
            .find(|candidate| runtime_executable_available(candidate))
            .and_then(|candidate| candidate.canonicalize().ok())
            .context("the bundled dappercode-bridge worker executable is unavailable")?;
        let watched_bridge_binary = bridge_binary.clone();
        let launcher = Arc::new(ProcessWorkerLauncher {
            paths: self.paths.clone(),
            bridge_binary,
            settings: self.settings.clone(),
            http: worker_http_client()?,
        });
        let pool = Arc::new(WorkerPool::new(
            launcher,
            self.settings.max_workers,
            self.settings.max_idle_workers,
            Duration::from_millis(self.settings.worker_idle_grace_ms),
        ));
        let state = Arc::new(BrokerState {
            started_at: Instant::now(),
            registry,
            pool: pool.clone(),
            http: proxy_http_client()?,
        });

        let bridge_listener =
            tokio::net::TcpListener::bind((self.settings.host.as_str(), self.settings.bridge_port))
                .await
                .with_context(|| {
                    format!(
                        "failed to bind broker endpoint {}:{}",
                        self.settings.host, self.settings.bridge_port
                    )
                })?;
        let bridge_router = Router::new()
            .route("/health", get(broker_health))
            .route("/broker/status", get(broker_status))
            .route("/broker/rpc", get(broker_status_websocket))
            .route("/rpc", get(broker_websocket))
            .fallback(any(broker_http))
            .with_state(state.clone());
        let sweep_pool = pool.clone();
        let sweep_task = tokio::spawn(async move {
            loop {
                sleep(SWEEP_INTERVAL).await;
                if let Err(error) = sweep_pool.sweep(false).await {
                    eprintln!("broker worker sweep failed: {error:#}");
                }
            }
        });

        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let mut legacy_tasks = Vec::new();
        for endpoint in &self.settings.legacy_bridge_endpoints {
            let address = format!("{}:{}", endpoint.host, endpoint.port);
            let listener = match tokio::net::TcpListener::bind((
                endpoint.host.as_str(),
                endpoint.port,
            ))
            .await
            {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!(
                        "legacy broker endpoint {address} is unavailable; re-pair affected mobile profiles: {error}"
                    );
                    continue;
                }
            };
            let router = bridge_router.clone();
            let mut legacy_shutdown = shutdown_rx.clone();
            legacy_tasks.push(tokio::spawn(async move {
                axum::serve(listener, router)
                    .with_graceful_shutdown(async move {
                        wait_for_shutdown(&mut legacy_shutdown).await;
                    })
                    .await
            }));
            println!("legacy dappercode broker endpoint listening on {address}");
        }
        println!(
            "dappercode broker listening on {}:{}",
            self.settings.host, self.settings.bridge_port
        );
        let mut bridge_shutdown = shutdown_rx.clone();
        let serve = axum::serve(bridge_listener, bridge_router)
            .with_graceful_shutdown(async move {
                tokio::select! {
                    _ = wait_for_shutdown_signal() => {}
                    _ = owner.wait_for_exit() => {}
                    _ = wait_for_runtime_executable_loss(
                        watched_bridge_binary,
                        WORKER_RUNTIME_WATCH_INTERVAL,
                        WORKER_RUNTIME_MISSING_SAMPLES,
                    ) => {
                        eprintln!(
                            "broker worker executable is unavailable; shutting down so the desktop app can recover"
                        );
                    }
                }
                let _ = shutdown_tx.send(true);
                wait_for_shutdown(&mut bridge_shutdown).await;
            })
            .into_future();
        tokio::pin!(serve);
        let mut shutdown_completion = shutdown_rx.clone();
        let serve_result = tokio::select! {
            result = &mut serve => result,
            _ = wait_for_shutdown(&mut shutdown_completion) => {
                match timeout(BROKER_GRACEFUL_SHUTDOWN_TIMEOUT, &mut serve).await {
                    Ok(result) => result,
                    Err(_) => {
                        eprintln!(
                            "broker graceful shutdown timed out; forcing active connections closed"
                        );
                        Ok(())
                    }
                }
            }
        };

        sweep_task.abort();
        let _ = sweep_task.await;
        for mut task in legacy_tasks {
            match timeout(BROKER_GRACEFUL_SHUTDOWN_TIMEOUT, &mut task).await {
                Ok(result) => result
                    .context("legacy broker listener task failed to join")?
                    .context("legacy broker listener failed")?,
                Err(_) => {
                    task.abort();
                    let _ = task.await;
                    eprintln!("legacy broker listener shutdown timed out; forcing it closed");
                }
            }
        }
        pool.shutdown().await;
        serve_result.context("broker server failed")?;
        Ok(())
    }
}

#[derive(Clone)]
struct BrokerState {
    started_at: Instant,
    registry: Arc<WorkspaceRegistry>,
    pool: Arc<WorkerPool>,
    http: Client,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrokerQuery {
    token: Option<String>,
    workspace: Option<String>,
    client_type: Option<String>,
    client_name: Option<String>,
    client_foreground: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrokerHealth {
    status: &'static str,
    uptime_sec: u64,
    configured_workspaces: usize,
    running_workers: usize,
    connected_clients: usize,
    busy_workers: usize,
}

async fn broker_health(State(state): State<Arc<BrokerState>>) -> Response {
    let registry = state.registry.snapshot().await;
    let workers = state.pool.snapshot().await;
    Json(BrokerHealth {
        status: "ok",
        uptime_sec: state.started_at.elapsed().as_secs(),
        configured_workspaces: registry.workspace_count,
        running_workers: workers.running_workers,
        connected_clients: workers.connected_clients,
        busy_workers: workers.busy_workers,
    })
    .into_response()
}

async fn broker_status(
    State(state): State<Arc<BrokerState>>,
    headers: HeaderMap,
    Query(query): Query<BrokerQuery>,
) -> Response {
    let access = match state.registry.authenticate(&headers, &query).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    let worker = state
        .pool
        .workspace_snapshot(&access.profile.profile_id)
        .await;
    Json(serde_json::json!({
        "status": "ok",
        "protocolVersion": 1,
        "workspaceId": access.profile.profile_id,
        "workspace": access.profile.workspace,
        "worker": worker,
    }))
    .into_response()
}

async fn broker_status_websocket(
    ws: WebSocketUpgrade,
    State(state): State<Arc<BrokerState>>,
    headers: HeaderMap,
    Query(query): Query<BrokerQuery>,
) -> Response {
    if let Err(response) = state.registry.authenticate(&headers, &query).await {
        return response;
    }
    ws.max_frame_size(64 * 1024)
        .max_message_size(64 * 1024)
        .on_upgrade(move |socket| broker_status_socket(state, socket))
}

async fn broker_status_socket(state: Arc<BrokerState>, mut socket: WebSocket) {
    while let Some(Ok(message)) = socket.recv().await {
        let AxumMessage::Text(text) = message else {
            if matches!(message, AxumMessage::Close(_)) {
                return;
            }
            continue;
        };
        let Ok(request) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if request.get("method").and_then(serde_json::Value::as_str) != Some("bridge/health/read") {
            continue;
        }
        let workers = state.pool.snapshot().await;
        let registry = state.registry.snapshot().await;
        let agents = (0..workers.running_workers)
            .map(|_| serde_json::json!({ "lifecycle": "ready" }))
            .collect::<Vec<_>>();
        let response = serde_json::json!({
            "id": request.get("id").cloned().unwrap_or(serde_json::Value::Null),
            "result": {
                "status": "ok",
                "uptimeSec": state.started_at.elapsed().as_secs(),
                "connectedClients": workers.connected_clients,
                "agents": agents,
                "configuredWorkspaces": registry.workspace_count,
                "runningWorkers": workers.running_workers,
                "busyWorkers": workers.busy_workers,
                "operational": { "recentErrors": [] },
            }
        });
        if socket
            .send(AxumMessage::Text(response.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    }
}

async fn broker_websocket(
    ws: WebSocketUpgrade,
    State(state): State<Arc<BrokerState>>,
    headers: HeaderMap,
    Query(query): Query<BrokerQuery>,
) -> Response {
    let access = match state.registry.authenticate(&headers, &query).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    let (client_type, client_name, client_foreground) = broker_client_metadata(&headers, &query);
    ws.max_frame_size(MAX_WEBSOCKET_BYTES)
        .max_message_size(MAX_WEBSOCKET_BYTES)
        .on_upgrade(move |socket| async move {
            proxy_workspace_socket(
                state,
                access,
                socket,
                client_type,
                client_name,
                client_foreground,
            )
            .await;
        })
}

async fn proxy_workspace_socket(
    state: Arc<BrokerState>,
    access: WorkspaceAccess,
    downstream: WebSocket,
    client_type: Option<String>,
    client_name: Option<String>,
    client_foreground: Option<bool>,
) {
    let profile_id = access.profile.profile_id.clone();
    let session = match state.pool.acquire_client(access).await {
        Ok(session) => session,
        Err(error) => {
            let reason = format!("workspace runtime unavailable: {error:#}");
            eprintln!("workspace {profile_id} runtime launch failed: {error:#}");
            close_downstream(downstream, &reason).await;
            return;
        }
    };
    let upstream_result = timeout(
        WORKER_WEBSOCKET_CONNECT_TIMEOUT,
        connect_worker_socket(
            &session.worker.target(),
            client_type,
            client_name,
            client_foreground,
        ),
    )
    .await
    .map_err(|_| anyhow!("workspace worker websocket handshake timed out"))
    .and_then(|result| result);
    match upstream_result {
        Ok(upstream) => pump_websockets(downstream, upstream).await,
        Err(error) => {
            let reason = format!("workspace runtime connection failed: {error}");
            eprintln!("workspace {profile_id} runtime connection failed: {error:#}");
            close_downstream(downstream, &reason).await;
            session.release().await;
            return;
        }
    }
    session.release().await;
}

async fn close_downstream(mut socket: WebSocket, reason: &str) {
    let reason = reason.chars().take(120).collect::<String>();
    let _ = socket
        .send(AxumMessage::Close(Some(axum::extract::ws::CloseFrame {
            code: 1013,
            reason: reason.into(),
        })))
        .await;
}

async fn connect_worker_socket(
    target: &WorkerTarget,
    client_type: Option<String>,
    client_name: Option<String>,
    client_foreground: Option<bool>,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
> {
    let mut request = format!("{}/rpc", target.websocket_base)
        .into_client_request()
        .context("failed to build worker websocket request")?;
    request
        .headers_mut()
        .insert(AUTHORIZATION, bearer_header(&target.internal_token)?);
    insert_client_metadata_headers(
        request.headers_mut(),
        client_type,
        client_name,
        client_foreground,
    )?;
    let (socket, _) = connect_async(request)
        .await
        .context("failed to connect to workspace worker")?;
    Ok(socket)
}

async fn pump_websockets(
    downstream: WebSocket,
    upstream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    let (mut downstream_tx, mut downstream_rx) = downstream.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();
    let heartbeat_started_at = tokio::time::Instant::now();
    let mut heartbeat = tokio::time::interval_at(
        heartbeat_started_at + CLIENT_HEARTBEAT_INTERVAL,
        CLIENT_HEARTBEAT_INTERVAL,
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_downstream_activity = heartbeat_started_at;
    loop {
        tokio::select! {
            downstream_message = downstream_rx.next() => {
                let Some(Ok(message)) = downstream_message else { break };
                last_downstream_activity = tokio::time::Instant::now();
                let close = matches!(message, AxumMessage::Close(_));
                if let Some(message) = axum_to_tungstenite(message) {
                    if upstream_tx.send(message).await.is_err() {
                        break;
                    }
                }
                if close {
                    break;
                }
            }
            upstream_message = upstream_rx.next() => {
                let Some(Ok(message)) = upstream_message else { break };
                let close = matches!(message, TungsteniteMessage::Close(_));
                if let Some(message) = tungstenite_to_axum(message) {
                    if downstream_tx.send(message).await.is_err() {
                        break;
                    }
                }
                if close {
                    break;
                }
            }
            _ = heartbeat.tick() => {
                if client_heartbeat_expired(
                    last_downstream_activity,
                    tokio::time::Instant::now(),
                ) {
                    break;
                }
                if downstream_tx
                    .send(AxumMessage::Ping(Vec::new().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    }
}

fn client_heartbeat_expired(
    last_activity: tokio::time::Instant,
    now: tokio::time::Instant,
) -> bool {
    now.duration_since(last_activity) >= CLIENT_HEARTBEAT_TIMEOUT
}

fn axum_to_tungstenite(message: AxumMessage) -> Option<TungsteniteMessage> {
    match message {
        AxumMessage::Text(value) => Some(TungsteniteMessage::Text(value.to_string().into())),
        AxumMessage::Binary(value) => Some(TungsteniteMessage::Binary(value.to_vec().into())),
        AxumMessage::Ping(value) => Some(TungsteniteMessage::Ping(value.to_vec().into())),
        AxumMessage::Pong(value) => Some(TungsteniteMessage::Pong(value.to_vec().into())),
        AxumMessage::Close(_) => Some(TungsteniteMessage::Close(None)),
    }
}

fn tungstenite_to_axum(message: TungsteniteMessage) -> Option<AxumMessage> {
    match message {
        TungsteniteMessage::Text(value) => Some(AxumMessage::Text(value.to_string().into())),
        TungsteniteMessage::Binary(value) => Some(AxumMessage::Binary(value.to_vec().into())),
        TungsteniteMessage::Ping(value) => Some(AxumMessage::Ping(value.to_vec().into())),
        TungsteniteMessage::Pong(value) => Some(AxumMessage::Pong(value.to_vec().into())),
        TungsteniteMessage::Close(_) => Some(AxumMessage::Close(None)),
        TungsteniteMessage::Frame(_) => None,
    }
}

async fn broker_http(State(state): State<Arc<BrokerState>>, request: Request) -> Response {
    let query = parse_broker_query(request.uri());
    let access = match state.registry.authenticate(request.headers(), &query).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    let session = match state.pool.acquire_client(access).await {
        Ok(session) => session,
        Err(error) => return service_unavailable(&format!("{error:#}")),
    };
    proxy_http_request(
        &state.http,
        request,
        &session.worker.target().http_base,
        &session.worker.target().internal_token,
        None,
        &["token", "brokerToken", "workspace"],
        session,
    )
    .await
}

async fn proxy_http_request(
    client: &Client,
    request: Request,
    upstream_base: &str,
    internal_token: &str,
    path_override: Option<&str>,
    stripped_query_keys: &[&str],
    session: WorkerClientSession,
) -> Response {
    let (parts, body) = request.into_parts();
    let upstream_url = match upstream_url(
        upstream_base,
        path_override.unwrap_or(parts.uri.path()),
        parts.uri.query(),
        stripped_query_keys,
    ) {
        Ok(url) => url,
        Err(error) => return service_unavailable(&format!("invalid upstream URL: {error}")),
    };
    let mut upstream = client
        .request(parts.method.clone(), upstream_url)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()));
    for (name, value) in &parts.headers {
        if is_hop_by_hop(name) || name == AUTHORIZATION || name == HOST || name == CONTENT_LENGTH {
            continue;
        }
        upstream = upstream.header(name, value);
    }
    upstream = upstream.header(
        AUTHORIZATION,
        match bearer_header(internal_token) {
            Ok(value) => value,
            Err(error) => {
                return service_unavailable(&format!("invalid worker credential: {error}"))
            }
        },
    );

    let upstream = match upstream.send().await {
        Ok(response) => response,
        Err(error) => {
            return service_unavailable(&format!("workspace worker request failed: {error}"))
        }
    };
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);
    for (name, value) in &headers {
        if is_hop_by_hop(name) || name == CONTENT_LENGTH {
            continue;
        }
        response = response.header(name, value);
    }
    let leased_stream = futures_util::stream::unfold(
        (upstream.bytes_stream(), Some(session)),
        |(mut stream, session)| async move {
            match stream.next().await {
                Some(item) => Some((item, (stream, session))),
                None => {
                    if let Some(session) = session {
                        session.release().await;
                    }
                    None
                }
            }
        },
    );
    response
        .body(Body::from_stream(leased_stream))
        .unwrap_or_else(|error| service_unavailable(&format!("worker response failed: {error}")))
}

fn upstream_url(
    base: &str,
    path: &str,
    query: Option<&str>,
    stripped_query_keys: &[&str],
) -> Result<Url> {
    let mut url = Url::parse(base)?;
    let expected_origin = url.origin();
    let normalized_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    url.set_path(&normalized_path);
    url.set_query(None);
    if let Some(query) = query {
        let parsed = Url::parse(&format!("http://localhost/?{query}"))?;
        let retained = parsed
            .query_pairs()
            .filter(|(name, _)| !stripped_query_keys.iter().any(|key| name == *key))
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        if !retained.is_empty() {
            url.query_pairs_mut().extend_pairs(retained);
        }
    }
    if url.origin() != expected_origin {
        bail!("worker proxy URL escaped its fixed origin");
    }
    Ok(url)
}

fn is_hop_by_hop(name: &HeaderName) -> bool {
    name == CONNECTION || name == UPGRADE || name == TRANSFER_ENCODING
}

fn parse_broker_query(uri: &Uri) -> BrokerQuery {
    let Some(query) = uri.query() else {
        return BrokerQuery::default();
    };
    let Ok(url) = Url::parse(&format!("http://localhost/?{query}")) else {
        return BrokerQuery::default();
    };
    let mut result = BrokerQuery::default();
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "token" => result.token = Some(value.into_owned()),
            "workspace" => result.workspace = Some(value.into_owned()),
            "clientType" => result.client_type = Some(value.into_owned()),
            "clientName" => result.client_name = Some(value.into_owned()),
            "clientForeground" => {
                result.client_foreground = match value.as_ref() {
                    "true" => Some(true),
                    "false" => Some(false),
                    _ => None,
                }
            }
            _ => {}
        }
    }
    result
}

#[derive(Clone, Debug)]
struct WorkspaceAccess {
    profile: Profile,
}

#[derive(Clone)]
struct RegistryCache {
    by_token_digest: HashMap<String, Option<WorkspaceAccess>>,
    by_profile_id: HashMap<String, WorkspaceAccess>,
    config_revision: Option<[u8; 32]>,
}

#[derive(Debug, Clone, Copy)]
struct RegistrySnapshot {
    workspace_count: usize,
}

struct WorkspaceRegistry {
    paths: AppPaths,
    secrets: SecretStore,
    cache: RwLock<RegistryCache>,
    refresh_lock: Mutex<()>,
}

impl WorkspaceRegistry {
    async fn load(paths: AppPaths, secrets: SecretStore) -> Result<Self> {
        let cache = load_registry_cache(paths.clone(), secrets.clone(), true).await?;
        Ok(Self {
            paths,
            secrets,
            cache: RwLock::new(cache),
            refresh_lock: Mutex::new(()),
        })
    }

    async fn snapshot(&self) -> RegistrySnapshot {
        RegistrySnapshot {
            workspace_count: self.cache.read().await.by_profile_id.len(),
        }
    }

    async fn refresh_if_changed(&self) -> Result<()> {
        let revision = config_revision(&self.paths);
        {
            let cache = self.cache.read().await;
            if cache.config_revision == revision {
                return Ok(());
            }
        }
        let _refresh = self.refresh_lock.lock().await;
        {
            let cache = self.cache.read().await;
            if cache.config_revision == revision {
                return Ok(());
            }
        }
        match load_registry_cache(self.paths.clone(), self.secrets.clone(), false).await {
            Ok(refreshed) => *self.cache.write().await = refreshed,
            Err(error) => {
                eprintln!(
                    "workspace registry refresh failed; retaining the last authenticated cache: {error:#}"
                );
                self.cache.write().await.config_revision = revision;
            }
        }
        Ok(())
    }

    async fn authenticate(
        &self,
        headers: &HeaderMap,
        query: &BrokerQuery,
    ) -> std::result::Result<WorkspaceAccess, Response> {
        if let Err(error) = self.refresh_if_changed().await {
            return Err(service_unavailable(&format!(
                "workspace registry unavailable: {error:#}"
            )));
        }
        let bearer = extract_bearer(headers);
        let (token, query_credential) = match bearer {
            Some(token) => (Some(token), false),
            None => (query.token.as_deref(), true),
        };
        let Some(token) = token.map(str::trim).filter(|token| !token.is_empty()) else {
            return Err(unauthorized("workspace credential required"));
        };
        if token.len() > MAX_CREDENTIAL_BYTES {
            return Err(unauthorized("workspace credential is invalid"));
        }
        let digest = token_digest(token);
        let cache = self.cache.read().await;
        let Some(Some(access)) = cache.by_token_digest.get(&digest) else {
            return Err(unauthorized("workspace credential is invalid"));
        };
        if query_credential && !access.profile.allow_query_token_auth {
            return Err(unauthorized(
                "query-token authentication is disabled for this workspace",
            ));
        }
        let claimed_workspace = headers
            .get(WORKSPACE_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                query
                    .workspace
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            });
        if claimed_workspace.is_some_and(|workspace| workspace != access.profile.profile_id) {
            return Err((
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "workspace_credential_mismatch",
                    "message": "The credential does not authorize the requested workspace."
                })),
            )
                .into_response());
        }
        Ok(access.clone())
    }
}

async fn load_registry_cache(
    paths: AppPaths,
    secrets: SecretStore,
    ensure_profile_tokens: bool,
) -> Result<RegistryCache> {
    tokio::task::spawn_blocking(move || {
        let (config, revision) = paths.load_config_with_revision()?;
        if ensure_profile_tokens {
            let profile_ids = config
                .profiles
                .iter()
                .map(|profile| profile.profile_id.clone())
                .collect::<Vec<_>>();
            secrets.ensure_profiles(&paths, &profile_ids)?;
        } else {
            secrets.refresh(&paths)?;
        }
        let mut by_token_digest: HashMap<String, Option<WorkspaceAccess>> = HashMap::new();
        let mut by_profile_id = HashMap::new();
        for profile in config.profiles {
            let Some(secret) = secrets.get_vault(&paths, &profile.profile_id)? else {
                continue;
            };
            let access = WorkspaceAccess {
                profile: profile.clone(),
            };
            let digest = token_digest(&secret.token);
            match by_token_digest.entry(digest) {
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(Some(access.clone()));
                }
                std::collections::hash_map::Entry::Occupied(mut entry) => {
                    entry.insert(None);
                }
            }
            by_profile_id.insert(profile.profile_id.clone(), access);
        }
        Ok(RegistryCache {
            by_token_digest,
            by_profile_id,
            config_revision: revision,
        })
    })
    .await
    .context("workspace registry refresh task failed")?
}

fn config_revision(paths: &AppPaths) -> Option<[u8; 32]> {
    std::fs::read(paths.config_path())
        .ok()
        .map(|contents| Sha256::digest(contents).into())
}

fn token_digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

fn bearer_header(token: &str) -> Result<HeaderValue> {
    HeaderValue::from_str(&format!("Bearer {token}")).context("invalid bearer credential")
}

fn sanitized_forwarded_header(headers: &HeaderMap, name: &'static str) -> Option<String> {
    sanitized_forwarded_value(headers.get(name).and_then(|value| value.to_str().ok()))
}

fn sanitized_forwarded_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .chars()
                .filter(|character| !character.is_control())
                .take(128)
                .collect()
        })
}

fn broker_client_metadata(
    headers: &HeaderMap,
    query: &BrokerQuery,
) -> (Option<String>, Option<String>, Option<bool>) {
    let client_type = sanitized_forwarded_header(headers, CLIENT_TYPE_HEADER)
        .or_else(|| sanitized_forwarded_value(query.client_type.as_deref()));
    let client_name = sanitized_forwarded_header(headers, CLIENT_NAME_HEADER)
        .or_else(|| sanitized_forwarded_value(query.client_name.as_deref()));
    let client_foreground = headers
        .get(CLIENT_FOREGROUND_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| match value.trim() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        })
        .or(query.client_foreground);
    (client_type, client_name, client_foreground)
}

fn insert_client_metadata_headers(
    headers: &mut HeaderMap,
    client_type: Option<String>,
    client_name: Option<String>,
    client_foreground: Option<bool>,
) -> Result<()> {
    if let Some(value) = client_type {
        headers.insert(
            HeaderName::from_static(CLIENT_TYPE_HEADER),
            HeaderValue::from_str(&value)?,
        );
    }
    if let Some(value) = client_name {
        headers.insert(
            HeaderName::from_static(CLIENT_NAME_HEADER),
            HeaderValue::from_str(&value)?,
        );
    }
    if let Some(value) = client_foreground {
        headers.insert(
            HeaderName::from_static(CLIENT_FOREGROUND_HEADER),
            HeaderValue::from_static(if value { "true" } else { "false" }),
        );
    }
    Ok(())
}

fn unauthorized(message: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({
            "error": "unauthorized",
            "message": message,
        })),
    )
        .into_response()
}

fn service_unavailable(message: &str) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "error": "workspace_runtime_unavailable",
            "message": message,
        })),
    )
        .into_response()
}

#[derive(Clone, Debug)]
struct WorkerTarget {
    http_base: String,
    websocket_base: String,
    internal_token: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRuntimeActivity {
    active_runs: usize,
    queued_messages: usize,
    pending_steers: usize,
    pending_approvals: usize,
    pending_user_inputs: usize,
    active_preview_sessions: usize,
    in_flight_requests: usize,
    other_live_work: usize,
    can_retire: bool,
}

impl WorkerRuntimeActivity {
    #[cfg(test)]
    fn busy() -> Self {
        Self {
            other_live_work: 1,
            can_retire: false,
            ..Self::default()
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerStatusResponse {
    runtime: WorkerRuntimeActivity,
}

#[async_trait]
trait ManagedWorker: Send + Sync {
    fn target(&self) -> WorkerTarget;
    async fn activity(&self) -> Result<WorkerRuntimeActivity>;
    async fn is_running(&self) -> bool;
    async fn stop(&self) -> Result<()>;
}

#[async_trait]
trait WorkerLauncher: Send + Sync {
    async fn launch(&self, access: &WorkspaceAccess) -> Result<Arc<dyn ManagedWorker>>;
}

struct ProcessWorkerLauncher {
    paths: AppPaths,
    bridge_binary: PathBuf,
    settings: BrokerSettings,
    http: Client,
}

/// Re-registers a workspace's agent before waking its runtime.
///
/// A package-manager upgrade replaces the pinned executable, so healing here lets the first device
/// connection recover the workspace instead of closing every socket until setup is rerun by hand.
async fn refreshed_workspace_profile(paths: &AppPaths, profile: &Profile) -> Result<Profile> {
    let refresh_paths = paths.clone();
    let profile_id = profile.profile_id.clone();
    let refreshed = tokio::task::spawn_blocking(move || -> Result<Option<Profile>> {
        let Some(refresh) = refresh_registered_agent(&refresh_paths, &profile_id)? else {
            return Ok(None);
        };
        println!(
            "workspace {profile_id} re-registered {} after an upgrade: {} -> {} ({})",
            refresh.agent_id,
            refresh.previous_version,
            refresh.resolved_version,
            refresh.executable.display()
        );
        Ok(refresh_paths.load_config()?.find(&profile_id).cloned())
    })
    .await
    .context("agent refresh task failed")??;
    Ok(refreshed.unwrap_or_else(|| profile.clone()))
}

#[async_trait]
impl WorkerLauncher for ProcessWorkerLauncher {
    async fn launch(&self, access: &WorkspaceAccess) -> Result<Arc<dyn ManagedWorker>> {
        let bridge_port = allocate_worker_port(access.profile.preview_port).await?;
        let internal_token = random_token()?;
        let profile = refreshed_workspace_profile(&self.paths, &access.profile).await?;
        let mut config = BridgeRuntimeConfig::from_profile(
            &profile,
            &internal_token,
            SecretBackend::File,
            &self.paths,
        )?;
        config
            .values
            .insert("BRIDGE_HOST".into(), "127.0.0.1".into());
        config
            .values
            .insert("BRIDGE_PORT".into(), bridge_port.to_string());
        config
            .values
            .insert("BRIDGE_PREVIEW_HOST".into(), self.settings.host.clone());
        config.values.insert(
            "BRIDGE_PREVIEW_PORT".into(),
            profile.preview_port.to_string(),
        );
        config.values.insert(
            "BRIDGE_CONNECT_URL".into(),
            self.settings.connect_url.clone(),
        );
        config.values.insert(
            "BRIDGE_PREVIEW_CONNECT_URL".into(),
            profile.preview_connect_url.clone(),
        );
        config
            .values
            .insert("BRIDGE_ALLOW_QUERY_TOKEN_AUTH".into(), "true".into());
        config
            .values
            .insert("BRIDGE_ALLOW_OUTSIDE_ROOT_CWD".into(), "false".into());
        config
            .values
            .insert("BRIDGE_SHOW_PAIRING_QR".into(), "false".into());
        config
            .values
            .insert("BRIDGE_OWNER_PID".into(), std::process::id().to_string());

        let log_path = self.paths.log_path(&profile.profile_id);
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .with_context(|| format!("failed to open {}", log_path.display()))?;
        let stderr = stdout.try_clone()?;
        let mut command = Command::new(&self.bridge_binary);
        command
            .current_dir(&profile.workspace)
            .envs(&config.values)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        let child = command.spawn().with_context(|| {
            format!(
                "failed to start workspace worker {}",
                self.bridge_binary.display()
            )
        })?;
        let target = WorkerTarget {
            http_base: format!("http://127.0.0.1:{bridge_port}/"),
            websocket_base: format!("ws://127.0.0.1:{bridge_port}"),
            internal_token,
        };
        let worker = Arc::new(ProcessWorker {
            target,
            child: Mutex::new(child),
            http: self.http.clone(),
        });
        if let Err(error) = wait_for_worker(
            worker.clone(),
            Duration::from_millis(self.settings.worker_start_timeout_ms),
        )
        .await
        {
            let _ = worker.stop().await;
            return Err(error);
        }
        Ok(worker)
    }
}

struct ProcessWorker {
    target: WorkerTarget,
    child: Mutex<Child>,
    http: Client,
}

#[async_trait]
impl ManagedWorker for ProcessWorker {
    fn target(&self) -> WorkerTarget {
        self.target.clone()
    }

    async fn activity(&self) -> Result<WorkerRuntimeActivity> {
        let response = self
            .http
            .get(format!("{}status", self.target.http_base))
            .header(AUTHORIZATION, bearer_header(&self.target.internal_token)?)
            .send()
            .await
            .context("worker status request failed")?
            .error_for_status()
            .context("worker status was not successful")?;
        Ok(response
            .json::<WorkerStatusResponse>()
            .await
            .context("worker status was malformed")?
            .runtime)
    }

    async fn is_running(&self) -> bool {
        self.child
            .lock()
            .await
            .try_wait()
            .ok()
            .is_some_and(|status| status.is_none())
    }

    async fn stop(&self) -> Result<()> {
        let mut child = self.child.lock().await;
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        stop_child(&mut child, Duration::from_secs(8)).await
    }
}

async fn wait_for_worker(worker: Arc<dyn ManagedWorker>, wait: Duration) -> Result<()> {
    timeout(wait, async {
        loop {
            if !worker.is_running().await {
                bail!("workspace worker exited before accepting requests");
            }
            match worker.activity().await {
                Ok(_) => return Ok(()),
                Err(_) => sleep(WORKER_POLL_INTERVAL).await,
            }
        }
    })
    .await
    .map_err(|_| anyhow!("workspace worker did not become reachable within {wait:?}"))?
}

async fn allocate_worker_port(excluded: u16) -> Result<u16> {
    loop {
        let listener =
            tokio::net::TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
                .await?;
        let port = listener.local_addr()?.port();
        drop(listener);
        if port != excluded {
            return Ok(port);
        }
    }
}

fn random_token() -> Result<String> {
    let mut bytes = [0_u8; 32];
    fill_random(&mut bytes).context("failed to generate worker credential")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

struct WorkerRecord {
    worker: Arc<dyn ManagedWorker>,
    clients: usize,
    last_idle_at: Instant,
    last_used: u64,
    known_busy: bool,
    retiring: bool,
}

#[derive(Default)]
struct WorkerPoolState {
    workers: HashMap<String, WorkerRecord>,
}

struct WorkerPool {
    launcher: Arc<dyn WorkerLauncher>,
    state: Mutex<WorkerPoolState>,
    sweep_lock: Mutex<()>,
    launch_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    max_workers: usize,
    max_idle_workers: usize,
    idle_grace: Duration,
    usage_counter: AtomicU64,
    launching: AtomicUsize,
}

struct WorkerClientSession {
    profile_id: String,
    worker: Arc<dyn ManagedWorker>,
    pool: Weak<WorkerPool>,
    released: bool,
}

struct LaunchReservation<'a> {
    launching: &'a AtomicUsize,
}

impl Drop for LaunchReservation<'_> {
    fn drop(&mut self) {
        self.launching.fetch_sub(1, Ordering::AcqRel);
    }
}

impl WorkerClientSession {
    async fn release(mut self) {
        if let Some(pool) = self.pool.upgrade() {
            pool.release_client(&self.profile_id).await;
        }
        self.released = true;
    }
}

impl Drop for WorkerClientSession {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let Some(pool) = self.pool.upgrade() else {
            return;
        };
        let profile_id = self.profile_id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                pool.release_client(&profile_id).await;
            });
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerPoolSnapshot {
    running_workers: usize,
    connected_clients: usize,
    busy_workers: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceWorkerSnapshot {
    state: &'static str,
    connected_clients: usize,
}

impl WorkerPool {
    fn new(
        launcher: Arc<dyn WorkerLauncher>,
        max_workers: usize,
        max_idle_workers: usize,
        idle_grace: Duration,
    ) -> Self {
        Self {
            launcher,
            state: Mutex::new(WorkerPoolState::default()),
            sweep_lock: Mutex::new(()),
            launch_locks: Mutex::new(HashMap::new()),
            max_workers,
            max_idle_workers,
            idle_grace,
            usage_counter: AtomicU64::new(1),
            launching: AtomicUsize::new(0),
        }
    }

    #[cfg(test)]
    async fn contains(&self, profile_id: &str) -> bool {
        self.state.lock().await.workers.contains_key(profile_id)
    }

    async fn snapshot(&self) -> WorkerPoolSnapshot {
        let state = self.state.lock().await;
        WorkerPoolSnapshot {
            running_workers: state.workers.len(),
            connected_clients: state.workers.values().map(|worker| worker.clients).sum(),
            busy_workers: state
                .workers
                .values()
                .filter(|worker| worker.known_busy || worker.clients > 0)
                .count(),
        }
    }

    async fn workspace_snapshot(&self, profile_id: &str) -> WorkspaceWorkerSnapshot {
        let state = self.state.lock().await;
        match state.workers.get(profile_id) {
            None => WorkspaceWorkerSnapshot {
                state: "dormant",
                connected_clients: 0,
            },
            Some(worker) if worker.known_busy => WorkspaceWorkerSnapshot {
                state: "busy",
                connected_clients: worker.clients,
            },
            Some(worker) => WorkspaceWorkerSnapshot {
                state: "idle",
                connected_clients: worker.clients,
            },
        }
    }

    async fn acquire_client(
        self: &Arc<Self>,
        access: WorkspaceAccess,
    ) -> Result<WorkerClientSession> {
        let profile_id = access.profile.profile_id.clone();
        let launch_lock = {
            let mut locks = self.launch_locks.lock().await;
            locks
                .entry(profile_id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _launch = launch_lock.lock().await;
        loop {
            let needs_capacity = {
                let state = self.state.lock().await;
                !state.workers.contains_key(&profile_id)
                    && state
                        .workers
                        .len()
                        .saturating_add(self.launching.load(Ordering::Acquire))
                        >= self.max_workers
            };
            if needs_capacity {
                self.sweep(true).await?;
            }
            let mut should_launch = false;
            let existing = {
                let state = self.state.lock().await;
                let has_capacity = state
                    .workers
                    .len()
                    .saturating_add(self.launching.load(Ordering::Acquire))
                    < self.max_workers;
                match state.workers.get(&profile_id) {
                    Some(record) if record.retiring => None,
                    Some(record) => Some(record.worker.clone()),
                    None if has_capacity => {
                        self.launching.fetch_add(1, Ordering::AcqRel);
                        should_launch = true;
                        None
                    }
                    None => {
                        bail!(
                            "workspace worker capacity is busy (max {}); retry after another workspace settles",
                            self.max_workers
                        );
                    }
                }
            };
            if let Some(worker) = existing {
                if !worker.is_running().await {
                    self.state.lock().await.workers.remove(&profile_id);
                    continue;
                }
                let mut state = self.state.lock().await;
                let Some(record) = state.workers.get_mut(&profile_id) else {
                    continue;
                };
                if record.retiring || !Arc::ptr_eq(&record.worker, &worker) {
                    continue;
                }
                record.clients += 1;
                record.known_busy = true;
                record.last_used = self.usage_counter.fetch_add(1, Ordering::Relaxed);
                return Ok(WorkerClientSession {
                    profile_id,
                    worker,
                    pool: Arc::downgrade(self),
                    released: false,
                });
            }
            if !should_launch {
                sleep(Duration::from_millis(10)).await;
                continue;
            }

            let reservation = LaunchReservation {
                launching: &self.launching,
            };
            let launched = self.launcher.launch(&access).await;
            let mut state = self.state.lock().await;
            let worker = launched?;
            state.workers.insert(
                profile_id.clone(),
                WorkerRecord {
                    worker: worker.clone(),
                    clients: 1,
                    last_idle_at: Instant::now(),
                    last_used: self.usage_counter.fetch_add(1, Ordering::Relaxed),
                    known_busy: true,
                    retiring: false,
                },
            );
            drop(state);
            drop(reservation);
            return Ok(WorkerClientSession {
                profile_id,
                worker,
                pool: Arc::downgrade(self),
                released: false,
            });
        }
    }

    async fn release_client(&self, profile_id: &str) {
        let mut state = self.state.lock().await;
        if let Some(record) = state.workers.get_mut(profile_id) {
            record.clients = record.clients.saturating_sub(1);
            if record.clients == 0 {
                record.last_idle_at = Instant::now();
            }
            record.last_used = self.usage_counter.fetch_add(1, Ordering::Relaxed);
        }
    }

    async fn sweep(&self, capacity_pressure: bool) -> Result<()> {
        let _sweep = self.sweep_lock.lock().await;
        self.sweep_locked(capacity_pressure).await
    }

    async fn sweep_locked(&self, capacity_pressure: bool) -> Result<()> {
        let candidates = {
            let state = self.state.lock().await;
            state
                .workers
                .iter()
                .filter(|(_, record)| record.clients == 0 && !record.retiring)
                .map(|(profile_id, record)| (profile_id.clone(), record.worker.clone()))
                .collect::<Vec<_>>()
        };
        for (profile_id, worker) in candidates {
            if !worker.is_running().await {
                self.state.lock().await.workers.remove(&profile_id);
                continue;
            }
            let activity = worker.activity().await;
            let mut state = self.state.lock().await;
            let Some(record) = state.workers.get_mut(&profile_id) else {
                continue;
            };
            if record.clients > 0 || record.retiring {
                continue;
            }
            match activity {
                Ok(activity) if activity.can_retire => {
                    if record.known_busy {
                        record.last_idle_at = Instant::now();
                    }
                    record.known_busy = false;
                }
                _ => {
                    // Unavailable status is not evidence that an accepted turn has stopped.
                    record.known_busy = true;
                    record.last_idle_at = Instant::now();
                }
            }
        }

        let now = Instant::now();
        let mut idle = {
            let state = self.state.lock().await;
            state
                .workers
                .iter()
                .filter(|(_, record)| record.clients == 0 && !record.known_busy && !record.retiring)
                .map(|(profile_id, record)| {
                    (profile_id.clone(), record.last_idle_at, record.last_used)
                })
                .collect::<Vec<_>>()
        };
        idle.sort_by_key(|(_, _, last_used)| *last_used);
        let excess_idle = idle.len().saturating_sub(self.max_idle_workers);
        let capacity_needed = {
            let state = self.state.lock().await;
            usize::from(
                capacity_pressure
                    && state
                        .workers
                        .len()
                        .saturating_add(self.launching.load(Ordering::Acquire))
                        >= self.max_workers,
            )
        };
        let evict_count = excess_idle.max(capacity_needed);
        let mut evicted = 0;
        for (profile_id, idle_since, _) in idle {
            if evicted >= evict_count {
                break;
            }
            if now.saturating_duration_since(idle_since) < self.idle_grace {
                continue;
            }
            let worker = {
                let mut state = self.state.lock().await;
                let Some(record) = state.workers.get_mut(&profile_id) else {
                    continue;
                };
                if record.clients > 0
                    || record.known_busy
                    || record.retiring
                    || now.saturating_duration_since(record.last_idle_at) < self.idle_grace
                {
                    continue;
                }
                record.retiring = true;
                record.worker.clone()
            };
            if let Err(error) = worker.stop().await {
                if let Some(record) = self.state.lock().await.workers.get_mut(&profile_id) {
                    record.retiring = false;
                }
                return Err(error);
            }
            self.state.lock().await.workers.remove(&profile_id);
            evicted += 1;
        }
        Ok(())
    }

    async fn shutdown(&self) {
        let _sweep = self.sweep_lock.lock().await;
        let workers = {
            let mut state = self.state.lock().await;
            state
                .workers
                .drain()
                .map(|(_, record)| record.worker)
                .collect::<Vec<_>>()
        };
        for worker in workers {
            let _ = worker.stop().await;
        }
    }
}

fn worker_http_client() -> Result<Client> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(2))
        .build()
        .context("failed to build worker status client")
}

fn proxy_http_client() -> Result<Client> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .build()
        .context("failed to build broker proxy client")
}

#[derive(Clone, Copy)]
struct OwnerIdentity {
    pid: Option<u32>,
    started_at: Option<u64>,
}

impl OwnerIdentity {
    fn capture(pid: Option<u32>) -> Result<Self> {
        let Some(pid) = pid else {
            return Ok(Self {
                pid: None,
                started_at: None,
            });
        };
        let started_at = process_start_time(pid)
            .with_context(|| format!("owning desktop process {pid} is not running"))?;
        Ok(Self {
            pid: Some(pid),
            started_at: Some(started_at),
        })
    }

    async fn wait_for_exit(self) {
        let Some(pid) = self.pid else {
            std::future::pending::<()>().await;
            return;
        };
        loop {
            if process_start_time(pid) != self.started_at {
                return;
            }
            sleep(Duration::from_secs(1)).await;
        }
    }
}

fn process_start_time(pid: u32) -> Option<u64> {
    let mut system = System::new();
    let pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
    );
    system
        .process(pid)
        .and_then(|process| process_start_identity(pid.as_u32(), process.start_time()).ok())
}

async fn wait_for_shutdown(receiver: &mut tokio::sync::watch::Receiver<bool>) {
    while !*receiver.borrow() {
        if receiver.changed().await.is_err() {
            break;
        }
    }
}

async fn wait_for_runtime_executable_loss(
    path: PathBuf,
    poll_interval: Duration,
    required_missing_samples: u8,
) {
    let required_missing_samples = required_missing_samples.max(1);
    let mut missing_samples = 0_u8;
    loop {
        sleep(poll_interval).await;
        if runtime_executable_available(&path) {
            missing_samples = 0;
            continue;
        }
        missing_samples = missing_samples.saturating_add(1);
        if missing_samples >= required_missing_samples {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dappercode_desktop_core::ProfileAgent;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use tempfile::tempdir;

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
                argv: vec!["acp".to_string()],
                resolved_version: "1".to_string(),
                verified_digest: "sha256:test".to_string(),
            },
            updated_at: "now".to_string(),
        }
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
                "failed probes must not stop an accepted disconnected turn"
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
            tokio::join!(
                first_pool.acquire_client(first_access),
                second_pool.acquire_client(second_access)
            )
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
        let launch =
            tokio::spawn(async move { cancelled_pool.acquire_client(cancelled_access).await });
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
                    secrets.set_for_tests(
                        &paths,
                        &profile.profile_id,
                        &format!("token-{index}"),
                    )?;
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
        let (client_type, client_name, client_foreground) =
            broker_client_metadata(&headers, &query);
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
                .and_then(|value| value.to_str().ok()),
            Some("desktop-monitor"),
        );
        assert_eq!(
            worker_headers
                .get(CLIENT_NAME_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some("DapperCode"),
        );
        assert_eq!(
            worker_headers
                .get(CLIENT_FOREGROUND_HEADER)
                .and_then(|value| value.to_str().ok()),
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
}
