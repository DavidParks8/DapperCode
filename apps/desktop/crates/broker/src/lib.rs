#![cfg_attr(coverage_nightly, feature(coverage_attribute))]
#![cfg_attr(dylint_lib = "perfectionist", feature(register_tool))]
#![cfg_attr(dylint_lib = "perfectionist", register_tool(perfectionist))]
#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "broker HTTP/WebSocket proxy and worker pool lifecycle live in one crate root"
    )
)]
#![forbid(unsafe_code)]
// LLVM 21 crashes while exporting this Axum crate's coverage instantiation groups. Broker tests
// still run in coverage jobs; only the broken compiler mapping is disabled.
#![cfg_attr(coverage_nightly, coverage(off))]

//! Authenticated broker and worker proxy used by the desktop operator.

#[cfg(test)]
mod http_client_tests;

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use axum::body::Body;
use axum::extract::ws::{Message as AxumMessage, WebSocket};
use axum::extract::{Query, Request, State, WebSocketUpgrade};
use axum::http::header::{
    AUTHORIZATION, CONNECTION, CONTENT_LENGTH, HOST, TRANSFER_ENCODING, UPGRADE,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use dappercode_desktop_core::{
    process_start_identity, refresh_registered_agent, runtime_executable_available, stop_child,
    wait_for_shutdown_signal, AppPaths, BridgeRuntimeConfig, BrokerSettings, Profile, RuntimePaths,
    SecretBackend, SecretStore,
};
use futures_util::{SinkExt, StreamExt};
use getrandom::fill as fill_random;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::future::IntoFuture;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

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

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "binds broker and preview listeners, spawns background tasks, and coordinates shutdown"
        )
    )]
    pub async fn serve(self) -> Result<()> {
        self.settings.validate()?;
        let owner = OwnerIdentity::capture(self.owner_pid)?;
        let registry =
            Arc::new(WorkspaceRegistry::load(self.paths.clone(), self.secrets.clone()).await?);
        let bridge_binary = RuntimePaths::discover()?
            .bridge_binary_candidates()
            .into_iter()
            .find(|candidate| runtime_executable_available(candidate))
            .map(|candidate| candidate.canonicalize())
            .and_then(Result::ok)
            .context("the bundled dappercode-bridge worker executable is unavailable")?;
        let watched_bridge_binary = bridge_binary.clone();
        let launcher = Arc::new(ProcessWorkerLauncher {
            paths: self.paths.clone(),
            secrets: self.secrets.clone(),
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
                        self.settings.host, self.settings.bridge_port,
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
                        "legacy broker endpoint {address} is unavailable; re-pair affected mobile profiles: {error}",
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
            self.settings.host, self.settings.bridge_port,
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

#[derive(Default, Deserialize)]
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        perfectionist::excessive_cognitive_complexity,
        reason = "select! loop handles bidirectional WebSocket forwarding, pings, and close frames"
    )
)]
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        perfectionist::excessive_cognitive_complexity,
        reason = "proxies HTTP method, headers, query parameters, and streaming response body"
    )
)]
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
                    "workspace registry refresh failed; retaining the last authenticated cache: {error:#}",
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
                "workspace registry unavailable: {error:#}",
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
            .map(HeaderValue::to_str)
            .and_then(Result::ok)
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
        .map(Sha256::digest)
        .map(Into::into)
}

fn token_digest(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)
        .map(HeaderValue::to_str)
        .and_then(Result::ok)
        .and_then(|value| value.strip_prefix("Bearer "))
}

fn bearer_header(token: &str) -> Result<HeaderValue> {
    HeaderValue::from_str(&format!("Bearer {token}")).context("invalid bearer credential")
}

fn sanitized_forwarded_header(headers: &HeaderMap, name: &'static str) -> Option<String> {
    sanitized_forwarded_value(
        headers
            .get(name)
            .map(HeaderValue::to_str)
            .and_then(Result::ok),
    )
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
        .map(HeaderValue::to_str)
        .and_then(Result::ok)
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

#[derive(Clone)]
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
    status: String,
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
    secrets: SecretStore,
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
    tokio::task::spawn_blocking(move || -> Result<Profile> {
        if let Some(refresh) = refresh_registered_agent(&refresh_paths, &profile_id)? {
            println!(
                "workspace {profile_id} re-registered {} after an upgrade: {} -> {} ({})",
                refresh.agent_id,
                refresh.previous_version,
                refresh.resolved_version,
                refresh.executable.display(),
            );
        }
        refresh_paths
            .load_config()?
            .find(&profile_id)
            .cloned()
            .context("workspace profile disappeared during agent refresh")
    })
    .await
    .context("agent refresh task failed")?
}

#[async_trait]
impl WorkerLauncher for ProcessWorkerLauncher {
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "allocates worker ports, configures environment, spawns child, and waits for health"
        )
    )]
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
        config.apply_phone_call(&self.paths, &self.secrets)?;

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
                self.bridge_binary.display(),
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
            worker
                .stop()
                .await
                .with_context(|| format!("{error:#}; failed to stop unavailable worker"))?;
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
        Ok(self.status().await?.runtime)
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

impl ProcessWorker {
    async fn status(&self) -> Result<WorkerStatusResponse> {
        let response = self
            .http
            .get(format!("{}status", self.target.http_base))
            .header(AUTHORIZATION, bearer_header(&self.target.internal_token)?)
            .send()
            .await
            .context("worker status request failed")?
            .error_for_status()
            .context("worker status was not successful")?;
        response
            .json::<WorkerStatusResponse>()
            .await
            .context("worker status was malformed")
    }
}

async fn wait_for_worker(worker: Arc<ProcessWorker>, wait: Duration) -> Result<()> {
    timeout(wait, async {
        loop {
            if !worker.is_running().await {
                bail!("workspace worker exited before accepting requests");
            }
            match worker.status().await {
                Ok(status) if matches!(status.status.as_str(), "ok" | "degraded") => return Ok(()),
                Ok(_) => bail!("workspace agent failed to initialize; inspect the workspace bridge log and retry after the agent update finishes"),
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

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            perfectionist::excessive_cognitive_complexity,
            reason = "coordinates per-workspace launch locking, capacity eviction, and worker reuse"
        )
    )]
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
                            self.max_workers,
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

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            perfectionist::excessive_cognitive_complexity,
            reason = "selects idle workers for retirement while respecting busy status and grace periods"
        )
    )]
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
    broker_http_client_builder()?
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(2))
        .build()
        .context("failed to build worker status client")
}

fn proxy_http_client() -> Result<Client> {
    broker_http_client_builder()?
        .connect_timeout(Duration::from_secs(2))
        .build()
        .context("failed to build broker proxy client")
}

fn broker_http_client_builder() -> Result<reqwest::ClientBuilder> {
    // Workers currently use loopback HTTP. Preserve ring and WebPKI-only trust for HTTPS too.
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    })
    .with_no_client_auth();
    Ok(Client::builder()
        .tls_backend_preconfigured(tls)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none()))
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
        let started_at = process_start_time(pid)?
            .with_context(|| format!("owning desktop process {pid} is not running"))?;
        Ok(Self {
            pid: Some(pid),
            started_at: Some(started_at),
        })
    }

    async fn wait_for_exit(self) {
        self.wait_for_exit_with(process_start_time, Duration::from_secs(1))
            .await;
    }

    async fn wait_for_exit_with(
        self,
        mut inspect: impl FnMut(u32) -> Result<Option<u64>>,
        poll_interval: Duration,
    ) {
        let Some(pid) = self.pid else {
            std::future::pending::<()>().await;
            return;
        };
        loop {
            match inspect(pid) {
                Ok(started_at) if started_at != self.started_at => return,
                Ok(_) => {}
                Err(error) => {
                    eprintln!("failed to inspect owning desktop process {pid}: {error:#}");
                }
            }
            sleep(poll_interval).await;
        }
    }
}

fn process_start_time(pid: u32) -> Result<Option<u64>> {
    let mut system = System::new().context("failed to initialize process inspection")?;
    let pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
    );
    system
        .process(pid)
        .filter(|process| process.status() != sysinfo::ProcessStatus::Zombie)
        .map(|process| process_start_identity(pid.as_u32(), process.start_time()))
        .transpose()
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
#[path = "lib_tests.rs"]
mod tests;
