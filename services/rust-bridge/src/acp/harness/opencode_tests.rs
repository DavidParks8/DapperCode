use super::{
    fork_boundary_text_matches, is_verified_opencode_acp, opencode_messages, opencode_prompt_parts,
    resolve_opencode_message_id, session_action_url, timed_agent_message_send_with_timeout,
    validate_fork_response, wait_for_opencode_idle, Arc, ContentBlock, Duration, HarnessAdapter,
    HarnessAgentMessageOutcome, HarnessAgentMessageRequest, HarnessCapabilities, HarnessContext,
    HarnessDeleteRequest, HarnessError, HarnessForkBoundary, HarnessForkBoundaryMessage,
    HarnessForkRequest, HarnessSteerRequest, HashMap, OpenCodeForkResponse, OpenCodeHarnessAdapter,
    OpenCodePromptPart, OpenCodePromptRequest, PathBuf, ResolvedAgentManifest, SessionContext,
    StatusCode, MAX_OPENCODE_RESPONSE_BYTES, MAX_OPENCODE_SESSION_ID_BYTES,
    OPENCODE_BACKGROUND_SUBAGENTS_ENV,
};
use crate::acp::config::RuntimeIntegrity;
use agent_client_protocol::v1::schema::SessionId;
use axum::extract::{Path as AxumPath, State};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex as StdMutex;
use tokio::sync::mpsc;

async fn fixture_context(
    app: Router,
    session_id: &str,
) -> (SessionContext, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener");
    let address = listener.local_addr().expect("listener address");
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("test server");
    });
    (
        SessionContext {
            http: crate::tls::http_client(),
            http_base: format!("http://{address}/"),
            session_id: SessionId::new(session_id),
            cwd: std::env::current_dir().expect("current directory"),
        },
        server,
    )
}

fn manifest(executable: &str, agent_id: &str, argv: &[&str]) -> ResolvedAgentManifest {
    ResolvedAgentManifest {
        agent_id: agent_id.to_string(),
        executable: PathBuf::from(executable),
        argv: argv.iter().map(|value| (*value).to_string()).collect(),
        environment: BTreeMap::new(),
        resolved_version: "1".to_string(),
        provenance: "test".to_string(),
        verified_digest: format!("sha256:{}", "0".repeat(64)),
        integrity: RuntimeIntegrity::Executable,
    }
}

#[test]
fn only_the_exact_opencode_invocation_selects_the_harness() {
    assert!(is_verified_opencode_acp(&manifest(
        "/usr/local/bin/opencode",
        "opencode",
        &["acp"]
    )));
    assert!(is_verified_opencode_acp(&manifest(
        "opencode.exe",
        "opencode",
        &["acp"]
    )));
    assert!(is_verified_opencode_acp(&manifest(
        "/opt/homebrew/lib/node_modules/opencode-ai/dist/cli.js",
        "opencode",
        &["acp"]
    )));
    assert!(!is_verified_opencode_acp(&manifest(
        "/usr/local/bin/other",
        "opencode",
        &["acp"]
    )));
    assert!(!is_verified_opencode_acp(&manifest(
        "/opt/homebrew/lib/node_modules/unrelated-package/dist/cli.js",
        "opencode",
        &["acp"]
    )));
    assert!(!is_verified_opencode_acp(&manifest(
        "/usr/local/bin/opencode",
        "spoofed",
        &["acp"]
    )));
    assert!(!is_verified_opencode_acp(&manifest(
        "/usr/local/bin/opencode",
        "opencode",
        &[]
    )));
    assert!(fork_boundary_text_matches(
        "second request with a long tail",
        "second request",
        true
    ));
    assert!(!fork_boundary_text_matches(
        "second request with a long tail",
        "second request",
        false
    ));

    let verified = manifest("/usr/local/bin/opencode", "opencode", &["acp"]);
    assert_eq!(
        OpenCodeHarnessAdapter.capabilities(&HarnessContext {
            manifest: &verified,
            http_base: None,
        }),
        HarnessCapabilities::default(),
    );
    let spoofed = manifest("/usr/local/bin/other", "opencode", &["acp"]);
    assert_eq!(
        OpenCodeHarnessAdapter.capabilities(&HarnessContext {
            manifest: &spoofed,
            http_base: Some("http://127.0.0.1"),
        }),
        HarnessCapabilities::default(),
    );
    let launch = OpenCodeHarnessAdapter
        .launch_config()
        .expect("loopback launch configuration");
    assert_eq!(launch.extra_args[0], "--port");
    assert_eq!(
        launch
            .extra_environment
            .get(OPENCODE_BACKGROUND_SUBAGENTS_ENV)
            .map(String::as_str),
        Some("true"),
    );
    assert!(launch.http_base.starts_with("http://127.0.0.1:"));
}

#[test]
fn fork_response_validation_rejects_each_mismatched_field() {
    let cwd = std::env::current_dir().expect("current directory");
    let valid = || OpenCodeForkResponse {
        id: "forked".to_string(),
        parent_id: Some("source".to_string()),
        directory: cwd.to_string_lossy().to_string(),
        title: None,
    };
    assert!(validate_fork_response(&valid(), "source", &cwd).is_ok());

    let mut forked = valid();
    forked.id.clear();
    assert!(matches!(
        validate_fork_response(&forked, "source", &cwd),
        Err(HarnessError::InvalidResponse(_))
    ));
    let mut forked = valid();
    forked.id = "x".repeat(MAX_OPENCODE_SESSION_ID_BYTES + 1);
    assert!(validate_fork_response(&forked, "source", &cwd).is_err());
    let mut forked = valid();
    forked.id = "source".to_string();
    assert!(validate_fork_response(&forked, "source", &cwd).is_err());
    let mut forked = valid();
    forked.parent_id = Some("other".to_string());
    assert!(validate_fork_response(&forked, "source", &cwd).is_err());
    let mut forked = valid();
    forked.directory = cwd.join("other").to_string_lossy().to_string();
    assert!(validate_fork_response(&forked, "source", &cwd).is_err());
}

#[tokio::test]
async fn opencode_delete_handles_not_found_and_surfaces_http_and_verification_failures() {
    let adapter = OpenCodeHarnessAdapter;
    let request = || HarnessDeleteRequest {
        affected_session_ids: vec!["source".to_string()],
    };

    let app = Router::new().route(
        "/session/source",
        delete(|| async { StatusCode::NOT_FOUND }).get(|| async { StatusCode::NOT_FOUND }),
    );
    let (context, server) = fixture_context(app, "source").await;
    adapter
        .delete(&context, request())
        .await
        .expect("not found is already deleted");
    assert!(!adapter
        .session_exists(&context)
        .await
        .expect("empty catalog confirms absence"));
    server.abort();

    let app = Router::new().route(
        "/session/source",
        delete(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
    );
    let (context, server) = fixture_context(app, "source").await;
    assert!(matches!(
        adapter.delete(&context, request()).await,
        Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
    ));
    server.abort();

    let app = Router::new().route(
        "/session/source",
        delete(|| async { StatusCode::OK }).get(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
    );
    let (context, server) = fixture_context(app, "source").await;
    assert!(matches!(
        adapter.delete(&context, request()).await,
        Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
    ));
    server.abort();

    let app = Router::new().route(
        "/session/source",
        delete(|| async { StatusCode::OK })
            .get(|| async { Json(serde_json::json!({"id": "source"})) }),
    );
    let (context, server) = fixture_context(app, "source").await;
    assert!(adapter
        .session_exists(&context)
        .await
        .expect("catalog confirms the session is live"));
    assert!(matches!(
        adapter.delete(&context, request()).await,
        Err(HarnessError::InvalidResponse(_))
    ));
    server.abort();
}

#[tokio::test]
async fn opencode_session_exists_uses_the_exact_session_endpoint() {
    let adapter = OpenCodeHarnessAdapter;
    let exact_calls = Arc::new(AtomicUsize::new(0));
    let observed_exact_calls = exact_calls.clone();
    let app = Router::new()
        .route(
            "/session",
            get(|| async {
                Json(
                    (0..2048)
                        .map(|index| serde_json::json!({"id": format!("other-{index}")}))
                        .collect::<Vec<_>>(),
                )
            }),
        )
        .route(
            "/session/source",
            get(
                move |axum::extract::Query(query): axum::extract::Query<
                    HashMap<String, String>,
                >| {
                    let exact_calls = observed_exact_calls.clone();
                    async move {
                        assert!(query
                            .get("directory")
                            .is_some_and(|value| !value.is_empty()));
                        exact_calls.fetch_add(1, Ordering::SeqCst);
                        Json(serde_json::json!({"id": "source"}))
                    }
                },
            ),
        );
    let (context, server) = fixture_context(app, "source").await;

    assert!(adapter
        .session_exists(&context)
        .await
        .expect("exact endpoint confirms the session despite a saturated catalog"));
    assert_eq!(exact_calls.load(Ordering::SeqCst), 1);
    server.abort();

    for (status, body, expected) in [
        (StatusCode::NOT_FOUND, "", "absent"),
        (StatusCode::OK, "{}", "malformed"),
        (StatusCode::INTERNAL_SERVER_ERROR, "", "failure"),
    ] {
        let app = Router::new().route(
            "/session/source",
            get(move || async move { (status, body) }),
        );
        let (context, server) = fixture_context(app, "source").await;
        let result = adapter.session_exists(&context).await;
        match expected {
            "absent" => assert!(!result.expect("404 is definitive absence")),
            "malformed" => {
                assert!(matches!(result, Err(HarnessError::InvalidResponse(_))))
            }
            "failure" => assert!(matches!(
                result,
                Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
            )),
            _ => unreachable!(),
        }
        server.abort();
    }
}

#[tokio::test]
async fn opencode_steer_surfaces_abort_prompt_and_content_failures() {
    let adapter = OpenCodeHarnessAdapter;
    let text = || {
        serde_json::from_value(serde_json::json!({"type": "text", "text": "replacement"}))
            .expect("text content")
    };

    let app = Router::new().route(
        "/session/source/abort",
        post(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
    );
    let (context, server) = fixture_context(app, "source").await;
    assert!(matches!(
        adapter
            .steer(
                &context,
                HarnessSteerRequest {
                    prompt: vec![text()],
                },
            )
            .await,
        Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
    ));
    server.abort();

    let app = Router::new()
        .route("/session/source/abort", post(|| async { StatusCode::OK }))
        .route(
            "/session/source/prompt_async",
            post(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
        );
    let (context, server) = fixture_context(app, "source").await;
    assert!(matches!(
        adapter
            .steer(
                &context,
                HarnessSteerRequest {
                    prompt: vec![text()],
                },
            )
            .await,
        Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
    ));
    server.abort();

    let app = Router::new()
        .route("/session/source/abort", post(|| async { StatusCode::OK }))
        .route(
            "/session/source/prompt_async",
            post(|| async { StatusCode::OK }),
        );
    let (context, server) = fixture_context(app, "source").await;
    adapter
        .steer(
            &context,
            HarnessSteerRequest {
                prompt: vec![text()],
            },
        )
        .await
        .expect("successful non-204 prompt response");
    server.abort();

    let image: ContentBlock = serde_json::from_value(serde_json::json!({
        "type": "image",
        "data": "aW1hZ2U=",
        "mimeType": "image/png"
    }))
    .expect("image content");
    assert!(matches!(
        opencode_prompt_parts(&[image]),
        Err(HarnessError::UnsupportedContent)
    ));
}

#[tokio::test]
async fn opencode_live_agent_message_promotes_then_prompts_without_aborting() {
    let observed = Arc::new(StdMutex::new(Vec::<(String, serde_json::Value)>::new()));
    let background_observed = observed.clone();
    let prompt_observed = observed.clone();
    let app = Router::new()
        .route(
            "/experimental/session/source/background",
            post(move || {
                let observed = background_observed.clone();
                async move {
                    observed
                        .lock()
                        .expect("observed requests lock")
                        .push(("background".to_string(), serde_json::Value::Null));
                    Json(true)
                }
            }),
        )
        .route(
            "/session/source/prompt_async",
            post(move |Json(body): Json<serde_json::Value>| {
                let observed = prompt_observed.clone();
                async move {
                    observed
                        .lock()
                        .expect("observed requests lock")
                        .push(("prompt".to_string(), body));
                    StatusCode::NO_CONTENT
                }
            }),
        );
    let (context, server) = fixture_context(app, "source").await;

    let outcome = OpenCodeHarnessAdapter
        .deliver_agent_message(
            &context,
            HarnessAgentMessageRequest {
                prompt: vec![serde_json::from_value(serde_json::json!({
                    "type": "text",
                    "text": "child needs guidance"
                }))
                .expect("text content")],
                promote_blocking_subagents: true,
            },
        )
        .await
        .expect("live agent message");
    assert_eq!(outcome, HarnessAgentMessageOutcome::Delivered);

    let observed = observed.lock().expect("observed requests lock");
    assert_eq!(
        observed
            .iter()
            .map(|(operation, _)| operation.as_str())
            .collect::<Vec<_>>(),
        ["background", "prompt"],
    );
    assert_eq!(
        observed[1].1,
        serde_json::json!({
            "parts": [{"type": "text", "text": "child needs guidance"}]
        }),
    );
    server.abort();
}

#[tokio::test]
async fn opencode_live_agent_message_does_not_submit_when_promotion_is_unavailable() {
    let prompt_calls = Arc::new(AtomicUsize::new(0));
    let prompt_calls_for_route = prompt_calls.clone();
    let app = Router::new()
        .route(
            "/experimental/session/source/background",
            post(|| async { Json(false) }),
        )
        .route(
            "/session/source/prompt_async",
            post(move || {
                let prompt_calls = prompt_calls_for_route.clone();
                async move {
                    prompt_calls.fetch_add(1, Ordering::SeqCst);
                    StatusCode::NO_CONTENT
                }
            }),
        );
    let (context, server) = fixture_context(app, "source").await;

    let outcome = OpenCodeHarnessAdapter
        .deliver_agent_message(
            &context,
            HarnessAgentMessageRequest {
                prompt: vec![serde_json::from_value(serde_json::json!({
                    "type": "text",
                    "text": "wait for the current tool"
                }))
                .expect("text content")],
                promote_blocking_subagents: true,
            },
        )
        .await
        .expect("unavailable promotion defers without submission");
    assert_eq!(outcome, HarnessAgentMessageOutcome::Deferred);
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 0);
    server.abort();

    let app = Router::new().route(
        "/experimental/session/source/background",
        post(|| async { StatusCode::NOT_FOUND }),
    );
    let (context, server) = fixture_context(app, "source").await;
    let outcome = OpenCodeHarnessAdapter
        .deliver_agent_message(
            &context,
            HarnessAgentMessageRequest {
                prompt: vec![serde_json::from_value(serde_json::json!({
                    "type": "text",
                    "text": "older OpenCode"
                }))
                .expect("text content")],
                promote_blocking_subagents: true,
            },
        )
        .await
        .expect("missing promotion endpoint defers safely");
    assert_eq!(outcome, HarnessAgentMessageOutcome::Deferred);
    server.abort();
}

#[tokio::test]
async fn opencode_live_agent_message_keeps_connect_failures_retryable() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("reserve closed test port");
    let address = listener.local_addr().expect("test address");
    drop(listener);
    let context = SessionContext {
        http: crate::tls::http_client(),
        http_base: format!("http://{address}"),
        session_id: SessionId::new("source"),
        cwd: std::env::current_dir().expect("current directory"),
    };

    let failure = OpenCodeHarnessAdapter
        .deliver_agent_message(
            &context,
            HarnessAgentMessageRequest {
                prompt: vec![serde_json::from_value(serde_json::json!({
                    "type": "text",
                    "text": "retry safely"
                }))
                .expect("text content")],
                promote_blocking_subagents: false,
            },
        )
        .await
        .expect_err("closed port must fail");
    assert!(!failure.is_indeterminate());
}

#[tokio::test]
async fn opencode_live_agent_reply_skips_promotion_and_prompts_the_running_child() {
    let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
    let app = Router::new().route(
        "/session/source/prompt_async",
        post(move |Json(body): Json<serde_json::Value>| {
            let observed = observed_tx.clone();
            async move {
                observed.send(body).expect("observe child prompt");
                StatusCode::NO_CONTENT
            }
        }),
    );
    let (context, server) = fixture_context(app, "source").await;

    let outcome = OpenCodeHarnessAdapter
        .deliver_agent_message(
            &context,
            HarnessAgentMessageRequest {
                prompt: vec![serde_json::from_value(serde_json::json!({
                    "type": "text",
                    "text": "parent reply"
                }))
                .expect("text content")],
                promote_blocking_subagents: false,
            },
        )
        .await
        .expect("live child reply");

    assert_eq!(outcome, HarnessAgentMessageOutcome::Delivered);
    assert_eq!(
        observed_rx.recv().await,
        Some(serde_json::json!({
            "parts": [{"type": "text", "text": "parent reply"}]
        })),
    );
    server.abort();
}

#[tokio::test]
async fn opencode_live_agent_message_surfaces_definitive_http_failures() {
    let app = Router::new().route(
        "/experimental/session/source/background",
        post(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
    );
    let (context, server) = fixture_context(app, "source").await;
    let request = |promote_blocking_subagents| HarnessAgentMessageRequest {
        prompt: vec![serde_json::from_value(serde_json::json!({
            "type": "text",
            "text": "message"
        }))
        .expect("text content")],
        promote_blocking_subagents,
    };
    let failure = OpenCodeHarnessAdapter
        .deliver_agent_message(&context, request(true))
        .await
        .expect_err("promotion HTTP failure");
    assert!(!failure.is_indeterminate());
    server.abort();

    let app = Router::new().route(
        "/session/source/prompt_async",
        post(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
    );
    let (context, server) = fixture_context(app, "source").await;
    let failure = OpenCodeHarnessAdapter
        .deliver_agent_message(&context, request(false))
        .await
        .expect_err("prompt HTTP failure");
    assert!(!failure.is_indeterminate());
    server.abort();
}

#[tokio::test]
async fn opencode_live_agent_message_timeout_is_indeterminate() {
    let app = Router::new().route(
        "/session/source/prompt_async",
        post(|| async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            StatusCode::NO_CONTENT
        }),
    );
    let (context, server) = fixture_context(app, "source").await;
    let url = session_action_url(&context, "source", "prompt_async").expect("prompt URL");
    let failure = timed_agent_message_send_with_timeout(
        context.http.post(url).json(&OpenCodePromptRequest {
            parts: vec![OpenCodePromptPart::Text {
                text: "ambiguous".to_string(),
            }],
        }),
        Duration::from_millis(10),
    )
    .await
    .expect_err("prompt timeout");
    assert!(failure.is_indeterminate());
    server.abort();
}

#[derive(Clone)]
struct ForkServerState {
    directory: String,
    observed: mpsc::UnboundedSender<String>,
}

async fn opencode_messages_fixture(
    AxumPath(session_id): AxumPath<String>,
) -> Json<serde_json::Value> {
    let users = if session_id == "source" {
        serde_json::json!([
            {"info": {"id": "raw-user-1", "role": "user"}, "parts": [{"type": "text", "text": "first"}]},
            {"info": {"id": "raw-user-2", "role": "user"}, "parts": [{"type": "text", "text": "second"}]}
        ])
    } else {
        serde_json::json!([
            {"info": {"id": "raw-user-1", "role": "user"}, "parts": [{"type": "text", "text": "first"}]}
        ])
    };
    Json(users)
}

async fn opencode_mismatched_messages_fixture(
    AxumPath(session_id): AxumPath<String>,
) -> Json<serde_json::Value> {
    if session_id == "source" {
        opencode_messages_fixture(AxumPath(session_id)).await
    } else {
        Json(serde_json::json!([]))
    }
}

async fn opencode_tail_messages_fixture() -> Json<serde_json::Value> {
    Json(serde_json::json!([
        {"info": {"id": "raw-user-1", "role": "user"}, "parts": [{"type": "text", "text": "first"}]},
        {"info": {"id": "raw-agent-1", "role": "assistant"}, "parts": [{"type": "text", "text": "answer"}]},
        {"info": {"id": "raw-user-2", "role": "user"}, "parts": [{"type": "text", "text": "second"}]},
        {"info": {"id": "raw-agent-2", "role": "assistant"}, "parts": [{"type": "text", "text": "answer"}]}
    ]))
}

async fn opencode_fork_fixture(
    State(state): State<ForkServerState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let _ = state.observed.send(
        body.get("messageID")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
    );
    Json(serde_json::json!({
        "id": "forked",
        "directory": state.directory,
        "title": "Forked"
    }))
}

#[tokio::test]
async fn opencode_fork_resolves_exact_identity_despite_snapshot_ordinal_drift() {
    let directory = std::env::current_dir().expect("current directory");
    let (observed, mut observed_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route(
            "/session/{session_id}/message",
            get(opencode_messages_fixture),
        )
        .route("/session/source/fork", post(opencode_fork_fixture))
        .with_state(ForkServerState {
            directory: directory.to_string_lossy().to_string(),
            observed,
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener");
    let address = listener.local_addr().expect("listener address");
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("test server");
    });
    let context = SessionContext {
        http: crate::tls::http_client(),
        http_base: format!("http://{address}/"),
        session_id: SessionId::new("source"),
        cwd: directory.clone(),
    };

    let forked = OpenCodeHarnessAdapter
        .fork(
            &context,
            HarnessForkRequest {
                user_message_ordinal: 0,
                boundary: HarnessForkBoundary::BeforeRequest(HarnessForkBoundaryMessage {
                    first_text: "second".to_string(),
                    first_text_truncated: false,
                    raw_message_id_hint: Some("raw-user-2".to_string()),
                }),
            },
        )
        .await
        .expect("fork succeeds");
    assert_eq!(forked.session_id, "forked");
    assert_eq!(forked.parent_session_id, "source");
    assert_eq!(forked.directory, directory);
    assert_eq!(observed_rx.recv().await.as_deref(), Some("raw-user-2"));
    server.abort();
}

#[tokio::test]
async fn opencode_fork_at_the_end_of_history_copies_every_turn() {
    let directory = std::env::current_dir().expect("current directory");
    let (observed, mut observed_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route(
            "/session/{session_id}/message",
            get(opencode_tail_messages_fixture),
        )
        .route("/session/source/fork", post(opencode_fork_fixture))
        .with_state(ForkServerState {
            directory: directory.to_string_lossy().to_string(),
            observed,
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener");
    let address = listener.local_addr().expect("listener address");
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("test server");
    });
    let context = SessionContext {
        http: crate::tls::http_client(),
        http_base: format!("http://{address}/"),
        session_id: SessionId::new("source"),
        cwd: directory.clone(),
    };

    let anchor = |first_text: &str, raw_message_id_hint: &str| {
        HarnessForkBoundary::EndOfHistory(HarnessForkBoundaryMessage {
            first_text: first_text.to_string(),
            first_text_truncated: false,
            raw_message_id_hint: Some(raw_message_id_hint.to_string()),
        })
    };
    let forked = OpenCodeHarnessAdapter
        .fork(
            &context,
            HarnessForkRequest {
                user_message_ordinal: 2,
                boundary: anchor("second", "raw-user-2"),
            },
        )
        .await
        .expect("tail fork succeeds");
    assert_eq!(forked.session_id, "forked");
    // No excluded message is named, which is how OpenCode is asked to copy the whole session.
    assert_eq!(observed_rx.recv().await.as_deref(), Some(""));

    // OpenCode may split one request across several canonical transcript messages, so the tail
    // check anchors on the newest request's identity instead of comparing message counts.
    OpenCodeHarnessAdapter
        .fork(
            &context,
            HarnessForkRequest {
                user_message_ordinal: 5,
                boundary: anchor("second", "raw-user-2"),
            },
        )
        .await
        .expect("tail fork tolerates a differently split transcript");
    assert_eq!(observed_rx.recv().await.as_deref(), Some(""));

    // A conversation that gained a turn since the snapshot was read must fail closed instead of
    // silently forking a longer conversation than the caller asked for.
    assert!(matches!(
        OpenCodeHarnessAdapter
            .fork(
                &context,
                HarnessForkRequest {
                    user_message_ordinal: 1,
                    boundary: anchor("first", "raw-user-1"),
                },
            )
            .await,
        Err(HarnessError::InvalidResponse(_))
    ));
    server.abort();
}

#[tokio::test]
async fn opencode_fork_and_message_validation_fail_closed() {
    let request = |first_text: &str, raw_message_id_hint: Option<&str>| HarnessForkRequest {
        user_message_ordinal: 1,
        boundary: HarnessForkBoundary::BeforeRequest(HarnessForkBoundaryMessage {
            first_text: first_text.to_string(),
            first_text_truncated: false,
            raw_message_id_hint: raw_message_id_hint.map(str::to_string),
        }),
    };

    let app = Router::new()
        .route(
            "/session/{session_id}/message",
            get(opencode_mismatched_messages_fixture),
        )
        .route(
            "/session/source/fork",
            post(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
        );
    let (context, server) = fixture_context(app, "source").await;
    let preflight = OpenCodeHarnessAdapter
        .fork_with_outcome(&context, request("not-present", None))
        .await
        .expect_err("stale boundary is rejected before the fork request");
    assert!(!preflight.is_indeterminate());
    assert!(matches!(
        OpenCodeHarnessAdapter
            .fork(&context, request("second", None))
            .await,
        Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
    ));
    server.abort();

    let app = Router::new()
        .route(
            "/session/{session_id}/message",
            get(opencode_mismatched_messages_fixture),
        )
        .route(
            "/session/source/fork",
            post(|| async {
                Json(serde_json::json!({
                    "id": "forked",
                    "parentID": "source",
                    "directory": std::env::current_dir()
                        .expect("current directory")
                        .to_string_lossy(),
                    "title": "Forked"
                }))
            }),
        );
    let (context, server) = fixture_context(app, "source").await;
    assert!(matches!(
        OpenCodeHarnessAdapter
            .fork(
                &context,
                HarnessForkRequest {
                    user_message_ordinal: 1,
                    boundary: HarnessForkBoundary::BeforeRequest(HarnessForkBoundaryMessage {
                        first_text: "second".to_string(),
                        first_text_truncated: false,
                        raw_message_id_hint: None,
                    },),
                },
            )
            .await,
        Err(HarnessError::InvalidResponse(_))
    ));
    server.abort();

    let app = Router::new().route(
        "/session/{session_id}/message",
        get(opencode_messages_fixture),
    );
    let (context, server) = fixture_context(app, "source").await;
    assert!(matches!(
        resolve_opencode_message_id(&context, &request("different", None)).await,
        Err(HarnessError::InvalidResponse(_))
    ));
    assert!(matches!(
        resolve_opencode_message_id(&context, &request("second", Some("wrong"))).await,
        Err(HarnessError::InvalidResponse(_))
    ));
    server.abort();

    let app = Router::new().route(
        "/session/source/message",
        get(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
    );
    let (context, server) = fixture_context(app, "source").await;
    assert!(matches!(
        opencode_messages(&context, "source").await,
        Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
    ));
    server.abort();

    let app = Router::new().route(
        "/session/source/message",
        get(|| async { "x".repeat(MAX_OPENCODE_RESPONSE_BYTES + 1) }),
    );
    let (context, server) = fixture_context(app, "source").await;
    assert!(matches!(
        opencode_messages(&context, "source").await,
        Err(HarnessError::ResponseTooLarge)
    ));
    server.abort();
}

#[derive(Clone, Copy)]
enum StatusFixtureMode {
    BusyThenAbsent,
    Absent,
    Idle,
    Busy,
    Failure,
}

#[derive(Clone)]
struct StatusFixtureState {
    calls: Arc<AtomicUsize>,
    mode: StatusFixtureMode,
}

async fn opencode_status_fixture(
    State(state): State<StatusFixtureState>,
) -> (StatusCode, Json<serde_json::Value>) {
    let call = state.calls.fetch_add(1, Ordering::SeqCst);
    match state.mode {
        StatusFixtureMode::BusyThenAbsent if call == 0 => (
            StatusCode::OK,
            Json(serde_json::json!({"source": {"type": "busy"}})),
        ),
        StatusFixtureMode::Busy => (
            StatusCode::OK,
            Json(serde_json::json!({"source": {"type": "busy"}})),
        ),
        StatusFixtureMode::Idle => (
            StatusCode::OK,
            Json(serde_json::json!({"source": {"type": "idle"}})),
        ),
        StatusFixtureMode::Failure => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "failed"})),
        ),
        StatusFixtureMode::BusyThenAbsent | StatusFixtureMode::Absent => {
            (StatusCode::OK, Json(serde_json::json!({})))
        }
    }
}

async fn status_fixture_context(
    mode: StatusFixtureMode,
) -> (
    SessionContext,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let calls = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route("/session/status", get(opencode_status_fixture))
        .with_state(StatusFixtureState {
            calls: calls.clone(),
            mode,
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener");
    let address = listener.local_addr().expect("listener address");
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("test server");
    });
    (
        SessionContext {
            http: crate::tls::http_client(),
            http_base: format!("http://{address}/"),
            session_id: SessionId::new("source"),
            cwd: std::env::current_dir().expect("current directory"),
        },
        calls,
        server,
    )
}

#[tokio::test]
async fn opencode_status_polling_accepts_absence_only_after_confirmation_and_surfaces_failures() {
    for (mode, minimum_calls) in [
        (StatusFixtureMode::BusyThenAbsent, 3),
        (StatusFixtureMode::Absent, 2),
        (StatusFixtureMode::Idle, 2),
    ] {
        let (context, calls, server) = status_fixture_context(mode).await;
        wait_for_opencode_idle(
            &context,
            Duration::from_millis(100),
            Duration::from_millis(5),
            Duration::from_millis(10),
        )
        .await
        .expect("absence confirms idle");
        assert!(calls.load(Ordering::SeqCst) >= minimum_calls);
        server.abort();
    }

    let (context, _, server) = status_fixture_context(StatusFixtureMode::Busy).await;
    assert!(matches!(
        wait_for_opencode_idle(
            &context,
            Duration::from_millis(20),
            Duration::from_millis(5),
            Duration::from_millis(10),
        )
        .await,
        Err(HarnessError::StatusTimeout)
    ));
    server.abort();

    let (context, _, server) = status_fixture_context(StatusFixtureMode::Failure).await;
    assert!(matches!(
        wait_for_opencode_idle(
            &context,
            Duration::from_millis(100),
            Duration::from_millis(5),
            Duration::from_millis(10),
        )
        .await,
        Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
    ));
    server.abort();
}
