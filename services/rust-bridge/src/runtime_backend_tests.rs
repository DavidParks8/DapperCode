use super::{
    approval_policy, bounded_page_limit, child_matches_tool_title, discovery_key, json, now_iso,
    parent_subagent_snapshot_envelope, process_event_side_effects, pump_canonical_events,
    reject_client_agent_message_envelope, select_spawned_child, session_to_thread_value,
    AgentManager, ApprovalPolicy, Arc, BoxFuture, BridgeQueueService, BridgeQueuedMessageEntry,
    BridgeThreadQueueDisposition, BridgeThreadQueueRuntime, BridgeThreadQueueSendResponse,
    CancellationToken, ClientConnectionMetadata, ClientHub, ClientRequestOwner,
    ClientRequestTracker, ContentBlock, HarnessChildSession, HashSet, ManagedSession, Mutex,
    Ordering, QueueRuntimeDispatcher, QueueRuntimeSnapshot, RequestCancellation,
    RetirementPlanReconciliation, RetirementSessionReconciler, StdMutex, SubagentDiscoveryState,
    ThreadStateRetirement, ThreadStateRetirementTransaction, Utc, Value, MAX_PAGE_SIZE,
    MAX_SNAPSHOT_PAGE_SIZE, MAX_TRACKED_CLIENT_REQUESTS, THREAD_RETIREMENT_STARTUP_MAX_ATTEMPTS,
};
use crate::acp::events::{canonical_event_channel, CanonicalEvent, MessageRole};
use agent_client_protocol::v1::schema::{ToolCallStatus, ToolKind};
use std::path::PathBuf;
use tokio::sync::{oneshot, Notify, Semaphore};
use tokio::time::{timeout, Duration};

pub(crate) async fn process_event_side_effects_for_test(
    manager: &Arc<AgentManager>,
    hub: &Arc<ClientHub>,
    events: &[CanonicalEvent],
) {
    let discoveries = Arc::new(StdMutex::new(SubagentDiscoveryState::default()));
    for event in events {
        process_event_side_effects(manager, hub, &discoveries, event).await;
    }
}

#[test]
fn page_limits_are_bounded_before_platform_conversion() {
    for maximum in [MAX_PAGE_SIZE, MAX_SNAPSHOT_PAGE_SIZE] {
        assert_eq!(bounded_page_limit(&json!({}), maximum), 50);
        assert_eq!(bounded_page_limit(&json!({ "limit": 0 }), maximum), 0);
        assert_eq!(bounded_page_limit(&json!({ "limit": 42 }), maximum), 42);
        assert_eq!(
            bounded_page_limit(&json!({ "limit": u64::from(u32::MAX) + 1 }), maximum),
            maximum,
        );
        assert_eq!(
            bounded_page_limit(&json!({ "limit": u64::MAX }), maximum),
            maximum,
        );
        assert_eq!(
            bounded_page_limit(&json!({ "limit": "invalid" }), maximum),
            50,
        );
    }
}

struct RetirementDispatcher;

impl QueueRuntimeDispatcher for RetirementDispatcher {
    fn read_snapshot<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxFuture<'a, Result<QueueRuntimeSnapshot, String>> {
        let snapshot =
            crate::acp::snapshot::SessionSnapshot::new("agent".to_string(), thread_id.into());
        Box::pin(async move {
            Ok(QueueRuntimeSnapshot {
                session: snapshot,
                pending_approval_ids: HashSet::new(),
                pending_user_input_ids: HashSet::new(),
            })
        })
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
        Box::pin(async { Ok(false) })
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

fn retirement_test_directory(name: &str) -> PathBuf {
    let directory = std::env::current_dir()
        .expect("current directory")
        .join("target")
        .join(format!("{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).expect("create retirement test directory");
    directory
}

fn retirement_test_thread(name: &str) -> String {
    crate::acp::identity::AgentSessionId::new("agent", name)
        .expect("valid test thread ID")
        .encode()
}

async fn seeded_durable_retirement_services(
    directory: &std::path::Path,
    thread_id: &str,
) -> (
    Arc<BridgeQueueService>,
    Arc<crate::scheduled_prompts::ScheduledPromptService>,
    Arc<crate::retirement_journal::ThreadRetirementJournal>,
) {
    let hub = Arc::new(ClientHub::new());
    let receipt_path = directory.join("queue-idempotency.json");
    let queue = BridgeQueueService::with_submission_store(
        Arc::new(RetirementDispatcher),
        hub.clone(),
        Some(receipt_path),
        crate::queue_service::DurableQueueSubmissions::default(),
    );
    queue
        .remember_submission_result(BridgeThreadQueueSendResponse {
            submission_id: "sent-before-delete".to_string(),
            disposition: BridgeThreadQueueDisposition::Sent,
            queue: BridgeQueueService::snapshot_for_thread(thread_id, None),
            turn_id: Some("turn-before-delete".to_string()),
        })
        .await
        .expect("seed durable queue receipt");
    let scheduler = crate::scheduled_prompts::ScheduledPromptService::start_paused(
        directory.join("scheduled-prompts.json"),
        Arc::downgrade(&queue),
        hub,
    )
    .await
    .expect("start paused scheduler");
    scheduler
        .schedule(
            thread_id,
            "survives until ACP deletion succeeds".to_string(),
            &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        )
        .await
        .expect("seed durable schedule");
    let journal = Arc::new(
        crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json"),
        )
        .await
        .expect("load retirement journal"),
    );
    (queue, scheduler, journal)
}

async fn reload_retirement_services(
    directory: &std::path::Path,
) -> (
    Arc<BridgeQueueService>,
    Arc<crate::scheduled_prompts::ScheduledPromptService>,
    Arc<crate::retirement_journal::ThreadRetirementJournal>,
) {
    let hub = Arc::new(ClientHub::new());
    let receipt_path = directory.join("queue-idempotency.json");
    let submissions = BridgeQueueService::load_submission_store(&receipt_path)
        .await
        .expect("reload queue idempotency state");
    let queue = BridgeQueueService::with_submission_store(
        Arc::new(RetirementDispatcher),
        hub.clone(),
        Some(receipt_path),
        submissions,
    );
    let scheduler = crate::scheduled_prompts::ScheduledPromptService::start_paused(
        directory.join("scheduled-prompts.json"),
        Arc::downgrade(&queue),
        hub,
    )
    .await
    .expect("reload paused scheduler");
    let journal = Arc::new(
        crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json"),
        )
        .await
        .expect("reload retirement journal"),
    );
    (queue, scheduler, journal)
}

struct FixedRetirementReconciler {
    result: RetirementPlanReconciliation,
    expanded: Option<Vec<String>>,
    finalized: StdMutex<Vec<Vec<String>>>,
}

impl FixedRetirementReconciler {
    fn new(result: RetirementPlanReconciliation) -> Self {
        Self {
            result,
            expanded: None,
            finalized: StdMutex::new(Vec::new()),
        }
    }

    fn with_expanded(mut self, expanded: Vec<String>) -> Self {
        self.expanded = Some(expanded);
        self
    }

    fn finalized(&self) -> Vec<Vec<String>> {
        self.finalized
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

impl RetirementSessionReconciler for FixedRetirementReconciler {
    fn reconcile_retirement_plan<'a>(
        &'a self,
        _thread_ids: &'a [String],
    ) -> BoxFuture<'a, RetirementPlanReconciliation> {
        Box::pin(async move { self.result })
    }

    fn expand_absent_retirement_family<'a>(
        &'a self,
        thread_ids: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<String>, String>> {
        Box::pin(async move { Ok(self.expanded.clone().unwrap_or_else(|| thread_ids.to_vec())) })
    }

    fn finalize_confirmed_deleted_sessions<'a>(
        &'a self,
        thread_ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.finalized
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(thread_ids.to_vec());
            Ok(())
        })
    }
}

#[test]
fn client_turn_start_rejects_reserved_agent_message_envelopes() {
    let envelope = crate::agent_messaging::AgentMessageEnvelope::new(
        "message-1".to_string(),
        "parent".to_string(),
        "child".to_string(),
        crate::agent_messaging::AgentRelationKind::SubAgent,
        Some("Parent".to_string()),
        "Inspect the queue.".to_string(),
    )
    .encode()
    .expect("agent-message envelope");
    let split_at = envelope
        .find(r#","senderThreadId""#)
        .expect("encoded sender field");

    for params in [
        json!({"input": [{"type": "text", "text": envelope.clone(), "text_elements": []}]}),
        json!({
            "input": [
                {"type": "text", "text": &envelope[..split_at], "text_elements": []},
                {"type": "text", "text": &envelope[split_at..], "text_elements": []},
            ]
        }),
    ] {
        assert_eq!(
            reject_client_agent_message_envelope("turn/start", Some(&params)),
            Err("agent message envelopes are reserved for the bridge".to_string()),
        );
    }
    assert!(reject_client_agent_message_envelope(
        "turn/start",
        Some(&json!({
            "input": [{"type": "text", "text": "ordinary user prompt", "text_elements": []}]
        })),
    )
    .is_ok());
    assert!(reject_client_agent_message_envelope(
        "bridge/thread/queue/send",
        Some(&json!({"input": []})),
    )
    .is_ok());
}

#[tokio::test]
async fn canonical_event_pump_keeps_draining_while_side_effects_are_backlogged() {
    let (sender, events) = canonical_event_channel(4);
    let hub = Arc::new(ClientHub::new());
    let mut subscriber = hub.subscribe_canonical_events();
    let (side_effects_tx, mut side_effects_rx) = tokio::sync::mpsc::unbounded_channel();
    let pump = tokio::spawn(pump_canonical_events(events, hub.clone(), side_effects_tx));

    sender
        .send(CanonicalEvent::RunStarted {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: "run".to_string(),
            source_turn_id: "turn".to_string(),
            generation: 1,
        })
        .await
        .expect("run event");
    sender
        .send(CanonicalEvent::MessageChunk {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: Some("run".to_string()),
            source_turn_id: Some("turn".to_string()),
            generation: Some(1),
            role: MessageRole::Agent,
            message_id: "message".to_string(),
            content: "continued".to_string(),
            content_block: None,
        })
        .await
        .expect("message event");

    let first = timeout(Duration::from_millis(100), subscriber.recv())
        .await
        .expect("first event broadcast")
        .expect("first event");
    let second = timeout(Duration::from_millis(100), subscriber.recv())
        .await
        .expect("second event broadcast")
        .expect("second event");
    assert!(matches!(first.event, CanonicalEvent::RunStarted { .. }));
    assert!(matches!(second.event, CanonicalEvent::MessageChunk { .. }));
    assert!(matches!(
        side_effects_rx.try_recv(),
        Ok(CanonicalEvent::RunStarted { .. })
    ));
    assert!(side_effects_rx.try_recv().is_err());

    drop(sender);
    pump.await.expect("event pump");
}

/// Several sub-agents at once are told apart by the description their child session is
/// named after; the placeholder title every task tool starts with names none of them.
#[test]
fn child_titles_are_matched_to_the_task_they_were_spawned_for() {
    assert!(child_matches_tool_title(
        Some("Read txt files, write report (@general subagent)"),
        "Read txt files, write report",
    ));
    assert!(!child_matches_tool_title(
        Some("Audit dependencies (@general subagent)"),
        "Read txt files, write report",
    ));
    assert!(!child_matches_tool_title(
        Some("Read txt files, write report (@general subagent)"),
        "task",
    ));
    assert!(!child_matches_tool_title(None, "Read txt files"));
    assert!(!child_matches_tool_title(Some("anything"), "   "));
}

#[test]
fn session_threads_emit_the_current_subagent_source_shape() {
    let value = session_to_thread_value(ManagedSession {
        thread_id: "child-thread".to_string(),
        agent_id: "alpha-agent".to_string(),
        cwd: PathBuf::from("/tmp"),
        parent_thread_id: Some("parent-thread".to_string()),
        snapshot: crate::acp::snapshot::SessionSnapshot::new(
            "alpha-agent".to_string(),
            "child-thread".to_string(),
        ),
    })
    .expect("thread response");

    assert_eq!(
        value["source"],
        json!({
            "subAgent": {
                "thread_spawn": {
                    "parentThreadId": "parent-thread",
                    "depth": 1,
                },
            },
        }),
    );
}

#[test]
fn parses_all_three_approval_policies_conservatively() {
    assert_eq!(
        approval_policy(&json!({ "approvalPolicy": "never" })),
        ApprovalPolicy::Never,
    );
    assert_eq!(
        approval_policy(&json!({ "approvalPolicy": "on-request" })),
        ApprovalPolicy::OnRequest,
    );
    assert_eq!(
        approval_policy(&json!({ "approvalPolicy": "untrusted" })),
        ApprovalPolicy::Untrusted,
    );
    assert_eq!(approval_policy(&json!({})), ApprovalPolicy::Untrusted);
    assert_eq!(
        approval_policy(&json!({ "approvalPolicy": "invalid" })),
        ApprovalPolicy::Untrusted,
    );
}

/// A sub-agent has to be found while it is still running, because that is the only thing that
/// makes its card openable before the task tool finishes. A parent that already owns other
/// unclaimed children must not defeat that.
#[test]
fn a_child_that_appears_after_polling_started_is_the_one_the_tool_spawned() {
    let child = |id: &str, title: Option<&str>| {
        (
            HarnessChildSession {
                title: title.map(str::to_string),
                acp_session_id: id.to_string(),
            },
            format!("thread-{id}"),
        )
    };
    let existing = child("old", Some("Earlier errand (@general subagent)"));
    let spawned = child("new", None);

    // Nothing has appeared yet, so the single-candidate rule still resolves the sub-agent.
    let baseline = HashSet::new();
    let candidates = vec![spawned.clone()];
    assert_eq!(
        select_spawned_child(&candidates, "task", &baseline)
            .map(|(_, thread_id)| thread_id.as_str()),
        Some("thread-new"),
    );

    // A leftover child from earlier work used to make this unresolvable, leaving the running
    // card unopenable for the whole run.
    let baseline: HashSet<String> = [existing.1.clone()].into_iter().collect();
    let candidates = vec![existing.clone(), spawned.clone()];
    assert_eq!(
        select_spawned_child(&candidates, "task", &baseline)
            .map(|(_, thread_id)| thread_id.as_str()),
        Some("thread-new"),
    );

    // Two children appearing at once are genuinely ambiguous without a title to tell them
    // apart, so nothing is claimed and the tool's own header resolves it later.
    let both_new = vec![existing.clone(), spawned.clone()];
    assert!(select_spawned_child(&both_new, "task", &HashSet::new()).is_none());

    // A named tool call still wins outright.
    assert_eq!(
        select_spawned_child(&both_new, "Earlier errand", &HashSet::new())
            .map(|(_, thread_id)| thread_id.as_str()),
        Some("thread-old"),
    );
}

/// One discovery per tool call: the agent reports a running task tool repeatedly, and each
/// report must not start another poller for the same sub-agent.
#[test]
fn discovery_keys_separate_tool_calls_without_colliding() {
    let mut in_flight = HashSet::new();
    assert!(in_flight.insert(discovery_key("parent", "call-1")));
    assert!(!in_flight.insert(discovery_key("parent", "call-1")));
    assert!(in_flight.insert(discovery_key("parent", "call-2")));
    assert_ne!(
        discovery_key("parent", "a\u{1}b"),
        discovery_key("parent\u{1}a", "b"),
    );
}

#[test]
fn late_child_terminal_after_projector_state_loss_broadcasts_the_updated_parent_snapshot() {
    let mut snapshot = crate::acp::snapshot::SessionSnapshot::new(
        "alpha-agent".to_string(),
        "parent-thread".to_string(),
    );
    snapshot.apply(&crate::acp::events::CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: "parent-thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Research dependency options".to_string(),
        content: crate::acp::events::FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string(),
        ),
        structured_content: crate::acp::events::FieldUpdate::Set(Vec::new()),
        locations: crate::acp::events::FieldUpdate::Set(Vec::new()),
    });
    assert!(snapshot.mark_subagent_terminal("child-1", "failed"));
    snapshot.apply(&crate::acp::events::CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: "parent-thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::Completed,
        title: "Research dependency options".to_string(),
        content: crate::acp::events::FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nWrapper completed\n</task>".to_string(),
        ),
        structured_content: crate::acp::events::FieldUpdate::Unchanged,
        locations: crate::acp::events::FieldUpdate::Unchanged,
    });
    let parent = ManagedSession {
        thread_id: "parent-thread".to_string(),
        agent_id: "alpha-agent".to_string(),
        cwd: PathBuf::from("/tmp"),
        parent_thread_id: None,
        snapshot,
    };

    let envelope = parent_subagent_snapshot_envelope(&parent);
    assert_eq!(envelope.thread_id, "parent-thread");
    let card = envelope
        .event
        .messages
        .expect("parent snapshot messages")
        .into_iter()
        .find(|message| message.id == "subagent:task-1")
        .map(serde_json::to_value)
        .and_then(Result::ok)
        .expect("corrected parent card");
    assert_eq!(card["content"]["subAgent"]["agentStatus"], "failed");
    assert!(card["content"]["text"]
        .as_str()
        .is_some_and(|text| text.contains("Sub-agent failed")));
}

#[tokio::test]
async fn disconnect_cancels_blocked_permit_and_acp_futures_and_cleans_map() {
    let tracker = Arc::new(ClientRequestTracker::default());
    tracker.register_client(7);
    let semaphore = Arc::new(Semaphore::new(0));
    let permit_wait = {
        let tracker = tracker.clone();
        let semaphore = semaphore.clone();
        tokio::spawn(async move {
            tracker
                .run(7, async move { semaphore.acquire_owned().await })
                .await
        })
    };
    let (_acp_tx, acp_rx) = oneshot::channel::<()>();
    let acp_wait = {
        let tracker = tracker.clone();
        tokio::spawn(async move { tracker.run(7, acp_rx).await })
    };
    while tracker.request_count() != 2 {
        tokio::task::yield_now().await;
    }

    tracker.cancel_client(7);
    assert_eq!(
        timeout(Duration::from_secs(1), permit_wait)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err(),
        "client request cancelled",
    );
    assert_eq!(
        timeout(Duration::from_secs(1), acp_wait)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err(),
        "client request cancelled",
    );
    assert_eq!(tracker.request_count(), 0);
    assert_eq!(tracker.run(7, async {}).await, Err("client disconnected"));
}

#[tokio::test]
async fn disconnect_before_the_operation_is_polled_is_definitive() {
    let tracker = Arc::new(ClientRequestTracker::default());
    tracker.register_client(8);
    let cancelling_tracker = Arc::clone(&tracker);

    let result = tracker
        .run_with(8, move |_| {
            cancelling_tracker.cancel_client(8);
            std::future::pending::<()>()
        })
        .await;

    assert_eq!(result, Err("client disconnected"));
    assert_eq!(tracker.request_count(), 0);
}

#[tokio::test]
async fn post_apply_response_loss_preserves_prepared_family_and_recovers_indexed_descendants() {
    let directory = retirement_test_directory("retirement-response-loss");
    let thread_id = retirement_test_thread("response-loss");
    let child_thread_id = retirement_test_thread("response-loss-child");
    let late_child_thread_id = retirement_test_thread("response-loss-late-child");
    let retiring_thread_ids = vec![thread_id.clone(), child_thread_id.clone()];
    let (queue, scheduler, journal) =
        seeded_durable_retirement_services(&directory, &thread_id).await;
    let retirement = ThreadStateRetirement::begin_with_journal(
        queue.clone(),
        scheduler.clone(),
        journal,
        CancellationToken::new(),
        &retiring_thread_ids,
    )
    .await
    .expect("begin durable retirement");

    let persisted = crate::retirement_journal::ThreadRetirementJournal::load(
        directory.join("thread-retirements.json"),
    )
    .await
    .expect("load persisted tombstone");
    let mut expected_thread_ids = retiring_thread_ids.clone();
    expected_thread_ids.sort();
    let entries = persisted.entries().await;
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].phase,
        crate::retirement_journal::RetirementPhase::Prepared,
    );
    assert_eq!(entries[0].requested_thread_ids, expected_thread_ids);
    assert_eq!(scheduler.list(&thread_id).await.len(), 1);
    assert!(
        BridgeQueueService::load_submission_store(&directory.join("queue-idempotency.json"))
            .await
            .unwrap()
            .results
            .contains_key("sent-before-delete"),
    );

    assert_eq!(
        retirement
            .finish_delete(Err("ACP response was lost after apply".to_string()))
            .await
            .unwrap_err(),
        "ACP response was lost after apply",
    );
    let entries = crate::retirement_journal::ThreadRetirementJournal::load(
        directory.join("thread-retirements.json"),
    )
    .await
    .unwrap()
    .entries()
    .await;
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].phase,
        crate::retirement_journal::RetirementPhase::Prepared,
    );
    assert_eq!(entries[0].requested_thread_ids, expected_thread_ids);
    assert_eq!(scheduler.list(&thread_id).await.len(), 1);
    assert!(
        BridgeQueueService::load_submission_store(&directory.join("queue-idempotency.json"))
            .await
            .unwrap()
            .results
            .contains_key("sent-before-delete"),
    );
    drop(
        queue
            .retirement_fence
            .admit(&thread_id)
            .await
            .expect("indeterminate delete releases the fence"),
    );
    drop(
        queue
            .retirement_fence
            .admit(&child_thread_id)
            .await
            .expect("indeterminate delete releases the complete family fence"),
    );
    scheduler
        .schedule(
            &late_child_thread_id,
            "indexed after the prepared family was frozen".to_string(),
            &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        )
        .await
        .expect("seed late indexed descendant schedule");
    queue
        .remember_submission_result(BridgeThreadQueueSendResponse {
            submission_id: "sent-before-late-child-delete".to_string(),
            disposition: BridgeThreadQueueDisposition::Sent,
            queue: BridgeQueueService::snapshot_for_thread(&late_child_thread_id, None),
            turn_id: Some("turn-before-late-child-delete".to_string()),
        })
        .await
        .expect("seed late indexed descendant receipt");
    scheduler.shutdown().await;
    drop(scheduler);

    let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
    let mut recovered_family = vec![
        thread_id.clone(),
        child_thread_id,
        late_child_thread_id.clone(),
    ];
    recovered_family.sort();
    let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Absent)
        .with_expanded(recovered_family.clone());
    ThreadStateRetirement::recover_pending(
        queue,
        scheduler.clone(),
        journal,
        &reconciler,
        CancellationToken::new(),
    )
    .await
    .expect("confirmed absent expanded family converges");

    assert!(scheduler.list(&thread_id).await.is_empty());
    assert!(scheduler.list(&late_child_thread_id).await.is_empty());
    assert!(
        BridgeQueueService::load_submission_store(&directory.join("queue-idempotency.json"))
            .await
            .unwrap()
            .results
            .is_empty(),
    );
    assert_eq!(reconciler.finalized(), vec![recovered_family]);
    assert!(crate::retirement_journal::ThreadRetirementJournal::load(
        directory.join("thread-retirements.json")
    )
    .await
    .unwrap()
    .entries()
    .await
    .is_empty());
    scheduler.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn drop_before_delete_invocation_preserves_prepared_tombstone_without_background_work() {
    let directory = retirement_test_directory("retirement-pre-delete-drop");
    let thread_id = retirement_test_thread("pre-delete-drop");
    let (queue, scheduler, journal) =
        seeded_durable_retirement_services(&directory, &thread_id).await;
    let retirement = ThreadStateRetirement::begin_with_journal(
        queue.clone(),
        scheduler.clone(),
        journal,
        CancellationToken::new(),
        std::slice::from_ref(&thread_id),
    )
    .await
    .expect("begin durable retirement");

    drop(retirement);
    drop(
        queue
            .retirement_fence
            .admit(&thread_id)
            .await
            .expect("dropping retirement releases its fence synchronously"),
    );
    let entries = crate::retirement_journal::ThreadRetirementJournal::load(
        directory.join("thread-retirements.json"),
    )
    .await
    .unwrap()
    .entries()
    .await;
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].phase,
        crate::retirement_journal::RetirementPhase::Prepared,
    );
    assert_eq!(scheduler.list(&thread_id).await.len(), 1);
    assert!(
        BridgeQueueService::load_submission_store(&directory.join("queue-idempotency.json"))
            .await
            .unwrap()
            .results
            .contains_key("sent-before-delete"),
    );

    scheduler.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn shutdown_abort_joins_owned_delete_and_preserves_recoverable_prepared_tombstone() {
    let directory = retirement_test_directory("retirement-abort-during-delete");
    let thread_id = retirement_test_thread("abort-during-delete");
    let (queue, scheduler, journal) =
        seeded_durable_retirement_services(&directory, &thread_id).await;
    let tracker = Arc::new(ClientRequestTracker::default());
    tracker.register_client(82);
    let (delete_invoked_tx, delete_invoked_rx) = oneshot::channel();
    let delete = tokio::spawn({
        let tracker = tracker.clone();
        let queue = queue.clone();
        let scheduler = scheduler.clone();
        let journal = journal.clone();
        let thread_id = thread_id.clone();
        async move {
            tracker
                .run_owned_with(82, move || async move {
                    let retirement = ThreadStateRetirement::begin_with_journal(
                        queue,
                        scheduler,
                        journal,
                        CancellationToken::new(),
                        std::slice::from_ref(&thread_id),
                    )
                    .await
                    .expect("begin durable retirement");
                    delete_invoked_tx.send(()).unwrap();
                    let _retirement = retirement;
                    std::future::pending::<()>().await;
                })
                .await
        }
    });
    delete_invoked_rx.await.unwrap();

    timeout(Duration::from_secs(1), tracker.shutdown_owned_requests())
        .await
        .expect("shutdown aborts and joins the owned delete task");
    assert_eq!(
        delete
            .await
            .expect("delete request wrapper settles")
            .expect("client request remains registered")
            .unwrap_err(),
        "owned client request task failed",
    );
    assert_eq!(
        tracker.active_request_count(),
        0,
        "no retirement task survives the tracked outer delete task",
    );
    drop(
        queue
            .retirement_fence
            .admit(&thread_id)
            .await
            .expect("aborted delete releases in-memory guards before shutdown returns"),
    );

    let entries = crate::retirement_journal::ThreadRetirementJournal::load(
        directory.join("thread-retirements.json"),
    )
    .await
    .unwrap()
    .entries()
    .await;
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].phase,
        crate::retirement_journal::RetirementPhase::Prepared,
    );
    assert_eq!(scheduler.list(&thread_id).await.len(), 1);
    assert!(
        BridgeQueueService::load_submission_store(&directory.join("queue-idempotency.json"))
            .await
            .unwrap()
            .results
            .contains_key("sent-before-delete"),
    );

    scheduler.shutdown().await;
    drop(scheduler);

    let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
    let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Absent);
    ThreadStateRetirement::recover_pending(
        queue.clone(),
        scheduler.clone(),
        journal.clone(),
        &reconciler,
        CancellationToken::new(),
    )
    .await
    .expect("startup reconciles the journal preserved by shutdown abort");
    assert!(journal.entries().await.is_empty());
    assert!(scheduler.list(&thread_id).await.is_empty());
    assert_eq!(
        queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
        "thread is being deleted",
        "confirmed-absent startup recovery installs a deleted-thread tombstone",
    );
    assert!(
        BridgeQueueService::load_submission_store(&directory.join("queue-idempotency.json"))
            .await
            .unwrap()
            .results
            .is_empty(),
    );
    scheduler.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn prepared_recovery_with_live_acp_session_preserves_work_and_clears_journal() {
    let directory = retirement_test_directory("retirement-prepared-live");
    let thread_id = retirement_test_thread("prepared-live");
    let (queue, scheduler, journal) =
        seeded_durable_retirement_services(&directory, &thread_id).await;
    let retirement = ThreadStateRetirement::begin_with_journal(
        queue,
        scheduler.clone(),
        journal,
        CancellationToken::new(),
        std::slice::from_ref(&thread_id),
    )
    .await
    .expect("begin durable retirement");

    retirement.abandon_for_test();
    scheduler.shutdown().await;
    drop(scheduler);

    let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
    let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Present);
    ThreadStateRetirement::recover_pending(
        queue.clone(),
        scheduler.clone(),
        journal.clone(),
        &reconciler,
        CancellationToken::new(),
    )
    .await
    .expect("live prepared retirement rolls back");

    assert_eq!(scheduler.list(&thread_id).await.len(), 1);
    assert!(
        BridgeQueueService::load_submission_store(&directory.join("queue-idempotency.json"))
            .await
            .unwrap()
            .results
            .contains_key("sent-before-delete"),
    );
    assert!(crate::retirement_journal::ThreadRetirementJournal::load(
        directory.join("thread-retirements.json")
    )
    .await
    .unwrap()
    .entries()
    .await
    .is_empty());
    assert!(reconciler.finalized().is_empty());
    scheduler.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn prepared_recovery_with_confirmed_absent_session_promotes_and_cleans() {
    let directory = retirement_test_directory("retirement-prepared-absent");
    let thread_id = retirement_test_thread("prepared-absent");
    let (queue, scheduler, journal) =
        seeded_durable_retirement_services(&directory, &thread_id).await;
    let retirement = ThreadStateRetirement::begin_with_journal(
        queue,
        scheduler.clone(),
        journal,
        CancellationToken::new(),
        std::slice::from_ref(&thread_id),
    )
    .await
    .expect("begin durable retirement");
    retirement.abandon_for_test();
    scheduler.shutdown().await;
    drop(scheduler);

    let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
    let (outbox, mut notifications) = crate::client_outbox::client_outbox(8);
    queue
        .hub
        .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
        .await;
    let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Absent);
    ThreadStateRetirement::recover_pending(
        queue.clone(),
        scheduler.clone(),
        journal,
        &reconciler,
        CancellationToken::new(),
    )
    .await
    .expect("startup recovery converges");

    assert!(scheduler.list(&thread_id).await.is_empty());
    assert_eq!(
        queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
        "thread is being deleted",
        "confirmed-absent startup recovery installs a deleted-thread tombstone",
    );
    assert!(
        BridgeQueueService::load_submission_store(&directory.join("queue-idempotency.json"))
            .await
            .unwrap()
            .results
            .is_empty(),
    );
    assert!(crate::retirement_journal::ThreadRetirementJournal::load(
        directory.join("thread-retirements.json")
    )
    .await
    .unwrap()
    .entries()
    .await
    .is_empty());
    assert_eq!(reconciler.finalized(), vec![vec![thread_id.clone()]]);
    let mut methods = HashSet::new();
    for _ in 0..2 {
        let message = timeout(Duration::from_secs(1), notifications.recv())
            .await
            .expect("recovery notification timeout")
            .expect("recovery notification");
        let axum::extract::ws::Message::Text(text) = message else {
            panic!("expected text recovery notification");
        };
        let value: Value = serde_json::from_str(text.as_str()).unwrap();
        assert_eq!(value["params"]["threadId"], thread_id);
        methods.insert(value["method"].as_str().unwrap().to_string());
    }
    assert_eq!(
        methods,
        HashSet::from([
            "bridge/thread/queue/updated".to_string(),
            "bridge/thread/schedules/updated".to_string(),
        ]),
    );
    scheduler
        .start_worker()
        .expect("scheduled worker starts only after recovery");
    scheduler.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn deleted_phase_freezes_expanded_family_before_cleanup_and_recovers_union() {
    let directory = retirement_test_directory("retirement-deleted-expanded");
    let thread_id = retirement_test_thread("deleted-expanded");
    let additional_thread_id = retirement_test_thread("deleted-expanded-child");
    let (queue, scheduler, journal) =
        seeded_durable_retirement_services(&directory, &thread_id).await;
    queue
        .remember_submission_result(BridgeThreadQueueSendResponse {
            submission_id: "sent-before-expanded-delete".to_string(),
            disposition: BridgeThreadQueueDisposition::Sent,
            queue: BridgeQueueService::snapshot_for_thread(&additional_thread_id, None),
            turn_id: Some("turn-before-expanded-delete".to_string()),
        })
        .await
        .expect("seed expanded durable queue receipt");
    scheduler
        .schedule(
            &additional_thread_id,
            "expanded child survives until deleted phase".to_string(),
            &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        )
        .await
        .expect("seed expanded durable schedule");
    let mut expected_family = vec![thread_id.clone(), additional_thread_id.clone()];
    expected_family.sort();
    let retirement = ThreadStateRetirement::begin_with_journal(
        queue,
        scheduler.clone(),
        journal,
        CancellationToken::new(),
        &expected_family,
    )
    .await
    .expect("begin durable retirement");
    assert_eq!(
        retirement
            .mark_deleted_then_abandon_for_test(&expected_family)
            .await
            .expect("persist delete response before cleanup"),
        expected_family,
    );
    scheduler.shutdown().await;
    drop(scheduler);

    let persisted = crate::retirement_journal::ThreadRetirementJournal::load(
        directory.join("thread-retirements.json"),
    )
    .await
    .unwrap()
    .entries()
    .await;
    assert_eq!(persisted.len(), 1);
    assert_eq!(
        persisted[0].phase,
        crate::retirement_journal::RetirementPhase::Deleted,
    );
    assert_eq!(persisted[0].deleted_thread_ids, expected_family);

    let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
    let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Present);
    ThreadStateRetirement::recover_pending(
        queue.clone(),
        scheduler.clone(),
        journal.clone(),
        &reconciler,
        CancellationToken::new(),
    )
    .await
    .expect("deleted union recovery converges");
    assert!(scheduler.list(&thread_id).await.is_empty());
    assert!(scheduler.list(&additional_thread_id).await.is_empty());
    for deleted_thread_id in [&thread_id, &additional_thread_id] {
        assert_eq!(
            queue
                .retirement_fence
                .admit(deleted_thread_id)
                .await
                .unwrap_err(),
            "thread is being deleted",
            "deleted journal recovery leaves the complete family tombstoned",
        );
    }
    assert!(
        BridgeQueueService::load_submission_store(&directory.join("queue-idempotency.json"))
            .await
            .unwrap()
            .results
            .is_empty(),
    );
    assert_eq!(reconciler.finalized(), vec![expected_family]);
    scheduler.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn global_retirement_barrier_drains_manager_waiting_descendant_without_deadlock() {
    let queue = BridgeQueueService::new(Arc::new(RetirementDispatcher), Arc::new(ClientHub::new()));
    let parent = retirement_test_thread("barrier-parent");
    let descendant = retirement_test_thread("barrier-descendant");
    let manager_family_lock = Arc::new(Mutex::new(()));
    let held_manager_operation = manager_family_lock.clone().lock_owned().await;
    let dispatch_reached_manager = Arc::new(Notify::new());
    let dispatch = tokio::spawn({
        let queue = queue.clone();
        let descendant = descendant.clone();
        let manager_family_lock = manager_family_lock.clone();
        let dispatch_reached_manager = dispatch_reached_manager.clone();
        async move {
            let _admission = queue
                .retirement_fence
                .admit(&descendant)
                .await
                .expect("descendant dispatch is initially admitted");
            dispatch_reached_manager.notify_one();
            let _manager_operation = manager_family_lock.lock().await;
        }
    });
    timeout(Duration::from_secs(1), dispatch_reached_manager.notified())
        .await
        .expect("descendant dispatch reaches the manager family lock");

    let barrier_attempted = Arc::new(Notify::new());
    *queue
        .retirement_fence
        .begin_attempted
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(barrier_attempted.clone());
    let deletion = tokio::spawn({
        let queue = queue.clone();
        let parent = parent.clone();
        let descendant = descendant.clone();
        let manager_family_lock = manager_family_lock.clone();
        async move {
            let barrier = queue.block_retirement_admissions().await;
            let _manager_family = manager_family_lock.lock().await;
            let lease = queue
                .begin_retirement_fence_blocked(&[parent, descendant], &barrier)
                .expect("authoritative family fence installs beneath global barrier");
            drop(barrier);
            lease
        }
    });
    timeout(Duration::from_secs(1), barrier_attempted.notified())
        .await
        .expect("deletion queues the global admission barrier before manager planning");
    let late_admission = tokio::spawn({
        let queue = queue.clone();
        let descendant = descendant.clone();
        async move { queue.retirement_fence.admit(&descendant).await }
    });
    tokio::task::yield_now().await;
    assert!(!deletion.is_finished());
    assert!(!late_admission.is_finished());

    drop(held_manager_operation);
    timeout(Duration::from_secs(1), dispatch)
        .await
        .expect("admitted dispatch clears the manager lock")
        .expect("dispatch task");
    let lease = timeout(Duration::from_secs(1), deletion)
        .await
        .expect("global-barrier deletion cannot deadlock")
        .expect("deletion task");
    assert_eq!(
        timeout(Duration::from_secs(1), late_admission)
            .await
            .expect("late admission settles after full-family fence installation")
            .expect("late admission task")
            .unwrap_err(),
        "thread is being deleted",
    );
    lease.finish().await;
}

#[tokio::test]
async fn prepared_authoritative_family_recovers_after_delete_and_index_removal_crash() {
    let directory = retirement_test_directory("retirement-post-delete-crash");
    let parent = retirement_test_thread("post-delete-crash-parent");
    let descendant = retirement_test_thread("post-delete-crash-descendant");
    let (queue, scheduler, journal) = seeded_durable_retirement_services(&directory, &parent).await;
    scheduler
        .schedule(
            &descendant,
            "frozen before ACP deletion".to_string(),
            &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        )
        .await
        .expect("seed descendant schedule");
    queue
        .remember_submission_result(BridgeThreadQueueSendResponse {
            submission_id: "sent-before-post-delete-crash".to_string(),
            disposition: BridgeThreadQueueDisposition::Sent,
            queue: BridgeQueueService::snapshot_for_thread(&descendant, None),
            turn_id: Some("turn-before-post-delete-crash".to_string()),
        })
        .await
        .expect("seed descendant receipt");
    let mut authoritative = vec![parent.clone(), descendant.clone()];
    authoritative.sort();
    let retirement = ThreadStateRetirement::begin_with_journal(
        queue,
        scheduler.clone(),
        journal,
        CancellationToken::new(),
        &authoritative,
    )
    .await
    .expect("freeze authoritative family before ACP deletion");

    retirement.abandon_for_test();
    scheduler.shutdown().await;
    drop(scheduler);
    let persisted = crate::retirement_journal::ThreadRetirementJournal::load(
        directory.join("thread-retirements.json"),
    )
    .await
    .unwrap()
    .entries()
    .await;
    assert_eq!(persisted.len(), 1);
    assert_eq!(
        persisted[0].phase,
        crate::retirement_journal::RetirementPhase::Prepared,
    );
    assert_eq!(persisted[0].requested_thread_ids, authoritative);

    let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
    let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Absent)
        .with_expanded(authoritative.clone());
    ThreadStateRetirement::recover_pending(
        queue,
        scheduler.clone(),
        journal.clone(),
        &reconciler,
        CancellationToken::new(),
    )
    .await
    .expect("prepared complete family recovers without session-index ancestry");

    assert!(scheduler.list(&parent).await.is_empty());
    assert!(scheduler.list(&descendant).await.is_empty());
    assert!(
        BridgeQueueService::load_submission_store(&directory.join("queue-idempotency.json"))
            .await
            .unwrap()
            .results
            .is_empty(),
    );
    assert_eq!(reconciler.finalized(), vec![authoritative]);
    assert!(journal.entries().await.is_empty());
    scheduler.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn authoritative_delete_fences_descendants_before_journal_retry_and_cleanup() {
    let directory = retirement_test_directory("retirement-authoritative-fence");
    let parent = retirement_test_thread("authoritative-fence-parent");
    let queued_descendant = retirement_test_thread("authoritative-fence-queued");
    let steered_descendant = retirement_test_thread("authoritative-fence-steered");
    let (queue, scheduler, journal) = seeded_durable_retirement_services(&directory, &parent).await;
    let queued_entry = |id: &str| BridgeQueuedMessageEntry {
        id: id.to_string(),
        submission_id: format!("submission-{id}"),
        created_at: now_iso(),
        content: format!("content-{id}"),
        turn_start: json!({
            "input": [{"type": "text", "text": format!("content-{id}"), "text_elements": []}]
        }),
        agent_message: None,
    };
    queue.threads.write().await.insert(
        queued_descendant.clone(),
        BridgeThreadQueueRuntime {
            items: std::collections::VecDeque::from([queued_entry("expanded-queue")]),
            ..BridgeThreadQueueRuntime::default()
        },
    );
    queue.threads.write().await.insert(
        steered_descendant.clone(),
        BridgeThreadQueueRuntime {
            pending_steers: std::collections::VecDeque::from([queued_entry("expanded-steer")]),
            active_turn_id: Some("turn".to_string()),
            active_run_id: Some("run".to_string()),
            active_prompt_generation: Some(1),
            live_generation_known: true,
            thread_running: true,
            ..BridgeThreadQueueRuntime::default()
        },
    );
    let mut deleted_family = vec![
        parent.clone(),
        queued_descendant.clone(),
        steered_descendant.clone(),
    ];
    deleted_family.sort();
    let retirement = ThreadStateRetirement::begin_with_journal(
        queue.clone(),
        scheduler.clone(),
        journal.clone(),
        CancellationToken::new(),
        &deleted_family,
    )
    .await
    .expect("freeze and guard the authoritative family before ACP deletion");
    let prepared = journal.entries().await;
    assert_eq!(prepared.len(), 1);
    assert_eq!(prepared[0].requested_thread_ids, deleted_family);
    for thread_id in [&queued_descendant, &steered_descendant] {
        assert_eq!(
            queue.retirement_fence.admit(thread_id).await.unwrap_err(),
            "thread is being deleted",
        );
    }

    journal.fail_all_persists(true);
    let retry_reached = Arc::new(Notify::new());
    let release_retry = Arc::new(Notify::new());
    *queue
        .retirement_retry_barrier
        .lock()
        .unwrap_or_else(|error| error.into_inner()) =
        Some((retry_reached.clone(), release_retry.clone()));
    let cleanup = tokio::spawn({
        let deleted_family = deleted_family.clone();
        async move { retirement.finish_delete(Ok(deleted_family)).await }
    });
    timeout(Duration::from_secs(1), retry_reached.notified())
        .await
        .expect("deleted journal phase reaches persistence retry");

    for thread_id in [&queued_descendant, &steered_descendant] {
        assert_eq!(
            queue.retirement_fence.admit(thread_id).await.unwrap_err(),
            "thread is being deleted",
        );
    }
    timeout(Duration::from_secs(1), async {
        let drain_queue = queue.drain_thread_queue(queued_descendant.clone());
        let drain_steers = queue.drain_pending_steers(steered_descendant.clone());
        tokio::join!(drain_queue, drain_steers);
    })
    .await
    .expect("fenced background dispatch attempts return");
    {
        let threads = queue.threads.read().await;
        let queued = threads
            .get(&queued_descendant)
            .expect("queued descendant remains pending before cleanup");
        assert_eq!(queued.items.len(), 1);
        assert!(!queued.turn_start_in_flight);
        assert!(queued.last_error.is_none());
        let steered = threads
            .get(&steered_descendant)
            .expect("steered descendant remains pending before cleanup");
        assert_eq!(steered.pending_steers.len(), 1);
        assert!(!steered.steer_prepare_in_flight);
        assert!(steered.steer_dispatch_in_flight.is_none());
        assert!(steered.last_error.is_none());
    }

    journal.fail_all_persists(false);
    release_retry.notify_one();
    assert_eq!(
        timeout(Duration::from_secs(1), cleanup)
            .await
            .expect("expanded retirement cleanup completes")
            .expect("cleanup task")
            .expect("retirement converges"),
        deleted_family,
    );
    for thread_id in [&queued_descendant, &steered_descendant] {
        assert_eq!(
            queue.retirement_fence.admit(thread_id).await.unwrap_err(),
            "thread is being deleted",
            "successful cleanup leaves the authoritative family tombstoned",
        );
    }
    scheduler.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn prepared_recovery_with_mixed_or_indeterminate_sessions_keeps_tombstone_and_work() {
    let directory = retirement_test_directory("retirement-prepared-indeterminate");
    let thread_id = retirement_test_thread("prepared-indeterminate");
    let child_thread_id = retirement_test_thread("prepared-indeterminate-child");
    let (queue, scheduler, journal) =
        seeded_durable_retirement_services(&directory, &thread_id).await;
    let retirement = ThreadStateRetirement::begin_with_journal(
        queue,
        scheduler.clone(),
        journal,
        CancellationToken::new(),
        &[thread_id.clone(), child_thread_id],
    )
    .await
    .expect("begin durable retirement");
    retirement.abandon_for_test();
    scheduler.shutdown().await;
    drop(scheduler);

    let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
    let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Indeterminate);
    let error = ThreadStateRetirement::recover_pending(
        queue,
        scheduler.clone(),
        journal,
        &reconciler,
        CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert!(error.contains("indeterminate or mixed"));
    assert_eq!(scheduler.list(&thread_id).await.len(), 1);
    assert!(
        BridgeQueueService::load_submission_store(&directory.join("queue-idempotency.json"))
            .await
            .unwrap()
            .results
            .contains_key("sent-before-delete"),
    );
    let entries = crate::retirement_journal::ThreadRetirementJournal::load(
        directory.join("thread-retirements.json"),
    )
    .await
    .unwrap()
    .entries()
    .await;
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].phase,
        crate::retirement_journal::RetirementPhase::Prepared,
    );
    assert!(reconciler.finalized().is_empty());
    scheduler.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn restart_idempotently_recovers_either_partially_cleaned_store() {
    for scheduler_cleaned_first in [false, true] {
        let directory = retirement_test_directory(if scheduler_cleaned_first {
            "retirement-crash-scheduler-clean"
        } else {
            "retirement-crash-queue-clean"
        });
        let thread_id = retirement_test_thread(if scheduler_cleaned_first {
            "scheduler-clean"
        } else {
            "queue-clean"
        });
        let (queue, scheduler, journal) =
            seeded_durable_retirement_services(&directory, &thread_id).await;
        let retirement = ThreadStateRetirement::begin_with_journal(
            queue,
            scheduler.clone(),
            journal,
            CancellationToken::new(),
            std::slice::from_ref(&thread_id),
        )
        .await
        .expect("begin durable retirement");
        if scheduler_cleaned_first {
            retirement
                .commit_scheduler_then_abandon_for_test()
                .await
                .expect("persist scheduler cleanup");
            assert!(scheduler.list(&thread_id).await.is_empty());
            assert!(BridgeQueueService::load_submission_store(
                &directory.join("queue-idempotency.json")
            )
            .await
            .unwrap()
            .results
            .contains_key("sent-before-delete"));
        } else {
            retirement
                .commit_queue_then_abandon_for_test()
                .await
                .expect("persist queue cleanup");
            assert!(scheduler.list(&thread_id).await.len() == 1);
            assert!(BridgeQueueService::load_submission_store(
                &directory.join("queue-idempotency.json")
            )
            .await
            .unwrap()
            .results
            .is_empty());
        }
        assert!(!crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json")
        )
        .await
        .unwrap()
        .entries()
        .await
        .is_empty());
        scheduler.shutdown().await;
        drop(scheduler);

        let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
        let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Present);
        ThreadStateRetirement::recover_pending(
            queue.clone(),
            scheduler.clone(),
            journal.clone(),
            &reconciler,
            CancellationToken::new(),
        )
        .await
        .expect("partial startup recovery converges");
        assert!(scheduler.list(&thread_id).await.is_empty());
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .is_empty());
        assert!(crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json")
        )
        .await
        .unwrap()
        .entries()
        .await
        .is_empty());
        ThreadStateRetirement::recover_pending(
            queue,
            scheduler.clone(),
            journal,
            &reconciler,
            CancellationToken::new(),
        )
        .await
        .expect("cleared deleted journal recovery is idempotent");
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }
}

#[tokio::test]
async fn journal_clear_precedes_success_snapshots_and_deleted_tombstone_transition() {
    let directory = retirement_test_directory("retirement-final-commit-order");
    let thread_id = retirement_test_thread("final-commit-order");
    let (queue, scheduler, journal) =
        seeded_durable_retirement_services(&directory, &thread_id).await;
    let (outbox, mut notifications) = crate::client_outbox::client_outbox(8);
    queue
        .hub
        .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
        .await;
    let retirement = ThreadStateRetirement::begin_with_journal(
        queue.clone(),
        scheduler.clone(),
        journal.clone(),
        CancellationToken::new(),
        std::slice::from_ref(&thread_id),
    )
    .await
    .expect("begin durable retirement");
    journal.fail_all_removes(true);
    let retry_reached = Arc::new(Notify::new());
    let release_retry = Arc::new(Notify::new());
    *queue
        .retirement_retry_barrier
        .lock()
        .unwrap_or_else(|error| error.into_inner()) =
        Some((retry_reached.clone(), release_retry.clone()));
    let cleanup = tokio::spawn({
        let thread_id = thread_id.clone();
        async move { retirement.finish_delete(Ok(vec![thread_id])).await }
    });
    timeout(Duration::from_secs(1), retry_reached.notified())
        .await
        .expect("journal clear reaches its retry owner");

    assert!(scheduler.list(&thread_id).await.is_empty());
    assert!(
        BridgeQueueService::load_submission_store(&directory.join("queue-idempotency.json"))
            .await
            .unwrap()
            .results
            .is_empty(),
    );
    assert_eq!(
        crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json")
        )
        .await
        .unwrap()
        .entries()
        .await[0]
            .phase,
        crate::retirement_journal::RetirementPhase::Deleted,
    );
    assert!(
        notifications.try_recv().is_err(),
        "durable cleanup must not look committed before the tombstone clears",
    );
    assert_eq!(
        queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
        "thread is being deleted",
    );

    journal.fail_all_removes(false);
    release_retry.notify_one();
    assert_eq!(
        timeout(Duration::from_secs(1), cleanup)
            .await
            .expect("journal clear retry completes")
            .expect("cleanup task")
            .expect("retirement converges"),
        vec![thread_id.clone()],
    );
    assert!(journal.entries().await.is_empty());
    let mut methods = HashSet::new();
    for _ in 0..2 {
        let message = timeout(Duration::from_secs(1), notifications.recv())
            .await
            .expect("success notification timeout")
            .expect("success notification");
        let axum::extract::ws::Message::Text(text) = message else {
            panic!("expected text success notification");
        };
        let value: Value = serde_json::from_str(text.as_str()).unwrap();
        methods.insert(value["method"].as_str().unwrap().to_string());
    }
    assert_eq!(
        methods,
        HashSet::from([
            "bridge/thread/queue/updated".to_string(),
            "bridge/thread/schedules/updated".to_string(),
        ]),
    );
    assert_eq!(
        queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
        "thread is being deleted",
        "journal clear transitions retirement to a permanent deleted tombstone",
    );

    scheduler.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn startup_recovery_bounds_permanent_persistence_failure_and_retains_journal() {
    let directory = retirement_test_directory("retirement-startup-bound");
    let thread_id = retirement_test_thread("startup-bound");
    let (queue, scheduler, journal) =
        seeded_durable_retirement_services(&directory, &thread_id).await;
    let retirement = ThreadStateRetirement::begin_with_journal(
        queue.clone(),
        scheduler.clone(),
        journal.clone(),
        CancellationToken::new(),
        std::slice::from_ref(&thread_id),
    )
    .await
    .expect("begin durable retirement");
    retirement
        .mark_deleted_then_abandon_for_test(std::slice::from_ref(&thread_id))
        .await
        .expect("freeze deleted phase");
    journal.fail_all_removes(true);
    let attempts_before = journal.remove_attempt_count();
    let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Absent);

    let error = timeout(
        Duration::from_secs(1),
        ThreadStateRetirement::recover_pending(
            queue.clone(),
            scheduler.clone(),
            journal.clone(),
            &reconciler,
            CancellationToken::new(),
        ),
    )
    .await
    .expect("startup recovery is bounded")
    .unwrap_err();
    assert!(error.contains(&format!(
        "did not converge after {THREAD_RETIREMENT_STARTUP_MAX_ATTEMPTS} attempts"
    )));
    assert_eq!(
        journal.remove_attempt_count() - attempts_before,
        THREAD_RETIREMENT_STARTUP_MAX_ATTEMPTS as usize,
    );
    assert_eq!(journal.entries().await.len(), 1);
    assert_eq!(
        journal.entries().await[0].phase,
        crate::retirement_journal::RetirementPhase::Deleted,
    );
    assert_eq!(
        queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
        "thread is being deleted",
        "deleted-plan recovery keeps its in-memory tombstone after bounded cleanup failure",
    );

    journal.fail_all_removes(false);
    ThreadStateRetirement::recover_pending(
        queue,
        scheduler.clone(),
        journal.clone(),
        &reconciler,
        CancellationToken::new(),
    )
    .await
    .expect("next startup completes retained cleanup");
    assert!(journal.entries().await.is_empty());
    scheduler.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn shutdown_bounds_permanent_journal_failure_and_leaves_recoverable_tombstone() {
    let directory = retirement_test_directory("retirement-shutdown");
    let thread_id = retirement_test_thread("shutdown");
    let (queue, scheduler, journal) =
        seeded_durable_retirement_services(&directory, &thread_id).await;
    let shutdown = CancellationToken::new();
    let retirement = ThreadStateRetirement::begin_with_journal(
        queue.clone(),
        scheduler.clone(),
        journal.clone(),
        shutdown.clone(),
        std::slice::from_ref(&thread_id),
    )
    .await
    .expect("begin durable retirement");
    journal.fail_all_persists(true);
    let retry_reached = Arc::new(Notify::new());
    let release_retry = Arc::new(Notify::new());
    *queue
        .retirement_retry_barrier
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some((retry_reached.clone(), release_retry));
    let cleanup = tokio::spawn(async move { retirement.finish_delete(Ok(vec![thread_id])).await });
    timeout(Duration::from_secs(1), retry_reached.notified())
        .await
        .expect("journal clear reaches retry");

    shutdown.cancel();
    let result = timeout(Duration::from_secs(1), cleanup)
        .await
        .expect("shutdown bounds cleanup")
        .expect("cleanup task")
        .unwrap_err();
    assert!(result.contains("bridge shutdown"));
    assert!(!crate::retirement_journal::ThreadRetirementJournal::load(
        directory.join("thread-retirements.json")
    )
    .await
    .unwrap()
    .entries()
    .await
    .is_empty());
    assert_eq!(
        scheduler
            .list(&retirement_test_thread("shutdown"))
            .await
            .len(),
        1,
    );
    assert!(
        BridgeQueueService::load_submission_store(&directory.join("queue-idempotency.json"))
            .await
            .unwrap()
            .results
            .contains_key("sent-before-delete"),
    );
    scheduler.shutdown().await;
    drop(scheduler);

    let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
    let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Absent);
    ThreadStateRetirement::recover_pending(
        queue,
        scheduler.clone(),
        journal,
        &reconciler,
        CancellationToken::new(),
    )
    .await
    .expect("next startup clears preserved tombstone");
    assert!(crate::retirement_journal::ThreadRetirementJournal::load(
        directory.join("thread-retirements.json")
    )
    .await
    .unwrap()
    .entries()
    .await
    .is_empty());
    scheduler.shutdown().await;
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn owned_request_shutdown_aborts_a_permanently_stalled_task_within_its_bound() {
    let tracker = Arc::new(ClientRequestTracker::default());
    tracker.register_client(91);
    let request = tokio::spawn({
        let tracker = tracker.clone();
        async move { tracker.run_owned_with(91, std::future::pending::<()>).await }
    });
    while tracker.active_request_count() == 0 {
        tokio::task::yield_now().await;
    }

    timeout(Duration::from_secs(1), tracker.shutdown_owned_requests())
        .await
        .expect("owned request shutdown is bounded");
    assert!(request.await.unwrap().unwrap().is_err());
    assert_eq!(tracker.active_request_count(), 0);
}

#[tokio::test]
async fn disconnect_after_delete_keeps_retrying_retirement_until_shutdown_can_join_it() {
    let directory = std::env::current_dir()
        .expect("current directory")
        .join("target")
        .join(format!("disconnected-retirement-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).expect("create retirement test directory");
    let receipt_path = directory.join("queue.json");
    let queue = BridgeQueueService::with_submission_store(
        Arc::new(RetirementDispatcher),
        Arc::new(ClientHub::new()),
        Some(receipt_path.clone()),
        crate::queue_service::DurableQueueSubmissions::default(),
    );
    let scheduler = crate::scheduled_prompts::ScheduledPromptService::inert_for_test();
    let thread_id = crate::acp::identity::AgentSessionId::new("agent", "deleted-thread")
        .expect("valid test thread ID")
        .encode();
    queue
        .remember_submission_result(BridgeThreadQueueSendResponse {
            submission_id: "sent-before-delete".to_string(),
            disposition: BridgeThreadQueueDisposition::Sent,
            queue: BridgeQueueService::snapshot_for_thread(&thread_id, None),
            turn_id: Some("turn-before-delete".to_string()),
        })
        .await
        .expect("seed durable receipt");
    queue
        .fail_next_submission_persist
        .store(true, Ordering::Release);
    let retry_reached = Arc::new(Notify::new());
    let release_retry = Arc::new(Notify::new());
    *queue
        .retirement_retry_barrier
        .lock()
        .unwrap_or_else(|error| error.into_inner()) =
        Some((retry_reached.clone(), release_retry.clone()));

    let tracker = Arc::new(ClientRequestTracker::default());
    tracker.register_client(81);
    let deletion_succeeded = Arc::new(Notify::new());
    let request = {
        let tracker = tracker.clone();
        let deletion_succeeded = deletion_succeeded.clone();
        let queue = queue.clone();
        let scheduler = scheduler.clone();
        let thread_id = thread_id.clone();
        tokio::spawn(async move {
            tracker
                .run_owned_with(81, move || async move {
                    let retirement = ThreadStateRetirement::begin(
                        queue,
                        scheduler,
                        std::slice::from_ref(&thread_id),
                    )
                    .await
                    .expect("begin retirement");
                    deletion_succeeded.notify_one();
                    retirement.finish_delete(Ok(vec![thread_id])).await
                })
                .await
        })
    };

    timeout(Duration::from_secs(1), deletion_succeeded.notified())
        .await
        .expect("ACP deletion reaches success before disconnect");
    timeout(Duration::from_secs(1), retry_reached.notified())
        .await
        .expect("cleanup reaches durable retry after ACP deletion");
    tracker.cancel_client(81);
    assert_eq!(
        timeout(Duration::from_secs(1), request)
            .await
            .expect("cancelled request settles")
            .unwrap(),
        Err("client request cancelled"),
    );
    assert_eq!(
        tracker.active_request_count(),
        1,
        "the owned delete remains tracked after its client disconnects",
    );

    let shutdown = tokio::spawn({
        let tracker = tracker.clone();
        async move { tracker.shutdown_owned_requests().await }
    });
    tokio::task::yield_now().await;
    assert!(
        !shutdown.is_finished(),
        "runtime shutdown waits for the tracked owned delete",
    );
    assert_eq!(
        queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
        "thread is being deleted",
    );
    assert!(BridgeQueueService::load_submission_store(&receipt_path)
        .await
        .expect("load pre-retry receipt")
        .results
        .contains_key("sent-before-delete"));

    release_retry.notify_one();
    timeout(Duration::from_secs(1), shutdown)
        .await
        .expect("runtime shutdown settles after cleanup")
        .expect("shutdown task");
    assert!(BridgeQueueService::load_submission_store(&receipt_path)
        .await
        .expect("load converged receipt store")
        .results
        .is_empty());
    assert_eq!(
        queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
        "thread is being deleted",
        "converged cleanup leaves a permanent deleted-thread tombstone",
    );
    assert_eq!(tracker.request_count(), 0);
    assert_eq!(tracker.active_request_count(), 0);
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn tracker_rejects_capacity_and_completes_after_capacity_is_released() {
    let tracker = ClientRequestTracker::default();
    tracker.register_client(9);
    {
        let mut registry = tracker
            .registry
            .lock()
            .expect("client request registry lock");
        for request_id in 0..MAX_TRACKED_CLIENT_REQUESTS as u64 {
            registry.requests.insert(
                request_id,
                ClientRequestOwner {
                    client_id: 9,
                    cancellation: RequestCancellation::default(),
                },
            );
        }
    }
    assert_eq!(
        tracker.run(9, async { 1 }).await,
        Err("client request tracking capacity reached"),
    );

    tracker
        .registry
        .lock()
        .expect("client request registry lock")
        .requests
        .clear();
    assert_eq!(tracker.run(9, async { 2 }).await, Ok(2));
    assert_eq!(tracker.request_count(), 0);

    tracker.cancel_client(9);
    tracker.cancel_client(999);
    assert_eq!(
        tracker.run(9, async { 3 }).await,
        Err("client disconnected"),
    );
}

#[tokio::test]
async fn disconnect_is_owner_scoped_and_completion_races_cleanup_once() {
    let tracker = Arc::new(ClientRequestTracker::default());
    tracker.register_client(1);
    tracker.register_client(2);
    let (one_tx, one_rx) = oneshot::channel::<u8>();
    let (two_tx, two_rx) = oneshot::channel::<u8>();
    let one = {
        let tracker = tracker.clone();
        tokio::spawn(async move { tracker.run(1, one_rx).await })
    };
    let two = {
        let tracker = tracker.clone();
        tokio::spawn(async move { tracker.run(2, two_rx).await })
    };
    while tracker.request_count() != 2 {
        tokio::task::yield_now().await;
    }
    tracker.cancel_client(1);
    two_tx.send(2).unwrap();
    assert_eq!(one.await.unwrap(), Err("client request cancelled"));
    assert_eq!(two.await.unwrap().unwrap().unwrap(), 2);
    drop(one_tx);
    assert_eq!(tracker.request_count(), 0);

    for client_id in 10..110 {
        tracker.register_client(client_id);
        let (complete_tx, complete_rx) = oneshot::channel::<()>();
        let request = {
            let tracker = tracker.clone();
            tokio::spawn(async move { tracker.run(client_id, complete_rx).await })
        };
        while tracker.request_count() != 1 {
            tokio::task::yield_now().await;
        }
        let _ = complete_tx.send(());
        tracker.cancel_client(client_id);
        let result = request.await.unwrap();
        assert!(matches!(
            result,
            Ok(Ok(())) | Err("client request cancelled")
        ));
        assert_eq!(tracker.request_count(), 0);
    }
}

#[tokio::test]
async fn retirement_rejects_a_deleted_family_outside_its_prepared_scope() {
    let thread_id = retirement_test_thread("prepared");
    let other_thread_id = retirement_test_thread("unexpected");
    let queue = BridgeQueueService::new(Arc::new(RetirementDispatcher), Arc::new(ClientHub::new()));
    let scheduler = crate::scheduled_prompts::ScheduledPromptService::inert_for_test();
    let journal = Arc::new(crate::retirement_journal::ThreadRetirementJournal::inert_for_test());
    let retirement = ThreadStateRetirement::begin_with_journal(
        queue.clone(),
        scheduler,
        journal.clone(),
        CancellationToken::new(),
        std::slice::from_ref(&thread_id),
    )
    .await
    .unwrap();

    assert_eq!(
        retirement
            .finish_delete(Ok(vec![other_thread_id]))
            .await
            .unwrap_err(),
        "ACP deletion returned a family different from its prepared scope",
    );
    assert_eq!(journal.entries().await.len(), 1);
    drop(queue.retirement_fence.admit(&thread_id).await.unwrap());
}

#[tokio::test]
async fn bounded_retirement_retries_cover_limits_and_shutdown_interruption() {
    let thread_id = retirement_test_thread("bounded-retries");
    let queue = BridgeQueueService::new(Arc::new(RetirementDispatcher), Arc::new(ClientHub::new()));
    let scheduler = crate::scheduled_prompts::ScheduledPromptService::inert_for_test();
    let journal = Arc::new(crate::retirement_journal::ThreadRetirementJournal::inert_for_test());
    let retirement_id = journal
        .add_prepared(std::slice::from_ref(&thread_id))
        .await
        .unwrap();

    journal.fail_all_persists(true);
    assert!(ThreadStateRetirement::mark_journal_deleted_until_converged(
        &queue,
        &journal,
        &retirement_id,
        std::slice::from_ref(&thread_id),
        &CancellationToken::new(),
        Some(1),
    )
    .await
    .unwrap_err()
    .contains("did not converge after 1 attempts"));
    journal.fail_all_persists(false);

    let queue_retirement = queue
        .begin_thread_retirement(std::slice::from_ref(&thread_id))
        .await
        .unwrap();
    queue
        .fail_next_submission_persist
        .store(true, Ordering::Release);
    assert!(ThreadStateRetirement::commit_queue_until_converged(
        &queue,
        &queue_retirement,
        &CancellationToken::new(),
        Some(1),
    )
    .await
    .unwrap_err()
    .contains("did not converge after 1 attempts"));

    let shutdown = CancellationToken::new();
    shutdown.cancel();
    queue
        .fail_next_submission_persist
        .store(true, Ordering::Release);
    assert_eq!(
        ThreadStateRetirement::commit_queue_until_converged(
            &queue,
            &queue_retirement,
            &shutdown,
            None,
        )
        .await
        .unwrap_err(),
        "thread retirement interrupted by bridge shutdown",
    );

    journal.fail_all_removes(true);
    assert_eq!(
        ThreadStateRetirement::clear_journal_until_converged(
            &queue,
            &journal,
            std::slice::from_ref(&retirement_id),
            &shutdown,
            None,
        )
        .await
        .unwrap_err(),
        "thread retirement interrupted by bridge shutdown",
    );
    journal.fail_all_removes(false);

    let partial = ThreadStateRetirementTransaction {
        thread_ids: vec![thread_id],
        queue,
        scheduler,
        queue_retirement: None,
        scheduler_retirement: None,
        fence: None,
        journal,
        journal_retirement_ids: vec![retirement_id],
        shutdown,
        max_commit_attempts: None,
    };
    ThreadStateRetirement::release_transaction_preserving_journal(partial).await;
}
