use super::{
    append_bounded, bound_json, bound_text, bounded_values, handle_session_notification,
    tool_content, tool_locations, AcpSession, CanonicalEvent, ReceivedSessionNotification,
    SessionUpdate, ToolCallContent, MAX_MESSAGE_CHUNK_BYTES, MAX_STRUCTURED_FIELDS,
    MAX_STRUCTURED_ITEMS, MAX_TOOL_TEXT_CHUNK_BYTES,
};
use crate::acp::snapshot::{SnapshotMessage, SnapshotTimelineKind};
use agent_client_protocol::v1::schema::SessionNotification;

#[test]
fn patch_locations_only_interpret_headers_inside_a_patch() {
    let input = serde_json::json!({
        "patchText": "*** Begin Patch\r\n*** Add File: src/a file.ts\r\n\
            +*** Delete File: not-a-header.ts\r\n*** Update File: src/a file.ts\r\n\
            *** End Patch\r\n*** Delete File: outside.ts\r\n"
    });
    assert_eq!(
        tool_locations::<serde_json::Value>(&[], "apply_patch", Some(&input), &[]),
        vec![serde_json::json!({"path": "src/a file.ts"})],
    );
    for input in [
        serde_json::json!({"secret": "*** Begin Patch\n*** Add File: hidden\n"}),
        serde_json::json!("*** Begin Patch typo\n*** Add File: hidden\n"),
        serde_json::json!("*** Add File: hidden\n"),
        serde_json::json!(null),
    ] {
        assert!(
            tool_locations::<serde_json::Value>(&[], "apply_patch", Some(&input), &[]).is_empty(),
        );
    }
}

#[tokio::test]
async fn available_commands_carry_only_non_blank_unstructured_hints() {
    let session = AcpSession::new("agent".into(), "thread".into());
    let update: SessionUpdate = serde_json::from_value(serde_json::json!({
        "sessionUpdate": "available_commands_update",
        "availableCommands": [
            { "name": "review", "description": "Review changes", "input": { "hint": " [focus] " } },
            { "name": "compact", "description": "Compact" },
            { "name": "blank", "description": "Blank hint", "input": { "hint": "   " } },
            { "name": "invalid", "description": "Invalid input", "input": { "hint": 7 } }
        ]
    }))
    .unwrap();
    handle_session_notification(
        "agent",
        &session,
        SessionNotification::new("session", update).into(),
    )
    .await;
    let snapshot = session.snapshot().await;
    assert_eq!(
        serde_json::to_value(&snapshot.commands).unwrap(),
        serde_json::json!([
            { "name": "review", "description": "Review changes", "hint": "[focus]" },
            { "name": "compact", "description": "Compact" },
            { "name": "blank", "description": "Blank hint" },
            { "name": "invalid", "description": "Invalid input" }
        ]),
    );
}

#[tokio::test]
async fn unrelated_tool_patch_shaped_input_remains_private() {
    let session = AcpSession::new("agent".into(), "thread".into());
    for update_type in ["tool_call", "tool_call_update"] {
        let update: SessionUpdate = serde_json::from_value(serde_json::json!({
            "sessionUpdate": update_type, "toolCallId": "private-tool",
            "title": "Review private patch", "kind": "other", "status": "in_progress",
            "rawInput": {"patch":"*** Begin Patch\n*** Add File: private-filename\n+secret\n"},
            "locations": [{"path":"public.ts"}]
        }))
        .unwrap();
        handle_session_notification(
            "agent",
            &session,
            SessionNotification::new("session", update).into(),
        )
        .await;
        let snapshot = session.snapshot().await;
        assert_eq!(
            snapshot.tools["private-tool"].locations,
            vec![serde_json::json!({"path":"public.ts"})],
        );
    }
}

#[tokio::test]
async fn patch_input_publishes_complete_file_headers_before_the_patch_finishes() {
    for status in ["completed", "failed"] {
        let session = AcpSession::new("agent".into(), "thread".into());
        let first = "*** Begin Patch\n*** Add File: src/first.ts\n+private-patch-body\n";
        let partial = format!("{first}*** Update File: src/sec");
        let full = format!(
            "{partial}ond.ts\n*** Move to: src/renamed.ts\n@@\n-old\n+new\n\
             *** Delete File: src/obsolete.ts\n*** End Patch\n",
        );
        let updates = [
            (
                serde_json::json!({
                    "sessionUpdate": "tool_call", "toolCallId": "patch",
                    "title": "apply_patch", "kind": "other", "status": "pending",
                    "rawInput": "*** Begin Patch\n*** Add File: src/fir"
                }),
                vec![],
            ),
            (
                serde_json::json!({
                    "sessionUpdate": "tool_call_update", "toolCallId": "patch",
                    "status": "in_progress", "rawInput": {"input": partial}
                }),
                vec!["src/first.ts"],
            ),
            (
                serde_json::json!({
                    "sessionUpdate": "tool_call_update", "toolCallId": "patch",
                    "rawInput": {"patch": full, "secret": "private-argument"}
                }),
                vec![
                    "src/first.ts",
                    "src/second.ts",
                    "src/renamed.ts",
                    "src/obsolete.ts",
                ],
            ),
            (
                serde_json::json!({
                    "sessionUpdate": "tool_call_update", "toolCallId": "patch", "status": status
                }),
                vec![
                    "src/first.ts",
                    "src/second.ts",
                    "src/renamed.ts",
                    "src/obsolete.ts",
                ],
            ),
        ];
        for (value, expected) in updates {
            let update: SessionUpdate = serde_json::from_value(value).unwrap();
            handle_session_notification(
                "agent",
                &session,
                SessionNotification::new("session", update).into(),
            )
            .await;
            let snapshot = session.snapshot().await;
            let tool = &snapshot.tools["patch"];
            assert_eq!(
                tool.locations
                    .iter()
                    .map(|location| location["path"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                expected,
            );
            let serialized = serde_json::to_string(tool).unwrap();
            assert!(!serialized.contains("private-"));
            assert!(!serialized.contains("rawInput"));
            assert!(!serialized.contains("*** Begin Patch"));
        }
    }
}

#[tokio::test]
async fn repeated_patch_input_does_not_crowd_new_files_out_of_location_budget() {
    let session = AcpSession::new("agent".into(), "thread".into());
    let mut input = "*** Begin Patch\n*** Update File: src/first.ts\n@@\n-old\n".to_string();
    for index in 0..40 {
        input.push_str("+more\n");
        let update: SessionUpdate = serde_json::from_value(serde_json::json!({
            "sessionUpdate": if index == 0 { "tool_call" } else { "tool_call_update" },
            "toolCallId": "patch", "title": "functions.apply_patch",
            "kind": "edit", "status": "in_progress", "rawInput": input,
            "locations": [{"path":"src/explicit.ts","line":7}]
        }))
        .unwrap();
        handle_session_notification(
            "agent",
            &session,
            SessionNotification::new("session", update).into(),
        )
        .await;
    }
    input.push_str("*** Add File: src/last.ts\n");
    let update = serde_json::from_value(serde_json::json!({
        "sessionUpdate": "tool_call_update", "toolCallId": "patch", "rawInput": input
    }))
    .unwrap();
    handle_session_notification(
        "agent",
        &session,
        SessionNotification::new("session", update).into(),
    )
    .await;
    let snapshot = session.snapshot().await;
    assert_eq!(
        snapshot.tools["patch"].locations,
        serde_json::json!([
            {"path":"src/explicit.ts","line":7}, {"path":"src/first.ts"}, {"path":"src/last.ts"}
        ])
        .as_array()
        .unwrap()
        .to_vec(),
    );
}

#[tokio::test]
async fn plan_entries_use_acp_wire_values_not_debug_formatting() {
    let session = AcpSession::new("agent".into(), "thread".into());
    let update: SessionUpdate = serde_json::from_value(serde_json::json!({
        "sessionUpdate": "plan",
        "entries": [
            {"content": "Read", "priority": "high", "status": "completed"},
            {"content": "Edit", "priority": "medium", "status": "in_progress"},
            {"content": "Test", "priority": "low", "status": "pending"}
        ]
    }))
    .expect("plan update");

    handle_session_notification(
        "agent",
        &session,
        SessionNotification::new("session", update).into(),
    )
    .await;

    let snapshot = session.snapshot().await;
    assert_eq!(
        snapshot
            .plan
            .iter()
            .map(|entry| (entry.priority.as_str(), entry.status.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("high", "completed"),
            ("medium", "in_progress"),
            ("low", "pending"),
        ],
    );
}

#[tokio::test]
async fn typed_tool_update_preserves_all_structured_variants_and_excludes_raw_fields() {
    let session = AcpSession::new("agent".into(), "thread".into());
    let update: SessionUpdate = serde_json::from_value(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "tool",
        "title": "Structured",
        "kind": "edit",
        "status": "completed",
        "content": [
            {"type": "content", "content": {"type": "text", "text": "done"}},
            {"type": "content", "content": {"type": "image", "data": "aW1hZ2U=", "mimeType": "image/png"}},
            {"type": "content", "content": {"type": "audio", "data": "YXVkaW8=", "mimeType": "audio/wav"}},
            {"type": "content", "content": {"type": "resource_link", "uri": "file:///tmp/file", "name": "file"}},
            {"type": "content", "content": {"type": "resource", "resource": {"uri": "file:///tmp/file", "text": "body", "mimeType": "text/plain"}}},
            {"type": "diff", "path": "/tmp/file", "oldText": "old", "newText": "new"},
            {"type": "terminal", "terminalId": "terminal-1"}
        ],
        "locations": [{"path": "/tmp/file", "line": 7}],
        "rawInput": {"secret": "must-not-appear"},
        "rawOutput": {"secret": "must-not-appear"}
    }))
    .expect("typed tool update");
    handle_session_notification(
        "agent",
        &session,
        SessionNotification::new("session", update).into(),
    )
    .await;
    let snapshot = session.snapshot().await;
    let tool = &snapshot.tools["tool"];
    assert_eq!(tool.content, "done");
    assert_eq!(tool.structured_content.len(), 7);
    assert_eq!(tool.structured_content[1]["content"]["type"], "image");
    assert_eq!(tool.structured_content[2]["content"]["type"], "audio");
    assert_eq!(
        tool.structured_content[3]["content"]["type"],
        "resource_link",
    );
    assert_eq!(tool.structured_content[4]["content"]["type"], "resource");
    assert_eq!(tool.structured_content[5]["type"], "diff");
    assert_eq!(tool.structured_content[6]["type"], "terminal");
    assert_eq!(tool.locations[0]["line"], 7);
    let serialized = serde_json::to_string(tool).unwrap();
    assert!(!serialized.contains("must-not-appear"));
    assert!(!serialized.contains("rawInput"));
    assert!(!serialized.contains("rawOutput"));
}

#[tokio::test]
async fn non_text_message_blocks_are_preserved_without_placeholders_or_raw_secrets() {
    let session = AcpSession::new("agent".into(), "thread".into());
    let blocks = [
        serde_json::json!({"type":"image","data":"aW1hZ2U=","mimeType":"image/png"}),
        serde_json::json!({"type":"audio","data":"YXVkaW8=","mimeType":"audio/wav"}),
        serde_json::json!({"type":"resource_link","uri":"file:///tmp/file","name":"file","mimeType":"text/plain"}),
        serde_json::json!({"type":"resource","resource":{"uri":"file:///tmp/file","text":"body","mimeType":"text/plain","rawInput":{"secret":"hidden"}}}),
    ];
    for (index, block) in blocks.into_iter().enumerate() {
        let update: SessionUpdate = serde_json::from_value(serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "messageId": format!("message-{index}"),
            "content": block,
        }))
        .expect("typed message update");
        handle_session_notification(
            "agent",
            &session,
            SessionNotification::new("session", update).into(),
        )
        .await;
    }
    let snapshot = session.snapshot().await;
    assert_eq!(snapshot.messages.len(), 4);
    let serialized = serde_json::to_string(&snapshot.messages).unwrap();
    for content_type in ["image", "audio", "resource_link", "resource"] {
        assert!(serialized.contains(content_type));
    }
    assert!(!serialized.contains("non-text content omitted"));
    assert!(!serialized.contains("hidden"));
    assert!(!serialized.contains("rawInput"));
}

#[tokio::test]
async fn reconstructed_agent_message_envelopes_may_span_multiple_user_chunks() {
    let session = AcpSession::new("agent".into(), "child".into());
    session
        .emit(CanonicalEvent::AgentMessage {
            agent_id: "agent".to_string(),
            thread_id: "child".to_string(),
            message: crate::agent_messaging::AgentMessageOrigin {
                message_id: "message-1".to_string(),
                direction: crate::agent_messaging::AgentMessageDirection::Received,
                related_thread_id: "parent".to_string(),
                related_title: Some("Parent agent".to_string()),
                relation: crate::agent_messaging::AgentRelationKind::Parent,
                disposition: crate::agent_messaging::AgentMessageDisposition::Steering,
                body: "Inspect the queue lifecycle.".to_string(),
            },
        })
        .await;
    let envelope = crate::agent_messaging::AgentMessageEnvelope::new(
        "message-1".to_string(),
        "parent".to_string(),
        "child".to_string(),
        crate::agent_messaging::AgentRelationKind::SubAgent,
        Some("Parent agent".to_string()),
        "Inspect the queue lifecycle.".to_string(),
    )
    .encode()
    .unwrap();
    let split_at = envelope.len() / 2;
    for content in [&envelope[..split_at], &envelope[split_at..]] {
        let update: SessionUpdate = serde_json::from_value(serde_json::json!({
            "sessionUpdate": "user_message_chunk",
            "messageId": "history-message",
            "content": {"type": "text", "text": content}
        }))
        .expect("typed user update");
        handle_session_notification(
            "agent",
            &session,
            ReceivedSessionNotification {
                notification: SessionNotification::new("session", update),
                operation: None,
                reconstruction: true,
            },
        )
        .await;
    }

    let snapshot = session.snapshot().await;
    assert_eq!(snapshot.messages.len(), 1);
    assert_eq!(snapshot.messages[0].id, "agent-message:message-1");
    let origin = snapshot.messages[0]
        .agent_message
        .as_ref()
        .expect("typed agent-message origin");
    assert_eq!(origin.body, "Inspect the queue lifecycle.");
    assert_eq!(
        origin.direction,
        crate::agent_messaging::AgentMessageDirection::Received,
    );
    assert_eq!(
        origin.relation,
        crate::agent_messaging::AgentRelationKind::Parent,
    );
    assert_eq!(
        origin.disposition,
        crate::agent_messaging::AgentMessageDisposition::Steering,
    );
}

#[tokio::test]
async fn incomplete_live_agent_message_prefix_is_flushed_as_ordinary_text_at_run_end() {
    let session = AcpSession::new("agent".into(), "thread".into());
    let (generation, _) = session
        .admit_prompt("run".to_string(), "turn".to_string())
        .await
        .expect("prompt admission");
    let content = "<<<dappercode.dev/agent-message:v1>>>";
    let update: SessionUpdate = serde_json::from_value(serde_json::json!({
        "sessionUpdate": "user_message_chunk",
        "messageId": "live-user-message",
        "content": {"type": "text", "text": content}
    }))
    .expect("typed user update");

    handle_session_notification(
        "agent",
        &session,
        ReceivedSessionNotification {
            notification: SessionNotification::new("session", update),
            operation: None,
            reconstruction: false,
        },
    )
    .await;

    let snapshot = session.snapshot().await;
    assert!(snapshot.messages.is_empty());

    session
        .emit(CanonicalEvent::RunFinished {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: "run".to_string(),
            source_turn_id: "turn".to_string(),
            generation,
            stop_reason: agent_client_protocol::v1::schema::StopReason::EndTurn,
        })
        .await;
    let snapshot = session.snapshot().await;
    assert_eq!(snapshot.messages.len(), 1);
    assert_eq!(snapshot.messages[0].parts[0]["text"], content);
    assert!(snapshot.messages[0].agent_message.is_none());
}

#[tokio::test]
async fn split_live_agent_message_echo_is_typed_and_deduplicated() {
    let session = AcpSession::new("agent".into(), "child".into());
    session
        .emit(CanonicalEvent::AgentMessage {
            agent_id: "agent".to_string(),
            thread_id: "child".to_string(),
            message: crate::agent_messaging::AgentMessageOrigin {
                message_id: "live-message".to_string(),
                direction: crate::agent_messaging::AgentMessageDirection::Received,
                related_thread_id: "parent".to_string(),
                related_title: Some("Parent agent".to_string()),
                relation: crate::agent_messaging::AgentRelationKind::Parent,
                disposition: crate::agent_messaging::AgentMessageDisposition::Sent,
                body: "Echo this only as a typed activity.".to_string(),
            },
        })
        .await;
    let envelope = crate::agent_messaging::AgentMessageEnvelope::new(
        "live-message".to_string(),
        "parent".to_string(),
        "child".to_string(),
        crate::agent_messaging::AgentRelationKind::SubAgent,
        Some("Parent agent".to_string()),
        "Echo this only as a typed activity.".to_string(),
    )
    .encode()
    .expect("agent message envelope");
    let split_at = envelope.find('{').expect("JSON payload") + 8;
    let echoed = format!("{}\n", &envelope[split_at..]);
    for chunk in [&envelope[..split_at], echoed.as_str()] {
        let update: SessionUpdate = serde_json::from_value(serde_json::json!({
            "sessionUpdate": "user_message_chunk",
            "messageId": "live-user-message",
            "content": {"type": "text", "text": chunk}
        }))
        .expect("typed user update");
        handle_session_notification(
            "agent",
            &session,
            ReceivedSessionNotification {
                notification: SessionNotification::new("session", update),
                operation: Some(("run".to_string(), "turn".to_string(), 1)),
                reconstruction: false,
            },
        )
        .await;
    }

    let snapshot = session.snapshot().await;
    assert_eq!(snapshot.messages.len(), 1);
    assert_eq!(snapshot.messages[0].id, "agent-message:live-message");
    assert_eq!(
        snapshot.messages[0]
            .agent_message
            .as_ref()
            .expect("typed activity")
            .disposition,
        crate::agent_messaging::AgentMessageDisposition::Sent,
    );
    assert!(!serde_json::to_string(&snapshot.messages)
        .expect("snapshot serializes")
        .contains("<<<dappercode.dev/agent-message"));
}

#[tokio::test]
async fn replayed_agent_message_for_another_thread_remains_ordinary_text() {
    let session = AcpSession::new("agent".into(), "fork".into());
    let envelope = crate::agent_messaging::AgentMessageEnvelope::new(
        "message-from-original".to_string(),
        "parent".to_string(),
        "original-child".to_string(),
        crate::agent_messaging::AgentRelationKind::SubAgent,
        Some("Parent agent".to_string()),
        "Do not project this onto the fork.".to_string(),
    )
    .encode()
    .expect("agent message envelope");
    let update: SessionUpdate = serde_json::from_value(serde_json::json!({
        "sessionUpdate": "user_message_chunk",
        "messageId": "history-message",
        "content": {"type": "text", "text": envelope}
    }))
    .expect("typed user update");

    handle_session_notification(
        "agent",
        &session,
        ReceivedSessionNotification {
            notification: SessionNotification::new("session", update),
            operation: None,
            reconstruction: true,
        },
    )
    .await;

    let snapshot = session.snapshot().await;
    assert_eq!(snapshot.messages.len(), 1);
    assert!(snapshot.messages[0].agent_message.is_none());
    assert!(snapshot.messages[0].parts[0]["text"]
        .as_str()
        .expect("ordinary text")
        .contains("message-from-original"));
}

#[tokio::test]
async fn oversized_single_text_chunk_is_utf8_bounded_and_marked_truncated() {
    let session = AcpSession::new("agent".into(), "thread".into());
    let update: SessionUpdate = serde_json::from_value(serde_json::json!({
        "sessionUpdate": "agent_message_chunk",
        "messageId": "oversized",
        "content": {"type":"text","text":"é".repeat(MAX_MESSAGE_CHUNK_BYTES)}
    }))
    .expect("typed message update");
    handle_session_notification(
        "agent",
        &session,
        SessionNotification::new("session", update).into(),
    )
    .await;
    let snapshot = session.snapshot().await;
    let message = &snapshot.messages[0];
    assert!(message.truncated);
    assert!(message.parts[0]["text"].as_str().unwrap().len() <= MAX_MESSAGE_CHUNK_BYTES);
    assert_eq!(message.parts[1]["truncated"], true);
}

#[test]
fn structured_value_sanitizer_is_lossless_and_filters_every_excluded_key() {
    let values = vec![serde_json::Value::Object(
        (0..64)
            .map(|index| {
                (
                    format!("key-{index}"),
                    serde_json::json!("x".repeat(40_000)),
                )
            })
            .collect(),
    )];
    let bounded = bounded_values(&values, MAX_STRUCTURED_ITEMS);
    assert_eq!(bounded.len(), 1);
    assert_eq!(bounded[0]["truncated"], true);

    let filtered = bound_json(serde_json::json!({
        "rawInput": "secret",
        "rawOutput": "secret",
        "_meta": "secret",
        "kept": "value"
    }));
    assert_eq!(filtered, serde_json::json!({"kept": "value"}));

    let capped = bounded_values(&(0..70).collect::<Vec<_>>(), MAX_STRUCTURED_ITEMS);
    assert_eq!(capped.len(), MAX_STRUCTURED_ITEMS);
}

#[test]
fn text_and_structure_bounds_cover_full_buffers_and_utf8_boundaries() {
    let content: Vec<ToolCallContent> = serde_json::from_value(serde_json::json!([
        {"type": "content", "content": {"type": "text", "text": "first"}},
        {"type": "content", "content": {"type": "text", "text": "second"}}
    ]))
    .unwrap();
    assert_eq!(tool_content(&content), "first\nsecond");

    let full: Vec<ToolCallContent> = serde_json::from_value(serde_json::json!([
        {
            "type": "content",
            "content": {"type": "text", "text": "x".repeat(MAX_TOOL_TEXT_CHUNK_BYTES)}
        },
        {"type": "content", "content": {"type": "text", "text": "ignored"}}
    ]))
    .unwrap();
    assert_eq!(tool_content(&full).len(), MAX_TOOL_TEXT_CHUNK_BYTES);

    let crowded = serde_json::Value::Object(
        (0..=MAX_STRUCTURED_FIELDS)
            .map(|index| (format!("key-{index}"), serde_json::json!(index)))
            .collect(),
    );
    assert_eq!(
        bound_json(crowded).as_object().unwrap().len(),
        MAX_STRUCTURED_FIELDS,
    );

    let mut target = "full".to_string();
    append_bounded(&mut target, "ignored", 4);
    assert_eq!(target, "full");
    assert_eq!(bound_text("é".to_string(), 1), "");
}

fn live(update: SessionUpdate, generation: u64) -> ReceivedSessionNotification {
    ReceivedSessionNotification {
        notification: SessionNotification::new("session", update),
        operation: Some(("run".to_string(), "turn".to_string(), generation)),
        reconstruction: false,
    }
}

fn thought(text: &str) -> SessionUpdate {
    serde_json::from_value(serde_json::json!({
        "sessionUpdate": "agent_thought_chunk",
        "content": {"type": "text", "text": text}
    }))
    .expect("thought chunk")
}

fn agent_text(text: &str) -> SessionUpdate {
    serde_json::from_value(serde_json::json!({
        "sessionUpdate": "agent_message_chunk",
        "content": {"type": "text", "text": text}
    }))
    .expect("agent chunk")
}

fn tool_call(id: &str) -> SessionUpdate {
    serde_json::from_value(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": id,
        "title": id,
        "kind": "read",
        "status": "pending"
    }))
    .expect("tool call")
}

fn tool_progress(id: &str, text: &str) -> SessionUpdate {
    serde_json::from_value(serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": id,
        "content": [{"type": "content", "content": {"type": "text", "text": text}}]
    }))
    .expect("tool update")
}

async fn timeline_of(
    updates: Vec<SessionUpdate>,
) -> (Vec<(SnapshotTimelineKind, String)>, Vec<SnapshotMessage>) {
    let session = AcpSession::new("agent".into(), "thread".into());
    let (generation, _) = session
        .admit_prompt("run".into(), "turn".into())
        .await
        .expect("prompt admitted");
    for update in updates {
        handle_session_notification("agent", &session, live(update, generation)).await;
    }
    let snapshot = session.snapshot().await;
    (
        snapshot
            .timeline
            .iter()
            .map(|entry| (entry.kind, entry.canonical_id.clone()))
            .collect(),
        snapshot.messages.iter().cloned().collect(),
    )
}

fn text_of(message: &SnapshotMessage) -> String {
    message
        .parts
        .iter()
        .filter_map(|part| part.get("text"))
        .filter_map(serde_json::Value::as_str)
        .collect()
}

#[tokio::test]
async fn reasoning_resumed_after_a_tool_call_starts_a_new_message_below_it() {
    let (timeline, messages) = timeline_of(vec![
        thought("first thought"),
        tool_call("tool-1"),
        tool_progress("tool-1", "read"),
        thought("second thought"),
        agent_text("answer"),
    ])
    .await;

    assert_eq!(
        timeline.iter().map(|(kind, _)| *kind).collect::<Vec<_>>(),
        vec![
            SnapshotTimelineKind::Reasoning,
            SnapshotTimelineKind::Tool,
            SnapshotTimelineKind::Reasoning,
            SnapshotTimelineKind::Message,
        ],
        "reasoning that resumes after a tool call must render below it",
    );
    assert_ne!(
        timeline[0].1, timeline[2].1,
        "each reasoning block needs its own message id",
    );
    assert_eq!(
        messages.iter().map(text_of).collect::<Vec<_>>(),
        vec!["first thought", "second thought", "answer"],
        "no block may be folded back into an earlier one",
    );
}

#[tokio::test]
async fn consecutive_chunks_of_one_block_keep_streaming_into_the_same_message() {
    let (timeline, messages) = timeline_of(vec![
        thought("think"),
        thought("ing"),
        agent_text("ans"),
        agent_text("wer"),
    ])
    .await;

    assert_eq!(
        timeline.iter().map(|(kind, _)| *kind).collect::<Vec<_>>(),
        vec![
            SnapshotTimelineKind::Reasoning,
            SnapshotTimelineKind::Message,
        ],
    );
    assert_eq!(
        messages.iter().map(text_of).collect::<Vec<_>>(),
        vec!["thinking", "answer"],
    );
}

#[tokio::test]
async fn a_tool_update_alone_does_not_split_the_streaming_message() {
    let (timeline, messages) = timeline_of(vec![
        tool_call("tool-1"),
        agent_text("part one "),
        tool_progress("tool-1", "still running"),
        agent_text("part two"),
    ])
    .await;

    assert_eq!(
        timeline.iter().map(|(kind, _)| *kind).collect::<Vec<_>>(),
        vec![SnapshotTimelineKind::Tool, SnapshotTimelineKind::Message,],
    );
    assert_eq!(
        messages.iter().map(text_of).collect::<Vec<_>>(),
        vec!["part one part two"],
    );
}
