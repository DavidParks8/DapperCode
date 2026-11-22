use super::{
    append_message_text, append_structured_part, apply_tool_text, apply_tool_values, bound_json,
    history_entry_bytes, BridgeThreadSnapshot, BridgeTokenTotalsSnapshot, BridgeTurnUsageSnapshot,
    CanonicalEvent, CommandEntry, ConfigEntry, ConfigOptionValue, FieldUpdate, ForkBoundary,
    ForkBoundaryKind, ForkBoundaryMessage, HashSet, MessageRole, PlanEntry, SessionSnapshot,
    SnapshotCursor, SnapshotHistoryEntry, SnapshotMessage, SnapshotTimelineEntry,
    SnapshotTimelineKind, SnapshotTool, ToolProjection, VecDeque, HISTORY_ENTRY_MEASUREMENTS,
    MAX_ACTIVE_TOOL_TOMBSTONES, MAX_ENTRIES, MAX_HISTORY_BYTES, MAX_HISTORY_ENTRIES, MAX_MESSAGES,
    MAX_MESSAGE_PARTS, MAX_SNAPSHOT_PAGE_SIZE, MAX_STRUCTURED_FIELDS, MAX_STRUCTURED_PART_BYTES,
    MAX_TEXT_BYTES, MAX_TIMELINE_ENTRIES, MAX_TOOLS, MAX_TOOL_LOCATIONS, MAX_TOOL_STRUCTURED_ITEMS,
    MAX_TOOL_TEXT_BYTES, URL_SAFE_NO_PAD,
};
use agent_client_protocol::v1::schema::{StopReason, ToolCallStatus, ToolKind};
use base64::Engine;

fn run_started(generation: u64) -> CanonicalEvent {
    CanonicalEvent::RunStarted {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: format!("run-{generation}"),
        source_turn_id: format!("turn-{generation}"),
        generation,
    }
}

fn subagent_tool_update(
    id: &str,
    title: &str,
    status: ToolCallStatus,
    content: &str,
) -> CanonicalEvent {
    CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: Some(1),
        tool_call_id: id.to_string(),
        kind: ToolKind::Think,
        status,
        title: title.to_string(),
        content: FieldUpdate::Set(content.to_string()),
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    }
}

fn tool(id: &str, generation: Option<u64>, status: ToolCallStatus) -> CanonicalEvent {
    CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation,
        tool_call_id: id.to_string(),
        kind: ToolKind::Other,
        status,
        title: "title".to_string(),
        content: FieldUpdate::Set("content".to_string()),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    }
}

#[test]
fn message_repositioning_handles_duplicates_self_anchors_and_stale_indexes() {
    let mut snapshot = SessionSnapshot::new("agent".into(), "thread".into());
    assert!(!snapshot.mark_subagent_terminal("missing", "completed"));
    assert!(!snapshot.mark_subagent_tool_terminal(
        "missing",
        "completed",
        ToolCallStatus::Completed
    ));

    snapshot.append_message_after("first".into(), MessageRole::User, "one".into(), None, None);
    snapshot.append_message_after(
        "first".into(),
        MessageRole::User,
        "two".into(),
        None,
        Some("first"),
    );
    snapshot.append_message_after(
        "self".into(),
        MessageRole::User,
        "self".into(),
        None,
        Some("self"),
    );
    snapshot.reposition_message_after("first", "missing-anchor");

    snapshot.append_message(
        "agent-message:message".into(),
        MessageRole::User,
        "ordinary".into(),
        None,
    );
    let origin = crate::agent_messaging::AgentMessageOrigin {
        message_id: "message".into(),
        direction: crate::agent_messaging::AgentMessageDirection::Received,
        related_thread_id: "parent".into(),
        related_title: None,
        relation: crate::agent_messaging::AgentRelationKind::Parent,
        disposition: crate::agent_messaging::AgentMessageDisposition::Queued,
        body: "typed".into(),
    };
    snapshot.append_agent_message(origin.clone());
    snapshot.append_agent_message_after(origin.clone(), Some("first"));
    snapshot.append_agent_message_after(origin, Some("first"));

    snapshot.append_message(
        "stale-anchor".into(),
        MessageRole::User,
        "anchor".into(),
        None,
    );
    snapshot
        .history
        .retain(|entry| entry.canonical_id != "stale-anchor");
    snapshot.reposition_message_after("first", "stale-anchor");
}

#[test]
fn tool_timing_keeps_first_observation_and_freezes_terminal_time() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply_at(&tool("tool", None, ToolCallStatus::InProgress), 1_000);
    snapshot.apply_at(&tool("tool", None, ToolCallStatus::InProgress), 1_500);
    let running = &snapshot.tools["tool"];
    assert_eq!(running.started_at_ms, 1_000);
    assert_eq!(running.completed_at_ms, None);

    snapshot.apply_at(&tool("tool", None, ToolCallStatus::Completed), 2_500);
    snapshot.apply_at(&tool("tool", None, ToolCallStatus::Completed), 3_000);
    let completed = &snapshot.tools["tool"];
    assert_eq!(completed.started_at_ms, 1_000);
    assert_eq!(completed.completed_at_ms, Some(2_500));
    let value = serde_json::to_value(completed).unwrap();
    assert_eq!(value["startedAtMs"], 1_000);
    assert_eq!(value["completedAtMs"], 2_500);
}

#[test]
fn run_completion_stamps_dangling_tool_completion_time() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply_at(&run_started(1), 500);
    snapshot.apply_at(&tool("tool", Some(1), ToolCallStatus::InProgress), 1_000);
    snapshot.apply_at(
        &CanonicalEvent::RunFinished {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: "run-1".to_string(),
            source_turn_id: "turn-1".to_string(),
            generation: 1,
            stop_reason: StopReason::EndTurn,
        },
        4_000,
    );

    let tool = &snapshot.tools["tool"];
    assert_eq!(tool.status, ToolCallStatus::Completed);
    assert_eq!(tool.started_at_ms, 1_000);
    assert_eq!(tool.completed_at_ms, Some(4_000));
}

/// Reproduces "a long complete session showed as in progress".
///
/// Restarting the bridge replays a thread from history. Replayed tool events carry no
/// generation and are never followed by a `RunFinished`, so the run-scoped terminalizer
/// cannot reach them: the tool call settles to `completed` while the last `<task …>`
/// header it ever saw still reads `state="running"`. Committing that contradiction made
/// every finished thread report a working sub-agent on every future read.
#[test]
fn replayed_subagent_header_settles_with_its_tool_call() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        tool_call_id: "call-task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::Completed,
        title: "Task".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nAudit the tests\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });

    // Applying the replayed event settles the header with the tool that carries it, so
    // the contradiction never reaches the snapshot in the first place.
    assert!(snapshot
        .subagent_header("call-task-1")
        .expect("replayed sub-agent header")
        .contains(r#"state="completed""#));

    // Sweeping again is idempotent: it must not reopen or relabel a settled header.
    snapshot.settle_unresolved_subagents_without_run();

    assert!(snapshot
        .subagent_header("call-task-1")
        .expect("settled sub-agent header")
        .contains(r#"state="completed""#));
    assert!(!snapshot
        .tools
        .get("call-task-1")
        .expect("tool")
        .content
        .contains(r#"state="running""#));
}

/// OpenCode opens its task tool as `task` and relabels it with the task description on the
/// next update, long before any `<task …>` result exists. Recomputing the classification
/// from the newest title left a live sub-agent rendering as an ordinary tool call for its
/// entire run.
#[test]
fn renaming_a_task_tool_keeps_it_classified_as_a_sub_agent() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&run_started(1));
    snapshot.apply(&subagent_tool_update(
        "call-task-1",
        "task",
        ToolCallStatus::Pending,
        "",
    ));

    assert!(snapshot.tools.get("call-task-1").expect("tool").subagent);

    snapshot.apply(&subagent_tool_update(
        "call-task-1",
        "Inspect workspace",
        ToolCallStatus::InProgress,
        "",
    ));

    let tool = snapshot.tools.get("call-task-1").expect("tool");
    assert!(tool.subagent, "renaming un-classified the sub-agent");
    assert_eq!(tool.title, "Inspect workspace");
}

#[test]
fn active_subagent_detection_survives_tool_snapshot_eviction() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&run_started(1));
    snapshot.apply(&subagent_tool_update(
        "call-task-1",
        "Inspect workspace",
        ToolCallStatus::InProgress,
        "<task id=\"child\" state=\"running\">\nWorking\n</task>",
    ));
    assert!(snapshot.has_active_subagent_tool());

    snapshot.tools.remove("call-task-1");
    assert!(snapshot.active_tool_ids.contains("call-task-1"));
    assert!(snapshot.subagent_headers.contains_key("call-task-1"));
    assert!(snapshot.has_active_subagent_tool());
}

/// Agents that never name the tool `task` are still classified once a task header lands.
#[test]
fn a_task_header_classifies_a_tool_that_was_never_named_task() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&run_started(1));
    snapshot.apply(&subagent_tool_update(
        "call-task-1",
        "Inspect workspace",
        ToolCallStatus::InProgress,
        "",
    ));

    assert!(!snapshot.tools.get("call-task-1").expect("tool").subagent);

    snapshot.apply(&subagent_tool_update(
        "call-task-1",
        "Inspect workspace",
        ToolCallStatus::Completed,
        "<task id=\"child\" state=\"completed\">\n<task_result>done</task_result>\n</task>",
    ));

    assert!(snapshot.tools.get("call-task-1").expect("tool").subagent);
}

/// A failed tool call must settle its header as failed, not launder it into a success.
#[test]
fn replayed_failed_subagent_header_settles_as_failed() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        tool_call_id: "call-task-2".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::Failed,
        title: "Task".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-2\" state=\"running\">\nAudit\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });

    snapshot.settle_unresolved_subagents_without_run();

    assert!(snapshot
        .subagent_header("call-task-2")
        .expect("settled sub-agent header")
        .contains(r#"state="failed""#));
}

/// A tool call that has not settled is still genuinely working, and a live run owns its
/// own reconciliation, so neither may be forced terminal.
#[test]
fn settling_leaves_unfinished_subagents_and_live_runs_alone() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        tool_call_id: "call-task-3".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Task".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-3\" state=\"running\">\nAudit\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    snapshot.settle_unresolved_subagents_without_run();
    assert!(snapshot
        .subagent_header("call-task-3")
        .expect("header")
        .contains(r#"state="running""#));

    let mut live = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    live.apply(&run_started(1));
    live.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "call-task-4".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::Completed,
        title: "Task".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-4\" state=\"running\">\nAudit\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    live.settle_unresolved_subagents_without_run();
    assert!(live
        .subagent_header("call-task-4")
        .expect("header")
        .contains(r#"state="running""#));
}

#[test]
fn snapshot_tracks_active_generation_messages_and_tools() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&run_started(2));
    snapshot.apply(&CanonicalEvent::MessageChunk {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-2".to_string()),
        source_turn_id: Some("turn-2".to_string()),
        generation: Some(2),
        role: MessageRole::Agent,
        message_id: "message".to_string(),
        content: "one".to_string(),
        content_block: None,
    });
    snapshot.apply(&CanonicalEvent::MessageChunk {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-2".to_string()),
        source_turn_id: Some("turn-2".to_string()),
        generation: Some(2),
        role: MessageRole::Agent,
        message_id: "message".to_string(),
        content: " two".to_string(),
        content_block: None,
    });
    snapshot.apply(&tool("tool", Some(2), ToolCallStatus::InProgress));
    snapshot.apply(&tool("other-generation", Some(1), ToolCallStatus::Pending));
    assert_eq!(
        snapshot.messages[0].parts,
        vec![serde_json::json!({"type":"text","text":"one two"})],
    );
    assert_eq!(
        snapshot.active_tool_ids,
        HashSet::from(["tool".to_string()]),
    );

    snapshot.apply(&tool("tool", Some(2), ToolCallStatus::Completed));
    snapshot.apply(&CanonicalEvent::RunFinished {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: "stale".to_string(),
        source_turn_id: "stale".to_string(),
        generation: 1,
        stop_reason: StopReason::EndTurn,
    });
    assert_eq!(snapshot.active_generation, Some(2));
    snapshot.apply(&CanonicalEvent::RunFailed {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: "run-2".to_string(),
        source_turn_id: "turn-2".to_string(),
        generation: 2,
        message: "failed".to_string(),
    });
    assert_eq!(snapshot.active_generation, None);
    assert!(snapshot.active_tool_ids.is_empty());
}

#[test]
fn overlapping_runs_terminalize_prior_tools_and_ignore_missing_subagent_tools() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    assert!(!snapshot.mark_subagent_tool_terminal("missing", "failed", ToolCallStatus::Failed,));

    snapshot.apply(&run_started(1));
    snapshot.apply(&tool("tool", Some(1), ToolCallStatus::InProgress));
    snapshot.apply(&run_started(2));

    assert_eq!(snapshot.active_generation, Some(2));
    assert_eq!(
        snapshot.tools.get("tool").map(|tool| tool.status),
        Some(ToolCallStatus::Failed),
    );

    let mut orphaned_header = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    orphaned_header.subagent_headers.insert(
        "missing".to_string(),
        r#"<task id="child" state="running">"#.to_string(),
    );
    assert!(BridgeThreadSnapshot::from(orphaned_header).tools.is_empty());
}

#[test]
fn snapshot_preserves_subagent_header_after_plain_text_replaces_tool_content() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nReading files\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::Completed,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set("Found three options".to_string()),
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    });

    assert_eq!(snapshot.tools["task-1"].content, "Found three options");
    assert_eq!(
        snapshot.subagent_header("task-1"),
        Some(r#"<task id="child-1" state="running">"#),
    );

    let restored_source = snapshot.clone();
    let mut restored = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    restored.restore_transcript_from(restored_source);
    assert_eq!(
        restored.subagent_header("task-1"),
        Some(r#"<task id="child-1" state="running">"#),
    );

    let page = snapshot.page(None, None, 10).expect("snapshot page");
    let paged_tool = page
        .entries
        .iter()
        .find_map(|entry| entry.tool.as_ref())
        .expect("paged tool");
    assert!(
        paged_tool
            .content
            .starts_with("<task id=\"child-1\" state=\"completed\">\n"),
        "paged history lost terminal sub-agent metadata: {paged_tool:?}",
    );

    let mut evicted = snapshot.clone();
    for index in 0..MAX_TOOLS {
        evicted.apply(&tool(
            &format!("other-{index}"),
            None,
            ToolCallStatus::Completed,
        ));
    }
    assert!(!evicted.tools.contains_key("task-1"));
    assert_eq!(
        evicted.subagent_header("task-1"),
        Some(r#"<task id="child-1" state="running">"#),
    );
    assert!(evicted.mark_subagent_terminal("child-1", "failed"));
    let evicted_history_tool = evicted
        .history
        .iter()
        .find(|entry| entry.canonical_id == "task-1")
        .and_then(|entry| entry.tool.as_ref())
        .expect("evicted history tool");
    assert!(
        evicted_history_tool
            .content
            .starts_with("<task id=\"child-1\" state=\"failed\">\n"),
        "evicted history lost sub-agent metadata: {evicted_history_tool:?}",
    );

    let durable = BridgeThreadSnapshot::from(snapshot);
    assert_eq!(durable.tools.len(), 1);
    assert!(
        durable.tools[0]
            .content
            .starts_with("<task id=\"child-1\" state=\"completed\">\n"),
        "durable thread snapshot lost sub-agent classification: {:?}",
        durable.tools[0],
    );
    let serialized = serde_json::to_value(durable).expect("serializable snapshot");
    assert!(
        serialized.get("subagentHeaders").is_none(),
        "internal metadata leaked into the bridge contract: {serialized}",
    );

    let mut child_failed = SessionSnapshot::new("agent".to_string(), "failed-thread".to_string());
    child_failed.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "failed-thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-failed".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::Completed,
        title: "Audit dependency risks".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-failed\" state=\"error\">\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    let child_failed = BridgeThreadSnapshot::from(child_failed);
    assert!(
        child_failed.tools[0]
            .content
            .starts_with("<task id=\"child-failed\" state=\"error\">\n"),
        "successful wrapper overwrote the child's failure: {:?}",
        child_failed.tools[0],
    );
}

#[test]
fn active_subagent_eviction_keeps_a_terminalizable_history_tombstone() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&run_started(1));
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-active".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-active\" state=\"running\">\nWorking\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    for index in 0..MAX_TOOLS {
        snapshot.apply(&tool(
            &format!("other-{index}"),
            None,
            ToolCallStatus::Completed,
        ));
    }
    assert!(!snapshot.tools.contains_key("task-active"));
    assert!(snapshot.active_tool_ids.contains("task-active"));

    snapshot.apply(&CanonicalEvent::RunFailed {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: "run-1".to_string(),
        source_turn_id: "turn-1".to_string(),
        generation: 1,
        message: "parent failed".to_string(),
    });
    let history_tool = snapshot
        .history
        .iter()
        .find(|entry| entry.canonical_id == "task-active")
        .and_then(|entry| entry.tool.as_ref())
        .expect("active history tombstone");
    assert_eq!(history_tool.status, ToolCallStatus::Failed);
    assert!(
        history_tool
            .content
            .starts_with("<task id=\"child-active\" state=\"failed\">\n"),
        "evicted active task stayed running: {history_tool:?}",
    );

    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-active".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::Completed,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set("Wrapper completed".to_string()),
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    });
    let restored_tool = snapshot.tools.get("task-active").expect("restored tool");
    let durable = BridgeThreadSnapshot::from(snapshot.clone());
    let durable_tool = durable
        .tools
        .iter()
        .find(|tool| tool.id == "task-active")
        .expect("durable restored tool");
    assert_eq!(restored_tool.content, "Wrapper completed");
    assert!(
        durable_tool
            .content
            .starts_with("<task id=\"child-active\" state=\"failed\">\n"),
        "plain terminal update lost evicted child failure: {durable_tool:?}",
    );
    assert_eq!(
        snapshot
            .history
            .iter()
            .filter(|entry| entry.canonical_id == "task-active")
            .count(),
        1,
        "restoring an evicted tool duplicated paged history",
    );
}

#[test]
fn active_tool_tombstones_are_bounded() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&run_started(1));
    for index in 0..(MAX_TOOLS + MAX_ACTIVE_TOOL_TOMBSTONES + 16) {
        snapshot.apply(&tool(
            &format!("active-{index:03}"),
            Some(1),
            ToolCallStatus::InProgress,
        ));
    }

    assert_eq!(snapshot.tools.len(), MAX_TOOLS);
    assert!(
        snapshot.active_tool_ids.len() <= MAX_TOOLS + MAX_ACTIVE_TOOL_TOMBSTONES,
        "active tool ids escaped their bound: {}",
        snapshot.active_tool_ids.len(),
    );
    assert!(
        snapshot
            .history
            .iter()
            .filter_map(|entry| entry.tool.as_ref())
            .any(|tool| tool.status == ToolCallStatus::Failed),
        "expiring a tombstone did not terminalize its history",
    );
}

#[test]
fn history_rollover_keeps_active_subagent_classification_for_a_late_update() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&run_started(1));
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-active".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-active\" state=\"running\">\nWorking\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    for index in 0..MAX_TOOLS {
        snapshot.apply(&tool(
            &format!("other-{index:03}"),
            None,
            ToolCallStatus::Completed,
        ));
    }
    assert!(!snapshot.tools.contains_key("task-active"));
    for index in 0..=MAX_HISTORY_ENTRIES {
        snapshot.apply(&CanonicalEvent::MessageChunk {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            role: MessageRole::Agent,
            message_id: format!("message-{index:04}"),
            content: "x".to_string(),
            content_block: None,
        });
    }
    assert!(
        snapshot
            .history
            .iter()
            .all(|entry| entry.canonical_id != "task-active"),
        "fixture did not roll the active task out of history",
    );
    assert!(snapshot.active_tool_ids.contains("task-active"));
    assert!(snapshot.subagent_header("task-active").is_some());

    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-active".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::Completed,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set("Wrapper completed".to_string()),
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    });
    let durable = BridgeThreadSnapshot::from(snapshot);
    let task = durable
        .tools
        .iter()
        .find(|tool| tool.id == "task-active")
        .expect("late task update");
    assert!(
        task.content
            .starts_with("<task id=\"child-active\" state=\"completed\">\n"),
        "late update lost rolled-over classification: {task:?}",
    );
}

#[test]
fn late_child_failure_survives_a_successful_parent_wrapper_snapshot() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&run_started(1));
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    assert!(snapshot.mark_subagent_terminal("child-1", "failed"));
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::Completed,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set("Wrapper completed".to_string()),
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    });

    let durable = BridgeThreadSnapshot::from(snapshot);
    assert_eq!(durable.tools[0].status, ToolCallStatus::Completed);
    assert!(
        durable.tools[0]
            .content
            .starts_with("<task id=\"child-1\" state=\"failed\">\n"),
        "wrapper completion erased the persisted child failure: {:?}",
        durable.tools[0],
    );
}

#[test]
fn late_append_to_an_evicted_tool_preserves_its_retained_state() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&run_started(1));
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-active".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-active\" state=\"running\">\nfirst chunk".to_string(),
        ),
        structured_content: FieldUpdate::Set(vec![serde_json::json!({"kind":"retained"})]),
        locations: FieldUpdate::Set(vec![serde_json::json!({"path":"src/a.rs"})]),
    });
    for index in 0..MAX_TOOLS {
        snapshot.apply(&tool(
            &format!("other-{index:03}"),
            None,
            ToolCallStatus::Completed,
        ));
    }
    assert!(!snapshot.tools.contains_key("task-active"));

    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-active".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Append("\nsecond chunk".to_string()),
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    });

    let restored = snapshot.tools.get("task-active").expect("restored tool");
    assert!(restored.content.contains("first chunk\nsecond chunk"));
    assert_eq!(
        restored.structured_content,
        vec![serde_json::json!({"kind":"retained"})],
    );
    assert_eq!(
        restored.locations,
        vec![serde_json::json!({"path":"src/a.rs"})],
    );
    assert_eq!(
        snapshot
            .history
            .iter()
            .filter(|entry| entry.canonical_id == "task-active")
            .count(),
        1,
        "late append duplicated retained history",
    );
}

#[test]
fn later_parent_failure_does_not_fail_unresolved_child_from_earlier_turn() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&run_started(1));
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::Completed,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Unchanged,
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    });
    snapshot.apply(&CanonicalEvent::RunFinished {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: "run-1".to_string(),
        source_turn_id: "turn-1".to_string(),
        generation: 1,
        stop_reason: StopReason::EndTurn,
    });
    snapshot.apply(&run_started(2));

    assert_eq!(snapshot.tools["task-1"].status, ToolCallStatus::Completed);
    assert_eq!(
        snapshot.subagent_header("task-1"),
        Some(r#"<task id="child-1" state="running">"#),
    );
    snapshot.apply(&CanonicalEvent::RunFailed {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: "run-2".to_string(),
        source_turn_id: "turn-2".to_string(),
        generation: 2,
        message: "follow-up failed".to_string(),
    });
    assert_eq!(snapshot.tools["task-1"].status, ToolCallStatus::Completed);
    assert_eq!(
        snapshot.subagent_header("task-1"),
        Some(r#"<task id="child-1" state="running">"#),
    );
}

#[test]
fn starting_a_followup_does_not_fail_an_unresolved_child_from_a_finished_parent_run() {
    later_parent_failure_does_not_fail_unresolved_child_from_earlier_turn();
}

#[test]
fn retasked_child_terminal_status_only_updates_the_latest_unresolved_card() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    for (tool_call_id, state) in [("task-1", "completed"), ("task-2", "running")] {
        snapshot.apply(&CanonicalEvent::Tool {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            tool_call_id: tool_call_id.to_string(),
            kind: ToolKind::Other,
            status: if state == "completed" {
                ToolCallStatus::Completed
            } else {
                ToolCallStatus::InProgress
            },
            title: "Research dependency options".to_string(),
            content: FieldUpdate::Set(format!("<task id=\"child-1\" state=\"{state}\">\n</task>")),
            structured_content: FieldUpdate::Set(Vec::new()),
            locations: FieldUpdate::Set(Vec::new()),
        });
    }

    assert!(snapshot.mark_subagent_terminal("child-1", "failed"));
    assert_eq!(
        snapshot.subagent_header("task-1"),
        Some(r#"<task id="child-1" state="completed">"#),
    );
    assert_eq!(
        snapshot.subagent_header("task-2"),
        Some(r#"<task id="child-1" state="failed">"#),
    );
}

#[test]
fn terminal_wrapper_with_a_stale_running_header_cannot_clear_a_known_child_failure() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    assert!(snapshot.mark_subagent_terminal("child-1", "failed"));
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::Completed,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nWrapper completed\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    });

    let durable = BridgeThreadSnapshot::from(snapshot);
    assert!(
        durable.tools[0]
            .content
            .starts_with("<task id=\"child-1\" state=\"failed\">\n"),
        "stale wrapper header resurrected the child: {:?}",
        durable.tools[0],
    );
}

#[test]
fn unresolved_subagent_link_remains_correctable_until_child_terminal() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&run_started(1));
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::Completed,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Unchanged,
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    });
    for index in 0..MAX_TOOLS {
        snapshot.apply(&tool(
            &format!("other-{index:03}"),
            None,
            ToolCallStatus::Completed,
        ));
    }
    assert!(!snapshot.tools.contains_key("task-1"));
    assert!(snapshot.subagent_header("task-1").is_some());

    assert!(snapshot.mark_subagent_terminal("child-1", "failed"));
    let history_tool = snapshot
        .history
        .iter()
        .find(|entry| entry.canonical_id == "task-1")
        .and_then(|entry| entry.tool.as_ref())
        .expect("evicted unresolved card");
    assert_eq!(history_tool.status, ToolCallStatus::Failed);
    assert!(history_tool
        .content
        .starts_with("<task id=\"child-1\" state=\"failed\">\n"));
}

#[test]
fn snapshot_preserves_ordered_typed_message_content() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    let event = CanonicalEvent::MessageChunk {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        role: MessageRole::Agent,
        message_id: "content".to_string(),
        content: "A".to_string(),
        content_block: None,
    };
    let exercise = |snapshot: &mut SessionSnapshot, mut event: CanonicalEvent| {
        snapshot.apply(&event);
        if let CanonicalEvent::MessageChunk { content_block, .. } = &mut event {
            *content_block = Some(serde_json::json!({"type":"image"}));
        }
        if let CanonicalEvent::MessageChunk { content, .. } = &mut event {
            content.clear();
        }
        snapshot.apply(&event);
        if let CanonicalEvent::MessageChunk { content_block, .. } = &mut event {
            *content_block = None;
        }
        if let CanonicalEvent::MessageChunk { content, .. } = &mut event {
            *content = "B".to_string();
        }
        snapshot.apply(&event);
    };
    exercise(&mut snapshot, event);
    exercise(
        &mut snapshot,
        CanonicalEvent::Plan {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            entries: Vec::new(),
        },
    );
    assert_eq!(
        snapshot.messages[0].parts,
        vec![
            serde_json::json!({"type":"text","text":"A"}),
            serde_json::json!({"type":"image"}),
            serde_json::json!({"type":"text","text":"B"}),
        ],
    );
}

#[test]
fn accepted_child_terminal_updates_only_the_current_retask_generation() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    for (tool_call_id, state) in [("task-old", "completed"), ("task-current", "running")] {
        snapshot.apply(&CanonicalEvent::Tool {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            tool_call_id: tool_call_id.to_string(),
            kind: ToolKind::Other,
            status: if state == "completed" {
                ToolCallStatus::Completed
            } else {
                ToolCallStatus::InProgress
            },
            title: "Research dependency options".to_string(),
            content: FieldUpdate::Set(format!("<task id=\"child-1\" state=\"{state}\">\n</task>")),
            structured_content: FieldUpdate::Set(Vec::new()),
            locations: FieldUpdate::Set(Vec::new()),
        });
    }
    for index in 0..=MAX_HISTORY_ENTRIES {
        snapshot.apply(&CanonicalEvent::MessageChunk {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            role: MessageRole::Agent,
            message_id: format!("rollover-{index:04}"),
            content: "x".to_string(),
            content_block: None,
        });
    }

    assert!(snapshot.mark_subagent_tool_terminal("task-current", "failed", ToolCallStatus::Failed,));
    assert_eq!(
        snapshot.subagent_header("task-old"),
        Some(r#"<task id="child-1" state="completed">"#),
    );
    assert_eq!(
        snapshot.subagent_header("task-current"),
        Some(r#"<task id="child-1" state="failed">"#),
    );
}

#[test]
fn cancelled_status_survives_authoritative_snapshot_normalization() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-1".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Research dependency options".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    assert!(snapshot.mark_subagent_terminal("child-1", "cancelled"));

    let durable = BridgeThreadSnapshot::from(snapshot);
    assert_eq!(durable.tools[0].status, ToolCallStatus::Failed);
    assert!(
        durable.tools[0]
            .content
            .starts_with("<task id=\"child-1\" state=\"cancelled\">\n"),
        "cancelled state collapsed to failed: {:?}",
        durable.tools[0],
    );
}

#[test]
fn snapshot_timeline_preserves_first_seen_canonical_order_across_updates() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    let message = |id: &str, role| CanonicalEvent::MessageChunk {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        role,
        message_id: id.to_string(),
        content: id.to_string(),
        content_block: None,
    };
    snapshot.apply(&message("message-a", MessageRole::Agent));
    snapshot.apply(&tool("tool-t", None, ToolCallStatus::InProgress));
    snapshot.apply(&message("message-b", MessageRole::Agent));
    snapshot.apply(&message("reasoning-r", MessageRole::Thought));
    snapshot.apply(&tool("tool-t", None, ToolCallStatus::Completed));

    assert_eq!(
        snapshot
            .timeline
            .iter()
            .map(|entry| (entry.sequence, entry.kind, entry.canonical_id.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (0, SnapshotTimelineKind::Message, "message-a"),
            (1, SnapshotTimelineKind::Tool, "tool-t"),
            (2, SnapshotTimelineKind::Message, "message-b"),
            (3, SnapshotTimelineKind::Reasoning, "reasoning-r"),
        ],
    );
}

#[test]
fn snapshot_applies_append_and_clear_updates_without_reordering_tool() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&tool("tool", None, ToolCallStatus::InProgress));
    let update = |content, structured_content, locations| CanonicalEvent::Tool {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        tool_call_id: "tool".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "title".to_string(),
        content,
        structured_content,
        locations,
    };
    snapshot.apply(&update(
        FieldUpdate::Append(" appended".to_string()),
        FieldUpdate::Append(vec![serde_json::json!({"type":"terminal"})]),
        FieldUpdate::Append(vec![serde_json::json!({"path":"file"})]),
    ));
    let updated = snapshot.tools.get("tool").unwrap();
    assert_eq!(updated.content, "content appended");
    assert_eq!(updated.structured_content.len(), 1);
    assert_eq!(updated.locations.len(), 1);

    snapshot.apply(&update(
        FieldUpdate::Clear,
        FieldUpdate::Clear,
        FieldUpdate::Clear,
    ));
    let cleared = snapshot.tools.get("tool").unwrap();
    assert!(cleared.content.is_empty());
    assert!(cleared.structured_content.is_empty());
    assert!(cleared.locations.is_empty());
    assert_eq!(snapshot.timeline.len(), 1);
}

#[test]
fn snapshot_timeline_bounds_and_saturates_sequence() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.next_sequence = u64::MAX;
    for index in 0..=MAX_TIMELINE_ENTRIES {
        snapshot.push_timeline(SnapshotTimelineKind::Message, format!("entry-{index}"));
    }
    assert_eq!(snapshot.timeline.len(), MAX_TIMELINE_ENTRIES);
    assert_eq!(snapshot.timeline.front().unwrap().canonical_id, "entry-1");
    assert_eq!(snapshot.next_sequence, u64::MAX);
    assert!(snapshot
        .timeline
        .iter()
        .all(|entry| entry.sequence == u64::MAX));
}

#[test]
fn checked_contract_snapshot_fixture_matches_rust_dto() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../contracts/bridge-rpc/v2/manifest.json"
    ))
    .unwrap();
    let mut snapshot = SessionSnapshot::new(
        "agent-alpha".to_string(),
        "agent-alpha:thread-snapshot".to_string(),
    );
    snapshot.title = Some("Typed ACP snapshot".to_string());
    snapshot.updated_at = Some("2026-07-19T00:00:00Z".to_string());
    snapshot.messages.push_back(SnapshotMessage {
        id: "message-1".to_string(),
        role: MessageRole::Agent,
        parts: vec![
            serde_json::json!({"type":"text","text":"Snapshot A"}),
            serde_json::json!({"type":"image","data":"aW1hZ2U=","mimeType":"image/png"}),
            serde_json::json!({"type":"text","text":"Snapshot B"}),
            serde_json::json!({"type":"resource","resource":{"uri":"file:///tmp/result.txt","text":"embedded result","mimeType":"text/plain"}}),
            serde_json::json!({"type":"audio","data":"YXVkaW8=","mimeType":"audio/wav"}),
        ],
        truncated: false,
        usage: Some(BridgeTurnUsageSnapshot {
            input_tokens: 4_100,
            output_tokens: 860,
            reasoning_tokens: Some(240),
            cached_read_tokens: Some(31_200),
            cached_write_tokens: Some(1_900),
            total_tokens: 38_300,
            model: Some("Example Model".to_string()),
        }),
        agent_message: None,
    });
    snapshot.messages.push_back(SnapshotMessage {
        id: "reasoning-1".to_string(),
        role: MessageRole::Thought,
        parts: vec![serde_json::json!({"type":"text","text":"Snapshot reasoning"})],
        truncated: false,
        usage: None,
        agent_message: None,
    });
    snapshot.timeline = VecDeque::from([
        SnapshotTimelineEntry {
            sequence: 0,
            kind: SnapshotTimelineKind::Message,
            canonical_id: "message-1".to_string(),
        },
        SnapshotTimelineEntry {
            sequence: 1,
            kind: SnapshotTimelineKind::Tool,
            canonical_id: "tool-1".to_string(),
        },
        SnapshotTimelineEntry {
            sequence: 2,
            kind: SnapshotTimelineKind::Reasoning,
            canonical_id: "reasoning-1".to_string(),
        },
    ]);
    snapshot.next_sequence = 3;
    snapshot.total_messages = 1;
    snapshot.total_reasoning = 1;
    snapshot.total_tools = 1;
    snapshot.tools.insert(
        "tool-1".to_string(),
        SnapshotTool {
            id: "tool-1".to_string(),
            generation: Some(7),
            kind: ToolKind::Read,
            status: ToolCallStatus::Completed,
            title: "Read file".to_string(),
            started_at_ms: 1_000,
            completed_at_ms: Some(2_000),
            content: "done".to_string(),
            structured_content: vec![
                serde_json::json!({"type":"content","content":{"type":"text","text":"structured"}}),
                serde_json::json!({"type":"diff","path":"src/file.ts","oldText":"old","newText":"new"}),
                serde_json::json!({"type":"terminal","terminalId":"terminal-1"}),
            ],
            locations: vec![serde_json::json!({"path":"src/file.ts","line":7})],
            truncated: false,
            subagent: false,
            interrupted: false,
        },
    );
    snapshot.plan = vec![PlanEntry {
        content: "Inspect state".to_string(),
        priority: "high".to_string(),
        status: "completed".to_string(),
    }];
    snapshot.usage_used = Some(120);
    snapshot.usage_size = Some(4096);
    snapshot.usage_cost = Some("$0.01".to_string());
    snapshot.token_totals = Some(BridgeTokenTotalsSnapshot {
        turns: 14,
        input_tokens: 48_200,
        output_tokens: 12_400,
        reasoning_tokens: Some(8_900),
        cached_read_tokens: Some(386_000),
        cached_write_tokens: Some(52_300),
        total_tokens: 507_800,
    });
    snapshot.mode_id = Some("plan".to_string());
    snapshot.config = vec![ConfigEntry {
        id: "model".to_string(),
        value: "example-model".to_string(),
        name: "Model".to_string(),
        description: None,
        category: Some("model".to_string()),
        options: Vec::new(),
    }];
    snapshot.commands = vec![
        CommandEntry {
            name: "test".to_string(),
            description: "Run tests".to_string(),
            hint: Some("[filter]".to_string()),
        },
        CommandEntry {
            name: "compact".to_string(),
            description: "Compact the conversation".to_string(),
            hint: None,
        },
    ];
    snapshot.active_run_id = Some("run-7".to_string());
    snapshot.active_source_turn_id = Some("turn-7".to_string());
    snapshot.active_generation = Some(7);
    snapshot.active_tool_ids.insert("tool-live".to_string());
    snapshot.history = VecDeque::from([
        SnapshotHistoryEntry {
            sequence: 0,
            kind: SnapshotTimelineKind::Message,
            canonical_id: "message-1".to_string(),
            message: snapshot.messages.front().cloned(),
            tool: None,
        },
        SnapshotHistoryEntry {
            sequence: 1,
            kind: SnapshotTimelineKind::Tool,
            canonical_id: "tool-1".to_string(),
            message: None,
            tool: snapshot.tools.get("tool-1").cloned(),
        },
        SnapshotHistoryEntry {
            sequence: 2,
            kind: SnapshotTimelineKind::Reasoning,
            canonical_id: "reasoning-1".to_string(),
            message: snapshot.messages.back().cloned(),
            tool: None,
        },
    ]);
    snapshot.remeasure_history();

    assert_eq!(
        serde_json::to_value(BridgeThreadSnapshot::from(snapshot)).unwrap(),
        manifest["fixtures"]["threadSnapshot"]["acpSnapshot"],
    );
}

#[test]
fn snapshot_pages_typed_history_and_reports_irretrievable_eviction() {
    let mut snapshot = SessionSnapshot::new("agent".into(), "thread".into());
    for index in 0..=MAX_HISTORY_ENTRIES {
        snapshot.append_message(
            format!("message-{index}"),
            if index % 2 == 0 {
                MessageRole::Agent
            } else {
                MessageRole::Thought
            },
            "x".into(),
            None,
        );
    }
    let metadata = snapshot.collection_metadata(SnapshotTimelineKind::Message);
    assert!(metadata.truncated);
    assert!(metadata.omitted_count > 0);
    assert!(snapshot.continuation().unavailable_count > 0);

    let before_cursor = metadata.before_cursor.as_deref().unwrap();
    let older = snapshot
        .page(Some(before_cursor), None, MAX_SNAPSHOT_PAGE_SIZE + 1)
        .unwrap();
    assert!(older.entries.len() <= MAX_SNAPSHOT_PAGE_SIZE);
    assert!(older.entries.iter().all(|entry| entry.message.is_some()));
    assert!(older
        .entries
        .last()
        .is_some_and(|entry| entry.sequence < metadata.oldest_available_sequence.unwrap()));
    assert!(snapshot.page(Some("invalid"), None, 1).is_err());
    assert!(snapshot.page(Some("invalid"), Some("invalid"), 1).is_err());
}

#[test]
fn snapshot_page_cursors_cover_forward_empty_and_revision_validation() {
    let mut snapshot = SessionSnapshot::new("agent".into(), "thread".into());
    snapshot.append_message("message".into(), MessageRole::Agent, "answer".into(), None);
    snapshot.append_message(
        "reasoning".into(),
        MessageRole::Thought,
        "thought".into(),
        None,
    );
    snapshot.apply(&tool("tool", None, ToolCallStatus::Completed));

    let first = snapshot.page(None, None, 0).unwrap();
    assert_eq!(first.entries.len(), 1);
    assert!(first.has_more_after);
    assert!(!first.has_more_before);
    let reverse = snapshot
        .page(first.after_cursor.as_deref(), None, 1)
        .unwrap();
    assert!(reverse.entries.is_empty());
    let forward = snapshot
        .page(None, first.after_cursor.as_deref(), MAX_SNAPSHOT_PAGE_SIZE)
        .unwrap();
    assert_eq!(forward.entries.len(), 2);
    assert!(forward.has_more_before);
    assert!(forward
        .entries
        .iter()
        .any(|entry| entry.kind == SnapshotTimelineKind::Reasoning));
    assert!(forward
        .entries
        .iter()
        .any(|entry| entry.kind == SnapshotTimelineKind::Tool));
    assert!(!forward.has_more_after);

    let empty = snapshot
        .page(None, forward.after_cursor.as_deref(), 10)
        .unwrap();
    assert!(empty.entries.is_empty());
    assert!(empty.before_cursor.is_none());
    assert!(empty.after_cursor.is_none());
    assert!(!empty.has_more_before);
    assert!(!empty.has_more_after);

    let wrong_thread = SessionSnapshot::new("agent".into(), "other".into()).cursor(0);
    assert!(snapshot.page(Some(&wrong_thread), None, 1).is_err());
    let future_revision = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&SnapshotCursor {
            thread_id: "thread".into(),
            sequence: 0,
            revision: snapshot.next_sequence + 1,
        })
        .unwrap(),
    );
    assert!(snapshot.page(None, Some(&future_revision), 1).is_err());
    assert!(snapshot.page(None, Some("%%%"), 1).is_err());

    for kind in [
        SnapshotTimelineKind::Message,
        SnapshotTimelineKind::Reasoning,
        SnapshotTimelineKind::Tool,
    ] {
        let metadata = snapshot.collection_metadata(kind);
        assert!(!metadata.truncated);
        assert_eq!(metadata.omitted_count, 0);
        assert!(metadata.oldest_available_sequence.is_some());
        assert!(metadata.newest_sequence.is_some());
    }
}

#[test]
fn empty_snapshot_and_before_earliest_cursor_report_no_available_entries() {
    let empty = SessionSnapshot::new("agent".into(), "empty".into());
    let continuation = empty.continuation();
    assert_eq!(continuation.unavailable_count, 0);
    assert_eq!(continuation.earliest_available_sequence, None);
    assert_eq!(continuation.latest_available_sequence, None);
    for kind in [
        SnapshotTimelineKind::Message,
        SnapshotTimelineKind::Reasoning,
        SnapshotTimelineKind::Tool,
    ] {
        let metadata = empty.collection_metadata(kind);
        assert!(!metadata.truncated);
        assert_eq!(metadata.omitted_count, 0);
        assert_eq!(metadata.oldest_available_sequence, None);
        assert_eq!(metadata.newest_sequence, None);
        assert_eq!(metadata.before_cursor, None);
    }
    let page = empty.page(None, None, 0).unwrap();
    assert!(page.entries.is_empty());
    assert!(!page.has_more_before);
    assert!(!page.has_more_after);

    let malformed_json = URL_SAFE_NO_PAD.encode(b"not-json");
    assert!(empty.page(Some(&malformed_json), None, 1).is_err());

    let mut populated = SessionSnapshot::new("agent".into(), "thread".into());
    populated.append_message("message".into(), MessageRole::Agent, "answer".into(), None);
    let before_earliest = populated.cursor(populated.history.front().unwrap().sequence);
    let page = populated.page(Some(&before_earliest), None, 1).unwrap();
    assert!(page.entries.is_empty());
    assert!(page.before_cursor.is_none());
    assert!(page.after_cursor.is_none());
}

#[test]
fn history_eviction_accounts_for_each_timeline_kind() {
    let cases = [
        (SnapshotTimelineKind::Message, MessageRole::Agent),
        (SnapshotTimelineKind::Reasoning, MessageRole::Thought),
    ];
    for (kind, role) in cases {
        let mut snapshot = SessionSnapshot::new("agent".into(), "thread".into());
        snapshot.push_timeline(kind, "entry".into());
        snapshot.attach_history_message(SnapshotMessage {
            id: "entry".into(),
            role,
            parts: vec![serde_json::json!({"type":"text","text":"x"})],
            truncated: false,
            usage: None,
            agent_message: None,
        });
        snapshot.history_bytes = MAX_HISTORY_BYTES + 1;
        snapshot.enforce_history_bounds();
        assert_eq!(snapshot.continuation().unavailable_count, 1);
    }

    let mut tools = SessionSnapshot::new("agent".into(), "thread".into());
    tools.push_timeline(SnapshotTimelineKind::Tool, "tool".into());
    tools.attach_or_update_history_tool(SnapshotTool {
        id: "tool".into(),
        generation: None,
        kind: ToolKind::Read,
        status: ToolCallStatus::Completed,
        title: "Read".into(),
        started_at_ms: 1_000,
        completed_at_ms: Some(2_000),
        content: String::new(),
        structured_content: Vec::new(),
        locations: Vec::new(),
        truncated: false,
        subagent: false,
        interrupted: false,
    });
    tools.history_bytes = MAX_HISTORY_BYTES + 1;
    tools.enforce_history_bounds();
    assert_eq!(tools.continuation().unavailable_count, 1);

    let mut absent = SessionSnapshot::new("agent".into(), "absent".into());
    absent.update_history_message(&SnapshotMessage {
        id: "missing-message".into(),
        role: MessageRole::Agent,
        parts: Vec::new(),
        truncated: false,
        usage: None,
        agent_message: None,
    });
    absent.attach_or_update_history_tool(SnapshotTool {
        id: "missing-tool".into(),
        generation: None,
        kind: ToolKind::Read,
        status: ToolCallStatus::Completed,
        title: "Read".into(),
        started_at_ms: 1_000,
        completed_at_ms: Some(2_000),
        content: String::new(),
        structured_content: Vec::new(),
        locations: Vec::new(),
        truncated: false,
        subagent: false,
        interrupted: false,
    });
    assert!(absent.history.is_empty());
}

#[test]
fn streaming_message_updates_only_remeasure_the_changed_history_entry() {
    let mut snapshot = SessionSnapshot::new("agent".into(), "thread".into());
    for index in 0..64 {
        snapshot.append_message(
            format!("message-{index}"),
            MessageRole::Agent,
            "seed".into(),
            None,
        );
    }

    HISTORY_ENTRY_MEASUREMENTS.with(|measurements| measurements.set(0));
    snapshot.append_message(
        "message-63".into(),
        MessageRole::Agent,
        " delta".into(),
        None,
    );

    let measurements = HISTORY_ENTRY_MEASUREMENTS.with(std::cell::Cell::get);
    assert_eq!(measurements, 2);
    assert_eq!(
        snapshot.history_bytes,
        snapshot
            .history
            .iter()
            .map(history_entry_bytes)
            .sum::<usize>(),
    );
}

#[test]
fn snapshot_bounds_collections_fields_and_unicode_text() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    for index in 0..=MAX_MESSAGES {
        snapshot.apply(&CanonicalEvent::MessageChunk {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role: MessageRole::User,
            message_id: format!("message-{index}"),
            content: "x".to_string(),
            content_block: None,
        });
    }

    for index in 0..=MAX_TOOLS {
        snapshot.apply(&tool(
            &format!("tool-{index:03}"),
            None,
            ToolCallStatus::Pending,
        ));
    }
    assert_eq!(snapshot.messages.len(), MAX_MESSAGES);
    assert_eq!(snapshot.messages.front().unwrap().id, "message-1");
    assert_eq!(snapshot.tools.len(), MAX_TOOLS);
    assert!(!snapshot.tools.contains_key("tool-000"));
    snapshot.apply(&tool(
        &format!("tool-{MAX_TOOLS:03}"),
        None,
        ToolCallStatus::Completed,
    ));
    assert_eq!(snapshot.tools.len(), MAX_TOOLS);
    assert_eq!(
        snapshot.tools[&format!("tool-{MAX_TOOLS:03}")].status,
        ToolCallStatus::Completed,
    );

    let mut nonlexical = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    nonlexical.active_generation = Some(1);
    nonlexical.apply(&tool("z-oldest", Some(1), ToolCallStatus::InProgress));
    nonlexical.apply(&tool("z-oldest", Some(1), ToolCallStatus::InProgress));
    for index in 1..MAX_TOOLS {
        nonlexical.apply(&tool(
            &format!("a-newer-{index:03}"),
            Some(1),
            ToolCallStatus::Pending,
        ));
    }
    nonlexical.apply(&tool("m-newest", Some(1), ToolCallStatus::Pending));
    assert!(!nonlexical.tools.contains_key("z-oldest"));
    assert!(nonlexical.active_tool_ids.contains("z-oldest"));
    assert!(nonlexical.history.iter().any(|entry| {
        entry.canonical_id == "z-oldest"
            && entry
                .tool
                .as_ref()
                .is_some_and(|tool| tool.status == ToolCallStatus::InProgress)
    }));
    assert!(nonlexical.tools.contains_key("a-newer-001"));
    assert!(nonlexical.tools.contains_key("m-newest"));
    assert_eq!(
        nonlexical
            .timeline
            .iter()
            .filter(|entry| entry.canonical_id == "z-oldest")
            .count(),
        0,
    );
    assert_eq!(nonlexical.timeline.len(), MAX_TOOLS);

    let unicode = format!("{}é", "x".repeat(MAX_TEXT_BYTES - 1));
    snapshot.apply(&CanonicalEvent::Mode {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        id: unicode,
    });
    assert_eq!(
        snapshot.mode_id.as_deref().unwrap().len(),
        MAX_TEXT_BYTES - 1,
    );

    snapshot.title = Some("old".to_string());
    snapshot.updated_at = Some("old".to_string());
    let mut empty_metadata = SessionSnapshot::new("agent".to_string(), "empty".to_string());
    empty_metadata.apply(&CanonicalEvent::SessionInfo {
        agent_id: "agent".to_string(),
        thread_id: "empty".to_string(),
        title: FieldUpdate::Append("title".to_string()),
        updated_at: FieldUpdate::Append("time".to_string()),
    });
    assert_eq!(empty_metadata.title.as_deref(), Some("title"));
    assert_eq!(empty_metadata.updated_at.as_deref(), Some("time"));
    snapshot.apply(&CanonicalEvent::SessionInfo {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        title: FieldUpdate::Unchanged,
        updated_at: FieldUpdate::Clear,
    });
    snapshot.apply(&CanonicalEvent::SessionInfo {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        title: FieldUpdate::Set("new".to_string()),
        updated_at: FieldUpdate::Set("now".to_string()),
    });
    snapshot.apply(&CanonicalEvent::SessionInfo {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        title: FieldUpdate::Append(" title".to_string()),
        updated_at: FieldUpdate::Append(" later".to_string()),
    });
    assert_eq!(snapshot.title.as_deref(), Some("new title"));
    assert_eq!(snapshot.updated_at.as_deref(), Some("now later"));
}

#[test]
fn snapshot_bounds_thousands_of_incremental_message_and_reasoning_chunks() {
    let mut snapshot = SessionSnapshot::new("agent".into(), "thread".into());
    for role in [MessageRole::Agent, MessageRole::Thought] {
        let id = format!("{role:?}");
        for _ in 0..2_000 {
            snapshot.apply(&CanonicalEvent::MessageChunk {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role,
                message_id: id.clone(),
                content: "é".repeat(128),
                content_block: None,
            });
        }
        let message = snapshot
            .messages
            .iter()
            .find(|message| message.id == id)
            .unwrap();
        let text = message.parts[0]["text"].as_str().unwrap();
        assert!(text.len() <= MAX_TEXT_BYTES);
        assert!(text.is_char_boundary(text.len()));
        assert!(message.truncated);
    }
}

#[test]
fn snapshot_bounds_mixed_parts_tool_fields_and_preserves_terminal_items() {
    let mut snapshot = SessionSnapshot::new("agent".into(), "thread".into());
    for index in 0..1_000 {
        snapshot.append_message(
            "mixed".into(),
            MessageRole::Agent,
            String::new(),
            Some(serde_json::json!({
                "type": "resource",
                "field": index,
                "text": "x".repeat(MAX_STRUCTURED_PART_BYTES * 2),
                "rawOutput": "secret"
            })),
        );
    }
    let message = snapshot.messages.back().unwrap();
    assert!(message.parts.len() <= MAX_MESSAGE_PARTS);
    assert!(message.truncated);
    assert!(!serde_json::to_string(message).unwrap().contains("secret"));

    for index in 0..1_000 {
        snapshot.apply_tool(
            "tool",
            None,
            index,
            ToolProjection {
                kind: &ToolKind::Execute,
                status: if index == 999 {
                    &ToolCallStatus::Completed
                } else {
                    &ToolCallStatus::InProgress
                },
                title: "terminal",
                content: &FieldUpdate::Append("é".repeat(256)),
                structured_content: &FieldUpdate::Append(vec![serde_json::json!({
                    "type": if index == 999 { "terminal" } else { "diff" },
                    "terminalId": "terminal-1",
                    "oldText": "x".repeat(MAX_STRUCTURED_PART_BYTES * 2),
                    "rawInput": "secret"
                })]),
                locations: &FieldUpdate::Append(vec![serde_json::json!({
                    "path": "x".repeat(MAX_STRUCTURED_PART_BYTES * 2),
                    "line": index,
                    "rawOutput": "secret"
                })]),
            },
        );
    }
    let tool = &snapshot.tools["tool"];
    assert!(tool.content.len() <= MAX_TOOL_TEXT_BYTES);
    assert!(tool.structured_content.len() <= MAX_TOOL_STRUCTURED_ITEMS);
    assert!(tool.locations.len() <= MAX_TOOL_LOCATIONS);
    assert!(tool.truncated);
    assert!(!serde_json::to_string(tool).unwrap().contains("secret"));
    assert_eq!(tool.status, ToolCallStatus::Completed);
}

#[test]
fn accumulator_helpers_cover_clear_unchanged_exact_and_overflow_paths() {
    let mut parts = Vec::new();
    assert!(!append_message_text(&mut parts, "x".repeat(MAX_TEXT_BYTES)));
    assert!(append_message_text(&mut parts, "more".into()));
    parts.resize(MAX_MESSAGE_PARTS, serde_json::Value::Null);
    assert!(append_message_text(&mut parts, "new part".into()));
    assert!(append_structured_part(
        &mut parts,
        serde_json::json!({"ok": true})
    ));

    let mut text = "existing".to_string();
    assert!(!apply_tool_text(&mut text, &FieldUpdate::Unchanged));
    assert!(!apply_tool_text(&mut text, &FieldUpdate::Clear));
    assert!(text.is_empty());
    assert!(apply_tool_text(
        &mut text,
        &FieldUpdate::Set("x".repeat(MAX_TOOL_TEXT_BYTES + 1))
    ));
    assert!(apply_tool_text(
        &mut text,
        &FieldUpdate::Append("more".into())
    ));

    let mut values = vec![serde_json::json!({"old": true})];
    assert!(!apply_tool_values(&mut values, &FieldUpdate::Unchanged, 2));
    assert!(!apply_tool_values(&mut values, &FieldUpdate::Clear, 2));
    assert!(values.is_empty());
    assert!(apply_tool_values(
        &mut values,
        &FieldUpdate::Set(vec![
            serde_json::json!({"one": 1}),
            serde_json::json!({"two": 2}),
            serde_json::json!({"three": 3}),
        ]),
        2,
    ));

    let oversized_array = serde_json::Value::Array(
        (0..=MAX_STRUCTURED_FIELDS)
            .map(serde_json::Value::from)
            .collect(),
    );
    let (_, array_truncated) = bound_json(
        oversized_array,
        MAX_STRUCTURED_PART_BYTES,
        MAX_STRUCTURED_FIELDS,
    );
    assert!(array_truncated);
    let oversized_object = serde_json::Value::Object(
        (0..=MAX_STRUCTURED_FIELDS)
            .map(|index| (format!("key-{index}"), serde_json::Value::from(index)))
            .collect(),
    );
    let (_, object_truncated) = bound_json(
        oversized_object,
        MAX_STRUCTURED_PART_BYTES,
        MAX_STRUCTURED_FIELDS,
    );
    assert!(object_truncated);
}

#[test]
fn snapshot_applies_plan_config_commands_usage_and_ignored_events() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    let oversized = "x".repeat(MAX_TEXT_BYTES + 1);
    snapshot.apply(&CanonicalEvent::Plan {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        entries: vec![
            PlanEntry {
                content: oversized.clone(),
                priority: oversized.clone(),
                status: oversized.clone(),
            };
            MAX_ENTRIES + 1
        ],
    });
    snapshot.apply(&CanonicalEvent::Config {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        entries: vec![
            ConfigEntry {
                id: oversized.clone(),
                value: oversized.clone(),
                name: oversized.clone(),
                description: None,
                category: None,
                options: Vec::new(),
            };
            MAX_ENTRIES + 1
        ],
    });
    snapshot.apply(&CanonicalEvent::Commands {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        commands: vec![
            CommandEntry {
                name: oversized.clone(),
                description: oversized.clone(),
                hint: Some(oversized.clone()),
            };
            MAX_ENTRIES + 1
        ],
    });
    snapshot.apply(&CanonicalEvent::Usage {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        used: 3,
        size: 10,
        cost: Some(oversized),
    });
    snapshot.apply(&CanonicalEvent::Ignored {
        agent_id: "agent".to_string(),
        thread_id: Some("thread".to_string()),
        kind: "ignored".to_string(),
    });
    assert_eq!(snapshot.plan.len(), MAX_ENTRIES);
    assert_eq!(snapshot.config.len(), MAX_ENTRIES);
    assert_eq!(snapshot.commands.len(), MAX_ENTRIES);
    assert_eq!(snapshot.plan[0].content.len(), MAX_TEXT_BYTES);
    assert_eq!(snapshot.config[0].id.len(), MAX_TEXT_BYTES);
    assert_eq!(snapshot.commands[0].name.len(), MAX_TEXT_BYTES);
    assert_eq!(
        snapshot.commands[0].hint.as_deref().map(str::len),
        Some(MAX_TEXT_BYTES),
    );
    assert_eq!(snapshot.usage_used, Some(3));
    assert_eq!(snapshot.usage_size, Some(10));
    assert_eq!(
        snapshot.usage_cost.as_deref().unwrap().len(),
        MAX_TEXT_BYTES,
    );
}

#[test]
fn snapshot_without_turn_usage_exposes_null_token_totals() {
    let snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());

    assert_eq!(
        serde_json::to_value(BridgeThreadSnapshot::from(snapshot)).unwrap()["tokenTotals"],
        serde_json::Value::Null,
    );
}

#[test]
fn snapshot_accumulates_turn_usage_and_preserves_unreported_optional_fields() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    let usage = |input_tokens,
                 output_tokens,
                 reasoning_tokens,
                 cached_read_tokens,
                 cached_write_tokens,
                 total_tokens| CanonicalEvent::TurnTokenUsage {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cached_read_tokens,
        cached_write_tokens,
        total_tokens,
    };

    snapshot.apply(&usage(10, 5, None, None, None, 15));
    let first = snapshot.token_totals.as_ref().unwrap();
    assert_eq!(first.reasoning_tokens, None);
    assert_eq!(first.cached_read_tokens, None);
    assert_eq!(first.cached_write_tokens, None);

    snapshot.apply(&usage(20, 7, Some(3), Some(11), Some(2), 43));
    snapshot.apply(&usage(4, 1, None, None, None, 5));

    let totals = snapshot.token_totals.as_ref().unwrap();
    assert_eq!(
        totals,
        &BridgeTokenTotalsSnapshot {
            turns: 3,
            input_tokens: 34,
            output_tokens: 13,
            reasoning_tokens: Some(3),
            cached_read_tokens: Some(11),
            cached_write_tokens: Some(2),
            total_tokens: 63,
        },
    );
    assert_eq!(
        serde_json::to_value(BridgeThreadSnapshot::from(snapshot)).unwrap()["tokenTotals"],
        serde_json::json!({
            "turns": 3,
            "inputTokens": 34,
            "outputTokens": 13,
            "reasoningTokens": 3,
            "cachedReadTokens": 11,
            "cachedWriteTokens": 2,
            "totalTokens": 63,
        }),
    );
}

#[test]
fn turn_usage_attaches_to_the_agent_message_the_turn_ended_on() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    let chunk = |role, message_id: &str, content: &str| CanonicalEvent::MessageChunk {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        role,
        message_id: message_id.to_string(),
        content: content.to_string(),
        content_block: None,
    };
    snapshot.apply(&CanonicalEvent::Config {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        entries: vec![ConfigEntry {
            id: "model".to_string(),
            value: "gpt-5.6-sol".to_string(),
            name: "Model".to_string(),
            description: None,
            category: Some("model".to_string()),
            options: vec![ConfigOptionValue {
                value: "gpt-5.6-sol".to_string(),
                name: "GPT-5.6 Sol".to_string(),
                description: None,
            }],
        }],
    });
    snapshot.apply(&chunk(MessageRole::User, "user-1", "hi"));
    snapshot.apply(&chunk(MessageRole::Agent, "agent-1", "first"));
    snapshot.apply(&CanonicalEvent::TurnTokenUsage {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        input_tokens: 120,
        output_tokens: 40,
        reasoning_tokens: Some(12),
        cached_read_tokens: Some(880),
        cached_write_tokens: None,
        total_tokens: 1_040,
    });

    let first = snapshot
        .messages
        .iter()
        .find(|message| message.id == "agent-1")
        .unwrap();
    assert_eq!(
        first.usage,
        Some(BridgeTurnUsageSnapshot {
            input_tokens: 120,
            output_tokens: 40,
            reasoning_tokens: Some(12),
            cached_read_tokens: Some(880),
            cached_write_tokens: None,
            total_tokens: 1_040,
            model: Some("GPT-5.6 Sol".to_string()),
        }),
    );
    // A user message never anchors the affordance, and the second turn must not overwrite the
    // first response's cost.
    assert!(snapshot
        .messages
        .iter()
        .find(|message| message.id == "user-1")
        .unwrap()
        .usage
        .is_none());

    snapshot.apply(&chunk(MessageRole::Agent, "agent-2", "second"));
    snapshot.apply(&CanonicalEvent::TurnTokenUsage {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        input_tokens: 7,
        output_tokens: 3,
        reasoning_tokens: None,
        cached_read_tokens: None,
        cached_write_tokens: None,
        total_tokens: 10,
    });

    let messages = &snapshot.messages;
    assert_eq!(
        messages
            .iter()
            .find(|message| message.id == "agent-1")
            .unwrap()
            .usage
            .as_ref()
            .unwrap()
            .input_tokens,
        120,
    );
    assert_eq!(
        messages
            .iter()
            .find(|message| message.id == "agent-2")
            .unwrap()
            .usage
            .as_ref()
            .unwrap()
            .input_tokens,
        7,
    );
    assert_eq!(
        serde_json::to_value(BridgeThreadSnapshot::from(snapshot)).unwrap()["messages"][2]["usage"],
        serde_json::json!({
            "inputTokens": 7,
            "outputTokens": 3,
            "reasoningTokens": null,
            "cachedReadTokens": null,
            "cachedWriteTokens": null,
            "totalTokens": 10,
            "model": "GPT-5.6 Sol",
        }),
    );
}

#[test]
fn turn_usage_falls_back_to_the_model_identifier_and_tolerates_a_response_less_turn() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&CanonicalEvent::Config {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        entries: vec![ConfigEntry {
            id: "model".to_string(),
            value: "opaque-model".to_string(),
            name: "Model".to_string(),
            description: None,
            category: None,
            options: Vec::new(),
        }],
    });
    let usage = CanonicalEvent::TurnTokenUsage {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        input_tokens: 5,
        output_tokens: 2,
        reasoning_tokens: None,
        cached_read_tokens: None,
        cached_write_tokens: None,
        total_tokens: 7,
    };

    // No agent message has landed yet, so there is nothing to anchor the report to.
    snapshot.apply(&usage);
    assert!(snapshot.messages.is_empty());

    snapshot.apply(&CanonicalEvent::MessageChunk {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        role: MessageRole::Agent,
        message_id: "agent-1".to_string(),
        content: "answer".to_string(),
        content_block: None,
    });
    snapshot.apply(&usage);

    assert_eq!(
        snapshot
            .messages
            .back()
            .unwrap()
            .usage
            .as_ref()
            .unwrap()
            .model,
        Some("opaque-model".to_string()),
    );
}

#[test]
fn turn_usage_reaches_the_paged_history_copy_of_the_response() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&CanonicalEvent::MessageChunk {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        role: MessageRole::Agent,
        message_id: "agent-1".to_string(),
        content: "answer".to_string(),
        content_block: None,
    });
    snapshot.apply(&CanonicalEvent::TurnTokenUsage {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        input_tokens: 9,
        output_tokens: 4,
        reasoning_tokens: None,
        cached_read_tokens: Some(1),
        cached_write_tokens: None,
        total_tokens: 14,
    });

    let page = snapshot.page(None, None, MAX_SNAPSHOT_PAGE_SIZE).unwrap();
    let entry = page
        .entries
        .iter()
        .find(|entry| entry.canonical_id == "agent-1")
        .unwrap();
    assert_eq!(
        entry
            .message
            .as_ref()
            .unwrap()
            .usage
            .as_ref()
            .unwrap()
            .total_tokens,
        14,
    );
}

#[test]
fn fork_boundary_uses_complete_history_after_live_messages_roll_over() {
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    for index in 0..=MAX_MESSAGES {
        snapshot.apply(&CanonicalEvent::MessageChunk {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role: if index % 2 == 0 {
                MessageRole::User
            } else {
                MessageRole::Agent
            },
            message_id: format!("message-{index}"),
            content: format!("content-{index}"),
            content_block: None,
        });
    }

    assert!(snapshot
        .messages
        .iter()
        .all(|message| message.id != "message-0"));
    assert_eq!(
        snapshot.complete_fork_boundary("message-126"),
        Some(ForkBoundary {
            ordinal: 63,
            kind: ForkBoundaryKind::BeforeRequest(ForkBoundaryMessage {
                message_id: "message-126".to_string(),
                first_text: "content-126".to_string(),
                first_text_truncated: false,
                raw_message_id_hint: None,
            }),
        }),
    );
}

#[test]
fn replayed_agent_messages_keep_timeline_order_without_becoming_fork_turns() {
    let message = |id: &str, role| CanonicalEvent::MessageChunk {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        role,
        message_id: id.to_string(),
        content: id.to_string(),
        content_block: None,
    };
    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&message("user-1", MessageRole::User));
    snapshot.apply(&message("agent-1", MessageRole::Agent));
    snapshot.apply(&tool("tool-1", None, ToolCallStatus::Completed));
    let anchor = snapshot
        .latest_timeline_canonical_id()
        .expect("timeline anchor")
        .to_string();
    snapshot.apply(&message("user-2", MessageRole::User));
    snapshot.apply(&message("agent-2", MessageRole::Agent));
    let agent_message = |message_id: &str, body: &str| crate::agent_messaging::AgentMessageOrigin {
        message_id: message_id.to_string(),
        direction: crate::agent_messaging::AgentMessageDirection::Sent,
        related_thread_id: "child".to_string(),
        related_title: Some("Worker".to_string()),
        relation: crate::agent_messaging::AgentRelationKind::SubAgent,
        disposition: crate::agent_messaging::AgentMessageDisposition::Sent,
        body: body.to_string(),
    };
    snapshot.append_agent_message_after(
        agent_message("message-1", "Inspect the queue."),
        Some(&anchor),
    );
    snapshot.append_agent_message_after(
        agent_message("message-2", "Report the result."),
        Some(&anchor),
    );
    snapshot.append_agent_message_after(
        agent_message("message-3", "Confirm completion."),
        Some(&anchor),
    );

    assert_eq!(
        snapshot
            .timeline
            .iter()
            .map(|entry| entry.canonical_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "user-1",
            "agent-1",
            "tool-1",
            "agent-message:message-1",
            "agent-message:message-2",
            "agent-message:message-3",
            "user-2",
            "agent-2"
        ],
    );

    let mut live_snapshot = SessionSnapshot::new("agent".to_string(), "live-thread".to_string());
    live_snapshot.apply(&message("live-user", MessageRole::User));
    live_snapshot.append_agent_message(agent_message("live-message", "Continue."));
    assert_eq!(
        live_snapshot.latest_timeline_canonical_id(),
        Some("agent-message:live-message"),
    );
    assert_eq!(
        snapshot
            .timeline
            .iter()
            .map(|entry| entry.sequence)
            .collect::<Vec<_>>(),
        vec![0, 1, 2, 3, 4, 5, 6, 7],
    );
    assert_eq!(
        snapshot
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "user-1",
            "agent-1",
            "agent-message:message-1",
            "agent-message:message-2",
            "agent-message:message-3",
            "user-2",
            "agent-2"
        ],
    );
    assert_eq!(
        snapshot.complete_fork_boundary("user-2"),
        Some(ForkBoundary {
            ordinal: 1,
            kind: ForkBoundaryKind::BeforeRequest(ForkBoundaryMessage {
                message_id: "user-2".to_string(),
                first_text: "user-2".to_string(),
                first_text_truncated: false,
                raw_message_id_hint: None,
            }),
        }),
    );
    assert!(snapshot
        .complete_fork_boundary("agent-message:message-1")
        .is_none());
}

#[test]
fn fork_boundary_fails_closed_for_incomplete_history_and_skips_non_user_entries() {
    let message = |id: &str, role| CanonicalEvent::MessageChunk {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        role,
        message_id: id.to_string(),
        content: id.to_string(),
        content_block: None,
    };

    let mut unavailable = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    unavailable.apply(&message("user", MessageRole::User));
    unavailable.unavailable_count = 1;
    assert!(unavailable.complete_fork_boundary("user").is_none());

    let mut shifted = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    shifted.apply(&message("user", MessageRole::User));
    shifted.history.front_mut().expect("history entry").sequence = 1;
    assert!(shifted.complete_fork_boundary("user").is_none());

    let mut mixed = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    mixed.apply(&tool("tool", None, ToolCallStatus::Completed));
    mixed.apply(&message("agent-message", MessageRole::Agent));
    mixed.apply(&message("user-message", MessageRole::User));
    mixed
        .history
        .iter_mut()
        .find(|entry| entry.canonical_id == "agent-message")
        .expect("agent history")
        .message = None;
    assert_eq!(
        mixed.complete_fork_boundary("user-message"),
        Some(ForkBoundary {
            ordinal: 0,
            kind: ForkBoundaryKind::BeforeRequest(ForkBoundaryMessage {
                message_id: "user-message".to_string(),
                first_text: "user-message".to_string(),
                first_text_truncated: false,
                raw_message_id_hint: None,
            }),
        }),
    );
    assert!(mixed.complete_fork_boundary("missing-message").is_none());
}

#[test]
fn fork_boundary_named_by_a_response_keeps_that_turn() {
    let message = |id: &str, role| CanonicalEvent::MessageChunk {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        role,
        message_id: id.to_string(),
        content: id.to_string(),
        content_block: None,
    };

    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&message("user-1", MessageRole::User));
    snapshot.apply(&message("agent-1", MessageRole::Agent));
    snapshot.apply(&message("user-2", MessageRole::User));
    snapshot.apply(&message("agent-2", MessageRole::Agent));

    // An earlier response resolves to the request that follows it, which is the same boundary
    // the older "name the next request" clients send.
    assert_eq!(
        snapshot.complete_fork_boundary("agent-1"),
        Some(ForkBoundary {
            ordinal: 1,
            kind: ForkBoundaryKind::BeforeRequest(ForkBoundaryMessage {
                message_id: "user-2".to_string(),
                first_text: "user-2".to_string(),
                first_text_truncated: false,
                raw_message_id_hint: None,
            }),
        }),
    );
    // The newest response has no later request, so the boundary is the end of the conversation
    // and every recorded turn is kept.
    assert_eq!(
        snapshot.complete_fork_boundary("agent-2"),
        Some(ForkBoundary {
            ordinal: 2,
            kind: ForkBoundaryKind::EndOfHistory {
                newest_request: ForkBoundaryMessage {
                    message_id: "user-2".to_string(),
                    first_text: "user-2".to_string(),
                    first_text_truncated: false,
                    raw_message_id_hint: None,
                },
            },
        }),
    );
}

#[test]
fn fork_boundary_rejects_a_response_that_precedes_every_request() {
    let message = |id: &str, role| CanonicalEvent::MessageChunk {
        agent_id: "agent".to_string(),
        thread_id: "thread".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        role,
        message_id: id.to_string(),
        content: id.to_string(),
        content_block: None,
    };

    let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
    snapshot.apply(&message("agent-greeting", MessageRole::Agent));
    snapshot.apply(&message("user-1", MessageRole::User));

    assert_eq!(
        snapshot.complete_fork_boundary("agent-greeting"),
        Some(ForkBoundary {
            ordinal: 0,
            kind: ForkBoundaryKind::BeforeRequest(ForkBoundaryMessage {
                message_id: "user-1".to_string(),
                first_text: "user-1".to_string(),
                first_text_truncated: false,
                raw_message_id_hint: None,
            }),
        }),
    );
}

#[test]
fn fork_boundary_accepts_live_wrapped_opencode_ids_and_preserves_the_raw_identity() {
    let mut snapshot = SessionSnapshot::new("opencode".to_string(), "thread".to_string());
    for (id, content) in [("msg_first", "first"), ("msg_boundary", "second")] {
        snapshot.apply(&CanonicalEvent::MessageChunk {
            agent_id: "opencode".to_string(),
            thread_id: "thread".to_string(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role: MessageRole::User,
            message_id: id.to_string(),
            content: content.to_string(),
            content_block: None,
        });
    }

    assert_eq!(
        snapshot.complete_fork_boundary("thread::item::msg_boundary"),
        Some(ForkBoundary {
            ordinal: 1,
            kind: ForkBoundaryKind::BeforeRequest(ForkBoundaryMessage {
                message_id: "msg_boundary".to_string(),
                first_text: "second".to_string(),
                first_text_truncated: false,
                raw_message_id_hint: Some("msg_boundary".to_string()),
            }),
        }),
    );
}
