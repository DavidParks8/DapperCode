use super::{
    agent_message_journal_bytes, canonical_event_channel, classify_harness_operation_failure,
    classify_runtime_operation_failure, decode_cursor, encode_cursor, forward_session_events,
    index_entry, index_entry_with_policy, redact_error, sanitize_agent_message_journal,
    sanitize_index_entries, valid_agent_icon, AcpConnection, AcpRuntimeError, AgentLifecycle,
    AgentManager, AgentManagerError, AgentMessageJournalEntry, AgentRelationError,
    AgentRelationKind, AgentRelationSession, AgentRelationStatus, AgentSessionId, ApprovalPolicy,
    Arc, AtomicBool, BTreeMap, CanonicalEvent, CloseSessionRequest, DeleteSessionRequest,
    DurableAgentMessageJournal, DurableSessionIndex, Duration, FieldUpdate, ForkRequest,
    HarnessChildSession, HarnessError, HarnessOperationFailure, HashMap, LoadSessionRequest,
    LocalAgentManifest, LocalAgentManifestSet, McpCredentialError, MessageRole, Mutex,
    NegotiatedInitialize, NewSessionRequest, Ordering, Path, PathBuf, PromptRequest,
    RequestCancellation, ResolvedAgentManifest, ResumeSessionRequest, RetirementPlanReconciliation,
    SessionConfigOptionValue, SessionId, SessionIndexEntry, SessionListDiagnostic, SessionSnapshot,
    SetSessionConfigOptionRequest, SteerRequest, SubagentGenerationState, Uuid,
    AGENT_MESSAGE_JOURNAL_FILE, MAX_AGENTS, MAX_AGENT_MESSAGE_ANCHOR_BYTES,
    MAX_AGENT_MESSAGE_BODY_BYTES, MAX_AGENT_MESSAGE_ID_BYTES, MAX_AGENT_MESSAGE_JOURNAL_BYTES,
    MAX_AGENT_MESSAGE_JOURNAL_ENTRIES, MAX_AGENT_RELATION_CHILDREN, MAX_PAGE_SIZE, MAX_SESSIONS,
    MAX_SESSION_CWD_BYTES, MAX_SESSION_INDEX_BYTES, MAX_SESSION_LIST_PAGES,
    MAX_TRACKED_SUBAGENT_GENERATIONS, SESSION_INDEX_FILE, URL_SAFE_NO_PAD,
};
#[cfg(unix)]
use super::{harness_for_manifest, milliseconds_to_iso};
use base64::Engine;

#[derive(Clone)]
pub(super) struct PolicySnapshotBarrier {
    pub(super) reached: Arc<tokio::sync::Notify>,
    pub(super) release: Arc<tokio::sync::Notify>,
}

impl PolicySnapshotBarrier {
    async fn wait_until_reached(&self) {
        self.reached.notified().await;
    }

    fn release(&self) {
        self.release.notify_one();
    }
}

use crate::acp::config::tests::test_executable_root;
use agent_client_protocol::v1::schema::{
    AgentCapabilities, CancelNotification, CloseSessionResponse, DeleteSessionResponse,
    InitializeRequest, InitializeResponse, ListSessionsRequest, ListSessionsResponse,
    LoadSessionResponse, McpCapabilities, NewSessionResponse, PromptResponse,
    ResumeSessionResponse, SessionCapabilities, SessionCloseCapabilities, SessionConfigOption,
    SessionDeleteCapabilities, SessionInfo, SessionListCapabilities, SessionResumeCapabilities,
    SetSessionConfigOptionResponse, StopReason, ToolCallStatus, ToolKind,
};
use agent_client_protocol::Agent;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode as AxumStatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicUsize;
use tokio::sync::mpsc;

#[test]
fn unavailable_connection_before_dispatch_is_a_definitive_failure() {
    let failure = classify_runtime_operation_failure(AcpRuntimeError::ConnectionUnavailable(
        "already closed".to_string(),
    ));
    assert!(!failure.is_indeterminate());
    let failure = classify_harness_operation_failure(HarnessOperationFailure::indeterminate(
        HarnessError::Timeout,
    ));
    assert!(failure.is_indeterminate());
}

fn echo_digest() -> String {
    let bytes = std::fs::read("/bin/echo").expect("read /bin/echo");
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn manifest(agent_id: &str, display_name: &str) -> LocalAgentManifest {
    LocalAgentManifest {
        enabled: true,
        display_name: display_name.to_string(),
        icon: Some(format!("https://cdn.example.test/{agent_id}.png")),
        resolved: ResolvedAgentManifest {
            agent_id: agent_id.to_string(),
            executable: PathBuf::from("/bin/echo"),
            argv: vec![],
            environment: BTreeMap::new(),
            resolved_version: "1.2.3".to_string(),
            provenance: "local registry snapshot".to_string(),
            verified_digest: echo_digest(),
            integrity: crate::acp::config::RuntimeIntegrity::Executable,
        },
    }
}

fn sent_agent_message(
    message_id: &str,
    related_thread_id: &str,
) -> crate::agent_messaging::AgentMessageOrigin {
    crate::agent_messaging::AgentMessageOrigin {
        message_id: message_id.to_string(),
        direction: crate::agent_messaging::AgentMessageDirection::Sent,
        related_thread_id: related_thread_id.to_string(),
        related_title: Some("Worker".to_string()),
        relation: AgentRelationKind::SubAgent,
        disposition: crate::agent_messaging::AgentMessageDisposition::Sent,
        body: "Check the queue lifecycle.".to_string(),
    }
}

#[test]
fn agent_icons_match_shared_policy_fixture() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../contracts/agent-icon-policy.json"))
            .expect("parse icon policy fixture");
    for policy_case in fixture["cases"].as_array().expect("icon cases") {
        let value = policy_case["value"].as_str();
        let expected = policy_case["valid"].as_bool().expect("valid flag");
        assert_eq!(
            valid_agent_icon(value),
            expected,
            "{}",
            policy_case["name"].as_str().expect("case name"),
        );
    }
    assert!(!valid_agent_icon(Some(&format!(
        "https://example.test/{}",
        "x".repeat(2_048)
    ))));
}

#[tokio::test]
async fn manager_projects_native_extension_capabilities_without_a_harness() {
    let connection = native_extension_connection("native-agent").await;
    let manager = AgentManager::from_start_results(
        "native-agent".to_string(),
        vec![(manifest("native-agent", "Native"), Ok(connection))],
    )
    .await
    .expect("manager");
    let capabilities = manager
        .list_agents()
        .into_iter()
        .find(|agent| agent.agent_id == "native-agent")
        .and_then(|agent| agent.capabilities)
        .expect("native capabilities");
    assert!(capabilities.session_steer);
    assert!(capabilities.session_fork);
    assert!(capabilities.session_delete);
    assert!(manager
        .supports_steer(
            &AgentSessionId::new("native-agent", "source")
                .expect("identity")
                .encode()
        )
        .expect("native steer support"));
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_injects_one_shared_agent_message_transport_only_when_supported() {
    let service = crate::agent_messaging::AgentMessagingService::start(
        std::sync::Weak::<crate::runtime_backend::RuntimeBackend>::new(),
        std::sync::Weak::<crate::BridgeQueueService>::new(),
        crate::scheduled_prompts::ScheduledPromptService::inert_for_test(),
        crate::phone_call::PhoneCallService::inert_for_test(),
    )
    .await
    .expect("shared MCP listener starts");
    let config = service.config().clone();
    let http_url = config.http_url.clone();
    let sse_url = config.sse_url.clone();
    let (http_observed, mut http_requests) = mpsc::unbounded_channel();
    let (sse_observed, mut sse_requests) = mpsc::unbounded_channel();
    let (stdio_observed, mut stdio_requests) = mpsc::unbounded_channel();
    let http = mcp_observing_connection(
        "http-agent",
        McpCapabilities::new().http(true).sse(true),
        http_observed,
    )
    .await;
    let sse =
        mcp_observing_connection("sse-agent", McpCapabilities::new().sse(true), sse_observed).await;
    let stdio =
        mcp_observing_connection("stdio-agent", McpCapabilities::new(), stdio_observed).await;
    let manager = AgentManager::from_start_results(
        "http-agent".to_string(),
        vec![
            (manifest("http-agent", "HTTP"), Ok(http)),
            (manifest("sse-agent", "SSE"), Ok(sse)),
            (manifest("stdio-agent", "Stdio"), Ok(stdio)),
        ],
    )
    .await
    .expect("manager");
    manager
        .attach_agent_messaging(config)
        .expect("attach shared MCP service");

    for agent_id in ["http-agent", "sse-agent", "stdio-agent"] {
        manager
            .new_session(agent_id, NewSessionRequest::new("/tmp"))
            .await
            .expect("session starts");
    }

    let http_servers = http_requests.recv().await.expect("HTTP request");
    assert_eq!(http_servers.as_array().expect("HTTP server array").len(), 1);
    assert_eq!(http_servers[0]["url"], http_url);
    assert_eq!(http_servers[0]["headers"][0]["name"], "Authorization");
    assert!(!http_servers[0]["url"]
        .as_str()
        .expect("HTTP MCP URL")
        .contains("dcm_"));

    let sse_servers = sse_requests.recv().await.expect("SSE request");
    assert_eq!(sse_servers.as_array().expect("SSE server array").len(), 1);
    assert_eq!(sse_servers[0]["url"], sse_url);
    assert_eq!(sse_servers[0]["headers"][0]["name"], "Authorization");

    let stdio_servers = stdio_requests.recv().await.expect("stdio request");
    assert_eq!(
        stdio_servers
            .as_array()
            .expect("stdio-only server array")
            .len(),
        0,
    );

    manager.shutdown().await;
    service.shutdown().await;
}

#[tokio::test]
async fn manager_keeps_session_lifecycle_available_when_messaging_credentials_are_saturated() {
    let service = crate::agent_messaging::AgentMessagingService::start(
        std::sync::Weak::<crate::runtime_backend::RuntimeBackend>::new(),
        std::sync::Weak::<crate::BridgeQueueService>::new(),
        crate::scheduled_prompts::ScheduledPromptService::inert_for_test(),
        crate::phone_call::PhoneCallService::inert_for_test(),
    )
    .await
    .expect("shared MCP listener starts");
    let config = service.config().clone();
    let mut reserved = Vec::new();
    loop {
        match config.stage_credential("reserved-agent") {
            Ok(credential) => reserved.push(credential),
            Err(McpCredentialError::LimitReached) => break,
            Err(error) => panic!("unexpected credential staging failure: {error}"),
        }
    }
    assert_eq!(reserved.len(), 4_096);

    let (observed, mut requests) = mpsc::unbounded_channel();
    let connection =
        mcp_observing_connection("http-agent", McpCapabilities::new().http(true), observed).await;
    let manager = AgentManager::from_start_results(
        "http-agent".to_string(),
        vec![(manifest("http-agent", "HTTP"), Ok(connection))],
    )
    .await
    .expect("manager");
    manager
        .attach_agent_messaging(config)
        .expect("attach shared MCP service");

    manager
        .new_session("http-agent", NewSessionRequest::new("/tmp"))
        .await
        .expect("session lifecycle remains available");
    assert!(requests
        .recv()
        .await
        .expect("new-session MCP servers")
        .as_array()
        .expect("MCP server array")
        .is_empty());

    manager.shutdown().await;
    drop(reserved);
    service.shutdown().await;
}

#[tokio::test]
async fn manager_projects_fork_support_for_a_canonicalized_opencode_launcher() {
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let connection = connection_with_capabilities(
        "opencode",
        AgentCapabilities::new().load_session(true),
        observed_tx,
    )
    .await;
    let mut opencode = manifest("opencode", "OpenCode");
    opencode.resolved.executable =
        PathBuf::from("/opt/homebrew/lib/node_modules/opencode-ai/dist/cli.js");
    opencode.resolved.argv = vec!["acp".to_string()];
    let mut manager =
        AgentManager::from_start_results("opencode".to_string(), vec![(opencode, Ok(connection))])
            .await
            .expect("manager");
    manager
        .agents
        .get_mut("opencode")
        .expect("OpenCode runtime")
        .http_base = Some("http://127.0.0.1:4096".to_string());

    let capabilities = manager
        .list_agents()
        .into_iter()
        .find(|agent| agent.agent_id == "opencode")
        .and_then(|agent| agent.capabilities)
        .expect("OpenCode capabilities");
    assert!(capabilities.session_fork);

    manager.shutdown().await;
}

#[tokio::test]
async fn manager_rejects_native_forks_that_reuse_source_or_existing_ids() {
    let connection = native_extension_connection("native-agent").await;
    let session = connection
        .0
        .ensure_session(SessionId::new("source"))
        .await
        .expect("source session");
    let manager = AgentManager::from_start_results(
        "native-agent".to_string(),
        vec![(manifest("native-agent", "Native"), Ok(connection))],
    )
    .await
    .expect("manager");
    let identity = AgentSessionId::new("native-agent", "source").unwrap();
    let thread_id = identity.encode();
    manager
        .session_index
        .lock()
        .await
        .insert_all([
            index_entry(
                AgentSessionId::new("a-agent", "source").unwrap(),
                PathBuf::from("/tmp"),
            ),
            index_entry(
                AgentSessionId::new("native-agent", "aaa").unwrap(),
                PathBuf::from("/tmp"),
            ),
            index_entry(identity, PathBuf::from("/tmp")),
            index_entry(
                AgentSessionId::new("native-agent", "existing").unwrap(),
                PathBuf::from("/tmp"),
            ),
        ])
        .await
        .expect("source index");
    for id in ["first-id", "source-id", "existing-id"] {
        session
            .emit(CanonicalEvent::MessageChunk {
                agent_id: "native-agent".to_string(),
                thread_id: thread_id.clone(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::User,
                message_id: id.to_string(),
                content: id.to_string(),
                content_block: None,
            })
            .await;
    }

    assert!(matches!(
        manager.fork_session(&thread_id, "source-id").await,
        Err(AgentManagerError::Fork(_))
    ));
    assert!(matches!(
        manager.fork_session(&thread_id, "existing-id").await,
        Err(AgentManagerError::Fork(_))
    ));
    let (generation, _) = session
        .admit_prompt("run".to_string(), "turn".to_string())
        .await
        .expect("native prompt");
    let epoch = manager
        .prepare_steer(&thread_id)
        .await
        .expect("prepare native steer");
    manager
        .steer(
            &thread_id,
            "run".to_string(),
            "turn".to_string(),
            generation,
            epoch,
            Vec::new(),
        )
        .await
        .expect("native steer");
    manager.shutdown().await;
}

async fn connection(
    agent_id: &str,
    supports_list: bool,
    listed_session: &str,
    observed: mpsc::UnboundedSender<String>,
) -> (AcpConnection, NegotiatedInitialize) {
    let listed_session = listed_session.to_string();
    let new_session = format!("{agent_id}-new");
    let prompt_agent = agent_id.to_string();
    let cancel_agent = agent_id.to_string();
    let capabilities = if supports_list {
        AgentCapabilities::new()
            .session_capabilities(SessionCapabilities::new().list(SessionListCapabilities::new()))
    } else {
        AgentCapabilities::new()
    };
    let agent = Agent
        .v1()
        .on_receive_request(
            async move |request: InitializeRequest, responder, _| {
                responder.respond(
                    InitializeResponse::new(request.protocol_version)
                        .agent_capabilities(capabilities.clone()),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: NewSessionRequest, responder, _| {
                responder.respond(NewSessionResponse::new(new_session.clone()))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: ListSessionsRequest, responder, _| {
                responder.respond(ListSessionsResponse::new(vec![SessionInfo::new(
                    listed_session.clone(),
                    "/tmp",
                )]))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let observed = observed.clone();
                async move |_request: PromptRequest, responder, _| {
                    let _ = observed.send(format!("prompt:{prompt_agent}"));
                    responder.respond(PromptResponse::new(StopReason::EndTurn))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            async move |_request: CancelNotification, _| {
                let _ = observed.send(format!("cancel:{cancel_agent}"));
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        );
    AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
        .await
        .expect("test agent starts")
}

async fn connection_with_capabilities(
    agent_id: &str,
    capabilities: AgentCapabilities,
    observed: mpsc::UnboundedSender<String>,
) -> (AcpConnection, NegotiatedInitialize) {
    let load_agent = agent_id.to_string();
    let resume_agent = agent_id.to_string();
    let agent = Agent
        .v1()
        .on_receive_request(
            async move |request: InitializeRequest, responder, _| {
                responder.respond(
                    InitializeResponse::new(request.protocol_version)
                        .agent_capabilities(capabilities.clone()),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let observed = observed.clone();
                async move |_request: LoadSessionRequest, responder, _| {
                    let _ = observed.send(format!("load:{load_agent}"));
                    responder.respond(LoadSessionResponse::new())
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: ResumeSessionRequest, responder, _| {
                let _ = observed.send(format!("resume:{resume_agent}"));
                responder.respond(ResumeSessionResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        );
    AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
        .await
        .expect("capability agent starts")
}

async fn mcp_observing_connection(
    agent_id: &str,
    capabilities: McpCapabilities,
    observed: mpsc::UnboundedSender<serde_json::Value>,
) -> (AcpConnection, NegotiatedInitialize) {
    let session_id = format!("{agent_id}-session");
    let agent = Agent
        .v1()
        .on_receive_request(
            async move |request: InitializeRequest, responder, _| {
                responder.respond(
                    InitializeResponse::new(request.protocol_version).agent_capabilities(
                        AgentCapabilities::new().mcp_capabilities(capabilities.clone()),
                    ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: NewSessionRequest, responder, _| {
                observed
                    .send(
                        serde_json::to_value(request.mcp_servers)
                            .expect("serialize observed MCP servers"),
                    )
                    .expect("observe MCP servers");
                responder.respond(NewSessionResponse::new(session_id.clone()))
            },
            agent_client_protocol::on_receive_request!(),
        );
    AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
        .await
        .expect("MCP-observing agent starts")
}

async fn deleting_connection(
    agent_id: &str,
    supports_delete: bool,
    supports_close: bool,
    observed: mpsc::UnboundedSender<String>,
) -> (AcpConnection, NegotiatedInitialize) {
    deleting_connection_with_catalog(agent_id, supports_delete, supports_close, true, observed)
        .await
}

async fn deleting_connection_with_catalog(
    agent_id: &str,
    supports_delete: bool,
    supports_close: bool,
    supports_list: bool,
    observed: mpsc::UnboundedSender<String>,
) -> (AcpConnection, NegotiatedInitialize) {
    let mut session_capabilities = SessionCapabilities::new();
    if supports_list {
        session_capabilities = session_capabilities.list(SessionListCapabilities::new());
    }
    if supports_delete {
        session_capabilities = session_capabilities.delete(SessionDeleteCapabilities::new());
    }
    if supports_close {
        session_capabilities = session_capabilities.close(SessionCloseCapabilities::new());
    }
    let capabilities = AgentCapabilities::new().session_capabilities(session_capabilities);
    let listed_agent = agent_id.to_string();
    let delete_agent = agent_id.to_string();
    let close_agent = agent_id.to_string();
    let deleted = Arc::new(AtomicBool::new(false));
    let listed_deleted = deleted.clone();
    let agent = Agent
        .v1()
        .on_receive_request(
            async move |request: InitializeRequest, responder, _| {
                responder.respond(
                    InitializeResponse::new(request.protocol_version)
                        .agent_capabilities(capabilities.clone()),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: ListSessionsRequest, responder, _| {
                let sessions = if listed_deleted.load(Ordering::SeqCst) {
                    Vec::new()
                } else {
                    vec![SessionInfo::new(format!("{listed_agent}-listed"), "/tmp")]
                };
                responder.respond(ListSessionsResponse::new(sessions))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let observed = observed.clone();
                async move |request: DeleteSessionRequest, responder, _| {
                    let _ = observed.send(format!("delete:{delete_agent}:{}", request.session_id));
                    deleted.store(true, Ordering::SeqCst);
                    responder.respond(DeleteSessionResponse::new())
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let observed = observed.clone();
                async move |request: CloseSessionRequest, responder, _| {
                    let _ = observed.send(format!("close:{close_agent}:{}", request.session_id));
                    responder.respond(CloseSessionResponse::new())
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: PromptRequest, responder, _| {
                responder.respond(PromptResponse::new(StopReason::EndTurn))
            },
            agent_client_protocol::on_receive_request!(),
        );
    AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
        .await
        .expect("deleting agent starts")
}

async fn post_apply_deleting_connection(
    agent_id: &str,
    observed: mpsc::UnboundedSender<String>,
) -> (AcpConnection, NegotiatedInitialize) {
    let deleted = Arc::new(AtomicBool::new(false));
    let listed_agent = agent_id.to_string();
    let listed_deleted = deleted.clone();
    let delete_agent = agent_id.to_string();
    let delete_applied = deleted.clone();
    let agent = Agent
        .v1()
        .on_receive_request(
            async move |request: InitializeRequest, responder, _| {
                responder.respond(
                    InitializeResponse::new(request.protocol_version).agent_capabilities(
                        AgentCapabilities::new().session_capabilities(
                            SessionCapabilities::new()
                                .list(SessionListCapabilities::new())
                                .delete(SessionDeleteCapabilities::new()),
                        ),
                    ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: ListSessionsRequest, responder, _| {
                let sessions = if listed_deleted.load(Ordering::Acquire) {
                    Vec::new()
                } else {
                    vec![SessionInfo::new(format!("{listed_agent}-listed"), "/tmp")]
                };
                responder.respond(ListSessionsResponse::new(sessions))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: DeleteSessionRequest, responder, _| {
                delete_applied.store(true, Ordering::Release);
                let _ = observed.send(format!("delete:{delete_agent}:{}", request.session_id));
                responder.respond(DeleteSessionResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        );
    AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
        .await
        .expect("post-apply deleting agent starts")
}

async fn native_extension_connection(agent_id: &str) -> (AcpConnection, NegotiatedInitialize) {
    let agent = Agent
        .v1()
        .on_receive_request(
            async move |request: InitializeRequest, responder, _| {
                let mut response = InitializeResponse::new(request.protocol_version)
                    .agent_capabilities(AgentCapabilities::new().session_capabilities(
                        SessionCapabilities::new().delete(SessionDeleteCapabilities::new()),
                    ));
                response.meta = serde_json::from_value(serde_json::json!({
                    "dappercode.dev": {
                        "version": 1,
                        "capabilities": {
                            "sessionSteer": {
                                "method": "_dappercode.dev/session/steer",
                                "version": 1
                            },
                            "sessionFork": {
                                "method": "_dappercode.dev/session/fork",
                                "version": 1
                            }
                        }
                    }
                }))
                .ok();
                responder.respond(response)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ForkRequest, responder, _| {
                let session_id = match request.message_id.as_deref() {
                    Some("source-id") => request.session_id,
                    Some("existing-id") => SessionId::new("existing"),
                    _ => SessionId::new("forked"),
                };
                responder.respond(crate::acp::runtime::ForkResponse {
                    session_id,
                    title: Some("Forked".to_string()),
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: SteerRequest, responder, _| {
                responder.respond(crate::acp::runtime::SteerResponse { accepted: true })
            },
            agent_client_protocol::on_receive_request!(),
        );
    AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
        .await
        .expect("native extension agent starts")
}

#[derive(Clone)]
struct OpenCodeDeleteServerState {
    observed: mpsc::UnboundedSender<(String, Option<String>)>,
    status: AxumStatusCode,
    delete_removes: bool,
    deleted: Arc<AtomicBool>,
}

async fn handle_opencode_delete(
    AxumPath(session_id): AxumPath<String>,
    Query(query): Query<HashMap<String, String>>,
    State(state): State<OpenCodeDeleteServerState>,
) -> AxumStatusCode {
    let _ = state
        .observed
        .send((session_id, query.get("directory").cloned()));
    if state.status.is_success() && state.delete_removes {
        state.deleted.store(true, Ordering::SeqCst);
    }
    state.status
}

async fn handle_opencode_get(
    AxumPath(session_id): AxumPath<String>,
    State(state): State<OpenCodeDeleteServerState>,
) -> Result<Json<serde_json::Value>, AxumStatusCode> {
    if state.deleted.load(Ordering::SeqCst) {
        Err(AxumStatusCode::NOT_FOUND)
    } else {
        Ok(Json(serde_json::json!({ "id": session_id })))
    }
}

async fn opencode_delete_server(
    status: AxumStatusCode,
    delete_removes: bool,
) -> (
    String,
    mpsc::UnboundedReceiver<(String, Option<String>)>,
    tokio::task::JoinHandle<()>,
) {
    let (observed, observed_rx) = mpsc::unbounded_channel();
    let deleted = Arc::new(AtomicBool::new(false));
    let app = Router::new()
        .route(
            "/session/{session_id}",
            delete(handle_opencode_delete).get(handle_opencode_get),
        )
        .with_state(OpenCodeDeleteServerState {
            observed,
            status,
            delete_removes,
            deleted,
        });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind OpenCode delete fixture");
    let base = format!(
        "http://{}",
        listener.local_addr().expect("fixture local address"),
    );
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve OpenCode delete fixture");
    });
    (base, observed_rx, task)
}

async fn reconstructing_connection(
    agent_id: &str,
    capabilities: AgentCapabilities,
    requests: Arc<std::sync::atomic::AtomicUsize>,
    fail: bool,
    response_barrier: Option<Arc<(tokio::sync::Notify, tokio::sync::Notify)>>,
) -> (AcpConnection, NegotiatedInitialize) {
    let agent = Agent
        .v1()
        .on_receive_request(
            async move |request: InitializeRequest, responder, _| {
                responder.respond(
                    InitializeResponse::new(request.protocol_version)
                        .agent_capabilities(capabilities.clone()),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let requests = requests.clone();
                let response_barrier = response_barrier.clone();
                async move |request: LoadSessionRequest, responder, connection| {
                    requests.fetch_add(1, Ordering::SeqCst);
                    if let Some(barrier) = &response_barrier {
                        barrier.0.notify_one();
                        barrier.1.notified().await;
                    }
                    if fail {
                        return responder
                            .respond_with_error(agent_client_protocol::Error::internal_error());
                    }
                    let update = serde_json::from_value(serde_json::json!({
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "restored"},
                        "messageId": "restored-message"
                    }))
                    .expect("typed update");
                    connection.send_notification(
                        agent_client_protocol::v1::schema::SessionNotification::new(
                            request.session_id,
                            update,
                        ),
                    )?;
                    responder.respond(LoadSessionResponse::new())
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let requests = requests.clone();
                let response_barrier = response_barrier.clone();
                async move |_: ResumeSessionRequest, responder, _| {
                    requests.fetch_add(1, Ordering::SeqCst);
                    if let Some(barrier) = &response_barrier {
                        barrier.0.notify_one();
                        barrier.1.notified().await;
                    }
                    if fail {
                        return responder
                            .respond_with_error(agent_client_protocol::Error::internal_error());
                    }
                    responder.respond(ResumeSessionResponse::new())
                }
            },
            agent_client_protocol::on_receive_request!(),
        );
    AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
        .await
        .expect("reconstructing agent starts")
}

async fn paginated_connection(agent_id: &str) -> (AcpConnection, NegotiatedInitialize) {
    let agent = Agent
        .v1()
        .on_receive_request(
            async move |request: InitializeRequest, responder, _| {
                responder.respond(
                    InitializeResponse::new(request.protocol_version).agent_capabilities(
                        AgentCapabilities::new().session_capabilities(
                            SessionCapabilities::new().list(SessionListCapabilities::new()),
                        ),
                    ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ListSessionsRequest, responder, _| {
                let response = if request.cursor.as_deref() == Some("page-2") {
                    ListSessionsResponse::new(vec![
                        SessionInfo::new("alpha", "/tmp"),
                        SessionInfo::new("duplicate", "/tmp"),
                    ])
                    .next_cursor("page-2")
                } else {
                    ListSessionsResponse::new(vec![
                        SessionInfo::new("zulu", "/tmp"),
                        SessionInfo::new("duplicate", "/tmp"),
                        SessionInfo::new("", "/tmp"),
                        SessionInfo::new(
                            "invalid-cwd",
                            "/definitely/missing/dappercode-remote-workspace",
                        ),
                    ])
                    .next_cursor("page-2")
                };
                responder.respond(response)
            },
            agent_client_protocol::on_receive_request!(),
        );
    AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
        .await
        .expect("paginated agent starts")
}

#[derive(Clone, Copy)]
enum PaginationFixture {
    Endless,
    Empty,
    DuplicateOnly,
    MaxSessions,
    Failure,
}

async fn adversarial_paginated_connection(
    agent_id: &str,
    fixture: PaginationFixture,
    requests: Arc<std::sync::atomic::AtomicUsize>,
) -> (AcpConnection, NegotiatedInitialize) {
    let agent = Agent
        .v1()
        .on_receive_request(
            async move |request: InitializeRequest, responder, _| {
                responder.respond(
                    InitializeResponse::new(request.protocol_version).agent_capabilities(
                        AgentCapabilities::new().session_capabilities(
                            SessionCapabilities::new().list(SessionListCapabilities::new()),
                        ),
                    ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: ListSessionsRequest, responder, _| {
                let request = requests.fetch_add(1, Ordering::SeqCst);
                let response = match fixture {
                    PaginationFixture::Endless => {
                        ListSessionsResponse::new(vec![SessionInfo::new(
                            format!("session-{request}"),
                            "/tmp",
                        )])
                        .next_cursor(format!("cursor-{request}"))
                    }
                    PaginationFixture::Empty => ListSessionsResponse::new(Vec::new())
                        .next_cursor(format!("cursor-{request}")),
                    PaginationFixture::DuplicateOnly => {
                        ListSessionsResponse::new(vec![SessionInfo::new("duplicate", "/tmp")])
                            .next_cursor(format!("cursor-{request}"))
                    }
                    PaginationFixture::MaxSessions => ListSessionsResponse::new(
                        (0..MAX_SESSIONS)
                            .map(|index| SessionInfo::new(format!("session-{index}"), "/tmp"))
                            .collect(),
                    ),
                    PaginationFixture::Failure => {
                        return responder
                            .respond_with_error(agent_client_protocol::Error::internal_error())
                    }
                };
                responder.respond(response)
            },
            agent_client_protocol::on_receive_request!(),
        );
    AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
        .await
        .expect("adversarial paginated agent starts")
}

#[test]
fn local_manifest_set_rejects_duplicates_missing_preferred_and_empty_enabled_set() {
    let alpha = manifest("alpha-orbit", "Alpha Orbit");
    let roots = [test_executable_root(&alpha.resolved.executable)];
    let duplicate = LocalAgentManifestSet {
        preferred_agent_id: "alpha-orbit".into(),
        agents: vec![alpha.clone(), alpha.clone()],
    };
    assert!(duplicate.validate(&roots).is_err());
    let missing = LocalAgentManifestSet {
        preferred_agent_id: "missing".into(),
        agents: vec![alpha.clone()],
    };
    assert!(missing.validate(&roots).is_err());
    let mut disabled = alpha;
    disabled.enabled = false;
    let empty = LocalAgentManifestSet {
        preferred_agent_id: "alpha-orbit".into(),
        agents: vec![disabled],
    };
    assert!(empty.validate(&roots).is_err());
}

#[test]
fn local_manifest_requires_executable_digest_and_typed_integrity() {
    let roots = [test_executable_root(
        &manifest("alpha-orbit", "Alpha Orbit").resolved.executable,
    )];
    let value = serde_json::to_value(LocalAgentManifestSet {
        preferred_agent_id: "alpha-orbit".into(),
        agents: vec![manifest("alpha-orbit", "Alpha Orbit")],
    })
    .expect("serialize manifest");
    let mut missing = value.clone();
    missing["agents"][0]
        .as_object_mut()
        .expect("agent object")
        .remove("verifiedDigest");
    assert!(LocalAgentManifestSet::parse(
        &serde_json::to_string(&missing).expect("serialize missing digest"),
        &roots
    )
    .is_err());

    let mut missing_integrity = value;
    missing_integrity["agents"][0]
        .as_object_mut()
        .expect("agent object")
        .remove("integrity");
    assert!(LocalAgentManifestSet::parse(
        &serde_json::to_string(&missing_integrity).expect("serialize missing integrity"),
        &roots
    )
    .is_err());
}

#[tokio::test]
async fn preferred_failure_is_fatal_and_nonpreferred_failure_is_visible_and_redacted() {
    let preferred = manifest("alpha-orbit", "Alpha Orbit");
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let sibling = connection("beta-lab", false, "unused", observed_tx).await;
    let result = AgentManager::from_start_results(
        "alpha-orbit".into(),
        vec![
            (manifest("beta-lab", "Beta Lab"), Ok(sibling)),
            (
                preferred,
                Err(AcpRuntimeError::Connection("/secret/token=value".into())),
            ),
        ],
    )
    .await;
    assert!(matches!(result, Err(AgentManagerError::PreferredStart(_))));

    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let ready = connection("alpha-orbit", false, "unused", observed_tx).await;
    let manager = AgentManager::from_start_results(
        "alpha-orbit".into(),
        vec![
            (manifest("alpha-orbit", "Alpha Orbit"), Ok(ready)),
            (
                manifest("beta-lab", "Beta Lab"),
                Err(AcpRuntimeError::Connection("/secret/token=value".into())),
            ),
        ],
    )
    .await
    .expect("nonpreferred failure is nonfatal");
    let beta = manager
        .list_agents()
        .into_iter()
        .find(|agent| agent.agent_id == "beta-lab")
        .unwrap();
    assert_eq!(beta.lifecycle, AgentLifecycle::Unavailable);
    assert_eq!(
        beta.last_error.as_deref(),
        Some("ACP agent startup failed (details redacted)"),
    );
    assert!(!serde_json::to_string(&beta).unwrap().contains("secret"));
}

#[tokio::test]
async fn generic_routing_opaque_pagination_fallback_interactions_and_shutdown() {
    let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
    let alpha = connection("alpha-orbit", true, "alpha-history", observed_tx.clone()).await;
    let beta = connection("beta-lab", false, "unused", observed_tx).await;
    let manager = AgentManager::from_start_results(
        "alpha-orbit".into(),
        vec![
            (manifest("alpha-orbit", "Alpha Orbit"), Ok(alpha)),
            (manifest("beta-lab", "Beta Lab"), Ok(beta)),
        ],
    )
    .await
    .expect("manager starts");
    assert_eq!(manager.preferred_agent_id(), "alpha-orbit");
    assert_eq!(manager.list_agents().len(), 2);

    let beta_session = manager
        .new_session("beta-lab", NewSessionRequest::new("/tmp"))
        .await
        .expect("explicit beta session");
    let decoded = AgentSessionId::decode(&beta_session.thread_id).unwrap();
    assert_eq!(decoded.agent_id, "beta-lab");
    assert_eq!(decoded.acp_session_id, "beta-lab-new");

    assert_eq!(
        manager.loaded_session_ids().await,
        vec![beta_session.thread_id.clone()],
    );

    let first_page = manager.list_sessions(None, 1).await.unwrap();
    assert_eq!(first_page.sessions.len(), 1);
    assert_eq!(first_page.next_cursor, Some(encode_cursor(1)));
    let second_page = manager
        .list_sessions(Some(&encode_cursor(1)), 100)
        .await
        .unwrap();
    assert_eq!(second_page.sessions.len(), 1);
    let listed = [
        first_page.sessions[0].clone(),
        second_page.sessions[0].clone(),
    ];
    assert!(listed.iter().any(|session| {
        AgentSessionId::decode(&session.thread_id)
            .is_ok_and(|identity| identity.acp_session_id == "alpha-history")
    }));
    assert!(listed
        .iter()
        .any(|session| session.thread_id == beta_session.thread_id));
    assert_eq!(
        manager.loaded_session_ids().await,
        vec![beta_session.thread_id.clone()],
    );

    let fallback_id = AgentSessionId::new("beta-lab", "opaque/unknown:session")
        .unwrap()
        .encode();
    assert!(matches!(
        manager.read_session(&fallback_id).await,
        Err(AgentManagerError::Runtime(AcpRuntimeError::UnknownSession(
            _
        )))
    ));
    assert_eq!(
        manager.loaded_session_ids().await,
        vec![beta_session.thread_id.clone()],
    );
    assert!(matches!(
        manager.resume_session(&fallback_id, "/tmp").await,
        Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
            "session/resume or session/load"
        )))
    ));

    let mut events = manager.take_events().await.expect("manager event receiver");
    manager
        .prompt(
            &beta_session.thread_id,
            vec!["hello".into()],
            "run-beta".into(),
            "turn-beta".into(),
        )
        .await
        .unwrap();
    assert_eq!(observed_rx.recv().await.as_deref(), Some("prompt:beta-lab"));
    let started = events.recv().await.unwrap();
    assert!(
        matches!(started, CanonicalEvent::RunStarted { agent_id, .. } if agent_id == "beta-lab"),
    );
    assert!(matches!(
        manager.cancel_turn("invalid-thread", "turn-beta").await,
        Err(AgentManagerError::InvalidThreadId)
    ));
    let unavailable = AgentSessionId::new("offline-agent", "session")
        .unwrap()
        .encode();
    assert!(matches!(
        manager.cancel_turn(&unavailable, "turn-beta").await,
        Err(AgentManagerError::UnknownAgent(_))
    ));
    manager
        .prepare_steer(&beta_session.thread_id)
        .await
        .unwrap();
    assert!(manager.pending_permissions().await.is_empty());
    assert!(manager.pending_elicitations().await.is_empty());
    let _ = manager.read_session("invalid-thread").await;
    let _ = manager.read_session(&unavailable).await;

    manager.shutdown().await;
    assert!(manager
        .list_agents()
        .iter()
        .all(|agent| agent.lifecycle == AgentLifecycle::Stopped));
    manager.shutdown().await;
}

#[test]
fn local_manifest_set_validates_counts_descriptors_and_enabled_agents() {
    let roots = [test_executable_root(
        &manifest("alpha", "Alpha").resolved.executable,
    )];
    let empty = LocalAgentManifestSet {
        preferred_agent_id: "alpha".to_string(),
        agents: Vec::new(),
    };
    assert!(empty.validate(&roots).is_err());

    let oversized = LocalAgentManifestSet {
        preferred_agent_id: "agent-0".to_string(),
        agents: (0..=MAX_AGENTS)
            .map(|index| manifest(&format!("agent-{index}"), "Agent"))
            .collect(),
    };
    assert!(oversized.validate(&roots).is_err());

    let mut invalid_enabled = manifest("alpha", "Alpha");
    invalid_enabled.resolved.executable = PathBuf::from("/does/not/exist");
    let invalid_enabled = LocalAgentManifestSet {
        preferred_agent_id: "alpha".to_string(),
        agents: vec![invalid_enabled],
    };
    assert!(invalid_enabled.validate(&roots).is_err());

    let mut disabled_invalid = manifest("disabled", "Disabled");
    disabled_invalid.enabled = false;
    disabled_invalid.resolved.executable = PathBuf::from("/does/not/exist");
    let disabled_invalid = LocalAgentManifestSet {
        preferred_agent_id: "alpha".to_string(),
        agents: vec![manifest("alpha", "Alpha"), disabled_invalid],
    };
    assert!(disabled_invalid.validate(&roots).is_ok());

    let blank_name_agent = manifest("alpha", " ");
    let blank_name = LocalAgentManifestSet {
        preferred_agent_id: "alpha".to_string(),
        agents: vec![blank_name_agent],
    };
    assert!(blank_name.validate(&roots).is_err());
    let long_name_agent = manifest("alpha", &"x".repeat(257));
    let long_name = LocalAgentManifestSet {
        preferred_agent_id: "alpha".to_string(),
        agents: vec![long_name_agent],
    };
    assert!(long_name.validate(&roots).is_err());

    let mut bad_icon = manifest("alpha", "Alpha");
    bad_icon.icon = Some("bad\0icon".to_string());
    let bad_icon = LocalAgentManifestSet {
        preferred_agent_id: "alpha".to_string(),
        agents: vec![bad_icon],
    };
    assert!(bad_icon.validate(&roots).is_err());
    let mut long_icon = manifest("alpha", "Alpha");
    long_icon.icon = Some("x".repeat(2_049));
    let long_icon = LocalAgentManifestSet {
        preferred_agent_id: "alpha".to_string(),
        agents: vec![long_icon],
    };
    assert!(long_icon.validate(&roots).is_err());

    let mut long_version = manifest("alpha", "Alpha");
    long_version.resolved.resolved_version = "x".repeat(2_049);
    let long_version = LocalAgentManifestSet {
        preferred_agent_id: "alpha".to_string(),
        agents: vec![long_version],
    };
    assert!(long_version.validate(&roots).is_err());
    let mut long_provenance = manifest("alpha", "Alpha");
    long_provenance.resolved.provenance = "x".repeat(2_049);
    let long_provenance = LocalAgentManifestSet {
        preferred_agent_id: "alpha".to_string(),
        agents: vec![long_provenance],
    };
    assert!(long_provenance.validate(&roots).is_err());
}

#[test]
fn local_manifest_parse_load_and_cursor_validation_are_strict() {
    let roots = [test_executable_root(
        &manifest("alpha", "Alpha").resolved.executable,
    )];
    assert!(LocalAgentManifestSet::parse("not json", &roots).is_err());
    assert!(LocalAgentManifestSet::load(Path::new("/does/not/exist"), &roots).is_err());
    assert_eq!(decode_cursor(None).unwrap(), 0);
    assert_eq!(decode_cursor(Some(&encode_cursor(42))).unwrap(), 42);
    assert!(decode_cursor(Some("v0.invalid")).is_err());
    assert!(decode_cursor(Some("v1.invalid")).is_err());
    assert!(decode_cursor(Some(&encode_cursor(MAX_SESSIONS + 1))).is_err());
    let overflow = format!("v1.{}", URL_SAFE_NO_PAD.encode(u64::MAX.to_be_bytes()));
    assert!(decode_cursor(Some(&overflow)).is_err());
    let wraps_on_32_bit = format!(
        "v1.{}",
        URL_SAFE_NO_PAD.encode((u64::from(u32::MAX) + 1).to_be_bytes()),
    );
    assert!(decode_cursor(Some(&wraps_on_32_bit)).is_err());
    assert_eq!(
        redact_error(&AcpRuntimeError::Connection("secret".to_string())),
        "ACP agent startup failed (details redacted)",
    );
}

#[tokio::test]
async fn manager_reports_unknown_unavailable_and_invalid_routes() {
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection("alpha", false, "unused", observed).await;
    let manager = AgentManager::from_start_results(
        "alpha".to_string(),
        vec![
            (manifest("alpha", "Alpha"), Ok(ready)),
            (
                manifest("beta", "Beta"),
                Err(AcpRuntimeError::Connection("failed".to_string())),
            ),
        ],
    )
    .await
    .unwrap();
    assert!(matches!(
        manager
            .new_session("missing", NewSessionRequest::new("/tmp"))
            .await,
        Err(AgentManagerError::UnknownAgent(_))
    ));
    assert!(matches!(
        manager
            .new_session("beta", NewSessionRequest::new("/tmp"))
            .await,
        Err(AgentManagerError::AgentUnavailable(_))
    ));
    assert!(matches!(
        manager.read_session("invalid").await,
        Err(AgentManagerError::InvalidThreadId)
    ));
    assert!(matches!(
        manager.list_sessions(Some("invalid"), 0).await,
        Err(AgentManagerError::InvalidCursor)
    ));
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_merges_remote_history_but_loaded_list_remains_live_only() {
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection("alpha", true, "remote-history", observed).await;
    let manager = AgentManager::from_start_results(
        "alpha".to_string(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .unwrap();
    let remote = manager.list_sessions(None, 100).await.unwrap().sessions;
    assert_eq!(remote.len(), 1);
    assert_eq!(
        AgentSessionId::decode(&remote[0].thread_id)
            .unwrap()
            .acp_session_id,
        "remote-history",
    );
    assert!(manager.loaded_session_ids().await.is_empty());
    assert_eq!(
        manager
            .list_sessions_for(None, 100, Some("alpha"))
            .await
            .unwrap()
            .sessions
            .len(),
        1,
    );
    assert!(manager
        .list_sessions_for(None, 100, Some("missing"))
        .await
        .unwrap()
        .sessions
        .is_empty());
    let created = manager
        .new_session("alpha", NewSessionRequest::new("/tmp"))
        .await
        .unwrap();
    let created_again = manager.read_session(&created.thread_id).await.unwrap();
    assert_eq!(created_again.thread_id, created.thread_id);
    let sessions = manager.list_sessions(None, 100).await.unwrap().sessions;
    assert_eq!(sessions.len(), 2);
    assert_eq!(
        sessions
            .iter()
            .filter(|session| session.thread_id == created.thread_id)
            .count(),
        1,
    );
    assert_eq!(manager.loaded_session_ids().await, vec![created.thread_id]);
    manager.shutdown().await;
}

#[tokio::test]
async fn retirement_reconciliation_distinguishes_live_absent_and_mixed_indexed_sessions() {
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection("alpha", true, "live-session", observed).await;
    let manager = AgentManager::from_start_results(
        "alpha".to_string(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .unwrap();
    let live = AgentSessionId::new("alpha", "live-session").unwrap();
    let absent = AgentSessionId::new("alpha", "absent-session").unwrap();
    let absent_child = AgentSessionId::new("alpha", "absent-child").unwrap();
    let cwd = std::env::current_dir().unwrap();
    let mut absent_child_entry = index_entry(absent_child.clone(), cwd.clone());
    absent_child_entry.parent_acp_session_id = Some(absent.acp_session_id.clone());
    manager
        .session_index
        .lock()
        .await
        .insert_all([
            index_entry(live.clone(), cwd.clone()),
            index_entry(absent.clone(), cwd),
            absent_child_entry,
        ])
        .await
        .unwrap();
    manager
        .connection("alpha")
        .unwrap()
        .ensure_session(SessionId::new(absent.acp_session_id.clone()))
        .await
        .expect("seed a stale locally cached session");

    assert_eq!(
        manager.reconcile_retirement_plan(&[live.encode()]).await,
        RetirementPlanReconciliation::Present,
    );
    assert_eq!(
        manager.reconcile_retirement_plan(&[absent.encode()]).await,
        RetirementPlanReconciliation::Absent,
    );
    let mut expanded_absent = vec![absent.encode(), absent_child.encode()];
    expanded_absent.sort();
    assert_eq!(
        manager
            .expand_retirement_family(&[absent.encode()])
            .await
            .unwrap(),
        expanded_absent,
    );
    assert_eq!(
        manager
            .reconcile_retirement_plan(&[live.encode(), absent.encode()])
            .await,
        RetirementPlanReconciliation::Indeterminate,
    );
    manager
        .finalize_confirmed_deleted_sessions(&[absent.encode()])
        .await
        .unwrap();
    manager
        .finalize_confirmed_deleted_sessions(&[absent.encode()])
        .await
        .unwrap();
    assert!(!manager
        .session_index
        .lock()
        .await
        .entries
        .iter()
        .any(|entry| entry.acp_session_id == "absent-session"));
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_preserves_remote_session_summary_metadata() {
    let agent = Agent
        .v1()
        .on_receive_request(
            async move |request: InitializeRequest, responder, _| {
                responder.respond(
                    InitializeResponse::new(request.protocol_version).agent_capabilities(
                        AgentCapabilities::new().session_capabilities(
                            SessionCapabilities::new().list(SessionListCapabilities::new()),
                        ),
                    ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: ListSessionsRequest, responder, _| {
                responder.respond(ListSessionsResponse::new(vec![SessionInfo::new(
                    "summary-session",
                    "/tmp",
                )
                .title("Real session title")
                .updated_at("2026-07-21T14:17:00Z")]))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: NewSessionRequest, responder, _| {
                responder.respond(NewSessionResponse::new("summary-session"))
            },
            agent_client_protocol::on_receive_request!(),
        );
    let (connection, negotiated) =
        AcpConnection::start_transport("alpha".to_string(), agent, Duration::from_secs(1))
            .await
            .expect("summary agent starts");
    let manager = AgentManager::from_start_results(
        "alpha".to_string(),
        vec![(manifest("alpha", "Alpha"), Ok((connection, negotiated)))],
    )
    .await
    .expect("manager starts");

    let created = manager
        .new_session("alpha", NewSessionRequest::new("/tmp"))
        .await
        .expect("session created");
    let page = manager
        .list_sessions(None, 10)
        .await
        .expect("list succeeds");
    let summary = &page.sessions[0].snapshot;
    assert_eq!(summary.title.as_deref(), Some("Real session title"));
    assert_eq!(summary.updated_at.as_deref(), Some("2026-07-21T14:17:00Z"));
    assert_eq!(summary.thread_id, created.thread_id);

    let renamed = manager
        .rename_session(&created.thread_id, "Manual title")
        .await
        .expect("session renamed");
    assert_eq!(renamed.snapshot.title.as_deref(), Some("Manual title"));
    let refreshed = manager
        .list_sessions(None, 10)
        .await
        .expect("list after rename");
    assert_eq!(
        refreshed.sessions[0].snapshot.title.as_deref(),
        Some("Manual title"),
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn discovered_subagent_inherits_parent_workspace_and_loads() {
    let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
    let ready = connection_with_capabilities(
        "alpha",
        AgentCapabilities::new().load_session(true),
        observed_tx,
    )
    .await;
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .expect("manager starts");
    let parent = AgentSessionId::new("alpha", "parent-session").unwrap();
    let parent_thread_id = parent.encode();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry_with_policy(
            parent.clone(),
            PathBuf::from("/tmp"),
            ApprovalPolicy::Never,
        )])
        .await
        .unwrap();

    let child_thread_id = manager
        .adopt_related_session(&parent_thread_id, "child-session", Some("Child task"))
        .await
        .expect("child adopted");
    let child = manager
        .read_session(&child_thread_id)
        .await
        .expect("child loads through ACP");
    assert_eq!(child.cwd, PathBuf::from("/tmp"));
    assert_eq!(
        child.parent_thread_id.as_deref(),
        Some(parent_thread_id.as_str()),
    );
    assert_eq!(
        AgentSessionId::decode(&child.thread_id)
            .unwrap()
            .acp_session_id,
        "child-session",
    );
    assert_eq!(
        manager
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| entry.acp_session_id == "child-session")
            .expect("child indexed")
            .approval_policy,
        ApprovalPolicy::Never,
    );
    assert_eq!(
        manager
            .connection("alpha")
            .unwrap()
            .approval_policy(&SessionId::new("child-session"))
            .await,
        ApprovalPolicy::Never,
    );
    assert_eq!(observed_rx.recv().await.as_deref(), Some("load:alpha"));
    manager
        .session_index
        .lock()
        .await
        .set_approval_policy(&parent, ApprovalPolicy::Untrusted)
        .await
        .unwrap();
    manager
        .adopt_related_session(&parent_thread_id, "child-session", Some("Child task"))
        .await
        .expect("existing child policy refreshed");
    assert_eq!(
        manager
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| entry.acp_session_id == "child-session")
            .expect("child remains indexed")
            .approval_policy,
        ApprovalPolicy::Untrusted,
    );
    assert_eq!(
        manager
            .connection("alpha")
            .unwrap()
            .approval_policy(&SessionId::new("child-session"))
            .await,
        ApprovalPolicy::Untrusted,
    );
    manager
        .resume_session_with_policy(&parent_thread_id, "/tmp", ApprovalPolicy::OnRequest)
        .await
        .expect("parent workspace resume refreshes its family");
    assert_eq!(
        manager
            .connection("alpha")
            .unwrap()
            .approval_policy(&SessionId::new("child-session"))
            .await,
        ApprovalPolicy::OnRequest,
    );
    assert!(manager
        .session_index
        .lock()
        .await
        .entries
        .iter()
        .filter(|entry| {
            entry.acp_session_id == "parent-session" || entry.acp_session_id == "child-session"
        })
        .all(|entry| entry.approval_policy == ApprovalPolicy::OnRequest));
    manager.shutdown().await;
}

#[tokio::test]
async fn concurrent_subagent_adoption_keeps_the_canonical_parent_policy() {
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection("alpha", false, "unused", observed).await;
    let child_id = SessionId::new("shared-child");
    ready
        .0
        .ensure_session(child_id.clone())
        .await
        .expect("child session loaded");
    let manager = Arc::new(
        AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .expect("manager starts"),
    );
    let first_parent = AgentSessionId::new("alpha", "first-parent").unwrap();
    let second_parent = AgentSessionId::new("alpha", "second-parent").unwrap();
    let child = AgentSessionId::new("alpha", child_id.to_string()).unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([
            index_entry_with_policy(
                first_parent.clone(),
                PathBuf::from("/tmp"),
                ApprovalPolicy::Never,
            ),
            index_entry_with_policy(
                second_parent.clone(),
                PathBuf::from("/tmp"),
                ApprovalPolicy::Untrusted,
            ),
        ])
        .await
        .unwrap();

    let first_adoption = {
        let manager = manager.clone();
        let parent = first_parent.encode();
        let child = child.acp_session_id.clone();
        tokio::spawn(async move { manager.adopt_related_session(&parent, &child, None).await })
    };
    let second_adoption = {
        let manager = manager.clone();
        let parent = second_parent.encode();
        let child = child.acp_session_id.clone();
        tokio::spawn(async move { manager.adopt_related_session(&parent, &child, None).await })
    };
    first_adoption
        .await
        .expect("first adoption task")
        .expect("first parent discovery");
    second_adoption
        .await
        .expect("second adoption task")
        .expect("second parent discovery");

    let indexed_child = manager
        .session_index
        .lock()
        .await
        .entries
        .iter()
        .find(|entry| entry.acp_session_id == child.acp_session_id)
        .cloned()
        .expect("child remains indexed");
    let expected_policy = if indexed_child.parent_acp_session_id.as_deref()
        == Some(first_parent.acp_session_id.as_str())
    {
        ApprovalPolicy::Never
    } else if indexed_child.parent_acp_session_id.as_deref()
        == Some(second_parent.acp_session_id.as_str())
    {
        ApprovalPolicy::Untrusted
    } else {
        panic!("unexpected canonical parent");
    };
    assert_eq!(indexed_child.approval_policy, expected_policy);
    assert_eq!(
        manager
            .connection("alpha")
            .unwrap()
            .approval_policy(&child_id)
            .await,
        expected_policy,
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn global_policy_uses_the_locked_pending_to_indexed_classification() {
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection("alpha", false, "unused", observed).await;
    let manager = Arc::new(
        AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .expect("manager starts"),
    );
    let identity = AgentSessionId::new("alpha", "transitioning").unwrap();
    let thread_id = identity.encode();
    let operation = manager
        .session_operation_lock(&thread_id)
        .await
        .lock_owned()
        .await;
    manager.pending_durable_sessions.lock().await.insert(
        thread_id,
        index_entry_with_policy(
            identity.clone(),
            PathBuf::from("/tmp"),
            ApprovalPolicy::Untrusted,
        ),
    );
    let snapshot = manager.pause_next_policy_snapshot().await;
    let update = {
        let manager = manager.clone();
        tokio::spawn(async move {
            manager
                .set_all_session_approval_policies(ApprovalPolicy::Never)
                .await
        })
    };
    snapshot.wait_until_reached().await;
    let transitioned = manager
        .pending_durable_sessions
        .lock()
        .await
        .remove(&identity.encode())
        .expect("pending session");
    manager
        .session_index
        .lock()
        .await
        .insert_all([transitioned])
        .await
        .unwrap();
    snapshot.release();
    drop(operation);

    update
        .await
        .expect("policy task")
        .expect("policy update succeeds");
    assert_eq!(
        manager
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| entry.acp_session_id == identity.acp_session_id)
            .expect("session indexed")
            .approval_policy,
        ApprovalPolicy::Never,
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn committed_global_policy_succeeds_when_live_delivery_is_unavailable() {
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection("alpha", false, "unused", observed).await;
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![
            (manifest("alpha", "Alpha"), Ok(ready)),
            (
                manifest("beta", "Beta"),
                Err(AcpRuntimeError::Connection("offline".to_string())),
            ),
        ],
    )
    .await
    .expect("manager starts");
    let offline = AgentSessionId::new("beta", "offline-session").unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry_with_policy(
            offline.clone(),
            PathBuf::from("/tmp"),
            ApprovalPolicy::Untrusted,
        )])
        .await
        .unwrap();

    manager
        .set_all_session_approval_policies(ApprovalPolicy::Never)
        .await
        .expect("durably committed policy is acknowledged");
    assert_eq!(
        manager
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| entry.acp_session_id == offline.acp_session_id)
            .expect("offline session indexed")
            .approval_policy,
        ApprovalPolicy::Never,
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn parent_prompt_updates_loaded_descendant_policies_before_dispatch() {
    let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
    let ready = connection("alpha", false, "unused", observed_tx).await;
    let child_id = SessionId::new("loaded-child");
    ready
        .0
        .ensure_session(child_id.clone())
        .await
        .expect("child session loaded");
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .expect("manager starts");
    let parent = manager
        .new_session("alpha", NewSessionRequest::new("/tmp"))
        .await
        .expect("parent session created");
    let parent_identity = AgentSessionId::decode(&parent.thread_id).unwrap();
    let child_identity = AgentSessionId::new("alpha", child_id.to_string()).unwrap();
    let mut child_entry = index_entry(child_identity.clone(), PathBuf::from("/tmp"));
    child_entry.parent_acp_session_id = Some(parent_identity.acp_session_id.clone());
    manager
        .session_index
        .lock()
        .await
        .insert_all([child_entry])
        .await
        .unwrap();

    manager
        .set_all_session_approval_policies(ApprovalPolicy::OnRequest)
        .await
        .expect("global policy applied");
    assert_eq!(
        manager
            .connection("alpha")
            .unwrap()
            .approval_policy(&SessionId::new(parent_identity.acp_session_id.clone()))
            .await,
        ApprovalPolicy::OnRequest,
    );
    assert_eq!(
        manager
            .connection("alpha")
            .unwrap()
            .approval_policy(&child_id)
            .await,
        ApprovalPolicy::OnRequest,
    );

    manager
        .prompt_with_policy_outcome(
            &parent.thread_id,
            vec!["update policy".into()],
            "family-run".to_string(),
            "family-turn".to_string(),
            ApprovalPolicy::Never,
        )
        .await
        .expect("parent prompt admitted");

    assert_eq!(
        manager
            .connection("alpha")
            .unwrap()
            .approval_policy(&child_id)
            .await,
        ApprovalPolicy::Never,
    );
    let policies = manager
        .session_index
        .lock()
        .await
        .entries
        .iter()
        .map(|entry| entry.approval_policy)
        .collect::<Vec<_>>();
    assert_eq!(policies, vec![ApprovalPolicy::Never, ApprovalPolicy::Never]);
    assert_eq!(observed_rx.recv().await.as_deref(), Some("prompt:alpha"));
    manager.shutdown().await;
}

#[tokio::test]
async fn late_child_terminal_loads_and_updates_the_parent_session() {
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let ready = connection_with_capabilities(
        "alpha",
        AgentCapabilities::new().load_session(true),
        observed_tx,
    )
    .await;
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .expect("manager starts");
    let parent = AgentSessionId::new("alpha", "parent-session").unwrap();
    let parent_thread_id = parent.encode();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(parent.clone(), PathBuf::from("/tmp"))])
        .await
        .unwrap();
    manager
        .read_session(&parent_thread_id)
        .await
        .expect("parent loads");
    let (_, parent_session_id, connection) = manager.route_thread(&parent_thread_id).unwrap();
    let parent_session = connection
        .session(&parent_session_id)
        .await
        .expect("loaded parent session");
    parent_session
        .emit(CanonicalEvent::Tool {
            agent_id: "alpha".to_string(),
            thread_id: parent_thread_id.clone(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            tool_call_id: "task-1".to_string(),
            kind: ToolKind::Other,
            status: ToolCallStatus::InProgress,
            title: "Research dependency options".to_string(),
            content: FieldUpdate::Set(
                "<task id=\"child-session\" state=\"running\">\nWorking\n</task>".to_string(),
            ),
            structured_content: FieldUpdate::Set(Vec::new()),
            locations: FieldUpdate::Set(Vec::new()),
        })
        .await;
    manager
        .agent_message_journal
        .lock()
        .await
        .upsert_many(vec![(
            parent_thread_id.clone(),
            Some("task-1".to_string()),
            sent_agent_message(
                "terminal-update-message",
                &AgentSessionId::new("alpha", "child-session")
                    .unwrap()
                    .encode(),
            ),
        )])
        .await
        .unwrap();

    let child_thread_id = manager
        .adopt_related_session(&parent_thread_id, "child-session", Some("Child task"))
        .await
        .expect("child adopted");
    let updated_parent = manager
        .mark_parent_subagent_terminal(&child_thread_id, "failed")
        .await
        .expect("parent correction succeeds")
        .expect("parent was updated");
    assert_eq!(
        updated_parent.snapshot.tools["task-1"].status,
        ToolCallStatus::Failed,
    );
    assert_eq!(
        updated_parent.snapshot.subagent_header("task-1"),
        Some(r#"<task id="child-session" state="failed">"#),
    );
    assert!(updated_parent.snapshot.messages.iter().any(|message| {
        message
            .agent_message
            .as_ref()
            .is_some_and(|origin| origin.message_id == "terminal-update-message")
    }));

    manager
        .note_subagent_link(&parent_thread_id, &child_thread_id, "task-old")
        .await;
    manager.note_subagent_started(&child_thread_id, 1).await;
    manager
        .note_subagent_link(&parent_thread_id, &child_thread_id, "task-new")
        .await;
    assert!(
        manager
            .accepted_subagent_terminal(&child_thread_id, 1)
            .await
            .is_none(),
        "stale child generation was accepted for a newer retask",
    );
    manager.note_subagent_started(&child_thread_id, 2).await;
    let current = manager
        .accepted_subagent_terminal(&child_thread_id, 2)
        .await
        .expect("current child generation was rejected");
    assert_eq!(current.tool_call_id, "task-new");
    manager.shutdown().await;
}

#[tokio::test]
async fn retask_after_retired_correlation_rejects_duplicate_old_terminal() {
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let ready = connection("alpha", false, "unused", observed_tx).await;
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .expect("manager starts");

    manager
        .note_subagent_link("parent", "child", "task-1")
        .await;
    manager.note_subagent_started("child", 1).await;
    let accepted = manager
        .accepted_subagent_terminal("child", 1)
        .await
        .expect("linked terminal accepted");
    assert_eq!(accepted.tool_call_id, "task-1");
    manager.retire_subagent_link("child", "task-1").await;

    manager
        .note_subagent_link("parent", "child", "task-2")
        .await;
    assert!(
        manager
            .accepted_subagent_terminal("child", 1)
            .await
            .is_none(),
        "duplicate old terminal was accepted for the rearmed retask",
    );
    manager.note_subagent_started("child", 2).await;
    let rearmed = manager
        .accepted_subagent_terminal("child", 2)
        .await
        .expect("new link rearmed correlation");
    assert_eq!(rearmed.tool_call_id, "task-2");
    manager.shutdown().await;
}

#[tokio::test]
async fn failed_parent_correction_keeps_terminal_correlation_retryable() {
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let ready = connection("alpha", false, "unused", observed_tx).await;
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .expect("manager starts");

    manager
        .note_subagent_link("parent", "child", "task-1")
        .await;
    manager.note_subagent_started("child", 1).await;
    assert!(manager
        .accepted_subagent_terminal("child", 1)
        .await
        .is_some());
    // A failed parent correction leaves the target armed for a duplicate
    // terminal notification to retry.
    assert!(manager
        .accepted_subagent_terminal("child", 1)
        .await
        .is_some());
    manager.retire_subagent_link("child", "task-1").await;
    assert!(manager
        .accepted_subagent_terminal("child", 1)
        .await
        .is_none());
    manager.shutdown().await;
}

#[tokio::test]
async fn terminal_task_link_does_not_authorize_a_later_independent_child_run() {
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let ready = connection("alpha", false, "unused", observed_tx).await;
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .expect("manager starts");

    manager
        .note_subagent_link("parent", "child", "task-1")
        .await;
    manager.retire_subagent_link("child", "task-1").await;
    manager.note_subagent_started("child", 2).await;
    assert!(
        manager
            .accepted_subagent_terminal("child", 2)
            .await
            .is_none(),
        "terminal wrapper left correlation armed for an independent child run",
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn terminal_discovered_task_retires_manager_correlation_even_when_adoption_fails() {
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let ready = connection("alpha", false, "unused", observed_tx).await;
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .expect("manager starts");

    manager
        .note_subagent_link("parent", "child", "task-terminal")
        .await;
    manager.retire_subagent_link("child", "task-terminal").await;
    // No adoption/index operation succeeds in this scenario. Retirement must
    // still happen before that fallible work.
    manager.note_subagent_started("child", 1).await;
    assert!(manager
        .accepted_subagent_terminal("child", 1)
        .await
        .is_none());
    manager.shutdown().await;
}

#[tokio::test]
async fn persisted_parent_task_snapshot_adopts_child_session() {
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let ready = connection("alpha", false, "unused", observed_tx).await;
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .expect("manager starts");
    let parent = manager
        .new_session("alpha", NewSessionRequest::new("/tmp"))
        .await
        .expect("parent created");
    let parent_identity = AgentSessionId::decode(&parent.thread_id).unwrap();
    manager
        .session_index
        .lock()
        .await
        .set_approval_policy(&parent_identity, ApprovalPolicy::Never)
        .await
        .unwrap();
    let (_, session_id, connection) = manager.route_thread(&parent.thread_id).unwrap();
    let session = connection
        .session(&session_id)
        .await
        .expect("parent loaded");
    session
        .emit(CanonicalEvent::Tool {
            agent_id: "alpha".into(),
            thread_id: parent.thread_id.clone(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            tool_call_id: "task-persisted".into(),
            kind: agent_client_protocol::v1::schema::ToolKind::Other,
            status: agent_client_protocol::v1::schema::ToolCallStatus::Completed,
            title: "task".into(),
            content: FieldUpdate::Set(
                r#"<task id="child-persisted" state="completed"></task>"#.into(),
            ),
            structured_content: FieldUpdate::Set(Vec::new()),
            locations: FieldUpdate::Set(Vec::new()),
        })
        .await;

    manager
        .read_session(&parent.thread_id)
        .await
        .expect("parent read");
    let child_entry = manager
        .session_index
        .lock()
        .await
        .entries
        .iter()
        .filter(|entry| entry.agent_id == "alpha")
        .find(|entry| entry.acp_session_id == "child-persisted")
        .cloned()
        .expect("child indexed");
    assert_eq!(
        child_entry.parent_acp_session_id.as_deref(),
        Some(parent_identity.acp_session_id.as_str()),
    );
    assert_eq!(child_entry.approval_policy, ApprovalPolicy::Never);
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_consumes_remote_pages_and_dedupes_repeated_cursor_results() {
    let ready = paginated_connection("alpha").await;
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .unwrap();
    let sessions = manager.list_sessions(None, 100).await.unwrap().sessions;
    let session_ids = sessions
        .iter()
        .map(|session| {
            AgentSessionId::decode(&session.thread_id)
                .unwrap()
                .acp_session_id
        })
        .collect::<Vec<_>>();
    assert_eq!(session_ids, vec!["alpha", "duplicate", "zulu"]);
    let page = manager.list_sessions(None, 100).await.unwrap();
    assert_eq!(
        page.diagnostics,
        vec![SessionListDiagnostic::RepeatedCursor],
    );
    assert!(manager.loaded_session_ids().await.is_empty());
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_bounds_endless_empty_and_duplicate_only_remote_pagination() {
    for (fixture, expected_requests, expected_diagnostic, expected_sessions) in [
        (
            PaginationFixture::Endless,
            MAX_SESSION_LIST_PAGES,
            SessionListDiagnostic::PageBudgetExhausted,
            MAX_SESSION_LIST_PAGES + 1,
        ),
        (
            PaginationFixture::Empty,
            1,
            SessionListDiagnostic::EmptyPage,
            1,
        ),
        (
            PaginationFixture::DuplicateOnly,
            2,
            SessionListDiagnostic::DuplicateOnlyPage,
            2,
        ),
        (
            PaginationFixture::MaxSessions,
            1,
            SessionListDiagnostic::MaxSessionsReached,
            MAX_SESSIONS,
        ),
        (
            PaginationFixture::Failure,
            1,
            SessionListDiagnostic::NativeListFailed,
            1,
        ),
    ] {
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ready = adversarial_paginated_connection("alpha", fixture, requests.clone()).await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(
                AgentSessionId::new("alpha", "durable-only").unwrap(),
                PathBuf::from("/tmp"),
            )])
            .await
            .unwrap();
        let page = manager.list_sessions(None, 100).await.unwrap();
        assert_eq!(requests.load(Ordering::SeqCst), expected_requests);
        assert_eq!(page.sessions.len(), expected_sessions.min(MAX_PAGE_SIZE));
        assert!(page.sessions.iter().any(|session| {
            AgentSessionId::decode(&session.thread_id)
                .is_ok_and(|identity| identity.acp_session_id == "durable-only")
        }));
        assert_eq!(page.diagnostics, vec![expected_diagnostic]);
        assert!(page.partial);
        manager.shutdown().await;
    }
}

#[tokio::test]
async fn durable_index_survives_restart_for_agent_without_list_capability() {
    let directory =
        std::env::temp_dir().join(format!("dappercode-session-index-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let index_path = directory.join(SESSION_INDEX_FILE);
    let (observed, _) = mpsc::unbounded_channel();
    let first_connection = connection("alpha", false, "unused", observed).await;
    let first = AgentManager::from_start_results_with_index(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(first_connection))],
        Some(index_path.clone()),
        PathBuf::from("/tmp"),
        true,
    )
    .await
    .unwrap();
    let created = first
        .new_session("alpha", NewSessionRequest::new("/tmp"))
        .await
        .unwrap();
    first.shutdown().await;

    let (observed, _) = mpsc::unbounded_channel();
    let restarted_connection = connection("alpha", false, "unused", observed).await;
    let restarted = AgentManager::from_start_results_with_index(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(restarted_connection))],
        Some(index_path),
        PathBuf::from("/tmp"),
        true,
    )
    .await
    .unwrap();
    let history = restarted.list_sessions(None, 1).await.unwrap();
    assert_eq!(history.sessions.len(), 1);
    assert_eq!(history.sessions[0].thread_id, created.thread_id);
    assert_eq!(
        history.sessions[0].cwd,
        std::fs::canonicalize("/tmp").unwrap(),
    );
    assert!(history.next_cursor.is_none());
    assert!(restarted.loaded_session_ids().await.is_empty());
    restarted.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
#[cfg(unix)]
async fn runtime_activity_never_hydrates_history_and_counts_reconstruction() {
    use std::os::unix::fs::PermissionsExt;

    let directory = std::env::temp_dir().join(format!(
        "dappercode-activity-export-fixture-{}",
        uuid::Uuid::new_v4(),
    ));
    std::fs::create_dir(&directory).unwrap();
    let executable = directory.join("opencode");
    std::fs::write(
        &executable,
        r#"#!/bin/sh
# Deterministic slow history fixture; never invokes an installed agent.
printf invoked > history-probed
exec /bin/sleep 5
"#,
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection("opencode", false, "unused", observed).await;
    let identity = AgentSessionId::new("opencode", "activity-session").unwrap();
    let session = ready
        .0
        .ensure_session(identity.acp_session_id.clone().into())
        .await
        .unwrap();
    let mut fixture_manifest = manifest("opencode", "OpenCode activity fixture");
    fixture_manifest.resolved.executable = executable;
    fixture_manifest.resolved.argv = vec!["acp".into()];
    let manager = Arc::new(
        AgentManager::from_start_results_with_index(
            "opencode".into(),
            vec![(fixture_manifest, Ok(ready))],
            Some(directory.join(SESSION_INDEX_FILE)),
            directory.clone(),
            false,
        )
        .await
        .unwrap(),
    );
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(identity.clone(), directory.clone())])
        .await
        .unwrap();
    let backend = crate::runtime_backend::RuntimeBackend::from_manager_for_test(
        manager,
        Arc::new(crate::client_hub::ClientHub::new()),
        Arc::new(crate::retirement_journal::ThreadRetirementJournal::inert_for_test()),
    )
    .await;
    let (generation, _) = session
        .admit_prompt("run".into(), "turn".into())
        .await
        .unwrap();
    session
        .emit(CanonicalEvent::Tool {
            agent_id: "opencode".into(),
            thread_id: identity.encode(),
            run_id: Some("run".into()),
            source_turn_id: Some("turn".into()),
            generation: Some(generation),
            tool_call_id: "tool".into(),
            kind: agent_client_protocol::v1::schema::ToolKind::Execute,
            status: agent_client_protocol::v1::schema::ToolCallStatus::InProgress,
            title: "Running tool".into(),
            content: FieldUpdate::Unchanged,
            structured_content: FieldUpdate::Unchanged,
            locations: FieldUpdate::Unchanged,
        })
        .await;
    let active = tokio::time::timeout(Duration::from_millis(250), backend.runtime_activity()).await;
    session
        .emit(CanonicalEvent::RunFinished {
            agent_id: "opencode".into(),
            thread_id: identity.encode(),
            run_id: "run".into(),
            source_turn_id: "turn".into(),
            generation,
            stop_reason: StopReason::EndTurn,
        })
        .await;
    let settled =
        tokio::time::timeout(Duration::from_millis(250), backend.runtime_activity()).await;
    let reconstruction = session.begin_reconstruction().await.unwrap();
    let loading =
        tokio::time::timeout(Duration::from_millis(250), backend.runtime_activity()).await;
    reconstruction.finish(true).await;
    let reloaded =
        tokio::time::timeout(Duration::from_millis(250), backend.runtime_activity()).await;
    let probed_history = directory.join("history-probed").exists();
    backend.shutdown().await;
    std::fs::remove_dir_all(&directory).unwrap();

    assert_eq!(
        active.expect("activity must not wait for history export"),
        (1, 0, 0, 1),
    );
    assert_eq!(settled.unwrap(), (0, 0, 0, 0));
    assert_eq!(loading.unwrap(), (0, 0, 0, 1));
    assert_eq!(reloaded.unwrap(), (0, 0, 0, 0));
    assert!(!probed_history);
}

#[tokio::test]
#[cfg(unix)]
async fn completed_history_recovery_export_keeps_catalog_metadata() {
    use std::os::unix::fs::PermissionsExt;

    let directory = std::env::temp_dir().join(format!(
        "dappercode-history-export-fixture-{}",
        uuid::Uuid::new_v4(),
    ));
    std::fs::create_dir(&directory).unwrap();
    let executable = directory.join("opencode");
    std::fs::write(
        &executable,
        r#"#!/bin/sh
# Deterministic fixture only; never invokes an installed agent.
case "$1" in
  session) printf '%s' '[{"id":"completed","title":"Catalog title","updated":1750000000000}]' ;;
  export) if [ -f history.json ]; then cat history.json; else exit 1; fi ;;
  *) exit 1 ;;
esac
"#,
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection_with_capabilities(
        "opencode",
        AgentCapabilities::new().load_session(true),
        observed,
    )
    .await;
    let mut fixture_manifest = manifest("opencode", "OpenCode fixture");
    fixture_manifest.resolved.executable = executable;
    fixture_manifest.resolved.argv = vec!["acp".into()];
    let manager = AgentManager::from_start_results_with_index(
        "opencode".into(),
        vec![(fixture_manifest, Ok(ready))],
        Some(directory.join(SESSION_INDEX_FILE)),
        directory.clone(),
        false,
    )
    .await
    .unwrap();
    let identity = AgentSessionId::new("opencode", "completed").unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(identity.clone(), directory.clone())])
        .await
        .unwrap();
    let unavailable = manager.read_session(&identity.encode()).await.unwrap();
    let unavailable_again = manager.read_session(&identity.encode()).await.unwrap();
    std::fs::write(
        directory.join("history.json"),
        serde_json::json!({
            "messages": [
                {"info": {"id": "user", "role": "user"}, "parts": [
                    {"type": "text", "text": "A phone prompt"}
                ]},
                {"info": {"id": "answer", "role": "assistant"}, "parts": [
                    {"type": "text", "text": "Recovered answer"}
                ]}
            ]
        })
        .to_string(),
    )
    .unwrap();
    let recovered = manager.read_session(&identity.encode()).await.unwrap();
    let reopened = manager.read_session(&identity.encode()).await.unwrap();
    let renamed = manager
        .rename_session(&identity.encode(), "Authoritative rename")
        .await
        .unwrap();
    manager.shutdown().await;
    std::fs::remove_dir_all(&directory).unwrap();

    assert!(unavailable.snapshot.messages.is_empty());
    assert!(unavailable_again.snapshot.messages.is_empty());
    assert_eq!(recovered.snapshot.messages.len(), 2);
    assert_eq!(reopened.snapshot.messages.len(), 2);
    assert_eq!(
        reopened.snapshot.messages[1].parts[0]["text"],
        "Recovered answer",
    );
    for snapshot in [
        unavailable.snapshot,
        unavailable_again.snapshot,
        recovered.snapshot,
        reopened.snapshot,
    ] {
        assert_eq!(snapshot.title.as_deref(), Some("Catalog title"));
        assert_eq!(snapshot.updated_at, milliseconds_to_iso(1_750_000_000_000));
        assert!(!snapshot.history_reconstruction);
        assert!(snapshot.active_run_id.is_none());
    }
    assert_eq!(
        renamed.snapshot.title.as_deref(),
        Some("Authoritative rename"),
    );
}

#[tokio::test]
async fn completed_history_recovery_reads_load_instead_of_historyless_resume() {
    assert_completed_history_recovery(false).await;
}

#[tokio::test]
async fn completed_history_recovery_resumes_load_instead_of_historyless_resume() {
    assert_completed_history_recovery(true).await;
}

async fn assert_completed_history_recovery(explicit_resume: bool) {
    use agent_client_protocol::v1::schema::{SessionNotification, SessionUpdate};

    let directory = std::env::temp_dir().join(format!(
        "dappercode-completed-history-{}",
        uuid::Uuid::new_v4(),
    ));
    std::fs::create_dir(&directory).unwrap();
    let history: Vec<SessionUpdate> = [
        serde_json::json!({
            "sessionUpdate": "user_message_chunk",
            "content": {"type": "text", "text": "A phone prompt"},
            "messageId": "user-message"
        }),
        serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": "Completed while disconnected"},
            "messageId": "agent-message"
        }),
        serde_json::json!({
            "sessionUpdate": "session_info_update",
            "title": "Known conversation",
            "updatedAt": "2026-09-05T10:00:00Z"
        }),
    ]
    .into_iter()
    .map(serde_json::from_value)
    .map(Result::unwrap)
    .collect();
    let complete = Arc::new(tokio::sync::Notify::new());
    let (observed, mut methods) = mpsc::unbounded_channel();
    let agent = Agent
        .v1()
        .on_receive_request(
            async |request: InitializeRequest, responder, _| {
                responder.respond(
                    InitializeResponse::new(request.protocol_version).agent_capabilities(
                        AgentCapabilities::new()
                            .load_session(true)
                            .session_capabilities(
                                SessionCapabilities::new().resume(SessionResumeCapabilities::new()),
                            ),
                    ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async |_: NewSessionRequest, responder, _| {
                responder.respond(NewSessionResponse::new("completed-session"))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let complete = complete.clone();
                let history = history.clone();
                async move |request: PromptRequest, responder, connection| {
                    complete.notified().await;
                    for update in history.iter().skip(1) {
                        connection.send_notification(SessionNotification::new(
                            request.session_id.clone(),
                            update.clone(),
                        ))?;
                    }
                    responder.respond(PromptResponse::new(StopReason::EndTurn))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let observed = observed.clone();
                async move |request: LoadSessionRequest, responder, connection| {
                    let _ = observed.send("load");
                    for update in &history {
                        connection.send_notification(SessionNotification::new(
                            request.session_id.clone(),
                            update.clone(),
                        ))?;
                    }
                    responder.respond(LoadSessionResponse::new())
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_: ResumeSessionRequest, responder, _| {
                let _ = observed.send("resume");
                responder.respond(ResumeSessionResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        );
    let ready = AcpConnection::start_transport("alpha".into(), agent, Duration::from_secs(1))
        .await
        .unwrap();
    let manager = AgentManager::from_start_results_with_index(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
        Some(directory.join(SESSION_INDEX_FILE)),
        directory.clone(),
        false,
    )
    .await
    .unwrap();
    let mut events = manager.take_events().await.unwrap();
    let created = manager
        .new_session("alpha", NewSessionRequest::new(directory.clone()))
        .await
        .unwrap();
    assert!(created.snapshot.messages.is_empty());
    manager
        .prompt(
            &created.thread_id,
            vec!["A phone prompt".into()],
            "run-1".into(),
            "turn-1".into(),
        )
        .await
        .unwrap();
    let running = manager.read_session(&created.thread_id).await.unwrap();
    assert_eq!(running.snapshot.active_run_id.as_deref(), Some("run-1"));
    assert_eq!(running.snapshot.messages.len(), 1);
    complete.notify_one();
    tokio::time::timeout(Duration::from_secs(1), async {
        while let Some(event) = events.recv().await {
            if matches!(event, CanonicalEvent::RunFinished { .. }) {
                return;
            }
        }
        panic!("completion event channel closed");
    })
    .await
    .expect("turn completes without a mobile subscriber");
    let completed = manager.read_session(&created.thread_id).await.unwrap();
    assert_eq!(completed.snapshot.messages.len(), 2);
    assert!(completed.snapshot.active_run_id.is_none());

    manager
        .connection("alpha")
        .unwrap()
        .evict_session(&SessionId::new("completed-session"))
        .await;
    let recovered = if explicit_resume {
        manager
            .resume_session(&created.thread_id, directory.clone())
            .await
            .unwrap()
    } else {
        manager.read_session(&created.thread_id).await.unwrap()
    };
    let reopened = manager.read_session(&created.thread_id).await.unwrap();
    let page = manager
        .snapshot_page(&created.thread_id, None, None, 10)
        .await
        .unwrap();
    manager.shutdown().await;
    std::fs::remove_dir_all(&directory).unwrap();

    for snapshot in [recovered.snapshot, reopened.snapshot] {
        assert_eq!(snapshot.messages.len(), 2);
        assert_eq!(snapshot.messages[0].parts[0]["text"], "A phone prompt");
        assert_eq!(
            snapshot.messages[1].parts[0]["text"],
            "Completed while disconnected",
        );
        assert_eq!(snapshot.title.as_deref(), Some("Known conversation"));
        assert_eq!(snapshot.updated_at.as_deref(), Some("2026-09-05T10:00:00Z"));
        assert!(!snapshot.history_reconstruction);
        assert!(snapshot.active_run_id.is_none());
        assert!(snapshot.active_generation.is_none());
    }
    assert_eq!(page.entries.len(), 2);
    assert_eq!(methods.try_recv().unwrap(), "load");
    assert!(
        methods.try_recv().is_err(),
        "warm reads must not reload history",
    );
}

#[tokio::test]
async fn durable_reads_lazy_reconstruct_typed_history_once_for_read_and_page() {
    let directory = std::env::temp_dir().join(format!(
        "dappercode-session-lazy-read-{}",
        uuid::Uuid::new_v4(),
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let index_path = directory.join(SESSION_INDEX_FILE);
    let identity = AgentSessionId::new("alpha", "durable").unwrap();
    let mut index = DurableSessionIndex::load(Some(index_path.clone())).await;
    index
        .insert_all([index_entry(identity.clone(), directory.clone())])
        .await
        .unwrap();

    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let capabilities = AgentCapabilities::new()
        .load_session(true)
        .session_capabilities(SessionCapabilities::new().resume(SessionResumeCapabilities::new()));
    let response_barrier = Arc::new((tokio::sync::Notify::new(), tokio::sync::Notify::new()));
    let ready = reconstructing_connection(
        "alpha",
        capabilities,
        requests.clone(),
        false,
        Some(response_barrier.clone()),
    )
    .await;
    let manager = Arc::new(
        AgentManager::from_start_results_with_index(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
            Some(index_path),
            directory.clone(),
            false,
        )
        .await
        .unwrap(),
    );
    let thread_id = identity.encode();
    let first = {
        let manager = manager.clone();
        let thread_id = thread_id.clone();
        tokio::spawn(async move { manager.read_session(&thread_id).await })
    };
    response_barrier.0.notified().await;
    assert!(manager.loaded_session_ids().await.is_empty());
    let second = {
        let manager = manager.clone();
        let thread_id = thread_id.clone();
        tokio::spawn(async move { manager.read_session(&thread_id).await })
    };
    tokio::task::yield_now().await;
    assert!(!second.is_finished());
    response_barrier.1.notify_one();
    let first = first.await.unwrap();
    let second = second.await.unwrap();
    for session in [first.unwrap(), second.unwrap()] {
        assert_eq!(session.snapshot.messages.len(), 1);
        assert_eq!(session.snapshot.messages[0].parts[0]["text"], "restored");
    }
    let page = manager
        .snapshot_page(&thread_id, None, None, 10)
        .await
        .unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    manager.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn durable_read_falls_back_to_load_and_rejects_unsupported_or_invalid_cwd() {
    for (capabilities, expected_requests) in [
        (AgentCapabilities::new().load_session(true), 1),
        (AgentCapabilities::new(), 0),
    ] {
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ready =
            reconstructing_connection("alpha", capabilities, requests.clone(), false, None).await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .unwrap();
        let identity = AgentSessionId::new("alpha", "durable").unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
            .await
            .unwrap();
        let result = manager.read_session(&identity.encode()).await;
        if expected_requests == 1 {
            assert_eq!(result.unwrap().snapshot.messages.len(), 1);
        } else {
            assert!(matches!(
                result,
                Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
                    "session/resume or session/load"
                )))
            ));
        }
        assert_eq!(requests.load(Ordering::SeqCst), expected_requests);
        manager.shutdown().await;
    }

    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let ready = reconstructing_connection(
        "alpha",
        AgentCapabilities::new().load_session(true),
        requests.clone(),
        false,
        None,
    )
    .await;
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .unwrap();
    let identity = AgentSessionId::new("alpha", "stale").unwrap();
    manager.session_index.lock().await.entries.push(index_entry(
        identity.clone(),
        PathBuf::from("/definitely/missing/dappercode-workspace"),
    ));
    assert!(matches!(
        manager.read_session(&identity.encode()).await,
        Err(AgentManagerError::SessionIndex(_))
    ));
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    manager.shutdown().await;
}

#[tokio::test]
async fn failed_lazy_reconstruction_does_not_register_empty_live_session() {
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let ready = reconstructing_connection(
        "alpha",
        AgentCapabilities::new().load_session(true),
        requests.clone(),
        true,
        None,
    )
    .await;
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .unwrap();
    let identity = AgentSessionId::new("alpha", "fails").unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
        .await
        .unwrap();
    assert!(manager.read_session(&identity.encode()).await.is_err());
    assert!(manager.loaded_session_ids().await.is_empty());
    assert!(manager.read_session(&identity.encode()).await.is_err());
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    manager.shutdown().await;
}

#[tokio::test]
async fn durable_index_rejects_invalid_storage_and_bounds_valid_entries() {
    let directory = std::env::temp_dir().join(format!(
        "dappercode-session-index-validation-{}",
        uuid::Uuid::new_v4(),
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join(SESSION_INDEX_FILE);

    for contents in [
        br#"{"version":2,"sessions":[]}"#.as_slice(),
        br#"{"version":1,"sessions":[],"extra":true}"#.as_slice(),
        b"not json".as_slice(),
    ] {
        std::fs::write(&path, contents).unwrap();
        assert!(DurableSessionIndex::load(Some(path.clone()))
            .await
            .entries
            .is_empty());
    }
    std::fs::write(
        &path,
        br#"{"version":2,"sessions":[{"agentId":"alpha","acpSessionId":"legacy","cwd":"/tmp"}]}"#,
    )
    .unwrap();
    let legacy = DurableSessionIndex::load(Some(path.clone())).await;
    assert_eq!(legacy.entries.len(), 1);
    assert_eq!(legacy.entries[0].approval_policy, ApprovalPolicy::Untrusted);
    std::fs::write(&path, vec![b'x'; MAX_SESSION_INDEX_BYTES + 1]).unwrap();
    assert!(DurableSessionIndex::load(Some(path.clone()))
        .await
        .entries
        .is_empty());

    let valid = SessionIndexEntry {
        agent_id: "alpha".into(),
        acp_session_id: "valid".into(),
        cwd: PathBuf::from("/tmp"),
        approval_policy: ApprovalPolicy::Untrusted,
        title: None,
        parent_acp_session_id: None,
        forked_from_acp_session_id: None,
    };
    let other_session = SessionIndexEntry {
        agent_id: "alpha".into(),
        acp_session_id: "valid-two".into(),
        cwd: PathBuf::from("/tmp"),
        approval_policy: ApprovalPolicy::Untrusted,
        title: None,
        parent_acp_session_id: None,
        forked_from_acp_session_id: None,
    };
    let other_agent = SessionIndexEntry {
        agent_id: "beta".into(),
        acp_session_id: "valid".into(),
        cwd: PathBuf::from("/tmp"),
        approval_policy: ApprovalPolicy::Untrusted,
        title: None,
        parent_acp_session_id: None,
        forked_from_acp_session_id: None,
    };
    let entries = sanitize_index_entries(vec![
        valid.clone(),
        valid.clone(),
        other_session.clone(),
        other_agent.clone(),
        SessionIndexEntry {
            agent_id: "bad/agent".into(),
            acp_session_id: "invalid".into(),
            cwd: PathBuf::from("/tmp"),
            approval_policy: ApprovalPolicy::Untrusted,
            title: None,
            parent_acp_session_id: None,
            forked_from_acp_session_id: None,
        },
        SessionIndexEntry {
            agent_id: "alpha".into(),
            acp_session_id: "relative".into(),
            cwd: PathBuf::from("relative"),
            approval_policy: ApprovalPolicy::Untrusted,
            title: None,
            parent_acp_session_id: None,
            forked_from_acp_session_id: None,
        },
        SessionIndexEntry {
            agent_id: "alpha".into(),
            acp_session_id: "oversized-cwd".into(),
            cwd: PathBuf::from(format!("/{}", "x".repeat(MAX_SESSION_CWD_BYTES))),
            approval_policy: ApprovalPolicy::Untrusted,
            title: None,
            parent_acp_session_id: None,
            forked_from_acp_session_id: None,
        },
        SessionIndexEntry {
            agent_id: "alpha".into(),
            acp_session_id: "self-parent".into(),
            cwd: PathBuf::from("/tmp"),
            approval_policy: ApprovalPolicy::Untrusted,
            title: None,
            parent_acp_session_id: Some("self-parent".into()),
            forked_from_acp_session_id: None,
        },
    ]);
    assert_eq!(entries, vec![valid, other_session, other_agent]);

    let mut persisted = DurableSessionIndex::load(Some(path.clone())).await;
    persisted
        .insert_all([SessionIndexEntry {
            agent_id: "alpha".into(),
            acp_session_id: "titled".into(),
            cwd: PathBuf::from("/tmp"),
            approval_policy: ApprovalPolicy::Untrusted,
            title: Some("Manual title".into()),
            parent_acp_session_id: None,
            forked_from_acp_session_id: None,
        }])
        .await
        .unwrap();
    persisted
        .set_approval_policy(
            &AgentSessionId::new("alpha", "titled").unwrap(),
            ApprovalPolicy::Never,
        )
        .await
        .unwrap();
    let reloaded = DurableSessionIndex::load(Some(path.clone())).await;
    assert_eq!(reloaded.entries[0].title.as_deref(), Some("Manual title"));
    assert_eq!(reloaded.entries[0].approval_policy, ApprovalPolicy::Never);

    let mut memory_only = DurableSessionIndex::load(None).await;
    let original = SessionIndexEntry {
        agent_id: "alpha".into(),
        acp_session_id: "memory".into(),
        cwd: PathBuf::from("/tmp/original"),
        approval_policy: ApprovalPolicy::Never,
        title: Some("Original title".into()),
        parent_acp_session_id: Some("original-parent".into()),
        forked_from_acp_session_id: None,
    };
    memory_only.insert_all([original]).await.unwrap();
    memory_only
        .insert_all([SessionIndexEntry {
            agent_id: "alpha".into(),
            acp_session_id: "memory".into(),
            cwd: PathBuf::from("/tmp/updated"),
            approval_policy: ApprovalPolicy::Untrusted,
            title: None,
            parent_acp_session_id: None,
            forked_from_acp_session_id: None,
        }])
        .await
        .unwrap();
    assert_eq!(memory_only.entries.len(), 1);
    assert_eq!(memory_only.entries[0].cwd, PathBuf::from("/tmp/updated"));
    assert_eq!(
        memory_only.entries[0].title.as_deref(),
        Some("Original title"),
    );
    assert_eq!(
        memory_only.entries[0].parent_acp_session_id.as_deref(),
        Some("original-parent"),
    );
    assert_eq!(
        memory_only.entries[0].approval_policy,
        ApprovalPolicy::Never,
    );
    let replacement = SessionIndexEntry {
        agent_id: "alpha".into(),
        acp_session_id: "memory".into(),
        cwd: PathBuf::from("/tmp/replaced"),
        approval_policy: ApprovalPolicy::Untrusted,
        title: Some("Replacement title".into()),
        parent_acp_session_id: Some("replacement-parent".into()),
        forked_from_acp_session_id: None,
    };
    memory_only.insert_all([replacement.clone()]).await.unwrap();
    memory_only.insert_all([replacement]).await.unwrap();
    assert_eq!(
        memory_only.entries[0].title.as_deref(),
        Some("Replacement title"),
    );
    assert_eq!(
        memory_only.entries[0].parent_acp_session_id.as_deref(),
        Some("original-parent"),
    );
    assert_eq!(
        memory_only.entries[0].approval_policy,
        ApprovalPolicy::Never,
    );
    memory_only
        .set_approval_policy(
            &AgentSessionId::new("alpha", "memory").unwrap(),
            ApprovalPolicy::Untrusted,
        )
        .await
        .unwrap();
    assert_eq!(
        memory_only.entries[0].approval_policy,
        ApprovalPolicy::Untrusted,
    );
    memory_only
        .insert_all((0..=MAX_SESSIONS).map(|index| {
            index_entry(
                AgentSessionId::new("alpha", format!("bounded-{index:04}")).unwrap(),
                PathBuf::from("/tmp"),
            )
        }))
        .await
        .unwrap();
    assert_eq!(memory_only.entries.len(), MAX_SESSIONS);
    assert!(!memory_only
        .entries
        .iter()
        .any(|entry| entry.acp_session_id == "bounded-0000"));

    let missing_parent = directory.join("missing").join(SESSION_INDEX_FILE);
    let mut unwritable = DurableSessionIndex::load(Some(missing_parent)).await;
    let before = unwritable.entries.clone();
    assert!(matches!(
        unwritable
            .insert_all([index_entry(
                AgentSessionId::new("alpha", "failed-write").unwrap(),
                PathBuf::from("/tmp"),
            )])
            .await,
        Err(AgentManagerError::SessionIndex(_))
    ));
    assert_eq!(unwritable.entries, before);
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn durable_policy_sweep_skips_sessions_that_vanished_after_its_snapshot() {
    let mut index = DurableSessionIndex::load(None).await;
    let existing = AgentSessionId::new("alpha", "existing").unwrap();
    let vanished = AgentSessionId::new("alpha", "vanished").unwrap();
    index
        .insert_all([index_entry(existing.clone(), PathBuf::from("/tmp"))])
        .await
        .unwrap();

    index
        .set_existing_approval_policies(&[
            (vanished, ApprovalPolicy::Never),
            (existing.clone(), ApprovalPolicy::Never),
        ])
        .await
        .expect("vanished sessions do not reject the whole policy sweep");

    assert_eq!(index.entries.len(), 1);
    assert_eq!(index.entries[0].acp_session_id, existing.acp_session_id);
    assert_eq!(index.entries[0].approval_policy, ApprovalPolicy::Never);
}

#[tokio::test]
async fn durable_index_write_failure_rolls_back_and_retry_survives_restart() {
    let directory = std::env::temp_dir().join(format!(
        "dappercode-session-index-transaction-{}",
        uuid::Uuid::new_v4(),
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join(SESSION_INDEX_FILE);
    let original = index_entry(
        AgentSessionId::new("alpha", "original").unwrap(),
        directory.clone(),
    );
    let retry = index_entry(
        AgentSessionId::new("alpha", "retry").unwrap(),
        directory.clone(),
    );
    let mut index = DurableSessionIndex::load(Some(path.clone())).await;
    index.insert_all([original.clone()]).await.unwrap();
    let old_bytes = std::fs::read(&path).unwrap();
    index.fail_writes = true;
    assert!(matches!(
        index.insert_all([retry.clone()]).await,
        Err(AgentManagerError::SessionIndex(_))
    ));
    assert_eq!(index.entries, vec![original.clone()]);
    assert_eq!(std::fs::read(&path).unwrap(), old_bytes);

    index.fail_writes = false;
    index
        .insert_all([retry.clone(), retry.clone()])
        .await
        .unwrap();
    assert_eq!(index.entries, vec![original.clone(), retry.clone()]);
    let restarted = DurableSessionIndex::load(Some(path)).await;
    assert_eq!(restarted.entries, vec![original, retry]);
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn create_durability_failure_is_explicit_and_pending_list_flush_retries() {
    let directory = std::env::temp_dir().join(format!(
        "dappercode-session-create-durability-{}",
        uuid::Uuid::new_v4(),
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let index_path = directory.join(SESSION_INDEX_FILE);
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection("alpha", false, "unused", observed).await;
    let manager = AgentManager::from_start_results_with_index(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
        Some(index_path.clone()),
        directory.clone(),
        false,
    )
    .await
    .unwrap();
    manager.session_index.lock().await.fail_writes = true;
    let failure = manager
        .new_session_with_policy_outcome(
            "alpha",
            NewSessionRequest::new(directory.clone()),
            ApprovalPolicy::Never,
            RequestCancellation::default(),
        )
        .await
        .expect_err("post-creation durability failure is reported");
    assert!(failure.is_indeterminate());
    assert!(matches!(
        failure.into_error(),
        AgentManagerError::SessionIndex(_)
    ));
    assert_eq!(manager.loaded_session_ids().await.len(), 1);
    let pending = manager.pending_durable_sessions.lock().await;
    assert_eq!(pending.len(), 1);
    assert_eq!(
        pending
            .values()
            .next()
            .expect("pending session")
            .approval_policy,
        ApprovalPolicy::Never,
    );
    drop(pending);
    assert!(manager.session_index.lock().await.entries.is_empty());

    manager.session_index.lock().await.fail_writes = false;
    let listed = manager.list_sessions(None, 10).await.unwrap();
    assert_eq!(listed.sessions.len(), 1);
    assert!(manager.pending_durable_sessions.lock().await.is_empty());
    assert_eq!(manager.session_index.lock().await.entries.len(), 1);
    manager.shutdown().await;

    let restarted = DurableSessionIndex::load(Some(index_path)).await;
    assert_eq!(restarted.entries.len(), 1);
    assert_eq!(restarted.entries[0].approval_policy, ApprovalPolicy::Never);
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn resume_durability_failure_retains_live_session_and_flushes_on_retry() {
    let directory = std::env::temp_dir().join(format!(
        "dappercode-session-resume-durability-{}",
        uuid::Uuid::new_v4(),
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let index_path = directory.join(SESSION_INDEX_FILE);
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection_with_capabilities(
        "alpha",
        AgentCapabilities::new().load_session(true),
        observed,
    )
    .await;
    let manager = AgentManager::from_start_results_with_index(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
        Some(index_path.clone()),
        directory.clone(),
        false,
    )
    .await
    .unwrap();
    manager.session_index.lock().await.fail_writes = true;
    let identity = AgentSessionId::new("alpha", "resume-pending").unwrap();
    assert!(matches!(
        manager
            .resume_session(&identity.encode(), directory.clone())
            .await,
        Err(AgentManagerError::SessionIndex(_))
    ));
    assert_eq!(manager.loaded_session_ids().await, vec![identity.encode()]);
    assert_eq!(manager.pending_durable_sessions.lock().await.len(), 1);

    manager.session_index.lock().await.fail_writes = false;
    let listed = manager.list_sessions(None, 10).await.unwrap();
    assert_eq!(listed.sessions.len(), 1);
    assert!(manager.pending_durable_sessions.lock().await.is_empty());
    manager.shutdown().await;
    assert_eq!(
        DurableSessionIndex::load(Some(index_path))
            .await
            .entries
            .len(),
        1,
    );
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn workspace_policy_canonicalizes_relative_paths_and_rejects_outside_root() {
    let directory = std::env::temp_dir().join(format!(
        "dappercode-session-workspace-policy-{}",
        uuid::Uuid::new_v4(),
    ));
    let nested = directory.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let file = directory.join("file");
    std::fs::write(&file, "not a directory").unwrap();
    let manager = AgentManager::from_start_results_with_index(
        "alpha".into(),
        Vec::new(),
        None,
        directory.clone(),
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        manager.validate_cwd(Path::new("nested")).unwrap(),
        std::fs::canonicalize(&nested).unwrap(),
    );
    assert!(matches!(
        manager.validate_cwd(Path::new("/tmp")),
        Err(AgentManagerError::SessionIndex(_))
    ));
    assert!(matches!(
        manager.validate_cwd(&file),
        Err(AgentManagerError::SessionIndex(_))
    ));
    assert!(manager.flush_pending_durable_sessions().await.is_ok());
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn deleted_read_uses_retirement_tombstones_without_a_working_catalog() {
    async fn read_reply(
        backend: &Arc<crate::runtime_backend::RuntimeBackend>,
        client_id: u64,
        replies: &mut crate::client_outbox::ClientOutboxReceiver,
        thread_id: &str,
        request_id: u64,
    ) -> serde_json::Value {
        backend
            .forward_request(
                client_id,
                serde_json::json!(request_id),
                "thread/read",
                Some(serde_json::json!({ "threadId": thread_id })),
                None,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let frame = replies.recv().await.unwrap();
                let reply: serde_json::Value =
                    serde_json::from_str(frame.to_text().unwrap()).unwrap();
                if reply["id"] == request_id {
                    break reply;
                }
            }
        })
        .await
        .unwrap()
    }

    for supports_list in [false, true] {
        let directory = std::env::current_dir()
            .unwrap()
            .join(format!(".deleted-read-tombstones-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection_with_catalog(
            "delete-agent",
            true,
            false,
            supports_list,
            observed_tx,
        )
        .await;
        let agent_connection = connection.0.clone();
        let manager = Arc::new(
            AgentManager::from_start_results(
                "delete-agent".into(),
                vec![(manifest("delete-agent", "Delete"), Ok(connection))],
            )
            .await
            .unwrap(),
        );
        let hub = Arc::new(crate::client_hub::ClientHub::new());
        let journal = Arc::new(
            crate::retirement_journal::ThreadRetirementJournal::load(
                directory.join("thread-retirements.json"),
            )
            .await
            .unwrap(),
        );
        let backend = crate::runtime_backend::RuntimeBackend::from_manager_for_test(
            manager.clone(),
            hub.clone(),
            journal,
        )
        .await;
        let queue = crate::bridge_protocol::BridgeQueueService::new(backend.clone(), hub.clone());
        let scheduler = crate::scheduled_prompts::ScheduledPromptService::start_paused(
            directory.join("scheduled-prompts.json"),
            Arc::downgrade(&queue),
            hub.clone(),
        )
        .await
        .unwrap();
        backend
            .attach_thread_lifecycle(Arc::downgrade(&queue), Arc::downgrade(&scheduler))
            .await
            .unwrap();
        let (outbox, mut replies) = crate::client_outbox::client_outbox(32);
        let client_id = hub
            .add_client_with_metadata(
                outbox,
                crate::client_hub::ClientConnectionMetadata::default(),
            )
            .await;
        backend.register_client(client_id);
        let thread_id = AgentSessionId::new("delete-agent", "delete-agent-listed")
            .unwrap()
            .encode();

        // A pending or rolled-back retirement is not confirmed deletion, even if reads fail.
        let lease = queue
            .begin_retirement_fence(std::slice::from_ref(&thread_id))
            .await
            .unwrap();
        let pending = read_reply(&backend, client_id, &mut replies, &thread_id, 1).await;
        drop(lease);
        let cancelled = read_reply(&backend, client_id, &mut replies, &thread_id, 2).await;
        let lease = queue
            .begin_retirement_fence(std::slice::from_ref(&thread_id))
            .await
            .unwrap();
        lease.finish().await;
        let rolled_back = read_reply(&backend, client_id, &mut replies, &thread_id, 3).await;

        backend
            .request_internal(
                "thread/delete",
                Some(serde_json::json!({ "threadId": thread_id })),
            )
            .await
            .unwrap();
        if supports_list {
            agent_connection.shutdown().await.unwrap();
        }
        assert!(!manager.thread_is_authoritatively_absent(&thread_id).await);
        let deleted = read_reply(&backend, client_id, &mut replies, &thread_id, 4).await;
        scheduler.shutdown().await;
        backend.shutdown().await;
        std::fs::remove_dir_all(directory).unwrap();
        for reply in [pending, cancelled, rolled_back] {
            assert_eq!(reply["error"]["code"], -32601);
        }
        assert_eq!(
            deleted["error"]["code"], -32004,
            "supports_list={supports_list}",
        );
        assert_eq!(
            deleted["error"]["data"],
            serde_json::json!({
                "error": "thread_not_found", "threadId": thread_id,
            }),
        );
    }
}

#[tokio::test]
async fn manager_delete_removes_the_durable_entry_and_stops_listing_the_session() {
    let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("delete-agent", true, false, observed_tx).await;
    let manager = AgentManager::from_start_results(
        "delete-agent".to_string(),
        vec![(manifest("delete-agent", "Delete"), Ok(connection))],
    )
    .await
    .unwrap();
    let identity = AgentSessionId::new("delete-agent", "delete-agent-listed").unwrap();
    // Missing local index data must not delete valid, unloaded agent history.
    assert!(
        !manager
            .thread_is_authoritatively_absent(&identity.encode())
            .await,
    );
    assert!(!manager.thread_is_authoritatively_absent("invalid-id").await);
    assert!(
        !manager
            .thread_is_authoritatively_absent(
                &AgentSessionId::new("unavailable-agent", "session")
                    .unwrap()
                    .encode()
            )
            .await,
    );
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
        .await
        .unwrap();
    let thread_id = identity.encode();
    assert!(manager
        .list_sessions(None, 100)
        .await
        .unwrap()
        .sessions
        .iter()
        .any(|session| session.thread_id == thread_id));

    manager.delete_session(&thread_id).await.unwrap();

    assert_eq!(
        observed_rx.recv().await.as_deref(),
        Some("delete:delete-agent:delete-agent-listed"),
    );
    assert!(manager.session_index.lock().await.entries.is_empty());
    assert!(manager.loaded_session_ids().await.is_empty());
    assert!(manager.read_session(&thread_id).await.is_err());
    assert!(manager.thread_is_authoritatively_absent(&thread_id).await);
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_delete_session_index_failure_retains_family_evidence_after_acp_apply() {
    let directory = std::env::current_dir()
        .unwrap()
        .join("target")
        .join(format!("delete-index-failure-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
    let connection = post_apply_deleting_connection("delete-agent", observed_tx).await;
    let manager = AgentManager::from_start_results_with_index(
        "delete-agent".to_string(),
        vec![(manifest("delete-agent", "Delete"), Ok(connection))],
        Some(directory.join(SESSION_INDEX_FILE)),
        directory.clone(),
        false,
    )
    .await
    .unwrap();
    let parent = AgentSessionId::new("delete-agent", "delete-agent-listed").unwrap();
    let child = AgentSessionId::new("delete-agent", "indexed-child").unwrap();
    let mut child_entry = index_entry(child.clone(), directory.clone());
    child_entry.parent_acp_session_id = Some(parent.acp_session_id.clone());
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(parent.clone(), directory.clone()), child_entry])
        .await
        .unwrap();
    manager
        .connection("delete-agent")
        .unwrap()
        .ensure_session(SessionId::new(parent.acp_session_id.clone()))
        .await
        .expect("seed a locally cached session before deletion");
    manager.session_index.lock().await.fail_writes = true;

    assert!(matches!(
        manager.delete_session(&parent.encode()).await,
        Err(AgentManagerError::SessionIndex(_))
    ));
    assert_eq!(
        observed_rx.recv().await.as_deref(),
        Some("delete:delete-agent:delete-agent-listed"),
    );
    let mut retained = manager
        .session_index
        .lock()
        .await
        .entries
        .iter()
        .map(|entry| entry.acp_session_id.clone())
        .collect::<Vec<_>>();
    retained.sort();
    assert_eq!(
        retained,
        vec![
            "delete-agent-listed".to_string(),
            "indexed-child".to_string()
        ],
    );
    assert_eq!(
        manager.reconcile_retirement_plan(&[parent.encode()]).await,
        RetirementPlanReconciliation::Absent,
    );
    let mut expanded = manager
        .expand_retirement_family(&[parent.encode()])
        .await
        .unwrap();
    expanded.sort();
    let mut expected = vec![parent.encode(), child.encode()];
    expected.sort();
    assert_eq!(expanded, expected);

    manager.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn manager_delete_waits_for_the_session_operation_lock() {
    let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("delete-agent", true, false, observed_tx).await;
    let manager = Arc::new(
        AgentManager::from_start_results(
            "delete-agent".to_string(),
            vec![(manifest("delete-agent", "Delete"), Ok(connection))],
        )
        .await
        .unwrap(),
    );
    let identity = AgentSessionId::new("delete-agent", "delete-agent-listed").unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
        .await
        .unwrap();
    let thread_id = identity.encode();
    let operation = manager
        .session_operation_lock(&thread_id)
        .await
        .lock_owned()
        .await;
    let deletion = {
        let manager = manager.clone();
        let thread_id = thread_id.clone();
        tokio::spawn(async move { manager.delete_session(&thread_id).await })
    };

    assert!(
        tokio::time::timeout(Duration::from_millis(50), observed_rx.recv())
            .await
            .is_err(),
        "delete reached the agent while a policy/family operation owned the session lock",
    );
    drop(operation);
    deletion
        .await
        .expect("delete task")
        .expect("delete succeeds after operation finishes");
    assert_eq!(
        observed_rx.recv().await.as_deref(),
        Some("delete:delete-agent:delete-agent-listed"),
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn prepared_scope_hook_failure_aborts_before_acp_delete() {
    let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("delete-agent", true, false, observed_tx).await;
    let manager = AgentManager::from_start_results(
        "delete-agent".to_string(),
        vec![(manifest("delete-agent", "Delete"), Ok(connection))],
    )
    .await
    .unwrap();
    let identity = AgentSessionId::new("delete-agent", "delete-agent-listed").unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
        .await
        .unwrap();
    manager
        .connection("delete-agent")
        .unwrap()
        .ensure_session(SessionId::new(identity.acp_session_id.clone()))
        .await
        .expect("seed loaded session");
    let thread_id = identity.encode();

    let deletion = manager
        .prepare_session_deletion(&thread_id)
        .await
        .expect("lock deletion scope");
    assert_eq!(deletion.affected_thread_ids(), vec![thread_id.clone()]);
    let hook_result: Result<(), &str> = Err("injected pre-delete hook failure");
    assert!(hook_result.is_err());
    deletion.abort().await;

    assert!(
        observed_rx.try_recv().is_err(),
        "ACP deletion is only invoked by executing a successfully prepared plan",
    );
    assert_eq!(manager.session_index.lock().await.entries.len(), 1);
    assert!(manager.loaded_session_ids().await.contains(&thread_id));
    manager.shutdown().await;
}

#[tokio::test]
async fn operation_lock_pruning_preserves_identity_while_contended() {
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("delete-agent", true, false, observed_tx).await;
    let manager = AgentManager::from_start_results(
        "delete-agent".to_string(),
        vec![(manifest("delete-agent", "Delete"), Ok(connection))],
    )
    .await
    .unwrap();
    let thread_id = "contended-thread";
    let original = manager.session_operation_lock(thread_id).await;
    let held = original.clone().lock_owned().await;
    let waiter = {
        let operation = original.clone();
        tokio::spawn(async move { operation.lock_owned().await })
    };
    tokio::task::yield_now().await;

    manager.prune_session_operation_lock(thread_id).await;
    let while_queued = manager.session_operation_lock(thread_id).await;
    assert!(Arc::ptr_eq(&original, &while_queued));

    drop(held);
    let waiter_guard = waiter.await.expect("operation waiter");
    manager.prune_session_operation_lock(thread_id).await;
    let while_held = manager.session_operation_lock(thread_id).await;
    assert!(Arc::ptr_eq(&original, &while_held));

    drop(waiter_guard);
    drop(while_held);
    drop(while_queued);
    drop(original);
    manager.prune_session_operation_lock(thread_id).await;
    assert!(!manager
        .reconstruction_locks
        .lock()
        .await
        .contains_key(thread_id));
    manager.shutdown().await;
}

#[tokio::test]
async fn stale_subagent_adoption_cannot_recreate_a_child_after_parent_deletion() {
    let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("delete-agent", true, false, observed_tx).await;
    let manager = Arc::new(
        AgentManager::from_start_results(
            "delete-agent".to_string(),
            vec![(manifest("delete-agent", "Delete"), Ok(connection))],
        )
        .await
        .unwrap(),
    );
    let parent = AgentSessionId::new("delete-agent", "parent").unwrap();
    let child = AgentSessionId::new("delete-agent", "child").unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(parent.clone(), PathBuf::from("/tmp"))])
        .await
        .unwrap();
    let mut stale_child = index_entry(child, PathBuf::from("/tmp"));
    stale_child.parent_acp_session_id = Some(parent.acp_session_id.clone());
    let parent_thread_id = parent.encode();
    let operation = manager
        .session_operation_lock(&parent_thread_id)
        .await
        .lock_owned()
        .await;
    let deletion = {
        let manager = manager.clone();
        let parent_thread_id = parent_thread_id.clone();
        tokio::spawn(async move { manager.delete_session(&parent_thread_id).await })
    };
    tokio::task::yield_now().await;
    let adoption = {
        let manager = manager.clone();
        tokio::spawn(async move {
            manager
                .persist_inherited_entries(std::slice::from_ref(&stale_child))
                .await
        })
    };
    tokio::task::yield_now().await;

    drop(operation);
    deletion
        .await
        .expect("delete task")
        .expect("parent deletion succeeds");
    assert_eq!(
        observed_rx.recv().await.as_deref(),
        Some("delete:delete-agent:parent"),
    );
    assert!(matches!(
        adoption.await.expect("adoption task"),
        Err(AgentManagerError::SessionIndex(message))
            if message == "parent session is no longer indexed"
    ));
    assert!(manager.session_index.lock().await.entries.is_empty());
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_fork_rejects_busy_missing_first_unindexed_and_unsupported_sources() {
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("plain-agent", false, false, observed_tx).await;
    let session_id = SessionId::new("fork-source");
    let session = connection
        .0
        .ensure_session(session_id.clone())
        .await
        .expect("source session");
    let manager = AgentManager::from_start_results(
        "plain-agent".to_string(),
        vec![(manifest("plain-agent", "Plain"), Ok(connection))],
    )
    .await
    .expect("manager");
    let identity = AgentSessionId::new("plain-agent", "fork-source").unwrap();
    let thread_id = identity.encode();
    let unknown_agent = manager
        .new_session_with_cancellation_outcome(
            "missing-agent",
            NewSessionRequest::new("."),
            RequestCancellation::default(),
        )
        .await
        .expect_err("unknown agent is rejected before session creation");
    assert!(!unknown_agent.is_indeterminate());
    assert!(matches!(
        unknown_agent.into_error(),
        AgentManagerError::UnknownAgent(_)
    ));

    let (generation, _) = session
        .admit_prompt("run".to_string(), "turn".to_string())
        .await
        .expect("active prompt");
    assert!(matches!(
        manager.fork_session(&thread_id, "missing").await,
        Err(AgentManagerError::Runtime(AcpRuntimeError::SessionBusy))
    ));
    session
        .emit(CanonicalEvent::RunFinished {
            agent_id: "plain-agent".to_string(),
            thread_id: thread_id.clone(),
            run_id: "run".to_string(),
            source_turn_id: "turn".to_string(),
            generation,
            stop_reason: StopReason::EndTurn,
        })
        .await;
    let missing_boundary = manager
        .fork_session_with_outcome(&thread_id, "missing")
        .await
        .expect_err("missing boundary is rejected before forking");
    assert!(!missing_boundary.is_indeterminate());
    assert!(matches!(
        missing_boundary.into_error(),
        AgentManagerError::Fork(_)
    ));

    for (id, content) in [("user-1", "first"), ("user-2", "second")] {
        session
            .emit(CanonicalEvent::MessageChunk {
                agent_id: "plain-agent".to_string(),
                thread_id: thread_id.clone(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::User,
                message_id: id.to_string(),
                content: content.to_string(),
                content_block: None,
            })
            .await;
    }
    session
        .emit(CanonicalEvent::MessageChunk {
            agent_id: "plain-agent".to_string(),
            thread_id: thread_id.clone(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role: MessageRole::Agent,
            message_id: "agent-2".to_string(),
            content: "answer".to_string(),
            content_block: None,
        })
        .await;
    assert!(matches!(
        manager.fork_session(&thread_id, "user-1").await,
        Err(AgentManagerError::Fork(_))
    ));
    assert!(matches!(
        manager.fork_session(&thread_id, "user-2").await,
        Err(AgentManagerError::SessionIndex(_))
    ));
    // The newest response names the end of history, so it resolves the same way any request
    // does and only fails later, on the missing index entry.
    assert!(matches!(
        manager.fork_session(&thread_id, "agent-2").await,
        Err(AgentManagerError::SessionIndex(_))
    ));

    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(identity, PathBuf::from("/tmp"))])
        .await
        .expect("index source");
    assert!(matches!(
        manager.fork_session(&thread_id, "user-2").await,
        Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
            "session/fork"
        )))
    ));
    assert!(!manager
        .supports_steer(&thread_id)
        .expect("unsupported steer projection"));
    let epoch = manager
        .prepare_steer(&thread_id)
        .await
        .expect("prepare unsupported steer");
    assert!(matches!(
        manager
            .steer(
                &thread_id,
                "run".to_string(),
                "turn".to_string(),
                1,
                epoch + 1,
                Vec::new(),
            )
            .await,
        Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
            "stale steer interaction epoch"
        )))
    ));
    assert!(matches!(
        manager
            .steer(
                &thread_id,
                "run".to_string(),
                "turn".to_string(),
                1,
                epoch,
                Vec::new(),
            )
            .await,
        Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
            "session/steer"
        )))
    ));
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_rolls_back_an_adapter_fork_that_cannot_be_reconstructed() {
    async fn messages(AxumPath(session_id): AxumPath<String>) -> Json<serde_json::Value> {
        if session_id == "source" {
            Json(serde_json::json!([
                {"info": {"id": "raw-1", "role": "user"}, "parts": [{"type": "text", "text": "first"}]},
                {"info": {"id": "raw-2", "role": "user"}, "parts": [{"type": "text", "text": "second"}]}
            ]))
        } else {
            Json(serde_json::json!([
                {"info": {"id": "raw-1", "role": "user"}, "parts": [{"type": "text", "text": "first"}]}
            ]))
        }
    }

    let app = Router::new()
        .route("/session/{session_id}/message", get(messages))
        .route(
            "/session/source/fork",
            post(|| async {
                Json(serde_json::json!({
                    "id": "forked",
                    "parentID": "source",
                    "directory": "/tmp",
                    "title": "Forked"
                }))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener");
    let http_base = format!(
        "http://{}",
        listener.local_addr().expect("fixture local address"),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve fork fixture");
    });

    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("opencode", false, true, observed_tx).await;
    let session_id = SessionId::new("source");
    let session = connection
        .0
        .ensure_session(session_id)
        .await
        .expect("source session");
    let mut opencode = manifest("opencode", "OpenCode");
    opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
    opencode.resolved.argv = vec!["acp".to_string()];
    let mut manager =
        AgentManager::from_start_results("opencode".to_string(), vec![(opencode, Ok(connection))])
            .await
            .expect("manager");
    manager
        .agents
        .get_mut("opencode")
        .expect("runtime")
        .http_base = Some(http_base);
    let identity = AgentSessionId::new("opencode", "source").unwrap();
    let thread_id = identity.encode();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
        .await
        .expect("source index");
    for (id, text) in [("user-1", "first"), ("user-2", "second")] {
        session
            .emit(CanonicalEvent::MessageChunk {
                agent_id: "opencode".to_string(),
                thread_id: thread_id.clone(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::User,
                message_id: id.to_string(),
                content: text.to_string(),
                content_block: None,
            })
            .await;
    }

    assert!(matches!(
        manager.fork_session(&thread_id, "user-2").await,
        Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
            "session/resume or session/load"
        )))
    ));
    assert_eq!(manager.session_index.lock().await.entries.len(), 1);
    assert!(manager
        .agents
        .get("opencode")
        .and_then(|runtime| runtime.connection.as_ref())
        .expect("connection")
        .session(&SessionId::new("forked"))
        .await
        .is_none());

    server.abort();
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_deletes_opencode_sessions_through_its_loopback_api() {
    let (acp_observed_tx, mut acp_observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("opencode", false, true, acp_observed_tx).await;
    for session_id in ["opencode-listed", "opencode-child", "opencode-grandchild"] {
        connection
            .0
            .ensure_session(SessionId::new(session_id))
            .await
            .expect("load OpenCode session");
    }
    let mut opencode = manifest("opencode", "OpenCode");
    opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
    opencode.resolved.argv = vec!["acp".to_string()];
    let mut manager =
        AgentManager::from_start_results("opencode".to_string(), vec![(opencode, Ok(connection))])
            .await
            .unwrap();
    let (http_base, mut http_observed, server) =
        opencode_delete_server(AxumStatusCode::OK, true).await;
    manager
        .agents
        .get_mut("opencode")
        .expect("OpenCode runtime")
        .http_base = Some(http_base);
    let identity = AgentSessionId::new("opencode", "opencode-listed").unwrap();
    let child_identity = AgentSessionId::new("opencode", "opencode-child").unwrap();
    let grandchild_identity = AgentSessionId::new("opencode", "opencode-grandchild").unwrap();
    let mut child_entry = index_entry(child_identity.clone(), PathBuf::from("/tmp"));
    child_entry.parent_acp_session_id = Some(identity.acp_session_id.clone());
    let mut grandchild_entry = index_entry(grandchild_identity.clone(), PathBuf::from("/tmp"));
    grandchild_entry.parent_acp_session_id = Some(child_identity.acp_session_id.clone());
    manager
        .session_index
        .lock()
        .await
        .insert_all([
            index_entry(identity.clone(), PathBuf::from("/tmp")),
            child_entry,
        ])
        .await
        .unwrap();
    let thread_id = identity.encode();

    assert!(manager
        .list_agents()
        .into_iter()
        .find(|agent| agent.agent_id == "opencode")
        .and_then(|agent| agent.capabilities)
        .is_some_and(|capabilities| capabilities.session_delete));

    manager
        .session_index
        .lock()
        .await
        .insert_all([grandchild_entry])
        .await
        .unwrap();
    let expected_family = vec![
        identity.encode(),
        child_identity.encode(),
        grandchild_identity.encode(),
    ];
    let deletion = manager
        .prepare_session_deletion(&thread_id)
        .await
        .expect("lock the authoritative family before ACP deletion");
    assert_eq!(deletion.affected_thread_ids(), expected_family);
    assert!(http_observed.try_recv().is_err());
    assert!(acp_observed_rx.try_recv().is_err());
    assert_eq!(deletion.execute().await.unwrap(), expected_family);

    assert_eq!(
        http_observed.recv().await,
        Some(("opencode-listed".to_string(), Some("/tmp".to_string()))),
    );
    assert_eq!(
        acp_observed_rx.recv().await.as_deref(),
        Some("close:opencode:opencode-listed"),
    );
    assert_eq!(
        acp_observed_rx.recv().await.as_deref(),
        Some("close:opencode:opencode-child"),
    );
    assert_eq!(
        acp_observed_rx.recv().await.as_deref(),
        Some("close:opencode:opencode-grandchild"),
    );
    assert!(acp_observed_rx.try_recv().is_err());
    assert!(manager.session_index.lock().await.entries.is_empty());
    assert!(manager.loaded_session_ids().await.is_empty());
    manager.shutdown().await;
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn runtime_delete_uses_global_barrier_and_authoritative_dynamic_family() {
    let directory = std::env::current_dir()
        .expect("current directory")
        .join("target")
        .join(format!(
            "runtime-authoritative-delete-{}",
            uuid::Uuid::new_v4(),
        ));
    std::fs::create_dir_all(&directory).expect("create runtime deletion test directory");
    let (acp_observed_tx, mut acp_observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("opencode", false, true, acp_observed_tx).await;
    for session_id in ["parent", "child", "grandchild"] {
        connection
            .0
            .ensure_session(SessionId::new(session_id))
            .await
            .expect("load OpenCode family session");
    }
    let mut opencode = manifest("opencode", "OpenCode");
    opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
    opencode.resolved.argv = vec!["acp".to_string()];
    let mut manager = AgentManager::from_start_results_with_index(
        "opencode".to_string(),
        vec![(opencode, Ok(connection))],
        None,
        directory.clone(),
        true,
    )
    .await
    .expect("manager");
    let (http_base, mut http_observed, server) =
        opencode_delete_server(AxumStatusCode::OK, true).await;
    manager
        .agents
        .get_mut("opencode")
        .expect("OpenCode runtime")
        .http_base = Some(http_base);

    let parent = AgentSessionId::new("opencode", "parent").unwrap();
    let child = AgentSessionId::new("opencode", "child").unwrap();
    let grandchild = AgentSessionId::new("opencode", "grandchild").unwrap();
    let mut child_entry = index_entry(child.clone(), directory.clone());
    child_entry.parent_acp_session_id = Some(parent.acp_session_id.clone());
    let mut grandchild_entry = index_entry(grandchild.clone(), directory.clone());
    grandchild_entry.parent_acp_session_id = Some(child.acp_session_id.clone());
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(parent.clone(), directory.clone()), child_entry])
        .await
        .expect("index initial family");
    let manager = Arc::new(manager);
    let hub = Arc::new(crate::client_hub::ClientHub::new());
    let retirement_journal = Arc::new(
        crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json"),
        )
        .await
        .expect("load retirement journal"),
    );
    let backend = crate::runtime_backend::RuntimeBackend::from_manager_for_test(
        manager.clone(),
        hub.clone(),
        retirement_journal.clone(),
    )
    .await;
    let queue = crate::bridge_protocol::BridgeQueueService::new(backend.clone(), hub.clone());
    let scheduler = crate::scheduled_prompts::ScheduledPromptService::start_paused(
        directory.join("scheduled-prompts.json"),
        Arc::downgrade(&queue),
        hub,
    )
    .await
    .expect("start paused scheduler");
    backend
        .attach_thread_lifecycle(Arc::downgrade(&queue), Arc::downgrade(&scheduler))
        .await
        .expect("attach production deletion services");

    let parent_thread_id = parent.encode();
    let child_thread_id = child.encode();
    let grandchild_thread_id = grandchild.encode();
    queue.threads.write().await.insert(
        parent_thread_id.clone(),
        crate::bridge_protocol::BridgeThreadQueueRuntime {
            items: std::collections::VecDeque::from([
                crate::bridge_protocol::BridgeQueuedMessageEntry {
                    id: "concurrent-dispatch".to_string(),
                    submission_id: "concurrent-dispatch".to_string(),
                    created_at: "now".to_string(),
                    content: "dispatch before deletion".to_string(),
                    turn_start: serde_json::json!({
                        "input": [{
                            "type": "text",
                            "text": "dispatch before deletion",
                            "text_elements": []
                        }]
                    }),
                    agent_message: None,
                },
            ]),
            ..crate::bridge_protocol::BridgeThreadQueueRuntime::default()
        },
    );
    let manager_operation = manager
        .session_operation_lock(&parent_thread_id)
        .await
        .lock_owned()
        .await;
    let dispatch = tokio::spawn({
        let queue = queue.clone();
        let parent_thread_id = parent_thread_id.clone();
        async move { queue.drain_thread_queue(parent_thread_id).await }
    });
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if queue
                .threads
                .read()
                .await
                .get(&parent_thread_id)
                .is_some_and(|runtime| runtime.turn_start_in_flight)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("queue dispatch reaches the manager operation");

    let scheduler_operation = scheduler
        .begin_thread_retirement(&[AgentSessionId::new("opencode", "unrelated")
            .unwrap()
            .encode()])
        .await
        .expect("hold scheduler operation");
    let schedule_admitted = Arc::new(tokio::sync::Notify::new());
    *queue
        .retirement_fence
        .admission_acquired
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(schedule_admitted.clone());
    let scheduling = tokio::spawn({
        let scheduler = scheduler.clone();
        let child_thread_id = child_thread_id.clone();
        async move {
            scheduler
                .schedule(
                    &child_thread_id,
                    "schedule before deletion".to_string(),
                    &(chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
                )
                .await
        }
    });
    tokio::time::timeout(Duration::from_secs(1), schedule_admitted.notified())
        .await
        .expect("concurrent schedule acquires admission before scheduler operation");

    let barrier_attempted = Arc::new(tokio::sync::Notify::new());
    *queue
        .retirement_fence
        .begin_attempted
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(barrier_attempted.clone());
    let deletion = tokio::spawn({
        let backend = backend.clone();
        let parent_thread_id = parent_thread_id.clone();
        async move {
            backend
                .request_internal(
                    "thread/delete",
                    Some(serde_json::json!({"threadId": parent_thread_id})),
                )
                .await
        }
    });
    tokio::time::timeout(Duration::from_secs(1), barrier_attempted.notified())
        .await
        .expect("runtime deletion queues the global admission barrier");
    assert!(!deletion.is_finished());
    manager
        .session_index
        .lock()
        .await
        .insert_all([grandchild_entry])
        .await
        .expect("admitted work indexes a dynamic descendant before planning");

    scheduler
        .rollback_thread_retirement(scheduler_operation)
        .await;
    scheduling
        .await
        .expect("schedule task")
        .expect("admitted schedule completes");
    drop(manager_operation);
    tokio::time::timeout(Duration::from_secs(1), dispatch)
        .await
        .expect("admitted dispatch drains before deletion planning")
        .expect("dispatch task");
    let result = tokio::time::timeout(Duration::from_secs(1), deletion)
        .await
        .expect("global-barrier deletion completes")
        .expect("deletion task")
        .expect("runtime deletion succeeds");
    assert_eq!(
        result,
        serde_json::json!({"ok": true, "threadId": parent_thread_id}),
    );

    assert_eq!(
        http_observed.recv().await,
        Some((
            "parent".to_string(),
            Some(directory.to_string_lossy().into_owned())
        )),
    );
    let mut closed = Vec::new();
    for _ in 0..3 {
        closed.push(acp_observed_rx.recv().await.expect("closed family session"));
    }
    closed.sort();
    assert_eq!(
        closed,
        vec![
            "close:opencode:child".to_string(),
            "close:opencode:grandchild".to_string(),
            "close:opencode:parent".to_string(),
        ],
    );
    assert!(manager.session_index.lock().await.entries.is_empty());
    assert!(retirement_journal.entries().await.is_empty());
    for deleted_thread_id in [&parent_thread_id, &child_thread_id, &grandchild_thread_id] {
        assert!(scheduler.list(deleted_thread_id).await.is_empty());
        assert!(!queue.threads.read().await.contains_key(deleted_thread_id));
        assert_eq!(
            queue
                .retirement_fence
                .admit(deleted_thread_id)
                .await
                .unwrap_err(),
            "thread is being deleted",
        );
    }

    scheduler.shutdown().await;
    backend.shutdown().await;
    server.abort();
    let _ = server.await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn manager_keeps_opencode_session_when_loopback_claims_success_without_deleting() {
    let (acp_observed_tx, _acp_observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("opencode", false, true, acp_observed_tx).await;
    let mut opencode = manifest("opencode", "OpenCode");
    opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
    opencode.resolved.argv = vec!["acp".to_string()];
    let mut manager =
        AgentManager::from_start_results("opencode".to_string(), vec![(opencode, Ok(connection))])
            .await
            .unwrap();
    let (http_base, _http_observed, server) =
        opencode_delete_server(AxumStatusCode::OK, false).await;
    manager
        .agents
        .get_mut("opencode")
        .expect("OpenCode runtime")
        .http_base = Some(http_base);
    let identity = AgentSessionId::new("opencode", "opencode-listed").unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
        .await
        .unwrap();

    assert!(matches!(
        manager.delete_session(&identity.encode()).await,
        Err(AgentManagerError::Harness(_))
    ));
    assert_eq!(manager.session_index.lock().await.entries.len(), 1);
    manager.shutdown().await;
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn manager_opencode_steer_returns_after_handoff_admission() {
    let (acp_observed_tx, _acp_observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("opencode", false, true, acp_observed_tx).await;
    let session_id = SessionId::new("opencode-listed");
    connection
        .0
        .ensure_session(session_id.clone())
        .await
        .expect("load OpenCode session");
    let session = connection
        .0
        .session(&session_id)
        .await
        .expect("loaded OpenCode session");
    let (generation, _) = session
        .admit_prompt("run".to_string(), "turn".to_string())
        .await
        .expect("admit source prompt");
    let abort_calls = Arc::new(AtomicUsize::new(0));
    let abort_calls_for_route = abort_calls.clone();
    let status_idle = Arc::new(AtomicBool::new(false));
    let status_idle_for_route = status_idle.clone();
    let app = Router::new()
        .route(
            "/session/opencode-listed/abort",
            post(move || {
                let abort_calls = abort_calls_for_route.clone();
                async move {
                    if abort_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        AxumStatusCode::OK
                    } else {
                        AxumStatusCode::INTERNAL_SERVER_ERROR
                    }
                }
            }),
        )
        .route(
            "/session/opencode-listed/prompt_async",
            post(|| async { AxumStatusCode::NO_CONTENT }),
        )
        .route(
            "/session/status",
            get(move || {
                let status_idle = status_idle_for_route.clone();
                async move {
                    if status_idle.load(Ordering::SeqCst) {
                        Json(serde_json::json!({}))
                    } else {
                        Json(serde_json::json!({
                            "opencode-listed": {"type": "busy"}
                        }))
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener");
    let http_base = format!(
        "http://{}",
        listener.local_addr().expect("fixture local address"),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve OpenCode steer fixture");
    });

    let mut opencode = manifest("opencode", "OpenCode");
    opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
    opencode.resolved.argv = vec!["acp".to_string()];
    let mut manager =
        AgentManager::from_start_results("opencode".to_string(), vec![(opencode, Ok(connection))])
            .await
            .unwrap();
    manager
        .agents
        .get_mut("opencode")
        .expect("OpenCode runtime")
        .http_base = Some(http_base);
    let identity = AgentSessionId::new("opencode", "opencode-listed").unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
        .await
        .unwrap();
    let epoch = manager
        .prepare_steer(&identity.encode())
        .await
        .expect("prepare steer");
    let prompt = vec![serde_json::from_value(serde_json::json!({
        "type": "text",
        "text": "replacement"
    }))
    .expect("text content block")];

    tokio::time::timeout(
        Duration::from_millis(250),
        manager.steer(
            &identity.encode(),
            "run".to_string(),
            "turn".to_string(),
            generation,
            epoch,
            prompt,
        ),
    )
    .await
    .expect("steer returns after prompt admission")
    .expect("steer succeeds");
    assert_eq!(
        session.snapshot().await.active_generation,
        Some(generation + 1),
    );
    assert!(session.snapshot().await.messages.iter().any(|message| {
        message.role == MessageRole::User
            && message.parts.iter().any(|part| {
                part.get("text").and_then(serde_json::Value::as_str) == Some("replacement")
            })
    }));
    let failed_epoch = manager
        .prepare_steer(&identity.encode())
        .await
        .expect("prepare failed steer");
    assert!(matches!(
        manager
            .steer(
                &identity.encode(),
                "run".to_string(),
                "turn".to_string(),
                generation + 1,
                failed_epoch,
                vec![serde_json::from_value(serde_json::json!({
                    "type": "text",
                    "text": "rejected replacement"
                }))
                .expect("text content block")],
            )
            .await,
        Err(AgentManagerError::Harness(HarnessError::Http(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR
        )))
    ));
    assert_eq!(
        session.operation().await,
        Some(("run".to_string(), "turn".to_string(), generation + 1)),
    );
    status_idle.store(true, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if session.operation().await.is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("steered generation settles");

    server.abort();
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_delivers_opencode_agent_message_without_aborting_the_active_generation() {
    let (acp_observed_tx, _acp_observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("opencode", false, true, acp_observed_tx).await;
    let session_id = SessionId::new("opencode-listed");
    connection
        .0
        .ensure_session(session_id.clone())
        .await
        .expect("load OpenCode session");
    let session = connection
        .0
        .session(&session_id)
        .await
        .expect("loaded OpenCode session");
    let (generation, _) = session
        .admit_prompt("run".to_string(), "turn".to_string())
        .await
        .expect("admit source prompt");
    session
        .emit(CanonicalEvent::Tool {
            agent_id: "opencode".to_string(),
            thread_id: AgentSessionId::new("opencode", "opencode-listed")
                .unwrap()
                .encode(),
            run_id: Some("run".to_string()),
            source_turn_id: Some("turn".to_string()),
            generation: Some(generation),
            tool_call_id: "task-child".to_string(),
            kind: ToolKind::Other,
            status: ToolCallStatus::InProgress,
            title: "task".to_string(),
            content: FieldUpdate::Set(String::new()),
            structured_content: FieldUpdate::Set(Vec::new()),
            locations: FieldUpdate::Set(Vec::new()),
        })
        .await;

    let (http_observed_tx, mut http_observed_rx) = mpsc::unbounded_channel();
    let background_observed = http_observed_tx.clone();
    let prompt_observed = http_observed_tx;
    let app = Router::new()
        .route(
            "/experimental/session/opencode-listed/background",
            post(move || {
                let observed = background_observed.clone();
                async move {
                    observed
                        .send(("background".to_string(), serde_json::Value::Null))
                        .expect("observe background request");
                    Json(true)
                }
            }),
        )
        .route(
            "/session/opencode-listed/prompt_async",
            post(move |Json(body): Json<serde_json::Value>| {
                let observed = prompt_observed.clone();
                async move {
                    observed
                        .send(("prompt".to_string(), body))
                        .expect("observe prompt request");
                    AxumStatusCode::NO_CONTENT
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener");
    let http_base = format!(
        "http://{}",
        listener.local_addr().expect("fixture local address"),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve OpenCode live-message fixture");
    });

    let mut opencode = manifest("opencode", "OpenCode");
    opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
    opencode.resolved.argv = vec!["acp".to_string()];
    let mut manager =
        AgentManager::from_start_results("opencode".to_string(), vec![(opencode, Ok(connection))])
            .await
            .expect("manager");
    let identity = AgentSessionId::new("opencode", "opencode-listed").unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
        .await
        .expect("source index");
    let prompt = || {
        vec![serde_json::from_value(serde_json::json!({
            "type": "text",
            "text": "child needs guidance"
        }))
        .expect("text content block")]
    };
    assert!(!manager
        .supports_live_agent_message(&identity.encode())
        .expect("missing live-message capability"));
    let unsupported = manager
        .deliver_live_agent_message(
            &identity.encode(),
            "run".to_string(),
            "turn".to_string(),
            generation,
            0,
            prompt(),
        )
        .await
        .expect_err("missing harness is rejected");
    assert!(!unsupported.is_indeterminate());
    assert!(unsupported.to_string().contains("live agent messaging"));

    manager
        .agents
        .get_mut("opencode")
        .expect("OpenCode runtime")
        .http_base = Some(http_base);
    assert!(manager
        .supports_live_agent_message(&identity.encode())
        .expect("live-message capability"));
    let epoch = manager
        .current_steer_epoch(&identity.encode())
        .await
        .expect("read live-message epoch");
    let stale_epoch = manager
        .deliver_live_agent_message(
            &identity.encode(),
            "run".to_string(),
            "turn".to_string(),
            generation,
            epoch + 1,
            prompt(),
        )
        .await
        .expect_err("stale epoch is rejected");
    assert!(!stale_epoch.is_indeterminate());
    assert!(stale_epoch
        .to_string()
        .contains("stale agent-message interaction epoch"));
    let stale_correlation = manager
        .deliver_live_agent_message(
            &identity.encode(),
            "stale-run".to_string(),
            "turn".to_string(),
            generation,
            epoch,
            prompt(),
        )
        .await
        .expect_err("stale correlation is rejected");
    assert!(!stale_correlation.is_indeterminate());
    assert!(stale_correlation
        .to_string()
        .contains("stale agent-message correlation"));
    assert!(http_observed_rx.try_recv().is_err());

    manager
        .deliver_live_agent_message(
            &identity.encode(),
            "run".to_string(),
            "turn".to_string(),
            generation,
            epoch,
            prompt(),
        )
        .await
        .expect("deliver live agent message");

    assert_eq!(
        http_observed_rx.recv().await,
        Some(("background".to_string(), serde_json::Value::Null)),
    );
    assert_eq!(
        http_observed_rx.recv().await,
        Some((
            "prompt".to_string(),
            serde_json::json!({
                "parts": [{"type": "text", "text": "child needs guidance"}]
            })
        )),
    );
    assert!(http_observed_rx.try_recv().is_err());
    assert_eq!(
        session.operation().await,
        Some(("run".to_string(), "turn".to_string(), generation)),
    );

    server.abort();
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_delete_is_rejected_and_keeps_the_session_when_the_agent_cannot_delete() {
    let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("plain-agent", false, false, observed_tx).await;
    let manager = AgentManager::from_start_results(
        "plain-agent".to_string(),
        vec![(manifest("plain-agent", "Plain"), Ok(connection))],
    )
    .await
    .unwrap();
    let identity = AgentSessionId::new("plain-agent", "plain-agent-listed").unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
        .await
        .unwrap();
    let thread_id = identity.encode();

    assert!(matches!(
        manager.delete_session(&thread_id).await,
        Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
            "session/delete"
        )))
    ));

    assert!(observed_rx.try_recv().is_err());
    assert_eq!(manager.session_index.lock().await.entries.len(), 1);
    assert!(manager
        .list_sessions(None, 100)
        .await
        .unwrap()
        .sessions
        .iter()
        .any(|session| session.thread_id == thread_id));
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_delete_rejects_an_unroutable_thread() {
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let connection = deleting_connection("delete-agent", true, false, observed_tx).await;
    let manager = AgentManager::from_start_results(
        "delete-agent".to_string(),
        vec![(manifest("delete-agent", "Delete"), Ok(connection))],
    )
    .await
    .unwrap();

    assert!(manager.delete_session("not-a-thread-id").await.is_err());
    manager.shutdown().await;
}

fn model_config_option(current: &str) -> SessionConfigOption {
    serde_json::from_value(serde_json::json!({
        "id": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": current,
        "options": [
            {"value": "default-model", "name": "Default Model"},
            {"value": "chosen-model", "name": "Chosen Model"},
        ],
    }))
    .expect("model config option")
}

/// Mirrors agents such as OpenCode, which answer `session/resume` with a freshly defaulted
/// configuration instead of the session's current one.
async fn model_resetting_connection(
    agent_id: &str,
    model: Arc<Mutex<String>>,
) -> (AcpConnection, NegotiatedInitialize) {
    let agent = Agent
        .v1()
        .on_receive_request(
            async move |request: InitializeRequest, responder, _| {
                responder.respond(
                    InitializeResponse::new(request.protocol_version).agent_capabilities(
                        AgentCapabilities::new().session_capabilities(
                            SessionCapabilities::new().resume(SessionResumeCapabilities::new()),
                        ),
                    ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let model = model.clone();
                async move |_: NewSessionRequest, responder, _| {
                    let current = model.lock().await.clone();
                    responder.respond(
                        NewSessionResponse::new("model-session")
                            .config_options(vec![model_config_option(&current)]),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let model = model.clone();
                async move |request: SetSessionConfigOptionRequest, responder, _| {
                    let SessionConfigOptionValue::ValueId { value } = request.value else {
                        return responder
                            .respond_with_error(agent_client_protocol::Error::internal_error());
                    };
                    let value = value.to_string();
                    *model.lock().await = value.clone();
                    responder.respond(SetSessionConfigOptionResponse::new(vec![
                        model_config_option(&value),
                    ]))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let model = model.clone();
                async move |_: ResumeSessionRequest, responder, _| {
                    *model.lock().await = "default-model".to_string();
                    responder.respond(
                        ResumeSessionResponse::new()
                            .config_options(vec![model_config_option("default-model")]),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        );
    AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
        .await
        .expect("model resetting agent starts")
}

#[tokio::test]
async fn manager_resume_keeps_the_configured_model_when_the_agent_resets_it() {
    let model = Arc::new(Mutex::new("default-model".to_string()));
    let connection = model_resetting_connection("model-agent", model.clone()).await;
    let manager = AgentManager::from_start_results(
        "model-agent".to_string(),
        vec![(manifest("model-agent", "Model"), Ok(connection))],
    )
    .await
    .expect("manager");
    let session = manager
        .new_session("model-agent", NewSessionRequest::new("/tmp"))
        .await
        .expect("session starts");
    let thread_id = session.thread_id.clone();

    let configured = manager
        .set_session_config_option(
            &thread_id,
            "model",
            SessionConfigOptionValue::value_id("chosen-model"),
        )
        .await
        .expect("model applied");
    assert_eq!(
        configured
            .snapshot
            .config
            .iter()
            .find(|entry| entry.id == "model")
            .map(|entry| entry.value.as_str()),
        Some("chosen-model"),
    );

    let resumed = manager
        .resume_session_with_policy(&thread_id, "/tmp", ApprovalPolicy::Untrusted)
        .await
        .expect("session resumes");

    assert_eq!(
        resumed
            .snapshot
            .config
            .iter()
            .find(|entry| entry.id == "model")
            .map(|entry| entry.value.as_str()),
        Some("chosen-model"),
        "resume must not discard the configured model",
    );
    assert_eq!(model.lock().await.as_str(), "chosen-model");

    let read = manager
        .read_session(&thread_id)
        .await
        .expect("session read");
    assert_eq!(
        read.snapshot
            .config
            .iter()
            .find(|entry| entry.id == "model")
            .map(|entry| entry.value.as_str()),
        Some("chosen-model"),
    );
}

#[tokio::test]
async fn config_update_snapshot_includes_restored_agent_messages() {
    let model = Arc::new(Mutex::new("default-model".to_string()));
    let connection = model_resetting_connection("model-agent", model).await;
    let manager = AgentManager::from_start_results(
        "model-agent".to_string(),
        vec![(manifest("model-agent", "Model"), Ok(connection))],
    )
    .await
    .expect("manager");
    let session = manager
        .new_session("model-agent", NewSessionRequest::new("/tmp"))
        .await
        .expect("session starts");
    manager
        .agent_message_journal
        .lock()
        .await
        .upsert_many(vec![(
            session.thread_id.clone(),
            None,
            sent_agent_message("config-update-message", "child-thread"),
        )])
        .await
        .unwrap();

    let configured = manager
        .set_session_config_option(
            &session.thread_id,
            "model",
            SessionConfigOptionValue::value_id("chosen-model"),
        )
        .await
        .expect("model applied");

    assert!(configured.snapshot.messages.iter().any(|message| {
        message
            .agent_message
            .as_ref()
            .is_some_and(|origin| origin.message_id == "config-update-message")
    }));
    manager.shutdown().await;
}

#[tokio::test]
async fn reconstructed_recipient_prompt_reconciles_interrupted_journal_to_sent() {
    let model = Arc::new(Mutex::new("default-model".to_string()));
    let connection = model_resetting_connection("model-agent", model).await;
    let manager = AgentManager::from_start_results(
        "model-agent".to_string(),
        vec![(manifest("model-agent", "Model"), Ok(connection))],
    )
    .await
    .expect("manager");
    let session = manager
        .new_session("model-agent", NewSessionRequest::new("/tmp"))
        .await
        .expect("session starts");
    let mut received = sent_agent_message("recovered-message", "parent-thread");
    received.direction = crate::agent_messaging::AgentMessageDirection::Received;
    received.relation = AgentRelationKind::Parent;
    received.disposition = crate::agent_messaging::AgentMessageDisposition::Cancelled;
    let mut sent = sent_agent_message("recovered-message", &session.thread_id);
    sent.disposition = crate::agent_messaging::AgentMessageDisposition::Cancelled;
    manager
        .agent_message_journal
        .lock()
        .await
        .upsert_many(vec![
            (session.thread_id.clone(), None, received.clone()),
            ("parent-thread".to_string(), None, sent),
        ])
        .await
        .expect("interrupted activity persists");
    let mut snapshot = SessionSnapshot::new("model-agent".to_string(), session.thread_id.clone());
    received.disposition = crate::agent_messaging::AgentMessageDisposition::Queued;
    snapshot.append_agent_message_after(received, None);

    manager.reconcile_received_agent_messages(&snapshot).await;

    let reconciled = manager
        .agent_message_journal
        .lock()
        .await
        .messages_for_id("recovered-message");
    assert_eq!(reconciled.len(), 2);
    assert!(reconciled.iter().all(|(_, message)| {
        message.disposition == crate::agent_messaging::AgentMessageDisposition::Sent
    }));
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_resume_prefers_resume_and_falls_back_to_load() {
    let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
    let resume_capabilities = AgentCapabilities::new()
        .session_capabilities(SessionCapabilities::new().resume(SessionResumeCapabilities::new()));
    let load_capabilities = AgentCapabilities::new().load_session(true);
    let resume =
        connection_with_capabilities("resume-agent", resume_capabilities, observed_tx.clone())
            .await;
    let load = connection_with_capabilities("load-agent", load_capabilities, observed_tx).await;
    let manager = AgentManager::from_start_results(
        "resume-agent".to_string(),
        vec![
            (manifest("resume-agent", "Resume"), Ok(resume)),
            (manifest("load-agent", "Load"), Ok(load)),
        ],
    )
    .await
    .unwrap();
    let resume_thread = AgentSessionId::new("resume-agent", "resume-session")
        .unwrap()
        .encode();
    manager
        .resume_session_with_policy(&resume_thread, "/tmp", ApprovalPolicy::Never)
        .await
        .unwrap();
    assert_eq!(
        observed_rx.recv().await.as_deref(),
        Some("resume:resume-agent"),
    );
    let load_thread = AgentSessionId::new("load-agent", "load-session")
        .unwrap()
        .encode();
    manager
        .resume_session_with_policy(&load_thread, "/tmp", ApprovalPolicy::OnRequest)
        .await
        .unwrap();
    assert_eq!(observed_rx.recv().await.as_deref(), Some("load:load-agent"));
    {
        let index = manager.session_index.lock().await;
        let entries = &index.entries;
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.acp_session_id == "resume-session")
                .expect("resumed session indexed")
                .approval_policy,
            ApprovalPolicy::Never,
        );
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.acp_session_id == "load-session")
                .expect("loaded session indexed")
                .approval_policy,
            ApprovalPolicy::OnRequest,
        );
    }
    manager
        .resume_session(&resume_thread, "/tmp")
        .await
        .unwrap();
    assert_eq!(
        observed_rx.recv().await.as_deref(),
        Some("resume:resume-agent"),
    );
    assert_eq!(
        manager
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| entry.acp_session_id == "resume-session")
            .expect("resumed session remains indexed")
            .approval_policy,
        ApprovalPolicy::Untrusted,
    );
    let listed = manager.list_sessions(None, 100).await.unwrap().sessions;
    assert_eq!(listed.len(), 2);
    assert_eq!(
        listed
            .iter()
            .filter(|session| session.thread_id == resume_thread)
            .count(),
        1,
    );
    assert_eq!(
        listed
            .iter()
            .filter(|session| session.thread_id == load_thread)
            .count(),
        1,
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_resume_without_restoration_capability_leaves_registry_unchanged() {
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let connection =
        connection_with_capabilities("plain-agent", AgentCapabilities::new(), observed_tx).await;
    let manager = AgentManager::from_start_results(
        "plain-agent".to_string(),
        vec![(manifest("plain-agent", "Plain"), Ok(connection))],
    )
    .await
    .unwrap();
    let thread_id = AgentSessionId::new("plain-agent", "missing-session")
        .unwrap()
        .encode();
    assert!(matches!(
        manager.resume_session(&thread_id, "/tmp").await,
        Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
            "session/resume or session/load"
        )))
    ));
    assert!(manager.loaded_session_ids().await.is_empty());
    manager.shutdown().await;
}

#[tokio::test]
async fn manager_mailbox_backpressures_and_preserves_terminal_interaction_order() {
    let manager = AgentManager::from_start_results("agent".into(), Vec::new())
        .await
        .expect("manager starts");
    let mut events = manager.take_events().await.expect("manager event receiver");
    for index in 0..1_024 {
        manager
            .events
            .send(CanonicalEvent::Ignored {
                agent_id: "agent".into(),
                thread_id: Some("thread".into()),
                kind: format!("filler-{index}"),
            })
            .await
            .expect("mailbox open");
    }
    let producer = {
        let sender = manager.events.clone();
        tokio::spawn(async move {
            sender
                .send(CanonicalEvent::PermissionResolved {
                    agent_id: "agent".into(),
                    thread_id: "thread".into(),
                    request_id: "request".into(),
                    outcome: "cancelled".into(),
                })
                .await
        })
    };
    tokio::task::yield_now().await;
    assert!(!producer.is_finished());
    for index in 0..1_024 {
        assert!(matches!(
            events.recv().await,
            Some(CanonicalEvent::Ignored { kind, .. }) if kind == format!("filler-{index}")
        ));
    }
    producer
        .await
        .expect("producer task")
        .expect("mailbox open");
    assert!(matches!(
        events.recv().await,
        Some(CanonicalEvent::PermissionResolved { request_id, .. }) if request_id == "request"
    ));
}

#[tokio::test]
async fn manager_state_paths_cover_stopped_pagination_and_invalid_tracking() {
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let ready = connection("ready-agent", false, "unused", observed_tx).await;
    let manager = AgentManager::from_start_results(
        "ready-agent".into(),
        vec![
            (manifest("ready-agent", "Ready"), Ok(ready)),
            (
                manifest("offline-agent", "Offline"),
                Err(AcpRuntimeError::Connection("offline".into())),
            ),
        ],
    )
    .await
    .expect("manager starts");
    assert!(manager.take_events().await.is_some());
    assert!(manager.take_events().await.is_none());

    let page = manager
        .list_sessions(Some(&encode_cursor(1)), 1)
        .await
        .expect("nonzero page");
    assert!(page.sessions.is_empty());
    assert!(page.next_cursor.is_none());
    assert!(manager.pending_permissions().await.is_empty());
    assert!(manager.pending_elicitations().await.is_empty());

    let loaded = manager
        .new_session("ready-agent", NewSessionRequest::new("/tmp"))
        .await
        .unwrap();
    manager.session_index.lock().await.fail_writes = true;
    manager.pending_durable_sessions.lock().await.insert(
        loaded.thread_id.clone(),
        index_entry(
            AgentSessionId::decode(&loaded.thread_id).unwrap(),
            PathBuf::from("/tmp"),
        ),
    );

    let unknown = AgentSessionId::new("unknown-agent", "session").unwrap();
    let _ = manager
        .track_session(unknown.clone(), PathBuf::from("/tmp"))
        .await;
    let _ = manager.track_session(unknown, PathBuf::from("/tmp")).await;
    let _ = manager
        .track_session(
            AgentSessionId::new("ready-agent", "missing").unwrap(),
            PathBuf::from("/tmp"),
        )
        .await;
    manager
        .tracked_sessions
        .lock()
        .await
        .insert("not-a-thread-id".to_string(), Uuid::new_v4());
    manager.flush_events().await;

    manager.shutdown().await;
    let _ = manager.list_agents();
    manager.shutdown().await;
}

#[tokio::test]
async fn session_forwarder_stops_on_upstream_and_downstream_closure() {
    let thread_id = "thread".to_string();
    let instance_id = Uuid::new_v4();
    let tracked = Arc::new(Mutex::new(HashMap::from([(
        thread_id.clone(),
        instance_id,
    )])));
    let (upstream, receiver) = canonical_event_channel(1);
    let (downstream, _events) = canonical_event_channel(1);
    drop(upstream);
    forward_session_events(
        receiver,
        downstream,
        tracked.clone(),
        thread_id.clone(),
        instance_id,
    )
    .await;
    assert!(!tracked.lock().await.contains_key(&thread_id));

    let stale_instance_id = Uuid::new_v4();
    let current_instance_id = Uuid::new_v4();
    tracked
        .lock()
        .await
        .insert(thread_id.clone(), current_instance_id);
    let (upstream, receiver) = canonical_event_channel(1);
    let (downstream, events) = canonical_event_channel(1);
    drop(events);
    upstream
        .send(CanonicalEvent::Ignored {
            agent_id: "agent".into(),
            thread_id: None,
            kind: "closed".into(),
        })
        .await
        .expect("upstream open");
    forward_session_events(
        receiver,
        downstream,
        tracked.clone(),
        thread_id.clone(),
        stale_instance_id,
    )
    .await;
    assert_eq!(
        tracked.lock().await.get(&thread_id),
        Some(&current_instance_id),
    );
}

#[tokio::test]
async fn evicted_session_replacement_forwards_once_and_survives_old_task_cleanup() {
    let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
    let connection = connection("agent", true, "history", observed_tx).await;
    let manager = AgentManager::from_start_results(
        "agent".into(),
        vec![(manifest("agent", "Agent"), Ok(connection))],
    )
    .await
    .expect("manager starts");
    let created = manager
        .new_session("agent", NewSessionRequest::new("/tmp"))
        .await
        .expect("session created");
    let identity = AgentSessionId::decode(&created.thread_id).unwrap();
    let session_id = SessionId::new(identity.acp_session_id.clone());
    let connection = manager.connection("agent").unwrap();
    let old_session = connection.session(&session_id).await.unwrap();
    let old_instance_id = old_session.instance_id();
    let mut events = manager.take_events().await.expect("manager event receiver");

    connection.evict_session(&session_id).await;
    let replacement = connection.ensure_session(session_id).await.unwrap();
    let replacement_instance_id = replacement.instance_id();
    assert_ne!(old_instance_id, replacement_instance_id);
    manager.register_session_events(&identity).await;
    assert_eq!(
        manager
            .tracked_sessions
            .lock()
            .await
            .get(&created.thread_id),
        Some(&replacement_instance_id),
    );

    replacement
        .emit(CanonicalEvent::Ignored {
            agent_id: "agent".into(),
            thread_id: Some(created.thread_id.clone()),
            kind: "replacement".into(),
        })
        .await;
    replacement.flush_events().await;
    assert!(matches!(
        events.recv().await,
        Some(CanonicalEvent::Ignored { kind, .. }) if kind == "replacement"
    ));
    assert!(matches!(
        events.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));

    drop(old_session);
    tokio::task::yield_now().await;
    assert_eq!(
        manager
            .tracked_sessions
            .lock()
            .await
            .get(&created.thread_id),
        Some(&replacement_instance_id),
    );
}

#[tokio::test]
async fn agent_relations_are_limited_to_direct_index_edges() {
    let (alpha_tx, _alpha_rx) = mpsc::unbounded_channel();
    let (beta_tx, _beta_rx) = mpsc::unbounded_channel();
    let alpha = connection("alpha", false, "unused", alpha_tx).await;
    let beta = connection("beta", false, "unused", beta_tx).await;
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![
            (manifest("alpha", "Alpha"), Ok(alpha)),
            (manifest("beta", "Beta"), Ok(beta)),
        ],
    )
    .await
    .expect("manager starts");

    let parent = AgentSessionId::new("alpha", "parent").unwrap();
    let child = AgentSessionId::new("alpha", "child").unwrap();
    let sibling = AgentSessionId::new("alpha", "sibling").unwrap();
    let grandchild = AgentSessionId::new("alpha", "grandchild").unwrap();
    let cross_agent = AgentSessionId::new("beta", "other").unwrap();
    let mut parent_entry = index_entry(parent.clone(), PathBuf::from("/tmp"));
    parent_entry.title = Some("Parent".into());
    let mut child_entry = index_entry(child.clone(), PathBuf::from("/tmp"));
    child_entry.title = Some("Worker".into());
    child_entry.parent_acp_session_id = Some(parent.acp_session_id.clone());
    let mut sibling_entry = index_entry(sibling.clone(), PathBuf::from("/tmp"));
    sibling_entry.parent_acp_session_id = Some(parent.acp_session_id.clone());
    let mut grandchild_entry = index_entry(grandchild.clone(), PathBuf::from("/tmp"));
    grandchild_entry.title = Some("Nested worker".into());
    grandchild_entry.parent_acp_session_id = Some(child.acp_session_id.clone());
    manager
        .session_index
        .lock()
        .await
        .insert_all([
            parent_entry,
            child_entry,
            sibling_entry,
            grandchild_entry,
            index_entry(cross_agent.clone(), PathBuf::from("/tmp")),
        ])
        .await
        .expect("index family");
    manager
        .connection("alpha")
        .unwrap()
        .ensure_session(SessionId::new(child.acp_session_id.clone()))
        .await
        .expect("load caller");

    let relations = manager
        .agent_relations(&child.encode())
        .await
        .expect("child relations");
    assert!(
        serde_json::to_value(&relations)
            .expect("relations serialize")
            .get("caller")
            .is_none(),
        "the recipient listing must not expose the caller as a target",
    );
    assert_eq!(
        relations.parent,
        Some(AgentRelationSession {
            thread_id: parent.encode(),
            title: Some("Parent".into()),
            status: AgentRelationStatus::Unloaded,
        }),
    );
    assert_eq!(
        relations.children,
        vec![AgentRelationSession {
            thread_id: grandchild.encode(),
            title: Some("Nested worker".into()),
            status: AgentRelationStatus::Unloaded,
        }],
    );
    assert!(!relations.children_truncated);

    assert_eq!(
        manager
            .direct_agent_relation(&child.encode(), &parent.encode())
            .await,
        Ok(AgentRelationKind::Parent),
    );
    assert_eq!(
        manager
            .direct_agent_relation(&child.encode(), &grandchild.encode())
            .await,
        Ok(AgentRelationKind::SubAgent),
    );
    assert_eq!(
        manager
            .direct_agent_relation(&parent.encode(), &grandchild.encode())
            .await,
        Err(AgentRelationError::NotDirect),
    );
    assert_eq!(
        manager
            .direct_agent_relation(&child.encode(), &sibling.encode())
            .await,
        Err(AgentRelationError::NotDirect),
    );
    assert_eq!(
        manager
            .direct_agent_relation(&child.encode(), &cross_agent.encode())
            .await,
        Err(AgentRelationError::CrossAgent),
    );
    assert_eq!(
        manager
            .direct_agent_relation(&child.encode(), &child.encode())
            .await,
        Err(AgentRelationError::SelfTarget),
    );
    assert!(matches!(
        manager
            .direct_agent_relation(
                &child.encode(),
                &AgentSessionId::new("alpha", "missing").unwrap().encode(),
            )
            .await,
        Err(AgentRelationError::UnknownTarget(_))
    ));
    assert_eq!(
        manager.agent_relations("invalid").await,
        Err(AgentRelationError::InvalidThreadId),
    );

    manager.shutdown().await;
}

#[tokio::test]
async fn direct_agent_relation_resolution_is_not_limited_by_the_listing_cap() {
    let (alpha_tx, _alpha_rx) = mpsc::unbounded_channel();
    let alpha = connection("alpha", false, "unused", alpha_tx).await;
    let manager = AgentManager::from_start_results(
        "alpha".into(),
        vec![(manifest("alpha", "Alpha"), Ok(alpha))],
    )
    .await
    .expect("manager starts");

    let parent = AgentSessionId::new("alpha", "parent").unwrap();
    let mut parent_entry = index_entry(parent.clone(), PathBuf::from("/tmp"));
    parent_entry.title = Some("Parent".into());
    let mut entries = vec![parent_entry];
    let mut children = Vec::new();
    for index in 0..(MAX_AGENT_RELATION_CHILDREN + 2) {
        let child =
            AgentSessionId::new("alpha", format!("child-{index:03}")).expect("child identity");
        let mut entry = index_entry(child.clone(), PathBuf::from("/tmp"));
        entry.title = Some(format!("Worker {index:03}"));
        entry.parent_acp_session_id = Some(parent.acp_session_id.clone());
        entries.push(entry);
        children.push(child);
    }
    manager
        .session_index
        .lock()
        .await
        .insert_all(entries)
        .await
        .expect("index parent and children");
    manager
        .connection("alpha")
        .unwrap()
        .ensure_session(SessionId::new(parent.acp_session_id.clone()))
        .await
        .expect("load parent");

    let listed = manager
        .agent_relations(&parent.encode())
        .await
        .expect("parent relations");
    assert_eq!(listed.children.len(), MAX_AGENT_RELATION_CHILDREN);
    assert!(listed.children_truncated);
    let target = children
        .into_iter()
        .find(|child| {
            listed
                .children
                .iter()
                .all(|relation| relation.thread_id != child.encode())
        })
        .expect("at least one direct child is omitted from the listing");
    manager
        .connection("alpha")
        .unwrap()
        .ensure_session(SessionId::new(target.acp_session_id.clone()))
        .await
        .expect("load omitted target");

    let (relation, caller, recipient) = manager
        .direct_agent_relation_sessions(&parent.encode(), &target.encode())
        .await
        .expect("resolve omitted direct child");
    assert_eq!(relation, AgentRelationKind::SubAgent);
    assert_eq!(caller.thread_id, parent.encode());
    assert_eq!(caller.status, AgentRelationStatus::Idle);
    assert_eq!(recipient.thread_id, target.encode());
    assert_eq!(recipient.status, AgentRelationStatus::Idle);

    manager.shutdown().await;
}

#[tokio::test]
async fn agent_message_journal_is_bounded_deduplicated_and_restart_safe() {
    let directory = std::env::temp_dir().join(format!(
        "dappercode-agent-message-journal-{}",
        Uuid::new_v4(),
    ));
    tokio::fs::create_dir_all(&directory).await.unwrap();
    let path = directory.join(AGENT_MESSAGE_JOURNAL_FILE);
    let thread_id = AgentSessionId::new("alpha", "parent").unwrap().encode();
    let related_thread_id = AgentSessionId::new("alpha", "child").unwrap().encode();
    let origin = |message_id: String, disposition| crate::agent_messaging::AgentMessageOrigin {
        message_id,
        direction: crate::agent_messaging::AgentMessageDirection::Sent,
        related_thread_id: related_thread_id.clone(),
        related_title: Some("Worker".to_string()),
        relation: AgentRelationKind::SubAgent,
        disposition,
        body: "Check the queue lifecycle.".to_string(),
    };

    let mut journal = DurableAgentMessageJournal::load(Some(path.clone())).await;
    journal
        .upsert_many(vec![(
            thread_id.clone(),
            Some("tool-before-send".to_string()),
            origin(
                "message-1".to_string(),
                crate::agent_messaging::AgentMessageDisposition::Queued,
            ),
        )])
        .await
        .unwrap();
    journal
        .upsert_many(vec![(
            thread_id.clone(),
            Some("later-message".to_string()),
            origin(
                "message-1".to_string(),
                crate::agent_messaging::AgentMessageDisposition::Steering,
            ),
        )])
        .await
        .unwrap();
    journal
        .upsert_many(vec![(
            thread_id.clone(),
            None,
            origin(
                "restart-queued".to_string(),
                crate::agent_messaging::AgentMessageDisposition::Queued,
            ),
        )])
        .await
        .unwrap();

    let mut journal = DurableAgentMessageJournal::load(Some(path.clone())).await;
    assert_eq!(journal.entries.len(), 2);
    assert_eq!(
        journal.entries[0].message.disposition,
        crate::agent_messaging::AgentMessageDisposition::Cancelled,
    );
    assert_eq!(
        journal.entries[1].message.disposition,
        crate::agent_messaging::AgentMessageDisposition::Cancelled,
    );
    assert_eq!(
        journal.entries[0].after_timeline_id.as_deref(),
        Some("tool-before-send"),
    );
    assert_eq!(
        journal
            .update_disposition(
                "message-1",
                crate::agent_messaging::AgentMessageDisposition::Sent,
            )
            .await
            .unwrap(),
        vec![(
            thread_id.clone(),
            origin(
                "message-1".to_string(),
                crate::agent_messaging::AgentMessageDisposition::Sent,
            ),
        )],
    );
    assert_eq!(
        DurableAgentMessageJournal::load(Some(path.clone()))
            .await
            .entries[0]
            .message
            .disposition,
        crate::agent_messaging::AgentMessageDisposition::Sent,
    );
    assert!(journal
        .update_disposition(
            "message-1",
            crate::agent_messaging::AgentMessageDisposition::Steering,
        )
        .await
        .expect("terminal sent disposition remains monotonic")
        .is_empty());
    assert!(journal
        .update_disposition(
            "restart-queued",
            crate::agent_messaging::AgentMessageDisposition::Queued,
        )
        .await
        .expect("cancelled disposition cannot reactivate queued work")
        .is_empty());
    assert_eq!(
        journal.entries[0].message.disposition,
        crate::agent_messaging::AgentMessageDisposition::Sent,
    );
    assert_eq!(
        journal.entries[1].message.disposition,
        crate::agent_messaging::AgentMessageDisposition::Cancelled,
    );
    journal
        .remove_message("restart-queued")
        .await
        .expect("provisional message can be removed");
    assert!(journal
        .entries
        .iter()
        .all(|entry| entry.message.message_id != "restart-queued"));
    journal.path = None;
    for index in 0..=MAX_AGENT_MESSAGE_JOURNAL_ENTRIES {
        journal
            .upsert(
                &thread_id,
                origin(
                    format!("bounded-{index}"),
                    crate::agent_messaging::AgentMessageDisposition::Sent,
                ),
            )
            .await
            .unwrap();
    }
    assert_eq!(journal.entries.len(), MAX_AGENT_MESSAGE_JOURNAL_ENTRIES);
    assert!(agent_message_journal_bytes(&journal.entries)
        .is_some_and(|bytes| bytes.len() <= MAX_AGENT_MESSAGE_JOURNAL_BYTES));

    journal.path = Some(path.clone());
    journal
        .remove_threads(std::slice::from_ref(&thread_id))
        .await
        .unwrap();
    assert!(DurableAgentMessageJournal::load(Some(path))
        .await
        .entries
        .is_empty());
    let _ = tokio::fs::remove_dir_all(directory).await;
}

#[tokio::test]
async fn retirement_reconciliation_handles_invalid_missing_and_unavailable_agents() {
    let cwd = std::env::current_dir().unwrap();
    let indexed_unknown = AgentSessionId::new("unknown", "indexed").unwrap();
    let absent_unknown = AgentSessionId::new("unknown", "absent").unwrap();
    let manager = AgentManager::from_start_results("none".to_string(), Vec::new())
        .await
        .unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(indexed_unknown.clone(), cwd.clone())])
        .await
        .unwrap();
    assert_eq!(
        manager.reconcile_retirement_plan(&[]).await,
        RetirementPlanReconciliation::Indeterminate,
    );
    assert_eq!(
        manager
            .reconcile_retirement_plan(&["not-an-opaque-thread".to_string()])
            .await,
        RetirementPlanReconciliation::Indeterminate,
    );
    assert_eq!(
        manager
            .reconcile_retirement_plan(&[indexed_unknown.encode(), absent_unknown.encode(),])
            .await,
        RetirementPlanReconciliation::Indeterminate,
    );
    manager
        .finalize_confirmed_deleted_sessions(&[absent_unknown.encode()])
        .await
        .unwrap();
    manager.shutdown().await;

    let unavailable_indexed = AgentSessionId::new("unavailable", "indexed").unwrap();
    let unavailable_absent = AgentSessionId::new("unavailable", "absent").unwrap();
    let (observed, _) = mpsc::unbounded_channel();
    let ready_connection = connection("ready", false, "unused", observed).await;
    let manager = AgentManager::from_start_results(
        "ready".to_string(),
        vec![
            (manifest("ready", "Ready"), Ok(ready_connection)),
            (
                manifest("unavailable", "Unavailable"),
                Err(AcpRuntimeError::Connection("offline".to_string())),
            ),
        ],
    )
    .await
    .unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(unavailable_indexed.clone(), cwd.clone())])
        .await
        .unwrap();
    assert_eq!(
        manager
            .reconcile_retirement_plan(
                &[unavailable_indexed.encode(), unavailable_absent.encode(),]
            )
            .await,
        RetirementPlanReconciliation::Indeterminate,
    );
    manager.shutdown().await;

    let (observed, _) = mpsc::unbounded_channel();
    let plain_connection = connection("plain", false, "unused", observed).await;
    let plain_indexed = AgentSessionId::new("plain", "indexed").unwrap();
    let plain_absent = AgentSessionId::new("plain", "absent").unwrap();
    let manager = AgentManager::from_start_results(
        "plain".to_string(),
        vec![(manifest("plain", "Plain"), Ok(plain_connection))],
    )
    .await
    .unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(plain_indexed.clone(), cwd)])
        .await
        .unwrap();
    assert_eq!(
        manager
            .reconcile_retirement_plan(&[plain_indexed.encode(), plain_absent.encode()])
            .await,
        RetirementPlanReconciliation::Indeterminate,
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn opencode_retirement_reconciliation_uses_exact_session_statuses() {
    async fn exact_session(AxumPath(session_id): AxumPath<String>) -> impl IntoResponse {
        match session_id.as_str() {
            "live" => Json(serde_json::json!({"id": "live"})).into_response(),
            "absent" => AxumStatusCode::NOT_FOUND.into_response(),
            "wrong" => Json(serde_json::json!({"id": "different"})).into_response(),
            _ => AxumStatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }

    let app = Router::new().route("/session/{session_id}", get(exact_session));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http_base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let (observed, _) = mpsc::unbounded_channel();
    let connection = connection("opencode", false, "unused", observed).await;
    let mut opencode = manifest("opencode", "OpenCode");
    opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
    opencode.resolved.argv = vec!["acp".to_string()];
    let mut manager =
        AgentManager::from_start_results("opencode".to_string(), vec![(opencode, Ok(connection))])
            .await
            .unwrap();
    manager.agents.get_mut("opencode").unwrap().http_base = Some(http_base);
    let identities = ["live", "absent", "wrong", "failure"]
        .map(|session_id| AgentSessionId::new("opencode", session_id).unwrap());
    let cwd = std::env::current_dir().unwrap();
    manager
        .session_index
        .lock()
        .await
        .insert_all(
            identities
                .iter()
                .cloned()
                .map(|identity| index_entry(identity, cwd.clone())),
        )
        .await
        .unwrap();

    assert_eq!(
        manager
            .reconcile_retirement_plan(&[identities[0].encode()])
            .await,
        RetirementPlanReconciliation::Present,
    );
    assert_eq!(
        manager
            .reconcile_retirement_plan(&[identities[1].encode()])
            .await,
        RetirementPlanReconciliation::Absent,
    );
    for identity in [&identities[2], &identities[3]] {
        assert_eq!(
            manager
                .reconcile_retirement_plan(&[identity.encode()])
                .await,
            RetirementPlanReconciliation::Indeterminate,
        );
    }
    assert_eq!(
        manager
            .reconcile_retirement_plan(&[identities[0].encode(), identities[1].encode(),])
            .await,
        RetirementPlanReconciliation::Indeterminate,
    );
    let unindexed = AgentSessionId::new("opencode", "unindexed").unwrap();
    assert_eq!(
        manager
            .reconcile_retirement_plan(&[unindexed.encode()])
            .await,
        RetirementPlanReconciliation::Absent,
    );

    manager.shutdown().await;
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn subagent_generation_tracking_covers_relinks_retirement_and_capacity() {
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection("alpha", false, "unused", observed).await;
    let manager = AgentManager::from_start_results(
        "alpha".to_string(),
        vec![(manifest("alpha", "Alpha"), Ok(ready))],
    )
    .await
    .unwrap();

    assert!(!manager.tracks_subagent_generation("child").await);
    assert!(manager
        .accepted_subagent_terminal("missing", 1)
        .await
        .is_none());
    manager.note_subagent_started("missing", 1).await;
    manager
        .note_subagent_link("parent", "child", "tool-1")
        .await;
    assert!(manager.tracks_subagent_generation("child").await);
    manager
        .note_subagent_link("parent", "child", "tool-1")
        .await;
    manager.retire_subagent_link("child", "wrong-tool").await;
    assert!(manager
        .accepted_subagent_terminal("child", 1)
        .await
        .is_some());
    manager.note_subagent_started("child", 1).await;
    manager
        .note_subagent_link("parent-2", "child", "tool-2")
        .await;
    assert!(manager
        .accepted_subagent_terminal("child", 1)
        .await
        .is_none());
    manager.note_subagent_started("child", 2).await;
    assert_eq!(
        manager
            .accepted_subagent_terminal("child", 2)
            .await
            .unwrap()
            .parent_thread_id,
        "parent-2",
    );
    manager.retire_subagent_link("child", "tool-2").await;
    assert!(manager
        .accepted_subagent_terminal("child", 2)
        .await
        .is_none());

    {
        let mut generations = manager.subagent_generations.lock().await;
        generations.clear();
        for index in 0..MAX_TRACKED_SUBAGENT_GENERATIONS {
            generations.insert(
                format!("full-{index}"),
                SubagentGenerationState {
                    parent_thread_id: "parent".to_string(),
                    tool_call_id: "tool".to_string(),
                    observed_generation: None,
                    minimum_generation: None,
                    armed: true,
                },
            );
        }
    }
    manager
        .note_subagent_link("parent", "overflow", "tool")
        .await;
    let generations = manager.subagent_generations.lock().await;
    assert_eq!(generations.len(), MAX_TRACKED_SUBAGENT_GENERATIONS);
    assert!(generations.contains_key("overflow"));
    drop(generations);
    manager.shutdown().await;
}

#[tokio::test]
async fn opencode_child_discovery_filters_invalid_and_unrelated_sessions() {
    async fn children(AxumPath(session_id): AxumPath<String>) -> impl IntoResponse {
        match session_id.as_str() {
            "parent" => Json(serde_json::json!([
                {"id": " child-valid ", "title": " Child task ", "parentID": "parent"},
                {"id": "child-no-title", "title": " ", "parentID": "parent"},
                {"id": "", "title": "Empty id", "parentID": "parent"},
                {"id": "x".repeat(1_025), "title": "Long id", "parentID": "parent"},
                {"id": "unrelated", "title": "Other", "parentID": "someone-else"}
            ]))
            .into_response(),
            "failure" => AxumStatusCode::INTERNAL_SERVER_ERROR.into_response(),
            _ => (AxumStatusCode::OK, "not-json").into_response(),
        }
    }

    let app = Router::new().route("/session/{session_id}/children", get(children));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http_base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection("opencode", false, "unused", observed).await;
    let mut opencode = manifest("opencode", "OpenCode");
    opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
    opencode.resolved.argv = vec!["acp".to_string()];
    let mut manager =
        AgentManager::from_start_results("opencode".to_string(), vec![(opencode, Ok(ready))])
            .await
            .unwrap();

    assert!(!manager.can_discover_subagents("invalid"));
    let parent = AgentSessionId::new("opencode", "parent").unwrap();
    assert!(!manager.can_discover_subagents(&parent.encode()));
    assert!(manager.harness_child_sessions("invalid").await.is_empty());
    assert!(manager
        .harness_child_sessions(&AgentSessionId::new("missing", "parent").unwrap().encode())
        .await
        .is_empty());
    assert!(manager
        .harness_child_sessions(&parent.encode())
        .await
        .is_empty());

    manager.agents.get_mut("opencode").unwrap().http_base = Some(http_base);
    assert!(manager.can_discover_subagents(&parent.encode()));
    assert!(manager
        .harness_child_sessions(&parent.encode())
        .await
        .is_empty());
    let cwd = std::env::current_dir().unwrap();
    let identities =
        ["parent", "failure", "malformed"].map(|id| AgentSessionId::new("opencode", id).unwrap());
    manager
        .session_index
        .lock()
        .await
        .insert_all(
            identities
                .iter()
                .cloned()
                .map(|identity| index_entry(identity, cwd.clone())),
        )
        .await
        .unwrap();

    let children = manager.harness_child_sessions(&parent.encode()).await;
    assert_eq!(
        children,
        vec![
            HarnessChildSession {
                acp_session_id: "child-valid".to_string(),
                title: Some("Child task".to_string()),
            },
            HarnessChildSession {
                acp_session_id: "child-no-title".to_string(),
                title: None,
            },
        ],
    );
    assert!(manager
        .harness_child_sessions(&identities[1].encode())
        .await
        .is_empty());
    assert!(manager
        .harness_child_sessions(&identities[2].encode())
        .await
        .is_empty());

    manager.shutdown().await;
    server.abort();
    let _ = server.await;
}

#[cfg(unix)]
#[tokio::test]
async fn opencode_catalog_handles_process_failures_and_sanitizes_rows() {
    use std::os::unix::fs::PermissionsExt;

    struct ExecutableFixtureDir(PathBuf);

    impl ExecutableFixtureDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "dappercode-opencode-catalog-{}",
                uuid::Uuid::new_v4(),
            ));
            std::fs::create_dir(&path).expect("create executable fixture directory");
            Self(path)
        }

        fn executable(&self) -> PathBuf {
            self.0.join("opencode")
        }
    }

    impl Drop for ExecutableFixtureDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection("opencode", false, "unused", observed).await;
    let mut opencode = manifest("opencode", "OpenCode");
    opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
    opencode.resolved.argv = vec!["acp".to_string()];
    let mut manager =
        AgentManager::from_start_results("opencode".to_string(), vec![(opencode, Ok(ready))])
            .await
            .unwrap();

    manager
        .agents
        .get_mut("opencode")
        .unwrap()
        .manifest
        .resolved
        .executable = PathBuf::from("/definitely/missing/opencode");
    let runtime = manager.agents.get("opencode").unwrap();
    assert!(manager.opencode_session_summaries(runtime).await.is_empty());

    manager
        .agents
        .get_mut("opencode")
        .unwrap()
        .manifest
        .resolved
        .executable = PathBuf::from("/usr/bin/false");
    let runtime = manager.agents.get("opencode").unwrap();
    assert!(manager.opencode_session_summaries(runtime).await.is_empty());

    let fixture_dir = ExecutableFixtureDir::new();
    let fixture = fixture_dir.executable();
    let payload = serde_json::json!([
        {"id": " VALID ", "title": " Useful title ", "updated": 1_750_000_000_000_u64},
        {"id": "created", "title": null, "created": 1_700_000_000_000_u64},
        {"id": "blank-title", "title": "   "},
        {"id": "", "title": "Empty id"},
        {"id": "x".repeat(1_025), "title": "Long id"}
    ])
    .to_string();
    std::fs::write(&fixture, format!("#!/bin/sh\nprintf '%s' '{payload}'\n")).unwrap();
    let mut permissions = std::fs::metadata(&fixture).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&fixture, permissions).unwrap();
    manager
        .agents
        .get_mut("opencode")
        .unwrap()
        .manifest
        .resolved
        .executable = fixture.clone();
    let runtime = manager.agents.get("opencode").unwrap();
    let summaries = manager.opencode_session_summaries(runtime).await;
    assert_eq!(summaries.len(), 3);
    assert_eq!(summaries["valid"].title.as_deref(), Some("Useful title"));
    assert!(summaries["valid"].updated_at.is_some());
    assert!(summaries["created"].updated_at.is_some());
    assert_eq!(summaries["blank-title"].title, None);

    manager.agents.get_mut("opencode").unwrap().harness = None;
    let runtime = manager.agents.get("opencode").unwrap();
    assert!(manager.opencode_session_summaries(runtime).await.is_empty());

    assert!(manager
        .harness_model_catalog(Some("missing"))
        .await
        .is_empty());
    manager
        .agents
        .get_mut("opencode")
        .unwrap()
        .manifest
        .resolved
        .executable = PathBuf::from("/usr/local/bin/opencode");
    let harness = harness_for_manifest(&manager.agents["opencode"].manifest.resolved);
    manager.agents.get_mut("opencode").unwrap().harness = harness;
    manager
        .agents
        .get_mut("opencode")
        .unwrap()
        .manifest
        .resolved
        .executable = PathBuf::from("/definitely/missing/opencode");
    assert!(manager
        .harness_model_catalog(Some("opencode"))
        .await
        .is_empty());
    manager
        .agents
        .get_mut("opencode")
        .unwrap()
        .manifest
        .resolved
        .executable = PathBuf::from("/usr/bin/false");
    assert!(manager.harness_model_catalog(None).await.is_empty());
    std::fs::write(
        &fixture,
        "#!/bin/sh\nprintf '%s' 'opencode/demo\n{\"id\":\"demo\",\"providerID\":\"opencode\",\"name\":\"Demo\",\"limit\":{\"context\":1000},\"capabilities\":{\"reasoning\":false}}'\n",
    )
    .unwrap();
    manager
        .agents
        .get_mut("opencode")
        .unwrap()
        .manifest
        .resolved
        .executable = fixture.clone();
    let models = manager.harness_model_catalog(None).await;
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].id, "opencode/demo");

    manager.shutdown().await;
}

#[tokio::test]
async fn authoritative_session_listing_rejects_non_progressing_pagination() {
    async fn listing_connection(mode: u8) -> AcpConnection {
        let agent = Agent
            .v1()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version).agent_capabilities(
                            AgentCapabilities::new().session_capabilities(
                                SessionCapabilities::new().list(SessionListCapabilities::new()),
                            ),
                        ),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: ListSessionsRequest, responder, _| {
                    if mode == 3 {
                        return responder
                            .respond_with_error(agent_client_protocol::Error::internal_error());
                    }
                    let page = request.cursor.as_deref().unwrap_or("first");
                    let response = match mode {
                        0 => ListSessionsResponse::new(Vec::new())
                            .next_cursor("empty-next".to_string()),
                        1 if page == "first" => {
                            ListSessionsResponse::new(vec![SessionInfo::new("same", "/tmp")])
                                .next_cursor("next".to_string())
                        }
                        1 => ListSessionsResponse::new(vec![SessionInfo::new("same", "/tmp")])
                            .next_cursor("another".to_string()),
                        2 if page == "first" => {
                            ListSessionsResponse::new(vec![SessionInfo::new("one", "/tmp")])
                                .next_cursor("repeat".to_string())
                        }
                        2 => ListSessionsResponse::new(vec![SessionInfo::new("two", "/tmp")])
                            .next_cursor("repeat".to_string()),
                        _ => ListSessionsResponse::new(Vec::new()),
                    };
                    responder.respond(response)
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport("listing".to_string(), agent, Duration::from_secs(1))
            .await
            .unwrap()
            .0
    }

    for mode in 0..4 {
        let connection = listing_connection(mode).await;
        assert!(AgentManager::authoritative_session_ids(&connection)
            .await
            .is_err());
        let negotiated = connection.negotiated().clone();
        let manager = AgentManager::from_start_results(
            "listing".into(),
            vec![(manifest("listing", "Listing"), Ok((connection, negotiated)))],
        )
        .await
        .unwrap();
        assert!(
            !manager
                .thread_is_authoritatively_absent(
                    &AgentSessionId::new("listing", "missing").unwrap().encode()
                )
                .await,
        );
        manager.shutdown().await;
    }
}

#[test]
fn agent_message_journal_sanitization_validates_every_durable_field() {
    let thread = AgentSessionId::new("alpha", "thread").unwrap().encode();
    let related = AgentSessionId::new("alpha", "related").unwrap().encode();
    let valid_origin = || sent_agent_message("message", &related);
    let valid_entry = || AgentMessageJournalEntry {
        thread_id: thread.clone(),
        observed_at_ms: 1,
        after_timeline_id: Some("anchor".to_string()),
        message: valid_origin(),
    };
    let mut entries = vec![valid_entry()];
    let mut invalid = valid_entry();
    invalid.thread_id = "invalid".to_string();
    entries.push(invalid);
    let mut invalid = valid_entry();
    invalid.message.related_thread_id = "invalid".to_string();
    entries.push(invalid);
    let mut invalid = valid_entry();
    invalid.message.message_id.clear();
    entries.push(invalid);
    let mut invalid = valid_entry();
    invalid.message.message_id = "x".repeat(MAX_AGENT_MESSAGE_ID_BYTES + 1);
    entries.push(invalid);
    let mut invalid = valid_entry();
    invalid.after_timeline_id = Some(String::new());
    entries.push(invalid);
    let mut invalid = valid_entry();
    invalid.after_timeline_id = Some("x".repeat(MAX_AGENT_MESSAGE_ANCHOR_BYTES + 1));
    entries.push(invalid);
    let mut invalid = valid_entry();
    invalid.message.body.clear();
    entries.push(invalid);
    let mut invalid = valid_entry();
    invalid.message.body = "x".repeat(MAX_AGENT_MESSAGE_BODY_BYTES + 1);
    entries.push(invalid);
    let mut invalid = valid_entry();
    invalid.message.related_title = Some("\n".to_string());
    entries.push(invalid);
    let duplicate = valid_entry();
    entries.push(duplicate);

    let sanitized = sanitize_agent_message_journal(entries);
    assert_eq!(sanitized.len(), 1);
    assert_eq!(sanitized[0].message.message_id, "message");
}

#[tokio::test]
async fn runtime_request_validation_and_thread_start_cover_supported_parameter_shapes() {
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection("alpha", false, "unused", observed).await;
    let manager = Arc::new(
        AgentManager::from_start_results(
            "alpha".to_string(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .unwrap(),
    );
    let backend = crate::runtime_backend::RuntimeBackend::from_manager_for_test(
        manager.clone(),
        Arc::new(crate::client_hub::ClientHub::new()),
        Arc::new(crate::retirement_journal::ThreadRetirementJournal::inert_for_test()),
    )
    .await;

    for params in [
        serde_json::json!({
            "agentId": "alpha",
            "cwd": "/tmp",
            "model": "",
            "effort": " ",
            "mode": "default"
        }),
        serde_json::json!({
            "agentId": "alpha",
            "cwd": "/tmp",
            "model": "unadvertised",
            "effort": "high",
            "mode": "plan"
        }),
    ] {
        let value = backend
            .request_internal("thread/start", Some(params))
            .await
            .expect("start accepts absent optional catalogs");
        assert!(value["thread"]["id"].as_str().is_some());
    }

    for value in [
        serde_json::json!(null),
        serde_json::json!(" "),
        serde_json::json!(17),
    ] {
        let error = backend
            .request_internal(
                "thread/config/set",
                Some(serde_json::json!({
                    "threadId": AgentSessionId::new("alpha", "alpha-new").unwrap().encode(),
                    "configId": "model",
                    "value": value
                })),
            )
            .await
            .unwrap_err();
        assert!(error.contains("non-empty string or boolean"));
    }
    let error = backend
        .request_internal(
            "thread/config/set",
            Some(serde_json::json!({
                "threadId": AgentSessionId::new("alpha", "alpha-new").unwrap().encode(),
                "configId": "model",
                "value": true
            })),
        )
        .await
        .unwrap_err();
    assert!(!error.is_empty());
    assert!(backend
        .request_internal("unsupported/method", None)
        .await
        .unwrap_err()
        .contains("method not supported"));
    assert!(backend
        .request_internal("thread/loaded/list", None)
        .await
        .unwrap()["data"]
        .as_array()
        .is_some());

    backend.shutdown().await;
}

#[tokio::test]
async fn runtime_side_effects_adopt_and_settle_a_reported_subagent() {
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection_with_capabilities(
        "alpha",
        AgentCapabilities::new().load_session(true),
        observed,
    )
    .await;
    let manager = Arc::new(
        AgentManager::from_start_results(
            "alpha".to_string(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .unwrap(),
    );
    let parent = AgentSessionId::new("alpha", "parent").unwrap();
    let parent_thread_id = parent.encode();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(parent, PathBuf::from("/tmp"))])
        .await
        .unwrap();
    manager
        .read_session(&parent_thread_id)
        .await
        .expect("load parent");
    let hub = Arc::new(crate::client_hub::ClientHub::new());
    let tool = CanonicalEvent::Tool {
        agent_id: "alpha".to_string(),
        thread_id: parent_thread_id.clone(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "task".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child\" state=\"running\">\nWorking\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    };
    manager
        .connection("alpha")
        .unwrap()
        .session(&SessionId::new("parent"))
        .await
        .unwrap()
        .emit(tool.clone())
        .await;

    crate::runtime_backend::client_request_tests::process_event_side_effects_for_test(
        &manager,
        &hub,
        &[
            CanonicalEvent::MessageChunk {
                agent_id: "alpha".to_string(),
                thread_id: parent_thread_id.clone(),
                run_id: Some("run-1".to_string()),
                source_turn_id: Some("turn-1".to_string()),
                generation: Some(1),
                role: MessageRole::Agent,
                message_id: "message".to_string(),
                content: "ordinary update".to_string(),
                content_block: None,
            },
            tool,
        ],
    )
    .await;
    let child_thread_id = AgentSessionId::new("alpha", "child").unwrap().encode();
    assert!(manager.read_session(&child_thread_id).await.is_ok());
    assert!(manager.tracks_subagent_generation(&child_thread_id).await);

    crate::runtime_backend::client_request_tests::process_event_side_effects_for_test(
        &manager,
        &hub,
        &[
            CanonicalEvent::RunStarted {
                agent_id: "alpha".to_string(),
                thread_id: child_thread_id.clone(),
                run_id: "child-run".to_string(),
                source_turn_id: "child-turn".to_string(),
                generation: 2,
            },
            CanonicalEvent::RunFinished {
                agent_id: "alpha".to_string(),
                thread_id: child_thread_id.clone(),
                run_id: "child-run".to_string(),
                source_turn_id: "child-turn".to_string(),
                generation: 2,
                stop_reason: StopReason::EndTurn,
            },
            CanonicalEvent::RunFailed {
                agent_id: "alpha".to_string(),
                thread_id: "invalid-thread".to_string(),
                run_id: "failed-run".to_string(),
                source_turn_id: "failed-turn".to_string(),
                generation: 1,
                message: "fixture failure".to_string(),
            },
        ],
    )
    .await;
    assert!(manager
        .accepted_subagent_terminal(&child_thread_id, 2)
        .await
        .is_none());
    manager.shutdown().await;
}

#[tokio::test]
async fn running_task_discovers_a_child_that_appears_after_polling_begins() {
    let requests = Arc::new(AtomicUsize::new(0));
    let requests_for_route = requests.clone();
    let app = Router::new().route(
        "/session/parent/children",
        get(move || {
            let requests = requests_for_route.clone();
            async move {
                if requests.fetch_add(1, Ordering::SeqCst) == 0 {
                    Json(serde_json::json!([]))
                } else {
                    Json(serde_json::json!([{
                        "id": "child",
                        "title": "Investigate child task",
                        "parentID": "parent"
                    }]))
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http_base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let (observed, _) = mpsc::unbounded_channel();
    let ready = connection_with_capabilities(
        "opencode",
        AgentCapabilities::new().load_session(true),
        observed,
    )
    .await;
    let mut opencode = manifest("opencode", "OpenCode");
    opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
    opencode.resolved.argv = vec!["acp".to_string()];
    let mut manager =
        AgentManager::from_start_results("opencode".to_string(), vec![(opencode, Ok(ready))])
            .await
            .unwrap();
    manager.agents.get_mut("opencode").unwrap().http_base = Some(http_base);
    let parent = AgentSessionId::new("opencode", "parent").unwrap();
    let parent_thread_id = parent.encode();
    manager
        .session_index
        .lock()
        .await
        .insert_all([index_entry(parent, PathBuf::from("/tmp"))])
        .await
        .unwrap();
    let parent_session = manager
        .read_session(&parent_thread_id)
        .await
        .expect("load parent");
    let tool = CanonicalEvent::Tool {
        agent_id: "opencode".to_string(),
        thread_id: parent_thread_id.clone(),
        run_id: Some("run".to_string()),
        source_turn_id: Some("turn".to_string()),
        generation: Some(1),
        tool_call_id: "task".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "task".to_string(),
        content: FieldUpdate::Set("Working".to_string()),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    };
    manager
        .connection("opencode")
        .unwrap()
        .session(&SessionId::new("parent"))
        .await
        .unwrap()
        .emit(tool.clone())
        .await;
    let manager = Arc::new(manager);
    crate::runtime_backend::client_request_tests::process_event_side_effects_for_test(
        &manager,
        &Arc::new(crate::client_hub::ClientHub::new()),
        &[tool],
    )
    .await;
    let child_thread_id = AgentSessionId::new("opencode", "child").unwrap().encode();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if manager.read_session(&child_thread_id).await.is_ok() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("child is discovered");
    assert!(requests.load(Ordering::SeqCst) >= 2);
    assert_eq!(parent_session.thread_id, parent_thread_id);
    manager.shutdown().await;
    server.abort();
    let _ = server.await;
}

#[test]
fn durable_index_sanitization_rejects_each_invalid_relationship_and_path() {
    let valid = AgentSessionId::new("alpha", "valid").unwrap();
    let mut entries = vec![index_entry(valid.clone(), PathBuf::from("/tmp"))];
    let mut relative = index_entry(
        AgentSessionId::new("alpha", "relative").unwrap(),
        PathBuf::from("relative"),
    );
    entries.push(relative.clone());
    relative.cwd = PathBuf::from(format!("/{}", "x".repeat(MAX_SESSION_CWD_BYTES + 1)));
    relative.acp_session_id = "long-path".to_string();
    entries.push(relative);
    let mut titled = index_entry(
        AgentSessionId::new("alpha", "titled").unwrap(),
        PathBuf::from("/tmp"),
    );
    titled.title = Some("\n".to_string());
    entries.push(titled);
    let mut same_parent = index_entry(
        AgentSessionId::new("alpha", "same-parent").unwrap(),
        PathBuf::from("/tmp"),
    );
    same_parent.parent_acp_session_id = Some("same-parent".to_string());
    entries.push(same_parent);
    let mut invalid_parent = index_entry(
        AgentSessionId::new("alpha", "invalid-parent").unwrap(),
        PathBuf::from("/tmp"),
    );
    invalid_parent.parent_acp_session_id = Some("".to_string());
    entries.push(invalid_parent);
    let mut same_source = index_entry(
        AgentSessionId::new("alpha", "same-source").unwrap(),
        PathBuf::from("/tmp"),
    );
    same_source.forked_from_acp_session_id = Some("same-source".to_string());
    entries.push(same_source);
    let mut invalid_source = index_entry(
        AgentSessionId::new("alpha", "invalid-source").unwrap(),
        PathBuf::from("/tmp"),
    );
    invalid_source.forked_from_acp_session_id = Some("".to_string());
    entries.push(invalid_source);
    entries.push(index_entry(valid, PathBuf::from("/other")));

    let sanitized = sanitize_index_entries(entries);
    assert_eq!(sanitized.len(), 1);
    assert_eq!(sanitized[0].acp_session_id, "valid");
}

#[tokio::test]
async fn durable_index_merge_and_policy_updates_preserve_canonical_metadata() {
    let identity = AgentSessionId::new("alpha", "session").unwrap();
    let mut index = DurableSessionIndex {
        path: None,
        entries: Vec::new(),
        fail_writes: false,
    };
    let mut original = index_entry_with_policy(
        identity.clone(),
        PathBuf::from("/tmp"),
        ApprovalPolicy::Never,
    );
    original.title = Some("Original".to_string());
    original.parent_acp_session_id = Some("parent".to_string());
    original.forked_from_acp_session_id = Some("source".to_string());
    index.insert_all([original.clone()]).await.unwrap();
    index.insert_all([original.clone()]).await.unwrap();

    let mut replacement = index_entry_with_policy(
        identity.clone(),
        PathBuf::from("/other"),
        ApprovalPolicy::OnRequest,
    );
    replacement.title = None;
    replacement.parent_acp_session_id = Some("new-parent".to_string());
    index.insert_entries(vec![replacement]).await.unwrap();
    assert_eq!(index.entries[0].title.as_deref(), Some("Original"));
    assert_eq!(
        index.entries[0].parent_acp_session_id.as_deref(),
        Some("parent"),
    );
    assert_eq!(
        index.entries[0].forked_from_acp_session_id.as_deref(),
        Some("source"),
    );
    assert_eq!(index.entries[0].approval_policy, ApprovalPolicy::Never);

    index
        .set_existing_approval_policies(&[(
            AgentSessionId::new("alpha", "missing").unwrap(),
            ApprovalPolicy::OnRequest,
        )])
        .await
        .unwrap();
    assert!(index
        .set_approval_policies(&[(
            AgentSessionId::new("alpha", "missing").unwrap(),
            ApprovalPolicy::OnRequest,
        )])
        .await
        .is_err());
    index
        .set_approval_policies(&[(identity.clone(), ApprovalPolicy::OnRequest)])
        .await
        .unwrap();
    index
        .set_approval_policies(&[(identity.clone(), ApprovalPolicy::OnRequest)])
        .await
        .unwrap();
    index.remove_all(&[]).await.unwrap();
    index.remove_all(&[identity]).await.unwrap();
    assert!(index.entries.is_empty());
}

mod catalog_tests {
    use agent_client_protocol::v1::schema::ToolCallStatus;

    use super::super::{
        exported_session_events, parse_opencode_model_catalog, parse_opencode_related_sessions,
        snapshot_task_session_id, AgentSessionId, CanonicalEvent, FieldUpdate, MessageRole,
        OpenCodeExportDocument,
    };
    use crate::acp::session::AcpSession;
    use crate::acp::snapshot::{BridgeThreadSnapshot, SnapshotTimelineKind};

    #[test]
    fn parses_opencode_verbose_model_catalog() {
        let catalog = parse_opencode_model_catalog(
            br#"opencode/demo
{
  "id": "demo",
  "providerID": "opencode",
  "name": "Demo Model",
  "limit": { "context": 200000 },
  "capabilities": { "reasoning": true },
    "variants": { "high": { "reasoningEffort": "high" }, "max": {} }
}
"#,
        );
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].id, "opencode/demo");
        assert_eq!(catalog[0].display_name, "Demo Model");
        assert_eq!(catalog[0].context_window, Some(200000));
        assert_eq!(catalog[0].reasoning_effort, vec!["high", "max"]);
    }

    #[test]
    fn parses_related_sessions_from_opencode_export() {
        let document = serde_json::from_slice::<OpenCodeExportDocument>(
            br#"{
                    "messages": [{
                        "info": { "id": "message-parent", "role": "assistant" },
                        "parts": [
                            {
                                "type": "tool",
                                "tool": "task",
                                "state": {
                                    "input": { "description": "Ask subagent about hobbies" },
                                    "output": "<task id=\"child-fallback\" state=\"completed\"></task>",
                                    "metadata": { "sessionId": "child-session" }
                                }
                            },
                            {
                                "type": "tool",
                                "tool": "task",
                                "state": {
                                    "input": { "description": " " },
                                    "output": "<task id=\"child-fallback\" state=\"completed\"></task>"
                                }
                            },
                            {
                                "type": "tool",
                                "tool": "task",
                                "state": {
                                    "output": "<task id=\"child-fallback\" state=\"completed\"></task>"
                                }
                            },
                            {
                                "type": "tool",
                                "tool": "task"
                            },
                            {
                                "type": "tool",
                                "tool": "read",
                                "state": {}
                            }
                        ]
                    }]
                }"#,
        )
        .unwrap();
        let related = parse_opencode_related_sessions(document);
        assert_eq!(related.len(), 2);
        assert_eq!(related[0].session_id, "child-fallback");
        assert_eq!(related[0].title, None);
        assert_eq!(related[1].session_id, "child-session");
        assert_eq!(
            related[1].title.as_deref(),
            Some("Ask subagent about hobbies"),
        );
        assert_eq!(
            snapshot_task_session_id(r#"<task id="" state="running">"#),
            None,
        );
        assert_eq!(
            snapshot_task_session_id(&format!(
                r#"<task id="{}" state="running">"#,
                "x".repeat(1_025)
            )),
            None,
        );
    }

    #[test]
    fn converts_opencode_export_messages_to_canonical_transcript_events() {
        let document = serde_json::from_slice::<OpenCodeExportDocument>(
            br#"{
                    "messages": [
                        {
                            "info": { "id": "user-message", "role": "user" },
                            "parts": [{ "id": "user-text", "type": "text", "text": "Hello" }]
                        },
                        {
                            "info": { "id": "assistant-message", "role": "assistant" },
                            "parts": [
                                { "id": "thought", "type": "reasoning", "text": "Thinking" },
                                { "id": "answer", "type": "text", "text": "Hi there" }
                            ]
                        }
                    ]
                }"#,
        )
        .unwrap();
        let identity = AgentSessionId::new("opencode", "child-session").unwrap();
        let events = exported_session_events(&identity, document);
        assert_eq!(events.len(), 3);
        assert!(matches!(
            events[0],
            CanonicalEvent::MessageChunk {
                role: MessageRole::User,
                ..
            }
        ));
        assert!(matches!(
            events[1],
            CanonicalEvent::MessageChunk {
                role: MessageRole::Thought,
                ..
            }
        ));
        assert!(matches!(
            events[2],
            CanonicalEvent::MessageChunk {
                role: MessageRole::Agent,
                ..
            }
        ));
    }

    /// A sub-agent opened while it is still working reproduces the reported defect: the read
    /// finds an empty transcript and starts `opencode export`, the agent streams its thought
    /// and its answer during the seconds that subprocess takes, and the export (captured
    /// mid-answer, so it carries the prompt and the same reasoning but no answer yet) lands
    /// afterwards. Replaying it restated the reasoning under a second, exported id and filed
    /// the prompt below the answer it produced, which is what the sub-agent chat rendered.
    #[tokio::test]
    async fn keeps_a_live_subagent_transcript_chronological_and_unduplicated() {
        let identity = AgentSessionId::new("opencode", "child-session").unwrap();
        let thread_id = identity.encode();
        let session = AcpSession::new("opencode".to_string(), thread_id.clone());
        let reasoning = "The user is asking for a harness test confirmation.";
        let answer = "Confirmed - read-only smoke test, no files modified.";
        let prompt = "This is a harness test. Please respond with a brief confirmation message.";

        for (role, message_id, content) in [
            (MessageRole::Thought, "msg_answer::thought", reasoning),
            (MessageRole::Agent, "msg_answer::agent", answer),
        ] {
            session
                .emit(CanonicalEvent::MessageChunk {
                    agent_id: identity.agent_id.clone(),
                    thread_id: thread_id.clone(),
                    run_id: None,
                    source_turn_id: None,
                    generation: None,
                    role,
                    message_id: message_id.to_string(),
                    content: content.to_string(),
                    content_block: None,
                })
                .await;
        }

        let document = serde_json::from_value::<OpenCodeExportDocument>(serde_json::json!({
            "messages": [
                {
                    "info": { "id": "msg_prompt", "role": "user" },
                    "parts": [{ "id": "prt_prompt", "type": "text", "text": prompt }]
                },
                {
                    "info": { "id": "msg_answer", "role": "assistant" },
                    "parts": [{ "id": "prt_thought", "type": "reasoning", "text": reasoning }]
                }
            ]
        }))
        .unwrap();
        assert!(
            !session
                .seed_history(exported_session_events(&identity, document))
                .await,
        );

        let snapshot = BridgeThreadSnapshot::from(session.snapshot().await);
        let texts = snapshot
            .messages
            .iter()
            .map(|message| {
                (
                    message.id.clone(),
                    message.role,
                    message
                        .parts
                        .iter()
                        .filter_map(|part| part.get("text"))
                        .filter_map(serde_json::Value::as_str)
                        .collect::<String>(),
                )
            })
            .collect::<Vec<_>>();

        // Every reasoning turn keeps exactly one identity: the same thought must never be
        // restated under a second id.
        let reasoning_ids = texts
            .iter()
            .filter(|(_, role, text)| *role == MessageRole::Thought && text == reasoning)
            .map(|(id, _, _)| id.clone())
            .collect::<Vec<_>>();
        assert_eq!(reasoning_ids, vec!["msg_answer::thought".to_string()]);
        assert_eq!(
            snapshot
                .timeline
                .iter()
                .filter(|entry| entry.kind == SnapshotTimelineKind::Reasoning)
                .count(),
            1,
        );

        // The rendered order is the timeline order, and it must stay chronological: nothing
        // may be filed after the answer that already streamed.
        assert_eq!(
            snapshot
                .timeline
                .iter()
                .map(|entry| (entry.kind, entry.canonical_id.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (SnapshotTimelineKind::Reasoning, "msg_answer::thought"),
                (SnapshotTimelineKind::Message, "msg_answer::agent"),
            ],
        );
        assert!(snapshot
            .timeline
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence));
        assert!(!texts.iter().any(|(id, _, _)| id.starts_with("export:")));
    }

    #[tokio::test]
    async fn seeds_exported_history_into_a_transcript_that_has_none() {
        let identity = AgentSessionId::new("opencode", "cold-session").unwrap();
        let session = AcpSession::new("opencode".to_string(), identity.encode());
        let document = serde_json::from_value::<OpenCodeExportDocument>(serde_json::json!({
            "messages": [
                {
                    "info": { "id": "msg_prompt", "role": "user" },
                    "parts": [{ "id": "prt_prompt", "type": "text", "text": "Summarize" }]
                },
                {
                    "info": { "id": "msg_answer", "role": "assistant" },
                    "parts": [
                        { "id": "prt_first", "type": "reasoning", "text": "Reading" },
                        { "id": "prt_answer", "type": "text", "text": "Done" },
                        { "id": "prt_second", "type": "reasoning", "text": "Checking" }
                    ]
                }
            ]
        }))
        .unwrap();

        assert!(
            session
                .seed_history(exported_session_events(&identity, document))
                .await,
        );

        let snapshot = BridgeThreadSnapshot::from(session.snapshot().await);
        // Two distinct reasoning turns in one message stay two rows, in the order the
        // export recorded them.
        assert_eq!(
            snapshot
                .timeline
                .iter()
                .map(|entry| entry.kind)
                .collect::<Vec<_>>(),
            vec![
                SnapshotTimelineKind::Message,
                SnapshotTimelineKind::Reasoning,
                SnapshotTimelineKind::Message,
                SnapshotTimelineKind::Reasoning,
            ],
        );
        assert_eq!(
            snapshot
                .timeline
                .iter()
                .map(|entry| entry.canonical_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "export:msg_prompt:prt_prompt",
                "export:msg_answer:prt_first",
                "export:msg_answer:prt_answer",
                "export:msg_answer:prt_second",
            ],
        );
    }

    #[test]
    fn converts_opencode_export_tool_states_to_canonical_events() {
        let document = serde_json::from_slice::<OpenCodeExportDocument>(
            br#"{
                    "messages": [{
                        "info": { "id": "tool-message", "role": "assistant" },
                        "parts": [
                            { "id": "metadata", "type": "metadata" },
                            { "id": "missing-state", "type": "tool", "tool": "read" },
                            {
                                "id": "completed",
                                "type": "tool",
                                "tool": "read",
                                "state": { "status": "completed", "output": "done" }
                            },
                            {
                                "id": "failed",
                                "type": "tool",
                                "state": { "status": "error", "title": "Failure", "error": "bad" }
                            },
                            {
                                "id": "running",
                                "type": "tool",
                                "state": { "status": "running" }
                            },
                            {
                                "type": "tool",
                                "state": { "status": "unknown" }
                            }
                        ]
                    }]
                }"#,
        )
        .unwrap();
        let identity = AgentSessionId::new("opencode", "tool-session").unwrap();
        let events = exported_session_events(&identity, document);
        let statuses = events
            .iter()
            .map(|event| match event {
                CanonicalEvent::Tool { status, .. } => *status,
                _ => panic!("expected tool event"),
            })
            .collect::<Vec<_>>();

        assert_eq!(
            statuses,
            vec![
                ToolCallStatus::Completed,
                ToolCallStatus::Failed,
                ToolCallStatus::InProgress,
                ToolCallStatus::Pending,
            ],
        );
        assert!(matches!(
            &events[0],
            CanonicalEvent::Tool {
                title,
                content: FieldUpdate::Set(content),
                ..
            } if title == "read" && content == "done"
        ));
        assert!(matches!(
            &events[1],
            CanonicalEvent::Tool {
                title,
                content: FieldUpdate::Set(content),
                ..
            } if title == "Failure" && content == "bad"
        ));
        assert!(matches!(
            &events[3],
            CanonicalEvent::Tool {
                title,
                content: FieldUpdate::Set(content),
                ..
            } if title == "tool" && content.is_empty()
        ));
    }

    #[test]
    fn model_catalog_handles_invalid_json_and_non_reasoning_models() {
        let catalog = parse_opencode_model_catalog(
            br#"{invalid}
{
  "id": "plain",
  "providerID": "provider",
  "name": "",
  "capabilities": { "reasoning": false },
  "variants": { "unsupported": {} }
}
"#,
        );

        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].display_name, "provider/plain");
        assert_eq!(catalog[0].context_window, None);
        assert!(catalog[0].reasoning_effort.is_empty());
        assert!(parse_opencode_model_catalog(&[0xff]).is_empty());
    }
}
