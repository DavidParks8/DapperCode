use super::{
    apply_structured_updates, bounded, canonical_run_mut, discovered_subagent_session, envelope,
    field_value, generated_event, json, linked_subagent_activity_envelope,
    messages_snapshot_envelope, parse_task_header, parse_task_subagent, snapshot_content_lines,
    subagent_activity_envelope, summarize_task_result, task_progress_preview, tool_snapshot_text,
    utf8_chunks, AgUiEvent, AgUiEventContent, AgUiEventEnvelope, AgUiEventRole, AgUiEventType,
    AgUiProjector, AgUiRunState, AgentSessionId, CanonicalEvent, CanonicalProjection, ClientHub,
    Delta, FieldUpdate, HashMap, HashSet, MessageRole, PendingApproval, PendingApprovalOption,
    PendingUserInputQuestion, PendingUserInputQuestionOption, PendingUserInputRequest,
    SnapshotTool, SubagentActivityContext, Value, AG_UI_EVENT_METHOD, CLOSED_THREAD_CAPACITY,
    MAX_MESSAGE_TOTAL_BYTES, MAX_STRUCTURED_TOOL_BYTES, MAX_TOOL_TOTAL_BYTES,
    MESSAGES_SNAPSHOT_MAX_BYTES, OBSERVED_RUN_CAPACITY, TOOL_META_INTERRUPTED_FIELD,
};

#[test]
fn protocol_serialization_omits_optional_nulls_and_preserves_opaque_null_payloads() {
    let text = envelope(
        "thread",
        "run",
        None,
        AgUiEvent {
            message_id: Some("message".to_string()),
            role: Some(AgUiEventRole::Assistant),
            ..generated_event(AgUiEventType::TextMessageStart, 123)
        },
    );
    let text = serde_json::to_value(text).expect("text event serializes");
    assert!(text["event"].get("rawEvent").is_none());
    assert!(text["event"].get("content").is_none());
    assert_eq!(text["event"]["timestamp"], 123);

    for (kind, key) in [
        (AgUiEventType::Custom, "value"),
        (AgUiEventType::Raw, "event"),
        (AgUiEventType::StateSnapshot, "snapshot"),
    ] {
        let event = envelope("thread", "run", None, generated_event(kind, 123));
        let value = serde_json::to_value(event).expect("nullable event serializes");
        assert!(value["event"].get(key).is_some_and(Value::is_null));
        assert!(value["event"].get("rawEvent").is_none());
    }

    let event = envelope(
        "thread",
        "run",
        None,
        AgUiEvent {
            name: Some("opaque".to_string()),
            value: Some(json!({ "meaningful": null })),
            ..generated_event(AgUiEventType::Custom, 123)
        },
    );
    let value = serde_json::to_value(event).expect("opaque event serializes");
    assert!(value["event"]["value"]
        .get("meaningful")
        .is_some_and(Value::is_null));
}
use crate::acp::snapshot::SessionSnapshot;
use agent_client_protocol::v1::schema::{StopReason, ToolCallStatus, ToolKind};

#[test]
fn tool_snapshot_text_renders_structured_content_without_raw_json() {
    let tool = SnapshotTool {
        id: "call-read-1".to_string(),
        generation: Some(1),
        kind: ToolKind::Read,
        status: ToolCallStatus::Completed,
        title: "Read src/math.ts".to_string(),
        started_at_ms: 1_000,
        completed_at_ms: Some(2_000),
        content: "export function add() {}\n".to_string(),
        structured_content: vec![
            json!({"type": "content", "content": {"type": "text", "text": "export function add() {}\n"}}),
            json!({"type": "diff", "path": "src/math.ts"}),
        ],
        locations: vec![json!({"path": "src/math.ts", "line": 7})],
        truncated: false,
        subagent: false,
        interrupted: false,
    };

    let text = tool_snapshot_text(&tool);

    assert!(!text.contains(r#"{""#), "unexpected raw JSON in {text}");
    assert!(
        text.contains("[diff: src/math.ts]"),
        "missing diff marker in {text}",
    );
    assert!(
        text.contains("[location: src/math.ts:7]"),
        "missing location marker in {text}",
    );
    assert_eq!(
        text.matches("export function add() {}").count(),
        1,
        "duplicated plain content in {text}",
    );
}

#[test]
fn parse_task_subagent_falls_back_past_incidental_markup() {
    let content = concat!(
        "<task id=\"child-1\" state=\"completed\">\nAudit\n</task>\n",
        "src/readme.md:1:<task something-else>",
    );

    let task = parse_task_subagent(content).expect("task header");

    assert_eq!(task.session_id, "child-1");
    assert_eq!(task.state, "completed");
}

#[test]
fn parse_task_header_rejects_empty_and_oversized_attributes() {
    assert!(parse_task_header(r#"id="" state="running">"#).is_none());
    assert!(
        parse_task_header(&format!(r#"id="{}" state="running">"#, "x".repeat(1_025))).is_none(),
    );
    assert!(parse_task_header(r#"id="child" state="">"#).is_none());
    assert!(parse_task_header(&format!(r#"id="child" state="{}">"#, "x".repeat(65))).is_none());
}

#[test]
fn task_progress_preview_handles_reversed_result_markers() {
    assert_eq!(
        task_progress_preview("</task_result>\nStill working\n<task_result>").as_deref(),
        Some("Still working"),
    );
}

#[test]
fn utf8_helpers_back_up_to_character_boundaries() {
    assert_eq!(
        utf8_chunks("a😀b", 4).collect::<Vec<_>>(),
        vec!["a", "😀", "b"],
    );

    let unicode = format!("{}é", "x".repeat(7));
    assert_eq!(bounded(unicode.as_str(), 8), "xxxxxxx");
    assert_eq!(bounded(&unicode, 8), "xxxxxxx");
}

#[test]
fn discovers_only_tool_subagents_and_renders_structured_resources() {
    assert!(discovered_subagent_session(&CanonicalEvent::RunStarted {
        agent_id: "alpha".to_string(),
        thread_id: "thread".to_string(),
        run_id: "run".to_string(),
        source_turn_id: "turn".to_string(),
        generation: 1,
    })
    .is_none());

    let tool = CanonicalEvent::Tool {
        agent_id: "alpha".to_string(),
        thread_id: "thread".to_string(),
        run_id: Some("run".to_string()),
        source_turn_id: Some("turn".to_string()),
        generation: Some(1),
        tool_call_id: "task".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Research".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child\" state=\"running\">\nWorking\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    };
    assert_eq!(
        discovered_subagent_session(&tool),
        Some((
            "thread",
            "child".to_string(),
            Some("Research"),
            "task",
            false
        )),
    );

    assert_eq!(
        snapshot_content_lines(&json!({
            "resource": {
                "uri": "file:///tmp/readme.md",
                "text": "Documentation"
            }
        })),
        vec!["[resource: file:///tmp/readme.md]", "Documentation"],
    );
    assert!(snapshot_content_lines(&json!({
        "resource": {}
    }))
    .is_empty());
}

#[test]
fn tool_snapshot_text_keeps_diff_and_terminal_payloads() {
    let tool = SnapshotTool {
        id: "call-edit-1".to_string(),
        generation: Some(1),
        kind: ToolKind::Edit,
        status: ToolCallStatus::Completed,
        title: "Edit src/math.ts".to_string(),
        started_at_ms: 1_000,
        completed_at_ms: Some(2_000),
        content: String::new(),
        structured_content: vec![
            json!({"type": "diff", "path": "src/math.ts", "oldText": "old body", "newText": "new body"}),
            json!({"type": "terminal", "terminalId": "term-1", "output": "npm test output"}),
        ],
        locations: vec![],
        truncated: false,
        subagent: false,
        interrupted: false,
    };

    let text = tool_snapshot_text(&tool);

    assert!(
        text.contains("[diff: src/math.ts]"),
        "missing diff marker in {text}",
    );
    assert!(text.contains("new body"), "diff body dropped in {text}");
    assert!(
        text.contains("[terminal: term-1]"),
        "missing terminal marker in {text}",
    );
    assert!(
        text.contains("npm test output"),
        "terminal output dropped in {text}",
    );
}

#[test]
fn parse_task_subagent_reads_the_newest_appended_header() {
    let content = concat!(
        "<task id=\"child-1\" state=\"running\">\nAudit\n</task>",
        "<task id=\"child-1\" state=\"completed\">\nAudit\n</task>",
    );

    let task = parse_task_subagent(content).expect("task header");

    assert_eq!(task.session_id, "child-1");
    assert_eq!(task.state, "completed");
}

#[test]
fn subagent_activity_text_never_leaks_the_child_thread_id() {
    let envelope = subagent_activity_envelope(
        SubagentActivityContext {
            parent_thread_id: "parent",
            parent_run_id: "run",
            parent_source_turn_id: Some("turn".to_string()),
            tool_call_id: "call-task-1",
            child_thread_id: Some("v1.YWdlbnQ.Y2hpbGQ"),
        },
        "completed",
        Some("All clear"),
        0,
    );

    let text = serde_json::to_string(&envelope).expect("serializes");
    assert!(
        text.contains("Sub-agent completed"),
        "unexpected text in {text}",
    );
    assert!(!text.contains("Thread: "), "leaked thread id in {text}");
}

fn event_types(events: &[AgUiEventEnvelope]) -> Vec<&'static str> {
    events
        .iter()
        .map(|event| match event.event.ag_ui_event_type {
            AgUiEventType::RunStarted => "RUN_STARTED",
            AgUiEventType::RunFinished => "RUN_FINISHED",
            AgUiEventType::RunError => "RUN_ERROR",
            AgUiEventType::TextMessageStart => "TEXT_MESSAGE_START",
            AgUiEventType::TextMessageContent => "TEXT_MESSAGE_CONTENT",
            AgUiEventType::TextMessageEnd => "TEXT_MESSAGE_END",
            AgUiEventType::ReasoningMessageStart => "REASONING_MESSAGE_START",
            AgUiEventType::ReasoningMessageContent => "REASONING_MESSAGE_CONTENT",
            AgUiEventType::ReasoningMessageEnd => "REASONING_MESSAGE_END",
            AgUiEventType::ToolCallStart => "TOOL_CALL_START",
            AgUiEventType::ToolCallArgs => "TOOL_CALL_ARGS",
            AgUiEventType::ToolCallEnd => "TOOL_CALL_END",
            AgUiEventType::ToolCallResult => "TOOL_CALL_RESULT",
            AgUiEventType::ActivitySnapshot => "ACTIVITY_SNAPSHOT",
            AgUiEventType::MessagesSnapshot => "MESSAGES_SNAPSHOT",
            AgUiEventType::Custom => "CUSTOM",
            _ => "OTHER",
        })
        .collect()
}

#[test]
fn bounds_closed_threads() {
    let mut projector = AgUiProjector::default();
    projector.mark_thread_closed("closed-0");
    projector.mark_thread_closed("closed-0");
    for index in 0..=CLOSED_THREAD_CAPACITY {
        projector.mark_thread_closed(&format!("closed-{index}"));
    }
    projector.mark_thread_closed("closed-1");
    assert_eq!(projector.closed_threads.len(), CLOSED_THREAD_CAPACITY);
}

fn canonical_run_started() -> CanonicalEvent {
    CanonicalEvent::RunStarted {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: "run-1".to_string(),
        source_turn_id: "turn-1".to_string(),
        generation: 1,
    }
}

fn canonical_message(role: MessageRole, message_id: &str, content: &str) -> CanonicalEvent {
    CanonicalEvent::MessageChunk {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        role,
        message_id: message_id.to_string(),
        content: content.to_string(),
        content_block: None,
    }
}

#[test]
fn agent_driven_threads_stream_without_a_client_started_run() {
    let mut projector = AgUiProjector::default();
    let mut chunk = canonical_message(MessageRole::Agent, "child-message", "scanning");
    if let CanonicalEvent::MessageChunk {
        thread_id,
        run_id,
        source_turn_id,
        generation,
        ..
    } = &mut chunk
    {
        "v1.YWxwaGEtYWdlbnQ.Y2hpbGQ".clone_into(thread_id);
        *run_id = None;
        *source_turn_id = None;
        *generation = None;
    }

    let events = projector.project_canonical(&chunk).events;

    assert_eq!(
        event_types(&events),
        vec!["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"],
        "sub-agent threads must open an implicit run so their output streams",
    );
    // A second chunk reuses the same implicit run instead of restarting it.
    let more = projector.project_canonical(&chunk).events;
    assert_eq!(event_types(&more), vec!["TEXT_MESSAGE_CONTENT"]);
}

#[test]
fn unlinked_sub_agent_progress_remains_a_generic_tool() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let parent_thread = "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg";

    let task_tool = |status: ToolCallStatus, content: &str| CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: parent_thread.to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-plain".to_string(),
        kind: ToolKind::Other,
        status,
        title: "Task".to_string(),
        content: FieldUpdate::Set(content.to_string()),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    };

    let started = projector.project_canonical(&task_tool(ToolCallStatus::InProgress, "Auditing\n"));
    assert!(subagent_cards(&started).is_empty());
    assert_eq!(
        event_types(&started.events),
        ["TOOL_CALL_START", "TOOL_CALL_ARGS", "CUSTOM", "CUSTOM"],
    );

    let progress = projector.project_canonical(&task_tool(
        ToolCallStatus::InProgress,
        "Searching package 3 of 20\n",
    ));
    let serialized = serde_json::to_string(&progress.events).expect("progress serializes");
    assert!(subagent_cards(&progress).is_empty());
    assert!(
        serialized.contains("Searching package 3 of 20"),
        "generic progress missing from {serialized}",
    );

    let done = projector.project_canonical(&task_tool(
        ToolCallStatus::Completed,
        "<task_result>All clear</task_result>",
    ));
    let serialized = serde_json::to_string(&done.events).expect("terminal serializes");
    assert!(subagent_cards(&done).is_empty());
    assert!(
        event_types(&done.events).contains(&"TOOL_CALL_END"),
        "generic tool did not settle: {:?}",
        event_types(&done.events),
    );
    assert!(
        serialized.contains("All clear"),
        "terminal result missing from {serialized}",
    );
}

const TEST_THREAD: &str = "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg";

fn turn_run_started(turn: u64) -> CanonicalEvent {
    CanonicalEvent::RunStarted {
        agent_id: "alpha-agent".to_string(),
        thread_id: TEST_THREAD.to_string(),
        run_id: format!("run-{turn}"),
        source_turn_id: format!("turn-{turn}"),
        generation: turn,
    }
}

fn turn_run_finished(turn: u64) -> CanonicalEvent {
    CanonicalEvent::RunFinished {
        agent_id: "alpha-agent".to_string(),
        thread_id: TEST_THREAD.to_string(),
        run_id: format!("run-{turn}"),
        source_turn_id: format!("turn-{turn}"),
        generation: turn,
        stop_reason: StopReason::EndTurn,
    }
}

fn turn_message(turn: u64, message_id: &str, content: &str) -> CanonicalEvent {
    CanonicalEvent::MessageChunk {
        agent_id: "alpha-agent".to_string(),
        thread_id: TEST_THREAD.to_string(),
        run_id: Some(format!("run-{turn}")),
        source_turn_id: Some(format!("turn-{turn}")),
        generation: Some(turn),
        role: MessageRole::Agent,
        message_id: message_id.to_string(),
        content: content.to_string(),
        content_block: None,
    }
}

fn turn_task_tool(
    turn: u64,
    tool_call_id: &str,
    status: ToolCallStatus,
    content: &str,
) -> CanonicalEvent {
    let task_state = if matches!(status, ToolCallStatus::Completed | ToolCallStatus::Failed) {
        "completed"
    } else {
        "running"
    };
    CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: TEST_THREAD.to_string(),
        run_id: Some(format!("run-{turn}")),
        source_turn_id: Some(format!("turn-{turn}")),
        generation: Some(turn),
        tool_call_id: tool_call_id.to_string(),
        kind: ToolKind::Other,
        status,
        title: "Task".to_string(),
        content: FieldUpdate::Set(format!(
            "<task id=\"child-{turn}\" state=\"{task_state}\">\n{content}\n</task>",
        )),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    }
}

/// Every `(messageId, text)` pair a projection emits for sub-agent cards.
fn subagent_cards(projection: &CanonicalProjection) -> Vec<(String, String)> {
    projection
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .filter_map(|value| {
            let id = value["event"]["messageId"].as_str()?.to_string();
            let text = value["event"]["content"]["text"].as_str()?.to_string();
            id.starts_with("subagent:").then_some((id, text))
        })
        .collect()
}

#[test]
fn each_turn_keeps_its_own_run_and_message_ids() {
    // Follow-up messages in one session must stay separate turns: a new run has
    // to open its own run and must not reopen or reuse the previous one.
    let mut projector = AgUiProjector::default();
    let mut run_ids: Vec<String> = Vec::new();

    for turn in 1..=3u64 {
        let started = projector.project_canonical(&turn_run_started(turn));
        assert_eq!(
            event_types(&started.events),
            vec!["RUN_STARTED"],
            "turn {turn} must open exactly one run",
        );
        run_ids.push(started.events[0].run_id.clone());

        let answered =
            projector.project_canonical(&turn_message(turn, &format!("msg-{turn}"), "answer"));
        assert_eq!(
            event_types(&answered.events),
            vec!["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"],
            "turn {turn} must stream its own message",
        );

        let finished = projector.project_canonical(&turn_run_finished(turn));
        assert_eq!(
            event_types(&finished.events),
            vec!["TEXT_MESSAGE_END", "RUN_FINISHED"],
            "turn {turn} must close cleanly",
        );
    }

    run_ids.sort();
    run_ids.dedup();
    assert_eq!(run_ids.len(), 3, "each turn needs a distinct run id");
}

#[test]
fn a_sub_agent_in_the_middle_of_each_turn_gets_its_own_card() {
    // Two turns, each spawning a sub-agent between two assistant messages. The
    // cards are keyed by tool call, so turn two must not reuse turn one's card
    // or resurrect it as running.
    let mut projector = AgUiProjector::default();
    let mut card_ids: Vec<String> = Vec::new();

    for turn in 1..=2u64 {
        projector.project_canonical(&turn_run_started(turn));
        projector.project_canonical(&turn_message(turn, &format!("before-{turn}"), "before"));

        let tool_call_id = format!("turn-{turn}-task");
        let running = subagent_cards(&projector.project_canonical(&turn_task_tool(
            turn,
            &tool_call_id,
            ToolCallStatus::InProgress,
            "Working\n",
        )));
        assert_eq!(running.len(), 1, "expected one card, got {running:?}");
        assert_eq!(running[0].0, format!("subagent:{tool_call_id}"));
        assert!(
            running[0].1.contains("Status: running"),
            "turn {turn} card must report running, got {running:?}",
        );
        card_ids.push(running[0].0.clone());

        let done = subagent_cards(&projector.project_canonical(&turn_task_tool(
            turn,
            &tool_call_id,
            ToolCallStatus::Completed,
            &format!("<task_result>Finished turn {turn}</task_result>"),
        )));
        assert_eq!(done.len(), 1, "expected one card, got {done:?}");
        assert!(
            done[0].1.contains(&format!("Finished turn {turn}")),
            "turn {turn} result missing from {done:?}",
        );

        // The rest of the turn still streams after the sub-agent finishes.
        let after =
            projector.project_canonical(&turn_message(turn, &format!("after-{turn}"), "after"));
        assert!(
            event_types(&after.events).contains(&"TEXT_MESSAGE_CONTENT"),
            "turn {turn} must keep streaming after its sub-agent",
        );
        projector.project_canonical(&turn_run_finished(turn));
    }

    card_ids.sort();
    card_ids.dedup();
    assert_eq!(card_ids.len(), 2, "each turn needs its own sub-agent card");
}

/// Every event a projection emits, as `(type, messageId)`.
fn typed_ids(projection: &CanonicalProjection) -> Vec<(String, String)> {
    projection
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .map(|value| {
            let kind = value["event"]["type"]
                .as_str()
                .or_else(|| value["event"]["name"].as_str())
                .unwrap_or("?")
                .to_string();
            let id = value["event"]["messageId"]
                .as_str()
                .unwrap_or("-")
                .to_string();
            (kind, id)
        })
        .collect()
}

fn subagent_task_tool(
    tool_call_id: &str,
    title: &str,
    status: ToolCallStatus,
    content: FieldUpdate<String>,
) -> CanonicalEvent {
    CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: TEST_THREAD.to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: tool_call_id.to_string(),
        kind: ToolKind::Other,
        status,
        title: title.to_string(),
        content,
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    }
}

#[test]
fn a_finished_sub_agent_card_states_the_outcome_without_dumping_the_result() {
    // The result is markdown and routinely runs to kilobytes. Rendering it on the
    // card buries the transcript before the user has asked to see it.
    let body = format!(
        "<task_result>\n# Summary\n\nAdded retry logic to the client.\n\n{}\n</task_result>",
        "detail line\n".repeat(200),
    );
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Task",
        ToolCallStatus::InProgress,
        FieldUpdate::Set("<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string()),
    ));

    let cards = subagent_cards(&projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Task",
        ToolCallStatus::Completed,
        FieldUpdate::Set(format!(
            "<task id=\"child-1\" state=\"completed\">\n{body}\n</task>",
        )),
    )));
    assert_eq!(cards.len(), 1, "expected one card, got {cards:?}");
    let text = &cards[0].1;

    assert!(
        text.contains("Sub-agent completed"),
        "card must state the outcome: {text}",
    );
    assert!(
        text.contains("Added retry logic to the client."),
        "card must keep a one-line summary: {text}",
    );
    assert!(
        !text.contains("detail line"),
        "card must not dump the result body: {text}",
    );
    assert!(
        text.len() < 400,
        "card grew to {} bytes: {text}",
        text.len(),
    );
}

#[test]
fn a_result_summary_survives_markdown_and_empty_bodies() {
    assert_eq!(
        summarize_task_result("## Done\n\nShipped it."),
        "Shipped it.",
    );
    assert_eq!(summarize_task_result("- first item\nsecond"), "first item");
    assert_eq!(summarize_task_result("```\ncode\n```"), "code");
    assert_eq!(summarize_task_result("###"), "Done");
    assert_eq!(summarize_task_result("   "), "Done");
}

#[test]
fn a_sub_agent_never_reports_a_starting_state() {
    // A card that reads "starting" cannot be opened and looks stuck. Nothing is
    // announced until there is a child thread to open or real progress to show.
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());

    let opened = projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Task",
        ToolCallStatus::InProgress,
        FieldUpdate::Unchanged,
    ));
    assert!(
        typed_ids(&opened).is_empty(),
        "a task tool with nothing to report must stay silent, got {:?}",
        typed_ids(&opened),
    );

    let placeholder = projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Task",
        ToolCallStatus::InProgress,
        FieldUpdate::Set("Starting sub-agent".to_string()),
    ));
    assert!(
        typed_ids(&placeholder).is_empty(),
        "agent-authored placeholder text must stay silent, got {:?}",
        typed_ids(&placeholder),
    );

    // The agent's own `starting` state is reported as running, never verbatim.
    let announced = subagent_cards(&projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Task",
        ToolCallStatus::InProgress,
        FieldUpdate::Set("<task id=\"child-1\" state=\"starting\">\n</task>".to_string()),
    )));
    assert_eq!(announced.len(), 1, "expected one card, got {announced:?}");
    let text = announced[0].1.to_ascii_lowercase();
    assert!(
        !text.contains("starting"),
        "card must not report a starting state: {text}",
    );
    assert!(
        text.contains("status: running"),
        "a pre-run state is reported as running: {text}",
    );
}

#[test]
fn the_first_sub_agent_card_can_be_opened() {
    // The child thread id arrives with the task header, so the first card the
    // user ever sees must already carry it and be openable.
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Task",
        ToolCallStatus::InProgress,
        FieldUpdate::Unchanged,
    ));

    let projection = projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Task",
        ToolCallStatus::InProgress,
        FieldUpdate::Set("<task id=\"child-1\" state=\"starting\">\n</task>".to_string()),
    ));
    let card = projection
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .find(|value| {
            value["event"]["messageId"]
                .as_str()
                .is_some_and(|id| id.starts_with("subagent:"))
        })
        .expect("a sub-agent card");

    let meta = &card["event"]["content"]["subAgent"];
    assert_eq!(meta.as_object().map(|object| object.len()), Some(5));
    assert_eq!(
        meta["receiverThreadIds"].as_array().map(Vec::len),
        Some(1),
        "the first card must carry its child thread: {card}",
    );
}

#[test]
fn unlinked_progress_stays_generic_until_the_child_can_open() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let parent_thread = "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg";
    let child_thread = AgentSessionId::new("alpha-agent", "child-1")
        .expect("child identity")
        .encode();

    let unlinked = projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Task",
        ToolCallStatus::InProgress,
        FieldUpdate::Set("Auditing repository".to_string()),
    ));
    assert!(
        subagent_cards(&unlinked).is_empty(),
        "unlinked progress leaked a disabled card: {:?}",
        typed_ids(&unlinked),
    );
    assert_eq!(
        event_types(&unlinked.events),
        ["TOOL_CALL_START", "TOOL_CALL_ARGS", "CUSTOM", "CUSTOM"],
    );

    assert!(projector.link_subagent(
        parent_thread,
        "run-1",
        Some("turn-1".to_string()),
        "task-1",
        &child_thread,
    ));
    let first_card = linked_subagent_activity_envelope(
        parent_thread,
        "run-1",
        Some("turn-1".to_string()),
        "task-1",
        &child_thread,
    );
    let first_value = serde_json::to_value(first_card).expect("card serializes");
    assert_eq!(
        first_value["event"]["content"]["subAgent"]["receiverThreadIds"][0],
        child_thread,
    );

    let linked_progress = projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Task",
        ToolCallStatus::InProgress,
        FieldUpdate::Set("Auditing repository\nRunning tests".to_string()),
    ));
    let linked_value =
        serde_json::to_value(&linked_progress.events[0]).expect("progress serializes");
    assert_eq!(event_types(&linked_progress.events), ["ACTIVITY_SNAPSHOT"]);
    assert_eq!(
        linked_value["event"]["content"]["subAgent"]["receiverThreadIds"][0],
        child_thread,
    );
}

#[test]
fn a_sub_agent_tool_never_leaves_a_phantom_tool_card() {
    // The card already renders the task payload. Echoing it as tool text or a
    // tool result leaves a second, empty tool card beside it.
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());

    let mut emitted: Vec<(String, String)> = Vec::new();
    emitted.extend(typed_ids(&projector.project_canonical(
        &subagent_task_tool(
            "task-1",
            "Task",
            ToolCallStatus::InProgress,
            FieldUpdate::Set(
                "<task id=\"child-1\" state=\"running\">\nAuditing\n</task>".to_string(),
            ),
        ),
    )));
    emitted.extend(typed_ids(&projector.project_canonical(
        &subagent_task_tool(
            "task-1",
            "Task",
            ToolCallStatus::Completed,
            FieldUpdate::Set(
                "<task id=\"child-1\" state=\"completed\">\n<task_result>All clear</task_result>\n</task>"
                    .to_string(),
            ),
        ),
    )));

    for (kind, id) in &emitted {
        assert!(
            !matches!(
                kind.as_str(),
                "TOOL_CALL_START" | "TOOL_CALL_ARGS" | "TOOL_CALL_RESULT" | "TOOL_CALL_END"
            ),
            "sub-agent tool leaked {kind} ({id}); all of {emitted:?}",
        );
        assert!(
            !kind.contains("tool-text") && !kind.contains("tool-content"),
            "sub-agent tool leaked {kind} ({id}); all of {emitted:?}",
        );
    }
    assert!(
        emitted.iter().any(|(_, id)| id.starts_with("subagent:")),
        "expected a sub-agent card in {emitted:?}",
    );
}

#[test]
fn terminal_snapshot_keeps_a_live_sub_agent_card_classified() {
    // Some agents title the task tool with the prompt rather than "Task". The
    // first update carries the task header, but a later `Set` replaces it with
    // plain result text. The terminal snapshot must remember that this tool is
    // a sub-agent instead of replacing its live card with a generic tool card.
    let mut projector = AgUiProjector::default();
    let mut snapshot = SessionSnapshot::new("alpha-agent".to_string(), TEST_THREAD.to_string());
    let started = canonical_run_started();
    projector.project_canonical(&started);
    snapshot.apply(&started);

    let linked = subagent_task_tool(
        "task-1",
        "Research dependency options",
        ToolCallStatus::InProgress,
        FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nReading package.json\n</task>".to_string(),
        ),
    );
    snapshot.apply(&linked);
    let live = projector.project_canonical(&linked);
    assert_eq!(
        subagent_cards(&live),
        vec![(
            "subagent:task-1".to_string(),
            "• Sub-agent working\n  Status: running\n  Latest: Reading package.json".to_string(),
        )],
    );

    let completed = subagent_task_tool(
        "task-1",
        "Research dependency options",
        ToolCallStatus::Completed,
        FieldUpdate::Set("<task_result>Found three compatible options.</task_result>".to_string()),
    );
    snapshot.apply(&completed);
    let terminal_live = projector.project_canonical(&completed);
    let terminal_live_value = terminal_live
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .find(|value| value["event"]["messageId"] == "subagent:task-1")
        .expect("terminal live card");
    assert_eq!(
        terminal_live_value["event"]["content"]["subAgent"]["receiverThreadIds"]
            .as_array()
            .map(Vec::len),
        Some(1),
        "terminal live update lost its child link: {terminal_live_value}",
    );
    assert_eq!(
        terminal_live_value["event"]["content"]["subAgent"]["agentStatus"],
        "completed",
    );

    let envelope =
        messages_snapshot_envelope(&snapshot, "run-1".to_string(), Some("turn-1".to_string()));
    let messages = envelope.event.messages.expect("snapshot messages");
    assert_eq!(messages.len(), 1, "unexpected snapshot: {messages:?}");
    let value = serde_json::to_value(&messages[0]).expect("serializable message");
    assert_eq!(value["id"], "subagent:task-1");
    assert_eq!(value["role"], "activity");
    assert_eq!(value["activityType"], "dappercode.subagent");
    assert_eq!(
        value["content"]["subAgent"]["receiverThreadIds"]
            .as_array()
            .map(Vec::len),
        Some(1),
        "snapshot lost its child link: {value}",
    );
    assert_eq!(
        value["content"]["subAgent"]["agentStatus"], "completed",
        "terminal tool status must win over the preserved running header",
    );
    assert!(
        value["content"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("Sub-agent completed")),
        "snapshot replaced the card with a tool: {value}",
    );

    let failed = subagent_task_tool(
        "task-2",
        "Audit dependency risks",
        ToolCallStatus::Failed,
        FieldUpdate::Set(
            "<task id=\"child-2\" state=\"failed\">\n<task_result>Audit failed</task_result>\n</task>"
                .to_string(),
        ),
    );
    snapshot.apply(&failed);
    let failed_snapshot =
        messages_snapshot_envelope(&snapshot, "run-1".to_string(), Some("turn-1".to_string()));
    let failed_value = failed_snapshot
        .event
        .messages
        .expect("failed snapshot messages")
        .into_iter()
        .find(|message| message.id == "subagent:task-2")
        .map(serde_json::to_value)
        .and_then(Result::ok)
        .expect("failed sub-agent card");
    assert!(
        failed_value["content"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("Sub-agent failed")),
        "failed snapshot used the completed heading: {failed_value}",
    );

    let child_failed = subagent_task_tool(
        "task-3",
        "Audit transitive risks",
        ToolCallStatus::Completed,
        FieldUpdate::Set(
            "<task id=\"child-3\" state=\"error\">\n<task_result>Child failed</task_result>\n</task>"
                .to_string(),
        ),
    );
    snapshot.apply(&child_failed);
    let child_failed_snapshot =
        messages_snapshot_envelope(&snapshot, "run-1".to_string(), Some("turn-1".to_string()));
    let child_failed_value = child_failed_snapshot
        .event
        .messages
        .expect("child-failed snapshot messages")
        .into_iter()
        .find(|message| message.id == "subagent:task-3")
        .map(serde_json::to_value)
        .and_then(Result::ok)
        .expect("child-failed sub-agent card");
    assert_eq!(
        child_failed_value["content"]["subAgent"]["agentStatus"], "error",
        "successful wrapper overwrote the child's failure: {child_failed_value}",
    );
    assert!(
        child_failed_value["content"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("Sub-agent failed")),
        "child failure used the completed heading: {child_failed_value}",
    );
}

#[test]
fn snapshot_keeps_unlinked_subagent_progress_as_a_generic_tool() {
    let mut snapshot = SessionSnapshot::new("alpha-agent".to_string(), TEST_THREAD.to_string());
    snapshot.apply(&canonical_run_started());
    snapshot.apply(&subagent_task_tool(
        "task-unlinked",
        "Task",
        ToolCallStatus::InProgress,
        FieldUpdate::Set("Auditing repository".to_string()),
    ));

    let envelope =
        messages_snapshot_envelope(&snapshot, "run-1".to_string(), Some("turn-1".to_string()));
    let messages = envelope.event.messages.expect("snapshot messages");
    assert!(
        messages
            .iter()
            .all(|message| { message.activity_type.as_deref() != Some("dappercode.subagent") }),
        "snapshot leaked an unopenable sub-agent card: {messages:?}",
    );
    assert!(messages.iter().any(|message| {
        message
            .tool_calls
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|call| call.id == "task-unlinked")
    }));
}

#[test]
fn run_failure_terminalizes_an_active_sub_agent() {
    let mut projector = AgUiProjector::default();
    let started = canonical_run_started();
    projector.project_canonical(&started);
    let linked = subagent_task_tool(
        "task-1",
        "Research dependency options",
        ToolCallStatus::InProgress,
        FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nReading package.json\n</task>".to_string(),
        ),
    );
    projector.project_canonical(&linked);

    let failed = CanonicalEvent::RunFailed {
        agent_id: "alpha-agent".to_string(),
        thread_id: TEST_THREAD.to_string(),
        run_id: "run-1".to_string(),
        source_turn_id: "turn-1".to_string(),
        generation: 1,
        message: "parent failed".to_string(),
    };
    let projection = projector.project_canonical(&failed);
    let card = projection
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .find(|value| value["event"]["messageId"] == "subagent:task-1")
        .expect("failed active sub-agent card");
    assert_eq!(
        card["event"]["content"]["subAgent"]["agentStatus"],
        "failed",
    );
    assert_eq!(
        card["event"]["content"]["subAgent"]["receiverThreadIds"]
            .as_array()
            .map(Vec::len),
        Some(1),
        "run failure lost the child link: {card}",
    );
    assert!(
        card["event"]["content"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("Sub-agent failed")),
        "run failure left the card running: {card}",
    );

    let mut snapshot = SessionSnapshot::new("alpha-agent".to_string(), TEST_THREAD.to_string());
    snapshot.apply(&started);
    snapshot.apply(&linked);
    snapshot.apply(&failed);
    assert_eq!(snapshot.tools["task-1"].status, ToolCallStatus::Failed);
    let terminal =
        messages_snapshot_envelope(&snapshot, "run-1".to_string(), Some("turn-1".to_string()));
    let terminal_card = terminal
        .event
        .messages
        .expect("failed terminal snapshot")
        .into_iter()
        .find(|message| message.id == "subagent:task-1")
        .map(serde_json::to_value)
        .and_then(Result::ok)
        .expect("failed snapshot card");
    assert_eq!(
        terminal_card["content"]["subAgent"]["agentStatus"], "failed",
        "terminal snapshot resurrected the active card: {terminal_card}",
    );
}

#[test]
fn terminal_tool_update_overrides_stale_running_header_without_losing_child_failure() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Research dependency options",
        ToolCallStatus::InProgress,
        FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nReading files\n</task>".to_string(),
        ),
    ));
    let completed = projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Research dependency options",
        ToolCallStatus::Completed,
        FieldUpdate::Unchanged,
    ));
    let completed_card = completed
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .find(|value| value["event"]["messageId"] == "subagent:task-1")
        .expect("status-only completed card");
    assert_eq!(
        completed_card["event"]["content"]["subAgent"]["agentStatus"], "completed",
        "stale running header beat terminal wrapper status: {completed_card}",
    );
    assert_eq!(
        completed_card["event"]["content"]["subAgent"]["receiverThreadIds"]
            .as_array()
            .map(Vec::len),
        Some(1),
    );
    let child_thread = AgentSessionId::new("alpha-agent", "child-1")
        .expect("child identity")
        .encode();
    let late_child_failure = projector.project_canonical(&CanonicalEvent::RunFailed {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread,
        run_id: "child-run".to_string(),
        source_turn_id: "child-turn".to_string(),
        generation: 1,
        message: "child failed after wrapper completion".to_string(),
    });
    let corrected_card = late_child_failure
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .find(|value| value["event"]["messageId"] == "subagent:task-1")
        .expect("late child failure card");
    assert_eq!(
        corrected_card["event"]["content"]["subAgent"]["agentStatus"], "failed",
        "late child failure could not correct wrapper completion: {corrected_card}",
    );

    let mut failed_projector = AgUiProjector::default();
    failed_projector.project_canonical(&canonical_run_started());
    failed_projector.project_canonical(&subagent_task_tool(
        "task-2",
        "Audit dependency risks",
        ToolCallStatus::InProgress,
        FieldUpdate::Set(
            "<task id=\"child-2\" state=\"error\">\nChild failed\n</task>".to_string(),
        ),
    ));
    let wrapper_completed = failed_projector.project_canonical(&subagent_task_tool(
        "task-2",
        "Audit dependency risks",
        ToolCallStatus::Completed,
        FieldUpdate::Set("<task_result>Wrapper completed</task_result>".to_string()),
    ));
    let failed_card = wrapper_completed
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .find(|value| value["event"]["messageId"] == "subagent:task-2")
        .expect("remembered child failure card");
    assert_eq!(
        failed_card["event"]["content"]["subAgent"]["agentStatus"], "error",
        "wrapper completion downgraded the child failure: {failed_card}",
    );
    assert!(failed_card["event"]["content"]["text"]
        .as_str()
        .is_some_and(|text| text.contains("Sub-agent failed")));
}

#[test]
fn parent_failure_after_wrapper_completion_fails_the_unresolved_child() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let linked = subagent_task_tool(
        "task-1",
        "Research dependency options",
        ToolCallStatus::InProgress,
        FieldUpdate::Set("<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string()),
    );
    projector.project_canonical(&linked);
    let wrapper_completed = subagent_task_tool(
        "task-1",
        "Research dependency options",
        ToolCallStatus::Completed,
        FieldUpdate::Unchanged,
    );
    projector.project_canonical(&wrapper_completed);

    let parent_failed = CanonicalEvent::RunFailed {
        agent_id: "alpha-agent".to_string(),
        thread_id: TEST_THREAD.to_string(),
        run_id: "run-1".to_string(),
        source_turn_id: "turn-1".to_string(),
        generation: 1,
        message: "parent failed".to_string(),
    };
    let failed = projector.project_canonical(&parent_failed);
    let card = failed
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .find(|value| value["event"]["messageId"] == "subagent:task-1")
        .expect("unresolved child failure card");
    assert_eq!(
        card["event"]["content"]["subAgent"]["agentStatus"],
        "failed",
    );
    assert!(
        projector
            .subagent_links
            .values()
            .all(|link| link.parent_run_id != "run-1"),
        "parent failure kept the unresolved link",
    );

    let mut snapshot = SessionSnapshot::new("alpha-agent".to_string(), TEST_THREAD.to_string());
    snapshot.apply(&canonical_run_started());
    snapshot.apply(&linked);
    snapshot.apply(&wrapper_completed);
    snapshot.apply(&parent_failed);
    let terminal =
        messages_snapshot_envelope(&snapshot, "run-1".to_string(), Some("turn-1".to_string()));
    let terminal_card = terminal
        .event
        .messages
        .expect("terminal snapshot")
        .into_iter()
        .find(|message| message.id == "subagent:task-1")
        .map(serde_json::to_value)
        .and_then(Result::ok)
        .expect("terminal sub-agent card");
    assert_eq!(
        terminal_card["content"]["subAgent"]["agentStatus"], "failed",
        "parent failure left the completed wrapper state: {terminal_card}",
    );
}

#[test]
fn cancelled_parent_run_fails_and_unlinks_unresolved_subagents() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let linked = subagent_task_tool(
        "task-1",
        "Research dependency options",
        ToolCallStatus::InProgress,
        FieldUpdate::Set("<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string()),
    );
    projector.project_canonical(&linked);
    let cancelled = CanonicalEvent::RunFinished {
        agent_id: "alpha-agent".to_string(),
        thread_id: TEST_THREAD.to_string(),
        run_id: "run-1".to_string(),
        source_turn_id: "turn-1".to_string(),
        generation: 1,
        stop_reason: StopReason::Cancelled,
    };
    let projection = projector.project_canonical(&cancelled);
    let card = projection
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .find(|value| value["event"]["messageId"] == "subagent:task-1")
        .expect("cancelled parent card");
    assert_eq!(
        card["event"]["content"]["subAgent"]["agentStatus"],
        "cancelled",
    );
    assert!(projector
        .subagent_links
        .values()
        .all(|link| link.parent_run_id != "run-1"));

    let mut snapshot = SessionSnapshot::new("alpha-agent".to_string(), TEST_THREAD.to_string());
    snapshot.apply(&canonical_run_started());
    snapshot.apply(&linked);
    snapshot.apply(&cancelled);
    assert_eq!(snapshot.tools["task-1"].status, ToolCallStatus::Failed);
    let terminal =
        messages_snapshot_envelope(&snapshot, "run-1".to_string(), Some("turn-1".to_string()));
    let terminal_card = terminal
        .event
        .messages
        .expect("cancelled snapshot")
        .into_iter()
        .find(|message| message.id == "subagent:task-1")
        .map(serde_json::to_value)
        .and_then(Result::ok)
        .expect("cancelled snapshot card");
    assert_eq!(
        terminal_card["content"]["subAgent"]["agentStatus"], "cancelled",
        "authoritative snapshot lost cancellation cause: {terminal_card}",
    );
}

#[test]
fn cancelled_child_run_does_not_complete_the_parent_subagent_card() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Research dependency options",
        ToolCallStatus::InProgress,
        FieldUpdate::Set("<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string()),
    ));
    let child_thread = AgentSessionId::new("alpha-agent", "child-1")
        .expect("child identity")
        .encode();
    let cancelled = projector.project_canonical(&CanonicalEvent::RunFinished {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread,
        run_id: "child-run".to_string(),
        source_turn_id: "child-turn".to_string(),
        generation: 1,
        stop_reason: StopReason::Cancelled,
    });
    let card = cancelled
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .find(|value| value["event"]["messageId"] == "subagent:task-1")
        .expect("cancelled child card");
    assert_eq!(
        card["event"]["content"]["subAgent"]["agentStatus"],
        "cancelled",
    );
    assert!(card["event"]["content"]["text"]
        .as_str()
        .is_some_and(|text| text.contains("Sub-agent failed")));
}

#[test]
fn retasking_a_child_clears_its_previous_terminal_status() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Audit dependency risks",
        ToolCallStatus::InProgress,
        FieldUpdate::Set(
            "<task id=\"child-1\" state=\"error\">\nFirst attempt failed\n</task>".to_string(),
        ),
    ));
    projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Audit dependency risks",
        ToolCallStatus::InProgress,
        FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nTrying again\n</task>".to_string(),
        ),
    ));
    let completed = projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Audit dependency risks",
        ToolCallStatus::Completed,
        FieldUpdate::Set("<task_result>Second attempt passed</task_result>".to_string()),
    ));
    let card = completed
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .find(|value| value["event"]["messageId"] == "subagent:task-1")
        .expect("re-tasked child card");
    assert_eq!(
        card["event"]["content"]["subAgent"]["agentStatus"], "completed",
        "re-task inherited the previous failure: {card}",
    );
}

#[test]
fn stale_child_terminal_does_not_update_a_newer_retask_card() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    projector.project_canonical(&subagent_task_tool(
        "task-1",
        "First attempt",
        ToolCallStatus::InProgress,
        FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nFirst attempt\n</task>".to_string(),
        ),
    ));
    let child_thread = AgentSessionId::new("alpha-agent", "child-1")
        .expect("child identity")
        .encode();
    projector.project_canonical(&CanonicalEvent::RunStarted {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread.clone(),
        run_id: "child-run-1".to_string(),
        source_turn_id: "child-turn-1".to_string(),
        generation: 1,
    });
    projector.project_canonical(&subagent_task_tool(
        "task-1",
        "First attempt",
        ToolCallStatus::Completed,
        FieldUpdate::Unchanged,
    ));
    projector.project_canonical(&subagent_task_tool(
        "task-2",
        "Second attempt",
        ToolCallStatus::InProgress,
        FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nSecond attempt\n</task>".to_string(),
        ),
    ));
    projector.project_canonical(&subagent_task_tool(
        "task-3",
        "Third attempt before the child restarts",
        ToolCallStatus::InProgress,
        FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nThird attempt\n</task>".to_string(),
        ),
    ));

    let stale = projector.project_canonical(&CanonicalEvent::RunFailed {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread.clone(),
        run_id: "child-run-1".to_string(),
        source_turn_id: "child-turn-1".to_string(),
        generation: 1,
        message: "old attempt failed late".to_string(),
    });
    assert!(
        stale
            .events
            .iter()
            .map(serde_json::to_value)
            .filter_map(Result::ok)
            .all(|value| value["event"]["messageId"] != "subagent:task-3"),
        "repeated retask dropped its generation floor",
    );

    projector.project_canonical(&CanonicalEvent::RunStarted {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread.clone(),
        run_id: "child-run-2".to_string(),
        source_turn_id: "child-turn-2".to_string(),
        generation: 2,
    });
    let current = projector.project_canonical(&CanonicalEvent::RunFinished {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread,
        run_id: "child-run-2".to_string(),
        source_turn_id: "child-turn-2".to_string(),
        generation: 2,
        stop_reason: StopReason::EndTurn,
    });
    let current_card = current
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .find(|value| value["event"]["messageId"] == "subagent:task-3")
        .expect("new child terminal card");
    assert_eq!(
        current_card["event"]["content"]["subAgent"]["agentStatus"],
        "completed",
    );
}

#[test]
fn projector_retask_generation_floor_is_monotonic() {
    stale_child_terminal_does_not_update_a_newer_retask_card();
}

#[test]
fn superseding_a_run_terminalizes_and_unlinks_its_sub_agents() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Research dependency options",
        ToolCallStatus::InProgress,
        FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nReading files\n</task>".to_string(),
        ),
    ));

    let superseding = CanonicalEvent::RunStarted {
        agent_id: "alpha-agent".to_string(),
        thread_id: TEST_THREAD.to_string(),
        run_id: "run-2".to_string(),
        source_turn_id: "turn-2".to_string(),
        generation: 2,
    };
    let superseded = projector.project_canonical(&superseding);
    let old_card = superseded
        .events
        .iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .find(|value| value["event"]["messageId"] == "subagent:task-1")
        .expect("superseded sub-agent card");
    assert_eq!(
        old_card["event"]["content"]["subAgent"]["agentStatus"], "failed",
        "superseded sub-agent stayed active: {old_card}",
    );
    assert!(
        projector
            .subagent_links
            .values()
            .all(|link| link.parent_run_id != "run-1"),
        "superseded run kept a child link",
    );

    let child_thread = AgentSessionId::new("alpha-agent", "child-1")
        .expect("child identity")
        .encode();
    let child_after_supersession = CanonicalEvent::MessageChunk {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread,
        run_id: None,
        source_turn_id: None,
        generation: None,
        role: MessageRole::Agent,
        message_id: "late-child-message".to_string(),
        content: "late output".to_string(),
        content_block: None,
    };
    let late = projector.project_canonical(&child_after_supersession);
    assert!(
        late.events
            .iter()
            .map(serde_json::to_value)
            .filter_map(Result::ok)
            .all(|value| value["event"]["messageId"] != "subagent:task-1"),
        "late child output updated the superseded parent",
    );
}

#[test]
fn parallel_task_tools_keep_one_card_each() {
    // Two sub-agents running at once in a single turn must not share a card or a
    // revision slot: interleaved updates have to land on their own tool call.
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let parent_thread = "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg";

    let task_tool = |tool_call_id: &str, status: ToolCallStatus, content: &str| {
        let task_state = if matches!(status, ToolCallStatus::Completed | ToolCallStatus::Failed) {
            "completed"
        } else {
            "running"
        };
        let child_id = format!("child-{tool_call_id}");
        CanonicalEvent::Tool {
            agent_id: "alpha-agent".to_string(),
            thread_id: parent_thread.to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            tool_call_id: tool_call_id.to_string(),
            kind: ToolKind::Other,
            status,
            title: "Task".to_string(),
            content: FieldUpdate::Set(format!(
                "<task id=\"{child_id}\" state=\"{task_state}\">\n{content}\n</task>",
            )),
            structured_content: FieldUpdate::Set(Vec::new()),
            locations: FieldUpdate::Set(Vec::new()),
        }
    };

    let cards_of = subagent_cards;

    projector.project_canonical(&task_tool(
        "task-a",
        ToolCallStatus::InProgress,
        "Auditing\n",
    ));
    projector.project_canonical(&task_tool(
        "task-b",
        ToolCallStatus::InProgress,
        "Reading\n",
    ));

    // Interleaved progress: each update must address its own card.
    let b_progress = cards_of(&projector.project_canonical(&task_tool(
        "task-b",
        ToolCallStatus::InProgress,
        "Running npm test\n",
    )));
    assert_eq!(b_progress.len(), 1, "expected one card, got {b_progress:?}");
    assert_eq!(b_progress[0].0, "subagent:task-b");
    assert!(
        b_progress[0].1.contains("Running npm test"),
        "progress landed on the wrong card: {b_progress:?}",
    );

    let a_progress = cards_of(&projector.project_canonical(&task_tool(
        "task-a",
        ToolCallStatus::InProgress,
        "Checking lockfile\n",
    )));
    assert_eq!(a_progress.len(), 1, "expected one card, got {a_progress:?}");
    assert_eq!(a_progress[0].0, "subagent:task-a");
    assert!(
        a_progress[0].1.contains("Checking lockfile"),
        "progress landed on the wrong card: {a_progress:?}",
    );

    // One finishing must leave the other running.
    let b_done = cards_of(&projector.project_canonical(&task_tool(
        "task-b",
        ToolCallStatus::Completed,
        "<task_result>12 tests passed</task_result>",
    )));
    assert_eq!(b_done.len(), 1, "expected one card, got {b_done:?}");
    assert_eq!(b_done[0].0, "subagent:task-b");
    assert!(
        b_done[0].1.contains("Sub-agent completed"),
        "unexpected text {b_done:?}",
    );

    let a_done = cards_of(&projector.project_canonical(&task_tool(
        "task-a",
        ToolCallStatus::Completed,
        "<task_result>No drift found</task_result>",
    )));
    assert_eq!(a_done.len(), 1, "expected one card, got {a_done:?}");
    assert_eq!(a_done[0].0, "subagent:task-a");
    assert!(
        a_done[0].1.contains("No drift found"),
        "terminal result missing from {a_done:?}",
    );
}

#[test]
fn status_only_updates_keep_the_sub_agent_card_and_its_child_link() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let parent_thread = "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg";
    let child_thread = AgentSessionId::new("alpha-agent", "child-session")
        .unwrap()
        .encode();

    let tool = |status: ToolCallStatus, content: FieldUpdate| CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: parent_thread.to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-status".to_string(),
        kind: ToolKind::Other,
        status,
        title: "task".to_string(),
        content,
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    };

    projector.project_canonical(&tool(
        ToolCallStatus::InProgress,
        FieldUpdate::Set(r#"<task id="child-session" state="running"></task>"#.to_string()),
    ));

    // A status-only update carries no content at all.
    let status_only =
        projector.project_canonical(&tool(ToolCallStatus::InProgress, FieldUpdate::Unchanged));
    for event in &status_only.events {
        let value = serde_json::to_value(event).unwrap();
        let Some(sub_agent) = value["event"]["content"]["subAgent"].as_object() else {
            continue;
        };
        assert_eq!(
            sub_agent["receiverThreadIds"][0].as_str(),
            Some(child_thread.as_str()),
            "a status-only update must not drop the child thread link",
        );
        assert_eq!(sub_agent.len(), 5);
    }
}

#[test]
fn observed_runs_close_when_the_sub_agent_reaches_a_terminal_state() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let parent_thread = "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg";
    let child_thread = AgentSessionId::new("alpha-agent", "child-session")
        .unwrap()
        .encode();

    let task_tool = |state: &str| CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: parent_thread.to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-live".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "task".to_string(),
        content: FieldUpdate::Set(format!(
            r#"<task id="child-session" state="{state}"></task>"#,
        )),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    };

    projector.project_canonical(&task_tool("running"));

    // The child streams without any client-admitted run of its own.
    let mut chunk = canonical_message(MessageRole::Agent, "child-message", "scanning");
    if let CanonicalEvent::MessageChunk {
        thread_id,
        run_id,
        source_turn_id,
        generation,
        ..
    } = &mut chunk
    {
        child_thread.clone_into(thread_id);
        *run_id = None;
        *source_turn_id = None;
        *generation = None;
    }
    let streamed = projector.project_canonical(&chunk);
    let streamed_child = streamed
        .events
        .into_iter()
        .filter(|event| event.thread_id == child_thread)
        .collect::<Vec<_>>();
    assert_eq!(
        event_types(&streamed_child),
        ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"],
        "an agent-driven thread must open an implicit run so its output streams",
    );
    assert!(projector.runs.contains_key(&child_thread));

    let finished = projector.project_canonical(&task_tool("completed"));
    let closing = finished
        .events
        .into_iter()
        .filter(|event| event.thread_id == child_thread)
        .collect::<Vec<_>>();
    assert!(
        event_types(&closing).contains(&"RUN_FINISHED"),
        "the implicit run must be closed when the sub-agent finishes",
    );
    assert!(!projector.runs.contains_key(&child_thread));
    assert!(!projector.observed_runs.contains(&child_thread));

    assert!(
        event_types(&closing).contains(&"TEXT_MESSAGE_END"),
        "closing the implicit run must end the child's open message",
    );

    // A repeated terminal update must not close it twice.
    let repeated = projector.project_canonical(&task_tool("completed"));
    assert!(
        !repeated
            .events
            .iter()
            .any(|event| event.thread_id == child_thread),
        "closing an already-closed implicit run must be a no-op",
    );

    // Re-tasking the same child session must let it stream again.
    projector.project_canonical(&task_tool("running"));
    let restreamed = projector.project_canonical(&chunk);
    let restreamed_child = restreamed
        .events
        .into_iter()
        .filter(|event| event.thread_id == child_thread)
        .collect::<Vec<_>>();
    assert_eq!(
        event_types(&restreamed_child),
        ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"],
        "a re-tasked sub-agent must open a fresh implicit run",
    );
}

#[test]
fn observed_run_eviction_emits_a_balanced_terminal_event() {
    let mut projector = AgUiProjector::default();
    let mut overflow = CanonicalProjection::default();
    for index in 0..=OBSERVED_RUN_CAPACITY {
        overflow = projector.project_canonical(&CanonicalEvent::MessageChunk {
            agent_id: "alpha-agent".to_string(),
            thread_id: format!("observed-child-{index:03}"),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role: MessageRole::Agent,
            message_id: format!("message-{index:03}"),
            content: "working".to_string(),
            content_block: None,
        });
    }

    let types = event_types(&overflow.events);
    assert!(
        types.contains(&"RUN_FINISHED"),
        "eviction dropped an open run without a terminal event: {types:?}",
    );
    assert!(types.contains(&"RUN_STARTED"));
    assert!(!projector.runs.contains_key("observed-child-000"));
    assert!(projector.closed_threads.contains("observed-child-000"));

    let late = projector.project_canonical(&CanonicalEvent::MessageChunk {
        agent_id: "alpha-agent".to_string(),
        thread_id: "observed-child-000".to_string(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        role: MessageRole::Agent,
        message_id: "late".to_string(),
        content: "late".to_string(),
        content_block: None,
    });
    assert!(
        !event_types(&late.events).contains(&"RUN_STARTED"),
        "evicted observed thread opened a second run",
    );
}

#[test]
fn canonical_projection_orders_multiple_text_and_reasoning_messages() {
    let mut projector = AgUiProjector::default();
    assert_eq!(
        event_types(&projector.project_canonical(&canonical_run_started()).events),
        ["RUN_STARTED"],
    );
    let first = projector.project_canonical(&canonical_message(MessageRole::Agent, "one", "same"));
    assert_eq!(
        event_types(&first.events),
        ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"],
    );
    let repeated =
        projector.project_canonical(&canonical_message(MessageRole::Agent, "one", "same"));
    assert_eq!(event_types(&repeated.events), ["TEXT_MESSAGE_CONTENT"]);
    let second = projector.project_canonical(&canonical_message(MessageRole::Agent, "two", "next"));
    assert_eq!(
        event_types(&second.events),
        [
            "TEXT_MESSAGE_END",
            "TEXT_MESSAGE_START",
            "TEXT_MESSAGE_CONTENT"
        ],
    );
    let thought =
        projector.project_canonical(&canonical_message(MessageRole::Thought, "thought", "why"));
    assert_eq!(
        event_types(&thought.events),
        ["REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT"],
    );
    let serialized = serde_json::to_value(&thought.events[0]).unwrap();
    assert_eq!(serialized["event"]["role"], "reasoning");
}

#[test]
fn canonical_tool_lifecycle_is_exactly_once_and_terminal_closes_everything() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    projector.project_canonical(&canonical_message(MessageRole::Agent, "answer", "partial"));
    projector.project_canonical(&canonical_message(MessageRole::Thought, "thought", "work"));
    let tool = |tool_call_id: &str, status, content: &str| CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: tool_call_id.to_string(),
        kind: ToolKind::Read,
        status,
        title: "Read file".to_string(),
        content: FieldUpdate::Set(content.to_string()),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    };
    let started = projector.project_canonical(&tool("tool-1", ToolCallStatus::InProgress, ""));
    assert_eq!(
        event_types(&started.events),
        ["TOOL_CALL_START", "TOOL_CALL_ARGS", "CUSTOM"],
    );
    assert!(projector
        .project_canonical(&tool("tool-1", ToolCallStatus::InProgress, ""))
        .events
        .is_empty());
    let completed = projector.project_canonical(&tool("tool-1", ToolCallStatus::Completed, "done"));
    assert_eq!(
        event_types(&completed.events),
        ["TOOL_CALL_END", "CUSTOM", "TOOL_CALL_RESULT"],
    );
    assert!(projector
        .project_canonical(&tool("tool-1", ToolCallStatus::Completed, "done"))
        .events
        .is_empty());
    assert_eq!(
        event_types(
            &projector
                .project_canonical(&tool("tool-open", ToolCallStatus::InProgress, ""))
                .events
        ),
        ["TOOL_CALL_START", "TOOL_CALL_ARGS", "CUSTOM"],
    );

    let terminal = projector.project_canonical(&CanonicalEvent::RunFinished {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: "run-1".to_string(),
        source_turn_id: "turn-1".to_string(),
        generation: 1,
        stop_reason: StopReason::EndTurn,
    });
    assert_eq!(
        event_types(&terminal.events),
        [
            "TEXT_MESSAGE_END",
            "REASONING_MESSAGE_END",
            "TOOL_CALL_END",
            "CUSTOM",
            "RUN_FINISHED"
        ],
    );
}

#[test]
fn task_tools_project_one_typed_subagent_state_without_duplicate_payloads() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let starting = projector.project_canonical(&CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-starting".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "task".to_string(),
        content: FieldUpdate::Set(String::new()),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    // A task tool with nothing to report announces nothing: a placeholder card
    // would read "starting" and could not be opened.
    assert!(
        event_types(&starting.events).is_empty(),
        "unexpected {:?}",
        event_types(&starting.events),
    );
    let failed_unlinked = projector.project_canonical(&CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-starting".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::Failed,
        title: "task".to_string(),
        content: FieldUpdate::Unchanged,
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    });
    assert_eq!(
        event_types(&failed_unlinked.events),
        [
            "TOOL_CALL_START",
            "TOOL_CALL_ARGS",
            "TOOL_CALL_END",
            "CUSTOM"
        ],
    );
    assert!(subagent_cards(&failed_unlinked).is_empty());
    let task = |state: &str| {
        CanonicalEvent::Tool {
            agent_id: "alpha-agent".to_string(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            tool_call_id: "task-1".to_string(),
            kind: ToolKind::Other,
            status: ToolCallStatus::Completed,
            title: "task".to_string(),
            content: FieldUpdate::Set(format!(
                "<task id=\"child-session\" state=\"{state}\">\n<task_result>done</task_result>\n</task>",
            )),
            structured_content: FieldUpdate::Set(vec![json!({
                "type": "text",
                "text": "duplicate task result"
            })]),
            locations: FieldUpdate::Set(Vec::new()),
        }
    };

    let first = projector.project_canonical(&task("completed"));
    assert_eq!(event_types(&first.events), ["ACTIVITY_SNAPSHOT"]);
    let activity = serde_json::to_value(first.events.last().unwrap()).unwrap();
    assert_eq!(activity["event"]["activityType"], "dappercode.subagent");
    assert_eq!(
        activity["event"]["content"]["subAgent"]["agentStatus"],
        "completed",
    );
    assert!(activity["event"]["content"]["text"]
        .as_str()
        .is_some_and(|text| text.contains("Latest: done")));
    assert_eq!(
        activity["event"]["content"]["subAgent"]["receiverThreadIds"][0],
        AgentSessionId::new("alpha-agent", "child-session")
            .unwrap()
            .encode(),
    );
    assert!(!event_types(&first.events).contains(&"TOOL_CALL_RESULT"));

    let repeated = projector.project_canonical(&task("completed"));
    assert!(repeated.events.is_empty());

    // A stale child header cannot regress a terminal wrapper back to running.
    let changed = projector.project_canonical(&task("running"));
    assert!(changed.events.is_empty());
}

#[test]
fn child_events_update_parent_subagent_activity_until_terminal() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let parent_thread = "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg";
    let child_thread = AgentSessionId::new("alpha-agent", "child-session")
        .unwrap()
        .encode();
    let linked = projector.project_canonical(&CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: parent_thread.to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-live".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "task".to_string(),
        content: FieldUpdate::Set(
            r#"<task id="child-session" state="running"></task>"#.to_string(),
        ),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    assert_eq!(event_types(&linked.events), ["ACTIVITY_SNAPSHOT"]);

    let child_started = projector.project_canonical(&CanonicalEvent::RunStarted {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread.clone(),
        run_id: "child-run".to_string(),
        source_turn_id: "child-turn".to_string(),
        generation: 1,
    });
    assert_eq!(event_types(&child_started.events), ["RUN_STARTED"]);
    assert_eq!(child_started.events[0].thread_id, child_thread);

    let child_tool_event = |status| CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread.clone(),
        run_id: Some("child-run".to_string()),
        source_turn_id: Some("child-turn".to_string()),
        generation: Some(1),
        tool_call_id: "read-live".to_string(),
        kind: ToolKind::Read,
        status,
        title: "Read repository".to_string(),
        content: FieldUpdate::Set(String::new()),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    };
    let pending = projector.project_canonical(&child_tool_event(ToolCallStatus::Pending));
    assert!(
        subagent_cards(&pending).is_empty(),
        "pending tools must not flash a Preparing update on the parent card",
    );

    let working = projector.project_canonical(&child_tool_event(ToolCallStatus::InProgress));
    let parent_activity = serde_json::to_value(&working.events[0]).unwrap();
    assert!(parent_activity["event"]["content"]["text"]
        .as_str()
        .is_some_and(|text| text.contains("Latest: Working on Read repository")));

    let completed = projector.project_canonical(&child_tool_event(ToolCallStatus::Completed));
    assert!(
        subagent_cards(&completed).is_empty(),
        "the completed half of a tool lifecycle must reuse its working update",
    );

    let finished = projector.project_canonical(&CanonicalEvent::RunFinished {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread,
        run_id: "child-run".to_string(),
        source_turn_id: "child-turn".to_string(),
        generation: 1,
        stop_reason: StopReason::EndTurn,
    });
    let terminal_activity = serde_json::to_value(&finished.events[0]).unwrap();
    assert_eq!(
        terminal_activity["event"]["content"]["subAgent"]["agentStatus"],
        "completed",
    );
    let parent_finished = projector.project_canonical(&CanonicalEvent::RunFinished {
        agent_id: "alpha-agent".to_string(),
        thread_id: parent_thread.to_string(),
        run_id: "run-1".to_string(),
        source_turn_id: "turn-1".to_string(),
        generation: 1,
        stop_reason: StopReason::EndTurn,
    });
    let parent_cards = subagent_cards(&parent_finished);
    assert_eq!(parent_cards.len(), 1);
    assert!(parent_cards[0].1.contains("Sub-agent completed"));
}

/// The card names each tool the sub-agent runs and, between tools, what it is doing. It never
/// echoes streamed prose. Narration
/// arrives token by token, so printing it scrolls text past the user faster than it can be read
/// and repaints the transcript on every delta, which cancels the tap that opens the sub-agent.
#[test]
fn a_running_card_names_the_activity_instead_of_streamed_narration() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let parent_thread = "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg";
    let child_thread = AgentSessionId::new("alpha-agent", "child-session")
        .expect("child identity")
        .encode();
    assert!(projector.link_subagent(
        parent_thread,
        "run-1",
        Some("turn-1".to_string()),
        "task-tools",
        &child_thread,
    ));

    let child_message = |message_id: &str, role, content: &str| CanonicalEvent::MessageChunk {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread.clone(),
        run_id: Some("child-run".to_string()),
        source_turn_id: Some("child-turn".to_string()),
        generation: Some(1),
        role,
        message_id: message_id.to_string(),
        content: content.to_string(),
        content_block: None,
    };
    let child_tool = |tool_call_id: &str, title: &str, status| CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread.clone(),
        run_id: Some("child-run".to_string()),
        source_turn_id: Some("child-turn".to_string()),
        generation: Some(1),
        tool_call_id: tool_call_id.to_string(),
        kind: ToolKind::Read,
        status,
        title: title.to_string(),
        content: FieldUpdate::Set(String::new()),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    };

    // Reasoning is reported as reasoning, never as the thought text itself.
    let thinking = projector.project_canonical(&child_message(
        "thought-1",
        MessageRole::Thought,
        "The failure is probably in the retry loop",
    ));
    let thinking_cards = subagent_cards(&thinking);
    assert!(
        thinking_cards[0].1.contains("Latest: Reasoning"),
        "reasoning must be named, got {thinking_cards:?}",
    );
    assert!(
        !thinking_cards[0].1.contains("retry loop"),
        "thought text leaked onto the card: {thinking_cards:?}",
    );

    // A burst of reasoning deltas renders one line, so the card holds still while it streams.
    for (index, chunk) in ["so I will", " re-read the handler"].iter().enumerate() {
        let streamed = projector.project_canonical(&child_message(
            &format!("thought-{}", index + 2),
            MessageRole::Thought,
            chunk,
        ));
        assert!(
            subagent_cards(&streamed).is_empty(),
            "reasoning repainted the card: {:?}",
            subagent_cards(&streamed),
        );
    }

    // Answer text is named too, and its own deltas are just as quiet.
    let narrating = projector.project_canonical(&child_message(
        "answer-1",
        MessageRole::Agent,
        "Let me look at the code",
    ));
    let narrating_cards = subagent_cards(&narrating);
    assert!(narrating_cards[0].1.contains("Latest: Responding"));
    assert!(
        !narrating_cards[0].1.contains("look at the code"),
        "answer text leaked onto the card: {narrating_cards:?}",
    );
    for (index, chunk) in ["Now I will", " summarize the findings"].iter().enumerate() {
        let narrated = projector.project_canonical(&child_message(
            &format!("answer-{}", index + 2),
            MessageRole::Agent,
            chunk,
        ));
        assert!(
            subagent_cards(&narrated).is_empty(),
            "narration repainted the card: {:?}",
            subagent_cards(&narrated),
        );
    }

    // Every individual tool call is named on the card.
    let searched = projector.project_canonical(&child_tool(
        "read-1",
        "Search dependencies",
        ToolCallStatus::InProgress,
    ));
    assert!(subagent_cards(&searched)[0]
        .1
        .contains("Latest: Working on Search dependencies"));

    // A sub-agent that narrates while that tool is still running is still working on it, so
    // the tool keeps the card for its whole run instead of being wiped by the next token.
    for (index, chunk) in ["Hmm", " that is interesting"].iter().enumerate() {
        let during = projector.project_canonical(&child_message(
            &format!("thought-during-{index}"),
            MessageRole::Thought,
            chunk,
        ));
        assert!(
            subagent_cards(&during).is_empty(),
            "narration displaced a running tool: {:?}",
            subagent_cards(&during),
        );
    }

    // Completing the tool hands the card back without repainting it...
    let settled = projector.project_canonical(&child_tool(
        "read-1",
        "Search dependencies",
        ToolCallStatus::Completed,
    ));
    assert!(
        subagent_cards(&settled).is_empty(),
        "a completed tool repainted the card: {:?}",
        subagent_cards(&settled),
    );

    // ...so reasoning with nothing running finally reports reasoning.
    let reasoning_again =
        projector.project_canonical(&child_message("thought-9", MessageRole::Thought, "Hmm"));
    assert!(subagent_cards(&reasoning_again)[0]
        .1
        .contains("Latest: Reasoning"));

    // A genuinely new tool still updates the card.
    let edited = projector.project_canonical(&child_tool(
        "read-2",
        "Edit manifest",
        ToolCallStatus::InProgress,
    ));
    assert!(subagent_cards(&edited)[0]
        .1
        .contains("Latest: Working on Edit manifest"));

    // Agents run tools in parallel, so settling one must not hand the card back while another
    // is still in flight: the card falls back to the tool that is still running.
    let parallel = projector.project_canonical(&child_tool(
        "read-3",
        "Read config",
        ToolCallStatus::InProgress,
    ));
    assert!(subagent_cards(&parallel)[0]
        .1
        .contains("Latest: Working on Read config"));
    projector.project_canonical(&child_tool(
        "read-3",
        "Read config",
        ToolCallStatus::Completed,
    ));
    let still_editing = projector.project_canonical(&child_message(
        "thought-parallel",
        MessageRole::Thought,
        "Checking",
    ));
    assert!(
        subagent_cards(&still_editing)[0]
            .1
            .contains("Latest: Working on Edit manifest"),
        "a settled tool released the card while another was running: {:?}",
        subagent_cards(&still_editing),
    );

    let finished = projector.project_canonical(&CanonicalEvent::RunFinished {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread,
        run_id: "child-run".to_string(),
        source_turn_id: "child-turn".to_string(),
        generation: 1,
        stop_reason: StopReason::EndTurn,
    });
    let completed = subagent_cards(&finished);
    assert!(completed[0].1.contains("Sub-agent completed"));
    assert!(
        completed[0].1.contains("Latest: Returned result"),
        "terminal card must report its outcome, got {completed:?}",
    );
}

/// A foreground task tool names its child only once it has finished, so the bridge finds the
/// child elsewhere and links it up front. From then on the card must follow the sub-agent's
/// work, exactly as it does for a link built from the tool's own header.
#[test]
fn an_early_link_streams_child_progress_onto_the_parent_card() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let parent_thread = "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg";
    let child_thread = AgentSessionId::new("alpha-agent", "child-session")
        .expect("child identity")
        .encode();

    assert!(projector.link_subagent(
        parent_thread,
        "run-1",
        Some("turn-1".to_string()),
        "task-early",
        &child_thread,
    ));
    // The tool's own header arrives later and must not discard the correlation built since.
    assert!(!projector.link_subagent(
        parent_thread,
        "run-1",
        Some("turn-1".to_string()),
        "task-early",
        &child_thread,
    ));

    let child_tool = projector.project_canonical(&CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread.clone(),
        run_id: Some("child-run".to_string()),
        source_turn_id: Some("child-turn".to_string()),
        generation: Some(1),
        tool_call_id: "read-early".to_string(),
        kind: ToolKind::Read,
        status: ToolCallStatus::InProgress,
        title: "Read repository".to_string(),
        content: FieldUpdate::Set(String::new()),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    let card = serde_json::to_value(&child_tool.events[0]).expect("card serializes");
    assert_eq!(card["threadId"], parent_thread);
    assert_eq!(card["event"]["messageId"], "subagent:task-early");
    assert!(card["event"]["content"]["text"]
        .as_str()
        .is_some_and(|text| text.contains("Latest: Working on Read repository")));
    assert_eq!(
        card["event"]["content"]["subAgent"]["receiverThreadIds"][0],
        serde_json::Value::String(child_thread.clone()),
    );

    let blank_title = projector.project_canonical(&CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread.clone(),
        run_id: Some("child-run".to_string()),
        source_turn_id: Some("child-turn".to_string()),
        generation: Some(1),
        tool_call_id: "blank-title".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: " ".to_string(),
        content: FieldUpdate::Set(String::new()),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });
    assert!(subagent_cards(&blank_title)[0]
        .1
        .contains("Latest: Working on Using a tool"));

    let whitespace = projector.project_canonical(&CanonicalEvent::MessageChunk {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread.clone(),
        run_id: Some("child-run".to_string()),
        source_turn_id: Some("child-turn".to_string()),
        generation: Some(1),
        role: MessageRole::Agent,
        message_id: "whitespace".to_string(),
        content: "   ".to_string(),
        content_block: None,
    });
    assert!(subagent_cards(&whitespace).is_empty());

    let child_finished = |thread_id: &str| CanonicalEvent::RunFinished {
        agent_id: "alpha-agent".to_string(),
        thread_id: thread_id.to_string(),
        run_id: format!("{thread_id}-run"),
        source_turn_id: format!("{thread_id}-turn"),
        generation: 1,
        stop_reason: StopReason::EndTurn,
    };
    let completed = projector.project_canonical(&child_finished(&child_thread));
    assert!(subagent_cards(&completed)[0]
        .1
        .contains("Sub-agent completed"));

    assert!(projector.link_subagent(
        parent_thread,
        "stale-run",
        Some("turn-1".to_string()),
        "task-stale",
        "stale-child",
    ));
    let stale = projector.project_canonical(&child_finished("stale-child"));
    assert!(subagent_cards(&stale)[0].1.contains("Sub-agent completed"));

    assert!(projector.link_subagent(
        "missing-parent",
        "missing-run",
        None,
        "task-orphan",
        "orphan-child",
    ));
    let orphan = projector.project_canonical(&child_finished("orphan-child"));
    assert!(subagent_cards(&orphan)[0].1.contains("Sub-agent completed"));

    let source_correlated = projector.project_canonical(&CanonicalEvent::MessageChunk {
        agent_id: "alpha-agent".to_string(),
        thread_id: "source-correlated".to_string(),
        run_id: None,
        source_turn_id: Some("source-turn".to_string()),
        generation: Some(1),
        role: MessageRole::Agent,
        message_id: "source-message".to_string(),
        content: "Response".to_string(),
        content_block: None,
    });
    assert!(source_correlated.events.is_empty());
}

#[test]
fn child_run_started_does_not_replace_card_with_starting_preview() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    projector.project_canonical(&subagent_task_tool(
        "task-1",
        "Research dependency options",
        ToolCallStatus::InProgress,
        FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nQueued work\n</task>".to_string(),
        ),
    ));
    let child_thread = AgentSessionId::new("alpha-agent", "child-1")
        .expect("child identity")
        .encode();
    let started = projector.project_canonical(&CanonicalEvent::RunStarted {
        agent_id: "alpha-agent".to_string(),
        thread_id: child_thread,
        run_id: "child-run".to_string(),
        source_turn_id: "child-turn".to_string(),
        generation: 1,
    });
    assert!(
        started
            .events
            .iter()
            .map(serde_json::to_value)
            .filter_map(Result::ok)
            .all(|value| value["event"]["messageId"] != "subagent:task-1"),
        "child start regressed the parent card to a starting preview",
    );
}

#[test]
fn terminal_snapshot_uses_official_reasoning_and_tool_messages() {
    let mut snapshot = SessionSnapshot::new(
        "alpha-agent".to_string(),
        "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
    );
    snapshot.apply(&canonical_message(MessageRole::User, "user", "question"));
    snapshot.apply(&canonical_message(
        MessageRole::Thought,
        "thought",
        "reason",
    ));
    snapshot.apply(&canonical_message(MessageRole::Agent, "answer", "final"));
    snapshot.apply(&CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: snapshot.thread_id.clone(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "tool-1".to_string(),
        kind: ToolKind::Read,
        status: ToolCallStatus::Completed,
        title: "Read".to_string(),
        content: FieldUpdate::Set("done".to_string()),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    });

    let envelope =
        messages_snapshot_envelope(&snapshot, "run-1".to_string(), Some("turn-1".to_string()));
    let value = serde_json::to_value(envelope).unwrap();
    assert_eq!(value["event"]["type"], "MESSAGES_SNAPSHOT");
    let messages = value["event"]["messages"].as_array().unwrap();
    assert!(messages
        .iter()
        .any(|message| message["role"] == "reasoning"));
    assert!(messages.iter().any(|message| {
        message["role"] == "assistant" && message["toolCalls"][0]["id"] == "tool-1"
    }));
    assert!(messages
        .iter()
        .any(|message| { message["role"] == "tool" && message["toolCallId"] == "tool-1" }));
    let meta = messages
        .iter()
        .find(|message| message["activityType"] == "dappercode.tool")
        .expect("snapshot carries tool metadata");
    assert_eq!(meta["content"]["toolCallId"], "tool-1");
    assert_eq!(meta["content"]["kind"], "read");
    assert_eq!(meta["content"]["status"], "completed");
    assert_eq!(meta["content"]["title"], "Read");
    assert!(meta["content"]["startedAtMs"].is_number());
    assert!(meta["content"]["completedAtMs"].is_number());
}

#[test]
fn tool_meta_event_tracks_kind_and_status_without_repeating_itself() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let tool = |status| CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "meta-tool".to_string(),
        kind: ToolKind::SwitchMode,
        status,
        title: String::new(),
        content: FieldUpdate::Unchanged,
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    };
    let started = projector.project_canonical(&tool(ToolCallStatus::InProgress));
    let meta = serde_json::to_value(started.events.last().unwrap()).unwrap();
    assert_eq!(meta["event"]["name"], "dappercode.dev/tool-meta");
    assert_eq!(meta["event"]["value"]["kind"], "switch_mode");
    assert_eq!(meta["event"]["value"]["status"], "in_progress");
    // A blank ACP title falls back to the kind, matching `toolCallName`.
    assert_eq!(meta["event"]["value"]["title"], "switch_mode");
    let started_at_ms = meta["event"]["value"]["startedAtMs"]
        .as_i64()
        .expect("tool start timestamp");
    assert!(meta["event"]["value"]["completedAtMs"].is_null());
    assert!(projector
        .project_canonical(&tool(ToolCallStatus::InProgress))
        .events
        .is_empty());
    let failed = projector.project_canonical(&tool(ToolCallStatus::Failed));
    assert_eq!(event_types(&failed.events), ["TOOL_CALL_END", "CUSTOM"]);
    let failed_meta = serde_json::to_value(&failed.events[1]).unwrap();
    assert_eq!(failed_meta["event"]["value"]["status"], "failed");
    assert_eq!(failed_meta["event"]["value"]["startedAtMs"], started_at_ms);
    assert!(
        failed_meta["event"]["value"]["completedAtMs"]
            .as_i64()
            .expect("tool completion timestamp")
            >= started_at_ms,
    );
}

#[test]
fn run_completion_emits_terminal_timing_for_a_dangling_tool() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let started = projector.project_canonical(&CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: TEST_THREAD.to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "dangling-tool".to_string(),
        kind: ToolKind::Execute,
        status: ToolCallStatus::InProgress,
        title: "npm test".to_string(),
        content: FieldUpdate::Unchanged,
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    });
    let started_meta = serde_json::to_value(started.events.last().unwrap()).unwrap();
    let started_at_ms = started_meta["event"]["value"]["startedAtMs"]
        .as_i64()
        .expect("tool start timestamp");

    let finished = projector.project_canonical(&turn_run_finished(1));
    assert_eq!(
        event_types(&finished.events),
        ["TOOL_CALL_END", "CUSTOM", "RUN_FINISHED"],
    );
    let completed_meta = serde_json::to_value(&finished.events[1]).unwrap();
    assert_eq!(completed_meta["event"]["name"], "dappercode.dev/tool-meta");
    assert_eq!(completed_meta["event"]["value"]["status"], "completed");
    assert_eq!(
        completed_meta["event"]["value"]["startedAtMs"],
        started_at_ms,
    );
    assert!(
        completed_meta["event"]["value"]["completedAtMs"]
            .as_i64()
            .expect("tool completion timestamp")
            >= started_at_ms,
    );
}

#[test]
fn cancelled_run_flags_a_dangling_tool_interrupted_and_keeps_it_failed() {
    let running_tool = CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: TEST_THREAD.to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "dangling-tool".to_string(),
        kind: ToolKind::Execute,
        status: ToolCallStatus::InProgress,
        title: "npm test".to_string(),
        content: FieldUpdate::Unchanged,
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    };
    let finished = |stop_reason| CanonicalEvent::RunFinished {
        agent_id: "alpha-agent".to_string(),
        thread_id: TEST_THREAD.to_string(),
        run_id: "run-1".to_string(),
        source_turn_id: "turn-1".to_string(),
        generation: 1,
        stop_reason,
    };
    let dangling_status = |terminal: &CanonicalEvent| {
        let mut projector = AgUiProjector::default();
        projector.project_canonical(&canonical_run_started());
        projector.project_canonical(&running_tool);
        let projection = projector.project_canonical(terminal);
        let meta = projection
            .events
            .iter()
            .map(serde_json::to_value)
            .filter_map(Result::ok)
            .find(|value| value["event"]["name"] == "dappercode.dev/tool-meta")
            .expect("dangling tool meta");
        json!({
            "status": meta["event"]["value"]["status"],
            "interrupted": meta["event"]["value"]["interrupted"],
        })
    };
    // Older clients map unknown statuses to `pending`, so the status stays `failed`.
    assert_eq!(
        dangling_status(&finished(StopReason::Cancelled)),
        json!({ "status": "failed", "interrupted": true }),
    );
    assert_eq!(
        dangling_status(&finished(StopReason::EndTurn)),
        json!({ "status": "completed", "interrupted": null }),
    );
    assert_eq!(
        dangling_status(&CanonicalEvent::RunFailed {
            agent_id: "alpha-agent".to_string(),
            thread_id: TEST_THREAD.to_string(),
            run_id: "run-1".to_string(),
            source_turn_id: "turn-1".to_string(),
            generation: 1,
            message: "boom".to_string(),
        }),
        json!({ "status": "failed", "interrupted": null }),
    );

    let mut snapshot = SessionSnapshot::new("alpha-agent".to_string(), TEST_THREAD.to_string());
    snapshot.apply(&canonical_run_started());
    snapshot.apply(&running_tool);
    snapshot.apply(&finished(StopReason::Cancelled));
    let tool = &snapshot.tools["dangling-tool"];
    assert_eq!(tool.status, ToolCallStatus::Failed);
    assert!(tool.interrupted);
    let raw_tool = serde_json::to_value(tool).unwrap();
    assert_eq!(raw_tool["status"], "failed");
    assert_eq!(raw_tool["interrupted"], true);
    let messages = serde_json::to_value(
        messages_snapshot_envelope(&snapshot, "run-1".to_string(), Some("turn-1".to_string()))
            .event
            .messages
            .expect("snapshot messages"),
    )
    .unwrap();
    let messages = messages.as_array().expect("snapshot message list");
    let meta = messages
        .iter()
        .find(|message| message["id"] == "tool-meta:dangling-tool")
        .expect("snapshot tool meta");
    assert_eq!(meta["content"]["status"], "failed");
    assert_eq!(meta["content"][TOOL_META_INTERRUPTED_FIELD], true);
    let result = messages
        .iter()
        .find(|message| message["id"] == "tool-result:dangling-tool")
        .expect("snapshot tool result");
    assert!(result.get("error").is_none_or(Value::is_null));

    let mut failed = SessionSnapshot::new("alpha-agent".to_string(), TEST_THREAD.to_string());
    failed.apply(&canonical_run_started());
    failed.apply(&running_tool);
    failed.apply(&CanonicalEvent::RunFailed {
        agent_id: "alpha-agent".to_string(),
        thread_id: TEST_THREAD.to_string(),
        run_id: "run-1".to_string(),
        source_turn_id: "turn-1".to_string(),
        generation: 1,
        message: "boom".to_string(),
    });
    assert!(!failed.tools["dangling-tool"].interrupted);
    assert!(serde_json::to_value(&failed.tools["dangling-tool"])
        .unwrap()
        .get("interrupted")
        .is_none());
}

#[test]
fn subagent_tools_do_not_emit_tool_meta() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let projection = projector.project_canonical(&CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "task-tool".to_string(),
        kind: ToolKind::Other,
        status: ToolCallStatus::InProgress,
        title: "Task".to_string(),
        content: FieldUpdate::Set(
            "<task id=\"child-1\" state=\"running\">\nReading files\n</task>".to_string(),
        ),
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    });
    assert!(!serde_json::to_value(&projection.events)
        .unwrap()
        .to_string()
        .contains("dappercode.dev/tool-meta"));
}

#[test]
fn terminal_snapshot_stays_below_notification_limit_and_keeps_newest_messages() {
    let mut snapshot = SessionSnapshot::new(
        "alpha-agent".to_string(),
        "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
    );
    let content = "x".repeat(31 * 1024);
    for index in 0..12 {
        snapshot.apply(&canonical_message(
            MessageRole::Agent,
            &format!("message-{index}"),
            &content,
        ));
    }
    snapshot.apply(&canonical_message(
        MessageRole::Agent,
        "latest",
        "latest answer",
    ));

    let envelope = messages_snapshot_envelope(&snapshot, "run-1".to_string(), None);
    let serialized = serde_json::to_vec(&envelope).unwrap();
    assert!(serialized.len() <= MESSAGES_SNAPSHOT_MAX_BYTES);
    let messages = envelope.event.messages.unwrap();
    assert!(!messages.iter().any(|message| message.id == "message-0"));
    assert!(messages.iter().any(|message| message.id == "latest"));
}

#[test]
fn command_metadata_includes_hint_only_when_present() {
    let mut projector = AgUiProjector::default();
    let projected = projector.project_canonical(&CanonicalEvent::Commands {
        agent_id: "alpha-agent".into(),
        thread_id: "thread".into(),
        commands: vec![
            crate::acp::events::CommandEntry {
                name: "review".into(),
                description: "Review changes".into(),
                hint: Some("x".repeat(300)),
            },
            crate::acp::events::CommandEntry {
                name: "compact".into(),
                description: "Compact".into(),
                hint: None,
            },
        ],
    });
    let value = &serde_json::to_value(&projected.events[0]).unwrap()["event"]["value"];
    assert_eq!(
        value,
        &json!({ "commands": [
            { "name": "review", "description": "Review changes", "hint": "x".repeat(256) },
            { "name": "compact", "description": "Compact" }
        ] }),
    );
}

#[test]
fn canonical_metadata_and_interactions_use_custom_and_control_planes() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let thread_id = "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string();
    let plan = projector.project_canonical(&CanonicalEvent::Plan {
        agent_id: "alpha-agent".into(),
        thread_id: thread_id.clone(),
        entries: vec![crate::acp::events::PlanEntry {
            content: "Inspect".into(),
            priority: "high".into(),
            status: "pending".into(),
        }],
    });
    assert_eq!(event_types(&plan.events), ["ACTIVITY_SNAPSHOT"]);
    let plan_value = serde_json::to_value(&plan.events[0]).unwrap();
    assert_eq!(plan_value["event"]["activityType"], "dappercode.plan");

    let metadata = [
        CanonicalEvent::Usage {
            agent_id: "alpha-agent".into(),
            thread_id: thread_id.clone(),
            used: 1,
            size: 2,
            cost: Some("1 USD".into()),
        },
        CanonicalEvent::Mode {
            agent_id: "alpha-agent".into(),
            thread_id: thread_id.clone(),
            id: "plan".into(),
        },
        CanonicalEvent::Config {
            agent_id: "alpha-agent".into(),
            thread_id: thread_id.clone(),
            entries: vec![crate::acp::events::ConfigEntry {
                id: "model".into(),
                value: "example".into(),
                name: "Model".into(),
                description: None,
                category: Some("model".into()),
                options: Vec::new(),
            }],
        },
        CanonicalEvent::SessionInfo {
            agent_id: "alpha-agent".into(),
            thread_id: thread_id.clone(),
            title: FieldUpdate::Set("Title".into()),
            updated_at: FieldUpdate::Clear,
        },
        CanonicalEvent::Commands {
            agent_id: "alpha-agent".into(),
            thread_id: thread_id.clone(),
            commands: vec![crate::acp::events::CommandEntry {
                name: "test".into(),
                description: "Run tests".into(),
                hint: None,
            }],
        },
    ];
    let names = metadata
        .iter()
        .map(|event| {
            let projected = projector.project_canonical(event);
            assert_eq!(event_types(&projected.events), ["CUSTOM"]);
            serde_json::to_value(&projected.events[0]).unwrap()["event"]["name"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        [
            "dappercode.dev/usage",
            "dappercode.dev/mode",
            "dappercode.dev/config",
            "dappercode.dev/session-info",
            "dappercode.dev/commands"
        ],
    );

    let approval = PendingApproval {
        request_id: "permission".into(),
        agent_id: "alpha-agent".into(),
        kind: "fileChange".into(),
        thread_id: thread_id.clone(),
        turn_id: "turn-1".into(),
        item_id: "tool".into(),
        title: "Write".into(),
        message: "Write".into(),
        requested_at: "2026-07-20T00:00:00Z".into(),
        reason: Some("Write".into()),
        command: None,
        cwd: None,
        grant_root: None,
        proposed_execpolicy_amendment: None,
        options: vec![PendingApprovalOption {
            id: "reject".into(),
            label: "Reject".into(),
            kind: Some("RejectOnce".into()),
        }],
    };
    let requested = projector.project_canonical(&CanonicalEvent::PermissionRequested {
        approval: approval.clone(),
    });
    assert!(requested.events.is_empty());
    assert_eq!(requested.controls[0].0, "bridge/approval.requested");
    assert_eq!(
        requested.controls[0].1,
        serde_json::to_value(approval).unwrap(),
    );
    let resolved = projector.project_canonical(&CanonicalEvent::PermissionResolved {
        agent_id: "alpha-agent".into(),
        thread_id: thread_id.clone(),
        request_id: "permission".into(),
        outcome: "reject".into(),
    });
    assert_eq!(resolved.controls[0].0, "bridge/approval.resolved");
    let user_input = PendingUserInputRequest {
        request_id: "question".into(),
        agent_id: Some("alpha-agent".into()),
        thread_id: thread_id.clone(),
        turn_id: "turn-1".into(),
        item_id: "tool".into(),
        message: "Value".into(),
        requested_at: "2026-07-20T00:00:01Z".into(),
        questions: vec![PendingUserInputQuestion {
            id: "name".into(),
            header: "Name".into(),
            question: "Value".into(),
            is_other: false,
            is_secret: true,
            required: true,
            field_type: "string".into(),
            default_value: None,
            options: Some(vec![PendingUserInputQuestionOption {
                value: "value".into(),
                label: "Value".into(),
                description: String::new(),
            }]),
        }],
    };
    let elicitation = projector.project_canonical(&CanonicalEvent::ElicitationRequested {
        request: user_input.clone(),
    });
    assert!(elicitation.events.is_empty());
    assert_eq!(elicitation.controls[0].0, "bridge/userInput.requested");
    assert_eq!(
        elicitation.controls[0].1,
        serde_json::to_value(user_input).unwrap(),
    );
    let elicitation_resolved = projector.project_canonical(&CanonicalEvent::ElicitationResolved {
        agent_id: "alpha-agent".into(),
        thread_id,
        request_id: "question".into(),
        action: "cancelled".into(),
    });
    assert_eq!(
        elicitation_resolved.controls[0].0,
        "bridge/userInput.resolved",
    );
}

#[test]
fn turn_token_usage_projects_cumulative_totals() {
    let mut projector = AgUiProjector::default();
    let thread_id = "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string();
    projector.project_canonical(&canonical_run_started());
    let usage = |input_tokens,
                 output_tokens,
                 reasoning_tokens,
                 cached_read_tokens,
                 cached_write_tokens,
                 total_tokens| CanonicalEvent::TurnTokenUsage {
        agent_id: "alpha-agent".into(),
        thread_id: thread_id.clone(),
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cached_read_tokens,
        cached_write_tokens,
        total_tokens,
    };

    let first = projector.project_canonical(&usage(10, 4, Some(2), None, Some(1), 17));
    let first = serde_json::to_value(&first.events[0]).unwrap();
    assert_eq!(first["event"]["name"], "dappercode.dev/tokenTotals");
    assert_eq!(
        first["event"]["value"],
        json!({
            "turns": 1,
            "inputTokens": 10,
            "outputTokens": 4,
            "reasoningTokens": 2,
            "cachedReadTokens": null,
            "cachedWriteTokens": 1,
            "totalTokens": 17,
        }),
    );

    let second = projector.project_canonical(&usage(8, 3, None, Some(6), None, 17));
    let second = serde_json::to_value(&second.events[0]).unwrap();
    assert_eq!(second["event"]["name"], "dappercode.dev/tokenTotals");
    assert_eq!(
        second["event"]["value"],
        json!({
            "turns": 2,
            "inputTokens": 18,
            "outputTokens": 7,
            "reasoningTokens": 2,
            "cachedReadTokens": 6,
            "cachedWriteTokens": 1,
            "totalTokens": 34,
        }),
    );
}

#[test]
fn turn_token_usage_restarts_after_thread_closes() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&turn_run_started(1));
    projector.project_canonical(&CanonicalEvent::TurnTokenUsage {
        agent_id: "alpha-agent".into(),
        thread_id: TEST_THREAD.into(),
        input_tokens: 10,
        output_tokens: 4,
        reasoning_tokens: Some(2),
        cached_read_tokens: None,
        cached_write_tokens: Some(1),
        total_tokens: 17,
    });
    projector.project_canonical(&turn_run_finished(1));

    projector.project_canonical(&turn_run_started(2));
    let resumed = projector.project_canonical(&CanonicalEvent::TurnTokenUsage {
        agent_id: "alpha-agent".into(),
        thread_id: TEST_THREAD.into(),
        input_tokens: 3,
        output_tokens: 2,
        reasoning_tokens: None,
        cached_read_tokens: Some(7),
        cached_write_tokens: None,
        total_tokens: 12,
    });
    let resumed = serde_json::to_value(&resumed.events[0]).unwrap();

    assert_eq!(resumed["event"]["name"], "dappercode.dev/tokenTotals");
    assert_eq!(
        resumed["event"]["value"],
        json!({
            "turns": 1,
            "inputTokens": 3,
            "outputTokens": 2,
            "reasoningTokens": null,
            "cachedReadTokens": 7,
            "cachedWriteTokens": null,
            "totalTokens": 12,
        }),
    );
}

#[tokio::test]
async fn canonical_hub_projection_replays_serialized_events_once() {
    let hub = ClientHub::with_replay_capacity(32);
    hub.broadcast_canonical_event(&canonical_run_started())
        .await;
    hub.broadcast_canonical_event(&canonical_message(MessageRole::Agent, "message", "hello"))
        .await;
    let (replay, _, _) = hub.replay_since(None, 32).await;
    assert_eq!(replay.len(), 3);
    assert_eq!(replay[0]["method"], AG_UI_EVENT_METHOD);
    assert_eq!(replay[1]["params"]["event"]["type"], "TEXT_MESSAGE_START");
    assert_eq!(replay[2]["params"]["event"]["type"], "TEXT_MESSAGE_CONTENT");
}

#[tokio::test]
async fn early_subagent_link_is_openable_before_replay_and_projects_live_transcript() {
    let hub = ClientHub::with_replay_capacity(32);
    let parent_thread_id = "parent-thread";
    let child_thread_id = "child-thread";
    assert!(
        hub.link_subagent(
            parent_thread_id,
            "parent-run",
            Some("parent-turn".to_string()),
            "task-1",
            child_thread_id,
        )
        .await,
    );

    let (initial, _, _) = hub.replay_since(None, 32).await;
    assert_eq!(initial.len(), 1);
    assert_eq!(initial[0]["params"]["threadId"], parent_thread_id);
    assert_eq!(
        initial[0]["params"]["event"]["content"]["subAgent"]["receiverThreadIds"][0],
        child_thread_id,
    );
    assert_eq!(
        initial[0]["params"]["event"]["content"]["subAgent"]
            .as_object()
            .map(|object| object.len()),
        Some(5),
    );
    assert!(
        !hub.link_subagent(
            parent_thread_id,
            "parent-run",
            Some("parent-turn".to_string()),
            "task-1",
            child_thread_id,
        )
        .await,
    );
    let (after_duplicate, _, _) = hub.replay_since(None, 32).await;
    assert_eq!(after_duplicate.len(), 1);

    let mut child_run = canonical_run_started();
    if let CanonicalEvent::RunStarted {
        thread_id,
        run_id,
        source_turn_id,
        ..
    } = &mut child_run
    {
        *thread_id = child_thread_id.to_string();
        *run_id = "child-run".to_string();
        *source_turn_id = "child-turn".to_string();
    }
    hub.broadcast_canonical_event(&child_run).await;

    let mut child_message =
        canonical_message(MessageRole::Agent, "child-answer", "Reading project files");
    if let CanonicalEvent::MessageChunk {
        thread_id,
        run_id,
        source_turn_id,
        ..
    } = &mut child_message
    {
        *thread_id = child_thread_id.to_string();
        *run_id = Some("child-run".to_string());
        *source_turn_id = Some("child-turn".to_string());
    }
    hub.broadcast_canonical_event(&child_message).await;

    let (replay, _, _) = hub.replay_since(None, 32).await;
    assert!(replay.iter().any(|event| {
        event["params"]["threadId"] == parent_thread_id
            && event["params"]["event"]["content"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("Latest: Responding"))
    }));
    assert!(replay.iter().any(|event| {
        event["params"]["threadId"] == child_thread_id
            && event["params"]["event"]["type"] == "TEXT_MESSAGE_CONTENT"
            && event["params"]["event"]["delta"] == "Reading project files"
    }));
}

#[test]
fn canonical_projection_handles_superseded_failed_and_stale_runs() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    projector.project_canonical(&canonical_message(MessageRole::Agent, "answer", "partial"));
    projector.project_canonical(&canonical_message(MessageRole::Thought, "thought-1", "one"));
    let changed_thought =
        projector.project_canonical(&canonical_message(MessageRole::Thought, "thought-2", "two"));
    assert_eq!(
        event_types(&changed_thought.events),
        [
            "REASONING_MESSAGE_END",
            "REASONING_MESSAGE_START",
            "REASONING_MESSAGE_CONTENT"
        ],
    );

    let superseding = CanonicalEvent::RunStarted {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: "run-2".to_string(),
        source_turn_id: "turn-2".to_string(),
        generation: 2,
    };
    let superseded = projector.project_canonical(&superseding);
    assert_eq!(
        event_types(&superseded.events),
        [
            "TEXT_MESSAGE_END",
            "REASONING_MESSAGE_END",
            "RUN_ERROR",
            "RUN_STARTED"
        ],
    );

    let stale = projector.project_canonical(&CanonicalEvent::RunFinished {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: "run-1".to_string(),
        source_turn_id: "turn-1".to_string(),
        generation: 1,
        stop_reason: StopReason::EndTurn,
    });
    assert!(stale.events.is_empty());
    let failed = projector.project_canonical(&CanonicalEvent::RunFailed {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: "run-2".to_string(),
        source_turn_id: "turn-2".to_string(),
        generation: 2,
        message: "failed".to_string(),
    });
    assert_eq!(event_types(&failed.events), ["RUN_ERROR"]);

    let mut empty_projector = AgUiProjector::default();
    empty_projector.project_canonical(&canonical_run_started());
    let empty_superseded = empty_projector.project_canonical(&superseding);
    assert_eq!(
        event_types(&empty_superseded.events),
        ["RUN_ERROR", "RUN_STARTED"],
    );
}

#[test]
fn canonical_projection_filters_empty_and_mismatched_chunks() {
    let mut projector = AgUiProjector::default();
    assert!(projector
        .project_canonical(&canonical_message(MessageRole::Agent, "missing", "content"))
        .events
        .is_empty());
    projector.project_canonical(&canonical_run_started());
    assert!(projector
        .project_canonical(&canonical_message(MessageRole::Agent, "empty", ""))
        .events
        .is_empty());
    let user =
        projector.project_canonical(&canonical_message(MessageRole::User, "user", "content"));
    assert_eq!(
        event_types(&user.events),
        ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"],
    );
    assert_eq!(
        serde_json::to_value(&user.events[0]).unwrap()["event"]["role"],
        "user",
    );
    let next_user =
        projector.project_canonical(&canonical_message(MessageRole::User, "next-user", "next"));
    assert_eq!(
        event_types(&next_user.events),
        [
            "TEXT_MESSAGE_END",
            "TEXT_MESSAGE_START",
            "TEXT_MESSAGE_CONTENT"
        ],
    );

    let mut mismatched_run = canonical_message(MessageRole::Agent, "wrong-run", "content");
    if let CanonicalEvent::MessageChunk { run_id, .. } = &mut mismatched_run {
        *run_id = Some("other-run".to_string());
    }
    assert!(projector
        .project_canonical(&mismatched_run)
        .events
        .is_empty());
    let mut mismatched_turn = canonical_message(MessageRole::Agent, "wrong-turn", "content");
    if let CanonicalEvent::MessageChunk { source_turn_id, .. } = &mut mismatched_turn {
        *source_turn_id = Some("other-turn".to_string());
    }
    assert!(projector
        .project_canonical(&mismatched_turn)
        .events
        .is_empty());
}

#[test]
fn oversized_utf8_text_and_tool_results_are_bounded_and_explicitly_truncated() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let content = "a🙂界".repeat(12_000);
    for role in [MessageRole::User, MessageRole::Agent, MessageRole::Thought] {
        let projection =
            projector.project_canonical(&canonical_message(role, &format!("{role:?}"), &content));
        let reconstructed = projection
            .events
            .iter()
            .filter_map(|envelope| envelope.event.delta.as_ref())
            .filter_map(|delta| match delta {
                Delta::PurpleString(value) => Some(value.as_str()),
                _ => None,
            })
            .collect::<String>();
        assert!(reconstructed.len() <= MAX_MESSAGE_TOTAL_BYTES);
        assert!(content.starts_with(&reconstructed));
        let truncations = projection
            .events
            .iter()
            .filter(|envelope| {
                envelope.event.name.as_deref() == Some("dappercode.dev/transcript-truncated")
            })
            .collect::<Vec<_>>();
        assert_eq!(truncations.len(), 1);
        assert_eq!(
            truncations[0].event.value.as_ref().unwrap()["retrieval"]["available"],
            false,
        );
        let post_cap = projector.project_canonical(&canonical_message(
            role,
            &format!("{role:?}"),
            "ignored after cap",
        ));
        assert!(post_cap.events.is_empty());
        assert!(projection.events.iter().all(|envelope| {
            serde_json::to_value(envelope)
                .ok()
                .is_some_and(|value| value["event"]["type"].is_string())
        }));
    }

    let tool = CanonicalEvent::Tool {
        agent_id: "alpha-agent".into(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".into(),
        run_id: Some("run-1".into()),
        source_turn_id: Some("turn-1".into()),
        generation: Some(1),
        tool_call_id: "large-tool".into(),
        kind: ToolKind::Read,
        status: ToolCallStatus::Completed,
        title: "Large".into(),
        content: FieldUpdate::Set(content.clone()),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    };
    let projection = projector.project_canonical(&tool);
    let reconstructed = projection
        .events
        .iter()
        .filter_map(|envelope| envelope.event.content.as_ref())
        .filter_map(|content| match content {
            AgUiEventContent::PurpleString(value) => Some(value.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert!(reconstructed.len() <= MAX_TOOL_TOTAL_BYTES);
    assert!(content.starts_with(&reconstructed));
    assert_eq!(
        projector.runs.values().next().unwrap().tools["large-tool"]
            .result_content
            .len(),
        MAX_TOOL_TOTAL_BYTES,
    );
}

#[test]
fn canonical_non_text_message_projects_custom_content_without_placeholder_text() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let mut message = canonical_message(MessageRole::Agent, "image", "");
    if let CanonicalEvent::MessageChunk { content_block, .. } = &mut message {
        *content_block = Some(json!({"type":"image","mimeType":"image/png"}));
    }
    let projected = projector.project_canonical(&message);
    assert_eq!(
        event_types(&projected.events),
        ["CUSTOM", "TEXT_MESSAGE_START"],
    );
    let value = serde_json::to_value(&projected.events[0]).unwrap();
    assert_eq!(value["event"]["name"], "dappercode.dev/message-content");
    assert_eq!(value["event"]["value"]["content"]["type"], "image");
    assert!(!value.to_string().contains("non-text content omitted"));

    let repeated_reasoning =
        projector.project_canonical(&canonical_message(MessageRole::Thought, "reasoning", "one"));
    assert_eq!(
        event_types(&repeated_reasoning.events),
        ["REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT"],
    );
    let repeated_reasoning =
        projector.project_canonical(&canonical_message(MessageRole::Thought, "reasoning", "two"));
    assert_eq!(
        event_types(&repeated_reasoning.events),
        ["REASONING_MESSAGE_CONTENT"],
    );

    let location_only_event = CanonicalEvent::Tool {
        agent_id: "alpha-agent".into(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".into(),
        run_id: Some("run-1".into()),
        source_turn_id: Some("turn-1".into()),
        generation: Some(1),
        tool_call_id: "location-only".into(),
        kind: ToolKind::Read,
        status: ToolCallStatus::Completed,
        title: "Locate".into(),
        content: FieldUpdate::Set(String::new()),
        structured_content: FieldUpdate::Set(vec![]),
        locations: FieldUpdate::Set(vec![json!({"path":"src/lib.rs"})]),
    };
    assert!(AgUiProjector::default()
        .project_canonical(&location_only_event)
        .events
        .is_empty());
    let location_only = projector.project_canonical(&location_only_event);
    assert_eq!(
        event_types(&location_only.events),
        [
            "TOOL_CALL_START",
            "TOOL_CALL_ARGS",
            "TOOL_CALL_END",
            "CUSTOM",
            "CUSTOM"
        ],
    );

    let mut runs = HashMap::from([(
        "thread".to_string(),
        AgUiRunState {
            run_id: "run".to_string(),
            source_turn_id: None,
            open_user_id: None,
            open_message_id: None,
            open_reasoning_id: None,
            message_bytes: HashMap::new(),
            truncated_messages: HashSet::new(),
            tools: HashMap::new(),
        },
    )]);
    assert!(canonical_run_mut(&mut runs, "thread", None, None).is_some());
    assert!(canonical_run_mut(&mut runs, "thread", None, Some("turn")).is_some());
    runs.get_mut("thread").unwrap().source_turn_id = Some("turn".to_string());
    assert!(canonical_run_mut(&mut runs, "thread", None, Some("turn")).is_some());
    assert!(canonical_run_mut(&mut runs, "thread", Some("other"), None).is_none());
}

#[test]
fn canonical_message_truncation_block_emits_one_retrieval_marker() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let mut message = canonical_message(MessageRole::Agent, "truncated", "bounded");
    if let CanonicalEvent::MessageChunk { content_block, .. } = &mut message {
        *content_block = Some(json!({"type":"truncation","truncated":true}));
    }
    let projection = projector.project_canonical(&message);
    assert_eq!(
        projection
            .events
            .iter()
            .filter(|envelope| envelope.event.name.as_deref()
                == Some("dappercode.dev/transcript-truncated"))
            .count(),
        1,
    );
    let repeated = projector.project_canonical(&message);
    assert!(repeated.events.iter().all(|envelope| {
        envelope.event.name.as_deref() != Some("dappercode.dev/transcript-truncated")
    }));

    if let CanonicalEvent::MessageChunk { content_block, .. } = &mut message {
        *content_block = Some(json!({"type":"truncation","truncated":"invalid"}));
    }
    let second = projector.project_canonical(&message);
    assert!(second.events.iter().all(|envelope| {
        envelope.event.name.as_deref() != Some("dappercode.dev/transcript-truncated")
    }));
}

#[test]
fn canonical_tool_defaults_title_and_emits_changed_terminal_results() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let tool = |status, content: &str| CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "tool".to_string(),
        kind: ToolKind::Edit,
        status,
        title: " ".to_string(),
        content: FieldUpdate::Set(content.to_string()),
        structured_content: FieldUpdate::Set(Vec::new()),
        locations: FieldUpdate::Set(Vec::new()),
    };
    let mut terminal_first_projector = AgUiProjector::default();
    terminal_first_projector.project_canonical(&canonical_run_started());
    let terminal_first =
        terminal_first_projector.project_canonical(&tool(ToolCallStatus::Failed, "terminal-first"));
    assert!(event_types(&terminal_first.events).contains(&"TOOL_CALL_RESULT"));
    let started = projector.project_canonical(&tool(ToolCallStatus::Pending, ""));
    assert_eq!(
        event_types(&started.events),
        ["TOOL_CALL_START", "TOOL_CALL_ARGS", "CUSTOM"],
    );
    let serialized = serde_json::to_value(&started.events[0]).unwrap();
    assert_eq!(serialized["event"]["toolCallName"], "edit");
    let partial = projector.project_canonical(&tool(ToolCallStatus::InProgress, "first"));
    assert_eq!(event_types(&partial.events), ["CUSTOM", "CUSTOM"]);
    assert_eq!(
        serde_json::to_value(&partial.events[1]).unwrap()["event"]["name"],
        "dappercode.dev/tool-text",
    );
    assert!(projector
        .project_canonical(&tool(ToolCallStatus::InProgress, "first"))
        .events
        .is_empty());
    let empty_terminal = projector.project_canonical(&tool(ToolCallStatus::Failed, ""));
    assert_eq!(
        event_types(&empty_terminal.events),
        ["TOOL_CALL_END", "CUSTOM", "CUSTOM"],
    );
    assert_eq!(
        serde_json::to_value(&empty_terminal.events[2]).unwrap()["event"]["name"],
        "dappercode.dev/tool-text",
    );
    let metadata_only = CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "tool".to_string(),
        kind: ToolKind::Edit,
        status: ToolCallStatus::Failed,
        title: "updated title".to_string(),
        content: FieldUpdate::Unchanged,
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    };
    // A renamed tool still has to reach the row that shows its title, so the
    // metadata event fires even though no content moved.
    let renamed = projector.project_canonical(&metadata_only);
    assert_eq!(event_types(&renamed.events), ["CUSTOM"]);
    assert_eq!(
        serde_json::to_value(&renamed.events[0]).unwrap()["event"]["value"]["title"],
        "updated title",
    );
    assert!(projector
        .project_canonical(&metadata_only)
        .events
        .is_empty());
    let changed_result = projector.project_canonical(&tool(ToolCallStatus::Failed, "second"));
    assert_eq!(
        event_types(&changed_result.events),
        ["CUSTOM", "TOOL_CALL_RESULT"],
    );
    assert_eq!(
        serde_json::to_value(&changed_result.events[1]).unwrap()["event"]["content"],
        "second",
    );
    let suffix_result = projector.project_canonical(&tool(ToolCallStatus::Failed, "second!"));
    assert_eq!(event_types(&suffix_result.events), ["TOOL_CALL_RESULT"]);
    assert_eq!(
        serde_json::to_value(&suffix_result.events[0]).unwrap()["event"]["content"],
        "!",
    );
    let prefix_shaped_append = CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "tool".to_string(),
        kind: ToolKind::Edit,
        status: ToolCallStatus::Failed,
        title: " ".to_string(),
        content: FieldUpdate::Append("second! appended".to_string()),
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    };
    let prefix_shaped = projector.project_canonical(&prefix_shaped_append);
    assert_eq!(event_types(&prefix_shaped.events), ["TOOL_CALL_RESULT"]);
    assert_eq!(
        serde_json::to_value(&prefix_shaped.events[0]).unwrap()["event"]["content"],
        "second! appended",
    );
    let mut snapshot = SessionSnapshot::new(
        "alpha-agent".to_string(),
        "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
    );
    snapshot.apply(&tool(ToolCallStatus::Failed, "second!"));
    snapshot.apply(&prefix_shaped_append);
    assert_eq!(snapshot.tools["tool"].content, "second!second! appended");
    assert_eq!(
        projector.runs["v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg"].tools["tool"].result_content,
        snapshot.tools["tool"].content,
    );
    let append_event = CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "tool".to_string(),
        kind: ToolKind::Edit,
        status: ToolCallStatus::Failed,
        title: " ".to_string(),
        content: FieldUpdate::Append(" appended".to_string()),
        structured_content: FieldUpdate::Unchanged,
        locations: FieldUpdate::Unchanged,
    };
    let appended = projector.project_canonical(&append_event);
    assert_eq!(event_types(&appended.events), ["TOOL_CALL_RESULT"]);
    assert_eq!(
        serde_json::to_value(&appended.events[0]).unwrap()["event"]["content"],
        " appended",
    );
    let repeated = projector.project_canonical(&append_event);
    assert_eq!(event_types(&repeated.events), ["TOOL_CALL_RESULT"]);
    assert_eq!(
        serde_json::to_value(&repeated.events[0]).unwrap()["event"]["content"],
        " appended",
    );
    let mut cleared = append_event.clone();
    if let CanonicalEvent::Tool { content, .. } = &mut cleared {
        *content = FieldUpdate::Append(String::new());
    }
    assert!(
        !event_types(&projector.project_canonical(&cleared).events).contains(&"TOOL_CALL_RESULT"),
    );
}

#[test]
fn canonical_tool_preserves_structured_content_in_custom_event() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let projection = projector.project_canonical(&CanonicalEvent::Tool {
        agent_id: "alpha-agent".to_string(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        run_id: Some("run-1".to_string()),
        source_turn_id: Some("turn-1".to_string()),
        generation: Some(1),
        tool_call_id: "tool-structured".to_string(),
        kind: ToolKind::Edit,
        status: ToolCallStatus::Completed,
        title: "Edit".to_string(),
        content: FieldUpdate::Set("done".to_string()),
        structured_content: FieldUpdate::Set(vec![
            json!({"type": "content", "content": {"type": "image", "data": "aW1hZ2U=", "mimeType": "image/png"}}),
            json!({"type": "diff", "path": "/tmp/file", "oldText": "old", "newText": "new"}),
            json!({"type": "terminal", "terminalId": "terminal-1"}),
        ]),
        locations: FieldUpdate::Set(vec![json!({"path": "/tmp/file", "line": 7})]),
    });
    assert_eq!(
        event_types(&projection.events),
        [
            "TOOL_CALL_START",
            "TOOL_CALL_ARGS",
            "TOOL_CALL_END",
            "CUSTOM",
            "TOOL_CALL_RESULT",
            "CUSTOM",
        ],
    );
    let custom = serde_json::to_value(projection.events.last().unwrap()).unwrap();
    assert_eq!(custom["event"]["name"], "dappercode.dev/tool-content");
    assert_eq!(custom["event"]["value"]["content"][1]["type"], "diff");
    assert_eq!(custom["event"]["value"]["locations"][0]["line"], 7);
    let meta = serde_json::to_value(&projection.events[3]).unwrap();
    assert_eq!(meta["event"]["name"], "dappercode.dev/tool-meta");
    assert_eq!(meta["event"]["value"]["kind"], "edit");
    assert_eq!(meta["event"]["value"]["status"], "completed");
    assert_eq!(meta["event"]["value"]["toolCallId"], "tool-structured");
}

#[test]
fn canonical_tool_projects_changed_in_progress_structured_revisions() {
    let mut projector = AgUiProjector::default();
    projector.project_canonical(&canonical_run_started());
    let tool = |terminal_id: &str| CanonicalEvent::Tool {
        agent_id: "alpha-agent".into(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".into(),
        run_id: Some("run-1".into()),
        source_turn_id: Some("turn-1".into()),
        generation: Some(1),
        tool_call_id: "live-tool".into(),
        kind: ToolKind::Execute,
        status: ToolCallStatus::InProgress,
        title: "Terminal".into(),
        content: FieldUpdate::Set(String::new()),
        structured_content: FieldUpdate::Set(vec![
            json!({"type":"terminal","terminalId":terminal_id}),
        ]),
        locations: FieldUpdate::Set(Vec::new()),
    };
    let first = projector.project_canonical(&tool("terminal-1"));
    assert_eq!(
        event_types(&first.events),
        ["TOOL_CALL_START", "TOOL_CALL_ARGS", "CUSTOM", "CUSTOM"],
    );
    assert!(projector
        .project_canonical(&tool("terminal-1"))
        .events
        .is_empty());
    let changed = projector.project_canonical(&tool("terminal-2"));
    assert_eq!(event_types(&changed.events), ["CUSTOM"]);

    let append = CanonicalEvent::Tool {
        agent_id: "alpha-agent".into(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".into(),
        run_id: Some("run-1".into()),
        source_turn_id: Some("turn-1".into()),
        generation: Some(1),
        tool_call_id: "live-tool".into(),
        kind: ToolKind::Execute,
        status: ToolCallStatus::InProgress,
        title: "metadata update".into(),
        content: FieldUpdate::Unchanged,
        structured_content: FieldUpdate::Append(vec![
            json!({"type":"terminal","terminalId":"terminal-3"}),
        ]),
        locations: FieldUpdate::Append(vec![json!({"path":"src/main.rs"})]),
    };
    let appended = projector.project_canonical(&append);
    let appended_value = serde_json::to_value(appended.events.last().unwrap()).unwrap();
    assert_eq!(
        appended_value["event"]["name"],
        "dappercode.dev/tool-content",
    );
    assert_eq!(
        appended_value["event"]["value"]["content"]
            .as_array()
            .unwrap()
            .len(),
        2,
    );
    assert_eq!(
        appended_value["event"]["value"]["locations"]
            .as_array()
            .unwrap()
            .len(),
        1,
    );
    let mut metadata_only = append.clone();
    if let CanonicalEvent::Tool {
        title,
        structured_content,
        locations,
        ..
    } = &mut metadata_only
    {
        *title = "duplicate metadata update".into();
        *structured_content = FieldUpdate::Unchanged;
        *locations = FieldUpdate::Unchanged;
    }
    // Only the title moved, so the structured payload stays put and the client is
    // told about the rename alone.
    let renamed = projector.project_canonical(&metadata_only);
    assert_eq!(event_types(&renamed.events), ["CUSTOM"]);
    assert_eq!(
        serde_json::to_value(&renamed.events[0]).unwrap()["event"]["name"],
        "dappercode.dev/tool-meta",
    );
    assert!(projector
        .project_canonical(&metadata_only)
        .events
        .is_empty());

    let mut clear = append;
    if let CanonicalEvent::Tool {
        structured_content,
        locations,
        ..
    } = &mut clear
    {
        *structured_content = FieldUpdate::Clear;
        *locations = FieldUpdate::Clear;
    }
    let cleared = projector.project_canonical(&clear);
    let cleared_value = serde_json::to_value(cleared.events.last().unwrap()).unwrap();
    assert_eq!(
        cleared_value["event"]["name"],
        "dappercode.dev/tool-content",
    );
    assert_eq!(cleared_value["event"]["value"]["content"], json!([]));
    assert_eq!(cleared_value["event"]["value"]["locations"], json!([]));

    let mut content = Vec::new();
    let mut locations = Vec::new();
    let mut truncated = false;
    assert!(!apply_structured_updates(
        &mut content,
        &FieldUpdate::Unchanged,
        &mut locations,
        &FieldUpdate::Unchanged,
        16,
        &mut truncated,
    ));
    assert!(apply_structured_updates(
        &mut content,
        &FieldUpdate::Append(vec![json!({"large":"value that exceeds the bound"})]),
        &mut locations,
        &FieldUpdate::Append(vec![json!({"path":"also-too-large"})]),
        16,
        &mut truncated,
    ));
    assert!(truncated);
    assert!(content.is_empty());
    assert!(locations.is_empty());
    assert!(apply_structured_updates(
        &mut content,
        &FieldUpdate::Set(vec![json!(1)]),
        &mut locations,
        &FieldUpdate::Clear,
        64,
        &mut truncated,
    ));
    assert!(!truncated);

    let oversized = CanonicalEvent::Tool {
        agent_id: "alpha-agent".into(),
        thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".into(),
        run_id: Some("run-1".into()),
        source_turn_id: Some("turn-1".into()),
        generation: Some(1),
        tool_call_id: "live-tool".into(),
        kind: ToolKind::Execute,
        status: ToolCallStatus::InProgress,
        title: "oversized".into(),
        content: FieldUpdate::Unchanged,
        structured_content: FieldUpdate::Append(vec![json!({
            "type": "terminal",
            "output": "x".repeat(MAX_STRUCTURED_TOOL_BYTES + 1),
        })]),
        locations: FieldUpdate::Unchanged,
    };
    let unavailable = projector.project_canonical(&oversized);
    assert_eq!(unavailable.events.len(), 2);
    assert_eq!(
        serde_json::to_value(unavailable.events.last().unwrap()).unwrap()["event"]["value"]
            ["retrieval"]["available"],
        false,
    );

    let mut recovered = oversized;
    if let CanonicalEvent::Tool {
        structured_content, ..
    } = &mut recovered
    {
        *structured_content = FieldUpdate::Set(vec![json!({"type":"terminal","output":"ok"})]);
    }
    let recovered = projector.project_canonical(&recovered);
    assert_eq!(
        serde_json::to_value(&recovered.events[0]).unwrap()["event"]["value"]["retrieval"]
            ["available"],
        true,
    );
}

#[test]
fn canonical_custom_events_and_bounds_work_without_active_run() {
    let mut projector = AgUiProjector::default();
    let custom = projector.project_canonical(&CanonicalEvent::Mode {
        agent_id: "alpha-agent".to_string(),
        thread_id: "thread".to_string(),
        id: "mode".to_string(),
    });
    assert_eq!(custom.events[0].run_id, "thread::session");
    assert_eq!(custom.events[0].source_turn_id, None);
    assert_eq!(field_value(&FieldUpdate::Unchanged), Value::Null);
    assert_eq!(field_value(&FieldUpdate::Clear), Value::Null);
    assert_eq!(
        field_value(&FieldUpdate::Set("value".to_string())),
        Value::String("value".to_string()),
    );
    assert_eq!(
        field_value(&FieldUpdate::Append("suffix".to_string())),
        Value::String("suffix".to_string()),
    );
    let unicode = format!("{}é", "x".repeat(7));
    assert_eq!(bounded(unicode, 8), "xxxxxxx");
    assert_eq!(bounded("short", 8), "short");
}
