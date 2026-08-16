use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CancelNotification, ClientCapabilities, CloseSessionRequest, CloseSessionResponse,
    ContentBlock, CreateElicitationRequest, DeleteSessionRequest, DeleteSessionResponse,
    ElicitationCapabilities, ElicitationContentValue, ElicitationFormCapabilities,
    InitializeRequest, InitializeResponse, ListSessionsRequest, ListSessionsResponse,
    LoadSessionRequest, LoadSessionResponse, NewSessionRequest, NewSessionResponse, PromptRequest,
    RequestPermissionRequest, ResumeSessionRequest, ResumeSessionResponse, SessionId,
    SessionNotification, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Client, ConnectTo, JsonRpcRequest, JsonRpcResponse};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, watch};

use super::config::{ResolvedAgentManifest, RuntimeManifestError};
use super::events::CanonicalEvent;
use super::interactions::{
    ApprovalPolicy, InteractionError, InteractionRegistry, PendingElicitationSummary,
    PendingPermissionSummary,
};
use super::session::{AcpSession, ReconstructionError, SessionRegistry, SessionRouteError};

const COMMAND_BUFFER: usize = 64;
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

#[derive(Clone)]
pub struct RequestCancellation {
    sender: watch::Sender<bool>,
}

impl Default for RequestCancellation {
    fn default() -> Self {
        let (sender, _) = watch::channel(false);
        Self { sender }
    }
}

impl RequestCancellation {
    pub fn cancel(&self) {
        self.sender.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.sender.borrow()
    }

    pub async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        while !*receiver.borrow_and_update() {
            receiver
                .changed()
                .await
                .expect("request cancellation sender remains alive");
        }
    }
}

#[derive(Debug, Clone)]
pub struct NegotiatedInitialize {
    pub response: InitializeResponse,
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
            .and_then(|descriptor| serde_json::from_value::<ExtensionCapability>(descriptor).ok())
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
    ) -> Result<(Self, NegotiatedInitialize), AcpRuntimeError> {
        Self::start_transport(
            manifest.agent_id.clone(),
            manifest.acp_agent_with_args(approved_roots, host_environment, extra_argv)?,
            initialize_timeout,
        )
        .await
    }

    pub(super) async fn start_transport<T>(
        agent_id: String,
        transport: T,
        initialize_timeout: Duration,
    ) -> Result<(Self, NegotiatedInitialize), AcpRuntimeError>
    where
        T: ConnectTo<Client> + Send + 'static,
    {
        #[cfg(test)]
        let connection_agent_id: Arc<str> = Arc::from(agent_id.clone());
        let (ready_tx, mut ready_rx) = mpsc::channel(1);
        let (commands, mut command_rx) = mpsc::channel::<Command>(COMMAND_BUFFER);
        let (shutdown, mut shutdown_rx) = watch::channel(false);
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
                .builder()
                .on_receive_notification(
                    async move |notification: SessionNotification, _| {
                        notification_sessions
                            .route(&notification_agent_id, notification)
                            .await
                            .map_err(|error| {
                                agent_client_protocol::util::internal_error(error.to_string())
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
                .connect_with(transport, async move |connection| {
                let capabilities = ClientCapabilities::new().elicitation(
                    ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()),
                );
                let response = tokio::time::timeout(
                    initialize_timeout,
                    connection.send_request(InitializeRequest::new(ProtocolVersion::V1).client_capabilities(capabilities)).block_task(),
                )
                .await
                .map_err(|_| agent_client_protocol::util::internal_error("ACP initialization timed out"))??;
                let negotiated = NegotiatedInitialize { response };
                let _ = ready_for_initialize.send(Ok(negotiated.clone())).await;
                loop {
                    tokio::select! {
                        changed = shutdown_rx.changed() => {
                            changed.map_err(|_| agent_client_protocol::util::internal_error("ACP shutdown channel closed"))?;
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
            actor_interactions.drain().await;
            finish_connection_actor(
                result.map_err(|error| error.to_string()),
                &ready_tx,
                &actor_requested_shutdown,
                &failure_tx,
                &actor_sessions,
            )
            .await;
        });
        match tokio::time::timeout(initialize_timeout, ready_rx.recv()).await {
            Ok(Some(Ok(negotiated))) => Ok((
                Self {
                    #[cfg(test)]
                    agent_id: connection_agent_id,
                    commands,
                    negotiated: Arc::new(negotiated.clone()),
                    shutdown,
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
        session_id: agent_client_protocol::schema::v1::SessionId,
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
        session_id: agent_client_protocol::schema::v1::SessionId,
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
        session_id: &agent_client_protocol::schema::v1::SessionId,
    ) -> Result<u64, AcpRuntimeError> {
        if self.sessions.get(session_id).await.is_none() {
            return Err(AcpRuntimeError::UnknownSession(session_id.to_string()));
        }
        Ok(self.interactions.prepare_steer(session_id).await?)
    }

    pub async fn verify_steer_epoch(
        &self,
        session_id: &agent_client_protocol::schema::v1::SessionId,
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
        session_id: &agent_client_protocol::schema::v1::SessionId,
    ) -> Option<AcpSession> {
        self.sessions.get(session_id).await
    }

    pub(crate) async fn evict_session(
        &self,
        session_id: &agent_client_protocol::schema::v1::SessionId,
    ) {
        self.sessions.remove(session_id).await;
    }

    #[cfg(test)]
    pub async fn ensure_session(
        &self,
        session_id: agent_client_protocol::schema::v1::SessionId,
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

    async fn call<T>(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<T, AcpRuntimeError>>) -> Command,
    ) -> Result<T, AcpRuntimeError> {
        if let Some(message) = self.failure.borrow().clone() {
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
        self.shutdown
            .send(true)
            .map_err(|_| AcpRuntimeError::ConnectionTaskEnded)
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
        session_id: agent_client_protocol::schema::v1::SessionId,
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
    async fn dispatch(
        self,
        connection: &agent_client_protocol::ConnectionTo<agent_client_protocol::Agent>,
        request_timeout: Duration,
        agent_id: &str,
        sessions: &SessionRegistry,
        interactions: &InteractionRegistry,
    ) {
        macro_rules! dispatch_ordinary {
            ($request:expr, $cancellation:expr, $response:expr, $after:expr) => {{
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
            } => dispatch_ordinary!(
                request,
                cancellation,
                response,
                |result: Result<NewSessionResponse, AcpRuntimeError>,
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
                }
            ),
            Self::ListSessions { request, response } => dispatch_ordinary!(
                request,
                RequestCancellation::default(),
                response,
                |result: Result<ListSessionsResponse, AcpRuntimeError>,
                 _: SessionRegistry,
                 _: String| async move { result }
            ),
            Self::DeleteSession { request, response } => {
                let session_id = request.session_id.clone();
                dispatch_ordinary!(
                    request,
                    RequestCancellation::default(),
                    response,
                    move |result: Result<DeleteSessionResponse, AcpRuntimeError>,
                          sessions: SessionRegistry,
                          _: String| async move {
                        if result.is_ok() {
                            sessions.remove(&session_id).await;
                        }
                        result
                    }
                );
            }
            Self::CloseSession { request, response } => {
                let session_id = request.session_id.clone();
                dispatch_ordinary!(
                    request,
                    RequestCancellation::default(),
                    response,
                    move |result: Result<CloseSessionResponse, AcpRuntimeError>,
                          sessions: SessionRegistry,
                          _: String| async move {
                        if result.is_ok() {
                            sessions.remove(&session_id).await;
                        }
                        result
                    }
                );
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
                dispatch_ordinary!(
                    request,
                    RequestCancellation::default(),
                    response,
                    move |result: Result<LoadSessionResponse, AcpRuntimeError>,
                          sessions: SessionRegistry,
                          _: String| async move {
                        let succeeded = result.is_ok();
                        reconstruction.finish(succeeded).await;
                        drop(session_lease);
                        if fresh && !succeeded {
                            sessions.remove(&session_id).await;
                        }
                        result
                    }
                );
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
                dispatch_ordinary!(
                    request,
                    RequestCancellation::default(),
                    response,
                    move |result: Result<ResumeSessionResponse, AcpRuntimeError>,
                          sessions: SessionRegistry,
                          _: String| async move {
                        let succeeded = result.is_ok();
                        reconstruction.finish(succeeded).await;
                        drop(session_lease);
                        if fresh && !succeeded {
                            sessions.remove(&session_id).await;
                        }
                        result
                    }
                );
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
                for block in &request.prompt {
                    let (content, content_block) = match block {
                        ContentBlock::Text(text) => (text.text.clone(), None),
                        block => (String::new(), serde_json::to_value(block).ok()),
                    };
                    session
                        .emit(CanonicalEvent::MessageChunk {
                            agent_id: snapshot.agent_id.clone(),
                            thread_id: snapshot.thread_id.clone(),
                            run_id: Some(admission.run_id.clone()),
                            source_turn_id: Some(admission.source_turn_id.clone()),
                            generation: Some(admission.generation),
                            role: super::events::MessageRole::User,
                            message_id: message_id.clone(),
                            content,
                            content_block,
                        })
                        .await;
                }
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
                dispatch_ordinary!(
                    request,
                    RequestCancellation::default(),
                    response,
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
                    }
                );
            }
            Self::Cancel {
                session_id,
                response,
            } => {
                let result = connection
                    .send_notification(CancelNotification::new(session_id))
                    .map_err(|error| AcpRuntimeError::Connection(error.to_string()));
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
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Mutex as StdMutex;

    use agent_client_protocol::schema::v1::{
        AgentCapabilities, BooleanPropertySchema, CreateElicitationResponse, ElicitationAction,
        ElicitationFormMode, ElicitationRequestScope, ElicitationSchema, ElicitationSessionScope,
        IntegerPropertySchema, ListSessionsResponse, LoadSessionResponse,
        MultiSelectPropertySchema, NewSessionResponse, NumberPropertySchema, PermissionOption,
        PermissionOptionKind, PromptResponse, RequestPermissionOutcome, RequestPermissionResponse,
        ResumeSessionResponse, SessionCapabilities, SessionCloseCapabilities,
        SessionDeleteCapabilities, SessionInfo, SessionListCapabilities, SessionResumeCapabilities,
        SessionUpdate, StopReason, StringPropertySchema, ToolCallStatus, ToolCallUpdate,
        ToolCallUpdateFields, ToolKind,
    };

    #[tokio::test]
    async fn requested_shutdown_does_not_publish_connection_failure() {
        let (ready_tx, mut ready_rx) = mpsc::channel(1);
        let (failure_tx, failure) = watch::channel(None);

        finish_connection_actor(
            Err("closed".to_string()),
            &ready_tx,
            &AtomicBool::new(true),
            &failure_tx,
            &SessionRegistry::default(),
        )
        .await;

        assert!(matches!(
            ready_rx.recv().await,
            Some(Err(AcpRuntimeError::Connection(message))) if message == "closed"
        ));
        assert_eq!(*failure.borrow(), None);
    }
    use agent_client_protocol::{Agent, Client, ConnectTo, Responder};

    #[derive(Clone)]
    enum TestInteraction {
        Permission(RequestPermissionRequest, bool),
        Elicitation(CreateElicitationRequest, bool),
    }

    enum ObservedInteraction {
        Permission(Result<RequestPermissionResponse, String>),
        Elicitation(Result<CreateElicitationResponse, String>),
    }

    struct PendingInteractionFixture {
        connection: AcpConnection,
        events: crate::acp::events::CanonicalEventReceiver,
        session_id: agent_client_protocol::schema::v1::SessionId,
        observed: mpsc::UnboundedReceiver<ObservedInteraction>,
        prompt_responder: Arc<StdMutex<Option<Responder<PromptResponse>>>>,
    }

    fn interaction_agent(
        interaction: TestInteraction,
        observed: mpsc::UnboundedSender<ObservedInteraction>,
        prompt_responder: Arc<StdMutex<Option<Responder<PromptResponse>>>>,
    ) -> impl ConnectTo<Client> {
        Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("interaction-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: PromptRequest, responder, connection| {
                    *prompt_responder.lock().expect("prompt responder lock") = Some(responder);
                    match interaction.clone() {
                        TestInteraction::Permission(request, cancel_from_agent) => {
                            let sent = connection.send_request(request);
                            if cancel_from_agent {
                                sent.cancel()?;
                            }
                            sent.on_receiving_result({
                                let observed = observed.clone();
                                async move |result| {
                                    let _ = observed.send(ObservedInteraction::Permission(
                                        result.map_err(|error| error.to_string()),
                                    ));
                                    Ok(())
                                }
                            })?;
                        }
                        TestInteraction::Elicitation(request, cancel_from_agent) => {
                            let sent = connection.send_request(request);
                            if cancel_from_agent {
                                sent.cancel()?;
                            }
                            sent.on_receiving_result({
                                let observed = observed.clone();
                                async move |result| {
                                    let _ = observed.send(ObservedInteraction::Elicitation(
                                        result.map_err(|error| error.to_string()),
                                    ));
                                    Ok(())
                                }
                            })?;
                        }
                    }
                    Ok(())
                },
                agent_client_protocol::on_receive_request!(),
            )
    }

    async fn start_pending_interaction_for_agent(
        agent_id: &str,
        interaction: TestInteraction,
    ) -> PendingInteractionFixture {
        start_pending_interaction_for_agent_with_policy(
            agent_id,
            interaction,
            ApprovalPolicy::Untrusted,
        )
        .await
    }

    async fn start_pending_interaction_for_agent_with_policy(
        agent_id: &str,
        interaction: TestInteraction,
        approval_policy: ApprovalPolicy,
    ) -> PendingInteractionFixture {
        let (observed_tx, observed) = mpsc::unbounded_channel();
        let prompt_responder = Arc::new(StdMutex::new(None));
        let agent = interaction_agent(interaction, observed_tx, prompt_responder.clone());
        let (connection, _) =
            AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
                .await
                .expect("interaction agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let session = connection
            .session(&created.session_id)
            .await
            .expect("session registered");
        let events = session.take_events().await.expect("session event receiver");
        connection
            .prompt_with_policy(
                PromptRequest::new(created.session_id.clone(), vec!["interact".into()]),
                "interaction-run".to_string(),
                "interaction-turn".to_string(),
                approval_policy,
            )
            .await
            .expect("prompt admitted");
        PendingInteractionFixture {
            connection,
            events,
            session_id: created.session_id,
            observed,
            prompt_responder,
        }
    }

    async fn start_pending_interaction(interaction: TestInteraction) -> PendingInteractionFixture {
        start_pending_interaction_for_agent("test-agent", interaction).await
    }

    fn permission_request(options: Vec<PermissionOption>) -> RequestPermissionRequest {
        permission_request_with_kind(options, ToolKind::Edit)
    }

    fn permission_request_with_kind(
        options: Vec<PermissionOption>,
        kind: ToolKind,
    ) -> RequestPermissionRequest {
        RequestPermissionRequest::new(
            "interaction-session",
            ToolCallUpdate::new(
                "tool-1",
                ToolCallUpdateFields::new()
                    .title("Write file")
                    .kind(kind)
                    .status(ToolCallStatus::Pending),
            ),
            options,
        )
    }

    fn permission_options() -> Vec<PermissionOption> {
        vec![
            PermissionOption::new("allow-once", "Allow", PermissionOptionKind::AllowOnce),
            PermissionOption::new("reject-once", "Reject", PermissionOptionKind::RejectOnce),
        ]
    }

    async fn requested_event(
        events: &mut crate::acp::events::CanonicalEventReceiver,
        permission: bool,
    ) {
        loop {
            let event = events.recv().await.expect("interaction event");
            if permission && matches!(event, CanonicalEvent::PermissionRequested { .. }) {
                return;
            }
            if !permission && matches!(event, CanonicalEvent::ElicitationRequested { .. }) {
                return;
            }
        }
    }

    async fn resolved_event(
        events: &mut crate::acp::events::CanonicalEventReceiver,
        permission: bool,
    ) -> CanonicalEvent {
        loop {
            let event = events.recv().await.expect("interaction resolution event");
            if permission && matches!(event, CanonicalEvent::PermissionResolved { .. }) {
                return event;
            }
            if !permission && matches!(event, CanonicalEvent::ElicitationResolved { .. }) {
                return event;
            }
        }
    }

    async fn finish_fixture(fixture: &PendingInteractionFixture) {
        if let Some(responder) = fixture
            .prompt_responder
            .lock()
            .expect("prompt responder lock")
            .take()
        {
            responder
                .respond(PromptResponse::new(StopReason::Cancelled))
                .expect("prompt response");
        }
        fixture.connection.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn delete_session_is_capability_gated_and_evicts_the_loaded_session() {
        let delete_calls = Arc::new(AtomicUsize::new(0));

        let plain_agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let delete_calls = delete_calls.clone();
                    async move |_request: DeleteSessionRequest, responder, _| {
                        delete_calls.fetch_add(1, AtomicOrdering::SeqCst);
                        responder.respond(DeleteSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (plain, _) = AcpConnection::start_transport(
            "no-delete-agent".into(),
            plain_agent,
            Duration::from_secs(1),
        )
        .await
        .expect("agent starts");
        assert!(!plain.negotiated().supports_session_delete());
        assert!(matches!(
            plain
                .delete_session(DeleteSessionRequest::new(SessionId::new("any")))
                .await,
            Err(AcpRuntimeError::Unsupported("session/delete"))
        ));
        assert_eq!(delete_calls.load(AtomicOrdering::SeqCst), 0);
        plain.shutdown().await.expect("shutdown");

        let capable_agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new().session_capabilities(
                        SessionCapabilities::new().delete(SessionDeleteCapabilities::new()),
                    )))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let delete_calls = delete_calls.clone();
                    async move |_request: DeleteSessionRequest, responder, _| {
                        delete_calls.fetch_add(1, AtomicOrdering::SeqCst);
                        responder.respond(DeleteSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) = AcpConnection::start_transport(
            "delete-agent".into(),
            capable_agent,
            Duration::from_secs(1),
        )
        .await
        .expect("agent starts");
        assert!(connection.negotiated().supports_session_delete());
        let session_id = SessionId::new("deletable");
        connection
            .ensure_session(session_id.clone())
            .await
            .expect("session capacity");
        assert!(connection.session(&session_id).await.is_some());

        connection
            .delete_session(DeleteSessionRequest::new(session_id.clone()))
            .await
            .expect("delete succeeds");

        assert_eq!(delete_calls.load(AtomicOrdering::SeqCst), 1);
        assert!(connection.session(&session_id).await.is_none());
        connection.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn close_session_uses_the_advertised_method_and_evicts_the_loaded_session() {
        let close_calls = Arc::new(AtomicUsize::new(0));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new().session_capabilities(
                        SessionCapabilities::new().close(SessionCloseCapabilities::new()),
                    )))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let close_calls = close_calls.clone();
                    async move |_request: CloseSessionRequest, responder, _| {
                        close_calls.fetch_add(1, AtomicOrdering::SeqCst);
                        responder.respond(CloseSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("close-agent".into(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        assert!(connection.negotiated().supports_session_close());
        let session_id = SessionId::new("closable");
        connection
            .ensure_session(session_id.clone())
            .await
            .expect("session capacity");

        connection
            .close_session(CloseSessionRequest::new(session_id.clone()))
            .await
            .expect("close succeeds");

        assert_eq!(close_calls.load(AtomicOrdering::SeqCst), 1);
        assert!(connection.session(&session_id).await.is_none());
        connection.shutdown().await.expect("shutdown");
    }

    fn initialized(capabilities: AgentCapabilities) -> InitializeResponse {
        InitializeResponse::new(ProtocolVersion::V1).agent_capabilities(capabilities)
    }

    #[tokio::test]
    async fn prompt_response_usage_emits_before_finish_and_updates_snapshot() {
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("usage-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: PromptRequest, responder, _| {
                    let response: PromptResponse = serde_json::from_value(serde_json::json!({
                        "stopReason": "end_turn",
                        "usage": {
                            "totalTokens": 42,
                            "inputTokens": 20,
                            "outputTokens": 10,
                            "thoughtTokens": 5,
                            "cachedReadTokens": 6,
                            "cachedWriteTokens": 1
                        }
                    }))
                    .expect("prompt usage fixture");
                    responder.respond(response)
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("usage-agent".into(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/workspace"))
            .await
            .expect("session created");
        let session = connection.session(&created.session_id).await.unwrap();
        let mut events = session.take_events().await.expect("session event receiver");

        connection
            .prompt(
                PromptRequest::new(created.session_id, vec!["count tokens".into()]),
                "usage-run".into(),
                "usage-turn".into(),
            )
            .await
            .expect("prompt admitted");

        let mut usage_seen = false;
        loop {
            match events.recv().await.expect("prompt event") {
                CanonicalEvent::TurnTokenUsage {
                    input_tokens,
                    output_tokens,
                    reasoning_tokens,
                    cached_read_tokens,
                    cached_write_tokens,
                    total_tokens,
                    ..
                } => {
                    assert!(!usage_seen);
                    usage_seen = true;
                    assert_eq!(input_tokens, 20);
                    assert_eq!(output_tokens, 10);
                    assert_eq!(reasoning_tokens, Some(5));
                    assert_eq!(cached_read_tokens, Some(6));
                    assert_eq!(cached_write_tokens, Some(1));
                    assert_eq!(total_tokens, 42);
                }
                CanonicalEvent::RunFinished { .. } => {
                    assert!(usage_seen, "usage must settle before the run finishes");
                    break;
                }
                _ => {}
            }
        }

        assert_eq!(
            session.snapshot().await.token_totals,
            Some(crate::acp::snapshot::BridgeTokenTotalsSnapshot {
                turns: 1,
                input_tokens: 20,
                output_tokens: 10,
                reasoning_tokens: Some(5),
                cached_read_tokens: Some(6),
                cached_write_tokens: Some(1),
                total_tokens: 42,
            })
        );
        connection.shutdown().await.expect("shutdown");
    }

    fn steer_meta() -> agent_client_protocol::schema::v1::Meta {
        serde_json::from_value(serde_json::json!({
            "dappercode.dev": {
                "version": 1,
                "capabilities": {
                    "sessionSteer": {
                        "method": "_dappercode.dev/session/steer",
                        "version": 1
                    }
                }
            }
        }))
        .expect("valid extension metadata")
    }

    fn fork_meta() -> agent_client_protocol::schema::v1::Meta {
        serde_json::from_value(serde_json::json!({
            "dappercode.dev": {
                "version": 1,
                "capabilities": {
                    "sessionFork": {
                        "method": FORK_METHOD,
                        "version": 1
                    }
                }
            }
        }))
        .expect("valid fork extension metadata")
    }

    fn update(value: serde_json::Value) -> SessionUpdate {
        serde_json::from_value(value).expect("valid typed session update fixture")
    }

    fn assert_connection_failure<T>(result: Result<T, AcpRuntimeError>) {
        assert!(matches!(
            result,
            Err(AcpRuntimeError::Connection(_)) | Err(AcpRuntimeError::ConnectionUnavailable(_))
        ));
    }

    #[test]
    fn steer_negotiation_rejects_absent_malformed_and_oversized_metadata() {
        let absent = NegotiatedInitialize {
            response: initialized(AgentCapabilities::new()),
        };
        assert!(!absent.supports_session_steer());

        for value in [
            serde_json::json!({"dappercode.dev": true}),
            serde_json::json!({"dappercode.dev": {"version": "1", "capabilities": {"sessionSteer": {"method": STEER_METHOD, "version": 1}}}}),
            serde_json::json!({"dappercode.dev": {"version": 2, "capabilities": {}}}),
            serde_json::json!({"dappercode.dev": {"version": 1, "capabilities": []}}),
            serde_json::json!({"dappercode.dev": {"version": 1, "capabilities": {"sessionSteer": true}}}),
            serde_json::json!({"dappercode.dev": {"version": 2, "capabilities": {"sessionSteer": {"method": STEER_METHOD, "version": 1}}}}),
            serde_json::json!({"dappercode.dev": {"version": 1, "capabilities": {"sessionSteer": {"method": "wrong", "version": 1}}}}),
            serde_json::json!({"dappercode.dev": {"version": 1, "capabilities": {"sessionSteer": {"method": STEER_METHOD, "version": 2}}}}),
            serde_json::json!({"dappercode.dev": {"version": 1, "capabilities": {"sessionSteer": {"method": STEER_METHOD, "version": 1, "extra": true}}}}),
            serde_json::json!({"dappercode.dev": {"version": 1, "capabilities": {"sessionSteer": {"method": STEER_METHOD, "version": 1}}, "extra": true}}),
        ] {
            let mut response = initialized(AgentCapabilities::new());
            response.meta = serde_json::from_value(value).ok();
            assert!(!NegotiatedInitialize { response }.supports_session_steer());
        }
        let mut response = initialized(AgentCapabilities::new());
        response.meta = Some(steer_meta());
        assert!(NegotiatedInitialize { response }.supports_session_steer());

        let mut oversized = steer_meta();
        oversized.insert("padding".to_string(), serde_json::json!("x".repeat(5_000)));
        let mut response = initialized(AgentCapabilities::new());
        response.meta = Some(oversized);
        assert!(!NegotiatedInitialize { response }.supports_session_steer());

        let mut response = initialized(AgentCapabilities::new());
        response.meta = serde_json::from_value(serde_json::json!({
            "dappercode.dev": {
                "version": 1,
                "capabilities": {
                    "sessionSteer": {
                        "method": STEER_METHOD,
                        "version": 1
                    }
                },
                "padding": "x".repeat(5_000)
            }
        }))
        .ok();
        assert!(!NegotiatedInitialize { response }.supports_session_steer());
    }

    #[test]
    fn extension_capabilities_are_independent_and_allow_sibling_vendor_metadata() {
        for (steer, fork) in [(true, false), (false, true), (true, true)] {
            let mut capabilities = serde_json::Map::new();
            if steer {
                capabilities.insert(
                    "sessionSteer".to_string(),
                    serde_json::json!({"method": STEER_METHOD, "version": 1}),
                );
            }
            if fork {
                capabilities.insert(
                    "sessionFork".to_string(),
                    serde_json::json!({"method": FORK_METHOD, "version": 1}),
                );
            }
            let mut response = initialized(AgentCapabilities::new());
            response.meta = serde_json::from_value(serde_json::json!({
                "dappercode.dev": {"version": 1, "capabilities": capabilities},
                "another.vendor": {"enabled": true}
            }))
            .ok();
            let negotiated = NegotiatedInitialize { response };
            assert_eq!(negotiated.supports_session_steer(), steer);
            assert_eq!(negotiated.supports_session_fork(), fork);
        }

        let mut response = initialized(AgentCapabilities::new());
        response.meta = serde_json::from_value(serde_json::json!({
            "dappercode.dev": {
                "version": 1,
                "capabilities": {
                    "sessionSteer": {"method": STEER_METHOD, "version": 1},
                    "sessionFork": true
                }
            }
        }))
        .ok();
        let negotiated = NegotiatedInitialize { response };
        assert!(negotiated.supports_session_steer());
        assert!(!negotiated.supports_session_fork());
    }

    #[tokio::test]
    async fn typed_fork_is_capability_and_session_gated_before_dispatch() {
        let plain_agent = Agent.builder().on_receive_request(
            async |_request: InitializeRequest, responder, _| {
                responder.respond(initialized(AgentCapabilities::new()))
            },
            agent_client_protocol::on_receive_request!(),
        );
        let (plain, _) =
            AcpConnection::start_transport("plain".into(), plain_agent, Duration::from_secs(1))
                .await
                .expect("plain agent starts");
        assert!(matches!(
            plain
                .fork_session_extension(ForkRequest {
                    session_id: SessionId::new("source"),
                    message_id: Some("message".to_string()),
                    user_message_ordinal: 1,
                })
                .await,
            Err(AcpRuntimeError::Unsupported(FORK_METHOD))
        ));
        assert!(matches!(
            plain
                .verify_steer_epoch(&SessionId::new("missing"), 1)
                .await,
            Err(AcpRuntimeError::UnknownSession(_))
        ));
        assert!(matches!(
            plain
                .close_session(CloseSessionRequest::new(SessionId::new("missing")))
                .await,
            Err(AcpRuntimeError::Unsupported("session/close"))
        ));
        plain.shutdown().await.expect("plain shutdown");

        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel::<ForkRequest>();
        let fork_agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    let mut response = initialized(AgentCapabilities::new());
                    response.meta = Some(fork_meta());
                    responder.respond(response)
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: ForkRequest, responder, _| {
                    let _ = observed_tx.send(request);
                    responder.respond(ForkResponse {
                        session_id: SessionId::new("forked"),
                        title: Some("Forked".to_string()),
                    })
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("fork".into(), fork_agent, Duration::from_secs(1))
                .await
                .expect("fork agent starts");
        let request = ForkRequest {
            session_id: SessionId::new("source"),
            message_id: Some("message".to_string()),
            user_message_ordinal: 1,
        };
        assert!(matches!(
            connection.fork_session_extension(request.clone()).await,
            Err(AcpRuntimeError::UnknownSession(_))
        ));
        connection
            .ensure_session(SessionId::new("source"))
            .await
            .expect("source session");
        assert_eq!(
            connection
                .fork_session_extension(request)
                .await
                .expect("fork response")
                .session_id,
            SessionId::new("forked")
        );
        assert_eq!(
            observed_rx.recv().await.expect("observed fork").message_id,
            Some("message".to_string())
        );
        connection.shutdown().await.expect("fork shutdown");
    }

    #[tokio::test]
    async fn typed_steer_preserves_prompt_and_live_correlation_until_agent_ack() {
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel::<SteerRequest>();
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let timed_out_steer_responder = Arc::new(StdMutex::new(None::<Responder<SteerResponse>>));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    let mut response = initialized(AgentCapabilities::new());
                    response.meta = Some(steer_meta());
                    responder.respond(response)
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("steer-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, _| {
                        *prompt_responder.lock().expect("prompt lock") = Some(responder);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let timed_out_steer_responder = timed_out_steer_responder.clone();
                    async move |request: SteerRequest, responder, _| {
                        let should_timeout = request.prompt.iter().any(
                            |block| matches!(block, ContentBlock::Text(text) if text.text == "timeout"),
                        );
                        let accepted = !request.prompt.iter().any(
                            |block| matches!(block, ContentBlock::Text(text) if text.text == "reject"),
                        );
                        let _ = observed_tx.send(request);
                        if should_timeout {
                            *timed_out_steer_responder
                                .lock()
                                .expect("steer responder lock") = Some(responder);
                            Ok(())
                        } else {
                            responder.respond(SteerResponse { accepted })
                        }
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, negotiated) = AcpConnection::start_transport(
            "typed-steer-agent".to_string(),
            agent,
            Duration::from_millis(100),
        )
        .await
        .expect("agent starts");
        assert!(negotiated.supports_session_steer());
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let admission = connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["initial".into()]),
                "run-7".to_string(),
                "turn-7".to_string(),
            )
            .await
            .expect("prompt admitted");
        let prompt = vec![
            ContentBlock::from("preserve this guidance"),
            ContentBlock::Image(agent_client_protocol::schema::v1::ImageContent::new(
                "aGVsbG8=",
                "image/png",
            )),
            ContentBlock::ResourceLink(agent_client_protocol::schema::v1::ResourceLink::new(
                "source.rs",
                "/repo/source.rs",
            )),
        ];
        let unknown_session = connection
            .steer(
                SteerRequest {
                    session_id: SessionId::new("missing"),
                    expected_run_id: admission.run_id.clone(),
                    expected_source_turn_id: admission.source_turn_id.clone(),
                    prompt_generation: admission.generation,
                    prompt: prompt.clone(),
                },
                0,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            unknown_session,
            AcpRuntimeError::UnknownSession(_)
        ));
        let stale_run = connection
            .steer(
                SteerRequest {
                    session_id: created.session_id.clone(),
                    expected_run_id: "stale-run".to_string(),
                    expected_source_turn_id: admission.source_turn_id.clone(),
                    prompt_generation: admission.generation,
                    prompt: prompt.clone(),
                },
                0,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            stale_run,
            AcpRuntimeError::Unsupported("stale steer correlation")
        ));
        let stale_turn = connection
            .steer(
                SteerRequest {
                    session_id: created.session_id.clone(),
                    expected_run_id: admission.run_id.clone(),
                    expected_source_turn_id: "stale-turn".to_string(),
                    prompt_generation: admission.generation,
                    prompt: prompt.clone(),
                },
                0,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            stale_turn,
            AcpRuntimeError::Unsupported("stale steer correlation")
        ));
        let stale_generation = connection
            .steer(
                SteerRequest {
                    session_id: created.session_id.clone(),
                    expected_run_id: admission.run_id.clone(),
                    expected_source_turn_id: admission.source_turn_id.clone(),
                    prompt_generation: admission.generation + 1,
                    prompt: prompt.clone(),
                },
                0,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            stale_generation,
            AcpRuntimeError::Unsupported("stale steer correlation")
        ));
        connection
            .steer(
                SteerRequest {
                    session_id: created.session_id.clone(),
                    expected_run_id: admission.run_id.clone(),
                    expected_source_turn_id: admission.source_turn_id.clone(),
                    prompt_generation: admission.generation,
                    prompt: prompt.clone(),
                },
                0,
            )
            .await
            .expect("typed steer acknowledged");
        let observed = observed_rx.recv().await.expect("steer observed");
        assert_eq!(observed.session_id, created.session_id);
        assert_eq!(observed.expected_run_id, "run-7");
        assert_eq!(observed.expected_source_turn_id, "turn-7");
        assert_eq!(observed.prompt_generation, admission.generation);
        assert_eq!(observed.prompt, prompt);
        let rejected = connection
            .steer(
                SteerRequest {
                    session_id: created.session_id.clone(),
                    expected_run_id: admission.run_id.clone(),
                    expected_source_turn_id: admission.source_turn_id.clone(),
                    prompt_generation: admission.generation,
                    prompt: vec![ContentBlock::from("reject")],
                },
                0,
            )
            .await
            .expect_err("false acknowledgment must fail");
        assert!(matches!(
            rejected,
            AcpRuntimeError::Unsupported("steer was not accepted")
        ));
        let rejected_request = observed_rx.recv().await.expect("rejected steer observed");
        assert_eq!(rejected_request.expected_run_id, admission.run_id);
        assert_eq!(
            rejected_request.expected_source_turn_id,
            admission.source_turn_id
        );
        assert_eq!(rejected_request.prompt_generation, admission.generation);
        let timed_out = connection
            .steer(
                SteerRequest {
                    session_id: created.session_id.clone(),
                    expected_run_id: admission.run_id.clone(),
                    expected_source_turn_id: admission.source_turn_id.clone(),
                    prompt_generation: admission.generation,
                    prompt: vec![ContentBlock::from("timeout")],
                },
                0,
            )
            .await
            .expect_err("unacknowledged steer must time out");
        assert!(matches!(timed_out, AcpRuntimeError::RequestTimeout));
        let timed_out_request = observed_rx.recv().await.expect("timed out steer observed");
        assert_eq!(timed_out_request.expected_run_id, admission.run_id);
        drop(
            timed_out_steer_responder
                .lock()
                .expect("steer responder lock")
                .take(),
        );
        if let Some(responder) = prompt_responder.lock().expect("prompt lock").take() {
            responder
                .respond(PromptResponse::new(StopReason::EndTurn))
                .expect("prompt response");
        }
        connection.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn permission_requires_an_exact_advertised_option_without_consuming_on_error() {
        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            false,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        let pending = fixture.connection.pending_permissions().await;
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].thread_id,
            "v1.dGVzdC1hZ2VudA.aW50ZXJhY3Rpb24tc2Vzc2lvbg"
        );
        assert_eq!(pending[0].tool_call_id, "tool-1");
        assert_eq!(pending[0].title, "Write file");
        assert_eq!(pending[0].kind, ToolKind::Edit);
        assert_eq!(pending[0].status, ToolCallStatus::Pending);
        assert_eq!(pending[0].options[0].id, "allow-once");
        assert!(matches!(
            fixture
                .connection
                .resolve_permission("wrong-thread", &pending[0].request_id, "allow-once")
                .await,
            Err(AcpRuntimeError::Interaction(InteractionError::WrongOwner(
                _
            )))
        ));
        assert_eq!(fixture.connection.pending_permissions().await.len(), 1);
        assert!(matches!(
            fixture
                .connection
                .cancel_permission("wrong-thread", &pending[0].request_id)
                .await,
            Err(AcpRuntimeError::Interaction(InteractionError::WrongOwner(
                _
            )))
        ));
        assert!(matches!(
            fixture
                .connection
                .resolve_permission(&pending[0].thread_id, &pending[0].request_id, "allow")
                .await,
            Err(AcpRuntimeError::Interaction(
                InteractionError::InvalidPermissionOption(_)
            ))
        ));
        assert_eq!(fixture.connection.pending_permissions().await.len(), 1);
        fixture
            .connection
            .resolve_permission(&pending[0].thread_id, &pending[0].request_id, "allow-once")
            .await
            .expect("exact option resolves");
        let ObservedInteraction::Permission(result) = fixture.observed.recv().await.unwrap() else {
            panic!("permission response expected");
        };
        assert_eq!(
            result.expect("typed permission response").outcome,
            RequestPermissionOutcome::Selected(
                agent_client_protocol::schema::v1::SelectedPermissionOutcome::new("allow-once")
            )
        );
        assert!(matches!(
            resolved_event(&mut fixture.events, true).await,
            CanonicalEvent::PermissionResolved { request_id, .. } if request_id == pending[0].request_id
        ));
        assert!(fixture.events.try_recv().is_err());
        assert!(matches!(
            fixture
                .connection
                .cancel_permission(&pending[0].thread_id, &pending[0].request_id)
                .await,
            Err(AcpRuntimeError::Interaction(
                InteractionError::UnknownRequest(_)
            ))
        ));
        let (generation, errors) = fixture
            .connection
            .interactions
            .cancel_session(&SessionId::new("empty-session"))
            .await;
        assert_eq!(generation, None);
        assert!(errors.is_empty());
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn no_approval_policy_allows_permission_requests_without_queueing_them() {
        let mut fixture = start_pending_interaction_for_agent_with_policy(
            "test-agent",
            TestInteraction::Permission(
                permission_request(vec![
                    PermissionOption::new(
                        "allow-once",
                        "Allow once",
                        PermissionOptionKind::AllowOnce,
                    ),
                    PermissionOption::new(
                        "allow-always",
                        "Always allow",
                        PermissionOptionKind::AllowAlways,
                    ),
                ]),
                false,
            ),
            ApprovalPolicy::Never,
        )
        .await;

        let observed = tokio::time::timeout(Duration::from_secs(1), fixture.observed.recv())
            .await
            .expect("permission response arrived")
            .expect("permission response channel stayed open");
        let ObservedInteraction::Permission(result) = observed else {
            panic!("permission response expected");
        };
        assert_eq!(
            result.expect("typed permission response").outcome,
            RequestPermissionOutcome::Selected(
                agent_client_protocol::schema::v1::SelectedPermissionOutcome::new("allow-once")
            )
        );
        assert!(fixture.connection.pending_permissions().await.is_empty());
        while let Ok(event) = fixture.events.try_recv() {
            assert!(!matches!(event, CanonicalEvent::PermissionRequested { .. }));
        }
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn selective_approval_policy_allows_reads_but_queues_edits_and_mode_switches() {
        let mut read = start_pending_interaction_for_agent_with_policy(
            "test-agent",
            TestInteraction::Permission(
                permission_request_with_kind(permission_options(), ToolKind::Read),
                false,
            ),
            ApprovalPolicy::OnRequest,
        )
        .await;
        let observed = tokio::time::timeout(Duration::from_secs(1), read.observed.recv())
            .await
            .expect("read permission response arrived")
            .expect("read permission response channel stayed open");
        let ObservedInteraction::Permission(result) = observed else {
            panic!("permission response expected");
        };
        assert_eq!(
            result.expect("typed permission response").outcome,
            RequestPermissionOutcome::Selected(
                agent_client_protocol::schema::v1::SelectedPermissionOutcome::new("allow-once")
            )
        );
        assert!(read.connection.pending_permissions().await.is_empty());
        while let Ok(event) = read.events.try_recv() {
            assert!(!matches!(event, CanonicalEvent::PermissionRequested { .. }));
        }
        finish_fixture(&read).await;

        let mut edit = start_pending_interaction_for_agent_with_policy(
            "test-agent",
            TestInteraction::Permission(permission_request(permission_options()), false),
            ApprovalPolicy::OnRequest,
        )
        .await;
        requested_event(&mut edit.events, true).await;
        let pending = edit.connection.pending_permissions().await;
        assert_eq!(pending.len(), 1);
        edit.connection
            .cancel_permission(&pending[0].thread_id, &pending[0].request_id)
            .await
            .expect("edit permission cancelled");
        finish_fixture(&edit).await;

        let mut mode_switch = start_pending_interaction_for_agent_with_policy(
            "test-agent",
            TestInteraction::Permission(
                permission_request_with_kind(permission_options(), ToolKind::SwitchMode),
                false,
            ),
            ApprovalPolicy::OnRequest,
        )
        .await;
        requested_event(&mut mode_switch.events, true).await;
        let pending = mode_switch.connection.pending_permissions().await;
        assert_eq!(pending.len(), 1);
        mode_switch
            .connection
            .cancel_permission(&pending[0].thread_id, &pending[0].request_id)
            .await
            .expect("mode switch permission cancelled");
        finish_fixture(&mode_switch).await;
    }

    #[tokio::test]
    async fn enabling_no_approval_policy_resolves_an_already_pending_request() {
        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            false,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        assert_eq!(fixture.connection.pending_permissions().await.len(), 1);

        fixture
            .connection
            .set_approval_policy(&fixture.session_id, ApprovalPolicy::Never)
            .await
            .expect("permission policy applied");

        let observed = tokio::time::timeout(Duration::from_secs(1), fixture.observed.recv())
            .await
            .expect("permission response arrived")
            .expect("permission response channel stayed open");
        let ObservedInteraction::Permission(result) = observed else {
            panic!("permission response expected");
        };
        assert_eq!(
            result.expect("typed permission response").outcome,
            RequestPermissionOutcome::Selected(
                agent_client_protocol::schema::v1::SelectedPermissionOutcome::new("allow-once")
            )
        );
        assert!(fixture.connection.pending_permissions().await.is_empty());
        assert!(matches!(
            resolved_event(&mut fixture.events, true).await,
            CanonicalEvent::PermissionResolved { outcome, .. } if outcome == "allow-once"
        ));
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn policy_drain_cannot_publish_resolution_before_the_request() {
        let (observed_tx, observed) = mpsc::unbounded_channel();
        let prompt_responder = Arc::new(StdMutex::new(None));
        let agent = interaction_agent(
            TestInteraction::Permission(permission_request(permission_options()), false),
            observed_tx,
            prompt_responder.clone(),
        );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("interaction agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let session = connection
            .session(&created.session_id)
            .await
            .expect("session registered");
        let events = session.take_events().await.expect("session event receiver");
        let barrier = connection
            .interactions
            .pause_next_permission_publication()
            .await;
        connection
            .prompt_with_policy(
                PromptRequest::new(created.session_id.clone(), vec!["interact".into()]),
                "interaction-run".to_string(),
                "interaction-turn".to_string(),
                ApprovalPolicy::Untrusted,
            )
            .await
            .expect("prompt admitted");
        barrier.wait_until_reached().await;
        let interaction_guard =
            tokio::time::timeout(Duration::from_millis(100), session.lock_interactions())
                .await
                .expect("request publication must not hold the session interaction lock");
        drop(interaction_guard);

        let update = {
            let connection = connection.clone();
            let session_id = created.session_id.clone();
            tokio::spawn(async move {
                connection
                    .set_approval_policy(&session_id, ApprovalPolicy::Never)
                    .await
            })
        };
        tokio::task::yield_now().await;
        barrier.release();
        update
            .await
            .expect("policy update task")
            .expect("policy update succeeds");

        let mut fixture = PendingInteractionFixture {
            connection,
            events,
            session_id: created.session_id,
            observed,
            prompt_responder,
        };
        requested_event(&mut fixture.events, true).await;
        assert!(matches!(
            resolved_event(&mut fixture.events, true).await,
            CanonicalEvent::PermissionResolved { .. }
        ));
        while let Ok(event) = fixture.events.try_recv() {
            assert!(!matches!(event, CanonicalEvent::PermissionRequested { .. }));
        }
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn manual_permission_cancellation_waits_for_request_publication() {
        let (observed_tx, mut observed) = mpsc::unbounded_channel();
        let prompt_responder = Arc::new(StdMutex::new(None));
        let agent = interaction_agent(
            TestInteraction::Permission(permission_request(permission_options()), false),
            observed_tx,
            prompt_responder.clone(),
        );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("interaction agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let session = connection
            .session(&created.session_id)
            .await
            .expect("session registered");
        let mut events = session.take_events().await.expect("session event receiver");
        let barrier = connection
            .interactions
            .pause_next_permission_publication()
            .await;
        connection
            .prompt_with_policy(
                PromptRequest::new(created.session_id.clone(), vec!["interact".into()]),
                "interaction-run".to_string(),
                "interaction-turn".to_string(),
                ApprovalPolicy::Untrusted,
            )
            .await
            .expect("prompt admitted");
        barrier.wait_until_reached().await;
        let pending = connection.pending_permissions().await;
        let request = pending.first().expect("permission is listable").clone();
        let cancellation = {
            let connection = connection.clone();
            let thread_id = request.thread_id.clone();
            let request_id = request.request_id.clone();
            tokio::spawn(async move { connection.cancel_permission(&thread_id, &request_id).await })
        };
        tokio::task::yield_now().await;
        assert!(!cancellation.is_finished());
        assert!(observed.try_recv().is_err());

        barrier.release();
        cancellation
            .await
            .expect("cancellation task")
            .expect("cancellation succeeds");
        requested_event(&mut events, true).await;
        assert!(matches!(
            resolved_event(&mut events, true).await,
            CanonicalEvent::PermissionResolved { request_id, .. }
                if request_id == request.request_id
        ));
        assert!(matches!(
            observed.recv().await,
            Some(ObservedInteraction::Permission(Ok(response)))
                if response.outcome == RequestPermissionOutcome::Cancelled
        ));

        let fixture = PendingInteractionFixture {
            connection,
            events,
            session_id: created.session_id,
            observed,
            prompt_responder,
        };
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn family_policy_update_commits_after_one_stale_responder_failure() {
        let next_session = Arc::new(AtomicUsize::new(0));
        let prompt_responders = Arc::new(StdMutex::new(Vec::new()));
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let next_session = next_session.clone();
                    async move |_request: NewSessionRequest, responder, _| {
                        let index = next_session.fetch_add(1, AtomicOrdering::Relaxed);
                        responder.respond(NewSessionResponse::new(format!("family-{index}")))
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responders = prompt_responders.clone();
                    async move |request: PromptRequest, responder, connection| {
                        prompt_responders
                            .lock()
                            .expect("prompt responders")
                            .push(responder);
                        let session_id = request.session_id.clone();
                        connection
                            .send_request(RequestPermissionRequest::new(
                                session_id.clone(),
                                ToolCallUpdate::new(
                                    format!("tool-{session_id}"),
                                    ToolCallUpdateFields::new()
                                        .title("Write file")
                                        .kind(ToolKind::Edit)
                                        .status(ToolCallStatus::Pending),
                                ),
                                permission_options(),
                            ))
                            .on_receiving_result({
                                let observed_tx = observed_tx.clone();
                                async move |result| {
                                    let _ = observed_tx.send((
                                        session_id.to_string(),
                                        result.map_err(|error| error.to_string()),
                                    ));
                                    Ok(())
                                }
                            })?;
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("family agent starts");
        let first = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .unwrap()
            .session_id;
        let second = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .unwrap()
            .session_id;
        let mut first_events = connection
            .session(&first)
            .await
            .unwrap()
            .take_events()
            .await
            .unwrap();
        let mut second_events = connection
            .session(&second)
            .await
            .unwrap()
            .take_events()
            .await
            .unwrap();
        connection
            .prompt_with_policy(
                PromptRequest::new(first.clone(), vec!["first".into()]),
                "first-run".to_string(),
                "first-turn".to_string(),
                ApprovalPolicy::Untrusted,
            )
            .await
            .unwrap();
        connection
            .prompt_with_policy(
                PromptRequest::new(second.clone(), vec!["second".into()]),
                "second-run".to_string(),
                "second-turn".to_string(),
                ApprovalPolicy::Untrusted,
            )
            .await
            .unwrap();
        requested_event(&mut first_events, true).await;
        requested_event(&mut second_events, true).await;
        connection
            .interactions
            .inject_cancel_response_failures(&first, true, false)
            .await;

        connection
            .set_approval_policies(&[first.clone(), second.clone()], ApprovalPolicy::Never)
            .await
            .expect("stale responder does not reject the committed policy update");
        assert!(connection.pending_permissions().await.is_empty());
        assert_eq!(
            connection.approval_policy(&first).await,
            ApprovalPolicy::Never
        );
        assert_eq!(
            connection.approval_policy(&second).await,
            ApprovalPolicy::Never
        );
        let mut second_allowed = false;
        for _ in 0..2 {
            let Ok(Some((session_id, result))) =
                tokio::time::timeout(Duration::from_secs(1), observed_rx.recv()).await
            else {
                break;
            };
            if session_id == second.to_string() {
                second_allowed = matches!(
                    result.map(|response| response.outcome),
                    Ok(RequestPermissionOutcome::Selected(_))
                );
                break;
            }
        }
        assert!(second_allowed);
        for responder in prompt_responders
            .lock()
            .expect("prompt responders")
            .drain(..)
        {
            responder
                .respond(PromptResponse::new(StopReason::EndTurn))
                .unwrap();
        }
        connection.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn rejected_busy_turn_does_not_apply_or_drain_its_approval_policy() {
        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            false,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        let pending = fixture.connection.pending_permissions().await;
        assert_eq!(pending.len(), 1);

        assert!(matches!(
            fixture
                .connection
                .prompt_with_policy(
                    PromptRequest::new(fixture.session_id.clone(), vec!["second".into()]),
                    "second-run".to_string(),
                    "second-turn".to_string(),
                    ApprovalPolicy::Never,
                )
                .await,
            Err(AcpRuntimeError::SessionBusy)
        ));
        assert_eq!(fixture.connection.pending_permissions().await.len(), 1);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), fixture.observed.recv())
                .await
                .is_err()
        );

        fixture
            .connection
            .cancel_permission(&pending[0].thread_id, &pending[0].request_id)
            .await
            .expect("original permission cancelled");
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn no_approval_policy_cancels_a_request_without_an_allow_option() {
        let mut fixture = start_pending_interaction_for_agent_with_policy(
            "test-agent",
            TestInteraction::Permission(
                permission_request(vec![PermissionOption::new(
                    "reject-once",
                    "Reject",
                    PermissionOptionKind::RejectOnce,
                )]),
                false,
            ),
            ApprovalPolicy::Never,
        )
        .await;

        let observed = tokio::time::timeout(Duration::from_secs(1), fixture.observed.recv())
            .await
            .expect("permission response arrived")
            .expect("permission response channel stayed open");
        let ObservedInteraction::Permission(result) = observed else {
            panic!("permission response expected");
        };
        assert_eq!(
            result.expect("typed permission response").outcome,
            RequestPermissionOutcome::Cancelled
        );
        assert!(fixture.connection.pending_permissions().await.is_empty());
        while let Ok(event) = fixture.events.try_recv() {
            assert!(!matches!(event, CanonicalEvent::PermissionRequested { .. }));
        }
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn permission_response_does_not_wait_for_resolved_event_backpressure() {
        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            false,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        let pending = fixture.connection.pending_permissions().await;
        let request = pending.first().expect("pending permission");
        let session = fixture
            .connection
            .session(&fixture.session_id)
            .await
            .expect("interaction session");

        for index in 0..256 {
            session
                .emit(CanonicalEvent::Ignored {
                    agent_id: "test-agent".to_string(),
                    thread_id: Some(request.thread_id.clone()),
                    kind: format!("approval-backpressure-{index}"),
                })
                .await;
        }

        let mut resolution = {
            let connection = fixture.connection.clone();
            let thread_id = request.thread_id.clone();
            let request_id = request.request_id.clone();
            tokio::spawn(async move {
                connection
                    .resolve_permission(&thread_id, &request_id, "allow-once")
                    .await
            })
        };

        let ObservedInteraction::Permission(response) =
            tokio::time::timeout(Duration::from_secs(1), fixture.observed.recv())
                .await
                .expect("ACP permission response should not wait for event delivery")
                .expect("permission response")
        else {
            panic!("permission response expected");
        };
        assert_eq!(
            response.expect("typed permission response").outcome,
            RequestPermissionOutcome::Selected(
                agent_client_protocol::schema::v1::SelectedPermissionOutcome::new("allow-once")
            )
        );
        tokio::time::timeout(Duration::from_millis(100), &mut resolution)
            .await
            .expect("approval resolution should finish while its event is backpressured")
            .expect("resolution task")
            .expect("approval resolves");
        assert!(fixture.connection.pending_permissions().await.is_empty());

        assert!(matches!(
            resolved_event(&mut fixture.events, true).await,
            CanonicalEvent::PermissionResolved { request_id, .. }
                if request_id == request.request_id
        ));
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn simultaneous_two_agent_interactions_are_unique_and_never_cross_route() {
        let mut alpha_permission = start_pending_interaction_for_agent(
            "alpha-agent",
            TestInteraction::Permission(permission_request(permission_options()), false),
        )
        .await;
        let mut beta_permission = start_pending_interaction_for_agent(
            "beta-agent",
            TestInteraction::Permission(permission_request(permission_options()), false),
        )
        .await;
        requested_event(&mut alpha_permission.events, true).await;
        requested_event(&mut beta_permission.events, true).await;
        let alpha_pending = alpha_permission.connection.pending_permissions().await;
        let beta_pending = beta_permission.connection.pending_permissions().await;
        assert_ne!(alpha_pending[0].request_id, beta_pending[0].request_id);
        assert_ne!(alpha_pending[0].agent_id, beta_pending[0].agent_id);
        alpha_permission
            .connection
            .cancel_permission(&alpha_pending[0].thread_id, &beta_pending[0].request_id)
            .await
            .expect_err("beta permission is not routable through alpha");
        beta_permission
            .connection
            .cancel_permission(&beta_pending[0].thread_id, &alpha_pending[0].request_id)
            .await
            .expect_err("alpha permission is not routable through beta");
        alpha_permission
            .connection
            .cancel_permission(&alpha_pending[0].thread_id, &alpha_pending[0].request_id)
            .await
            .expect("alpha permission resolves");
        beta_permission
            .connection
            .cancel_permission(&beta_pending[0].thread_id, &beta_pending[0].request_id)
            .await
            .expect("beta permission resolves");
        alpha_permission
            .observed
            .recv()
            .await
            .expect("alpha permission response");
        beta_permission
            .observed
            .recv()
            .await
            .expect("beta permission response");
        finish_fixture(&alpha_permission).await;
        finish_fixture(&beta_permission).await;

        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(
                ElicitationSessionScope::new("interaction-session"),
                ElicitationSchema::new().string("value", true),
            ),
            "Value",
        );
        let mut alpha_elicitation = start_pending_interaction_for_agent(
            "alpha-agent",
            TestInteraction::Elicitation(request.clone(), false),
        )
        .await;
        let mut beta_elicitation = start_pending_interaction_for_agent(
            "beta-agent",
            TestInteraction::Elicitation(request, false),
        )
        .await;
        requested_event(&mut alpha_elicitation.events, false).await;
        requested_event(&mut beta_elicitation.events, false).await;
        let alpha_pending = alpha_elicitation.connection.pending_elicitations().await;
        let beta_pending = beta_elicitation.connection.pending_elicitations().await;
        assert_ne!(alpha_pending[0].request_id, beta_pending[0].request_id);
        assert_ne!(alpha_pending[0].agent_id, beta_pending[0].agent_id);
        alpha_elicitation
            .connection
            .cancel_elicitation(&alpha_pending[0].thread_id, &beta_pending[0].request_id)
            .await
            .expect_err("beta elicitation is not routable through alpha");
        beta_elicitation
            .connection
            .cancel_elicitation(&beta_pending[0].thread_id, &alpha_pending[0].request_id)
            .await
            .expect_err("alpha elicitation is not routable through beta");
        alpha_elicitation
            .connection
            .cancel_elicitation(&alpha_pending[0].thread_id, &alpha_pending[0].request_id)
            .await
            .expect("alpha elicitation resolves");
        beta_elicitation
            .connection
            .cancel_elicitation(&beta_pending[0].thread_id, &beta_pending[0].request_id)
            .await
            .expect("beta elicitation resolves");
        alpha_elicitation
            .observed
            .recv()
            .await
            .expect("alpha elicitation response");
        beta_elicitation
            .observed
            .recv()
            .await
            .expect("beta elicitation response");
        finish_fixture(&alpha_elicitation).await;
        finish_fixture(&beta_elicitation).await;
    }

    #[tokio::test]
    async fn permission_can_be_cancelled_by_client_or_request_cancellation_race() {
        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            false,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        let pending = fixture.connection.pending_permissions().await;
        let request_id = pending[0].request_id.clone();
        fixture
            .connection
            .cancel_permission(&pending[0].thread_id, &request_id)
            .await
            .expect("permission cancelled");
        let ObservedInteraction::Permission(result) = fixture.observed.recv().await.unwrap() else {
            panic!("permission response expected");
        };
        assert_eq!(
            result.expect("typed cancellation").outcome,
            RequestPermissionOutcome::Cancelled
        );
        assert!(matches!(
            resolved_event(&mut fixture.events, true).await,
            CanonicalEvent::PermissionResolved { request_id: resolved, .. } if resolved == request_id
        ));
        assert!(fixture.events.try_recv().is_err());
        finish_fixture(&fixture).await;

        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            false,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        let pending = fixture.connection.pending_permissions().await;
        fixture
            .connection
            .sessions
            .remove(&fixture.session_id)
            .await;
        fixture
            .connection
            .cancel_permission(&pending[0].thread_id, &pending[0].request_id)
            .await
            .expect("permission resolves after session removal");
        fixture.observed.recv().await.expect("permission response");
        assert!(fixture.connection.pending_permissions().await.is_empty());
        finish_fixture(&fixture).await;

        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            true,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        let ObservedInteraction::Permission(result) = fixture.observed.recv().await.unwrap() else {
            panic!("permission response expected");
        };
        assert_eq!(
            result.expect("watcher returns typed cancellation").outcome,
            RequestPermissionOutcome::Cancelled
        );
        assert!(fixture.connection.pending_permissions().await.is_empty());
        assert!(matches!(
            resolved_event(&mut fixture.events, true).await,
            CanonicalEvent::PermissionResolved { .. }
        ));
        assert!(fixture.events.try_recv().is_err());
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn absent_and_request_scoped_interactions_cancel_without_pending_leaks() {
        let mut missing_permission = permission_request(permission_options());
        missing_permission.session_id = "missing-session".into();
        let mut fixture =
            start_pending_interaction(TestInteraction::Permission(missing_permission, false)).await;
        let ObservedInteraction::Permission(result) = fixture.observed.recv().await.unwrap() else {
            panic!("permission response expected");
        };
        assert_eq!(result.unwrap().outcome, RequestPermissionOutcome::Cancelled);
        assert!(fixture.connection.pending_permissions().await.is_empty());
        finish_fixture(&fixture).await;

        let missing_elicitation = CreateElicitationRequest::new(
            ElicitationFormMode::new(
                ElicitationSessionScope::new("missing-session"),
                ElicitationSchema::new().string("value", true),
            ),
            "Missing",
        );
        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(missing_elicitation, false))
                .await;
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        assert!(matches!(result.unwrap().action, ElicitationAction::Cancel));
        assert!(fixture.connection.pending_elicitations().await.is_empty());
        finish_fixture(&fixture).await;

        let request_scoped = CreateElicitationRequest::new(
            ElicitationFormMode::new(
                ElicitationRequestScope::new(42),
                ElicitationSchema::new().string("value", true),
            ),
            "Request value",
        );
        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request_scoped, false)).await;
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        assert!(matches!(result.unwrap().action, ElicitationAction::Cancel));
        assert!(fixture.connection.pending_elicitations().await.is_empty());
        while let Ok(event) = fixture.events.try_recv() {
            assert!(!matches!(
                event,
                CanonicalEvent::ElicitationRequested { .. }
            ));
        }
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn form_elicitation_accepts_all_typed_values_and_redacts_secret_defaults() {
        let secret = StringPropertySchema::new()
            .title("API token")
            .default_value("must-not-leak");
        let schema = ElicitationSchema::new()
            .property("name", StringPropertySchema::new().min_length(2), true)
            .property(
                "count",
                IntegerPropertySchema::new().minimum(1).maximum(5),
                true,
            )
            .property(
                "ratio",
                NumberPropertySchema::new().minimum(0.0).maximum(1.0),
                true,
            )
            .property("enabled", BooleanPropertySchema::new(), true)
            .property(
                "tags",
                MultiSelectPropertySchema::new(vec!["one".to_string(), "two".to_string()]),
                true,
            )
            .property("token", secret, false);
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(ElicitationSessionScope::new("interaction-session"), schema),
            "Provide values",
        );
        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request, false)).await;
        requested_event(&mut fixture.events, false).await;
        let pending = fixture.connection.pending_elicitations().await;
        assert_eq!(pending.len(), 1);
        let token = pending[0]
            .fields
            .iter()
            .find(|field| field.name == "token")
            .unwrap();
        assert!(token.sensitive);
        assert_eq!(token.default, None);
        let values = BTreeMap::from([
            (
                "name".to_string(),
                ElicitationContentValue::String("Ada".to_string()),
            ),
            ("count".to_string(), ElicitationContentValue::Integer(3)),
            ("ratio".to_string(), ElicitationContentValue::Number(0.5)),
            (
                "enabled".to_string(),
                ElicitationContentValue::Boolean(true),
            ),
            (
                "tags".to_string(),
                ElicitationContentValue::StringArray(vec!["one".to_string()]),
            ),
            (
                "token".to_string(),
                ElicitationContentValue::String("entered-secret".to_string()),
            ),
        ]);
        fixture
            .connection
            .accept_elicitation(&pending[0].thread_id, &pending[0].request_id, values)
            .await
            .expect("typed values accepted");
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        let ElicitationAction::Accept(action) = result.expect("typed elicitation").action else {
            panic!("accept action expected");
        };
        assert_eq!(action.content.unwrap().len(), 6);
        assert!(fixture.connection.pending_elicitations().await.is_empty());
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn elicitation_validation_failure_preserves_responder_then_declines() {
        let schema = ElicitationSchema::new().property(
            "count",
            IntegerPropertySchema::new().minimum(1).maximum(2),
            true,
        );
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(ElicitationSessionScope::new("interaction-session"), schema),
            "Count",
        );
        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request, false)).await;
        requested_event(&mut fixture.events, false).await;
        let pending = fixture.connection.pending_elicitations().await;
        let request_id = pending[0].request_id.clone();
        let thread_id = pending[0].thread_id.clone();
        assert!(matches!(
            fixture
                .connection
                .accept_elicitation("wrong-thread", &request_id, BTreeMap::new())
                .await,
            Err(AcpRuntimeError::Interaction(InteractionError::WrongOwner(
                _
            )))
        ));
        assert!(matches!(
            fixture
                .connection
                .decline_elicitation("wrong-thread", &request_id)
                .await,
            Err(AcpRuntimeError::Interaction(InteractionError::WrongOwner(
                _
            )))
        ));
        assert!(matches!(
            fixture
                .connection
                .cancel_elicitation("wrong-thread", &request_id)
                .await,
            Err(AcpRuntimeError::Interaction(InteractionError::WrongOwner(
                _
            )))
        ));
        assert!(matches!(
            fixture
                .connection
                .accept_elicitation(
                    &thread_id,
                    &request_id,
                    BTreeMap::from([(
                        "count".to_string(),
                        ElicitationContentValue::String("wrong".to_string())
                    )]),
                )
                .await,
            Err(AcpRuntimeError::Interaction(
                InteractionError::InvalidElicitation(_)
            ))
        ));
        assert_eq!(fixture.connection.pending_elicitations().await.len(), 1);
        fixture
            .connection
            .decline_elicitation(&thread_id, &request_id)
            .await
            .expect("decline succeeds");
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        assert!(matches!(
            result.expect("typed decline").action,
            ElicitationAction::Decline
        ));
        assert!(matches!(
            fixture
                .connection
                .cancel_elicitation(&thread_id, &request_id)
                .await,
            Err(AcpRuntimeError::Interaction(
                InteractionError::UnknownRequest(_)
            ))
        ));
        fixture
            .connection
            .decline_elicitation(&thread_id, &request_id)
            .await
            .expect_err("removed elicitation stays unknown");
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn semantic_session_cancel_responds_before_cancel_notification() {
        const WAIT: Duration = Duration::from_secs(5);
        let (order_tx, mut order_rx) = mpsc::unbounded_channel::<&'static str>();
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("ordered-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let order_tx = order_tx.clone();
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, connection| {
                        *prompt_responder.lock().expect("prompt lock") = Some(responder);
                        let mut request = permission_request(permission_options());
                        request.session_id = "ordered-session".into();
                        connection.send_request(request).on_receiving_result({
                            let response_order = order_tx.clone();
                            async move |result| {
                                assert_eq!(result?.outcome, RequestPermissionOutcome::Cancelled);
                                let _ = response_order.send("permission");
                                Ok(())
                            }
                        })?;
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_notification(
                async move |request: CancelNotification, connection| {
                    let _ = order_tx.send("cancel");
                    connection.send_notification(SessionNotification::new(
                        request.session_id,
                        update(serde_json::json!({
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "late"},
                            "messageId": "late-cancelled-generation"
                        })),
                    ))?;
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let session = connection.session(&created.session_id).await.unwrap();
        let mut events = session.take_events().await.expect("session event receiver");
        assert!(matches!(
            connection
                .cancel_turn("missing-session".into(), "ordered-turn")
                .await,
            Err(AcpRuntimeError::UnknownSession(_))
        ));
        connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["cancel".into()]),
                "ordered-run".to_string(),
                "ordered-turn".to_string(),
            )
            .await
            .expect("prompt admitted");
        tokio::time::timeout(WAIT, requested_event(&mut events, true))
            .await
            .expect("permission request event timed out");
        assert!(matches!(
            connection
                .cancel_turn(created.session_id.clone(), "completed-turn")
                .await,
            Err(AcpRuntimeError::Unsupported(
                "stale turn interrupt correlation"
            ))
        ));
        assert_eq!(
            session.operation().await,
            Some(("ordered-run".into(), "ordered-turn".into(), 1))
        );
        assert!(order_rx.try_recv().is_err());
        tokio::time::timeout(
            WAIT,
            connection.cancel_turn(created.session_id.clone(), "ordered-turn"),
        )
        .await
        .expect("matching turn cancellation timed out")
        .expect("matching turn cancels");
        assert_eq!(
            tokio::time::timeout(WAIT, order_rx.recv())
                .await
                .expect("permission response ordering timed out"),
            Some("permission")
        );
        assert_eq!(
            tokio::time::timeout(WAIT, order_rx.recv())
                .await
                .expect("cancel notification ordering timed out"),
            Some("cancel")
        );
        assert!(matches!(
            connection
                .prompt(
                    PromptRequest::new(created.session_id.clone(), vec!["blocked".into()]),
                    "blocked-run".into(),
                    "blocked-turn".into(),
                )
                .await,
            Err(AcpRuntimeError::SessionBusy)
        ));
        tokio::time::timeout(WAIT, async {
            loop {
                let snapshot = session.snapshot().await;
                if snapshot
                    .messages
                    .iter()
                    .any(|message| message.id == "late-cancelled-generation::agent")
                {
                    assert_eq!(snapshot.active_generation, Some(1));
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("late cancellation notification timed out");
        if let Some(responder) = prompt_responder.lock().expect("prompt lock").take() {
            responder
                .respond(PromptResponse::new(StopReason::Cancelled))
                .expect("prompt response");
        }
        tokio::time::timeout(WAIT, async {
            loop {
                if session.snapshot().await.active_generation.is_none() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled prompt did not terminalize");
        assert!(matches!(
            connection
                .cancel_turn(created.session_id.clone(), "ordered-turn")
                .await,
            Err(AcpRuntimeError::Unsupported(
                "stale turn interrupt correlation"
            ))
        ));
        let next = tokio::time::timeout(
            WAIT,
            connection.prompt(
                PromptRequest::new(created.session_id, vec!["next".into()]),
                "next-run".into(),
                "next-turn".into(),
            ),
        )
        .await
        .expect("next prompt admission timed out")
        .expect("next prompt admitted after matching terminal callback");
        assert_eq!(next.generation, 2);
        tokio::time::timeout(WAIT, connection.shutdown())
            .await
            .expect("shutdown timed out")
            .expect("shutdown");
    }

    #[tokio::test]
    async fn load_and_resume_reject_active_and_cancelling_without_snapshot_loss() {
        let reconstruction_calls = Arc::new(AtomicUsize::new(0));
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(
                        AgentCapabilities::new()
                            .load_session(true)
                            .session_capabilities(
                                SessionCapabilities::new().resume(SessionResumeCapabilities::new()),
                            ),
                    ))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let reconstruction_calls = reconstruction_calls.clone();
                    async move |_request: LoadSessionRequest, responder, _| {
                        reconstruction_calls.fetch_add(1, AtomicOrdering::SeqCst);
                        responder.respond(LoadSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let reconstruction_calls = reconstruction_calls.clone();
                    async move |_request: ResumeSessionRequest, responder, _| {
                        reconstruction_calls.fetch_add(1, AtomicOrdering::SeqCst);
                        responder.respond(ResumeSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, _| {
                        *prompt_responder.lock().expect("prompt lock") = Some(responder);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) = AcpConnection::start_transport(
            "restore-race-agent".into(),
            agent,
            Duration::from_secs(1),
        )
        .await
        .expect("agent starts");
        let session_id = SessionId::new("restore-race");
        let session = connection
            .ensure_session(session_id.clone())
            .await
            .expect("session capacity");
        connection
            .prompt(
                PromptRequest::new(session_id.clone(), vec!["active".into()]),
                "active-run".into(),
                "active-turn".into(),
            )
            .await
            .expect("prompt admitted first");
        let before = session.snapshot().await;
        for result in [
            connection
                .load_session(LoadSessionRequest::new(session_id.clone(), "/tmp"))
                .await,
            connection
                .resume_session(ResumeSessionRequest::new(session_id.clone(), "/tmp"))
                .await
                .map(|_| LoadSessionResponse::new()),
        ] {
            assert!(matches!(result, Err(AcpRuntimeError::SessionBusy)));
        }
        connection.cancel(session_id.clone()).await.unwrap();
        assert!(matches!(
            connection
                .load_session(LoadSessionRequest::new(session_id.clone(), "/tmp"))
                .await,
            Err(AcpRuntimeError::SessionBusy)
        ));
        assert!(matches!(
            connection
                .resume_session(ResumeSessionRequest::new(session_id.clone(), "/tmp"))
                .await,
            Err(AcpRuntimeError::SessionBusy)
        ));
        assert_eq!(reconstruction_calls.load(AtomicOrdering::SeqCst), 0);
        let after = session.snapshot().await;
        assert_eq!(after.active_run_id, before.active_run_id);
        assert_eq!(after.active_source_turn_id, before.active_source_turn_id);
        assert_eq!(after.active_generation, before.active_generation);
        assert_eq!(after.messages.len(), before.messages.len());
        prompt_responder
            .lock()
            .expect("prompt lock")
            .take()
            .unwrap()
            .respond(PromptResponse::new(StopReason::Cancelled))
            .unwrap();
        connection.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn restore_first_commit_and_rollback_release_waiting_prompt() {
        for commit in [true, false] {
            let (restore_seen_tx, restore_seen_rx) = oneshot::channel();
            let restore_seen_tx = Arc::new(StdMutex::new(Some(restore_seen_tx)));
            let (release_tx, release_rx) = oneshot::channel();
            let release_rx = Arc::new(StdMutex::new(Some(release_rx)));
            let agent = Agent
                .builder()
                .on_receive_request(
                    async |_request: InitializeRequest, responder, _| {
                        responder.respond(initialized(AgentCapabilities::new().load_session(true)))
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    {
                        let restore_seen_tx = restore_seen_tx.clone();
                        let release_rx = release_rx.clone();
                        async move |_request: LoadSessionRequest, responder, _| {
                            if let Some(sender) = restore_seen_tx.lock().unwrap().take() {
                                let _ = sender.send(());
                            }
                            let receiver = release_rx.lock().unwrap().take().unwrap();
                            let _ = receiver.await;
                            if commit {
                                responder.respond(LoadSessionResponse::new())
                            } else {
                                responder.respond_with_error(
                                    agent_client_protocol::Error::internal_error(),
                                )
                            }
                        }
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    async |_request: PromptRequest, responder, _| {
                        responder.respond(PromptResponse::new(StopReason::EndTurn))
                    },
                    agent_client_protocol::on_receive_request!(),
                );
            let (connection, _) = AcpConnection::start_transport(
                "restore-first-agent".into(),
                agent,
                Duration::from_secs(1),
            )
            .await
            .unwrap();
            let session_id = SessionId::new(if commit {
                "restore-commit"
            } else {
                "restore-rollback"
            });
            connection
                .ensure_session(session_id.clone())
                .await
                .expect("session capacity");
            let restore_connection = connection.clone();
            let restore_session_id = session_id.clone();
            let restore = tokio::spawn(async move {
                restore_connection
                    .load_session(LoadSessionRequest::new(restore_session_id, "/tmp"))
                    .await
            });
            restore_seen_rx.await.unwrap();
            let prompt_connection = connection.clone();
            let prompt_session_id = session_id.clone();
            let prompt = tokio::spawn(async move {
                prompt_connection
                    .prompt(
                        PromptRequest::new(prompt_session_id, vec!["after restore".into()]),
                        "post-restore-run".into(),
                        "post-restore-turn".into(),
                    )
                    .await
            });
            tokio::task::yield_now().await;
            assert!(!prompt.is_finished());
            release_tx.send(()).unwrap();
            assert_eq!(restore.await.unwrap().is_ok(), commit);
            assert_eq!(prompt.await.unwrap().unwrap().generation, 1);
            connection.shutdown().await.unwrap();
        }
    }

    #[tokio::test]
    async fn interactions_arriving_after_cancel_mark_are_typed_cancelled_without_pending_leaks() {
        let (outcomes_tx, mut outcomes_rx) = mpsc::unbounded_channel();
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("late-interaction-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, _| {
                        *prompt_responder.lock().expect("prompt lock") = Some(responder);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_notification(
                async move |_request: CancelNotification, connection| {
                    let mut permission = permission_request(permission_options());
                    permission.session_id = "late-interaction-session".into();
                    connection.send_request(permission).on_receiving_result({
                        let outcomes_tx = outcomes_tx.clone();
                        async move |result| {
                            let cancelled =
                                matches!(result?.outcome, RequestPermissionOutcome::Cancelled);
                            let _ = outcomes_tx.send(("permission", cancelled));
                            Ok(())
                        }
                    })?;
                    let elicitation = CreateElicitationRequest::new(
                        ElicitationFormMode::new(
                            ElicitationSessionScope::new("late-interaction-session"),
                            ElicitationSchema::new().string("value", true),
                        ),
                        "Value",
                    );
                    connection.send_request(elicitation).on_receiving_result({
                        let outcomes_tx = outcomes_tx.clone();
                        async move |result| {
                            let cancelled = matches!(result?.action, ElicitationAction::Cancel);
                            let _ = outcomes_tx.send(("elicitation", cancelled));
                            Ok(())
                        }
                    })?;
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["cancel".into()]),
                "late-run".into(),
                "late-turn".into(),
            )
            .await
            .expect("prompt admitted");
        connection
            .cancel(created.session_id)
            .await
            .expect("cancel completes");
        let mut outcomes = vec![
            outcomes_rx.recv().await.expect("first typed outcome"),
            outcomes_rx.recv().await.expect("second typed outcome"),
        ];
        outcomes.sort_unstable();
        assert_eq!(outcomes, vec![("elicitation", true), ("permission", true)]);
        assert!(connection.pending_permissions().await.is_empty());
        assert!(connection.pending_elicitations().await.is_empty());
        assert!(
            outcomes_rx.try_recv().is_err(),
            "each request resolves once"
        );
        if let Some(responder) = prompt_responder.lock().expect("prompt lock").take() {
            responder
                .respond(PromptResponse::new(StopReason::Cancelled))
                .expect("prompt response");
        }
        connection.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn cancel_send_failure_fails_old_generation_once_and_reopens_admission() {
        let session = AcpSession::new("agent".into(), "cancel-failure".into());
        let mut events = session.take_events().await.unwrap();
        session
            .admit_prompt("old-run".into(), "old-turn".into())
            .await
            .unwrap();
        let generation = session.mark_cancelling().await;
        let failure = Err(AcpRuntimeError::Connection("cancel send failed".into()));
        finish_cancel_attempt(Some(session.clone()), generation, &failure).await;
        finish_cancel_attempt(Some(session.clone()), generation, &failure).await;
        let mut failures = 0;
        while let Ok(event) = events.try_recv() {
            if let CanonicalEvent::RunFailed {
                run_id, generation, ..
            } = event
            {
                assert_eq!(run_id, "old-run");
                assert_eq!(generation, 1);
                failures += 1;
            }
        }
        assert_eq!(failures, 1);
        let admission = session
            .admit_prompt("new-run".into(), "new-turn".into())
            .await
            .expect("failure terminalization reopens admission");
        assert_eq!(admission.0, 2);
    }

    #[tokio::test]
    async fn cancel_atomically_drains_permission_and_elicitation_for_active_generation() {
        let (outcomes_tx, mut outcomes_rx) = mpsc::unbounded_channel();
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("combined-interaction-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, connection| {
                        *prompt_responder.lock().expect("prompt lock") = Some(responder);
                        let mut permission = permission_request(permission_options());
                        permission.session_id = "combined-interaction-session".into();
                        connection.send_request(permission).on_receiving_result({
                            let outcomes_tx = outcomes_tx.clone();
                            async move |result| {
                                let _ = outcomes_tx.send(matches!(
                                    result?.outcome,
                                    RequestPermissionOutcome::Cancelled
                                ));
                                Ok(())
                            }
                        })?;
                        let elicitation = CreateElicitationRequest::new(
                            ElicitationFormMode::new(
                                ElicitationSessionScope::new("combined-interaction-session"),
                                ElicitationSchema::new().string("value", true),
                            ),
                            "Value",
                        );
                        connection.send_request(elicitation).on_receiving_result({
                            let outcomes_tx = outcomes_tx.clone();
                            async move |result| {
                                let _ = outcomes_tx
                                    .send(matches!(result?.action, ElicitationAction::Cancel));
                                Ok(())
                            }
                        })?;
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["interact".into()]),
                "combined-run".into(),
                "combined-turn".into(),
            )
            .await
            .expect("prompt admitted");
        for _ in 0..100 {
            if connection.pending_permissions().await.len() == 1
                && connection.pending_elicitations().await.len() == 1
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(connection.pending_permissions().await.len(), 1);
        assert_eq!(connection.pending_elicitations().await.len(), 1);
        connection
            .cancel(created.session_id)
            .await
            .expect("cancel completes");
        assert!(outcomes_rx.recv().await.expect("first cancellation"));
        assert!(outcomes_rx.recv().await.expect("second cancellation"));
        assert!(connection.pending_permissions().await.is_empty());
        assert!(connection.pending_elicitations().await.is_empty());
        assert!(
            outcomes_rx.try_recv().is_err(),
            "each request resolves once"
        );
        if let Some(responder) = prompt_responder.lock().expect("prompt lock").take() {
            responder
                .respond(PromptResponse::new(StopReason::Cancelled))
                .expect("prompt response");
        }
        connection.shutdown().await.expect("shutdown");
    }

    async fn assert_cancel_response_failures_do_not_block_cancel(
        fail_permission: bool,
        fail_elicitation: bool,
        fail_cancel_send: bool,
    ) {
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let cancel_tx = Arc::new(StdMutex::new(Some(cancel_tx)));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("cancel-failure-matrix"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, connection| {
                        *prompt_responder.lock().expect("prompt responder") = Some(responder);
                        let mut permission = permission_request(permission_options());
                        permission.session_id = "cancel-failure-matrix".into();
                        connection.send_request(permission).detach();
                        connection
                            .send_request(CreateElicitationRequest::new(
                                ElicitationFormMode::new(
                                    ElicitationSessionScope::new("cancel-failure-matrix"),
                                    ElicitationSchema::new().string("value", true),
                                ),
                                "Value",
                            ))
                            .detach();
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_notification(
                {
                    let cancel_tx = cancel_tx.clone();
                    async move |_request: CancelNotification, _| {
                        if let Some(cancel_tx) = cancel_tx.lock().expect("cancel sender").take() {
                            let _ = cancel_tx.send(());
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".into(), agent, Duration::from_secs(1))
                .await
                .unwrap();
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .unwrap();
        let session = connection.session(&created.session_id).await.unwrap();
        let mut events = session.take_events().await.unwrap();
        connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["cancel".into()]),
                "matrix-run".into(),
                "matrix-turn".into(),
            )
            .await
            .unwrap();
        for _ in 0..100 {
            if connection.pending_permissions().await.len() == 1
                && connection.pending_elicitations().await.len() == 1
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        connection
            .interactions
            .inject_cancel_response_failures(&created.session_id, fail_permission, fail_elicitation)
            .await;
        if fail_cancel_send {
            let (generation, errors) = connection
                .interactions
                .cancel_session(&created.session_id)
                .await;
            assert_eq!(errors.len(), 2);
            let failure = Err(AcpRuntimeError::Connection("cancel send failed".into()));
            finish_cancel_attempt(Some(session.clone()), generation, &failure).await;
            finish_cancel_attempt(Some(session.clone()), generation, &failure).await;
        } else {
            connection.cancel(created.session_id.clone()).await.unwrap();
            cancel_rx.await.expect("ACP cancel notification sent");
        }
        if fail_cancel_send {
            let mut failures = 0;
            while let Ok(event) = events.try_recv() {
                if matches!(event, CanonicalEvent::RunFailed { generation: 1, .. }) {
                    failures += 1;
                }
            }
            assert_eq!(failures, 1);
            let admission = session
                .admit_prompt("matrix-run-2".into(), "matrix-turn-2".into())
                .await
                .expect("cancel-send failure reopens prompt admission");
            assert_eq!(admission.0, 2);
            connection.shutdown().await.unwrap();
            return;
        }
        assert_eq!(
            session.operation().await,
            Some(("matrix-run".into(), "matrix-turn".into(), 1))
        );
        assert!(matches!(
            connection
                .prompt(
                    PromptRequest::new(created.session_id.clone(), vec!["blocked".into()]),
                    "blocked-run".into(),
                    "blocked-turn".into(),
                )
                .await,
            Err(AcpRuntimeError::SessionBusy)
        ));

        let mut permission_resolved = 0;
        let mut elicitation_resolved = 0;
        let mut diagnostics = 0;
        while permission_resolved == 0 || elicitation_resolved == 0 || diagnostics == 0 {
            match events.recv().await.expect("canonical cancellation event") {
                CanonicalEvent::PermissionResolved { .. } => permission_resolved += 1,
                CanonicalEvent::ElicitationResolved { .. } => elicitation_resolved += 1,
                CanonicalEvent::Ignored { kind, .. }
                    if kind == "interaction_cancel_response_failed" =>
                {
                    diagnostics += 1
                }
                _ => {}
            }
        }
        assert_eq!(
            (permission_resolved, elicitation_resolved, diagnostics),
            (1, 1, 1)
        );
        prompt_responder
            .lock()
            .expect("prompt responder")
            .take()
            .unwrap()
            .respond(PromptResponse::new(StopReason::Cancelled))
            .unwrap();
        loop {
            if session.operation().await.is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
        connection.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn cancel_responder_failure_matrix_still_sends_cancel_and_terminalizes() {
        for (fail_permission, fail_elicitation) in [(true, false), (false, true), (true, true)] {
            assert_cancel_response_failures_do_not_block_cancel(
                fail_permission,
                fail_elicitation,
                false,
            )
            .await;
        }
        assert_cancel_response_failures_do_not_block_cancel(true, true, true).await;
    }

    #[tokio::test]
    async fn cancel_drains_only_the_matching_session_generation() {
        let next_session = Arc::new(AtomicUsize::new(0));
        let (outcomes_tx, mut outcomes_rx) = mpsc::unbounded_channel();
        let prompt_responders = Arc::new(StdMutex::new(Vec::<Responder<PromptResponse>>::new()));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let next_session = next_session.clone();
                    async move |_request: NewSessionRequest, responder, _| {
                        let index = next_session.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                        responder.respond(NewSessionResponse::new(format!("isolated-{index}")))
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responders = prompt_responders.clone();
                    async move |request: PromptRequest, responder, connection| {
                        prompt_responders
                            .lock()
                            .expect("prompt responders")
                            .push(responder);
                        let session_id = request.session_id.clone();
                        let mut permission = permission_request(permission_options());
                        permission.session_id = session_id.clone();
                        connection.send_request(permission).on_receiving_result({
                            let outcomes_tx = outcomes_tx.clone();
                            let session_id = session_id.clone();
                            async move |result| {
                                let _ = outcomes_tx.send((
                                    session_id.to_string(),
                                    "permission",
                                    matches!(result?.outcome, RequestPermissionOutcome::Cancelled),
                                ));
                                Ok(())
                            }
                        })?;
                        let elicitation = CreateElicitationRequest::new(
                            ElicitationFormMode::new(
                                ElicitationSessionScope::new(session_id.clone()),
                                ElicitationSchema::new().string("value", true),
                            ),
                            "Value",
                        );
                        connection.send_request(elicitation).on_receiving_result({
                            let outcomes_tx = outcomes_tx.clone();
                            async move |result| {
                                let _ = outcomes_tx.send((
                                    session_id.to_string(),
                                    "elicitation",
                                    matches!(result?.action, ElicitationAction::Cancel),
                                ));
                                Ok(())
                            }
                        })?;
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let first = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("first session");
        let second = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("second session");
        for session_id in [&first.session_id, &second.session_id] {
            connection
                .prompt(
                    PromptRequest::new(session_id.clone(), vec!["interact".into()]),
                    format!("run-{session_id}"),
                    format!("turn-{session_id}"),
                )
                .await
                .expect("prompt admitted");
        }
        for _ in 0..100 {
            if connection.pending_permissions().await.len() == 2
                && connection.pending_elicitations().await.len() == 2
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        connection
            .cancel(first.session_id.clone())
            .await
            .expect("first session cancelled");
        assert_eq!(connection.pending_permissions().await.len(), 1);
        assert_eq!(connection.pending_elicitations().await.len(), 1);
        for _ in 0..2 {
            let (session_id, _, cancelled) = outcomes_rx.recv().await.expect("first outcome");
            assert_eq!(session_id, first.session_id.to_string());
            assert!(cancelled);
        }
        connection.shutdown().await.expect("shutdown");
        for _ in 0..2 {
            let (session_id, _, cancelled) = outcomes_rx.recv().await.expect("second outcome");
            assert_eq!(session_id, second.session_id.to_string());
            assert!(cancelled);
        }
        for responder in prompt_responders
            .lock()
            .expect("prompt responders")
            .drain(..)
        {
            let _ = responder.respond(PromptResponse::new(StopReason::Cancelled));
        }
    }

    #[tokio::test]
    async fn steer_preparation_prefers_reject_once_and_fails_without_reject() {
        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            false,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        fixture
            .connection
            .prepare_steer(&fixture.session_id)
            .await
            .expect("reject option prepares steer");
        let ObservedInteraction::Permission(result) = fixture.observed.recv().await.unwrap() else {
            panic!("permission response expected");
        };
        assert_eq!(
            result.expect("typed response").outcome,
            RequestPermissionOutcome::Selected(
                agent_client_protocol::schema::v1::SelectedPermissionOutcome::new("reject-once")
            )
        );
        finish_fixture(&fixture).await;

        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(vec![PermissionOption::new(
                "allow-once",
                "Allow",
                PermissionOptionKind::AllowOnce,
            )]),
            false,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        assert!(matches!(
            fixture.connection.prepare_steer(&fixture.session_id).await,
            Err(AcpRuntimeError::Interaction(
                InteractionError::NoRejectOption(_)
            ))
        ));
        assert_eq!(fixture.connection.pending_permissions().await.len(), 1);
        fixture
            .connection
            .interactions
            .cancel_permissions_for_session(&fixture.session_id)
            .await
            .expect("cleanup permission");
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn steer_preparation_cancels_elicitation_with_typed_action() {
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(
                ElicitationSessionScope::new("interaction-session"),
                ElicitationSchema::new().string("value", true),
            ),
            "Value",
        );
        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request, false)).await;
        requested_event(&mut fixture.events, false).await;
        fixture
            .connection
            .prepare_steer(&fixture.session_id)
            .await
            .expect("elicitation cancelled for steer");
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        assert!(matches!(
            result.expect("typed response").action,
            ElicitationAction::Cancel
        ));
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn steer_preparation_converges_with_manual_interaction_resolution_races() {
        let mut permission = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            false,
        ))
        .await;
        requested_event(&mut permission.events, true).await;
        let pending = permission.connection.pending_permissions().await;
        let request_id = pending[0].request_id.clone();
        let thread_id = pending[0].thread_id.clone();
        let (prepare, manual) = tokio::join!(
            permission.connection.prepare_steer(&permission.session_id),
            permission
                .connection
                .resolve_permission(&thread_id, &request_id, "reject-once"),
        );
        assert!(prepare.is_ok());
        assert!(
            manual.is_ok()
                || matches!(
                    manual,
                    Err(AcpRuntimeError::Interaction(
                        InteractionError::UnknownRequest(_)
                    ))
                )
        );
        assert!(permission.connection.pending_permissions().await.is_empty());
        finish_fixture(&permission).await;

        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(
                ElicitationSessionScope::new("interaction-session"),
                ElicitationSchema::new().string("value", true),
            ),
            "Value",
        );
        let mut elicitation =
            start_pending_interaction(TestInteraction::Elicitation(request, false)).await;
        requested_event(&mut elicitation.events, false).await;
        let pending = elicitation.connection.pending_elicitations().await;
        let request_id = pending[0].request_id.clone();
        let thread_id = pending[0].thread_id.clone();
        let (prepare, manual) = tokio::join!(
            elicitation
                .connection
                .prepare_steer(&elicitation.session_id),
            elicitation
                .connection
                .cancel_elicitation(&thread_id, &request_id),
        );
        assert!(prepare.is_ok());
        assert!(
            manual.is_ok()
                || matches!(
                    manual,
                    Err(AcpRuntimeError::Interaction(
                        InteractionError::UnknownRequest(_)
                    ))
                )
        );
        assert!(elicitation
            .connection
            .pending_elicitations()
            .await
            .is_empty());
        finish_fixture(&elicitation).await;
    }

    #[tokio::test]
    async fn elicitation_request_cancellation_and_shutdown_return_typed_cancel() {
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(
                ElicitationSessionScope::new("interaction-session"),
                ElicitationSchema::new().string("value", true),
            ),
            "Value",
        );
        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request.clone(), true)).await;
        requested_event(&mut fixture.events, false).await;
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        assert!(matches!(
            result.expect("typed watcher cancellation").action,
            ElicitationAction::Cancel
        ));
        assert!(fixture.connection.pending_elicitations().await.is_empty());
        assert!(matches!(
            resolved_event(&mut fixture.events, false).await,
            CanonicalEvent::ElicitationResolved { .. }
        ));
        assert!(fixture.events.try_recv().is_err());
        finish_fixture(&fixture).await;

        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request.clone(), false)).await;
        requested_event(&mut fixture.events, false).await;
        let pending = fixture.connection.pending_elicitations().await;
        fixture
            .connection
            .sessions
            .remove(&fixture.session_id)
            .await;
        fixture
            .connection
            .cancel_elicitation(&pending[0].thread_id, &pending[0].request_id)
            .await
            .expect("elicitation resolves after session removal");
        fixture.observed.recv().await.expect("elicitation response");
        assert!(fixture.connection.pending_elicitations().await.is_empty());
        finish_fixture(&fixture).await;

        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request, false)).await;
        requested_event(&mut fixture.events, false).await;
        assert_eq!(fixture.connection.pending_elicitations().await.len(), 1);
        fixture
            .connection
            .shutdown()
            .await
            .expect("shutdown drains");
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        assert!(matches!(
            result.expect("typed shutdown cancellation").action,
            ElicitationAction::Cancel
        ));
        assert!(fixture.connection.pending_elicitations().await.is_empty());
    }

    #[tokio::test]
    async fn interaction_capacity_rejects_excess_without_leaking_responders() {
        let (outcomes_tx, mut outcomes_rx) = mpsc::unbounded_channel();
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("capacity-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, connection| {
                        *prompt_responder.lock().expect("prompt lock") = Some(responder);
                        for index in 0..17 {
                            let mut request = permission_request(permission_options());
                            request.session_id = "capacity-session".into();
                            request.tool_call.tool_call_id = format!("tool-{index}").into();
                            connection.send_request(request).on_receiving_result({
                                let outcomes_tx = outcomes_tx.clone();
                                async move |result| {
                                    let _ =
                                        outcomes_tx.send(result.map(|response| response.outcome));
                                    Ok(())
                                }
                            })?;
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let session = connection.session(&created.session_id).await.unwrap();
        let mut events = session.take_events().await.expect("session event receiver");
        connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["capacity".into()]),
                "capacity-run".to_string(),
                "capacity-turn".to_string(),
            )
            .await
            .expect("prompt admitted");
        for _ in 0..16 {
            requested_event(&mut events, true).await;
        }
        assert_eq!(connection.pending_permissions().await.len(), 16);
        let first = outcomes_rx.recv().await.expect("excess request response");
        assert_eq!(
            first.expect("typed capacity response"),
            RequestPermissionOutcome::Cancelled
        );
        connection
            .interactions
            .cancel_permissions_for_session(&created.session_id)
            .await
            .expect("pending permissions drained");
        for _ in 0..16 {
            assert_eq!(
                outcomes_rx
                    .recv()
                    .await
                    .expect("pending response")
                    .expect("typed cancellation"),
                RequestPermissionOutcome::Cancelled
            );
        }
        assert!(connection.pending_permissions().await.is_empty());
        if let Some(responder) = prompt_responder.lock().expect("prompt lock").take() {
            responder
                .respond(PromptResponse::new(StopReason::Cancelled))
                .expect("prompt response");
        }
        connection.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn load_reconstruction_auto_cancels_interactions_without_live_request() {
        let (outcome_tx, outcome_rx) = oneshot::channel();
        let outcome_tx = Arc::new(StdMutex::new(Some(outcome_tx)));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new().load_session(true)))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let outcome_tx = outcome_tx.clone();
                    async move |request: LoadSessionRequest, responder, connection| {
                        let mut permission = permission_request(permission_options());
                        permission.session_id = request.session_id;
                        connection.send_request(permission).on_receiving_result({
                            let outcome_tx = outcome_tx.clone();
                            async move |result| {
                                if let Some(sender) =
                                    outcome_tx.lock().expect("outcome lock").take()
                                {
                                    let _ = sender.send(result.map(|response| response.outcome));
                                }
                                responder.respond(LoadSessionResponse::new())
                            }
                        })?;
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let session_id = agent_client_protocol::schema::v1::SessionId::new("reconstructed");
        let session = connection
            .sessions
            .register("test-agent", session_id.clone())
            .await
            .expect("session capacity");
        let mut events = session.take_events().await.expect("session event receiver");
        connection
            .load_session(LoadSessionRequest::new(session_id, "/tmp"))
            .await
            .expect("load completes");
        assert_eq!(
            outcome_rx
                .await
                .expect("interaction response")
                .expect("typed cancellation"),
            RequestPermissionOutcome::Cancelled
        );
        assert!(connection.pending_permissions().await.is_empty());
        assert!(
            events.try_recv().is_err(),
            "no live interaction event emitted"
        );
        connection.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn typed_load_replaces_previous_projection_and_rolls_back_failure() {
        let load_count = Arc::new(AtomicUsize::new(0));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new().load_session(true)))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let load_count = load_count.clone();
                    async move |request: LoadSessionRequest, responder, connection| {
                        let index = load_count.fetch_add(1, AtomicOrdering::SeqCst);
                        let message_id = match index {
                            0 => "first",
                            1 => "second",
                            _ => "failed",
                        };
                        connection.send_notification(SessionNotification::new(
                            request.session_id,
                            update(serde_json::json!({
                                "sessionUpdate": "agent_message_chunk",
                                "content": {"type": "text", "text": message_id},
                                "messageId": message_id
                            })),
                        ))?;
                        if index == 2 {
                            responder
                                .respond_with_error(agent_client_protocol::Error::internal_error())
                        } else {
                            responder.respond(LoadSessionResponse::new())
                        }
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("load-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("load agent starts");
        let session_id = SessionId::new("load-session");

        connection
            .load_session(LoadSessionRequest::new(session_id.clone(), "/tmp"))
            .await
            .expect("first load");
        connection
            .load_session(LoadSessionRequest::new(session_id.clone(), "/tmp"))
            .await
            .expect("second load");
        let session = connection
            .session(&session_id)
            .await
            .expect("loaded session");
        let snapshot = session.snapshot().await;
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].id, "second::agent");

        assert!(connection
            .load_session(LoadSessionRequest::new(session_id.clone(), "/tmp"))
            .await
            .is_err());
        let snapshot = session.snapshot().await;
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].id, "second::agent");
        assert!(!snapshot.history_reconstruction);
        connection.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn connection_failure_drains_pending_interactions() {
        let (release_tx, release_rx) = oneshot::channel();
        let release_rx = Arc::new(StdMutex::new(Some(release_rx)));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    let capabilities = AgentCapabilities::new()
                        .load_session(true)
                        .session_capabilities(
                            SessionCapabilities::new()
                                .list(SessionListCapabilities::new())
                                .resume(SessionResumeCapabilities::new()),
                        );
                    responder.respond(initialized(capabilities))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("failure-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let release_rx = release_rx.clone();
                    async move |_request: PromptRequest, _responder, connection| {
                        let mut request = permission_request(permission_options());
                        request.session_id = "failure-session".into();
                        connection
                            .send_request(request)
                            .on_receiving_result(async |_result| Ok(()))?;
                        let receiver = release_rx.lock().expect("release lock").take();
                        if let Some(receiver) = receiver {
                            connection.spawn(async move {
                                let _ = receiver.await;
                                Err::<(), _>(agent_client_protocol::util::internal_error(
                                    "forced failure",
                                ))
                            })?;
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let session = connection.session(&created.session_id).await.unwrap();
        let mut events = session.take_events().await.expect("session event receiver");
        connection
            .prompt(
                PromptRequest::new(created.session_id, vec!["fail".into()]),
                "failure-run".to_string(),
                "failure-turn".to_string(),
            )
            .await
            .expect("prompt admitted");
        requested_event(&mut events, true).await;
        assert_eq!(connection.pending_permissions().await.len(), 1);
        release_tx.send(()).expect("release failure");
        let mut failure = connection.failure.clone();
        loop {
            if failure.borrow().is_some() {
                break;
            }
            failure.changed().await.expect("failure signal");
        }
        assert!(connection.pending_permissions().await.is_empty());

        let late_session_id = SessionId::new("late-session");
        connection
            .ensure_session(late_session_id.clone())
            .await
            .expect("session capacity");
        assert_eq!(connection.loaded_sessions().await.len(), 2);
        assert_connection_failure(connection.new_session(NewSessionRequest::new("/tmp")).await);
        assert_connection_failure(connection.list_sessions(ListSessionsRequest::new()).await);
        assert_connection_failure(
            connection
                .load_session(LoadSessionRequest::new("load-after-failure", "/tmp"))
                .await,
        );
        assert_connection_failure(
            connection
                .resume_session(ResumeSessionRequest::new("resume-after-failure", "/tmp"))
                .await,
        );
        assert_connection_failure(
            connection
                .prompt(
                    PromptRequest::new(late_session_id.clone(), vec!["late".into()]),
                    "late-run".to_string(),
                    "late-turn".to_string(),
                )
                .await,
        );
        assert_connection_failure(connection.cancel(late_session_id).await);
    }

    #[tokio::test]
    async fn initialize_advertises_minimal_capabilities_and_gates_list() {
        let (initialize_tx, initialize_rx) = oneshot::channel();
        let initialize_tx = Arc::new(StdMutex::new(Some(initialize_tx)));
        let agent = Agent.builder().on_receive_request(
            {
                let initialize_tx = initialize_tx.clone();
                async move |request: InitializeRequest, responder, _| {
                    if let Some(sender) = initialize_tx.lock().expect("initialize lock").take() {
                        let _ = sender.send(request.clone());
                    }
                    responder.respond(initialized(AgentCapabilities::new()))
                }
            },
            agent_client_protocol::on_receive_request!(),
        );
        let (connection, negotiated) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("typed agent initializes");
        let request = initialize_rx.await.expect("initialize captured");
        assert_eq!(negotiated.response.protocol_version, ProtocolVersion::V1);
        assert!(!request.client_capabilities.fs.read_text_file);
        assert!(!request.client_capabilities.fs.write_text_file);
        assert!(!request.client_capabilities.terminal);
        let elicitation = request
            .client_capabilities
            .elicitation
            .expect("form elicitation advertised");
        assert!(elicitation.form.is_some());
        assert!(elicitation.url.is_none());
        assert!(matches!(
            connection.list_sessions(ListSessionsRequest::new()).await,
            Err(AcpRuntimeError::Unsupported("session/list"))
        ));
        assert!(matches!(
            connection
                .load_session(LoadSessionRequest::new("missing", "/tmp"))
                .await,
            Err(AcpRuntimeError::Unsupported("session/load"))
        ));
        assert!(matches!(
            connection
                .resume_session(ResumeSessionRequest::new("missing", "/tmp"))
                .await,
            Err(AcpRuntimeError::Unsupported("session/resume"))
        ));
        assert!(matches!(
            connection
                .prompt(
                    PromptRequest::new("missing", vec!["hello".into()]),
                    "run".to_string(),
                    "turn".to_string(),
                )
                .await,
            Err(AcpRuntimeError::UnknownSession(_))
        ));
        assert!(matches!(
            connection.cancel(SessionId::new("missing")).await,
            Err(AcpRuntimeError::UnknownSession(_))
        ));
        assert!(matches!(
            connection.prepare_steer(&SessionId::new("missing")).await,
            Err(AcpRuntimeError::UnknownSession(_))
        ));
        assert!(matches!(
            connection
                .steer(
                    SteerRequest {
                        session_id: SessionId::new("missing"),
                        expected_run_id: "run".to_string(),
                        expected_source_turn_id: "turn".to_string(),
                        prompt_generation: 1,
                        prompt: vec!["hello".into()],
                    },
                    0
                )
                .await,
            Err(AcpRuntimeError::Unsupported(STEER_METHOD))
        ));
        connection.shutdown().await.expect("connection shuts down");
    }

    #[tokio::test]
    async fn ordinary_command_failures_preserve_typed_state() {
        let agent = Agent
            .builder()
            .on_receive_request(
                async |request: InitializeRequest, responder, _| {
                    let capabilities = AgentCapabilities::new()
                        .load_session(true)
                        .session_capabilities(
                            SessionCapabilities::new()
                                .list(SessionListCapabilities::new())
                                .resume(SessionResumeCapabilities::new()),
                        );
                    responder.respond(
                        InitializeResponse::new(request.protocol_version)
                            .agent_capabilities(capabilities),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond_with_error(agent_client_protocol::Error::method_not_found())
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: ListSessionsRequest, responder, _| {
                    responder.respond_with_error(agent_client_protocol::Error::method_not_found())
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: LoadSessionRequest, responder, _| {
                    responder.respond_with_error(agent_client_protocol::Error::method_not_found())
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: ResumeSessionRequest, responder, _| {
                    responder.respond_with_error(agent_client_protocol::Error::method_not_found())
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) = AcpConnection::start_transport(
            "failure-agent".to_string(),
            agent,
            Duration::from_secs(1),
        )
        .await
        .expect("failure agent starts");
        assert!(matches!(
            connection.new_session(NewSessionRequest::new("/tmp")).await,
            Err(AcpRuntimeError::Connection(_))
        ));
        assert!(matches!(
            connection.list_sessions(ListSessionsRequest::new()).await,
            Err(AcpRuntimeError::Connection(_))
        ));
        assert!(matches!(
            connection
                .load_session(LoadSessionRequest::new("load-session", "/tmp"))
                .await,
            Err(AcpRuntimeError::Connection(_))
        ));
        assert!(connection
            .session(&SessionId::new("load-session"))
            .await
            .is_none());
        assert!(matches!(
            connection
                .resume_session(ResumeSessionRequest::new("resume-session", "/tmp"))
                .await,
            Err(AcpRuntimeError::Connection(_))
        ));
        assert!(connection
            .session(&SessionId::new("resume-session"))
            .await
            .is_none());
        connection.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn prompt_admission_does_not_block_list_or_cancel() {
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let (prompt_seen_tx, prompt_seen_rx) = oneshot::channel();
        let prompt_seen_tx = Arc::new(StdMutex::new(Some(prompt_seen_tx)));
        let (cancel_seen_tx, cancel_seen_rx) = oneshot::channel();
        let cancel_seen_tx = Arc::new(StdMutex::new(Some(cancel_seen_tx)));
        let agent = Agent.builder()
            .on_receive_request(async |request: InitializeRequest, responder, _| {
                let capabilities = AgentCapabilities::new().load_session(true).session_capabilities(
                    SessionCapabilities::new().list(SessionListCapabilities::new()).resume(SessionResumeCapabilities::new()),
                );
                responder.respond(InitializeResponse::new(request.protocol_version).agent_capabilities(capabilities))
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request(async |_request: NewSessionRequest, responder, _| {
                responder.respond(NewSessionResponse::new("session-1"))
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request(async |_request: ListSessionsRequest, responder, _| {
                responder.respond(ListSessionsResponse::new(vec![SessionInfo::new("session-1", "/tmp")]))
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request({
                let prompt_responder = prompt_responder.clone();
                let prompt_seen_tx = prompt_seen_tx.clone();
                async move |request: PromptRequest, responder, connection| {
                    for value in [
                        serde_json::json!({"sessionUpdate":"tool_call","toolCallId":"active-tool","title":"Run","kind":"execute","status":"in_progress"}),
                        serde_json::json!({"sessionUpdate":"tool_call","toolCallId":"active-tool","title":"Run","kind":"execute","status":"in_progress"}),
                        serde_json::json!({"sessionUpdate":"tool_call_update","toolCallId":"active-tool","status":"completed"}),
                        serde_json::json!({"sessionUpdate":"tool_call_update","toolCallId":"active-tool","status":"completed"}),
                    ] { connection.send_notification(SessionNotification::new(request.session_id.clone(), update(value)))?; }
                    *prompt_responder.lock().expect("prompt responder lock") = Some(responder);
                    if let Some(sender) = prompt_seen_tx.lock().expect("prompt seen lock").take() { let _ = sender.send(()); }
                    Ok(())
                }
            }, agent_client_protocol::on_receive_request!())
            .on_receive_notification({
                let cancel_seen_tx = cancel_seen_tx.clone();
                async move |_cancel: CancelNotification, _| {
                    if let Some(sender) = cancel_seen_tx.lock().expect("cancel lock").take() { let _ = sender.send(()); }
                    Ok(())
                }
            }, agent_client_protocol::on_receive_notification!());

        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("new session");
        let session = connection
            .session(&created.session_id)
            .await
            .expect("session registered before return");
        let mut events = session.take_events().await.expect("session event receiver");
        let admission = tokio::time::timeout(
            Duration::from_secs(1),
            connection.prompt(
                PromptRequest::new(created.session_id.clone(), vec!["hello".into()]),
                "run-1".to_string(),
                "turn-1".to_string(),
            ),
        )
        .await
        .expect("prompt admission does not wait for response")
        .expect("prompt admitted");
        assert_eq!(admission.generation, 1);
        prompt_seen_rx.await.expect("agent received prompt");
        let listed = tokio::time::timeout(
            Duration::from_secs(1),
            connection.list_sessions(ListSessionsRequest::new()),
        )
        .await
        .expect("list remains processable")
        .expect("list succeeds");
        assert_eq!(listed.sessions.len(), 1);
        assert!(
            session.snapshot().await.active_tool_ids.is_empty(),
            "duplicate terminal updates clear the active tool exactly once"
        );
        connection
            .cancel(created.session_id.clone())
            .await
            .expect("cancel notification sent");
        cancel_seen_rx.await.expect("agent received cancel");
        prompt_responder
            .lock()
            .expect("prompt responder lock")
            .take()
            .expect("pending prompt responder")
            .respond(PromptResponse::new(StopReason::Cancelled))
            .expect("prompt responds");
        loop {
            if let CanonicalEvent::RunFinished { stop_reason, .. } =
                events.recv().await.expect("terminal event")
            {
                assert_eq!(stop_reason, StopReason::Cancelled);
                break;
            }
        }
        let settled = session.snapshot().await;
        assert!(settled.active_generation.is_none());
        assert_eq!(settled.token_totals, None);
        connection.shutdown().await.expect("connection shuts down");
    }

    #[tokio::test]
    async fn cancelling_typed_new_session_cancels_agent_future_without_mutation() {
        let signal = RequestCancellation::default();
        assert!(!signal.is_cancelled());
        let waiter = {
            let signal = signal.clone();
            tokio::spawn(async move { signal.cancelled().await })
        };
        signal.cancel();
        waiter.await.unwrap();
        assert!(signal.is_cancelled());
        signal.cancelled().await;

        let attempts = Arc::new(AtomicUsize::new(0));
        let (cancelled_tx, cancelled_rx) = oneshot::channel();
        let cancelled_tx = Arc::new(StdMutex::new(Some(cancelled_tx)));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let attempts = attempts.clone();
                    let cancelled_tx = cancelled_tx.clone();
                    move |_: NewSessionRequest, responder: Responder<NewSessionResponse>, _| {
                        let attempts = attempts.clone();
                        let cancelled_tx = cancelled_tx.clone();
                        async move {
                            if attempts.fetch_add(1, AtomicOrdering::SeqCst) == 0 {
                                tokio::spawn(async move {
                                    responder.cancellation().cancelled().await;
                                    if let Some(sender) =
                                        cancelled_tx.lock().expect("cancelled sender lock").take()
                                    {
                                        let _ = sender.send(());
                                    }
                                });
                                Ok(())
                            } else {
                                responder.respond(NewSessionResponse::new("independent-session"))
                            }
                        }
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) = AcpConnection::start_transport(
            "cancellation-agent".into(),
            agent,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let cancellation = RequestCancellation::default();
        let request = {
            let connection = connection.clone();
            let cancellation = cancellation.clone();
            tokio::spawn(async move {
                connection
                    .new_session_with_cancellation(NewSessionRequest::new("/tmp"), cancellation)
                    .await
            })
        };
        while attempts.load(AtomicOrdering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        cancellation.cancel();
        assert!(matches!(
            request.await.unwrap(),
            Err(AcpRuntimeError::RequestCancelled)
        ));
        tokio::time::timeout(Duration::from_secs(1), cancelled_rx)
            .await
            .expect("agent request future cancelled")
            .expect("cancellation signal delivered");
        assert!(connection.loaded_sessions().await.is_empty());

        let independent = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("independent request remains usable");
        assert_eq!(independent.session_id.to_string(), "independent-session");
        assert_eq!(connection.loaded_sessions().await.len(), 1);
        connection.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn load_reconstructs_all_update_families_and_resume_registers_sessions() {
        let next_session = Arc::new(AtomicUsize::new(0));
        let agent = Agent.builder()
            .on_receive_request(async |_request: InitializeRequest, responder, _| {
                responder.respond(initialized(AgentCapabilities::new().load_session(true).session_capabilities(
                    SessionCapabilities::new().list(SessionListCapabilities::new()).resume(SessionResumeCapabilities::new()),
                )))
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request({
                let next_session = next_session.clone();
                async move |_request: NewSessionRequest, responder, _| {
                    let number = next_session.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                    responder.respond(NewSessionResponse::new(format!("session-{number}")))
                }
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request(async |request: LoadSessionRequest, responder, connection| {
                for index in 0..140 {
                    connection.send_notification(SessionNotification::new(request.session_id.clone(), update(serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"},"messageId":format!("bounded-{index}")}))))?;
                }
                let values = vec![
                    serde_json::json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"user"}}),
                    serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello "}}),
                    serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"world"}}),
                    serde_json::json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking"}}),
                    serde_json::json!({"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Read","kind":"read","status":"in_progress","content":[{"type":"content","content":{"type":"text","text":"partial"}}]}),
                    serde_json::json!({"sessionUpdate":"tool_call_update","toolCallId":"tool-1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"done"}}]}),
                    serde_json::json!({"sessionUpdate":"plan","entries":[{"content":"Ship","priority":"high","status":"in_progress"}]}),
                    serde_json::json!({"sessionUpdate":"available_commands_update","availableCommands":[{"name":"review","description":"Review changes"}]}),
                    serde_json::json!({"sessionUpdate":"current_mode_update","currentModeId":"plan"}),
                    serde_json::json!({"sessionUpdate":"config_option_update","configOptions":[{"id":"fast","name":"Fast","type":"boolean","currentValue":true}]}),
                    serde_json::json!({"sessionUpdate":"session_info_update","title":"Loaded","updatedAt":"2026-07-19T00:00:00Z"}),
                    serde_json::json!({"sessionUpdate":"usage_update","used":42,"size":100,"cost":{"amount":1.25,"currency":"USD"}}),
                ];
                for value in values { connection.send_notification(SessionNotification::new(request.session_id.clone(), update(value)))?; }
                responder.respond(LoadSessionResponse::new())
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request(async |_request: ResumeSessionRequest, responder, _| {
                responder.respond(ResumeSessionResponse::new())
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request(async |_request: ListSessionsRequest, responder, connection| {
                connection.send_notification(SessionNotification::new("session-1", update(serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"one"},"messageId":"one"}))))?;
                connection.send_notification(SessionNotification::new("session-2", update(serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"two"},"messageId":"two"}))))?;
                connection.send_notification(SessionNotification::new("late-session", update(serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"buffered"},"messageId":"late"}))))?;
                responder.respond(ListSessionsResponse::new(vec![]))
            }, agent_client_protocol::on_receive_request!());

        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let first = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("first session");
        let first_session = connection
            .session(&first.session_id)
            .await
            .expect("first registered");
        let mut live_events = first_session
            .take_events()
            .await
            .expect("session event receiver");
        connection
            .load_session(LoadSessionRequest::new(first.session_id.clone(), "/tmp"))
            .await
            .expect("load succeeds");
        assert!(
            live_events.try_recv().is_err(),
            "load replay is not broadcast live"
        );
        let snapshot = first_session.snapshot().await;
        assert!(!snapshot.history_reconstruction);
        assert_eq!(snapshot.messages.len(), 128);
        assert!(snapshot.messages.iter().any(|message| message.parts
            == vec![serde_json::json!({
                "type": "text",
                "text": "hello world",
            })]));
        assert_eq!(
            snapshot.tools["tool-1"].status,
            agent_client_protocol::schema::v1::ToolCallStatus::Completed
        );
        assert_eq!(snapshot.plan[0].content, "Ship");
        assert_eq!(snapshot.commands[0].name, "review");
        assert_eq!(snapshot.mode_id.as_deref(), Some("plan"));
        assert_eq!(snapshot.config[0].value, "true");
        assert_eq!(snapshot.title.as_deref(), Some("Loaded"));
        assert_eq!(snapshot.updated_at.as_deref(), Some("2026-07-19T00:00:00Z"));
        assert_eq!(snapshot.usage_used, Some(42));
        assert_eq!(snapshot.usage_size, Some(100));
        assert_eq!(snapshot.usage_cost.as_deref(), Some("1.25 USD"));

        let second = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("second session");
        connection
            .resume_session(ResumeSessionRequest::new(second.session_id.clone(), "/tmp"))
            .await
            .expect("resume succeeds");
        let second_session = connection
            .session(&second.session_id)
            .await
            .expect("resumed session registered");
        connection
            .list_sessions(ListSessionsRequest::new())
            .await
            .expect("interleaved notifications sent");
        assert!(first_session
            .snapshot()
            .await
            .messages
            .iter()
            .any(|message| message.id == "one::agent"));
        assert!(second_session
            .snapshot()
            .await
            .messages
            .iter()
            .any(|message| message.id == "two::agent"));
        connection
            .resume_session(ResumeSessionRequest::new("late-session", "/tmp"))
            .await
            .expect("late session resumes");
        let late_id = agent_client_protocol::schema::v1::SessionId::new("late-session");
        assert!(connection
            .session(&late_id)
            .await
            .expect("late session registered")
            .snapshot()
            .await
            .messages
            .iter()
            .any(|message| message.id == "late::agent"));
        connection.shutdown().await.expect("connection shuts down");
    }

    #[tokio::test]
    async fn connection_loss_while_cancelling_fails_generation_exactly_once() {
        let (release_tx, release_rx) = oneshot::channel();
        let release_rx = Arc::new(StdMutex::new(Some(release_rx)));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("session-loss"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let release_rx = release_rx.clone();
                    async move |_request: PromptRequest, _responder, _| {
                        let receiver = { release_rx.lock().expect("release lock").take() };
                        if let Some(receiver) = receiver {
                            let _ = receiver.await;
                        }
                        Err::<(), _>(agent_client_protocol::util::internal_error(
                            "agent connection lost",
                        ))
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let session = connection
            .session(&created.session_id)
            .await
            .expect("session registered");
        let mut events = session.take_events().await.expect("session event receiver");
        connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["fail".into()]),
                "run-loss".to_string(),
                "turn-loss".to_string(),
            )
            .await
            .expect("prompt admitted");
        connection
            .cancel(created.session_id)
            .await
            .expect("cancel accepted before connection loss");
        assert!(matches!(
            session.begin_reconstruction().await,
            Err(ReconstructionError::Cancelled)
        ));
        release_tx.send(()).expect("release agent failure");
        let terminal = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let CanonicalEvent::RunFailed { run_id, .. } =
                    events.recv().await.expect("failure event")
                {
                    break run_id;
                }
            }
        })
        .await
        .expect("connection failure fans out");
        assert_eq!(terminal, "run-loss");
        assert!(session.snapshot().await.active_generation.is_none());
        tokio::task::yield_now().await;
        assert!(
            events.try_recv().is_err(),
            "old generation fails exactly once"
        );
    }
}
