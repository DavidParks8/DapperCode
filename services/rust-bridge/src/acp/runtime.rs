#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::v1::schema::{
    CancelNotification, ClientCapabilities, CloseSessionRequest, CloseSessionResponse,
    ContentBlock, CreateElicitationRequest, DeleteSessionRequest, DeleteSessionResponse,
    ElicitationCapabilities, ElicitationContentValue, ElicitationFormCapabilities,
    InitializeRequest, InitializeResponse, ListSessionsRequest, ListSessionsResponse,
    LoadSessionRequest, LoadSessionResponse, NewSessionRequest, NewSessionResponse, PromptRequest,
    RequestPermissionRequest, ResumeSessionRequest, ResumeSessionResponse, SessionId,
    SessionNotification, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse,
};
use agent_client_protocol::{Client, ConnectTo, JsonRpcRequest, JsonRpcResponse};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, watch};

use super::config::{ResolvedAgentManifest, RuntimeManifestError};
use super::drain_transport::DrainTransport;
use super::events::CanonicalEvent;
use super::interactions::{
    ApprovalPolicy, InteractionError, InteractionRegistry, PendingElicitationSummary,
    PendingPermissionSummary,
};
use super::session::{AcpSession, ReconstructionError, SessionRegistry, SessionRouteError};

const COMMAND_BUFFER: usize = 64;
const TRANSPORT_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);
pub const STEER_METHOD: &str = "_dappercode.dev/session/steer";
pub const FORK_METHOD: &str = "_dappercode.dev/session/fork";
const DAPPERCODE_EXTENSION_VERSION: u64 = 1;
const MAX_EXTENSION_METADATA_BYTES: usize = 4 * 1024;

#[derive(Deserialize)]
struct DapperCodeExtensionMetadata {
    #[serde(rename = "dappercode.dev")]
    dappercode_dev: DapperCodeExtension,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DapperCodeExtension {
    version: u64,
    capabilities: DapperCodeCapabilities,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct DapperCodeCapabilities {
    #[serde(default, rename = "sessionSteer")]
    session_steer: Option<serde_json::Value>,
    #[serde(default, rename = "sessionFork")]
    session_fork: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtensionCapability {
    method: String,
    version: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NativeAcpCapabilities {
    pub session_list: bool,
    pub session_load: bool,
    pub session_resume: bool,
    pub session_delete: bool,
    pub session_close: bool,
    pub session_steer: bool,
    pub session_fork: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonRpcRequest)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[request(method = "_dappercode.dev/session/steer", response = SteerResponse)]
pub struct SteerRequest {
    pub session_id: SessionId,
    pub expected_run_id: String,
    pub expected_source_turn_id: String,
    pub prompt_generation: u64,
    pub prompt: Vec<ContentBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SteerResponse {
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonRpcRequest)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[request(method = "_dappercode.dev/session/fork", response = ForkResponse)]
pub struct ForkRequest {
    pub session_id: SessionId,
    pub message_id: Option<String>,
    pub user_message_ordinal: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForkResponse {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AcpRuntimeError {
    #[error(transparent)]
    Manifest(#[from] RuntimeManifestError),
    #[error("ACP initialization timed out")]
    InitializeTimeout,
    #[error("ACP connection closed: {0}")]
    Connection(String),
    #[error("ACP connection is already unavailable: {0}")]
    ConnectionUnavailable(String),
    #[error("ACP connection task ended unexpectedly")]
    ConnectionTaskEnded,
    #[error("ACP command queue is closed")]
    CommandQueueClosed,
    #[error("ACP command response was dropped")]
    CommandResponseDropped,
    #[error("ACP request timed out")]
    RequestTimeout,
    #[error("ACP client request cancelled")]
    RequestCancelled,
    #[error("ACP operation is unsupported: {0}")]
    Unsupported(&'static str),
    #[error("unknown ACP session: {0}")]
    UnknownSession(String),
    #[error("ACP session already has an active prompt")]
    SessionBusy,
    #[error(transparent)]
    SessionRoute(#[from] SessionRouteError),
    #[error(transparent)]
    Interaction(#[from] InteractionError),
}

pub type RequestCancellation = tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub struct NegotiatedInitialize {
    pub response: InitializeResponse,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum McpTransportPreference {
    Http,
    Sse,
    #[default]
    Unavailable,
}

impl NegotiatedInitialize {
    pub fn native_capabilities(&self) -> NativeAcpCapabilities {
        NativeAcpCapabilities {
            session_list: self.supports_session_list(),
            session_load: self.supports_session_load(),
            session_resume: self.supports_session_resume(),
            session_delete: self.supports_session_delete(),
            session_close: self.supports_session_close(),
            session_steer: self.supports_session_steer(),
            session_fork: self.supports_session_fork(),
        }
    }

    pub fn supports_session_list(&self) -> bool {
        self.response
            .agent_capabilities
            .session_capabilities
            .list
            .is_some()
    }

    pub fn supports_session_load(&self) -> bool {
        self.response.agent_capabilities.load_session
    }

    pub fn supports_session_resume(&self) -> bool {
        self.response
            .agent_capabilities
            .session_capabilities
            .resume
            .is_some()
    }

    pub fn supports_session_delete(&self) -> bool {
        self.response
            .agent_capabilities
            .session_capabilities
            .delete
            .is_some()
    }

    pub fn supports_session_close(&self) -> bool {
        self.response
            .agent_capabilities
            .session_capabilities
            .close
            .is_some()
    }

    pub fn supports_session_steer(&self) -> bool {
        self.extension_capability("sessionSteer", STEER_METHOD)
    }

    pub fn supports_session_fork(&self) -> bool {
        self.extension_capability("sessionFork", FORK_METHOD)
    }

    pub(crate) fn mcp_transport_preference(&self) -> McpTransportPreference {
        let capabilities = &self.response.agent_capabilities.mcp_capabilities;
        if capabilities.http {
            McpTransportPreference::Http
        } else if capabilities.sse {
            McpTransportPreference::Sse
        } else {
            McpTransportPreference::Unavailable
        }
    }

    fn extension_capability(&self, capability: &str, method: &str) -> bool {
        let Some(meta) = self.response.meta.as_ref() else {
            return false;
        };
        if serde_json::to_vec(meta).map_or(true, |bytes| bytes.len() > MAX_EXTENSION_METADATA_BYTES)
        {
            return false;
        }
        let Ok(metadata) = serde_json::to_value(meta)
            .and_then(serde_json::from_value::<DapperCodeExtensionMetadata>)
        else {
            return false;
        };
        if metadata.dappercode_dev.version != DAPPERCODE_EXTENSION_VERSION {
            return false;
        }
        let descriptor = match capability {
            "sessionSteer" => metadata.dappercode_dev.capabilities.session_steer,
            "sessionFork" => metadata.dappercode_dev.capabilities.session_fork,
            _ => None,
        };
        descriptor
            .map(serde_json::from_value::<ExtensionCapability>)
            .and_then(Result::ok)
            .is_some_and(|descriptor| {
                descriptor.method == method && descriptor.version == DAPPERCODE_EXTENSION_VERSION
            })
    }
}

#[derive(Clone)]
pub struct AcpConnection {
    #[cfg(test)]
    agent_id: Arc<str>,
    commands: mpsc::Sender<Command>,
    negotiated: Arc<NegotiatedInitialize>,
    shutdown: watch::Sender<bool>,
    finished: watch::Receiver<Option<Result<(), String>>>,
    failure: watch::Receiver<Option<String>>,
    sessions: SessionRegistry,
    interactions: InteractionRegistry,
    requested_shutdown: Arc<AtomicBool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptAdmission {
    pub run_id: String,
    pub source_turn_id: String,
    pub generation: u64,
}

async fn finish_cancel_attempt(
    session: Option<AcpSession>,
    generation: Option<u64>,
    result: &Result<(), AcpRuntimeError>,
) {
    let (Err(error), Some(session), Some(generation)) = (result, session, generation) else {
        return;
    };
    let Some((run_id, source_turn_id, active_generation)) = session.operation().await else {
        return;
    };
    if active_generation == generation {
        session
            .fail_generation(run_id, source_turn_id, generation, error.to_string())
            .await;
    }
}

async fn finish_connection_actor(
    result: Result<(), String>,
    ready_tx: &mpsc::Sender<Result<NegotiatedInitialize, AcpRuntimeError>>,
    requested_shutdown: &AtomicBool,
    failure_tx: &watch::Sender<Option<String>>,
    sessions: &SessionRegistry,
) {
    if let Err(message) = result {
        let _ = ready_tx
            .send(Err(AcpRuntimeError::Connection(message.clone())))
            .await;
        if !requested_shutdown.load(Ordering::SeqCst) {
            let _ = failure_tx.send(Some(message.clone()));
            for session in sessions.all().await {
                session.fail_active(message.clone()).await;
            }
        }
    }
}

impl AcpConnection {
    pub async fn start(
        manifest: &ResolvedAgentManifest,
        approved_roots: &[PathBuf],
        host_environment: &BTreeMap<String, String>,
        initialize_timeout: Duration,
        extra_argv: &[String],
        extra_environment: &BTreeMap<String, String>,
    ) -> Result<(Self, NegotiatedInitialize), AcpRuntimeError> {
        Self::start_transport(
            manifest.agent_id.clone(),
            manifest.acp_agent_with_args(
                approved_roots,
                host_environment,
                extra_argv,
                extra_environment,
            )?,
            initialize_timeout,
        )
        .await
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(super) async fn start_transport<Transport>(
        agent_id: String,
        transport: Transport,
        initialize_timeout: Duration,
    ) -> Result<(Self, NegotiatedInitialize), AcpRuntimeError>
    where
        Transport: ConnectTo<Client> + Send + 'static,
    {
        #[cfg(test)]
        let connection_agent_id: Arc<str> = Arc::from(agent_id.clone());
        let (ready_tx, mut ready_rx) = mpsc::channel(1);
        let (commands, mut command_rx) = mpsc::channel::<Command>(COMMAND_BUFFER);
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let (finished_tx, finished) = watch::channel(None);
        let (failure_tx, failure) = watch::channel(None);
        let sessions = SessionRegistry::default();
        let interactions = InteractionRegistry::new(sessions.clone());
        let actor_sessions = sessions.clone();
        let actor_interactions = interactions.clone();
        let requested_shutdown = Arc::new(AtomicBool::new(false));
        let actor_requested_shutdown = requested_shutdown.clone();
        tokio::spawn(async move {
            let ready_for_initialize = ready_tx.clone();
            let notification_sessions = actor_sessions.clone();
            let notification_agent_id = agent_id.clone();
            let connection_sessions = actor_sessions.clone();
            let command_interactions = actor_interactions.clone();
            let permission_interactions = actor_interactions.clone();
            let elicitation_interactions = actor_interactions.clone();
            let result = Client
                .v1()
                .on_receive_notification(
                    async move |notification: SessionNotification, _| {
                        notification_sessions
                            .route(&notification_agent_id, notification)
                            .await
                            .map_err(|error| {
                                agent_client_protocol::Error::internal_error().data(error.to_string())
                            })?;
                        Ok(())
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .on_receive_request(
                    async move |request: RequestPermissionRequest, responder, _| {
                        permission_interactions
                            .register_permission(request, responder)
                            .await
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    async move |request: CreateElicitationRequest, responder, _| {
                        elicitation_interactions
                            .register_elicitation(request, responder)
                            .await
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .connect_with(DrainTransport { transport, timeout: TRANSPORT_DRAIN_TIMEOUT }, async move |connection| {
                let capabilities = ClientCapabilities::new().elicitation(
                    ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()),
                );
                let response = tokio::time::timeout(
                    initialize_timeout,
                    connection.send_request(InitializeRequest::new(ProtocolVersion::V1).client_capabilities(capabilities)).block_task(),
                )
                .await
                .map_err(|_| agent_client_protocol::Error::internal_error().data("ACP initialization timed out"))??;
                let negotiated = NegotiatedInitialize { response };
                let _ = ready_for_initialize.send(Ok(negotiated.clone())).await;
                loop {
                    tokio::select! {
                        changed = shutdown_rx.changed() => {
                            changed.map_err(|_| agent_client_protocol::Error::internal_error().data("ACP shutdown channel closed"))?;
                            break;
                        }
                        command = command_rx.recv() => match command {
                            Some(command) => command.dispatch(&connection, initialize_timeout, &agent_id, &connection_sessions, &command_interactions).await,
                            None => break,
                        },
                    }
                }
                Ok(())
            }).await;
            let result = result.map_err(|error| error.to_string());
            actor_interactions.drain().await;
            finish_connection_actor(
                result.clone(),
                &ready_tx,
                &actor_requested_shutdown,
                &failure_tx,
                &actor_sessions,
            )
            .await;
            let _ = finished_tx.send(Some(result));
        });
        match tokio::time::timeout(initialize_timeout, ready_rx.recv()).await {
            Ok(Some(Ok(negotiated))) => Ok((
                Self {
                    #[cfg(test)]
                    agent_id: connection_agent_id,
                    commands,
                    negotiated: Arc::new(negotiated.clone()),
                    shutdown,
                    finished,
                    failure,
                    sessions,
                    interactions,
                    requested_shutdown,
                },
                negotiated,
            )),
            Ok(Some(Err(error))) => Err(error),
            Ok(None) => Err(AcpRuntimeError::ConnectionTaskEnded),
            Err(_) => Err(AcpRuntimeError::InitializeTimeout),
        }
    }

    pub fn negotiated(&self) -> &NegotiatedInitialize {
        &self.negotiated
    }

    pub fn failure_message(&self) -> Option<String> {
        self.failure.borrow().clone()
    }

    #[cfg(test)]
    pub async fn new_session(
        &self,
        request: NewSessionRequest,
    ) -> Result<NewSessionResponse, AcpRuntimeError> {
        self.new_session_with_cancellation(request, RequestCancellation::default())
            .await
    }

    pub async fn new_session_with_cancellation(
        &self,
        request: NewSessionRequest,
        cancellation: RequestCancellation,
    ) -> Result<NewSessionResponse, AcpRuntimeError> {
        let reservation = self.sessions.reserve().await?;
        let result = self
            .call(|response| Command::NewSession {
                request,
                cancellation,
                reservation,
                response,
            })
            .await;
        self.sessions.release_reservation(reservation).await;
        result
    }

    pub async fn list_sessions(
        &self,
        request: ListSessionsRequest,
    ) -> Result<ListSessionsResponse, AcpRuntimeError> {
        if !self.negotiated.supports_session_list() {
            return Err(AcpRuntimeError::Unsupported("session/list"));
        }
        self.call(|response| Command::ListSessions { request, response })
            .await
    }

    #[cfg(test)]
    pub async fn load_session(
        &self,
        request: LoadSessionRequest,
    ) -> Result<LoadSessionResponse, AcpRuntimeError> {
        self.load_session_with_policy(request, ApprovalPolicy::Untrusted)
            .await
    }

    pub async fn load_session_with_policy(
        &self,
        request: LoadSessionRequest,
        approval_policy: ApprovalPolicy,
    ) -> Result<LoadSessionResponse, AcpRuntimeError> {
        let policy_session_ids = vec![request.session_id.clone()];
        self.load_session_with_policy_for_sessions(request, approval_policy, policy_session_ids)
            .await
    }

    pub async fn load_session_with_policy_for_sessions(
        &self,
        request: LoadSessionRequest,
        approval_policy: ApprovalPolicy,
        policy_session_ids: Vec<SessionId>,
    ) -> Result<LoadSessionResponse, AcpRuntimeError> {
        if !self.negotiated.supports_session_load() {
            return Err(AcpRuntimeError::Unsupported("session/load"));
        }
        self.call(|response| Command::LoadSession {
            request,
            approval_policy,
            policy_session_ids,
            response,
        })
        .await
    }

    #[cfg(test)]
    pub async fn resume_session(
        &self,
        request: ResumeSessionRequest,
    ) -> Result<ResumeSessionResponse, AcpRuntimeError> {
        self.resume_session_with_policy(request, ApprovalPolicy::Untrusted)
            .await
    }

    pub async fn resume_session_with_policy(
        &self,
        request: ResumeSessionRequest,
        approval_policy: ApprovalPolicy,
    ) -> Result<ResumeSessionResponse, AcpRuntimeError> {
        let policy_session_ids = vec![request.session_id.clone()];
        self.resume_session_with_policy_for_sessions(request, approval_policy, policy_session_ids)
            .await
    }

    pub async fn resume_session_with_policy_for_sessions(
        &self,
        request: ResumeSessionRequest,
        approval_policy: ApprovalPolicy,
        policy_session_ids: Vec<SessionId>,
    ) -> Result<ResumeSessionResponse, AcpRuntimeError> {
        if !self.negotiated.supports_session_resume() {
            return Err(AcpRuntimeError::Unsupported("session/resume"));
        }
        self.call(|response| Command::ResumeSession {
            request,
            approval_policy,
            policy_session_ids,
            response,
        })
        .await
    }

    pub async fn delete_session(
        &self,
        request: DeleteSessionRequest,
    ) -> Result<DeleteSessionResponse, AcpRuntimeError> {
        if !self.negotiated.supports_session_delete() {
            return Err(AcpRuntimeError::Unsupported("session/delete"));
        }
        self.call(|response| Command::DeleteSession { request, response })
            .await
    }

    pub async fn close_session(
        &self,
        request: CloseSessionRequest,
    ) -> Result<CloseSessionResponse, AcpRuntimeError> {
        if !self.negotiated.supports_session_close() {
            return Err(AcpRuntimeError::Unsupported("session/close"));
        }
        self.call(|response| Command::CloseSession { request, response })
            .await
    }

    #[cfg(test)]
    pub async fn prompt(
        &self,
        request: PromptRequest,
        run_id: String,
        source_turn_id: String,
    ) -> Result<PromptAdmission, AcpRuntimeError> {
        self.prompt_with_policy(request, run_id, source_turn_id, ApprovalPolicy::Untrusted)
            .await
    }

    #[cfg(test)]
    pub async fn prompt_with_policy(
        &self,
        request: PromptRequest,
        run_id: String,
        source_turn_id: String,
        approval_policy: ApprovalPolicy,
    ) -> Result<PromptAdmission, AcpRuntimeError> {
        let policy_session_ids = vec![request.session_id.clone()];
        self.prompt_with_policy_for_sessions(
            request,
            run_id,
            source_turn_id,
            approval_policy,
            policy_session_ids,
        )
        .await
    }

    pub async fn prompt_with_policy_for_sessions(
        &self,
        request: PromptRequest,
        run_id: String,
        source_turn_id: String,
        approval_policy: ApprovalPolicy,
        policy_session_ids: Vec<SessionId>,
    ) -> Result<PromptAdmission, AcpRuntimeError> {
        if self.sessions.get(&request.session_id).await.is_none() {
            return Err(AcpRuntimeError::UnknownSession(
                request.session_id.to_string(),
            ));
        }
        self.call(|response| Command::Prompt {
            request,
            run_id,
            source_turn_id,
            approval_policy,
            policy_session_ids,
            response,
        })
        .await
    }

    pub async fn set_session_config_option(
        &self,
        request: SetSessionConfigOptionRequest,
    ) -> Result<SetSessionConfigOptionResponse, AcpRuntimeError> {
        if self.sessions.get(&request.session_id).await.is_none() {
            return Err(AcpRuntimeError::UnknownSession(
                request.session_id.to_string(),
            ));
        }
        self.call(|response| Command::SetSessionConfigOption { request, response })
            .await
    }

    pub async fn cancel(
        &self,
        session_id: agent_client_protocol::v1::schema::SessionId,
    ) -> Result<(), AcpRuntimeError> {
        if self.sessions.get(&session_id).await.is_none() {
            return Err(AcpRuntimeError::UnknownSession(session_id.to_string()));
        }
        let (generation, interaction_errors) = self.interactions.cancel_session(&session_id).await;
        for error in interaction_errors {
            eprintln!("ACP interaction cancellation response failed: {error}");
        }
        let session = self.sessions.get(&session_id).await;
        let result = self
            .call(|response| Command::Cancel {
                session_id: session_id.clone(),
                response,
            })
            .await;
        finish_cancel_attempt(session, generation, &result).await;
        result
    }

    pub async fn cancel_turn(
        &self,
        session_id: agent_client_protocol::v1::schema::SessionId,
        expected_source_turn_id: &str,
    ) -> Result<(), AcpRuntimeError> {
        let session = self
            .sessions
            .get(&session_id)
            .await
            .ok_or_else(|| AcpRuntimeError::UnknownSession(session_id.to_string()))?;
        if session.snapshot().await.active_source_turn_id.as_deref()
            != Some(expected_source_turn_id)
        {
            return Err(AcpRuntimeError::Unsupported(
                "stale turn interrupt correlation",
            ));
        }
        self.cancel(session_id).await
    }

    pub async fn pending_permissions(&self) -> Vec<PendingPermissionSummary> {
        self.interactions.pending_permissions().await
    }

    pub async fn set_approval_policy(
        &self,
        session_id: &SessionId,
        policy: ApprovalPolicy,
    ) -> Result<(), AcpRuntimeError> {
        self.set_approval_policies(std::slice::from_ref(session_id), policy)
            .await
    }

    pub async fn set_approval_policies(
        &self,
        session_ids: &[SessionId],
        policy: ApprovalPolicy,
    ) -> Result<(), AcpRuntimeError> {
        self.interactions
            .set_approval_policies(session_ids, policy)
            .await?;
        Ok(())
    }

    #[cfg(test)]
    pub async fn approval_policy(&self, session_id: &SessionId) -> ApprovalPolicy {
        self.interactions.approval_policy(session_id).await
    }

    pub async fn resolve_permission(
        &self,
        thread_id: &str,
        request_id: &str,
        option_id: &str,
    ) -> Result<(), AcpRuntimeError> {
        self.interactions
            .resolve_permission(thread_id, request_id, option_id)
            .await?;
        Ok(())
    }

    pub async fn cancel_permission(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), AcpRuntimeError> {
        self.interactions
            .cancel_permission(thread_id, request_id)
            .await?;
        Ok(())
    }

    pub async fn pending_elicitations(&self) -> Vec<PendingElicitationSummary> {
        self.interactions.pending_elicitations().await
    }

    pub async fn accept_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
        values: BTreeMap<String, ElicitationContentValue>,
    ) -> Result<(), AcpRuntimeError> {
        self.interactions
            .accept_elicitation(thread_id, request_id, values)
            .await?;
        Ok(())
    }

    pub async fn decline_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), AcpRuntimeError> {
        self.interactions
            .decline_elicitation(thread_id, request_id)
            .await?;
        Ok(())
    }

    pub async fn cancel_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), AcpRuntimeError> {
        self.interactions
            .cancel_elicitation(thread_id, request_id)
            .await?;
        Ok(())
    }

    pub async fn prepare_steer(
        &self,
        session_id: &agent_client_protocol::v1::schema::SessionId,
    ) -> Result<u64, AcpRuntimeError> {
        if self.sessions.get(session_id).await.is_none() {
            return Err(AcpRuntimeError::UnknownSession(session_id.to_string()));
        }
        Ok(self.interactions.prepare_steer(session_id).await?)
    }

    pub async fn current_steer_epoch(
        &self,
        session_id: &agent_client_protocol::v1::schema::SessionId,
    ) -> Result<u64, AcpRuntimeError> {
        if self.sessions.get(session_id).await.is_none() {
            return Err(AcpRuntimeError::UnknownSession(session_id.to_string()));
        }
        Ok(self.interactions.current_steer_epoch(session_id).await)
    }

    pub async fn verify_steer_epoch(
        &self,
        session_id: &agent_client_protocol::v1::schema::SessionId,
        epoch: u64,
    ) -> Result<bool, AcpRuntimeError> {
        if self.sessions.get(session_id).await.is_none() {
            return Err(AcpRuntimeError::UnknownSession(session_id.to_string()));
        }
        Ok(self
            .interactions
            .verify_steer_epoch(session_id, epoch)
            .await)
    }

    pub async fn steer(
        &self,
        request: SteerRequest,
        interaction_epoch: u64,
    ) -> Result<(), AcpRuntimeError> {
        if !self.negotiated.supports_session_steer() {
            return Err(AcpRuntimeError::Unsupported(STEER_METHOD));
        }
        let session = self
            .sessions
            .get(&request.session_id)
            .await
            .ok_or_else(|| AcpRuntimeError::UnknownSession(request.session_id.to_string()))?;
        let snapshot = session.snapshot().await;
        if snapshot.active_run_id.as_deref() != Some(request.expected_run_id.as_str())
            || snapshot.active_source_turn_id.as_deref()
                != Some(request.expected_source_turn_id.as_str())
            || snapshot.active_generation != Some(request.prompt_generation)
        {
            return Err(AcpRuntimeError::Unsupported("stale steer correlation"));
        }
        let response = self
            .call(|response| Command::Steer {
                request,
                interaction_epoch,
                response,
            })
            .await?;
        if !response.accepted {
            return Err(AcpRuntimeError::Unsupported("steer was not accepted"));
        }
        Ok(())
    }

    pub async fn fork_session_extension(
        &self,
        request: ForkRequest,
    ) -> Result<ForkResponse, AcpRuntimeError> {
        if !self.negotiated.supports_session_fork() {
            return Err(AcpRuntimeError::Unsupported(FORK_METHOD));
        }
        if self.sessions.get(&request.session_id).await.is_none() {
            return Err(AcpRuntimeError::UnknownSession(
                request.session_id.to_string(),
            ));
        }
        self.call(|response| Command::Fork { request, response })
            .await
    }

    pub async fn session(
        &self,
        session_id: &agent_client_protocol::v1::schema::SessionId,
    ) -> Option<AcpSession> {
        self.sessions.get(session_id).await
    }

    pub(crate) async fn evict_session(
        &self,
        session_id: &agent_client_protocol::v1::schema::SessionId,
    ) {
        self.sessions.remove(session_id).await;
    }

    #[cfg(test)]
    pub async fn ensure_session(
        &self,
        session_id: agent_client_protocol::v1::schema::SessionId,
    ) -> Result<AcpSession, AcpRuntimeError> {
        self.sessions
            .register(&self.agent_id, session_id)
            .await
            .map_err(Into::into)
    }

    pub async fn loaded_sessions(&self) -> Vec<AcpSession> {
        let mut loaded = Vec::new();
        for session in self.sessions.all().await {
            if !session.snapshot().await.history_reconstruction {
                loaded.push(session);
            }
        }
        loaded
    }

    pub(super) async fn runtime_activity(&self) -> (usize, usize) {
        let mut activity = (0, 0);
        for session in self.sessions.all().await {
            let (active_runs, other_live_work) = session.runtime_activity().await;
            activity.0 += active_runs;
            activity.1 += other_live_work;
        }
        activity
    }

    async fn call<Response>(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<Response, AcpRuntimeError>>) -> Command,
    ) -> Result<Response, AcpRuntimeError> {
        let failure = self.failure.borrow().clone();
        if let Some(message) = failure {
            return Err(AcpRuntimeError::ConnectionUnavailable(message));
        }
        let (response_tx, mut response_rx) = oneshot::channel();
        self.commands
            .send(make(response_tx))
            .await
            .map_err(|_| AcpRuntimeError::CommandQueueClosed)?;
        let mut failure = self.failure.clone();
        tokio::select! {
            response = &mut response_rx => response.map_err(|_| AcpRuntimeError::CommandResponseDropped)?,
            changed = failure.changed() => {
                changed.map_err(|_| AcpRuntimeError::ConnectionTaskEnded)?;
                Err(AcpRuntimeError::Connection(failure.borrow().clone().unwrap_or_else(|| "connection closed".to_string())))
            }
        }
    }

    pub async fn shutdown(&self) -> Result<(), AcpRuntimeError> {
        self.requested_shutdown.store(true, Ordering::SeqCst);
        self.interactions.drain().await;
        for session in self.sessions.all().await {
            session
                .fail_active("ACP connection shut down".to_string())
                .await;
        }
        let mut finished = self.finished.clone();
        let _ = self.shutdown.send(true);
        loop {
            let result = finished.borrow_and_update().clone();
            if let Some(result) = result {
                return result.map_err(AcpRuntimeError::Connection);
            }
            finished
                .changed()
                .await
                .map_err(|_| AcpRuntimeError::ConnectionTaskEnded)?;
        }
    }
}

enum Command {
    NewSession {
        request: NewSessionRequest,
        cancellation: RequestCancellation,
        reservation: u64,
        response: oneshot::Sender<Result<NewSessionResponse, AcpRuntimeError>>,
    },
    ListSessions {
        request: ListSessionsRequest,
        response: oneshot::Sender<Result<ListSessionsResponse, AcpRuntimeError>>,
    },
    LoadSession {
        request: LoadSessionRequest,
        approval_policy: ApprovalPolicy,
        policy_session_ids: Vec<SessionId>,
        response: oneshot::Sender<Result<LoadSessionResponse, AcpRuntimeError>>,
    },
    ResumeSession {
        request: ResumeSessionRequest,
        approval_policy: ApprovalPolicy,
        policy_session_ids: Vec<SessionId>,
        response: oneshot::Sender<Result<ResumeSessionResponse, AcpRuntimeError>>,
    },
    DeleteSession {
        request: DeleteSessionRequest,
        response: oneshot::Sender<Result<DeleteSessionResponse, AcpRuntimeError>>,
    },
    CloseSession {
        request: CloseSessionRequest,
        response: oneshot::Sender<Result<CloseSessionResponse, AcpRuntimeError>>,
    },
    Prompt {
        request: PromptRequest,
        run_id: String,
        source_turn_id: String,
        approval_policy: ApprovalPolicy,
        policy_session_ids: Vec<SessionId>,
        response: oneshot::Sender<Result<PromptAdmission, AcpRuntimeError>>,
    },
    SetSessionConfigOption {
        request: SetSessionConfigOptionRequest,
        response: oneshot::Sender<Result<SetSessionConfigOptionResponse, AcpRuntimeError>>,
    },
    Cancel {
        session_id: agent_client_protocol::v1::schema::SessionId,
        response: oneshot::Sender<Result<(), AcpRuntimeError>>,
    },
    Steer {
        request: SteerRequest,
        interaction_epoch: u64,
        response: oneshot::Sender<Result<SteerResponse, AcpRuntimeError>>,
    },
    Fork {
        request: ForkRequest,
        response: oneshot::Sender<Result<ForkResponse, AcpRuntimeError>>,
    },
}

impl Command {
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::excessive_nesting,
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn dispatch(
        self,
        connection: &agent_client_protocol::v1::ConnectionTo<agent_client_protocol::Agent>,
        request_timeout: Duration,
        agent_id: &str,
        sessions: &SessionRegistry,
        interactions: &InteractionRegistry,
    ) {
        macro_rules! dispatch_ordinary {
            ($request:expr_2021, $cancellation:expr_2021, $response:expr_2021, $after:expr_2021) => {{
                let sent = connection.send_request($request);
                let cancellation = $cancellation;
                let sessions = sessions.clone();
                let agent_id = agent_id.to_string();
                let _ = connection.spawn(async move {
                    let mut request = Box::pin(sent.block_task());
                    let result = tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => Err(AcpRuntimeError::RequestCancelled),
                        result = tokio::time::timeout(request_timeout, &mut request) => match result {
                            Ok(Ok(value)) => Ok(value),
                            Ok(Err(error)) => Err(AcpRuntimeError::Connection(error.to_string())),
                            Err(_) => Err(AcpRuntimeError::RequestTimeout),
                        }
                    };
                    drop(request);
                    let result = $after(result, sessions, agent_id).await;
                    let _ = $response.send(result);
                    Ok(())
                });
            }};
        }
        match self {
            Self::NewSession {
                request,
                cancellation,
                reservation,
                response,
            } => {
                let after = move |result: Result<NewSessionResponse, AcpRuntimeError>,
                                  sessions: SessionRegistry,
                                  agent_id: String| async move {
                    if let Ok(value) = &result {
                        sessions
                            .register_reserved(&agent_id, value.session_id.clone(), reservation)
                            .await?;
                    } else {
                        sessions.release_reservation(reservation).await;
                    }
                    result
                };
                dispatch_ordinary!(request, cancellation, response, after);
            }
            Self::ListSessions { request, response } => {
                let cancellation = RequestCancellation::default();
                let after = |result: Result<ListSessionsResponse, AcpRuntimeError>,
                             _: SessionRegistry,
                             _: String| async move { result };
                dispatch_ordinary!(request, cancellation, response, after);
            }
            Self::DeleteSession { request, response } => {
                let session_id = request.session_id.clone();
                let cancellation = RequestCancellation::default();
                let after = move |result: Result<DeleteSessionResponse, AcpRuntimeError>,
                                  sessions: SessionRegistry,
                                  _: String| async move {
                    if result.is_ok() {
                        sessions.remove(&session_id).await;
                    }
                    result
                };
                dispatch_ordinary!(request, cancellation, response, after);
            }
            Self::CloseSession { request, response } => {
                let session_id = request.session_id.clone();
                let cancellation = RequestCancellation::default();
                let after = move |result: Result<CloseSessionResponse, AcpRuntimeError>,
                                  sessions: SessionRegistry,
                                  _: String| async move {
                    if result.is_ok() {
                        sessions.remove(&session_id).await;
                    }
                    result
                };
                dispatch_ordinary!(request, cancellation, response, after);
            }
            Self::LoadSession {
                request,
                approval_policy,
                policy_session_ids,
                response,
            } => {
                let session_id = request.session_id.clone();
                let session = sessions
                    .register_with_freshness(agent_id, request.session_id.clone())
                    .await
                    .map_err(AcpRuntimeError::from);
                let Ok((session, fresh)) = session else {
                    let _ = response.send(session.map(|_| LoadSessionResponse::new()));
                    return;
                };
                let Some(session_lease) = sessions.lease(&request.session_id).await else {
                    let _ = response.send(Err(AcpRuntimeError::SessionBusy));
                    return;
                };
                let policy_locks = interactions.lock_policy_sessions(&policy_session_ids).await;
                let reconstruction = if fresh {
                    Ok(session.begin_initial_reconstruction().await)
                } else {
                    session.begin_reconstruction().await
                };
                let reconstruction = match reconstruction {
                    Ok(reconstruction) => reconstruction,
                    Err(ReconstructionError::Busy | ReconstructionError::Cancelled) => {
                        let _ = response.send(Err(AcpRuntimeError::SessionBusy));
                        return;
                    }
                };
                if let Err(error) = interactions
                    .set_approval_policies_locked(policy_locks, approval_policy)
                    .await
                {
                    reconstruction.finish(false).await;
                    drop(session_lease);
                    if fresh {
                        sessions.remove(&session_id).await;
                    }
                    let _ = response.send(Err(error.into()));
                    return;
                }
                let cancellation = RequestCancellation::default();
                let after = move |result: Result<LoadSessionResponse, AcpRuntimeError>,
                                  sessions: SessionRegistry,
                                  _: String| async move {
                    let succeeded = result.is_ok();
                    reconstruction.finish(succeeded).await;
                    drop(session_lease);
                    if fresh && !succeeded {
                        sessions.remove(&session_id).await;
                    }
                    result
                };
                dispatch_ordinary!(request, cancellation, response, after);
            }
            Self::ResumeSession {
                request,
                approval_policy,
                policy_session_ids,
                response,
            } => {
                let session_id = request.session_id.clone();
                let session = sessions
                    .register_with_freshness(agent_id, request.session_id.clone())
                    .await
                    .map_err(AcpRuntimeError::from);
                let Ok((session, fresh)) = session else {
                    let _ = response.send(session.map(|_| ResumeSessionResponse::new()));
                    return;
                };
                let Some(session_lease) = sessions.lease(&request.session_id).await else {
                    let _ = response.send(Err(AcpRuntimeError::SessionBusy));
                    return;
                };
                let policy_locks = interactions.lock_policy_sessions(&policy_session_ids).await;
                let reconstruction = if fresh {
                    Ok(session.begin_initial_reconstruction().await)
                } else {
                    session.begin_reconstruction().await
                };
                let reconstruction = match reconstruction {
                    Ok(reconstruction) => reconstruction,
                    Err(ReconstructionError::Busy | ReconstructionError::Cancelled) => {
                        let _ = response.send(Err(AcpRuntimeError::SessionBusy));
                        return;
                    }
                };
                if let Err(error) = interactions
                    .set_approval_policies_locked(policy_locks, approval_policy)
                    .await
                {
                    reconstruction.finish(false).await;
                    drop(session_lease);
                    if fresh {
                        sessions.remove(&session_id).await;
                    }
                    let _ = response.send(Err(error.into()));
                    return;
                }
                let cancellation = RequestCancellation::default();
                let after = move |result: Result<ResumeSessionResponse, AcpRuntimeError>,
                                  sessions: SessionRegistry,
                                  _: String| async move {
                    let succeeded = result.is_ok();
                    reconstruction.finish(succeeded).await;
                    drop(session_lease);
                    if fresh && !succeeded {
                        sessions.remove(&session_id).await;
                    }
                    result
                };
                dispatch_ordinary!(request, cancellation, response, after);
            }
            Self::Prompt {
                request,
                run_id,
                source_turn_id,
                approval_policy,
                policy_session_ids,
                response,
            } => {
                let Some(session_lease) = sessions.lease(&request.session_id).await else {
                    let _ = response.send(Err(AcpRuntimeError::SessionBusy));
                    return;
                };
                let session = session_lease.session().clone();
                let policy_locks = interactions.lock_policy_sessions(&policy_session_ids).await;
                let admission = match session
                    .admit_prompt(run_id.clone(), source_turn_id.clone())
                    .await
                {
                    Ok((generation, _)) => PromptAdmission {
                        run_id,
                        source_turn_id,
                        generation,
                    },
                    Err(_) => {
                        let _ = response.send(Err(AcpRuntimeError::SessionBusy));
                        return;
                    }
                };
                if let Err(error) = interactions
                    .set_approval_policies_locked(policy_locks, approval_policy)
                    .await
                {
                    drop(session_lease);
                    session.fail_active(error.to_string()).await;
                    let _ = response.send(Err(error.into()));
                    return;
                }
                drop(session_lease);
                let snapshot = session.snapshot().await;
                let message_id =
                    format!("{}::user::{}", snapshot.thread_id, admission.source_turn_id);
                session
                    .emit_prompt_transcript(
                        &request.prompt,
                        Some(admission.run_id.clone()),
                        Some(admission.source_turn_id.clone()),
                        Some(admission.generation),
                        message_id,
                    )
                    .await;
                let callback_session = session.clone();
                let callback_admission = admission.clone();
                let registration = connection.send_request(request).on_receiving_result(
                    move |result| async move {
                        let snapshot = callback_session.snapshot().await;
                        let event = match result {
                            Ok(prompt) => {
                                if let Some(usage) = prompt.usage.as_ref() {
                                    callback_session
                                        .emit(CanonicalEvent::TurnTokenUsage {
                                            agent_id: snapshot.agent_id.clone(),
                                            thread_id: snapshot.thread_id.clone(),
                                            input_tokens: usage.input_tokens,
                                            output_tokens: usage.output_tokens,
                                            reasoning_tokens: usage.thought_tokens,
                                            cached_read_tokens: usage.cached_read_tokens,
                                            cached_write_tokens: usage.cached_write_tokens,
                                            total_tokens: usage.total_tokens,
                                        })
                                        .await;
                                }
                                CanonicalEvent::RunFinished {
                                    agent_id: snapshot.agent_id,
                                    thread_id: snapshot.thread_id,
                                    run_id: callback_admission.run_id,
                                    source_turn_id: callback_admission.source_turn_id,
                                    generation: callback_admission.generation,
                                    stop_reason: prompt.stop_reason,
                                }
                            }
                            Err(error) => CanonicalEvent::RunFailed {
                                agent_id: snapshot.agent_id,
                                thread_id: snapshot.thread_id,
                                run_id: callback_admission.run_id,
                                source_turn_id: callback_admission.source_turn_id,
                                generation: callback_admission.generation,
                                message: error.to_string(),
                            },
                        };
                        callback_session.emit(event).await;
                        Ok(())
                    },
                );
                match registration {
                    Ok(()) => {
                        let _ = response.send(Ok(admission));
                    }
                    Err(error) => {
                        session.fail_active(error.to_string()).await;
                        let _ = response.send(Err(AcpRuntimeError::Connection(error.to_string())));
                    }
                }
            }
            Self::SetSessionConfigOption { request, response } => {
                let session_id = request.session_id.clone();
                let Some(session) = sessions.get(&session_id).await else {
                    let _ =
                        response.send(Err(AcpRuntimeError::UnknownSession(session_id.to_string())));
                    return;
                };
                let cancellation = RequestCancellation::default();
                let after =
                    move |result: Result<SetSessionConfigOptionResponse, AcpRuntimeError>,
                          _: SessionRegistry,
                          agent_id: String| async move {
                        if let Ok(value) = &result {
                            let snapshot = session.snapshot().await;
                            session
                                .emit(CanonicalEvent::Config {
                                    agent_id,
                                    thread_id: snapshot.thread_id,
                                    entries: super::handlers::config_entries(
                                        value.config_options.clone(),
                                    ),
                                })
                                .await;
                        }
                        result
                    };
                dispatch_ordinary!(request, cancellation, response, after);
            }
            Self::Cancel {
                session_id,
                response,
            } => {
                let result = connection
                    .send_notification(CancelNotification::new(session_id))
                    .map_err(|error| error.to_string())
                    .map_err(AcpRuntimeError::Connection);
                let _ = response.send(result);
            }
            Self::Steer {
                request,
                interaction_epoch,
                response,
            } => {
                let session_id = request.session_id.clone();
                let sent = interactions
                    .with_verified_steer_epoch(&session_id, interaction_epoch, || {
                        connection.send_request(request)
                    })
                    .await;
                let Some(sent) = sent else {
                    let _ =
                        response.send(Err(AcpRuntimeError::Unsupported("stale interaction epoch")));
                    return;
                };
                let _ = connection.spawn(async move {
                    let result =
                        match tokio::time::timeout(request_timeout, sent.block_task()).await {
                            Ok(Ok(value)) => Ok(value),
                            Ok(Err(error)) => Err(AcpRuntimeError::Connection(error.to_string())),
                            Err(_) => Err(AcpRuntimeError::RequestTimeout),
                        };
                    let _ = response.send(result);
                    Ok(())
                });
            }
            Self::Fork { request, response } => {
                let sent = connection.send_request(request);
                let _ = connection.spawn(async move {
                    let result =
                        match tokio::time::timeout(request_timeout, sent.block_task()).await {
                            Ok(Ok(value)) => Ok(value),
                            Ok(Err(error)) => Err(AcpRuntimeError::Connection(error.to_string())),
                            Err(_) => Err(AcpRuntimeError::RequestTimeout),
                        };
                    let _ = response.send(result);
                    Ok(())
                });
            }
        }
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "runtime_tests.rs"]
mod tests;
