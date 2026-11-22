use super::{
    client_outbox, completion_is_final, json, Arc, AtomicU64, BridgeQueueService,
    CanonicalHubEvent, ClientConnectionMetadata, ClientHub, ClientOutboxReceiver, Duration,
    HashMap, Message, MobilePresenceUpdate, OperationalMetrics, PendingApproval, PushEvent,
    PushEventPreferences, PushObservationUpdate, PushRegistryStore, PushService,
    QueueCompletionDisposition, QueueRuntimeDispatcher, QueueRuntimeSnapshot, RwLock, Uuid, Value,
    MOBILE_CLIENT_TYPE, PUSH_PREVIEW_ACCUMULATE_CAP, PUSH_PREVIEW_MAX_THREADS,
    PUSH_SEND_MAX_ATTEMPTS,
};
use crate::acp::events::{CanonicalEvent, MessageRole};
use agent_client_protocol::v1::schema::{ContentBlock, StopReason};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use futures_util::future::BoxFuture;
use std::sync::atomic::{AtomicUsize, Ordering};

struct UnusedQueueDispatcher;

impl QueueRuntimeDispatcher for UnusedQueueDispatcher {
    fn read_snapshot<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> BoxFuture<'a, Result<QueueRuntimeSnapshot, String>> {
        Box::pin(async { Err("unused".to_string()) })
    }

    fn supports_steer(&self, _thread_id: &str) -> Result<bool, String> {
        Ok(false)
    }

    fn prepare_steer<'a>(&'a self, _thread_id: &'a str) -> BoxFuture<'a, Result<u64, String>> {
        Box::pin(async { Err("unused".to_string()) })
    }

    fn verify_steer_epoch<'a>(
        &'a self,
        _thread_id: &'a str,
        _epoch: u64,
    ) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async { Err("unused".to_string()) })
    }

    fn steer<'a>(
        &'a self,
        _thread_id: &'a str,
        _expected_run_id: String,
        _expected_source_turn_id: String,
        _prompt_generation: u64,
        _interaction_epoch: u64,
        _prompt: Vec<ContentBlock>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Err("unused".to_string()) })
    }

    fn turn_start<'a>(
        &'a self,
        _thread_id: &'a str,
        _turn_start: &'a Value,
        _source_turn_id: &'a str,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async { Err("unused".to_string()) })
    }
}

fn approval_requested(request_id: &str) -> CanonicalEvent {
    CanonicalEvent::PermissionRequested {
        approval: PendingApproval {
            request_id: request_id.to_string(),
            agent_id: "agent".to_string(),
            kind: "fileChange".to_string(),
            thread_id: "thread".to_string(),
            turn_id: "turn".to_string(),
            item_id: "tool".to_string(),
            title: "Permission".to_string(),
            message: "Permission".to_string(),
            requested_at: "2026-07-20T00:00:00Z".to_string(),
            reason: None,
            command: None,
            cwd: None,
            grant_root: None,
            proposed_execpolicy_amendment: None,
            options: vec![],
        },
    }
}

fn run_finished(source_turn_id: &str) -> CanonicalEvent {
    CanonicalEvent::RunFinished {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: "run".to_string(),
        source_turn_id: source_turn_id.to_string(),
        generation: 1,
        stop_reason: StopReason::EndTurn,
    }
}

fn run_started(source_turn_id: &str) -> CanonicalEvent {
    CanonicalEvent::RunStarted {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: "run".to_string(),
        source_turn_id: source_turn_id.to_string(),
        generation: 1,
    }
}

async fn next_push_candidate(receiver: &mut ClientOutboxReceiver) -> u64 {
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let Message::Text(text) = receiver.recv().await.expect("candidate message") else {
                continue;
            };
            let payload: Value = serde_json::from_str(&text).unwrap();
            if payload["method"] == "bridge/push/candidate" {
                break payload["params"]["candidateId"]
                    .as_str()
                    .map(|value| value.parse::<u64>())
                    .and_then(Result::ok)
                    .expect("candidate id");
            }
        }
    })
    .await
    .expect("candidate notification timeout")
}

async fn retrying_push_fixture(State(attempts): State<Arc<AtomicUsize>>) -> Response {
    if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            [("retry-after", "0")],
            Json(json!({"error": "retry"})),
        )
            .into_response();
    }
    Json(json!({"data": [{"status": "ok"}]})).into_response()
}

async fn rate_limited_push_fixture(State(attempts): State<Arc<AtomicUsize>>) -> Response {
    attempts.fetch_add(1, Ordering::SeqCst);
    (
        StatusCode::TOO_MANY_REQUESTS,
        [("retry-after", "0")],
        Json(json!({"error": "limited"})),
    )
        .into_response()
}

#[tokio::test]
async fn delayed_receipt_checks_keep_the_worker_non_retireable() {
    let directory =
        std::env::temp_dir().join(format!("dappercode-push-receipt-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let service = PushService::load(
        &directory,
        "project".to_string(),
        Arc::new(OperationalMetrics::new()),
    )
    .await;
    assert_eq!(service.pending_receipt_check_count(), 0);
    service.spawn_receipt_check(Vec::new());
    assert_eq!(service.pending_receipt_check_count(), 0);
    service.spawn_receipt_check(vec![("receipt".to_string(), "token".to_string())]);
    assert_eq!(service.pending_receipt_check_count(), 1);
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn completion_pushes_only_follow_the_final_queue_disposition() {
    assert!(completion_is_final(QueueCompletionDisposition::Final));
    assert!(!completion_is_final(QueueCompletionDisposition::Continued));
}

#[tokio::test]
async fn canonical_reply_previews_evict_at_capacity_and_restart_evicted_threads() {
    let directory =
        std::env::temp_dir().join(format!("dappercode-push-eviction-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let service = PushService::load(
        &directory,
        "project".to_string(),
        Arc::new(OperationalMetrics::new()),
    )
    .await;
    let full_preview = "x".repeat(PUSH_PREVIEW_ACCUMULATE_CAP);
    for index in 0..PUSH_PREVIEW_MAX_THREADS {
        service
            .accumulate_canonical_reply(&format!("old-{index}"), &full_preview)
            .await;
    }
    service.accumulate_canonical_reply("old-0", "ignored").await;
    assert_eq!(service.recent_replies.read().await["old-0"], full_preview);
    assert_eq!(
        service.recent_replies.read().await.len(),
        PUSH_PREVIEW_MAX_THREADS,
    );

    service.accumulate_canonical_reply("new", "new reply").await;
    let evicted_thread = {
        let replies = service.recent_replies.read().await;
        assert_eq!(replies.len(), PUSH_PREVIEW_MAX_THREADS);
        assert_eq!(replies["new"], "new reply");
        // Any saturated preview may be evicted; HashMap order is unspecified.
        let mut evicted_threads = (0..PUSH_PREVIEW_MAX_THREADS)
            .map(|index| format!("old-{index}"))
            .filter(|thread_id| !replies.contains_key(thread_id))
            .collect::<Vec<_>>();
        assert_eq!(evicted_threads.len(), 1);
        evicted_threads.pop().unwrap()
    };
    service
        .accumulate_canonical_reply(&evicted_thread, "ignored")
        .await;
    assert_eq!(
        service.recent_replies.read().await[&evicted_thread],
        "ignored",
    );
    assert_eq!(
        service.recent_replies.read().await.len(),
        PUSH_PREVIEW_MAX_THREADS,
    );

    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn canonical_reply_previews_are_bounded_and_terminal_events_consume_them() {
    let directory =
        std::env::temp_dir().join(format!("dappercode-push-preview-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let service = PushService::load(
        &directory,
        "project".to_string(),
        Arc::new(OperationalMetrics::new()),
    )
    .await;
    let delivery_hub = ClientHub::new();

    service.accumulate_canonical_reply("empty", "").await;
    assert!(!service.recent_replies.read().await.contains_key("empty"));
    service
        .accumulate_canonical_reply("full", &"x".repeat(PUSH_PREVIEW_ACCUMULATE_CAP + 1))
        .await;
    service.accumulate_canonical_reply("full", "ignored").await;
    assert_eq!(
        service.recent_replies.read().await["full"].len(),
        PUSH_PREVIEW_ACCUMULATE_CAP,
    );
    service
        .accumulate_canonical_reply("new", "first\n final   answer ")
        .await;
    assert_eq!(
        service.take_reply_preview("new").await.as_deref(),
        Some("final answer"),
    );
    assert!(service.take_reply_preview("missing").await.is_none());
    service.accumulate_canonical_reply("blank", " \n\t ").await;
    assert!(service.take_reply_preview("blank").await.is_none());
    service
        .send_canonical_push_to_endpoint(
            "http://127.0.0.1:1/not-used",
            PushEvent::TurnCompleted,
            None,
            None,
            None,
            false,
        )
        .await;

    let hub = Arc::new(ClientHub::new());
    let event_loop = service.spawn_event_loop_with_queue(&hub, None);
    hub.broadcast_canonical_event(&CanonicalEvent::MessageChunk {
        agent_id: "agent".to_string(),
        thread_id: "loop-thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        role: MessageRole::Agent,
        message_id: "loop-message".to_string(),
        content: "loop reply".to_string(),
        content_block: None,
    })
    .await;
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            if service
                .recent_replies
                .read()
                .await
                .contains_key("loop-thread")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(hub);
    tokio::time::timeout(std::time::Duration::from_secs(1), event_loop)
        .await
        .expect("push event loop should close with the hub")
        .unwrap();

    service
        .handle_canonical_event(
            CanonicalHubEvent {
                event_id: 1,
                event: CanonicalEvent::MessageChunk {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    run_id: Some("run".to_string()),
                    source_turn_id: Some("turn".to_string()),
                    generation: Some(1),
                    role: MessageRole::Agent,
                    message_id: "message".to_string(),
                    content: "completed".to_string(),
                    content_block: None,
                },
                foreground_mobile_present: false,
            },
            None,
            &delivery_hub,
        )
        .await;
    assert!(service.recent_replies.read().await.contains_key("thread"));
    service
        .handle_canonical_event(
            CanonicalHubEvent {
                event_id: 2,
                event: CanonicalEvent::RunFinished {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    run_id: "run".to_string(),
                    source_turn_id: "turn".to_string(),
                    generation: 1,
                    stop_reason: StopReason::EndTurn,
                },
                foreground_mobile_present: false,
            },
            None,
            &delivery_hub,
        )
        .await;
    assert!(!service.recent_replies.read().await.contains_key("thread"));

    let queue =
        BridgeQueueService::new(Arc::new(UnusedQueueDispatcher), Arc::new(ClientHub::new()));
    for (event_id, disposition) in [
        (3, QueueCompletionDisposition::Continued),
        (4, QueueCompletionDisposition::Final),
    ] {
        service
            .accumulate_canonical_reply("settled", "answer")
            .await;
        queue
            .record_completion_disposition(event_id, disposition)
            .await;
        service
            .handle_canonical_event(
                CanonicalHubEvent {
                    event_id,
                    event: CanonicalEvent::RunFinished {
                        agent_id: "agent".to_string(),
                        thread_id: "settled".to_string(),
                        run_id: "run".to_string(),
                        source_turn_id: "turn".to_string(),
                        generation: 1,
                        stop_reason: StopReason::EndTurn,
                    },
                    foreground_mobile_present: false,
                },
                Some(&queue),
                &delivery_hub,
            )
            .await;
    }

    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn observed_foreground_events_suppress_all_registered_devices() {
    let delivered_targets = Arc::new(AtomicUsize::new(0));
    let captured_targets = Arc::clone(&delivered_targets);
    let app = Router::new().route(
        "/push",
        post(move |Json(payload): Json<Value>| {
            let captured_targets = Arc::clone(&captured_targets);
            async move {
                captured_targets
                    .fetch_add(payload.as_array().map_or(0, Vec::len), Ordering::SeqCst);
                Json(json!({ "data": [] }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}/push", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let directory =
        std::env::temp_dir().join(format!("dappercode-push-presence-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let service = PushService::load(
        &directory,
        "project".to_string(),
        Arc::new(OperationalMetrics::new()),
    )
    .await;
    for (profile, registration, token) in [
        ("profile-a", "registration-a", "token-a"),
        ("profile-b", "registration-b", "token-b"),
    ] {
        service
            .register(
                profile.to_string(),
                registration.to_string(),
                token.to_string(),
                "ios".to_string(),
                "Phone".to_string(),
                PushEventPreferences::default(),
            )
            .await
            .unwrap();
    }

    service
        .send_canonical_push_to_endpoint(
            &endpoint,
            PushEvent::TurnCompleted,
            Some("thread".to_string()),
            None,
            Some("Finished".to_string()),
            false,
        )
        .await;
    assert_eq!(delivered_targets.load(Ordering::SeqCst), 2);
    service
        .send_canonical_push_to_endpoint(
            &endpoint,
            PushEvent::ApprovalRequested,
            Some("thread".to_string()),
            Some("approval".to_string()),
            None,
            true,
        )
        .await;
    assert_eq!(delivered_targets.load(Ordering::SeqCst), 2);
    service
        .send_canonical_push_to_endpoint(
            &endpoint,
            PushEvent::TurnCompleted,
            Some("thread".to_string()),
            None,
            Some("Finished".to_string()),
            true,
        )
        .await;
    assert_eq!(delivered_targets.load(Ordering::SeqCst), 2);
    service
        .send_canonical_push_to_endpoint(
            &endpoint,
            PushEvent::ApprovalRequested,
            Some("thread".to_string()),
            Some("approval".to_string()),
            None,
            false,
        )
        .await;
    assert_eq!(delivered_targets.load(Ordering::SeqCst), 4);

    server.abort();
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn observation_proof_suppresses_but_stale_presence_fails_open() {
    let delivered_targets = Arc::new(AtomicUsize::new(0));
    let captured_targets = Arc::clone(&delivered_targets);
    let app = Router::new().route(
        "/push",
        post(move |Json(payload): Json<Value>| {
            let captured_targets = Arc::clone(&captured_targets);
            async move {
                captured_targets
                    .fetch_add(payload.as_array().map_or(0, Vec::len), Ordering::SeqCst);
                Json(json!({ "data": [] }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}/push", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let directory =
        std::env::temp_dir().join(format!("dappercode-push-observed-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let service = PushService::load(
        &directory,
        "project".to_string(),
        Arc::new(OperationalMetrics::new()),
    )
    .await;
    service
        .register(
            "profile".to_string(),
            "registration".to_string(),
            "token".to_string(),
            "ios".to_string(),
            "Phone".to_string(),
            PushEventPreferences::default(),
        )
        .await
        .unwrap();
    service
        .register(
            "second-profile".to_string(),
            "second-registration".to_string(),
            "second-token".to_string(),
            "android".to_string(),
            "Second phone".to_string(),
            PushEventPreferences::default(),
        )
        .await
        .unwrap();

    let hub = Arc::new(ClientHub::new());
    let mut canonical_events = hub.subscribe_canonical_events();
    let (sender, mut messages) = client_outbox(16);
    let mobile = hub
        .add_client_with_metadata(
            sender,
            ClientConnectionMetadata {
                client_type: MOBILE_CLIENT_TYPE.to_string(),
                client_name: "Phone".to_string(),
                foreground: true,
            },
        )
        .await;
    let (background_sender, _background_messages) = client_outbox(16);
    let background_mobile = hub
        .add_client_with_metadata(
            background_sender,
            ClientConnectionMetadata {
                client_type: MOBILE_CLIENT_TYPE.to_string(),
                client_name: "Background phone".to_string(),
                foreground: false,
            },
        )
        .await;

    hub.broadcast_canonical_event(&approval_requested("observed"))
        .await;
    let observed_event = canonical_events.recv().await.unwrap();
    let observed_candidate = next_push_candidate(&mut messages).await;
    assert_eq!(observed_candidate, observed_event.event_id);
    let observed_delivery = {
        let service = Arc::clone(&service);
        let hub = Arc::clone(&hub);
        let endpoint = endpoint.clone();
        tokio::spawn(async move {
            service
                .handle_canonical_event_to_endpoint(&endpoint, observed_event, None, &hub)
                .await;
        })
    };
    tokio::task::yield_now().await;
    assert_eq!(
        hub.observe_push_candidate(background_mobile, observed_candidate, 0)
            .await,
        PushObservationUpdate::NotForeground,
    );
    assert_eq!(
        hub.observe_push_candidate(mobile, observed_candidate, 0)
            .await,
        PushObservationUpdate::Observed,
    );
    observed_delivery.await.unwrap();
    assert_eq!(delivered_targets.load(Ordering::SeqCst), 0);

    assert_eq!(
        hub.set_mobile_client_foreground(mobile, false, 1).await,
        MobilePresenceUpdate::Applied,
    );
    hub.broadcast_canonical_event(&approval_requested("background"))
        .await;
    let background_event = canonical_events.recv().await.unwrap();
    let background_candidate = next_push_candidate(&mut messages).await;
    assert_eq!(background_candidate, background_event.event_id);
    service
        .handle_canonical_event_to_endpoint(&endpoint, background_event, None, &hub)
        .await;
    assert_eq!(delivered_targets.load(Ordering::SeqCst), 2);

    assert_eq!(
        hub.set_mobile_client_foreground(mobile, true, 2).await,
        MobilePresenceUpdate::Applied,
    );
    hub.broadcast_canonical_event(&approval_requested("stale"))
        .await;
    let stale_event = canonical_events.recv().await.unwrap();
    let stale_candidate = next_push_candidate(&mut messages).await;
    assert_eq!(stale_candidate, stale_event.event_id);
    service
        .handle_canonical_event_to_endpoint(&endpoint, stale_event, None, &hub)
        .await;
    assert_eq!(delivered_targets.load(Ordering::SeqCst), 4);

    let queue = Arc::new(BridgeQueueService::new(
        Arc::new(UnusedQueueDispatcher),
        Arc::new(ClientHub::new()),
    ));
    hub.broadcast_canonical_event(&run_started("final")).await;
    canonical_events.recv().await.unwrap();
    while messages.try_recv().is_ok() {}
    hub.broadcast_canonical_event(&run_finished("final")).await;
    let final_event = canonical_events.recv().await.unwrap();
    let final_candidate = next_push_candidate(&mut messages).await;
    let final_event_id = final_event.event_id;
    let final_delivery = {
        let service = Arc::clone(&service);
        let hub = Arc::clone(&hub);
        let queue = Arc::clone(&queue);
        let endpoint = endpoint.clone();
        tokio::spawn(async move {
            service
                .handle_canonical_event_to_endpoint(
                    &endpoint,
                    final_event,
                    Some(queue.as_ref()),
                    &hub,
                )
                .await;
        })
    };
    tokio::task::yield_now().await;
    assert_eq!(
        hub.observe_push_candidate(mobile, final_candidate, 2).await,
        PushObservationUpdate::Observed,
    );
    queue
        .record_completion_disposition(final_event_id, QueueCompletionDisposition::Final)
        .await;
    final_delivery.await.unwrap();
    assert_eq!(delivered_targets.load(Ordering::SeqCst), 4);

    hub.broadcast_canonical_event(&run_started("continued"))
        .await;
    canonical_events.recv().await.unwrap();
    while messages.try_recv().is_ok() {}
    hub.broadcast_canonical_event(&run_finished("continued"))
        .await;
    let continued_event = canonical_events.recv().await.unwrap();
    let continued_candidate = next_push_candidate(&mut messages).await;
    queue
        .record_completion_disposition(
            continued_event.event_id,
            QueueCompletionDisposition::Continued,
        )
        .await;
    service
        .handle_canonical_event_to_endpoint(&endpoint, continued_event, Some(queue.as_ref()), &hub)
        .await;
    assert_eq!(delivered_targets.load(Ordering::SeqCst), 4);
    assert!(
        !hub.take_push_observation(continued_candidate, Duration::ZERO)
            .await,
    );

    server.abort();
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn push_transport_handles_ticket_outcomes_retries_and_malformed_responses() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let blocked_entered = Arc::new(tokio::sync::Notify::new());
    let blocked_release = Arc::new(tokio::sync::Notify::new());
    let entered_handler = blocked_entered.clone();
    let release_handler = blocked_release.clone();
    let app = Router::new()
        .route(
            "/blocked",
            post(move || {
                let entered = entered_handler.clone();
                let release = release_handler.clone();
                async move {
                    entered.notify_one();
                    release.notified().await;
                    Json(json!({"data": [{"status": "ok"}]}))
                }
            }),
        )
        .route(
            "/tickets",
            post(|| async {
                Json(json!({
                    "data": [
                        {"status": "ok", "id": "receipt"},
                        {
                            "status": "error",
                            "details": {"error": "DeviceNotRegistered"}
                        },
                        {"status": "error", "details": {"error": "Other"}},
                        {"status": "unknown"}
                    ]
                }))
            }),
        )
        .route(
            "/partial",
            post(|| async { Json(json!({"data": [{"status": "ok"}]})) }),
        )
        .route("/nodata", post(|| async { Json(json!({"ok": true})) }))
        .route(
            "/extra",
            post(|| async {
                Json(json!({
                    "data": [{"status": "ok"}, {"status": "ok"}]
                }))
            }),
        )
        .route(
            "/receipts",
            post(|| async {
                Json(json!({
                    "data": {
                        "receipt-ok": {"status": "ok"},
                        "receipt-stale": {
                            "status": "error",
                            "details": {"error": "DeviceNotRegistered"}
                        },
                        "receipt-other": {
                            "status": "error",
                            "details": {"error": "Other"}
                        },
                        "receipt-missing": {
                            "status": "error",
                            "details": {"error": "DeviceNotRegistered"}
                        }
                    }
                }))
            }),
        )
        .route(
            "/receipt-nodata",
            post(|| async { Json(json!({"data": []})) }),
        )
        .route("/invalid", post(|| async { "not json" }))
        .route("/retry", post(retrying_push_fixture))
        .route("/limited", post(rate_limited_push_fixture))
        .with_state(attempts.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let directory =
        std::env::temp_dir().join(format!("dappercode-push-http-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let service = PushService::load(
        &directory,
        "project".to_string(),
        Arc::new(OperationalMetrics::new()),
    )
    .await;
    service
        .register(
            "profile".to_string(),
            "turn-registration".to_string(),
            "turn-token".to_string(),
            "ios".to_string(),
            "Phone".to_string(),
            PushEventPreferences {
                turn_completed: true,
                approval_requested: false,
            },
        )
        .await
        .unwrap();
    service
        .register(
            "profile".to_string(),
            "approval-registration".to_string(),
            "approval-token".to_string(),
            "ios".to_string(),
            "Phone".to_string(),
            PushEventPreferences {
                turn_completed: false,
                approval_requested: true,
            },
        )
        .await
        .unwrap();
    let blocked_send = tokio::spawn({
        let service = service.clone();
        let endpoint = format!("{base}/blocked");
        async move {
            service
                .send_to_endpoint(
                    &endpoint,
                    "title",
                    "body",
                    &json!({}),
                    None,
                    vec![(
                        "blocked".to_string(),
                        "profile".to_string(),
                        "blocked".to_string(),
                    )],
                )
                .await;
        }
    });
    blocked_entered.notified().await;
    assert_eq!(service.pending_delivery_count(), 1);
    blocked_release.notify_one();
    blocked_send.await.unwrap();
    assert_eq!(service.pending_delivery_count(), 0);
    let targets = (0..4)
        .map(|index| {
            (
                format!("token-{index}"),
                "profile".to_string(),
                format!("registration-{index}"),
            )
        })
        .collect();
    service
        .send_to_endpoint(
            &format!("{base}/tickets"),
            "title",
            "body",
            &json!({"kind": "test"}),
            Some("approval"),
            targets,
        )
        .await;
    service
        .send_canonical_push_to_endpoint(
            &format!("{base}/partial"),
            PushEvent::TurnCompleted,
            Some("thread".to_string()),
            None,
            Some("reply".to_string()),
            false,
        )
        .await;
    service
        .send_canonical_push_to_endpoint(
            &format!("{base}/partial"),
            PushEvent::TurnCompleted,
            Some("thread".to_string()),
            None,
            None,
            false,
        )
        .await;
    service
        .send_canonical_push_to_endpoint(
            &format!("{base}/partial"),
            PushEvent::ApprovalRequested,
            Some("thread".to_string()),
            Some("approval".to_string()),
            None,
            false,
        )
        .await;
    service
        .send_to_endpoint(
            &format!("{base}/nodata"),
            "title",
            "body",
            &json!({}),
            None,
            vec![(
                "nodata".to_string(),
                "profile".to_string(),
                "nodata".to_string(),
            )],
        )
        .await;
    service
        .send_to_endpoint(
            &format!("{base}/extra"),
            "title",
            "body",
            &json!({}),
            None,
            vec![(
                "extra".to_string(),
                "profile".to_string(),
                "extra".to_string(),
            )],
        )
        .await;
    assert_eq!(service.pending_receipt_check_count(), 1);

    service
        .send_to_endpoint(
            &format!("{base}/partial"),
            "title",
            "body",
            &json!({}),
            None,
            vec![
                ("one".to_string(), "profile".to_string(), "one".to_string()),
                ("two".to_string(), "profile".to_string(), "two".to_string()),
            ],
        )
        .await;
    service
        .send_to_endpoint(
            &format!("{base}/invalid"),
            "title",
            "body",
            &json!({}),
            None,
            vec![(
                "invalid".to_string(),
                "profile".to_string(),
                "invalid".to_string(),
            )],
        )
        .await;

    attempts.store(0, Ordering::SeqCst);
    assert!(service
        .post_with_retry(&format!("{base}/retry"), &json!({}))
        .await
        .is_some());
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    attempts.store(0, Ordering::SeqCst);
    assert!(service
        .post_with_retry(&format!("{base}/limited"), &json!({}))
        .await
        .is_none());
    assert_eq!(
        attempts.load(Ordering::SeqCst),
        PUSH_SEND_MAX_ATTEMPTS as usize,
    );
    assert!(service
        .post_with_retry("http://127.0.0.1:1/unreachable", &json!({}))
        .await
        .is_none());
    service
        .check_receipts_from_endpoint(
            &format!("{base}/receipts"),
            vec![
                ("receipt-ok".to_string(), "ok".to_string()),
                ("receipt-stale".to_string(), "stale".to_string()),
                ("receipt-other".to_string(), "other".to_string()),
            ],
        )
        .await;
    service
        .check_receipts_from_endpoint(
            &format!("{base}/receipt-nodata"),
            vec![("receipt".to_string(), "token".to_string())],
        )
        .await;
    service
        .check_receipts_from_endpoint(
            "http://127.0.0.1:1/unreachable",
            vec![("receipt".to_string(), "token".to_string())],
        )
        .await;

    let authenticated = Arc::new(PushService {
        registry: PushRegistryStore::load(&directory).await,
        project_label: "project".to_string(),
        http: crate::tls::http_client(),
        access_token: Some("access".to_string()),
        recent_replies: RwLock::new(HashMap::new()),
        metrics: Arc::new(OperationalMetrics::new()),
        active_deliveries: AtomicU64::new(0),
        pending_receipt_checks: AtomicU64::new(0),
    });
    assert!(authenticated
        .post_with_retry(&format!("{base}/partial"), &json!({}))
        .await
        .is_some());

    server.abort();
    let _ = server.await;
    let _ = std::fs::remove_dir_all(directory);
}
