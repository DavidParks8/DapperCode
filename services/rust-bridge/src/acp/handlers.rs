#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]

use super::events::{
    CanonicalEvent, CommandEntry, ConfigEntry, ConfigOptionValue, FieldUpdate, MessageRole,
    PlanEntry,
};
use super::session::{AcpSession, AgentMessageChunkMatch, ReceivedSessionNotification};
use agent_client_protocol::schema::MaybeUndefined;
use agent_client_protocol::v1::schema::{
    AvailableCommandInput, ContentBlock, ContentChunk, SessionConfigKind, SessionConfigOption,
    SessionConfigOptionCategory, SessionConfigSelectOptions, SessionUpdate, ToolCallContent,
    ToolCallStatus, ToolKind,
};

const MAX_MESSAGE_CHUNK_BYTES: usize = 32 * 1024;
const MAX_TOOL_TEXT_CHUNK_BYTES: usize = 64 * 1024;
const MAX_STRUCTURED_ITEMS: usize = 64;
const MAX_LOCATION_ITEMS: usize = 32;
const MAX_STRUCTURED_VALUE_BYTES: usize = 16 * 1024;
const MAX_STRUCTURED_FIELDS: usize = 64;

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
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
        )
        .await
        .expect("thought chunks always produce canonical events"),
        SessionUpdate::ToolCall(tool) => {
            let locations =
                tool_locations(&tool.locations, &tool.title, tool.raw_input.as_ref(), &[]);
            CanonicalEvent::Tool {
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
                locations: FieldUpdate::Set(locations),
            }
        }
        SessionUpdate::ToolCallUpdate(update) => {
            let existing = snapshot.tools.get(&update.tool_call_id.to_string());
            let title = update
                .fields
                .title
                .or_else(|| existing.map(|tool| tool.title.clone()))
                .unwrap_or_default();
            let locations = tool_locations(
                update.fields.locations.as_deref().unwrap_or_default(),
                &title,
                update.fields.raw_input.as_ref(),
                existing
                    .map(|tool| tool.locations.as_slice())
                    .unwrap_or(&[]),
            );
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
                title,
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
                locations: FieldUpdate::Append(locations),
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
                    // Use the ACP wire values (`high`, `in_progress`, ...) rather than
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
                    hint: command_hint(command.input),
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
async fn message_event(
    agent_id: &str,
    thread_id: &str,
    session: &AcpSession,
    role: MessageRole,
    chunk: ContentChunk,
    operation: (Option<String>, Option<String>, Option<u64>),
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
                    .classify_agent_message_chunk(&message_id, text.text, thread_id)
                    .await
                {
                    AgentMessageChunkMatch::Complete(envelope) => {
                        let disposition = session
                            .agent_message_disposition(&envelope.message_id)
                            .await
                            .unwrap_or(crate::agent_messaging::AgentMessageDisposition::Queued);
                        return Some(CanonicalEvent::AgentMessage {
                            agent_id: agent_id.to_string(),
                            thread_id: thread_id.to_string(),
                            message: crate::agent_messaging::AgentMessageOrigin {
                                message_id: envelope.message_id,
                                direction: crate::agent_messaging::AgentMessageDirection::Received,
                                related_thread_id: envelope.sender_thread_id,
                                related_title: envelope.sender_title,
                                relation: envelope.recipient_relation.inverse(),
                                disposition,
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

fn tool_locations<Location: serde::Serialize>(
    locations: &[Location],
    title: &str,
    raw_input: Option<&serde_json::Value>,
    existing: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let mut locations = bounded_values(locations, MAX_LOCATION_ITEMS);
    locations.retain(|location| !existing.contains(location));
    let patch = raw_input
        .filter(|_| {
            matches!(
                title.trim().to_ascii_lowercase().as_str(),
                "apply_patch" | "functions.apply_patch",
            )
        })
        .and_then(|input| {
            input.as_str().or_else(|| {
                ["patch", "input", "patchText", "patch_text"]
                    .iter()
                    .find_map(|key| input.get(key).and_then(serde_json::Value::as_str))
            })
        });
    if let Some(patch) = patch.filter(|patch| patch.lines().next() == Some("*** Begin Patch")) {
        // ACP rawInput updates replace the input-so-far. Publish only terminated headers;
        // an unfinished filename must not become a permanent location in the snapshot.
        for line in patch.split_inclusive('\n') {
            if !line.ends_with('\n') || line.trim_end() == "*** End Patch" {
                break;
            }
            let path = [
                "*** Add File: ",
                "*** Update File: ",
                "*** Delete File: ",
                "*** Move to: ",
            ]
            .iter()
            .find_map(|prefix| line.strip_prefix(prefix))
            .map(str::trim);
            let Some(path) = path
                .filter(|path| !path.is_empty())
                .filter(|path| path.len() <= MAX_STRUCTURED_VALUE_BYTES)
            else {
                continue;
            };
            let known = existing.iter().chain(&locations).any(|location| {
                location.get("path").and_then(serde_json::Value::as_str) == Some(path)
            });
            if !known {
                locations.push(serde_json::json!({ "path": path }));
            }
            if existing.len() + locations.len() >= MAX_LOCATION_ITEMS {
                break;
            }
        }
    }
    locations.truncate(MAX_LOCATION_ITEMS.saturating_sub(existing.len()));
    locations
}

fn bounded_values<Item: serde::Serialize>(
    values: &[Item],
    max_items: usize,
) -> Vec<serde_json::Value> {
    values
        .iter()
        .take(max_items)
        .map(serde_json::to_value)
        .filter_map(Result::ok)
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
    let slice = if value.len() > remaining {
        let mut end = remaining;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        &value[..end]
    } else {
        value
    };
    target.push_str(slice);
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

fn command_hint(input: Option<AvailableCommandInput>) -> Option<String> {
    let AvailableCommandInput::Unstructured(input) = input? else {
        return None;
    };
    let hint = input.hint.trim();
    (!hint.is_empty()).then(|| hint.to_string())
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
fn serde_wire_value<Value: serde::Serialize + std::fmt::Debug>(value: &Value) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{value:?}"))
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "handlers_tests.rs"]
mod tests;
