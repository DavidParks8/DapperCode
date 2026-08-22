#[cfg(test)]
use agent_client_protocol::schema::v1::SessionNotification;
use agent_client_protocol::schema::v1::{
    ContentBlock, ContentChunk, SessionConfigKind, SessionUpdate, ToolCallContent, ToolCallStatus,
    ToolKind,
};
use agent_client_protocol::schema::v1::{
    SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOptions,
};
use agent_client_protocol::schema::MaybeUndefined;

use super::events::{
    CanonicalEvent, CommandEntry, ConfigEntry, ConfigOptionValue, FieldUpdate, MessageRole,
    PlanEntry,
};
use super::session::{AcpSession, AgentMessageChunkMatch, ReceivedSessionNotification};

const MAX_MESSAGE_CHUNK_BYTES: usize = 32 * 1024;
const MAX_TOOL_TEXT_CHUNK_BYTES: usize = 64 * 1024;
const MAX_STRUCTURED_ITEMS: usize = 64;
const MAX_LOCATION_ITEMS: usize = 32;
const MAX_STRUCTURED_VALUE_BYTES: usize = 16 * 1024;
const MAX_STRUCTURED_FIELDS: usize = 64;

pub async fn handle_session_notification(
    agent_id: &str,
    session: &AcpSession,
    received: ReceivedSessionNotification,
) {
    let snapshot = session.snapshot().await;
    let thread_id = snapshot.thread_id;
    let operation = if received.reconstruction {
        None
    } else {
        received.operation
    };
    let (run_id, source_turn_id, generation) = match operation {
        Some((run_id, source_turn_id, generation)) => {
            (Some(run_id), Some(source_turn_id), Some(generation))
        }
        None => (None, None, None),
    };
    let event = match received.notification.update {
        SessionUpdate::UserMessageChunk(chunk) => {
            let Some(event) = message_event(
                agent_id,
                &thread_id,
                session,
                MessageRole::User,
                chunk,
                (run_id, source_turn_id, generation),
                received.reconstruction,
            )
            .await
            else {
                return;
            };
            event
        }
        SessionUpdate::AgentMessageChunk(chunk) => message_event(
            agent_id,
            &thread_id,
            session,
            MessageRole::Agent,
            chunk,
            (run_id, source_turn_id, generation),
            received.reconstruction,
        )
        .await
        .expect("agent message chunks always produce canonical events"),
        SessionUpdate::AgentThoughtChunk(chunk) => message_event(
            agent_id,
            &thread_id,
            session,
            MessageRole::Thought,
            chunk,
            (run_id, source_turn_id, generation),
            received.reconstruction,
        )
        .await
        .expect("thought chunks always produce canonical events"),
        SessionUpdate::ToolCall(tool) => CanonicalEvent::Tool {
            agent_id: agent_id.to_string(),
            thread_id,
            run_id,
            source_turn_id,
            generation,
            tool_call_id: tool.tool_call_id.to_string(),
            kind: tool.kind,
            status: tool.status,
            title: tool.title,
            content: FieldUpdate::Set(tool_content(&tool.content)),
            structured_content: FieldUpdate::Set(bounded_tool_values(&tool.content)),
            locations: FieldUpdate::Set(bounded_values(&tool.locations, MAX_LOCATION_ITEMS)),
        },
        SessionUpdate::ToolCallUpdate(update) => {
            let existing = snapshot.tools.get(&update.tool_call_id.to_string());
            CanonicalEvent::Tool {
                agent_id: agent_id.to_string(),
                thread_id,
                run_id,
                source_turn_id,
                tool_call_id: update.tool_call_id.to_string(),
                generation: existing.and_then(|tool| tool.generation).or(generation),
                kind: update
                    .fields
                    .kind
                    .or_else(|| existing.map(|tool| tool.kind))
                    .unwrap_or(ToolKind::Other),
                status: update
                    .fields
                    .status
                    .or_else(|| existing.map(|tool| tool.status))
                    .unwrap_or(ToolCallStatus::Pending),
                title: update
                    .fields
                    .title
                    .or_else(|| existing.map(|tool| tool.title.clone()))
                    .unwrap_or_default(),
                content: update
                    .fields
                    .content
                    .as_ref()
                    .map_or(FieldUpdate::Unchanged, |content| {
                        FieldUpdate::Append(tool_content(content))
                    }),
                structured_content: update
                    .fields
                    .content
                    .as_ref()
                    .map_or(FieldUpdate::Unchanged, |content| {
                        FieldUpdate::Append(bounded_tool_values(content))
                    }),
                locations: update
                    .fields
                    .locations
                    .as_ref()
                    .map_or(FieldUpdate::Unchanged, |locations| {
                        FieldUpdate::Append(bounded_values(locations, MAX_LOCATION_ITEMS))
                    }),
            }
        }
        SessionUpdate::Plan(plan) => CanonicalEvent::Plan {
            agent_id: agent_id.to_string(),
            thread_id,
            entries: plan
                .entries
                .into_iter()
                .map(|entry| PlanEntry {
                    content: entry.content,
                    // Use the ACP wire values (`high`, `in_progress`, …) rather than
                    // Rust's Debug spelling, which mobile cannot match.
                    priority: serde_wire_value(&entry.priority),
                    status: serde_wire_value(&entry.status),
                })
                .collect(),
        },
        SessionUpdate::AvailableCommandsUpdate(update) => CanonicalEvent::Commands {
            agent_id: agent_id.to_string(),
            thread_id,
            commands: update
                .available_commands
                .into_iter()
                .map(|command| CommandEntry {
                    name: command.name,
                    description: command.description,
                })
                .collect(),
        },
        SessionUpdate::CurrentModeUpdate(update) => CanonicalEvent::Mode {
            agent_id: agent_id.to_string(),
            thread_id,
            id: update.current_mode_id.to_string(),
        },
        SessionUpdate::ConfigOptionUpdate(update) => CanonicalEvent::Config {
            agent_id: agent_id.to_string(),
            thread_id,
            entries: update
                .config_options
                .into_iter()
                .map(config_entry)
                .collect(),
        },
        SessionUpdate::SessionInfoUpdate(update) => CanonicalEvent::SessionInfo {
            agent_id: agent_id.to_string(),
            thread_id,
            title: field_update(update.title),
            updated_at: field_update(update.updated_at),
        },
        SessionUpdate::UsageUpdate(update) => CanonicalEvent::Usage {
            agent_id: agent_id.to_string(),
            thread_id,
            used: update.used,
            size: update.size,
            cost: update
                .cost
                .map(|cost| format!("{} {}", cost.amount, cost.currency)),
        },
        _ => CanonicalEvent::Ignored {
            agent_id: agent_id.to_string(),
            thread_id: Some(thread_id),
            kind: "unknown_session_update".to_string(),
        },
    };
    session.emit(event).await;
}

pub fn config_entry(option: SessionConfigOption) -> ConfigEntry {
    let value = match &option.kind {
        SessionConfigKind::Select(select) => select.current_value.to_string(),
        SessionConfigKind::Boolean(boolean) => boolean.current_value.to_string(),
        _ => "unknown".to_string(),
    };
    let options = match option.kind {
        SessionConfigKind::Select(select) => match select.options {
            SessionConfigSelectOptions::Ungrouped(options) => options,
            SessionConfigSelectOptions::Grouped(groups) => {
                groups.into_iter().flat_map(|group| group.options).collect()
            }
            _ => Vec::new(),
        },
        SessionConfigKind::Boolean(_) => Vec::new(),
        _ => Vec::new(),
    }
    .into_iter()
    .map(|entry| ConfigOptionValue {
        value: entry.value.to_string(),
        name: entry.name,
        description: entry.description,
    })
    .collect();
    ConfigEntry {
        id: option.id.to_string(),
        value,
        name: option.name,
        description: option.description,
        category: option.category.map(|category| match category {
            SessionConfigOptionCategory::Mode => "mode".to_string(),
            SessionConfigOptionCategory::Model => "model".to_string(),
            SessionConfigOptionCategory::ModelConfig => "model_config".to_string(),
            SessionConfigOptionCategory::ThoughtLevel => "thought_level".to_string(),
            SessionConfigOptionCategory::Other(value) => value,
            _ => "other".to_string(),
        }),
        options,
    }
}

pub fn config_entries(options: Vec<SessionConfigOption>) -> Vec<ConfigEntry> {
    options.into_iter().map(config_entry).collect()
}

async fn message_event(
    agent_id: &str,
    thread_id: &str,
    session: &AcpSession,
    role: MessageRole,
    chunk: ContentChunk,
    operation: (Option<String>, Option<String>, Option<u64>),
    reconstruction: bool,
) -> Option<CanonicalEvent> {
    let (run_id, source_turn_id, generation) = operation;
    let supplied = chunk.message_id.map(|id| id.to_string());
    let message_id = session
        .message_id_for_generation(role, supplied, generation)
        .await;
    let content = if role == MessageRole::User {
        match chunk.content {
            ContentBlock::Text(mut text) => {
                match session
                    .classify_agent_message_chunk(&message_id, text.text, reconstruction)
                    .await
                {
                    AgentMessageChunkMatch::Complete(envelope) => {
                        return Some(CanonicalEvent::AgentMessage {
                            agent_id: agent_id.to_string(),
                            thread_id: thread_id.to_string(),
                            message: crate::agent_messaging::AgentMessageOrigin {
                                message_id: envelope.message_id,
                                direction: crate::agent_messaging::AgentMessageDirection::Received,
                                related_thread_id: envelope.sender_thread_id,
                                related_title: envelope.sender_title,
                                relation: envelope.recipient_relation.inverse(),
                                disposition:
                                    crate::agent_messaging::AgentMessageDisposition::Queued,
                                body: envelope.body,
                            },
                        });
                    }
                    AgentMessageChunkMatch::Pending => return None,
                    AgentMessageChunkMatch::Ordinary(content) => text.text = content,
                }
                ContentBlock::Text(text)
            }
            content => content,
        }
    } else {
        chunk.content
    };
    let (content, content_block) = match content {
        ContentBlock::Text(text) => {
            let truncated = text.text.len() > MAX_MESSAGE_CHUNK_BYTES;
            (
                bound_text(text.text, MAX_MESSAGE_CHUNK_BYTES),
                truncated.then(|| {
                    serde_json::json!({
                        "type": "truncation",
                        "truncated": true,
                        "maxBytes": MAX_MESSAGE_CHUNK_BYTES,
                    })
                }),
            )
        }
        content => (
            String::new(),
            serde_json::to_value(content).ok().map(bound_json),
        ),
    };
    Some(CanonicalEvent::MessageChunk {
        agent_id: agent_id.to_string(),
        thread_id: thread_id.to_string(),
        run_id,
        source_turn_id,
        generation,
        role,
        message_id,
        content,
        content_block,
    })
}

fn tool_content(content: &[ToolCallContent]) -> String {
    let mut output = String::new();
    for text in content.iter().filter_map(|item| match item {
        ToolCallContent::Content(content) => match &content.content {
            ContentBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        },
        _ => None,
    }) {
        if !output.is_empty() {
            append_bounded(&mut output, "\n", MAX_TOOL_TEXT_CHUNK_BYTES);
        }
        append_bounded(&mut output, text, MAX_TOOL_TEXT_CHUNK_BYTES);
        if output.len() == MAX_TOOL_TEXT_CHUNK_BYTES {
            break;
        }
    }
    output
}

fn bounded_tool_values(content: &[ToolCallContent]) -> Vec<serde_json::Value> {
    bounded_values(content, MAX_STRUCTURED_ITEMS)
}

fn bounded_values<T: serde::Serialize>(values: &[T], max_items: usize) -> Vec<serde_json::Value> {
    values
        .iter()
        .take(max_items)
        .filter_map(|value| serde_json::to_value(value).ok())
        .map(bound_json)
        .collect()
}

fn bound_json(value: serde_json::Value) -> serde_json::Value {
    let value = redact_json(value, &mut 0);
    if serde_json::to_vec(&value).is_ok_and(|bytes| bytes.len() <= MAX_STRUCTURED_VALUE_BYTES) {
        value
    } else {
        serde_json::json!({"type":"truncated","truncated":true})
    }
}

fn redact_json(value: serde_json::Value, fields: &mut usize) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .take(MAX_STRUCTURED_FIELDS)
                .map(|value| redact_json(value, fields))
                .collect(),
        ),
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .into_iter()
                .filter(|(key, _)| key != "rawInput" && key != "rawOutput" && key != "_meta")
                .filter_map(|(key, value)| {
                    if *fields >= MAX_STRUCTURED_FIELDS {
                        return None;
                    }
                    *fields += 1;
                    Some((bound_text(key, 256), redact_json(value, fields)))
                })
                .collect(),
        ),
        serde_json::Value::String(value) => {
            serde_json::Value::String(bound_text(value, MAX_STRUCTURED_VALUE_BYTES))
        }
        value => value,
    }
}

fn append_bounded(target: &mut String, value: &str, max: usize) {
    let remaining = max.saturating_sub(target.len());
    if remaining == 0 {
        return;
    }
    target.push_str(&bound_text(value.to_string(), remaining));
}

fn bound_text(mut value: String, max: usize) -> String {
    if value.len() > max {
        let mut end = max;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
    }
    value
}

fn field_update(value: MaybeUndefined<String>) -> FieldUpdate {
    match value {
        MaybeUndefined::Undefined => FieldUpdate::Unchanged,
        MaybeUndefined::Null => FieldUpdate::Clear,
        MaybeUndefined::Value(value) => FieldUpdate::Set(value),
    }
}

/// Renders a serde enum with its wire spelling, falling back to Debug formatting
/// for anything that does not serialize to a bare JSON string.
fn serde_wire_value<T: serde::Serialize + std::fmt::Debug>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{value:?}"))
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::acp::snapshot::{SnapshotMessage, SnapshotTimelineKind};

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
            ]
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
            "resource_link"
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
            crate::agent_messaging::AgentMessageDirection::Received
        );
        assert_eq!(
            origin.relation,
            crate::agent_messaging::AgentRelationKind::Parent
        );
    }

    #[tokio::test]
    async fn live_agent_message_envelope_prefix_is_not_buffered_or_interpreted() {
        let session = AcpSession::new("agent".into(), "thread".into());
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
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].parts[0]["text"], content);
        assert!(snapshot.messages[0].agent_message.is_none());
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
            .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
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
            "reasoning that resumes after a tool call must render below it"
        );
        assert_ne!(
            timeline[0].1, timeline[2].1,
            "each reasoning block needs its own message id"
        );
        assert_eq!(
            messages.iter().map(text_of).collect::<Vec<_>>(),
            vec!["first thought", "second thought", "answer"],
            "no block may be folded back into an earlier one"
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
            ]
        );
        assert_eq!(
            messages.iter().map(text_of).collect::<Vec<_>>(),
            vec!["thinking", "answer"]
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
            vec![SnapshotTimelineKind::Tool, SnapshotTimelineKind::Message,]
        );
        assert_eq!(
            messages.iter().map(text_of).collect::<Vec<_>>(),
            vec!["part one part two"]
        );
    }
}
