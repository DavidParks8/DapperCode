use super::{
    open_legacy_sse, prompt_contains_agent_message_envelope, scheduled_prompt_tool_error,
    validate_agent_message_envelope_size, AgentMessageEnvelope, AgentMessagingMcpConfig,
    AgentMessagingMcpHandler, AgentMessagingRouterState, AgentMessagingService, AgentRelationKind,
    Arc, AuthenticatedMcpCredential, BridgeQueueService, CancellationToken, Duration,
    GetPhoneCallArguments, HangupPhoneCallArguments, HashMap, HeaderMap, LocalSessionManager,
    McpCredentialError, McpCredentialPrincipal, McpCredentialRecord, McpCredentialState,
    McpCredentialStore, McpHttpSessionAuthorization, McpProtocolSession,
    McpProtocolSessionEvictions, McpServer, McpTransportPreference, Mutex, Parameters,
    PhoneCallService, RuntimeBackend, SchedulePromptArguments, ScheduledPromptError,
    ScheduledPromptService, SendAgentMessageArguments, StartPhoneCallArguments, State, StatusCode,
    SteerPhoneCallArguments, Weak, AUTHORIZATION, MAX_AGENT_MESSAGE_BODY_BYTES,
    MAX_MCP_CREDENTIALS, MAX_MCP_PROTOCOL_SESSIONS, MAX_MCP_REQUEST_BYTES,
    MAX_MCP_SESSIONS_PER_CREDENTIAL, MCP_SESSION_HEADER, QUEUE_MAX_CONTENT_BYTES,
    SEND_AGENT_MESSAGE_TOOL,
};

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
        AgentRelationKind::SubAgent,
    );
    assert_eq!(
        AgentRelationKind::SubAgent.inverse(),
        AgentRelationKind::Parent,
    );
}

#[tokio::test]
async fn send_agent_message_rejects_invalid_recipient_and_message_before_routing() {
    let credentials = Arc::new(McpCredentialStore::default());
    let config = AgentMessagingMcpConfig::new(
        "http://unused".into(),
        "http://unused".into(),
        credentials.clone(),
    );
    let pending = config.stage_credential("agent").unwrap();
    let token = pending.token.clone();
    config
        .activate_credential(pending, "agent-thread")
        .expect("credential activates");
    let handler = AgentMessagingMcpHandler::new(
        AuthenticatedMcpCredential {
            token,
            agent_id: "agent".to_string(),
        },
        Arc::new(AgentMessagingRouterState {
            backend: Weak::new(),
            queue: Weak::new(),
            scheduler: ScheduledPromptService::inert_for_test(),
            phone_calls: PhoneCallService::inert_for_test(),
            credentials,
            legacy_sessions: Arc::new(Mutex::new(HashMap::new())),
            message_url: "http://unused/message".to_string(),
        }),
    );

    for arguments in [
        SendAgentMessageArguments {
            recipient_thread_id: "  ".to_string(),
            message: "hello".to_string(),
        },
        SendAgentMessageArguments {
            recipient_thread_id: "recipient".to_string(),
            message: " \n ".to_string(),
        },
        SendAgentMessageArguments {
            recipient_thread_id: "recipient".to_string(),
            message: "x".repeat(MAX_AGENT_MESSAGE_BODY_BYTES + 1),
        },
    ] {
        assert!(handler
            .send_agent_message(Parameters(arguments))
            .await
            .is_err());
    }
}

#[tokio::test]
async fn authenticated_handler_routes_scheduled_prompt_tools_to_its_active_session() {
    let credentials = Arc::new(McpCredentialStore::default());
    let config = AgentMessagingMcpConfig::new(
        "http://unused".into(),
        "http://unused".into(),
        credentials.clone(),
    );
    let pending = config.stage_credential("agent").unwrap();
    let token = pending.token.clone();
    let thread_id = crate::acp::identity::AgentSessionId::new("agent", "scheduled-owner")
        .unwrap()
        .encode();
    config
        .activate_credential(pending, &thread_id)
        .expect("credential activates");
    let scheduler = ScheduledPromptService::inert_for_test();
    let handler = AgentMessagingMcpHandler::new(
        AuthenticatedMcpCredential {
            token,
            agent_id: "agent".to_string(),
        },
        Arc::new(AgentMessagingRouterState {
            backend: Weak::new(),
            queue: Weak::new(),
            scheduler: scheduler.clone(),
            phone_calls: PhoneCallService::inert_for_test(),
            credentials,
            legacy_sessions: Arc::new(Mutex::new(HashMap::new())),
            message_url: "http://unused/message".to_string(),
        }),
    );

    handler
        .schedule_prompt(Parameters(SchedulePromptArguments {
            prompt: "future work".to_string(),
            scheduled_for: (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        }))
        .await
        .expect("schedule_prompt path succeeds");
    handler
        .list_scheduled_prompts()
        .await
        .expect("list_scheduled_prompts path succeeds");
    assert_eq!(scheduler.list(&thread_id).await.len(), 1);
}

#[test]
fn exact_agent_message_envelope_round_trips() {
    let expected = envelope();
    let encoded = expected.encode().unwrap();

    assert!(encoded.contains(r#""replyToThreadId":"parent""#));
    assert_eq!(AgentMessageEnvelope::decode(&encoded), Some(expected));
}

#[test]
fn legacy_agent_message_envelopes_gain_an_unambiguous_reply_target() {
    let expected = envelope();
    let encoded = expected.encode().unwrap();
    let legacy = encoded.replacen(r#","replyToThreadId":"parent""#, "", 1);

    assert_eq!(AgentMessageEnvelope::decode(&legacy), Some(expected));
    assert!(AgentMessageEnvelope::decode(&encoded.replace(
        r#""replyToThreadId":"parent""#,
        r#""replyToThreadId":"child""#
    ))
    .is_none());
}

#[test]
fn echoed_agent_message_envelope_allows_only_outer_ascii_whitespace() {
    let expected = envelope();
    let encoded = expected.encode().unwrap();

    assert_eq!(
        AgentMessageEnvelope::decode_echo(&format!("\n{encoded}\r\n")),
        Some(expected),
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

    let future = encoded.replace(r#""version":1"#, r#""version":2"#);
    assert!(AgentMessageEnvelope::decode(&future).is_none());

    let wrong_tool = encoded.replace(SEND_AGENT_MESSAGE_TOOL, "other_tool");
    assert!(AgentMessageEnvelope::decode(&wrong_tool).is_none());

    let unknown_field = encoded.replace(r#""replyTool""#, r#""unexpected":true,"replyTool""#);
    assert!(AgentMessageEnvelope::decode(&unknown_field).is_none());
}

#[test]
fn reserved_envelope_markers_are_detected_across_prefixed_text_blocks() {
    let encoded = envelope().encode().expect("agent message envelope");
    let split_at = encoded
        .find(r#","senderThreadId""#)
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
    .collect::<Vec<agent_client_protocol::v1::schema::ContentBlock>>();

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
            <= MAX_MCP_REQUEST_BYTES,
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
        r#"""#.repeat(MAX_AGENT_MESSAGE_BODY_BYTES),
    );
    assert!(oversized.body.len() <= MAX_AGENT_MESSAGE_BODY_BYTES);
    assert!(oversized.encode().expect("agent-message envelope").len() > QUEUE_MAX_CONTENT_BYTES);
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
        }),
    );
    config.activate_credential(first, "thread-a").unwrap();
    assert_eq!(
        store.resolve_authorization(&first_header),
        Some(McpCredentialPrincipal::Active {
            agent_id: "agent-a".to_string(),
            thread_id: "thread-a".to_string(),
        }),
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
        }),
    );
    config.revoke_threads(["thread-a"]);
    assert_eq!(store.resolve_authorization(&second_header), None);
}

#[test]
fn credential_store_rejects_invalid_transitions_and_cleans_every_session_kind() {
    let store = Arc::new(McpCredentialStore::default());
    assert!(McpProtocolSessionEvictions::default().is_empty());
    assert!(!McpProtocolSessionEvictions {
        http_sessions: vec!["http".into()],
        legacy_sessions: vec![],
    }
    .is_empty());
    assert!(!McpProtocolSessionEvictions {
        http_sessions: vec![],
        legacy_sessions: vec![CancellationToken::new()],
    }
    .is_empty());
    assert!(store.authenticate("Basic invalid").is_none());
    assert!(store.authenticate("Bearer missing").is_none());
    assert!(store
        .bind_http_session("missing-http", "missing-token")
        .is_err());
    assert!(store
        .bind_legacy_session("missing-legacy", "missing-token", CancellationToken::new())
        .is_err());
    assert_eq!(
        store.activate("missing-token", "thread"),
        Err(McpCredentialError::UnknownPending),
    );

    let pending = McpCredentialStore::stage(&store, "agent").unwrap();
    let token = pending.token.clone();
    store.activate(&token, "thread").unwrap();
    assert_eq!(
        store.activate(&token, "thread"),
        Err(McpCredentialError::UnknownPending),
    );
    assert!(store.bind_http_session("http", &token).unwrap().is_empty());
    assert!(store.bind_http_session("http", &token).unwrap().is_empty());
    let cancellation = CancellationToken::new();
    store
        .bind_legacy_session("legacy", &token, cancellation.clone())
        .unwrap();
    store.unbind_http_session("unknown-http");
    store.unbind_legacy_session("unknown-legacy");
    store.revoke_threads(["unknown-thread"]);
    store.revoke_threads(["thread"]);
    assert!(cancellation.is_cancelled());
    assert_eq!(store.resolve_token(&token), None);

    let pending = McpCredentialStore::stage(&store, "agent").unwrap();
    let token = pending.token.clone();
    store.activate(&token, "thread-mismatch").unwrap();
    store
        .state
        .lock()
        .unwrap()
        .active_by_thread
        .insert("thread-mismatch".into(), "replacement".into());
    store.remove_token(&token);
    store.remove_token("already-removed");

    let pending = McpCredentialStore::stage(&store, "agent").unwrap();
    let token = pending.token.clone();
    store.activate(&token, "thread-direct-remove").unwrap();
    store.remove_token(&token);

    let pending = McpCredentialStore::stage(&store, "agent").unwrap();
    let token = pending.token.clone();
    store.activate(&token, "thread-2").unwrap();
    let cancellation = CancellationToken::new();
    store
        .bind_legacy_session("legacy-2", &token, cancellation.clone())
        .unwrap();
    store.revoke_all();
    assert!(cancellation.is_cancelled());
    assert_eq!(store.resolve_token(&token), None);

    let mut state = McpCredentialState::default();
    let mut evicted = McpProtocolSessionEvictions::default();
    McpCredentialStore::evict_protocol_session(
        &mut state,
        McpProtocolSession::Http("missing".into()),
        &mut evicted,
    );
    McpCredentialStore::evict_protocol_session(
        &mut state,
        McpProtocolSession::Legacy("missing".into()),
        &mut evicted,
    );
    let cancellation = CancellationToken::new();
    state
        .legacy_sessions
        .insert("present".into(), ("token".into(), cancellation.clone()));
    McpCredentialStore::evict_protocol_session(
        &mut state,
        McpProtocolSession::Legacy("present".into()),
        &mut evicted,
    );
    assert_eq!(evicted.legacy_sessions.len(), 1);
    evicted.legacy_sessions[0].cancel();
    assert!(cancellation.is_cancelled());
}

#[tokio::test]
async fn stores_without_http_managers_treat_close_as_a_noop() {
    let credentials = Arc::new(McpCredentialStore::default());
    credentials.close_http_session("missing").await;
    let state = Arc::new(AgentMessagingRouterState {
        backend: Weak::new(),
        queue: Weak::new(),
        scheduler: ScheduledPromptService::inert_for_test(),
        phone_calls: PhoneCallService::inert_for_test(),
        credentials,
        legacy_sessions: Arc::new(Mutex::new(HashMap::new())),
        message_url: "http://unused/message".into(),
    });
    assert_eq!(
        open_legacy_sse(State(state), HeaderMap::new())
            .await
            .status(),
        StatusCode::UNAUTHORIZED,
    );
}

#[test]
fn protocol_cleanup_without_a_runtime_does_not_spawn_tasks() {
    let store = McpCredentialStore::default();
    store.install_http_session_manager(Arc::new(LocalSessionManager::default()));
    store.close_protocol_sessions(vec!["missing".into()], vec![]);
}

#[test]
fn credential_store_enforces_pending_limit_and_handles_dropped_store() {
    let store = Arc::new(McpCredentialStore::default());
    {
        let mut state = store.state.lock().unwrap();
        for index in 0..MAX_MCP_CREDENTIALS {
            state.by_token.insert(
                format!("token-{index}"),
                McpCredentialRecord {
                    agent_id: "agent".into(),
                    thread_id: None,
                },
            );
        }
    }
    assert!(matches!(
        McpCredentialStore::stage(&store, "agent"),
        Err(McpCredentialError::LimitReached)
    ));

    let orphan = {
        let temporary = Arc::new(McpCredentialStore::default());
        McpCredentialStore::stage(&temporary, "agent").unwrap()
    };
    drop(orphan);
}

#[tokio::test]
async fn handler_accessors_distinguish_pending_revoked_and_mismatched_credentials() {
    let credentials = Arc::new(McpCredentialStore::default());
    let pending = McpCredentialStore::stage(&credentials, "agent").unwrap();
    let token = pending.token.clone();
    let state = Arc::new(AgentMessagingRouterState {
        backend: Weak::new(),
        queue: Weak::new(),
        scheduler: ScheduledPromptService::inert_for_test(),
        phone_calls: PhoneCallService::inert_for_test(),
        credentials: credentials.clone(),
        legacy_sessions: Arc::new(Mutex::new(HashMap::new())),
        message_url: "http://unused/message".into(),
    });
    let handler = AgentMessagingMcpHandler::new(
        AuthenticatedMcpCredential {
            token: token.clone(),
            agent_id: "agent".into(),
        },
        state.clone(),
    );
    assert!(handler.active_caller().is_err());
    assert!(handler.backend().is_err());
    assert!(handler.queue().is_err());

    credentials.activate(&token, "thread").unwrap();
    assert!(handler
        .send_agent_message(Parameters(SendAgentMessageArguments {
            recipient_thread_id: "recipient".into(),
            message: "valid message".into(),
        }))
        .await
        .is_err());
    let mismatched = AgentMessagingMcpHandler::new(
        AuthenticatedMcpCredential {
            token: token.clone(),
            agent_id: "other-agent".into(),
        },
        state,
    );
    assert!(mismatched.active_caller().is_err());
    credentials.revoke_all();
    assert!(handler.active_caller().is_err());

    assert_eq!(
        scheduled_prompt_tool_error(ScheduledPromptError::Invalid("bad".into()))
            .code
            .0,
        -32602,
    );
    assert_eq!(
        scheduled_prompt_tool_error(ScheduledPromptError::Internal("bad".into()))
            .code
            .0,
        -32603,
    );
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
        McpHttpSessionAuthorization::Authorized,
    );
    assert_eq!(
        store.http_session_authorization("mcp-session", &second.token),
        McpHttpSessionAuthorization::WrongCredential,
    );
    assert!(store
        .bind_http_session("mcp-session", &second.token)
        .is_err());

    drop(first);
    assert_eq!(
        store.http_session_authorization("mcp-session", &second.token),
        McpHttpSessionAuthorization::Unknown,
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
        McpHttpSessionAuthorization::Unknown,
    );
    assert_eq!(
        store.http_session_authorization("replacement", &replacement.token),
        McpHttpSessionAuthorization::Authorized,
    );
    assert_eq!(
        store
            .state
            .lock()
            .expect("credential state lock")
            .http_sessions
            .len(),
        MAX_MCP_PROTOCOL_SESSIONS,
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
        McpHttpSessionAuthorization::Unknown,
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
        ScheduledPromptService::inert_for_test(),
        PhoneCallService::inert_for_test(),
    )
    .await
    .expect("shared MCP listener starts");
    let config = service.config().clone();
    let http_url = reqwest::Url::parse(&config.http_url).unwrap();
    let sse_url = reqwest::Url::parse(&config.sse_url).unwrap();
    assert_eq!(http_url.host_str(), Some("127.0.0.1"));
    assert_eq!(http_url.port(), sse_url.port());

    let client = crate::tls::http_client_builder()
        .no_proxy()
        .build()
        .unwrap();
    assert_eq!(
        client
            .post(config.http_url.clone())
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED,
    );
    assert_eq!(
        client
            .get(config.sse_url.clone())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED,
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
        ScheduledPromptService::inert_for_test(),
        PhoneCallService::inert_for_test(),
    )
    .await
    .expect("shared MCP listener starts");
    let config = service.config().clone();
    let pending = config.stage_credential("agent-a").unwrap();
    let authorization = match config
        .descriptor(McpTransportPreference::Http, &pending)
        .expect("HTTP descriptor")
    {
        McpServer::Http(descriptor) => descriptor.headers[0].value.clone(),
        _ => panic!("unexpected MCP descriptor"),
    };
    let client = crate::tls::http_client_builder()
        .no_proxy()
        .build()
        .unwrap();
    let mut session_ids = Vec::new();

    for request_id in 0..MAX_MCP_SESSIONS_PER_CREDENTIAL as u64 {
        let response = initialize_http_session(&client, &config, &authorization, request_id).await;
        assert_eq!(response.status(), StatusCode::OK);
        session_ids.push(
            response
                .headers()
                .get(MCP_SESSION_HEADER.as_str())
                .map(reqwest::header::HeaderValue::to_str)
                .and_then(Result::ok)
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
        MAX_MCP_SESSIONS_PER_CREDENTIAL,
    );
    let tools = client
        .post(config.http_url.clone())
        .header(AUTHORIZATION, &authorization)
        .header(MCP_SESSION_HEADER.as_str(), &session_ids[0])
        .header("mcp-protocol-version", "2025-03-26")
        .header("accept", "application/json, text/event-stream")
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 98,
            "method": "tools/list",
        }))
        .send()
        .await
        .expect("tools/list response");
    assert_eq!(tools.status(), StatusCode::OK);
    let tools = tools.text().await.expect("tools/list body");
    for name in [
        "schedule_prompt",
        "list_scheduled_prompts",
        "cancel_scheduled_prompt",
        "start_phone_call",
        "steer_phone_call",
        "get_phone_call",
        "hangup_phone_call",
    ] {
        assert!(tools.contains(name), "missing MCP tool schema for {name}");
    }

    let replacement = initialize_http_session(&client, &config, &authorization, 99).await;
    assert_eq!(replacement.status(), StatusCode::OK);
    assert_eq!(
        manager.sessions.read().await.len(),
        MAX_MCP_SESSIONS_PER_CREDENTIAL,
    );
    assert_eq!(
        config
            .credentials
            .http_session_authorization(&session_ids[0], &pending.token),
        McpHttpSessionAuthorization::Unknown,
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
        McpHttpSessionAuthorization::Authorized,
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
        McpHttpSessionAuthorization::Unknown,
    );
    assert_eq!(
        manager.sessions.read().await.len(),
        MAX_MCP_SESSIONS_PER_CREDENTIAL - 1,
    );

    let next_replacement = initialize_http_session(&client, &config, &authorization, 100).await;
    assert_eq!(next_replacement.status(), StatusCode::OK);
    assert_eq!(
        manager.sessions.read().await.len(),
        MAX_MCP_SESSIONS_PER_CREDENTIAL,
    );

    drop(pending);
    service.shutdown().await;
}

#[tokio::test]
async fn revocation_closes_legacy_sse_before_mcp_initialization() {
    let service = AgentMessagingService::start(
        Weak::<RuntimeBackend>::new(),
        Weak::<BridgeQueueService>::new(),
        ScheduledPromptService::inert_for_test(),
        PhoneCallService::inert_for_test(),
    )
    .await
    .expect("shared MCP listener starts");
    let config = service.config().clone();
    let pending = config.stage_credential("agent-a").unwrap();
    let authorization = match config
        .descriptor(McpTransportPreference::Sse, &pending)
        .expect("SSE descriptor")
    {
        McpServer::Sse(descriptor) => descriptor.headers[0].value.clone(),
        _ => panic!("unexpected MCP descriptor"),
    };
    let client = crate::tls::http_client_builder()
        .no_proxy()
        .build()
        .unwrap();
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
        1,
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

#[tokio::test]
async fn authenticated_handler_routes_phone_call_tools_with_caller_session_isolation() {
    let credentials = Arc::new(McpCredentialStore::default());
    let config = AgentMessagingMcpConfig::new(
        "http://unused".into(),
        "http://unused".into(),
        credentials.clone(),
    );
    let pending = config.stage_credential("agent").unwrap();
    let token = pending.token.clone();
    let thread_id = crate::acp::identity::AgentSessionId::new("agent", "phone-owner")
        .unwrap()
        .encode();
    config
        .activate_credential(pending, &thread_id)
        .expect("credential activates");

    let phone_calls = PhoneCallService::inert_for_test();
    let handler = AgentMessagingMcpHandler::new(
        AuthenticatedMcpCredential {
            token,
            agent_id: "agent".to_string(),
        },
        Arc::new(AgentMessagingRouterState {
            backend: Weak::new(),
            queue: Weak::new(),
            scheduler: ScheduledPromptService::inert_for_test(),
            phone_calls,
            credentials,
            legacy_sessions: Arc::new(Mutex::new(HashMap::new())),
            message_url: "http://unused/message".to_string(),
        }),
    );

    let unconfigured_err = handler
        .start_phone_call(Parameters(StartPhoneCallArguments {
            phone_number: "+15551234567".to_string(),
            objective: "Check reservation".to_string(),
            callee_name: None,
            first_message: None,
            context: None,
        }))
        .await
        .expect_err("unconfigured phone calls must return MCP invalid_params");
    assert!(unconfigured_err.message.contains("not configured"));

    let get_unknown = handler
        .get_phone_call(Parameters(GetPhoneCallArguments {
            call_id: "missing-call".to_string(),
        }))
        .await
        .expect("get_phone_call returns not_found snapshot");
    let get_val: serde_json::Value =
        serde_json::from_str(&get_unknown.content[0].as_text().expect("text").text)
            .expect("parse get json");
    assert_eq!(get_val["status"], "not_found");
    assert_eq!(get_val["callId"], "missing-call");

    let steer_unknown = handler
        .steer_phone_call(Parameters(SteerPhoneCallArguments {
            call_id: "missing-call".to_string(),
            instruction: "Ask about patio".to_string(),
        }))
        .await
        .expect("steer_phone_call returns not_found result");
    let steer_val: serde_json::Value =
        serde_json::from_str(&steer_unknown.content[0].as_text().expect("text").text)
            .expect("parse steer json");
    assert_eq!(steer_val["status"], "not_found");

    let hangup_unknown = handler
        .hangup_phone_call(Parameters(HangupPhoneCallArguments {
            call_id: "missing-call".to_string(),
        }))
        .await
        .expect("hangup_phone_call returns not_found result");
    let hangup_val: serde_json::Value =
        serde_json::from_str(&hangup_unknown.content[0].as_text().expect("text").text)
            .expect("parse hangup json");
    assert_eq!(hangup_val["status"], "not_found");
}
