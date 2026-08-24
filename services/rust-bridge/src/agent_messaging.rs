use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::task::{Context, Poll};
use std::time::Duration;

use agent_client_protocol::schema::v1::{HttpHeader, McpServer, McpServerHttp, McpServerSse};
use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{header::AUTHORIZATION, HeaderMap, HeaderName, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::{Stream, StreamExt};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ClientJsonRpcMessage, ContentBlock, ServerCapabilities, ServerInfo,
    ServerJsonRpcMessage,
};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::session::SessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{schemars, tool, tool_handler, tool_router, ErrorData, ServerHandler, ServiceExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::{CancellationToken, PollSender};
use uuid::Uuid;

use crate::acp::runtime::McpTransportPreference;
use crate::bridge_protocol::BridgeQueueService;
use crate::resource_limits::QUEUE_MAX_CONTENT_BYTES;
use crate::runtime_backend::RuntimeBackend;

pub(crate) const AGENT_MESSAGE_ENVELOPE_VERSION: u32 = 1;
pub(crate) const SEND_AGENT_MESSAGE_TOOL: &str = "send_agent_message";

const ENVELOPE_PREFIX: &str = "<<<dappercode.dev/agent-message:v1>>>\n";
const ENVELOPE_SUFFIX: &str = "\n<<<dappercode.dev/agent-message:end>>>";
const MCP_SERVER_NAME: &str = "dappercode-agent-messaging";
const MAX_MCP_CREDENTIALS: usize = 4_096;
const MAX_MCP_PROTOCOL_SESSIONS: usize = 512;
const MAX_MCP_SESSIONS_PER_CREDENTIAL: usize = 4;
const MAX_AGENT_MESSAGE_BODY_BYTES: usize = 48 * 1024;
const MAX_MCP_REQUEST_BYTES: usize = MAX_AGENT_MESSAGE_BODY_BYTES * 6 + 16 * 1024;
const MCP_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MCP_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MCP_SESSION_HEADER: HeaderName = HeaderName::from_static("mcp-session-id");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentRelationKind {
    Parent,
    SubAgent,
}

impl AgentRelationKind {
    pub(crate) fn inverse(self) -> Self {
        match self {
            Self::Parent => Self::SubAgent,
            Self::SubAgent => Self::Parent,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentRelationStatus {
    Running,
    Idle,
    Unloaded,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRelationSession {
    pub(crate) thread_id: String,
    pub(crate) title: Option<String>,
    pub(crate) status: AgentRelationStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRelations {
    pub(crate) parent: Option<AgentRelationSession>,
    pub(crate) children: Vec<AgentRelationSession>,
    pub(crate) children_truncated: bool,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(crate) enum AgentRelationError {
    #[error("invalid opaque ACP thread ID")]
    InvalidThreadId,
    #[error("unknown caller thread: {0}")]
    UnknownCaller(String),
    #[error("unknown target thread: {0}")]
    UnknownTarget(String),
    #[error(
        "recipientThreadId is this session's own ID; choose parent.threadId or children[].threadId from list_agent_relations"
    )]
    SelfTarget,
    #[error("agent messaging cannot cross ACP agents")]
    CrossAgent,
    #[error("target is not the caller's direct parent or direct sub-agent")]
    NotDirect,
}

pub(crate) struct PendingMcpCredential {
    token: String,
    store: Weak<McpCredentialStore>,
    armed: bool,
}

#[derive(Clone)]
struct AuthenticatedMcpCredential {
    token: String,
    agent_id: String,
}

tokio::task_local! {
    static AUTHENTICATED_MCP_CREDENTIAL: AuthenticatedMcpCredential;
}

impl Drop for PendingMcpCredential {
    fn drop(&mut self) {
        if self.armed {
            if let Some(store) = self.store.upgrade() {
                store.remove_token(&self.token);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum McpCredentialPrincipal {
    Pending { agent_id: String },
    Active { agent_id: String, thread_id: String },
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(crate) enum McpCredentialError {
    #[error("agent messaging MCP credential limit reached")]
    LimitReached,
    #[error("unknown pending agent messaging MCP credential")]
    UnknownPending,
}

#[derive(Clone)]
pub(crate) struct AgentMessagingMcpConfig {
    pub(crate) http_url: String,
    pub(crate) sse_url: String,
    credentials: Arc<McpCredentialStore>,
}

impl AgentMessagingMcpConfig {
    pub(crate) fn new(
        http_url: String,
        sse_url: String,
        credentials: Arc<McpCredentialStore>,
    ) -> Self {
        Self {
            http_url,
            sse_url,
            credentials,
        }
    }

    pub(crate) fn stage_credential(
        &self,
        agent_id: &str,
    ) -> Result<PendingMcpCredential, McpCredentialError> {
        McpCredentialStore::stage(&self.credentials, agent_id)
    }

    pub(crate) fn activate_credential(
        &self,
        mut credential: PendingMcpCredential,
        thread_id: &str,
    ) -> Result<(), McpCredentialError> {
        self.credentials.activate(&credential.token, thread_id)?;
        credential.armed = false;
        Ok(())
    }

    pub(crate) fn revoke_threads<'a>(&self, thread_ids: impl IntoIterator<Item = &'a str>) {
        self.credentials.revoke_threads(thread_ids);
    }

    pub(crate) fn revoke_all(&self) {
        self.credentials.revoke_all();
    }

    pub(crate) fn descriptor(
        &self,
        preference: McpTransportPreference,
        credential: &PendingMcpCredential,
    ) -> Option<McpServer> {
        let headers = vec![HttpHeader::new(
            "Authorization",
            format!("Bearer {}", credential.token),
        )];
        match preference {
            McpTransportPreference::Http => Some(McpServer::Http(
                McpServerHttp::new(MCP_SERVER_NAME, &self.http_url).headers(headers),
            )),
            McpTransportPreference::Sse => Some(McpServer::Sse(
                McpServerSse::new(MCP_SERVER_NAME, &self.sse_url).headers(headers),
            )),
            McpTransportPreference::Unavailable => None,
        }
    }
}

#[derive(Default)]
struct McpCredentialState {
    by_token: HashMap<String, McpCredentialRecord>,
    active_by_thread: HashMap<String, String>,
    http_sessions: HashMap<String, String>,
    legacy_sessions: HashMap<String, (String, CancellationToken)>,
    protocol_session_order: VecDeque<McpProtocolSession>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum McpProtocolSession {
    Http(String),
    Legacy(String),
}

#[derive(Default)]
struct McpProtocolSessionEvictions {
    http_sessions: Vec<String>,
    legacy_sessions: Vec<CancellationToken>,
}

impl McpProtocolSessionEvictions {
    #[cfg(test)]
    fn is_empty(&self) -> bool {
        self.http_sessions.is_empty() && self.legacy_sessions.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum McpHttpSessionAuthorization {
    Authorized,
    WrongCredential,
    Unknown,
}

struct McpCredentialRecord {
    agent_id: String,
    thread_id: Option<String>,
}

pub(crate) struct McpCredentialStore {
    state: Mutex<McpCredentialState>,
    http_session_manager: OnceLock<Arc<LocalSessionManager>>,
}

impl Default for McpCredentialStore {
    fn default() -> Self {
        Self {
            state: Mutex::new(McpCredentialState::default()),
            http_session_manager: OnceLock::new(),
        }
    }
}

impl McpCredentialStore {
    fn install_http_session_manager(&self, manager: Arc<LocalSessionManager>) {
        let _ = self.http_session_manager.set(manager);
    }

    fn stage(
        store: &Arc<Self>,
        agent_id: &str,
    ) -> Result<PendingMcpCredential, McpCredentialError> {
        let mut state = store
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.by_token.len() >= MAX_MCP_CREDENTIALS {
            return Err(McpCredentialError::LimitReached);
        }
        let token = format!("dcm_{}", Uuid::new_v4().simple());
        state.by_token.insert(
            token.clone(),
            McpCredentialRecord {
                agent_id: agent_id.to_string(),
                thread_id: None,
            },
        );
        Ok(PendingMcpCredential {
            token,
            store: Arc::downgrade(store),
            armed: true,
        })
    }

    fn activate(&self, token: &str, thread_id: &str) -> Result<(), McpCredentialError> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let record = state
            .by_token
            .get_mut(token)
            .ok_or(McpCredentialError::UnknownPending)?;
        if record.thread_id.is_some() {
            return Err(McpCredentialError::UnknownPending);
        }
        record.thread_id = Some(thread_id.to_string());
        let previous = state
            .active_by_thread
            .insert(thread_id.to_string(), token.to_string());
        let (http_sessions, legacy_sessions) = if let Some(previous) = previous {
            state.by_token.remove(&previous);
            Self::take_protocol_sessions(&mut state, &previous)
        } else {
            (Vec::new(), Vec::new())
        };
        drop(state);
        self.close_protocol_sessions(http_sessions, legacy_sessions);
        Ok(())
    }

    fn remove_token(&self, token: &str) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let Some(record) = state.by_token.remove(token) else {
            return;
        };
        if let Some(thread_id) = record.thread_id {
            if state.active_by_thread.get(&thread_id).map(String::as_str) == Some(token) {
                state.active_by_thread.remove(&thread_id);
            }
        }
        let (http_sessions, legacy_sessions) = Self::take_protocol_sessions(&mut state, token);
        drop(state);
        self.close_protocol_sessions(http_sessions, legacy_sessions);
    }

    fn revoke_threads<'a>(&self, thread_ids: impl IntoIterator<Item = &'a str>) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let mut http_sessions = Vec::new();
        let mut legacy_sessions = Vec::new();
        for thread_id in thread_ids {
            if let Some(token) = state.active_by_thread.remove(thread_id) {
                state.by_token.remove(&token);
                let (http, legacy) = Self::take_protocol_sessions(&mut state, &token);
                http_sessions.extend(http);
                legacy_sessions.extend(legacy);
            }
        }
        drop(state);
        self.close_protocol_sessions(http_sessions, legacy_sessions);
    }

    fn revoke_all(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let http_sessions = state.http_sessions.keys().cloned().collect::<Vec<_>>();
        let legacy_sessions = state
            .legacy_sessions
            .drain()
            .map(|(_, (_, cancellation))| cancellation)
            .collect::<Vec<_>>();
        state.by_token.clear();
        state.active_by_thread.clear();
        state.http_sessions.clear();
        state.protocol_session_order.clear();
        drop(state);
        self.close_protocol_sessions(http_sessions, legacy_sessions);
    }

    fn authenticate(&self, authorization: &str) -> Option<AuthenticatedMcpCredential> {
        let token = authorization.strip_prefix("Bearer ")?;
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let record = state.by_token.get(token)?;
        Some(AuthenticatedMcpCredential {
            token: token.to_string(),
            agent_id: record.agent_id.clone(),
        })
    }

    fn resolve_token(&self, token: &str) -> Option<McpCredentialPrincipal> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let record = state.by_token.get(token)?;
        Some(match &record.thread_id {
            Some(thread_id) => McpCredentialPrincipal::Active {
                agent_id: record.agent_id.clone(),
                thread_id: thread_id.clone(),
            },
            None => McpCredentialPrincipal::Pending {
                agent_id: record.agent_id.clone(),
            },
        })
    }

    fn http_session_authorization(
        &self,
        session_id: &str,
        token: &str,
    ) -> McpHttpSessionAuthorization {
        match self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .http_sessions
            .get(session_id)
        {
            Some(bound) if bound == token => McpHttpSessionAuthorization::Authorized,
            Some(_) => McpHttpSessionAuthorization::WrongCredential,
            None => McpHttpSessionAuthorization::Unknown,
        }
    }

    fn bind_http_session(
        &self,
        session_id: &str,
        token: &str,
    ) -> Result<McpProtocolSessionEvictions, ()> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state.by_token.contains_key(token) {
            return Err(());
        }
        if let Some(bound) = state.http_sessions.get(session_id) {
            return (bound == token)
                .then(McpProtocolSessionEvictions::default)
                .ok_or(());
        }
        let evicted = Self::make_protocol_session_capacity(&mut state, token)?;
        state
            .http_sessions
            .insert(session_id.to_string(), token.to_string());
        state
            .protocol_session_order
            .push_back(McpProtocolSession::Http(session_id.to_string()));
        Ok(evicted)
    }

    fn unbind_http_session(&self, session_id: &str) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.http_sessions.remove(session_id);
        state
            .protocol_session_order
            .retain(|bound| *bound != McpProtocolSession::Http(session_id.to_string()));
    }

    async fn close_http_session(&self, session_id: &str) {
        let Some(manager) = self.http_session_manager.get() else {
            return;
        };
        let session_id: Arc<str> = Arc::from(session_id);
        let _ = manager.close_session(&session_id).await;
    }

    fn bind_legacy_session(
        &self,
        session_id: &str,
        token: &str,
        cancellation: CancellationToken,
    ) -> Result<McpProtocolSessionEvictions, ()> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state.by_token.contains_key(token) {
            return Err(());
        }
        let evicted = Self::make_protocol_session_capacity(&mut state, token)?;
        state
            .legacy_sessions
            .insert(session_id.to_string(), (token.to_string(), cancellation));
        state
            .protocol_session_order
            .push_back(McpProtocolSession::Legacy(session_id.to_string()));
        Ok(evicted)
    }

    fn unbind_legacy_session(&self, session_id: &str) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.legacy_sessions.remove(session_id);
        state
            .protocol_session_order
            .retain(|bound| *bound != McpProtocolSession::Legacy(session_id.to_string()));
    }

    fn make_protocol_session_capacity(
        state: &mut McpCredentialState,
        token: &str,
    ) -> Result<McpProtocolSessionEvictions, ()> {
        let mut evicted = McpProtocolSessionEvictions::default();
        while Self::credential_protocol_session_count(state, token)
            >= MAX_MCP_SESSIONS_PER_CREDENTIAL
        {
            let bound = state
                .protocol_session_order
                .iter()
                .find(|bound| Self::protocol_session_matches_token(state, bound, token))
                .cloned()
                .ok_or(())?;
            Self::evict_protocol_session(state, bound, &mut evicted);
        }
        while state.http_sessions.len() + state.legacy_sessions.len() >= MAX_MCP_PROTOCOL_SESSIONS {
            let bound = state.protocol_session_order.front().cloned().ok_or(())?;
            Self::evict_protocol_session(state, bound, &mut evicted);
        }
        Ok(evicted)
    }

    fn credential_protocol_session_count(state: &McpCredentialState, token: &str) -> usize {
        state
            .http_sessions
            .values()
            .filter(|bound| bound.as_str() == token)
            .count()
            + state
                .legacy_sessions
                .values()
                .filter(|(bound, _)| bound == token)
                .count()
    }

    fn protocol_session_matches_token(
        state: &McpCredentialState,
        session: &McpProtocolSession,
        token: &str,
    ) -> bool {
        match session {
            McpProtocolSession::Http(session_id) => state
                .http_sessions
                .get(session_id)
                .is_some_and(|bound| bound == token),
            McpProtocolSession::Legacy(session_id) => state
                .legacy_sessions
                .get(session_id)
                .is_some_and(|(bound, _)| bound == token),
        }
    }

    fn evict_protocol_session(
        state: &mut McpCredentialState,
        session: McpProtocolSession,
        evicted: &mut McpProtocolSessionEvictions,
    ) {
        state
            .protocol_session_order
            .retain(|bound| bound != &session);
        match session {
            McpProtocolSession::Http(session_id) => {
                if state.http_sessions.remove(&session_id).is_some() {
                    evicted.http_sessions.push(session_id);
                }
            }
            McpProtocolSession::Legacy(session_id) => {
                if let Some((_, cancellation)) = state.legacy_sessions.remove(&session_id) {
                    evicted.legacy_sessions.push(cancellation);
                }
            }
        }
    }

    fn take_protocol_sessions(
        state: &mut McpCredentialState,
        token: &str,
    ) -> (Vec<String>, Vec<CancellationToken>) {
        let http_ids = state
            .http_sessions
            .iter()
            .filter_map(|(session_id, bound)| (bound == token).then_some(session_id.clone()))
            .collect::<Vec<_>>();
        for session_id in &http_ids {
            state.http_sessions.remove(session_id);
        }
        let legacy_ids = state
            .legacy_sessions
            .iter()
            .filter_map(|(session_id, (bound, _))| (bound == token).then_some(session_id.clone()))
            .collect::<Vec<_>>();
        let legacy_cancellations = legacy_ids
            .iter()
            .filter_map(|session_id| {
                state
                    .legacy_sessions
                    .remove(session_id)
                    .map(|(_, cancellation)| cancellation)
            })
            .collect::<Vec<_>>();
        state.protocol_session_order.retain(|bound| match bound {
            McpProtocolSession::Http(session_id) => !http_ids.contains(session_id),
            McpProtocolSession::Legacy(session_id) => !legacy_ids.contains(session_id),
        });
        (http_ids, legacy_cancellations)
    }

    fn close_protocol_sessions(
        &self,
        http_sessions: Vec<String>,
        legacy_sessions: Vec<CancellationToken>,
    ) {
        for cancellation in legacy_sessions {
            cancellation.cancel();
        }
        let Some(manager) = self.http_session_manager.get().cloned() else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        for session_id in http_sessions {
            let manager = manager.clone();
            runtime.spawn(async move {
                let session_id: Arc<str> = Arc::from(session_id);
                let _ = manager.close_session(&session_id).await;
            });
        }
    }

    #[cfg(test)]
    fn resolve_authorization(&self, authorization: &str) -> Option<McpCredentialPrincipal> {
        self.authenticate(authorization)
            .and_then(|credential| self.resolve_token(&credential.token))
    }
}

pub(crate) struct AgentMessagingService {
    config: AgentMessagingMcpConfig,
    cancellation: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl AgentMessagingService {
    pub(crate) async fn start(
        backend: Weak<RuntimeBackend>,
        queue: Weak<BridgeQueueService>,
    ) -> Result<Self, String> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("failed to bind agent messaging MCP listener: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("failed to inspect agent messaging MCP listener: {error}"))?;
        let base_url = format!("http://{address}");
        let credentials = Arc::new(McpCredentialStore::default());
        let http_session_manager = Arc::new(LocalSessionManager::default());
        credentials.install_http_session_manager(http_session_manager.clone());
        let cancellation = CancellationToken::new();
        let state = Arc::new(AgentMessagingRouterState {
            backend,
            queue,
            credentials: credentials.clone(),
            legacy_sessions: Arc::new(Mutex::new(HashMap::new())),
            message_url: format!("{base_url}/message"),
        });

        let handler_state = state.clone();
        let streamable_http: StreamableHttpService<AgentMessagingMcpHandler, LocalSessionManager> =
            StreamableHttpService::new(
                move || {
                    let credential = AUTHENTICATED_MCP_CREDENTIAL
                        .try_with(Clone::clone)
                        .map_err(|_| io::Error::other("missing authenticated MCP credential"))?;
                    Ok(AgentMessagingMcpHandler::new(
                        credential,
                        handler_state.clone(),
                    ))
                },
                http_session_manager,
                StreamableHttpServerConfig::default()
                    .with_sse_keep_alive(None)
                    .with_cancellation_token(cancellation.child_token()),
            );
        let auth_state = state.clone();
        let router = Router::new()
            .route("/sse", get(open_legacy_sse))
            .route("/message", post(post_legacy_message))
            .nest_service("/mcp", streamable_http)
            .layer(DefaultBodyLimit::max(MAX_MCP_REQUEST_BYTES))
            .layer(middleware::from_fn_with_state(
                auth_state,
                authenticate_mcp_request,
            ))
            .with_state(state);
        let server_cancellation = cancellation.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router)
                .with_graceful_shutdown(server_cancellation.cancelled_owned())
                .await
            {
                eprintln!("agent messaging MCP listener stopped: {error}");
            }
        });

        Ok(Self {
            config: AgentMessagingMcpConfig::new(
                format!("{base_url}/mcp"),
                format!("{base_url}/sse"),
                credentials,
            ),
            cancellation,
            task,
        })
    }

    pub(crate) fn config(&self) -> AgentMessagingMcpConfig {
        self.config.clone()
    }

    pub(crate) async fn shutdown(self) {
        self.config.revoke_all();
        self.cancellation.cancel();
        let mut task = self.task;
        if tokio::time::timeout(MCP_SHUTDOWN_TIMEOUT, &mut task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
        }
    }
}

struct AgentMessagingRouterState {
    backend: Weak<RuntimeBackend>,
    queue: Weak<BridgeQueueService>,
    credentials: Arc<McpCredentialStore>,
    legacy_sessions: Arc<Mutex<HashMap<String, LegacySseSession>>>,
    message_url: String,
}

struct LegacySseSession {
    token: String,
    inbound: mpsc::Sender<ClientJsonRpcMessage>,
    cancellation: CancellationToken,
}

#[derive(Clone)]
struct AgentMessagingMcpHandler {
    credential: AuthenticatedMcpCredential,
    state: Arc<AgentMessagingRouterState>,
    tool_router: ToolRouter<Self>,
}

impl AgentMessagingMcpHandler {
    fn new(credential: AuthenticatedMcpCredential, state: Arc<AgentMessagingRouterState>) -> Self {
        Self {
            credential,
            state,
            tool_router: Self::tool_router(),
        }
    }

    fn active_caller(&self) -> Result<(String, String), ErrorData> {
        match self.state.credentials.resolve_token(&self.credential.token) {
            Some(McpCredentialPrincipal::Active {
                agent_id,
                thread_id,
            }) if agent_id == self.credential.agent_id => Ok((agent_id, thread_id)),
            Some(McpCredentialPrincipal::Pending { .. }) => Err(ErrorData::invalid_request(
                "agent messaging is unavailable until the ACP session is active",
                None,
            )),
            _ => Err(ErrorData::invalid_request(
                "agent messaging MCP credential is no longer valid",
                None,
            )),
        }
    }

    fn backend(&self) -> Result<Arc<RuntimeBackend>, ErrorData> {
        self.state.backend.upgrade().ok_or_else(|| {
            ErrorData::internal_error("agent messaging backend is shutting down", None)
        })
    }

    fn queue(&self) -> Result<Arc<BridgeQueueService>, ErrorData> {
        self.state
            .queue
            .upgrade()
            .ok_or_else(|| ErrorData::internal_error("agent message queue is shutting down", None))
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendAgentMessageArguments {
    #[schemars(
        description = "Opaque bridge thread ID of a direct parent or direct sub-agent. When replying to a delivered agent message, use its replyToThreadId; never copy its recipientThreadId, which identifies this session."
    )]
    recipient_thread_id: String,
    #[schemars(description = "One-way message body; the recipient must call this tool to reply")]
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SendAgentMessageResult {
    message_id: String,
    disposition: AgentMessageDisposition,
}

#[tool_router]
impl AgentMessagingMcpHandler {
    #[tool(
        description = "List this session's direct parent and direct sub-agents. The caller's own thread ID is omitted; only parent.threadId or children[].threadId may be passed to send_agent_message, and only recipients with status running or idle are currently messageable"
    )]
    async fn list_agent_relations(&self) -> Result<CallToolResult, ErrorData> {
        let (_, caller_thread_id) = self.active_caller()?;
        let relations = self
            .backend()?
            .agent_relations(&caller_thread_id)
            .await
            .map_err(agent_relation_tool_error)?;
        json_tool_result(relations)
    }

    #[tool(
        description = "Send a one-way message to a direct parent or direct sub-agent using parent.threadId or children[].threadId from list_agent_relations; never use this session's own thread ID. The recipient explicitly calls this tool to reply"
    )]
    async fn send_agent_message(
        &self,
        Parameters(arguments): Parameters<SendAgentMessageArguments>,
    ) -> Result<CallToolResult, ErrorData> {
        let (_, caller_thread_id) = self.active_caller()?;
        let recipient_thread_id = arguments.recipient_thread_id.trim();
        if recipient_thread_id.is_empty() {
            return Err(ErrorData::invalid_params(
                "recipientThreadId must not be empty",
                None,
            ));
        }
        if arguments.message.trim().is_empty() {
            return Err(ErrorData::invalid_params("message must not be empty", None));
        }
        if arguments.message.len() > MAX_AGENT_MESSAGE_BODY_BYTES {
            return Err(ErrorData::invalid_params(
                format!("message must be at most {MAX_AGENT_MESSAGE_BODY_BYTES} bytes"),
                None,
            ));
        }

        let backend = self.backend()?;
        let (relation, caller, recipient) = backend
            .direct_agent_relation_sessions(&caller_thread_id, recipient_thread_id)
            .await
            .map_err(agent_relation_tool_error)?;
        if !matches!(
            recipient.status,
            AgentRelationStatus::Running | AgentRelationStatus::Idle
        ) {
            return Err(ErrorData::invalid_params(
                format!(
                    "recipient agent session is {} and must be loaded before messaging",
                    match recipient.status {
                        AgentRelationStatus::Unloaded => "unloaded",
                        AgentRelationStatus::Unavailable => "unavailable",
                        AgentRelationStatus::Running | AgentRelationStatus::Idle => unreachable!(),
                    }
                ),
                None,
            ));
        }
        let message_id = Uuid::new_v4().to_string();
        let envelope = AgentMessageEnvelope::new(
            message_id.clone(),
            caller_thread_id.clone(),
            recipient.thread_id.clone(),
            relation,
            caller.title.clone(),
            arguments.message.clone(),
        );
        validate_agent_message_envelope_size(&envelope)?;
        let disposition = self
            .queue()?
            .send_agent_message(
                &envelope,
                AgentMessageOrigin {
                    message_id: message_id.clone(),
                    direction: AgentMessageDirection::Received,
                    related_thread_id: caller_thread_id,
                    related_title: caller.title,
                    relation: relation.inverse(),
                    disposition: AgentMessageDisposition::Queued,
                    body: arguments.message,
                },
                AgentMessageOrigin {
                    message_id: message_id.clone(),
                    direction: AgentMessageDirection::Sent,
                    related_thread_id: recipient.thread_id.clone(),
                    related_title: recipient.title.clone(),
                    relation,
                    disposition: AgentMessageDisposition::Queued,
                    body: envelope.body.clone(),
                },
            )
            .await
            .map_err(|error| ErrorData::internal_error(error, None))?;
        json_tool_result(SendAgentMessageResult {
            message_id,
            disposition,
        })
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for AgentMessagingMcpHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Use these tools only for explicit one-way communication with direct parent and sub-agent sessions. list_agent_relations omits this session's own thread ID; only its parent.threadId and children[].threadId values are valid send_agent_message recipients.",
        )
    }
}

fn validate_agent_message_envelope_size(envelope: &AgentMessageEnvelope) -> Result<(), ErrorData> {
    let encoded = envelope
        .encode()
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    if encoded.len() > QUEUE_MAX_CONTENT_BYTES {
        return Err(ErrorData::invalid_params(
            format!(
                "message is too large after delivery encoding; shorten it so the encoded payload is at most {QUEUE_MAX_CONTENT_BYTES} bytes"
            ),
            None,
        ));
    }
    Ok(())
}

fn json_tool_result(value: impl Serialize) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::success(vec![ContentBlock::json(value)?]))
}

fn agent_relation_tool_error(error: AgentRelationError) -> ErrorData {
    ErrorData::invalid_params(error.to_string(), None)
}

async fn authenticate_mcp_request(
    State(state): State<Arc<AgentMessagingRouterState>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(authorization) = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(credential) = state.credentials.authenticate(authorization) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let session_id = request
        .headers()
        .get(&MCP_SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if let Some(session_id) = session_id.as_deref() {
        match state
            .credentials
            .http_session_authorization(session_id, &credential.token)
        {
            McpHttpSessionAuthorization::Authorized => {}
            McpHttpSessionAuthorization::WrongCredential => {
                return StatusCode::FORBIDDEN.into_response();
            }
            McpHttpSessionAuthorization::Unknown => {
                return StatusCode::NOT_FOUND.into_response();
            }
        }
    }
    let deleting = request.method() == Method::DELETE;
    let token = credential.token.clone();
    let response = AUTHENTICATED_MCP_CREDENTIAL
        .scope(credential, next.run(request))
        .await;
    let response_session_id = response
        .headers()
        .get(&MCP_SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if let Some(response_session_id) = response_session_id {
        match state
            .credentials
            .bind_http_session(&response_session_id, &token)
        {
            Ok(evicted) => {
                for cancellation in evicted.legacy_sessions {
                    cancellation.cancel();
                }
                for session_id in evicted.http_sessions {
                    state.credentials.close_http_session(&session_id).await;
                }
            }
            Err(()) => {
                state
                    .credentials
                    .close_http_session(&response_session_id)
                    .await;
                return StatusCode::TOO_MANY_REQUESTS.into_response();
            }
        }
    }
    if deleting && response.status().is_success() {
        if let Some(session_id) = session_id {
            state.credentials.unbind_http_session(&session_id);
        }
    }
    response
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyMessageQuery {
    session_id: String,
}

async fn open_legacy_sse(
    State(state): State<Arc<AgentMessagingRouterState>>,
    headers: HeaderMap,
) -> Response {
    let Some(credential) = authenticated_credential_from_headers(&state.credentials, &headers)
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let session_id = format!("sse_{}", Uuid::new_v4().simple());
    let cancellation = CancellationToken::new();
    let evicted = match state.credentials.bind_legacy_session(
        &session_id,
        &credential.token,
        cancellation.clone(),
    ) {
        Ok(evicted) => evicted,
        Err(()) => return StatusCode::TOO_MANY_REQUESTS.into_response(),
    };
    for cancellation in evicted.legacy_sessions {
        cancellation.cancel();
    }
    for session_id in evicted.http_sessions {
        state.credentials.close_http_session(&session_id).await;
    }

    let (inbound, inbound_receiver) = mpsc::channel(64);
    let (outbound, outbound_receiver) = mpsc::channel(64);
    {
        let mut sessions = state
            .legacy_sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        sessions.insert(
            session_id.clone(),
            LegacySseSession {
                token: credential.token.clone(),
                inbound,
                cancellation: cancellation.clone(),
            },
        );
    }
    let handler = AgentMessagingMcpHandler::new(credential, state.clone());
    let cleanup_state = state.clone();
    let cleanup_session_id = session_id.clone();
    tokio::spawn(async move {
        let transport = (
            PollSender::new(outbound),
            ReceiverStream::new(inbound_receiver),
        );
        if let Ok(running) = handler.serve_with_ct(transport, cancellation).await {
            let _ = running.waiting().await;
        }
        remove_legacy_session(&cleanup_state, &cleanup_session_id);
    });

    let endpoint = format!("{}?sessionId={session_id}", state.message_url);
    let first = futures::stream::once(async move {
        Ok::<_, Infallible>(Event::default().event("endpoint").data(endpoint))
    });
    let messages = LegacySseStream {
        receiver: outbound_receiver,
        state: state.clone(),
        session_id,
    };
    Sse::new(first.chain(messages))
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        )
        .into_response()
}

async fn post_legacy_message(
    State(state): State<Arc<AgentMessagingRouterState>>,
    Query(query): Query<LegacyMessageQuery>,
    headers: HeaderMap,
    Json(message): Json<ClientJsonRpcMessage>,
) -> Response {
    let Some(credential) = authenticated_credential_from_headers(&state.credentials, &headers)
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let inbound = {
        let sessions = state
            .legacy_sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(session) = sessions.get(&query.session_id) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        if session.token != credential.token {
            return StatusCode::FORBIDDEN.into_response();
        }
        session.inbound.clone()
    };
    match tokio::time::timeout(MCP_REQUEST_TIMEOUT, inbound.send(message)).await {
        Ok(Ok(())) => StatusCode::ACCEPTED.into_response(),
        Ok(Err(_)) => StatusCode::GONE.into_response(),
        Err(_) => StatusCode::REQUEST_TIMEOUT.into_response(),
    }
}

fn authenticated_credential_from_headers(
    credentials: &McpCredentialStore,
    headers: &HeaderMap,
) -> Option<AuthenticatedMcpCredential> {
    credentials.authenticate(headers.get(AUTHORIZATION)?.to_str().ok()?)
}

fn remove_legacy_session(state: &AgentMessagingRouterState, session_id: &str) {
    if let Some(session) = state
        .legacy_sessions
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(session_id)
    {
        session.cancellation.cancel();
    }
    state.credentials.unbind_legacy_session(session_id);
}

struct LegacySseStream {
    receiver: mpsc::Receiver<ServerJsonRpcMessage>,
    state: Arc<AgentMessagingRouterState>,
    session_id: String,
}

impl Stream for LegacySseStream {
    type Item = Result<Event, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.receiver.poll_recv(context) {
            Poll::Ready(Some(message)) => match serde_json::to_string(&message) {
                Ok(message) => {
                    Poll::Ready(Some(Ok(Event::default().event("message").data(message))))
                }
                Err(_) => Poll::Ready(None),
            },
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for LegacySseStream {
    fn drop(&mut self) {
        remove_legacy_session(&self.state, &self.session_id);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentMessageDisposition {
    Sent,
    Steering,
    Queued,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentMessageDirection {
    Sent,
    Received,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentMessageOrigin {
    pub(crate) message_id: String,
    pub(crate) direction: AgentMessageDirection,
    pub(crate) related_thread_id: String,
    pub(crate) related_title: Option<String>,
    pub(crate) relation: AgentRelationKind,
    pub(crate) disposition: AgentMessageDisposition,
    pub(crate) body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentMessageEnvelope {
    pub(crate) version: u32,
    pub(crate) message_id: String,
    pub(crate) sender_thread_id: String,
    #[serde(default)]
    pub(crate) reply_to_thread_id: String,
    pub(crate) recipient_thread_id: String,
    pub(crate) recipient_relation: AgentRelationKind,
    pub(crate) sender_title: Option<String>,
    pub(crate) body: String,
    pub(crate) reply_tool: String,
}

impl AgentMessageEnvelope {
    pub(crate) fn may_be_partial(value: &str) -> bool {
        let value = value.trim_start_matches(|character: char| character.is_ascii_whitespace());
        !value.is_empty()
            && (ENVELOPE_PREFIX.starts_with(value) || value.starts_with(ENVELOPE_PREFIX))
    }

    pub(crate) fn has_complete_suffix(value: &str) -> bool {
        value.ends_with(ENVELOPE_SUFFIX)
    }

    pub(crate) fn new(
        message_id: String,
        sender_thread_id: String,
        recipient_thread_id: String,
        recipient_relation: AgentRelationKind,
        sender_title: Option<String>,
        body: String,
    ) -> Self {
        Self {
            version: AGENT_MESSAGE_ENVELOPE_VERSION,
            message_id,
            reply_to_thread_id: sender_thread_id.clone(),
            sender_thread_id,
            recipient_thread_id,
            recipient_relation,
            sender_title,
            body,
            reply_tool: SEND_AGENT_MESSAGE_TOOL.to_string(),
        }
    }

    pub(crate) fn encode(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
            .map(|payload| format!("{ENVELOPE_PREFIX}{payload}{ENVELOPE_SUFFIX}"))
    }

    pub(crate) fn decode(value: &str) -> Option<Self> {
        let payload = value
            .strip_prefix(ENVELOPE_PREFIX)?
            .strip_suffix(ENVELOPE_SUFFIX)?;
        let mut envelope = serde_json::from_str::<Self>(payload).ok()?;
        if envelope.reply_to_thread_id.is_empty() {
            envelope.reply_to_thread_id = envelope.sender_thread_id.clone();
        }
        (envelope.version == AGENT_MESSAGE_ENVELOPE_VERSION
            && envelope.reply_to_thread_id == envelope.sender_thread_id
            && envelope.reply_tool == SEND_AGENT_MESSAGE_TOOL)
            .then_some(envelope)
    }

    pub(crate) fn decode_echo(value: &str) -> Option<Self> {
        Self::decode(value.trim_matches(|character: char| character.is_ascii_whitespace()))
    }
}

pub(crate) fn prompt_contains_agent_message_envelope(
    prompt: &[agent_client_protocol::schema::v1::ContentBlock],
) -> bool {
    let mut combined = String::new();
    let mut contains_envelope = false;
    for block in prompt {
        if let agent_client_protocol::schema::v1::ContentBlock::Text(text) = block {
            contains_envelope |= contains_reserved_agent_message_marker(&text.text);
            combined.push_str(&text.text);
        }
    }
    contains_envelope || contains_reserved_agent_message_marker(&combined)
}

fn contains_reserved_agent_message_marker(value: &str) -> bool {
    value.contains(ENVELOPE_PREFIX.trim_end()) || value.contains(ENVELOPE_SUFFIX.trim_start())
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

    async fn initialize_http_session(
        client: &reqwest::Client,
        config: &AgentMessagingMcpConfig,
        authorization: &str,
        request_id: u64,
    ) -> reqwest::Response {
        client
            .post(config.http_url.clone())
            .header(AUTHORIZATION, authorization)
            .header("accept", "application/json, text/event-stream")
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "dappercode-agent-messaging-test",
                        "version": "1.0.0"
                    }
                }
            }))
            .send()
            .await
            .expect("HTTP MCP initialize response")
    }

    fn envelope() -> AgentMessageEnvelope {
        AgentMessageEnvelope::new(
            "message-1".to_string(),
            "parent".to_string(),
            "child".to_string(),
            AgentRelationKind::SubAgent,
            Some("Parent agent".to_string()),
            "Please check the queue race.\nKeep this exact text.".to_string(),
        )
    }

    #[test]
    fn relation_kind_inverts_between_sender_and_recipient() {
        assert_eq!(
            AgentRelationKind::Parent.inverse(),
            AgentRelationKind::SubAgent
        );
        assert_eq!(
            AgentRelationKind::SubAgent.inverse(),
            AgentRelationKind::Parent
        );
    }

    #[test]
    fn exact_agent_message_envelope_round_trips() {
        let expected = envelope();
        let encoded = expected.encode().unwrap();

        assert!(encoded.contains("\"replyToThreadId\":\"parent\""));
        assert_eq!(AgentMessageEnvelope::decode(&encoded), Some(expected));
    }

    #[test]
    fn legacy_agent_message_envelopes_gain_an_unambiguous_reply_target() {
        let expected = envelope();
        let encoded = expected.encode().unwrap();
        let legacy = encoded.replacen(",\"replyToThreadId\":\"parent\"", "", 1);

        assert_eq!(AgentMessageEnvelope::decode(&legacy), Some(expected));
        assert!(AgentMessageEnvelope::decode(&encoded.replace(
            "\"replyToThreadId\":\"parent\"",
            "\"replyToThreadId\":\"child\""
        ))
        .is_none());
    }

    #[test]
    fn echoed_agent_message_envelope_allows_only_outer_ascii_whitespace() {
        let expected = envelope();
        let encoded = expected.encode().unwrap();

        assert_eq!(
            AgentMessageEnvelope::decode_echo(&format!("\n{encoded}\r\n")),
            Some(expected)
        );
        assert!(AgentMessageEnvelope::decode_echo(&format!("{encoded}suffix")).is_none());
        assert!(AgentMessageEnvelope::may_be_partial(&format!(
            "\n{}",
            &encoded[..8]
        )));
        assert!(!AgentMessageEnvelope::may_be_partial(""));
    }

    #[test]
    fn envelope_parser_rejects_partial_forgiving_or_future_shapes() {
        let encoded = envelope().encode().unwrap();
        assert!(AgentMessageEnvelope::decode(&format!("prefix{encoded}")).is_none());
        assert!(AgentMessageEnvelope::decode(&format!("{encoded}suffix")).is_none());

        let future = encoded.replace("\"version\":1", "\"version\":2");
        assert!(AgentMessageEnvelope::decode(&future).is_none());

        let wrong_tool = encoded.replace(SEND_AGENT_MESSAGE_TOOL, "other_tool");
        assert!(AgentMessageEnvelope::decode(&wrong_tool).is_none());

        let unknown_field = encoded.replace("\"replyTool\"", "\"unexpected\":true,\"replyTool\"");
        assert!(AgentMessageEnvelope::decode(&unknown_field).is_none());
    }

    #[test]
    fn reserved_envelope_markers_are_detected_across_prefixed_text_blocks() {
        let encoded = envelope().encode().expect("agent message envelope");
        let split_at = encoded
            .find(",\"senderThreadId\"")
            .expect("encoded sender field");
        let prompt = [
            "ordinary prefix",
            &encoded[..split_at],
            &encoded[split_at..],
        ]
        .into_iter()
        .map(|text| {
            serde_json::from_value(serde_json::json!({
                "type": "text",
                "text": text,
                "text_elements": [],
            }))
            .expect("ACP text block")
        })
        .collect::<Vec<agent_client_protocol::schema::v1::ContentBlock>>();

        assert!(prompt_contains_agent_message_envelope(&prompt));
    }

    #[test]
    fn mcp_body_limit_admits_a_maximum_size_fully_escaped_message() {
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": SEND_AGENT_MESSAGE_TOOL,
                "arguments": {
                    "recipientThreadId": "agent-alpha:child",
                    "message": "\u{0000}".repeat(MAX_AGENT_MESSAGE_BODY_BYTES),
                },
            },
        });

        assert!(
            serde_json::to_vec(&request)
                .expect("MCP request serializes")
                .len()
                <= MAX_MCP_REQUEST_BYTES
        );
    }

    #[test]
    fn encoded_agent_message_must_fit_the_queue_before_admission() {
        let oversized = AgentMessageEnvelope::new(
            "message-oversized".to_string(),
            "parent".to_string(),
            "child".to_string(),
            AgentRelationKind::SubAgent,
            Some("Parent agent".to_string()),
            "\"".repeat(MAX_AGENT_MESSAGE_BODY_BYTES),
        );
        assert!(oversized.body.len() <= MAX_AGENT_MESSAGE_BODY_BYTES);
        assert!(
            oversized.encode().expect("agent-message envelope").len() > QUEUE_MAX_CONTENT_BYTES
        );
        let error = validate_agent_message_envelope_size(&oversized)
            .expect_err("encoded payload above the queue limit must be rejected");
        assert!(format!("{error:?}").contains("shorten"));
        validate_agent_message_envelope_size(&envelope())
            .expect("ordinary agent-message envelope fits");
    }

    #[test]
    fn credential_is_inactive_until_activation_and_rotation_revokes_the_old_token() {
        let store = Arc::new(McpCredentialStore::default());
        let config = AgentMessagingMcpConfig::new(
            "http://127.0.0.1:4312/mcp".to_string(),
            "http://127.0.0.1:4312/sse".to_string(),
            store.clone(),
        );

        let first = config.stage_credential("agent-a").unwrap();
        let first_header = format!("Bearer {}", first.token);
        assert_eq!(
            store.resolve_authorization(&first_header),
            Some(McpCredentialPrincipal::Pending {
                agent_id: "agent-a".to_string(),
            })
        );
        config.activate_credential(first, "thread-a").unwrap();
        assert_eq!(
            store.resolve_authorization(&first_header),
            Some(McpCredentialPrincipal::Active {
                agent_id: "agent-a".to_string(),
                thread_id: "thread-a".to_string(),
            })
        );

        let second = config.stage_credential("agent-a").unwrap();
        let second_header = format!("Bearer {}", second.token);
        config.activate_credential(second, "thread-a").unwrap();

        assert_eq!(store.resolve_authorization(&first_header), None);
        assert_eq!(
            store.resolve_authorization(&second_header),
            Some(McpCredentialPrincipal::Active {
                agent_id: "agent-a".to_string(),
                thread_id: "thread-a".to_string(),
            })
        );
        config.revoke_threads(["thread-a"]);
        assert_eq!(store.resolve_authorization(&second_header), None);
    }

    #[test]
    fn descriptor_prefers_exactly_one_remote_transport_and_keeps_token_out_of_url() {
        let store = Arc::new(McpCredentialStore::default());
        let config = AgentMessagingMcpConfig::new(
            "http://127.0.0.1:4312/mcp".to_string(),
            "http://127.0.0.1:4312/sse".to_string(),
            store,
        );
        let credential = config.stage_credential("agent-a").unwrap();

        let McpServer::Http(http) = config
            .descriptor(McpTransportPreference::Http, &credential)
            .unwrap()
        else {
            panic!("expected HTTP MCP descriptor");
        };
        assert_eq!(http.url, config.http_url);
        assert_eq!(http.headers.len(), 1);
        assert_eq!(http.headers[0].name, "Authorization");
        assert!(http.headers[0].value.starts_with("Bearer dcm_"));
        assert!(!http.url.contains("dcm_"));

        assert!(matches!(
            config
                .descriptor(McpTransportPreference::Sse, &credential)
                .unwrap(),
            McpServer::Sse(_)
        ));
        assert!(config
            .descriptor(McpTransportPreference::Unavailable, &credential)
            .is_none());
    }

    #[test]
    fn protocol_sessions_are_bound_to_one_token_and_removed_on_revocation() {
        let store = Arc::new(McpCredentialStore::default());
        let config = AgentMessagingMcpConfig::new(
            "http://127.0.0.1:4312/mcp".to_string(),
            "http://127.0.0.1:4312/sse".to_string(),
            store.clone(),
        );
        let first = config.stage_credential("agent-a").unwrap();
        let second = config.stage_credential("agent-a").unwrap();

        assert!(store.bind_http_session("mcp-session", &first.token).is_ok());
        assert_eq!(
            store.http_session_authorization("mcp-session", &first.token),
            McpHttpSessionAuthorization::Authorized
        );
        assert_eq!(
            store.http_session_authorization("mcp-session", &second.token),
            McpHttpSessionAuthorization::WrongCredential
        );
        assert!(store
            .bind_http_session("mcp-session", &second.token)
            .is_err());

        drop(first);
        assert_eq!(
            store.http_session_authorization("mcp-session", &second.token),
            McpHttpSessionAuthorization::Unknown
        );
        assert!(store
            .bind_http_session("mcp-session", &second.token)
            .is_ok());
    }

    #[test]
    fn global_http_session_quota_evicts_the_oldest_reconnectable_worker() {
        let store = Arc::new(McpCredentialStore::default());
        let mut credentials = Vec::new();
        for index in 0..MAX_MCP_PROTOCOL_SESSIONS {
            let credential = McpCredentialStore::stage(&store, "agent-a").unwrap();
            assert!(store
                .bind_http_session(&format!("session-{index}"), &credential.token)
                .expect("session binds without eviction")
                .is_empty());
            credentials.push(credential);
        }
        let replacement = McpCredentialStore::stage(&store, "agent-a").unwrap();
        let evicted = store
            .bind_http_session("replacement", &replacement.token)
            .expect("replacement evicts stale HTTP state");
        assert_eq!(evicted.http_sessions, vec!["session-0".to_string()]);
        assert!(evicted.legacy_sessions.is_empty());
        assert_eq!(
            store.http_session_authorization("session-0", &credentials[0].token),
            McpHttpSessionAuthorization::Unknown
        );
        assert_eq!(
            store.http_session_authorization("replacement", &replacement.token),
            McpHttpSessionAuthorization::Authorized
        );
        assert_eq!(
            store
                .state
                .lock()
                .expect("credential state lock")
                .http_sessions
                .len(),
            MAX_MCP_PROTOCOL_SESSIONS
        );
    }

    #[test]
    fn legacy_session_admission_evicts_the_oldest_http_binding_at_global_capacity() {
        let store = Arc::new(McpCredentialStore::default());
        let mut credentials = Vec::new();
        for index in 0..MAX_MCP_PROTOCOL_SESSIONS {
            let credential = McpCredentialStore::stage(&store, "agent-a").unwrap();
            assert!(store
                .bind_http_session(&format!("session-{index}"), &credential.token)
                .expect("HTTP session binds without eviction")
                .is_empty());
            credentials.push(credential);
        }
        let legacy = McpCredentialStore::stage(&store, "agent-a").unwrap();
        let evicted = store
            .bind_legacy_session(
                "legacy-replacement",
                &legacy.token,
                CancellationToken::new(),
            )
            .expect("legacy session evicts stale HTTP state");

        assert_eq!(evicted.http_sessions, vec!["session-0".to_string()]);
        assert!(evicted.legacy_sessions.is_empty());
        assert_eq!(
            store.http_session_authorization("session-0", &credentials[0].token),
            McpHttpSessionAuthorization::Unknown
        );
        assert!(store
            .state
            .lock()
            .expect("credential state lock")
            .legacy_sessions
            .contains_key("legacy-replacement"));
    }

    #[tokio::test]
    async fn one_loopback_listener_serves_http_and_sse_with_shared_authentication() {
        let service = AgentMessagingService::start(
            Weak::<RuntimeBackend>::new(),
            Weak::<BridgeQueueService>::new(),
        )
        .await
        .expect("shared MCP listener starts");
        let config = service.config();
        let http_url = reqwest::Url::parse(&config.http_url).unwrap();
        let sse_url = reqwest::Url::parse(&config.sse_url).unwrap();
        assert_eq!(http_url.host_str(), Some("127.0.0.1"));
        assert_eq!(http_url.port(), sse_url.port());

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(
            client
                .post(config.http_url.clone())
                .json(&serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(config.sse_url.clone())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );

        let pending = config.stage_credential("agent-a").unwrap();
        let authorization = match config
            .descriptor(McpTransportPreference::Sse, &pending)
            .expect("SSE descriptor")
        {
            McpServer::Sse(descriptor) => descriptor.headers[0].value.clone(),
            _ => panic!("unexpected MCP descriptor"),
        };
        let response = client
            .get(config.sse_url.clone())
            .header(AUTHORIZATION, authorization)
            .send()
            .await
            .expect("authenticated legacy SSE opens");
        assert_eq!(response.status(), StatusCode::OK);
        drop(response);
        drop(pending);
        service.shutdown().await;
    }

    #[tokio::test]
    async fn http_session_reconnect_evicts_the_oldest_worker_and_failed_delete_stays_bound() {
        let service = AgentMessagingService::start(
            Weak::<RuntimeBackend>::new(),
            Weak::<BridgeQueueService>::new(),
        )
        .await
        .expect("shared MCP listener starts");
        let config = service.config();
        let pending = config.stage_credential("agent-a").unwrap();
        let authorization = match config
            .descriptor(McpTransportPreference::Http, &pending)
            .expect("HTTP descriptor")
        {
            McpServer::Http(descriptor) => descriptor.headers[0].value.clone(),
            _ => panic!("unexpected MCP descriptor"),
        };
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut session_ids = Vec::new();

        for request_id in 0..MAX_MCP_SESSIONS_PER_CREDENTIAL as u64 {
            let response =
                initialize_http_session(&client, &config, &authorization, request_id).await;
            assert_eq!(response.status(), StatusCode::OK);
            session_ids.push(
                response
                    .headers()
                    .get(MCP_SESSION_HEADER.as_str())
                    .and_then(|value| value.to_str().ok())
                    .expect("initialized MCP session id")
                    .to_string(),
            );
        }
        let manager = config
            .credentials
            .http_session_manager
            .get()
            .expect("HTTP session manager");
        assert_eq!(
            manager.sessions.read().await.len(),
            MAX_MCP_SESSIONS_PER_CREDENTIAL
        );

        let replacement = initialize_http_session(&client, &config, &authorization, 99).await;
        assert_eq!(replacement.status(), StatusCode::OK);
        assert_eq!(
            manager.sessions.read().await.len(),
            MAX_MCP_SESSIONS_PER_CREDENTIAL
        );
        assert_eq!(
            config
                .credentials
                .http_session_authorization(&session_ids[0], &pending.token),
            McpHttpSessionAuthorization::Unknown
        );
        let evicted_request = client
            .post(config.http_url.clone())
            .header(AUTHORIZATION, &authorization)
            .header(MCP_SESSION_HEADER.as_str(), &session_ids[0])
            .header("mcp-protocol-version", "2025-03-26")
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1000,
                "method": "tools/list",
            }))
            .send()
            .await
            .expect("evicted HTTP MCP session response");
        assert_eq!(evicted_request.status(), StatusCode::NOT_FOUND);

        let first_session = &session_ids[1];
        let failed_delete = client
            .delete(config.http_url.clone())
            .header(AUTHORIZATION, &authorization)
            .header(MCP_SESSION_HEADER.as_str(), first_session)
            .header("mcp-protocol-version", "not-a-version")
            .send()
            .await
            .expect("malformed HTTP MCP delete response");
        assert!(!failed_delete.status().is_success());
        assert_eq!(
            config
                .credentials
                .http_session_authorization(first_session, &pending.token),
            McpHttpSessionAuthorization::Authorized
        );

        let deleted = client
            .delete(config.http_url.clone())
            .header(AUTHORIZATION, &authorization)
            .header(MCP_SESSION_HEADER.as_str(), first_session)
            .header("mcp-protocol-version", "2025-03-26")
            .send()
            .await
            .expect("valid HTTP MCP delete response");
        assert!(deleted.status().is_success());
        assert_eq!(
            config
                .credentials
                .http_session_authorization(first_session, &pending.token),
            McpHttpSessionAuthorization::Unknown
        );
        assert_eq!(
            manager.sessions.read().await.len(),
            MAX_MCP_SESSIONS_PER_CREDENTIAL - 1
        );

        let next_replacement = initialize_http_session(&client, &config, &authorization, 100).await;
        assert_eq!(next_replacement.status(), StatusCode::OK);
        assert_eq!(
            manager.sessions.read().await.len(),
            MAX_MCP_SESSIONS_PER_CREDENTIAL
        );

        drop(pending);
        service.shutdown().await;
    }

    #[tokio::test]
    async fn revocation_closes_legacy_sse_before_mcp_initialization() {
        let service = AgentMessagingService::start(
            Weak::<RuntimeBackend>::new(),
            Weak::<BridgeQueueService>::new(),
        )
        .await
        .expect("shared MCP listener starts");
        let config = service.config();
        let pending = config.stage_credential("agent-a").unwrap();
        let authorization = match config
            .descriptor(McpTransportPreference::Sse, &pending)
            .expect("SSE descriptor")
        {
            McpServer::Sse(descriptor) => descriptor.headers[0].value.clone(),
            _ => panic!("unexpected MCP descriptor"),
        };
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client
            .get(config.sse_url.clone())
            .header(AUTHORIZATION, authorization)
            .send()
            .await
            .expect("authenticated legacy SSE opens");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            config
                .credentials
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .legacy_sessions
                .len(),
            1
        );

        drop(pending);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if config
                    .credentials
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .legacy_sessions
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("revocation closes the uninitialized SSE session");

        drop(response);
        service.shutdown().await;
    }
}
