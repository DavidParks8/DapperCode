use crate::acp::events::{CanonicalEvent, FieldUpdate, MessageRole};
use crate::acp::identity::AgentSessionId;
use crate::acp::snapshot::{
    is_subagent_task_tool, SessionSnapshot, SnapshotMessage, SnapshotTimelineKind, SnapshotTool,
};
use crate::agui_generated::{
    AgUiEvent, AgUiEventContent, AgUiEventRole, AgUiEventType, Delta, Function, Message,
    MessageContent, MessageRole as AgUiMessageRole, ToolCall, ToolCallType,
};
use crate::resource_limits::NOTIFICATION_MAX_BYTES;
use crate::*;
use sha2::{Digest, Sha256};

pub(super) const AG_UI_EVENT_METHOD: &str = "bridge/agui.event";
const CLOSED_THREAD_CAPACITY: usize = 2048;
const OBSERVED_RUN_CAPACITY: usize = 256;
const SUBAGENT_LINK_CAPACITY: usize = 2048;
const SUBAGENT_PROGRESS_CAPACITY: usize = 1024;
const MESSAGE_CHUNK_BYTES: usize = 32 * 1024;
const TOOL_RESULT_CHUNK_BYTES: usize = 16 * 1024;
const STRUCTURED_CHUNK_BYTES: usize = 16 * 1024;
const MAX_MESSAGE_TOTAL_BYTES: usize = 32 * 1024;
const MAX_TOOL_TOTAL_BYTES: usize = 64 * 1024;
const MAX_STRUCTURED_TOOL_BYTES: usize = 64 * 1024;
const MESSAGES_SNAPSHOT_MAX_BYTES: usize = NOTIFICATION_MAX_BYTES - 16 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgUiEventEnvelope {
    pub(super) thread_id: String,
    pub(super) run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) source_turn_id: Option<String>,
    pub(super) event: AgUiEvent,
}

#[derive(Debug)]
struct AgUiRunState {
    run_id: String,
    source_turn_id: Option<String>,
    open_user_id: Option<String>,
    open_message_id: Option<String>,
    open_reasoning_id: Option<String>,
    message_bytes: HashMap<String, usize>,
    truncated_messages: HashSet<String>,
    tools: HashMap<String, AgUiToolState>,
}

#[derive(Debug, Default)]
struct AgUiToolState {
    started: bool,
    ended: bool,
    subagent_activity: bool,
    subagent_child_thread_id: Option<String>,
    subagent_terminal_status: Option<String>,
    result_content: String,
    result_revision: Option<String>,
    structured_revision: Option<String>,
    structured_content: Vec<Value>,
    locations: Vec<Value>,
    structured_truncated: bool,
    subagent_revision: Option<String>,
    meta_revision: Option<String>,
}

#[derive(Debug, Clone)]
struct SubagentActivityLink {
    parent_thread_id: String,
    parent_run_id: String,
    parent_source_turn_id: Option<String>,
    tool_call_id: String,
    child_thread_id: String,
    child_run_id: Option<String>,
    child_generation: Option<u64>,
    minimum_child_generation: Option<u64>,
    progress_revisions: HashSet<String>,
    /// The last tool the sub-agent actually ran, which is what its card reports.
    last_tool_latest: Option<String>,
    /// The last `status` and preview projected onto the card, so identical updates stay silent.
    last_rendered: Option<String>,
}

struct SubagentActivityContext<'a> {
    parent_thread_id: &'a str,
    parent_run_id: &'a str,
    parent_source_turn_id: Option<String>,
    tool_call_id: &'a str,
    child_thread_id: Option<&'a str>,
}

struct SubagentProgress {
    status: &'static str,
    latest: String,
    revision: Option<String>,
    /// Whether this preview names a tool the sub-agent ran, rather than its narration.
    from_tool: bool,
}

#[derive(Debug, Default)]
pub(super) struct AgUiProjector {
    runs: HashMap<String, AgUiRunState>,
    closed_threads: HashSet<String>,
    subagent_links: HashMap<String, SubagentActivityLink>,
    observed_runs: VecDeque<String>,
}

#[derive(Debug, Default)]
pub(super) struct CanonicalProjection {
    pub(super) events: Vec<AgUiEventEnvelope>,
    pub(super) controls: Vec<(&'static str, Value)>,
}

impl AgUiProjector {
    pub(super) fn project_canonical(&mut self, canonical: &CanonicalEvent) -> CanonicalProjection {
        let timestamp = Utc::now().timestamp_millis();
        let mut projection = CanonicalProjection::default();
        self.project_subagent_progress(canonical, timestamp, &mut projection.events);
        match canonical {
            CanonicalEvent::RunStarted {
                thread_id,
                run_id,
                source_turn_id,
                ..
            } => {
                self.closed_threads.remove(thread_id);
                if let Some(mut previous) = self.runs.remove(thread_id) {
                    let previous_run_id = previous.run_id.clone();
                    self.terminalize_run_subagents(
                        thread_id,
                        &mut previous,
                        "failed",
                        timestamp,
                        &mut projection.events,
                    );
                    self.subagent_links.retain(|_, link| {
                        link.parent_thread_id != *thread_id || link.parent_run_id != previous_run_id
                    });
                    close_run(thread_id, previous, timestamp, &mut projection.events, true);
                }
                self.runs.insert(
                    thread_id.clone(),
                    AgUiRunState {
                        run_id: run_id.clone(),
                        source_turn_id: Some(source_turn_id.clone()),
                        open_user_id: None,
                        open_message_id: None,
                        open_reasoning_id: None,
                        message_bytes: HashMap::new(),
                        truncated_messages: HashSet::new(),
                        tools: HashMap::new(),
                    },
                );
                projection.events.push(envelope(
                    thread_id,
                    run_id,
                    Some(source_turn_id.clone()),
                    run_event(
                        AgUiEventType::RunStarted,
                        thread_id.clone(),
                        run_id.clone(),
                        timestamp,
                    ),
                ));
            }
            CanonicalEvent::MessageChunk {
                thread_id,
                run_id,
                source_turn_id,
                role,
                message_id,
                content,
                content_block,
                ..
            } if !content.is_empty() || content_block.is_some() => {
                self.ensure_observed_run(
                    thread_id,
                    run_id.as_deref(),
                    source_turn_id.as_deref(),
                    timestamp,
                    &mut projection.events,
                );
                let Some(run) = canonical_run_mut(
                    &mut self.runs,
                    thread_id,
                    run_id.as_deref(),
                    source_turn_id.as_deref(),
                ) else {
                    return projection;
                };
                let (content, newly_truncated) = bounded_live_content(
                    &mut run.message_bytes,
                    &mut run.truncated_messages,
                    message_id,
                    content,
                    MAX_MESSAGE_TOTAL_BYTES,
                );
                let block_truncated = content_block.as_ref().is_some_and(|block| {
                    block
                        .get("truncated")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                });
                if let Some(content_block) = content_block {
                    push_structured_chunks(
                        &mut projection.events,
                        thread_id,
                        run,
                        "dappercode.dev/message-content",
                        message_id,
                        json!({
                            "messageId": message_id,
                            "role": format!("{role:?}").to_ascii_lowercase(),
                            "content": content_block,
                        }),
                        timestamp,
                    );
                }
                if newly_truncated
                    || (block_truncated && run.truncated_messages.insert(message_id.clone()))
                {
                    push_transcript_truncation(
                        &mut projection.events,
                        thread_id,
                        run,
                        message_id,
                        MAX_MESSAGE_TOTAL_BYTES,
                        timestamp,
                    );
                }
                match role {
                    MessageRole::Agent => {
                        if let Some(user_id) = run.open_user_id.take() {
                            push_text_message_end(
                                &mut projection.events,
                                thread_id,
                                run,
                                user_id,
                                timestamp,
                            );
                        }
                        if run.open_message_id.as_deref() != Some(message_id) {
                            if let Some(previous) = run.open_message_id.replace(message_id.clone())
                            {
                                projection.events.push(envelope(
                                    thread_id,
                                    &run.run_id,
                                    run.source_turn_id.clone(),
                                    message_event(
                                        AgUiEventType::TextMessageEnd,
                                        previous,
                                        None,
                                        None,
                                        timestamp,
                                    ),
                                ));
                            }
                            projection.events.push(envelope(
                                thread_id,
                                &run.run_id,
                                run.source_turn_id.clone(),
                                message_event(
                                    AgUiEventType::TextMessageStart,
                                    message_id.clone(),
                                    Some(AgUiEventRole::Assistant),
                                    None,
                                    timestamp,
                                ),
                            ));
                        }
                        if !content.is_empty() {
                            push_message_chunks(
                                &mut projection.events,
                                thread_id,
                                run,
                                false,
                                message_id,
                                &content,
                                timestamp,
                            );
                        }
                    }
                    MessageRole::Thought => {
                        if run.open_reasoning_id.as_deref() != Some(message_id) {
                            if let Some(previous) =
                                run.open_reasoning_id.replace(message_id.clone())
                            {
                                projection.events.push(envelope(
                                    thread_id,
                                    &run.run_id,
                                    run.source_turn_id.clone(),
                                    message_event(
                                        AgUiEventType::ReasoningMessageEnd,
                                        previous,
                                        None,
                                        None,
                                        timestamp,
                                    ),
                                ));
                            }
                            projection.events.push(envelope(
                                thread_id,
                                &run.run_id,
                                run.source_turn_id.clone(),
                                message_event(
                                    AgUiEventType::ReasoningMessageStart,
                                    message_id.clone(),
                                    Some(AgUiEventRole::Reasoning),
                                    None,
                                    timestamp,
                                ),
                            ));
                        }
                        if !content.is_empty() {
                            push_message_chunks(
                                &mut projection.events,
                                thread_id,
                                run,
                                true,
                                message_id,
                                &content,
                                timestamp,
                            );
                        }
                    }
                    MessageRole::User => {
                        if run.open_user_id.as_deref() != Some(message_id) {
                            if let Some(previous) = run.open_user_id.replace(message_id.clone()) {
                                push_text_message_end(
                                    &mut projection.events,
                                    thread_id,
                                    run,
                                    previous,
                                    timestamp,
                                );
                            }
                            projection.events.push(envelope(
                                thread_id,
                                &run.run_id,
                                run.source_turn_id.clone(),
                                message_event(
                                    AgUiEventType::TextMessageStart,
                                    message_id.clone(),
                                    Some(AgUiEventRole::User),
                                    None,
                                    timestamp,
                                ),
                            ));
                        }
                        if !content.is_empty() {
                            push_message_chunks(
                                &mut projection.events,
                                thread_id,
                                run,
                                false,
                                message_id,
                                &content,
                                timestamp,
                            );
                        }
                    }
                }
            }
            CanonicalEvent::Tool {
                agent_id,
                thread_id,
                run_id,
                source_turn_id,
                tool_call_id,
                kind,
                status,
                title,
                content,
                structured_content,
                locations,
                ..
            } => {
                let subagent_tool = is_subagent_task_tool(*kind, title);
                let update_has_task = match content {
                    FieldUpdate::Set(value) | FieldUpdate::Append(value) => {
                        parse_task_subagent(value).is_some()
                    }
                    FieldUpdate::Clear | FieldUpdate::Unchanged => false,
                };
                self.ensure_observed_run(
                    thread_id,
                    run_id.as_deref(),
                    source_turn_id.as_deref(),
                    timestamp,
                    &mut projection.events,
                );
                // Closing or re-opening the child's implicit run needs `&mut self`,
                // so defer both until the split borrow below ends.
                let mut finished_child_thread_id: Option<String> = None;
                let mut relinked_child_thread_id: Option<String> = None;
                let (runs, subagent_links) = (&mut self.runs, &mut self.subagent_links);
                let Some(run) = canonical_run_mut(
                    runs,
                    thread_id,
                    run_id.as_deref(),
                    source_turn_id.as_deref(),
                ) else {
                    return projection;
                };
                let state = run.tools.entry(tool_call_id.clone()).or_default();
                state.subagent_activity |= subagent_tool || update_has_task;
                let terminal = matches!(
                    status,
                    agent_client_protocol::schema::v1::ToolCallStatus::Completed
                        | agent_client_protocol::schema::v1::ToolCallStatus::Failed
                );
                if !state.started {
                    state.started = true;
                    if state.subagent_activity {
                        // Nothing is announced here: this update's content has not been
                        // applied yet, so the only card we could emit is a placeholder
                        // reading "starting" that carries no child thread and cannot be
                        // opened. The branches below report the sub-agent once its
                        // content has landed, which is also when its child link exists.
                    } else {
                        projection.events.push(envelope(
                            thread_id,
                            &run.run_id,
                            run.source_turn_id.clone(),
                            AgUiEvent {
                                tool_call_name: Some(bounded(
                                    if title.trim().is_empty() {
                                        format!("{kind:?}").to_ascii_lowercase()
                                    } else {
                                        title.clone()
                                    },
                                    256,
                                )),
                                ..tool_event(
                                    AgUiEventType::ToolCallStart,
                                    tool_call_id.clone(),
                                    timestamp,
                                )
                            },
                        ));
                        projection.events.push(envelope(
                            thread_id,
                            &run.run_id,
                            run.source_turn_id.clone(),
                            AgUiEvent {
                                delta: Some(Delta::String("{}".to_string())),
                                ..tool_event(
                                    AgUiEventType::ToolCallArgs,
                                    tool_call_id.clone(),
                                    timestamp,
                                )
                            },
                        ));
                    }
                }
                if terminal && !state.ended {
                    state.ended = true;
                    if !state.subagent_activity {
                        projection.events.push(envelope(
                            thread_id,
                            &run.run_id,
                            run.source_turn_id.clone(),
                            tool_event(AgUiEventType::ToolCallEnd, tool_call_id.clone(), timestamp),
                        ));
                    }
                }
                let content = match content {
                    FieldUpdate::Set(content) => {
                        Some(bounded(content.clone(), MAX_TOOL_TOTAL_BYTES))
                    }
                    FieldUpdate::Clear => Some(String::new()),
                    FieldUpdate::Append(content) => Some(bounded(
                        format!("{}{content}", state.result_content),
                        MAX_TOOL_TOTAL_BYTES,
                    )),
                    FieldUpdate::Unchanged => None,
                };
                let result_revision = content
                    .as_ref()
                    .map(|content| format!("sha256:{:x}", Sha256::digest(content.as_bytes())));
                let changed_result = match content.as_deref() {
                    None => false,
                    Some("") if state.result_revision.is_none() => false,
                    Some(_) => result_revision.as_deref() != state.result_revision.as_deref(),
                };
                let previous_content = if changed_result {
                    let previous_content = state.result_content.clone();
                    state.result_content = content.clone().unwrap_or_default();
                    state.result_revision = result_revision.clone();
                    Some(previous_content)
                } else {
                    None
                };
                let changed_structured_state = apply_structured_updates(
                    &mut state.structured_content,
                    structured_content,
                    &mut state.locations,
                    locations,
                    MAX_STRUCTURED_TOOL_BYTES,
                    &mut state.structured_truncated,
                );
                let structured_value = json!({
                    "toolCallId": tool_call_id,
                    "content": state.structured_content,
                    "locations": state.locations,
                    "retrieval": {
                        "available": !state.structured_truncated,
                    },
                });
                let structured_revision = format!(
                    "sha256:{:x}",
                    Sha256::digest(serde_json::to_vec(&structured_value).unwrap_or_default())
                );
                let changed_structured = changed_structured_state
                    && state.structured_revision.as_deref() != Some(&structured_revision);
                if changed_structured {
                    state.structured_revision = Some(structured_revision.clone());
                }
                let structured_content = state.structured_content.clone();
                let structured_locations = state.locations.clone();
                let structured_available = !state.structured_truncated;
                // Status-only updates carry no content, so read the accumulated text.
                // Using the per-update value would blank the sub-agent card and drop
                // its child-thread link.
                let accumulated_content = state.result_content.clone();
                let subagent_preview = task_result_preview(&accumulated_content)
                    .or_else(|| task_progress_preview(&accumulated_content));
                let subagent = parse_task_subagent(&accumulated_content).and_then(|task| {
                    AgentSessionId::new(agent_id, &task.session_id)
                        .ok()
                        .map(|identity| (task, identity.encode()))
                });
                if let Some((task, child_thread_id)) = subagent.as_ref() {
                    state.subagent_activity = true;
                    state.subagent_child_thread_id = Some(child_thread_id.clone());
                    let result = subagent_preview.clone();
                    let remembered_failure = state
                        .subagent_terminal_status
                        .as_deref()
                        .filter(|status| is_failed_subagent_status(status))
                        .map(str::to_string);
                    let stale_terminal_header = terminal
                        && !is_terminal_subagent_status(task.state)
                        && remembered_failure.is_some();
                    let subagent_status = remembered_failure
                        .as_deref()
                        .filter(|_| stale_terminal_header)
                        .unwrap_or_else(|| snapshot_subagent_status(*status, Some(task.state)));
                    if is_terminal_subagent_status(task.state) {
                        state.subagent_terminal_status = Some(task.state.to_string());
                    } else if !stale_terminal_header {
                        state.subagent_terminal_status = None;
                        state.ended = false;
                    }
                    let revision = format!(
                        "{}\0{}\0{}",
                        child_thread_id,
                        subagent_status,
                        result.as_deref().unwrap_or("")
                    );
                    if state.subagent_revision.as_deref() != Some(&revision) {
                        state.subagent_revision = Some(revision);
                        projection.events.push(subagent_activity_envelope(
                            SubagentActivityContext {
                                parent_thread_id: thread_id,
                                parent_run_id: &run.run_id,
                                parent_source_turn_id: run.source_turn_id.clone(),
                                tool_call_id,
                                child_thread_id: Some(child_thread_id),
                            },
                            subagent_status,
                            result.as_deref(),
                            timestamp,
                        ));
                    }
                    if is_terminal_subagent_status(task.state) || stale_terminal_header {
                        subagent_links.remove(child_thread_id);
                        finished_child_thread_id = Some(child_thread_id.clone());
                    } else {
                        relinked_child_thread_id = Some(child_thread_id.clone());
                        if !subagent_links.contains_key(child_thread_id)
                            && subagent_links.len() >= SUBAGENT_LINK_CAPACITY
                        {
                            if let Some(expired) = subagent_links.keys().next().cloned() {
                                subagent_links.remove(&expired);
                            }
                        }
                        let previous_link = subagent_links.get(child_thread_id);
                        let same_invocation = previous_link.is_some_and(|link| {
                            link.parent_run_id == run.run_id && link.tool_call_id == *tool_call_id
                        });
                        let child_run_id = same_invocation
                            .then(|| previous_link.and_then(|link| link.child_run_id.clone()))
                            .flatten();
                        let child_generation = same_invocation
                            .then(|| previous_link.and_then(|link| link.child_generation))
                            .flatten();
                        let minimum_child_generation = if same_invocation {
                            previous_link.and_then(|link| link.minimum_child_generation)
                        } else {
                            previous_link.and_then(|link| {
                                let observed_floor = link
                                    .child_generation
                                    .map(|generation| generation.saturating_add(1));
                                match (link.minimum_child_generation, observed_floor) {
                                    (Some(existing), Some(observed)) => {
                                        Some(existing.max(observed))
                                    }
                                    (Some(existing), None) => Some(existing),
                                    (None, Some(observed)) => Some(observed),
                                    (None, None) => None,
                                }
                            })
                        };
                        let progress_revisions = if same_invocation {
                            previous_link
                                .map(|link| link.progress_revisions.clone())
                                .unwrap_or_default()
                        } else {
                            HashSet::new()
                        };
                        let (last_tool_latest, last_rendered) = if same_invocation {
                            previous_link
                                .map(|link| {
                                    (link.last_tool_latest.clone(), link.last_rendered.clone())
                                })
                                .unwrap_or((None, None))
                        } else {
                            (None, None)
                        };
                        subagent_links.insert(
                            child_thread_id.clone(),
                            SubagentActivityLink {
                                parent_thread_id: thread_id.clone(),
                                parent_run_id: run.run_id.clone(),
                                parent_source_turn_id: run.source_turn_id.clone(),
                                tool_call_id: tool_call_id.clone(),
                                child_thread_id: child_thread_id.clone(),
                                child_run_id,
                                child_generation,
                                minimum_child_generation,
                                progress_revisions,
                                last_tool_latest,
                                last_rendered,
                            },
                        );
                    }
                }
                // Read after the linked branch above, which can classify this tool as a
                // sub-agent from accumulated content when the update itself carried none.
                let is_subagent_tool = state.subagent_activity;
                // The client renders one row per tool call and needs the ACP kind, status
                // and title to pick its icon, its progress affordance and its failure
                // styling. A status transition carries no content, so this cannot ride on
                // the tool-content event, which only fires when structured content moves.
                let kind_wire = tool_kind_wire(*kind);
                let status_wire = tool_status_wire(*status);
                // Mirror the fallback `TOOL_CALL_START` already uses so a blank ACP title
                // never reaches the client as an empty row label.
                let title_wire = if title.trim().is_empty() {
                    kind_wire.clone()
                } else {
                    bounded(title, 256)
                };
                let meta_revision = format!("{kind_wire}\0{status_wire}\0{title_wire}");
                let meta_changed = !is_subagent_tool
                    && state.meta_revision.as_deref() != Some(meta_revision.as_str());
                if meta_changed {
                    state.meta_revision = Some(meta_revision);
                }
                // Agents that never stream a child session only report progress through
                // this tool, so mirror its latest output onto the card. Without real
                // output there is nothing to say: an empty card reports "starting" and
                // cannot be opened, so stay silent until the sub-agent reports or ends.
                let known_child_thread_id = state.subagent_child_thread_id.clone();
                if let Some(latest) = subagent_preview
                    .clone()
                    .filter(|_| is_subagent_tool && !terminal && subagent.is_none())
                {
                    let revision = format!(
                        "{}\0running\0{latest}",
                        known_child_thread_id.as_deref().unwrap_or("unlinked")
                    );
                    if state.subagent_revision.as_deref() != Some(&revision) {
                        state.subagent_revision = Some(revision);
                        projection.events.push(subagent_activity_envelope(
                            SubagentActivityContext {
                                parent_thread_id: thread_id,
                                parent_run_id: &run.run_id,
                                parent_source_turn_id: run.source_turn_id.clone(),
                                tool_call_id,
                                child_thread_id: known_child_thread_id.as_deref(),
                            },
                            "running",
                            Some(latest.as_str()),
                            timestamp,
                        ));
                    }
                }
                if state.subagent_activity && terminal && subagent.is_none() {
                    let wrapper_failed = matches!(
                        status,
                        agent_client_protocol::schema::v1::ToolCallStatus::Failed
                    );
                    let status = state
                        .subagent_terminal_status
                        .as_deref()
                        .filter(|status| is_failed_subagent_status(status))
                        .unwrap_or({
                            if wrapper_failed {
                                "failed"
                            } else {
                                "completed"
                            }
                        });
                    let latest = subagent_preview.clone();
                    let revision = format!(
                        "{}\0{status}\0{}",
                        known_child_thread_id.as_deref().unwrap_or("unlinked"),
                        latest.as_deref().unwrap_or("")
                    );
                    if state.subagent_revision.as_deref() != Some(&revision) {
                        state.subagent_revision = Some(revision);
                        projection.events.push(subagent_activity_envelope(
                            SubagentActivityContext {
                                parent_thread_id: thread_id,
                                parent_run_id: &run.run_id,
                                parent_source_turn_id: run.source_turn_id.clone(),
                                tool_call_id,
                                child_thread_id: known_child_thread_id.as_deref(),
                            },
                            status,
                            latest.as_deref().or(Some("Task finished")),
                            timestamp,
                        ));
                    }
                    let terminal_child_known = state
                        .subagent_terminal_status
                        .as_deref()
                        .is_some_and(is_terminal_subagent_status);
                    if terminal_child_known || wrapper_failed {
                        if let Some(child_thread_id) = known_child_thread_id {
                            subagent_links.remove(&child_thread_id);
                            finished_child_thread_id = Some(child_thread_id);
                        }
                    }
                }
                if meta_changed {
                    push_structured_chunks(
                        &mut projection.events,
                        thread_id,
                        run,
                        "dappercode.dev/tool-meta",
                        tool_call_id,
                        json!({
                            "toolCallId": tool_call_id,
                            "kind": kind_wire,
                            "status": status_wire,
                            "title": title_wire,
                        }),
                        timestamp,
                    );
                }
                if let Some(previous_content) = previous_content {
                    let content = content.clone().unwrap_or_default();
                    if is_subagent_tool {
                        // A sub-agent's task payload is already rendered by its card.
                        // Echoing it as tool text or a tool result leaves a phantom
                        // tool card next to the card that says the same thing.
                    } else if terminal
                        && content.starts_with(&previous_content)
                        && !content.is_empty()
                    {
                        let suffix = &content[previous_content.len()..];
                        for chunk in utf8_chunks(suffix, TOOL_RESULT_CHUNK_BYTES) {
                            projection.events.push(envelope(
                                thread_id,
                                &run.run_id,
                                run.source_turn_id.clone(),
                                AgUiEvent {
                                    message_id: Some(format!(
                                        "{}::tool-result::{tool_call_id}",
                                        run.run_id
                                    )),
                                    role: Some(AgUiEventRole::Tool),
                                    content: Some(AgUiEventContent::String(chunk.to_string())),
                                    ..tool_event(
                                        AgUiEventType::ToolCallResult,
                                        tool_call_id.clone(),
                                        timestamp,
                                    )
                                },
                            ));
                        }
                    } else {
                        push_structured_chunks(
                            &mut projection.events,
                            thread_id,
                            run,
                            "dappercode.dev/tool-text",
                            tool_call_id,
                            json!({
                                "toolCallId": tool_call_id,
                                "revision": result_revision,
                                "content": content,
                            }),
                            timestamp,
                        );
                    }
                }
                if changed_structured && !is_subagent_tool {
                    push_structured_chunks(
                        &mut projection.events,
                        thread_id,
                        run,
                        "dappercode.dev/tool-content",
                        tool_call_id,
                        json!({
                            "toolCallId": tool_call_id,
                            "content": structured_content,
                            "locations": structured_locations,
                            "revision": structured_revision,
                            "retrieval": {
                                "available": structured_available,
                            },
                        }),
                        timestamp,
                    );
                }
                if let Some(child_thread_id) = finished_child_thread_id {
                    self.close_observed_run(&child_thread_id, timestamp, &mut projection.events);
                }
                if let Some(child_thread_id) = relinked_child_thread_id {
                    // A parent can re-task the same child session. Closing its implicit
                    // run marked the thread closed, so clear that or the child would
                    // never stream again.
                    self.closed_threads.remove(&child_thread_id);
                }
            }
            CanonicalEvent::RunFinished {
                thread_id, run_id, ..
            }
            | CanonicalEvent::RunFailed {
                thread_id, run_id, ..
            } => {
                let std::collections::hash_map::Entry::Occupied(entry) =
                    self.runs.entry(thread_id.clone())
                else {
                    return projection;
                };
                if entry.get().run_id != *run_id {
                    return projection;
                }
                let mut run = entry.remove();
                let run_cancelled = matches!(
                    canonical,
                    CanonicalEvent::RunFinished {
                        stop_reason: agent_client_protocol::schema::v1::StopReason::Cancelled,
                        ..
                    }
                );
                let run_failed =
                    run_cancelled || matches!(canonical, CanonicalEvent::RunFailed { .. });
                self.terminalize_run_subagents(
                    thread_id,
                    &mut run,
                    if run_cancelled {
                        "cancelled"
                    } else if run_failed {
                        "failed"
                    } else {
                        "completed"
                    },
                    timestamp,
                    &mut projection.events,
                );
                close_run(thread_id, run, timestamp, &mut projection.events, false);
                let source_turn_id = canonical_source_turn_id(canonical).map(str::to_string);
                projection.events.push(envelope(
                    thread_id,
                    run_id,
                    source_turn_id,
                    if let CanonicalEvent::RunFailed { message, .. } = canonical {
                        AgUiEvent {
                            message: Some(bounded(message, 2 * 1024)),
                            code: Some("acp_run_failed".to_string()),
                            ..generated_event(AgUiEventType::RunError, timestamp)
                        }
                    } else {
                        run_event(
                            AgUiEventType::RunFinished,
                            thread_id.clone(),
                            run_id.clone(),
                            timestamp,
                        )
                    },
                ));
                self.mark_thread_closed(thread_id);
                if run_failed {
                    self.subagent_links.retain(|_, link| {
                        link.parent_thread_id != *thread_id || link.parent_run_id != *run_id
                    });
                }
            }
            CanonicalEvent::PermissionRequested { approval } => {
                projection.controls.push((
                    "bridge/approval.requested",
                    serde_json::to_value(approval).expect("pending approval serializes"),
                ));
            }
            CanonicalEvent::PermissionResolved {
                thread_id,
                request_id,
                outcome,
                ..
            } => {
                projection.controls.push((
                    "bridge/approval.resolved",
                    json!({
                        "id": request_id, "threadId": thread_id, "outcome": bounded(outcome, 256)
                    }),
                ));
            }
            CanonicalEvent::ElicitationRequested { request } => {
                projection.controls.push((
                    "bridge/userInput.requested",
                    serde_json::to_value(request).expect("pending user input serializes"),
                ));
            }
            CanonicalEvent::ElicitationResolved {
                thread_id,
                request_id,
                action,
                ..
            } => {
                projection.controls.push((
                    "bridge/userInput.resolved",
                    json!({
                        "id": request_id, "threadId": thread_id, "action": bounded(action, 256)
                    }),
                ));
            }
            CanonicalEvent::Plan {
                thread_id, entries, ..
            } => push_activity(
                &mut projection.events,
                &self.runs,
                thread_id,
                format!("{thread_id}::plan"),
                "dappercode.plan",
                json!({
                    "text": "Plan updated",
                    "entries": entries.iter().take(128).map(|entry| json!({
                    "content": bounded(&entry.content, 2 * 1024),
                    "priority": bounded(&entry.priority, 256),
                    "status": bounded(&entry.status, 256)
                })).collect::<Vec<_>>() }),
                timestamp,
            ),
            CanonicalEvent::Usage {
                thread_id,
                used,
                size,
                cost,
                ..
            } => push_custom(
                &mut projection.events,
                &self.runs,
                thread_id,
                "dappercode.dev/usage",
                json!({ "used": used, "size": size, "cost": cost.as_deref().map(|value| bounded(value, 256)) }),
                timestamp,
            ),
            CanonicalEvent::Mode { thread_id, id, .. } => push_custom(
                &mut projection.events,
                &self.runs,
                thread_id,
                "dappercode.dev/mode",
                json!({ "id": bounded(id, 256) }),
                timestamp,
            ),
            CanonicalEvent::Config {
                thread_id, entries, ..
            } => push_custom(
                &mut projection.events,
                &self.runs,
                thread_id,
                "dappercode.dev/config",
                json!({ "entries": entries.iter().take(128).map(|entry| json!({
                    "id": bounded(&entry.id, 256),
                    "value": bounded(&entry.value, 2 * 1024)
                })).collect::<Vec<_>>() }),
                timestamp,
            ),
            CanonicalEvent::SessionInfo {
                thread_id,
                title,
                updated_at,
                ..
            } => push_custom(
                &mut projection.events,
                &self.runs,
                thread_id,
                "dappercode.dev/session-info",
                json!({ "title": field_value(title), "updatedAt": field_value(updated_at) }),
                timestamp,
            ),
            CanonicalEvent::Commands {
                thread_id,
                commands,
                ..
            } => push_custom(
                &mut projection.events,
                &self.runs,
                thread_id,
                "dappercode.dev/commands",
                json!({ "commands": commands.iter().take(128).map(|command| json!({
                    "name": bounded(&command.name, 256),
                    "description": bounded(&command.description, 2 * 1024)
                })).collect::<Vec<_>>() }),
                timestamp,
            ),
            CanonicalEvent::Ignored { .. } | CanonicalEvent::MessageChunk { .. } => {}
        }
        projection
    }

    /// Sub-agent threads are driven by the agent itself, so no client prompt ever
    /// opens a run for them and every live event they produce would be dropped.
    /// Open an implicit run the first time such a thread emits output so its
    /// transcript streams like any other thread.
    fn ensure_observed_run(
        &mut self,
        thread_id: &str,
        run_id: Option<&str>,
        source_turn_id: Option<&str>,
        timestamp: i64,
        events: &mut Vec<AgUiEventEnvelope>,
    ) {
        if run_id.is_some()
            || source_turn_id.is_some()
            || self.runs.contains_key(thread_id)
            || self.closed_threads.contains(thread_id)
        {
            return;
        }
        let observed_run_id = format!("{thread_id}::observed");
        self.runs.insert(
            thread_id.to_string(),
            AgUiRunState {
                run_id: observed_run_id.clone(),
                source_turn_id: None,
                open_user_id: None,
                open_message_id: None,
                open_reasoning_id: None,
                message_bytes: HashMap::new(),
                truncated_messages: HashSet::new(),
                tools: HashMap::new(),
            },
        );
        self.observed_runs.push_back(thread_id.to_string());
        while self.observed_runs.len() > OBSERVED_RUN_CAPACITY {
            if let Some(oldest) = self.observed_runs.pop_front() {
                if self
                    .runs
                    .get(&oldest)
                    .is_some_and(|run| run.source_turn_id.is_none())
                {
                    self.close_observed_run(&oldest, timestamp, events);
                }
            }
        }
        events.push(envelope(
            thread_id,
            &observed_run_id.clone(),
            None,
            run_event(
                AgUiEventType::RunStarted,
                thread_id.to_string(),
                observed_run_id,
                timestamp,
            ),
        ));
    }

    /// Closes an implicit run once the sub-agent that owns it reaches a terminal
    /// state, so clients stop showing the thread as working and the projector
    /// stops retaining its buffers.
    fn close_observed_run(
        &mut self,
        thread_id: &str,
        timestamp: i64,
        events: &mut Vec<AgUiEventEnvelope>,
    ) {
        let observed_run_id = format!("{thread_id}::observed");
        if self
            .runs
            .get(thread_id)
            .is_none_or(|run| run.run_id != observed_run_id)
        {
            return;
        }
        let Some(run) = self.runs.remove(thread_id) else {
            return;
        };
        self.observed_runs.retain(|entry| entry != thread_id);
        close_run(thread_id, run, timestamp, events, false);
        events.push(envelope(
            thread_id,
            &observed_run_id.clone(),
            None,
            run_event(
                AgUiEventType::RunFinished,
                thread_id.to_string(),
                observed_run_id,
                timestamp,
            ),
        ));
        self.mark_thread_closed(thread_id);
    }

    fn mark_thread_closed(&mut self, thread_id: &str) {
        if !self.closed_threads.contains(thread_id)
            && self.closed_threads.len() >= CLOSED_THREAD_CAPACITY
        {
            if let Some(oldest) = self.closed_threads.iter().next().cloned() {
                self.closed_threads.remove(&oldest);
            }
        }
        self.closed_threads.insert(thread_id.to_string());
    }

    fn terminalize_run_subagents(
        &mut self,
        parent_thread_id: &str,
        run: &mut AgUiRunState,
        fallback_status: &str,
        timestamp: i64,
        events: &mut Vec<AgUiEventEnvelope>,
    ) {
        let mut child_threads_to_close = Vec::new();
        for (tool_call_id, tool) in &mut run.tools {
            if !tool.subagent_activity || tool.ended {
                continue;
            }
            let remembered_terminal = tool
                .subagent_terminal_status
                .as_deref()
                .filter(|status| is_terminal_subagent_status(status))
                .map(str::to_string);
            let parsed_terminal = parse_task_subagent(&tool.result_content)
                .map(|task| task.state)
                .filter(|status| is_terminal_subagent_status(status))
                .map(str::to_string);
            let known_terminal = remembered_terminal.or(parsed_terminal);
            let status = known_terminal.as_deref().unwrap_or(fallback_status);
            let latest = task_result_preview(&tool.result_content)
                .or_else(|| task_progress_preview(&tool.result_content));
            events.push(subagent_activity_envelope(
                SubagentActivityContext {
                    parent_thread_id,
                    parent_run_id: &run.run_id,
                    parent_source_turn_id: run.source_turn_id.clone(),
                    tool_call_id,
                    child_thread_id: tool.subagent_child_thread_id.as_deref(),
                },
                status,
                latest.as_deref(),
                timestamp,
            ));
            tool.subagent_terminal_status = Some(status.to_string());
            tool.ended = true;
            let should_close_child =
                known_terminal.is_some() || is_failed_subagent_status(fallback_status);
            if should_close_child {
                let Some(child_thread_id) = &tool.subagent_child_thread_id else {
                    continue;
                };
                child_threads_to_close.push(child_thread_id.clone());
            }
        }
        for child_thread_id in child_threads_to_close {
            self.close_observed_run(&child_thread_id, timestamp, events);
        }
    }

    /// Records a sub-agent link discovered before its tool call reported one.
    ///
    /// The card can only follow a sub-agent's progress once the projector knows which tool call
    /// the child belongs to. An existing link is left alone: it was built from the tool's own
    /// `<task …>` header and carries run correlation this one cannot know yet.
    pub(super) fn link_subagent(
        &mut self,
        parent_thread_id: &str,
        parent_run_id: &str,
        parent_source_turn_id: Option<String>,
        tool_call_id: &str,
        child_thread_id: &str,
    ) -> bool {
        if self.subagent_links.contains_key(child_thread_id) {
            return false;
        }
        if self.subagent_links.len() >= SUBAGENT_LINK_CAPACITY {
            if let Some(expired) = self.subagent_links.keys().next().cloned() {
                self.subagent_links.remove(&expired);
            }
        }
        self.subagent_links.insert(
            child_thread_id.to_string(),
            SubagentActivityLink {
                parent_thread_id: parent_thread_id.to_string(),
                parent_run_id: parent_run_id.to_string(),
                parent_source_turn_id,
                tool_call_id: tool_call_id.to_string(),
                child_thread_id: child_thread_id.to_string(),
                child_run_id: None,
                child_generation: None,
                minimum_child_generation: None,
                progress_revisions: HashSet::new(),
                last_tool_latest: None,
                last_rendered: None,
            },
        );
        true
    }

    fn project_subagent_progress(
        &mut self,
        canonical: &CanonicalEvent,
        timestamp: i64,
        events: &mut Vec<AgUiEventEnvelope>,
    ) {
        let Some(thread_id) = canonical.thread_id() else {
            return;
        };
        let Some(link) = self.subagent_links.get(thread_id).cloned() else {
            return;
        };
        let (event_run_id, event_generation, run_started) =
            canonical_child_run_correlation(canonical);
        if link
            .minimum_child_generation
            .zip(event_generation)
            .is_some_and(|(minimum, generation)| generation < minimum)
        {
            return;
        }
        if link
            .child_generation
            .zip(event_generation)
            .is_some_and(|(expected, generation)| generation != expected)
        {
            return;
        }
        if link
            .child_run_id
            .as_deref()
            .zip(event_run_id)
            .is_some_and(|(expected, actual)| expected != actual)
        {
            return;
        }
        if run_started {
            if let Some(current) = self.subagent_links.get_mut(thread_id) {
                current.child_run_id = event_run_id.map(str::to_string);
                current.child_generation = event_generation;
            }
        }
        let Some(progress) = subagent_progress(canonical) else {
            return;
        };
        if let Some(revision) = progress.revision.as_deref() {
            let Some(current) = self.subagent_links.get_mut(thread_id) else {
                return;
            };
            if current.progress_revisions.contains(revision) {
                return;
            }
            if current.progress_revisions.len() >= SUBAGENT_PROGRESS_CAPACITY {
                current.progress_revisions.clear();
            }
            current.progress_revisions.insert(revision.to_string());
        }
        // A sub-agent narrating its answer says nothing about what it is doing, so the card keeps
        // naming the last tool it actually ran instead of churning through response text.
        let terminal = is_terminal_subagent_status(progress.status);
        let latest = if progress.from_tool || terminal {
            progress.latest.clone()
        } else {
            link.last_tool_latest
                .clone()
                .unwrap_or_else(|| progress.latest.clone())
        };
        {
            let Some(current) = self.subagent_links.get_mut(thread_id) else {
                return;
            };
            if progress.from_tool {
                current.last_tool_latest = Some(progress.latest.clone());
            }
            let rendered = format!("{}\u{0}{latest}", progress.status);
            // Repainting an unchanged card resizes the transcript under the user's finger, which
            // cancels the tap that opens the sub-agent.
            if current.last_rendered.as_deref() == Some(rendered.as_str()) {
                return;
            }
            current.last_rendered = Some(rendered);
        }
        events.push(subagent_activity_envelope(
            SubagentActivityContext {
                parent_thread_id: &link.parent_thread_id,
                parent_run_id: &link.parent_run_id,
                parent_source_turn_id: link.parent_source_turn_id.clone(),
                tool_call_id: &link.tool_call_id,
                child_thread_id: Some(&link.child_thread_id),
            },
            progress.status,
            Some(&latest),
            timestamp,
        ));
        if is_terminal_subagent_status(progress.status) {
            if let Some(run) = self.runs.get_mut(&link.parent_thread_id) {
                if run.run_id == link.parent_run_id {
                    if let Some(tool) = run.tools.get_mut(&link.tool_call_id) {
                        tool.subagent_terminal_status = Some(progress.status.to_string());
                    }
                }
            }
            self.subagent_links.remove(thread_id);
            self.close_observed_run(thread_id, timestamp, events);
        }
    }
}

fn canonical_child_run_correlation(
    canonical: &CanonicalEvent,
) -> (Option<&str>, Option<u64>, bool) {
    match canonical {
        CanonicalEvent::RunStarted {
            run_id, generation, ..
        } => (Some(run_id), Some(*generation), true),
        CanonicalEvent::RunFinished {
            run_id, generation, ..
        }
        | CanonicalEvent::RunFailed {
            run_id, generation, ..
        } => (Some(run_id), Some(*generation), false),
        CanonicalEvent::MessageChunk {
            run_id, generation, ..
        }
        | CanonicalEvent::Tool {
            run_id, generation, ..
        } => (run_id.as_deref(), *generation, false),
        _ => (None, None, false),
    }
}

pub(super) fn messages_snapshot_envelope(
    snapshot: &SessionSnapshot,
    run_id: String,
    source_turn_id: Option<String>,
) -> AgUiEventEnvelope {
    let timestamp = Utc::now().timestamp_millis();
    let messages_by_id = snapshot
        .messages
        .iter()
        .map(|message| (message.id.as_str(), message))
        .collect::<HashMap<_, _>>();
    let mut messages = Vec::new();
    for entry in &snapshot.timeline {
        match entry.kind {
            SnapshotTimelineKind::Message | SnapshotTimelineKind::Reasoning => {
                let Some(message) = messages_by_id.get(entry.canonical_id.as_str()) else {
                    continue;
                };
                messages.push(Message {
                    id: message.id.clone(),
                    role: match message.role {
                        MessageRole::User => AgUiMessageRole::User,
                        MessageRole::Agent => AgUiMessageRole::Assistant,
                        MessageRole::Thought => AgUiMessageRole::Reasoning,
                    },
                    content: Some(MessageContent::String(snapshot_message_text(message))),
                    encrypted_value: None,
                    name: None,
                    tool_calls: None,
                    error: None,
                    tool_call_id: None,
                    activity_type: None,
                });
            }
            SnapshotTimelineKind::Tool => {
                let Some(tool) = snapshot.tools.get(&entry.canonical_id) else {
                    continue;
                };
                let current_task = parse_task_subagent(&tool.content);
                let preserved_task = snapshot
                    .subagent_header(&tool.id)
                    .and_then(parse_task_subagent);
                let prefer_preserved_terminal = preserved_task
                    .as_ref()
                    .is_some_and(|task| is_terminal_subagent_status(task.state))
                    && current_task
                        .as_ref()
                        .is_some_and(|task| !is_terminal_subagent_status(task.state));
                let task = if prefer_preserved_terminal {
                    preserved_task
                } else {
                    current_task.or(preserved_task)
                };
                if task.is_some() || tool.subagent || is_subagent_task_tool(tool.kind, &tool.title)
                {
                    let child_thread_id = task.as_ref().and_then(|task| {
                        AgentSessionId::new(&snapshot.agent_id, &task.session_id)
                            .ok()
                            .map(|identity| identity.encode())
                    });
                    let status =
                        snapshot_subagent_status(tool.status, task.as_ref().map(|task| task.state));
                    let mut lines = vec![if is_failed_subagent_status(status) {
                        "• Sub-agent failed".to_string()
                    } else if is_terminal_subagent_status(status) {
                        "• Sub-agent completed".to_string()
                    } else {
                        "• Sub-agent working".to_string()
                    }];
                    lines.push(format!("  Status: {}", display_subagent_status(status)));
                    if let Some(result) = task_result_preview(&tool.content) {
                        lines.push(format!("  Latest: {result}"));
                    }
                    let content = json!({
                        "text": lines.join("\n"),
                        "subAgent": {
                            "toolCallId": tool.id,
                            "tool": "spawnAgent",
                            "senderThreadId": snapshot.thread_id,
                            "receiverThreadIds": child_thread_id.into_iter().collect::<Vec<_>>(),
                            "agentStatus": status,
                        }
                    });
                    messages.push(activity_message(
                        format!("subagent:{}", tool.id),
                        "dappercode.subagent",
                        content,
                    ));
                    continue;
                }
                // The generated AG-UI `Message` cannot carry the ACP kind or status, so the
                // client reads them from an activity message that sits immediately before
                // the pair it describes. It is folded into the tool row and never rendered
                // on its own.
                messages.push(activity_message(
                    format!("tool-meta:{}", tool.id),
                    "dappercode.tool",
                    json!({
                        "toolCallId": tool.id,
                        "kind": tool_kind_wire(tool.kind),
                        "status": tool_status_wire(tool.status),
                        "title": bounded(&tool.title, 256),
                        "content": tool.structured_content,
                        "locations": tool.locations,
                        "truncated": tool.truncated,
                    }),
                ));
                messages.push(Message {
                    id: format!("tool-call:{}", tool.id),
                    role: AgUiMessageRole::Assistant,
                    content: Some(MessageContent::String(String::new())),
                    encrypted_value: None,
                    name: None,
                    tool_calls: Some(vec![ToolCall {
                        id: tool.id.clone(),
                        tool_call_type: ToolCallType::Function,
                        function: Function {
                            name: bounded(
                                if tool.title.trim().is_empty() {
                                    tool_kind_wire(tool.kind)
                                } else {
                                    tool.title.clone()
                                },
                                256,
                            ),
                            arguments: "{}".to_string(),
                        },
                        encrypted_value: None,
                    }]),
                    error: None,
                    tool_call_id: None,
                    activity_type: None,
                });
                messages.push(Message {
                    id: format!("tool-result:{}", tool.id),
                    role: AgUiMessageRole::Tool,
                    content: Some(MessageContent::String(tool_snapshot_text(tool))),
                    encrypted_value: None,
                    name: None,
                    tool_calls: None,
                    error: matches!(
                        tool.status,
                        agent_client_protocol::schema::v1::ToolCallStatus::Failed
                    )
                    .then(|| "Tool failed".to_string()),
                    tool_call_id: Some(tool.id.clone()),
                    activity_type: None,
                });
            }
        }
    }
    let mut snapshot_envelope = envelope(
        &snapshot.thread_id,
        &run_id,
        source_turn_id,
        AgUiEvent {
            messages: Some(messages),
            ..generated_event(AgUiEventType::MessagesSnapshot, timestamp)
        },
    );
    while serde_json::to_vec(&snapshot_envelope)
        .expect("messages snapshot envelope serializes")
        .len()
        > MESSAGES_SNAPSHOT_MAX_BYTES
    {
        let Some(messages) = snapshot_envelope.event.messages.as_mut() else {
            break;
        };
        if messages.len() <= 1 {
            break;
        }
        remove_oldest_snapshot_message_group(messages);
    }
    snapshot_envelope
}

fn remove_oldest_snapshot_message_group(messages: &mut Vec<Message>) {
    let oldest = messages.remove(0);
    let tool_call_ids = oldest
        .tool_calls
        .as_ref()
        .map(|calls| {
            calls
                .iter()
                .map(|call| call.id.as_str())
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let result_call_id = oldest.tool_call_id.as_deref();
    messages.retain(|message| {
        if message
            .tool_call_id
            .as_deref()
            .is_some_and(|id| tool_call_ids.contains(id))
        {
            return false;
        }
        if let Some(result_call_id) = result_call_id {
            return !message
                .tool_calls
                .as_ref()
                .is_some_and(|calls| calls.iter().any(|call| call.id == result_call_id));
        }
        true
    });
}

fn snapshot_message_text(message: &SnapshotMessage) -> String {
    let mut text = message
        .parts
        .iter()
        .flat_map(snapshot_content_lines)
        .collect::<Vec<_>>()
        .join("\n");
    if message.truncated {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str("[message content truncated]");
    }
    bounded(text, MAX_MESSAGE_TOTAL_BYTES)
}

fn snapshot_content_lines(value: &Value) -> Vec<String> {
    match value {
        Value::String(value) => (!value.is_empty())
            .then(|| value.clone())
            .into_iter()
            .collect(),
        Value::Array(values) => values.iter().flat_map(snapshot_content_lines).collect(),
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("text") {
                return object
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .into_iter()
                    .collect();
            }
            if object.get("type").and_then(Value::as_str) == Some("content") {
                return object
                    .get("content")
                    .map(snapshot_content_lines)
                    .unwrap_or_default();
            }
            if let Some(resource) = object.get("resource").and_then(Value::as_object) {
                let mut lines = Vec::new();
                if let Some(uri) = resource.get("uri").and_then(Value::as_str) {
                    lines.push(format!("[resource: {uri}]"));
                }
                if let Some(text) = resource.get("text").and_then(Value::as_str) {
                    lines.push(text.to_string());
                }
                return lines;
            }
            match object.get("type").and_then(Value::as_str) {
                Some("diff") => {
                    let path = object
                        .get("path")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("file");
                    let mut lines = vec![format!("[diff: {path}]")];
                    lines.extend(nested_content_lines(object, &["oldText", "newText"]));
                    return lines;
                }
                Some("terminal") => {
                    let terminal_id = object
                        .get("terminalId")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty());
                    let mut lines = vec![terminal_id.map_or_else(
                        || "[terminal]".to_string(),
                        |id| format!("[terminal: {id}]"),
                    )];
                    lines.extend(nested_content_lines(object, &["output", "content"]));
                    return lines;
                }
                Some("resource_link") | Some("resourceLink") => {
                    return object
                        .get("uri")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(|uri| format!("[file: {uri}]"))
                        .into_iter()
                        .collect();
                }
                Some("image") => return vec!["[image]".to_string()],
                Some("audio") => return vec!["[audio]".to_string()],
                _ => {}
            }
            if let Some(path) = object
                .get("path")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                let line = object.get("line").and_then(Value::as_u64);
                return vec![line.map_or_else(
                    || format!("[location: {path}]"),
                    |line| format!("[location: {path}:{line}]"),
                )];
            }
            serde_json::to_string(value).ok().into_iter().collect()
        }
        Value::Null => Vec::new(),
        _ => vec![value.to_string()],
    }
}

fn nested_content_lines(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Vec<String> {
    keys.iter()
        .filter_map(|key| object.get(*key))
        .flat_map(snapshot_content_lines)
        .collect()
}

fn tool_snapshot_text(tool: &SnapshotTool) -> String {
    let mut parts = Vec::new();
    if !tool.content.is_empty() {
        parts.push(tool.content.clone());
    }
    // Render structured content as readable lines rather than embedding raw JSON,
    // and skip anything the plain-text `content` already covers.
    for line in tool
        .structured_content
        .iter()
        .chain(tool.locations.iter())
        .flat_map(snapshot_content_lines)
    {
        if line.trim().is_empty() || tool.content.contains(line.trim()) {
            continue;
        }
        parts.push(line);
    }
    if tool.truncated {
        parts.push("[tool content truncated]".to_string());
    }
    bounded(
        parts
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        MAX_TOOL_TOTAL_BYTES,
    )
}

fn activity_message(id: String, activity_type: &str, content: Value) -> Message {
    let content = content
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), Some(value.clone())))
                .collect()
        })
        .unwrap_or_default();
    Message {
        id,
        role: AgUiMessageRole::Activity,
        content: Some(MessageContent::AnythingMap(content)),
        encrypted_value: None,
        name: None,
        tool_calls: None,
        error: None,
        tool_call_id: None,
        activity_type: Some(activity_type.to_string()),
    }
}

struct TaskSubagent<'a> {
    session_id: String,
    state: &'a str,
}

fn parse_task_subagent(content: &str) -> Option<TaskSubagent<'_>> {
    // Tool content is appended across updates, so the newest `<task …>` header wins.
    // Later occurrences can also be incidental (quoted markup in tool output), so
    // fall back to earlier candidates instead of giving up on the first bad match.
    let mut candidates = content
        .match_indices("<task ")
        .map(|(index, marker)| index + marker.len())
        .collect::<Vec<_>>();
    candidates.reverse();
    candidates
        .into_iter()
        .find_map(|start| parse_task_header(&content[start..]))
}

fn parse_task_header(rest: &str) -> Option<TaskSubagent<'_>> {
    let header = rest.split_once('>')?.0;
    let session_id = xml_attribute(header, "id")?.trim();
    let state = xml_attribute(header, "state")?.trim();
    if session_id.is_empty() || session_id.len() > 1_024 || state.is_empty() || state.len() > 64 {
        return None;
    }
    Some(TaskSubagent {
        session_id: session_id.to_string(),
        state,
    })
}

pub(super) fn discovered_subagent_session(
    canonical: &CanonicalEvent,
) -> Option<(&str, String, Option<&str>, &str, bool)> {
    let CanonicalEvent::Tool {
        thread_id,
        tool_call_id,
        title,
        content,
        ..
    } = canonical
    else {
        return None;
    };
    let content = match content {
        FieldUpdate::Set(content) | FieldUpdate::Append(content) => content,
        FieldUpdate::Clear | FieldUpdate::Unchanged => return None,
    };
    parse_task_subagent(content).map(|task| {
        (
            thread_id.as_str(),
            task.session_id,
            (!title.trim().is_empty()).then_some(title.as_str()),
            tool_call_id.as_str(),
            is_terminal_subagent_status(task.state),
        )
    })
}

fn xml_attribute<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    let marker = format!(r#"{name}=""#);
    let value = header.split_once(&marker)?.1;
    value.split_once('"').map(|(value, _)| value)
}

/// Latest human-readable line of a sub-agent task tool's output, ignoring the
/// `<task …>` bookkeeping. Agents that never stream a child session report their
/// progress here, so this is the only live signal the parent card has.
fn task_progress_preview(content: &str) -> Option<String> {
    let without_result = match (
        content.find("<task_result>"),
        content.rfind("</task_result>"),
    ) {
        (Some(start), Some(end)) if end >= start => {
            let mut trimmed = content[..start].to_string();
            trimmed.push_str(&content[end + "</task_result>".len()..]);
            trimmed
        }
        _ => content.to_string(),
    };
    let lines = without_result
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty() && !line.starts_with("<task") && !line.starts_with("</task")
        })
        .collect::<Vec<_>>();
    lines
        .last()
        .filter(|line| !is_placeholder_subagent_progress(line))
        .map(|line| bounded(line, 512))
}

fn is_placeholder_subagent_progress(line: &str) -> bool {
    let normalized = line
        .trim()
        .trim_end_matches(['.', '…'])
        .to_ascii_lowercase()
        .replace(['-', '_'], " ");
    matches!(
        normalized.split_whitespace().collect::<Vec<_>>().as_slice(),
        ["starting", "agent"]
            | ["starting", "subagent"]
            | ["starting", "sub", "agent"]
            | ["agent", "starting"]
            | ["subagent", "starting"]
            | ["sub", "agent", "starting"]
    )
}

fn task_result_preview(content: &str) -> Option<String> {
    let result = content
        .split_once("<task_result>")?
        .1
        .split_once("</task_result>")?
        .0
        .trim();
    (!result.is_empty()).then(|| summarize_task_result(result))
}

/// A one-line "done" summary of a sub-agent's result.
///
/// The full result is markdown and routinely runs to kilobytes. Rendering it on
/// the card buries the transcript under a wall of raw text before the user has
/// asked for it, so the card states the outcome and the detail view holds the
/// rest.
fn summarize_task_result(result: &str) -> String {
    let strip = |line: &str| {
        line.trim()
            .trim_start_matches(['#', '>', '-', '*', ' '])
            .trim()
            .to_string()
    };
    // A leading "## Summary" heading says nothing the card does not already say, so
    // prefer the first line of prose and fall back to the heading only if that is
    // all there is.
    let body = result
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("```"))
        .map(strip)
        .filter(|line| !line.is_empty());
    let line = body.unwrap_or_else(|| {
        result
            .lines()
            .map(strip)
            .find(|line| !line.is_empty())
            .unwrap_or_default()
    });
    if line.is_empty() {
        "Done".to_string()
    } else {
        bounded(&line, TASK_RESULT_SUMMARY_BYTES)
    }
}

const TASK_RESULT_SUMMARY_BYTES: usize = 140;

/// How a sub-agent's own state should be reported on its card.
///
/// Agents announce a task as `starting` (or `pending`/`queued`) before the child
/// session does anything. Surfacing that verbatim gives a card that reads
/// "starting" and looks stuck, so pre-run states are reported as running -- the
/// card heading already distinguishes working from completed.
fn display_subagent_status(status: &str) -> &str {
    match status.trim().to_ascii_lowercase().as_str() {
        "starting" | "start" | "pending" | "queued" | "created" | "initializing" => "running",
        _ => status,
    }
}

fn is_terminal_subagent_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "completed"
            | "complete"
            | "succeeded"
            | "failed"
            | "error"
            | "aborted"
            | "cancelled"
            | "canceled"
            | "closed"
    )
}

fn is_failed_subagent_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "failed" | "error" | "aborted" | "cancelled" | "canceled"
    )
}

fn snapshot_subagent_status(
    tool_status: agent_client_protocol::schema::v1::ToolCallStatus,
    child_status: Option<&str>,
) -> &str {
    match tool_status {
        agent_client_protocol::schema::v1::ToolCallStatus::Completed => child_status
            .filter(|status| is_failed_subagent_status(status))
            .unwrap_or("completed"),
        agent_client_protocol::schema::v1::ToolCallStatus::Failed => child_status
            .filter(|status| is_failed_subagent_status(status))
            .unwrap_or("failed"),
        _ => child_status.unwrap_or("running"),
    }
}

fn subagent_activity_envelope(
    context: SubagentActivityContext<'_>,
    status: &str,
    latest: Option<&str>,
    timestamp: i64,
) -> AgUiEventEnvelope {
    let terminal = is_terminal_subagent_status(status);
    let failed = is_failed_subagent_status(status);
    let heading = if failed {
        "• Sub-agent failed"
    } else if terminal {
        "• Sub-agent completed"
    } else {
        "• Sub-agent working"
    };
    let mut lines = vec![heading.to_string()];
    lines.push(format!("  Status: {}", display_subagent_status(status)));
    if let Some(latest) = latest.map(str::trim).filter(|value| !value.is_empty()) {
        lines.push(format!("  Latest: {}", bounded(latest, 512)));
    }
    envelope(
        context.parent_thread_id,
        context.parent_run_id,
        context.parent_source_turn_id,
        activity_event(
            format!("subagent:{}", context.tool_call_id),
            "dappercode.subagent",
            json!({
                "text": lines.join("\n"),
                "subAgent": {
                    "toolCallId": context.tool_call_id,
                    "tool": "spawnAgent",
                    "senderThreadId": context.parent_thread_id,
                    "receiverThreadIds": context.child_thread_id.into_iter().collect::<Vec<_>>(),
                    "agentStatus": status,
                }
            }),
            timestamp,
        ),
    )
}

pub(super) fn linked_subagent_activity_envelope(
    parent_thread_id: &str,
    parent_run_id: &str,
    parent_source_turn_id: Option<String>,
    tool_call_id: &str,
    child_thread_id: &str,
) -> AgUiEventEnvelope {
    subagent_activity_envelope(
        SubagentActivityContext {
            parent_thread_id,
            parent_run_id,
            parent_source_turn_id,
            tool_call_id,
            child_thread_id: Some(child_thread_id),
        },
        "running",
        None,
        Utc::now().timestamp_millis(),
    )
}

fn subagent_progress(canonical: &CanonicalEvent) -> Option<SubagentProgress> {
    match canonical {
        // The task header already created an openable working card. RunStarted is
        // useful for correlation only; rendering it regresses the preview to a
        // meaningless "Starting" state until the child produces real work.
        CanonicalEvent::RunStarted { .. } => None,
        CanonicalEvent::MessageChunk { role, content, .. } if !content.trim().is_empty() => {
            let action = match role {
                MessageRole::Thought => "Thinking",
                MessageRole::Agent => "Responding",
                MessageRole::User => "Received input",
            };
            Some(SubagentProgress {
                status: "running",
                latest: format!("{action}: {}", bounded(content, 320)),
                revision: None,
                from_tool: false,
            })
        }
        CanonicalEvent::Tool {
            tool_call_id,
            title,
            status,
            ..
        } => {
            let title = if title.trim().is_empty() {
                "Using a tool"
            } else {
                title
            };
            match status {
                agent_client_protocol::schema::v1::ToolCallStatus::Pending => None,
                agent_client_protocol::schema::v1::ToolCallStatus::Failed => {
                    Some(SubagentProgress {
                        status: "running",
                        latest: format!("Tool failed {title}"),
                        revision: Some(format!("failed:{tool_call_id}")),
                        from_tool: true,
                    })
                }
                _ => Some(SubagentProgress {
                    status: "running",
                    latest: format!("Working on {title}"),
                    revision: Some(format!("working:{tool_call_id}")),
                    from_tool: true,
                }),
            }
        }
        CanonicalEvent::Plan { .. } => Some(SubagentProgress {
            status: "running",
            latest: "Updating plan".to_string(),
            revision: None,
            from_tool: false,
        }),
        CanonicalEvent::PermissionRequested { .. } => Some(SubagentProgress {
            status: "running",
            latest: "Waiting for approval".to_string(),
            revision: None,
            from_tool: false,
        }),
        CanonicalEvent::ElicitationRequested { .. } => Some(SubagentProgress {
            status: "running",
            latest: "Waiting for input".to_string(),
            revision: None,
            from_tool: false,
        }),
        CanonicalEvent::RunFinished {
            stop_reason: agent_client_protocol::schema::v1::StopReason::Cancelled,
            ..
        } => Some(SubagentProgress {
            status: "cancelled",
            latest: "Cancelled".to_string(),
            revision: None,
            from_tool: false,
        }),
        CanonicalEvent::RunFinished { .. } => Some(SubagentProgress {
            status: "completed",
            latest: "Returned result".to_string(),
            revision: None,
            from_tool: false,
        }),
        CanonicalEvent::RunFailed { message, .. } => Some(SubagentProgress {
            status: "failed",
            latest: bounded(message, 512),
            revision: None,
            from_tool: false,
        }),
        _ => None,
    }
}

fn generated_event(ag_ui_event_type: AgUiEventType, timestamp: i64) -> AgUiEvent {
    AgUiEvent {
        message_id: None,
        name: None,
        raw_event: None,
        role: None,
        timestamp: Some(timestamp as f64),
        ag_ui_event_type,
        delta: None,
        title: None,
        parent_message_id: None,
        tool_call_id: None,
        tool_call_name: None,
        content: None,
        snapshot: None,
        messages: None,
        activity_type: None,
        replace: None,
        patch: None,
        event: None,
        source: None,
        value: None,
        input: None,
        parent_run_id: None,
        run_id: None,
        thread_id: None,
        outcome: None,
        result: None,
        code: None,
        message: None,
        step_name: None,
        encrypted_value: None,
        entity_id: None,
        subtype: None,
    }
}

fn run_event(
    event_type: AgUiEventType,
    thread_id: String,
    run_id: String,
    timestamp: i64,
) -> AgUiEvent {
    AgUiEvent {
        thread_id: Some(thread_id),
        run_id: Some(run_id),
        ..generated_event(event_type, timestamp)
    }
}

fn message_event(
    event_type: AgUiEventType,
    message_id: String,
    role: Option<AgUiEventRole>,
    delta: Option<String>,
    timestamp: i64,
) -> AgUiEvent {
    AgUiEvent {
        message_id: Some(message_id),
        role,
        delta: delta.map(Delta::String),
        ..generated_event(event_type, timestamp)
    }
}

fn tool_event(event_type: AgUiEventType, tool_call_id: String, timestamp: i64) -> AgUiEvent {
    AgUiEvent {
        tool_call_id: Some(tool_call_id),
        ..generated_event(event_type, timestamp)
    }
}

fn custom_event(name: String, value: Value, timestamp: i64) -> AgUiEvent {
    AgUiEvent {
        name: Some(name),
        value: Some(value),
        ..generated_event(AgUiEventType::Custom, timestamp)
    }
}

fn activity_event(
    message_id: String,
    activity_type: &str,
    content: Value,
    timestamp: i64,
) -> AgUiEvent {
    let content = content
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), Some(value.clone())))
                .collect()
        })
        .unwrap_or_default();
    AgUiEvent {
        message_id: Some(message_id),
        activity_type: Some(activity_type.to_string()),
        content: Some(AgUiEventContent::AnythingMap(content)),
        replace: Some(true),
        ..generated_event(AgUiEventType::ActivitySnapshot, timestamp)
    }
}

fn envelope(
    thread_id: &str,
    run_id: &str,
    source_turn_id: Option<String>,
    event: AgUiEvent,
) -> AgUiEventEnvelope {
    AgUiEventEnvelope {
        thread_id: thread_id.to_string(),
        run_id: run_id.to_string(),
        source_turn_id,
        event,
    }
}

fn canonical_run_mut<'a>(
    runs: &'a mut HashMap<String, AgUiRunState>,
    thread_id: &str,
    run_id: Option<&str>,
    source_turn_id: Option<&str>,
) -> Option<&'a mut AgUiRunState> {
    let run = runs.get_mut(thread_id)?;
    if run_id.is_some_and(|value| value != run.run_id)
        || source_turn_id.is_some()
            && run.source_turn_id.as_deref().is_some()
            && source_turn_id != run.source_turn_id.as_deref()
    {
        return None;
    }
    Some(run)
}

fn close_run(
    thread_id: &str,
    mut run: AgUiRunState,
    timestamp: i64,
    events: &mut Vec<AgUiEventEnvelope>,
    superseded: bool,
) {
    if let Some(message_id) = run.open_user_id.take() {
        push_text_message_end(events, thread_id, &run, message_id, timestamp);
    }
    if let Some(message_id) = run.open_message_id.take() {
        events.push(envelope(
            thread_id,
            &run.run_id,
            run.source_turn_id.clone(),
            message_event(
                AgUiEventType::TextMessageEnd,
                message_id,
                None,
                None,
                timestamp,
            ),
        ));
    }
    if let Some(message_id) = run.open_reasoning_id.take() {
        events.push(envelope(
            thread_id,
            &run.run_id,
            run.source_turn_id.clone(),
            message_event(
                AgUiEventType::ReasoningMessageEnd,
                message_id,
                None,
                None,
                timestamp,
            ),
        ));
    }
    for (tool_call_id, tool) in run.tools {
        if !tool.ended && !tool.subagent_activity {
            events.push(envelope(
                thread_id,
                &run.run_id,
                run.source_turn_id.clone(),
                tool_event(AgUiEventType::ToolCallEnd, tool_call_id, timestamp),
            ));
        }
    }
    if superseded {
        events.push(envelope(
            thread_id,
            &run.run_id,
            run.source_turn_id,
            AgUiEvent {
                message: Some("Agent run superseded by a new run".to_string()),
                code: Some("superseded".to_string()),
                ..generated_event(AgUiEventType::RunError, timestamp)
            },
        ));
    }
}

fn push_text_message_end(
    events: &mut Vec<AgUiEventEnvelope>,
    thread_id: &str,
    run: &AgUiRunState,
    message_id: String,
    timestamp: i64,
) {
    events.push(envelope(
        thread_id,
        &run.run_id,
        run.source_turn_id.clone(),
        message_event(
            AgUiEventType::TextMessageEnd,
            message_id,
            None,
            None,
            timestamp,
        ),
    ));
}

fn bounded_live_content(
    totals: &mut HashMap<String, usize>,
    truncated: &mut HashSet<String>,
    id: &str,
    content: &str,
    max: usize,
) -> (String, bool) {
    let used = totals.entry(id.to_string()).or_default();
    let remaining = max.saturating_sub(*used);
    let bounded = bounded(content, remaining);
    *used = used.saturating_add(bounded.len());
    let was_truncated = bounded.len() < content.len();
    let newly_truncated = was_truncated && truncated.insert(id.to_string());
    (bounded, newly_truncated)
}

fn push_transcript_truncation(
    events: &mut Vec<AgUiEventEnvelope>,
    thread_id: &str,
    run: &AgUiRunState,
    canonical_id: &str,
    max_bytes: usize,
    timestamp: i64,
) {
    events.push(envelope(
        thread_id,
        &run.run_id,
        run.source_turn_id.clone(),
        custom_event(
            "dappercode.dev/transcript-truncated".to_string(),
            json!({
                "canonicalId": canonical_id,
                "truncated": true,
                "maxBytes": max_bytes,
                "retrieval": {
                    "available": false,
                }
            }),
            timestamp,
        ),
    ));
}

fn push_message_chunks(
    events: &mut Vec<AgUiEventEnvelope>,
    thread_id: &str,
    run: &AgUiRunState,
    reasoning: bool,
    message_id: &str,
    content: &str,
    timestamp: i64,
) {
    for chunk in utf8_chunks(content, MESSAGE_CHUNK_BYTES) {
        events.push(envelope(
            thread_id,
            &run.run_id,
            run.source_turn_id.clone(),
            message_event(
                if reasoning {
                    AgUiEventType::ReasoningMessageContent
                } else {
                    AgUiEventType::TextMessageContent
                },
                message_id.to_string(),
                None,
                Some(chunk.to_string()),
                timestamp,
            ),
        ));
    }
}

fn utf8_chunks(value: &str, max_bytes: usize) -> impl Iterator<Item = &str> {
    let mut remaining = value;
    std::iter::from_fn(move || {
        if remaining.is_empty() {
            return None;
        }
        let mut end = remaining.len().min(max_bytes.max(1));
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        let (chunk, rest) = remaining.split_at(end);
        remaining = rest;
        Some(chunk)
    })
}

fn push_structured_chunks(
    events: &mut Vec<AgUiEventEnvelope>,
    thread_id: &str,
    run: &AgUiRunState,
    name: &str,
    canonical_id: &str,
    value: Value,
    timestamp: i64,
) {
    let serialized = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string());
    if serialized.len() <= STRUCTURED_CHUNK_BYTES {
        events.push(envelope(
            thread_id,
            &run.run_id,
            run.source_turn_id.clone(),
            custom_event(name.to_string(), value, timestamp),
        ));
        return;
    }
    let revision = format!("sha256:{:x}", Sha256::digest(serialized.as_bytes()));
    let chunks = utf8_chunks(&serialized, STRUCTURED_CHUNK_BYTES).collect::<Vec<_>>();
    for (index, data) in chunks.iter().enumerate() {
        events.push(envelope(
            thread_id,
            &run.run_id,
            run.source_turn_id.clone(),
            custom_event(
                format!("{name}-chunk"),
                json!({
                    "canonicalId": canonical_id,
                    "revision": revision,
                    "index": index,
                    "count": chunks.len(),
                    "data": data,
                    "retrieval": {
                        "available": false,
                    }
                }),
                timestamp,
            ),
        ));
    }
}

fn apply_structured_updates(
    content: &mut Vec<Value>,
    content_update: &FieldUpdate<Vec<Value>>,
    locations: &mut Vec<Value>,
    locations_update: &FieldUpdate<Vec<Value>>,
    max_bytes: usize,
    truncated: &mut bool,
) -> bool {
    let previous = (content.clone(), locations.clone());
    let previous_truncated = *truncated;
    let reset_truncation = matches!(content_update, FieldUpdate::Set(_) | FieldUpdate::Clear)
        || matches!(locations_update, FieldUpdate::Set(_) | FieldUpdate::Clear);
    apply_structured_field(content, content_update);
    apply_structured_field(locations, locations_update);
    if reset_truncation {
        *truncated = false;
    }
    while serde_json::to_vec(&(content.as_slice(), locations.as_slice()))
        .expect("structured tool state is JSON serializable")
        .len()
        > max_bytes
    {
        if locations.is_empty() {
            content.pop();
        } else {
            locations.pop();
        }
        *truncated = true;
    }
    previous.0 != *content || previous.1 != *locations || previous_truncated != *truncated
}

fn apply_structured_field(current: &mut Vec<Value>, update: &FieldUpdate<Vec<Value>>) {
    match update {
        FieldUpdate::Set(value) => *current = value.clone(),
        FieldUpdate::Append(value) => current.extend(value.iter().cloned()),
        FieldUpdate::Clear => current.clear(),
        FieldUpdate::Unchanged => {}
    }
}

fn push_custom(
    events: &mut Vec<AgUiEventEnvelope>,
    runs: &HashMap<String, AgUiRunState>,
    thread_id: &str,
    name: &str,
    value: Value,
    timestamp: i64,
) {
    let (run_id, source_turn_id) = runs.get(thread_id).map_or_else(
        || (format!("{thread_id}::session"), None),
        |run| (run.run_id.clone(), run.source_turn_id.clone()),
    );
    events.push(envelope(
        thread_id,
        &run_id,
        source_turn_id,
        custom_event(name.to_string(), value, timestamp),
    ));
}

fn push_activity(
    events: &mut Vec<AgUiEventEnvelope>,
    runs: &HashMap<String, AgUiRunState>,
    thread_id: &str,
    message_id: String,
    activity_type: &str,
    content: Value,
    timestamp: i64,
) {
    let (run_id, source_turn_id) = runs.get(thread_id).map_or_else(
        || (format!("{thread_id}::session"), None),
        |run| (run.run_id.clone(), run.source_turn_id.clone()),
    );
    events.push(envelope(
        thread_id,
        &run_id,
        source_turn_id,
        activity_event(message_id, activity_type, content, timestamp),
    ));
}

fn canonical_source_turn_id(event: &CanonicalEvent) -> Option<&str> {
    match event {
        CanonicalEvent::RunStarted { source_turn_id, .. }
        | CanonicalEvent::RunFinished { source_turn_id, .. }
        | CanonicalEvent::RunFailed { source_turn_id, .. } => Some(source_turn_id),
        CanonicalEvent::MessageChunk { source_turn_id, .. }
        | CanonicalEvent::Tool { source_turn_id, .. } => source_turn_id.as_deref(),
        _ => None,
    }
}

fn field_value(update: &FieldUpdate) -> Value {
    match update {
        FieldUpdate::Unchanged => Value::Null,
        FieldUpdate::Clear => Value::Null,
        FieldUpdate::Set(value) => Value::String(bounded(value, 2 * 1024)),
        FieldUpdate::Append(value) => Value::String(bounded(value, 2 * 1024)),
    }
}

fn bounded(value: impl AsRef<str>, max_bytes: usize) -> String {
    let mut value = value.as_ref().to_string();
    if value.len() > max_bytes {
        let mut end = max_bytes;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
    }
    value
}

/// Wire spelling of an ACP enum, so the client sees `switch_mode` rather than the
/// Rust `SwitchMode` spelling and stays aligned with the session snapshot.
fn acp_wire_value<T: serde::Serialize + std::fmt::Debug>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{value:?}").to_ascii_lowercase())
}

fn tool_kind_wire(kind: agent_client_protocol::schema::v1::ToolKind) -> String {
    acp_wire_value(&kind)
}

fn tool_status_wire(status: agent_client_protocol::schema::v1::ToolCallStatus) -> String {
    acp_wire_value(&status)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::acp::snapshot::SessionSnapshot;
    use agent_client_protocol::schema::v1::{StopReason, ToolCallStatus, ToolKind};

    #[test]
    fn tool_snapshot_text_renders_structured_content_without_raw_json() {
        let tool = SnapshotTool {
            id: "call-read-1".to_string(),
            generation: Some(1),
            kind: ToolKind::Read,
            status: ToolCallStatus::Completed,
            title: "Read src/math.ts".to_string(),
            content: "export function add() {}\n".to_string(),
            structured_content: vec![
                json!({"type": "content", "content": {"type": "text", "text": "export function add() {}\n"}}),
                json!({"type": "diff", "path": "src/math.ts"}),
            ],
            locations: vec![json!({"path": "src/math.ts", "line": 7})],
            truncated: false,
            subagent: false,
        };

        let text = tool_snapshot_text(&tool);

        assert!(!text.contains("{\""), "unexpected raw JSON in {text}");
        assert!(
            text.contains("[diff: src/math.ts]"),
            "missing diff marker in {text}"
        );
        assert!(
            text.contains("[location: src/math.ts:7]"),
            "missing location marker in {text}"
        );
        assert_eq!(
            text.matches("export function add() {}").count(),
            1,
            "duplicated plain content in {text}"
        );
    }

    #[test]
    fn parse_task_subagent_falls_back_past_incidental_markup() {
        let content = concat!(
            "<task id=\"child-1\" state=\"completed\">\nAudit\n</task>\n",
            "src/readme.md:1:<task something-else>"
        );

        let task = parse_task_subagent(content).expect("task header");

        assert_eq!(task.session_id, "child-1");
        assert_eq!(task.state, "completed");
    }

    #[test]
    fn parse_task_header_rejects_empty_and_oversized_attributes() {
        assert!(parse_task_header("id=\"\" state=\"running\">").is_none());
        assert!(
            parse_task_header(&format!("id=\"{}\" state=\"running\">", "x".repeat(1_025)))
                .is_none()
        );
        assert!(parse_task_header("id=\"child\" state=\"\">").is_none());
        assert!(
            parse_task_header(&format!("id=\"child\" state=\"{}\">", "x".repeat(65))).is_none()
        );
    }

    #[test]
    fn task_progress_preview_handles_reversed_result_markers() {
        assert_eq!(
            task_progress_preview("</task_result>\nStill working\n<task_result>").as_deref(),
            Some("Still working")
        );
    }

    #[test]
    fn utf8_helpers_back_up_to_character_boundaries() {
        assert_eq!(
            utf8_chunks("a😀b", 4).collect::<Vec<_>>(),
            vec!["a", "😀", "b"]
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
            ))
        );

        assert_eq!(
            snapshot_content_lines(&json!({
                "resource": {
                    "uri": "file:///tmp/readme.md",
                    "text": "Documentation"
                }
            })),
            vec!["[resource: file:///tmp/readme.md]", "Documentation"]
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
            content: String::new(),
            structured_content: vec![
                json!({"type": "diff", "path": "src/math.ts", "oldText": "old body", "newText": "new body"}),
                json!({"type": "terminal", "terminalId": "term-1", "output": "npm test output"}),
            ],
            locations: vec![],
            truncated: false,
            subagent: false,
        };

        let text = tool_snapshot_text(&tool);

        assert!(
            text.contains("[diff: src/math.ts]"),
            "missing diff marker in {text}"
        );
        assert!(text.contains("new body"), "diff body dropped in {text}");
        assert!(
            text.contains("[terminal: term-1]"),
            "missing terminal marker in {text}"
        );
        assert!(
            text.contains("npm test output"),
            "terminal output dropped in {text}"
        );
    }

    #[test]
    fn parse_task_subagent_reads_the_newest_appended_header() {
        let content = concat!(
            "<task id=\"child-1\" state=\"running\">\nAudit\n</task>",
            "<task id=\"child-1\" state=\"completed\">\nAudit\n</task>"
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
            "unexpected text in {text}"
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
            "sub-agent threads must open an implicit run so their output streams"
        );
        // A second chunk reuses the same implicit run instead of restarting it.
        let more = projector.project_canonical(&chunk).events;
        assert_eq!(event_types(&more), vec!["TEXT_MESSAGE_CONTENT"]);
    }

    #[test]
    fn sub_agent_tools_report_progress_without_a_linked_child_session() {
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

        let latest_of = |projection: &CanonicalProjection| -> Option<String> {
            projection
                .events
                .iter()
                .filter_map(|event| serde_json::to_value(event).ok())
                .filter_map(|value| {
                    value["event"]["content"]["text"]
                        .as_str()
                        .map(str::to_string)
                })
                .next_back()
        };

        projector.project_canonical(&task_tool(ToolCallStatus::InProgress, "Auditing\n"));

        let progress = projector.project_canonical(&task_tool(
            ToolCallStatus::InProgress,
            "Searching package 3 of 20\n",
        ));
        let text = latest_of(&progress).expect("a progress envelope");
        assert!(
            text.contains("Searching package 3 of 20"),
            "sub-agent progress must reach the parent card, got {text}"
        );
        assert!(
            text.contains("Status: running"),
            "unexpected status in {text}"
        );

        let done = projector.project_canonical(&task_tool(
            ToolCallStatus::Completed,
            "<task_result>All clear</task_result>",
        ));
        let text = latest_of(&done).expect("a terminal envelope");
        assert!(
            text.contains("Sub-agent completed"),
            "unexpected text {text}"
        );
        assert!(
            text.contains("All clear"),
            "terminal result missing from {text}"
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
            content: FieldUpdate::Set(content.to_string()),
            structured_content: FieldUpdate::Set(Vec::new()),
            locations: FieldUpdate::Set(Vec::new()),
        }
    }

    /// Every `(messageId, text)` pair a projection emits for sub-agent cards.
    fn subagent_cards(projection: &CanonicalProjection) -> Vec<(String, String)> {
        projection
            .events
            .iter()
            .filter_map(|event| serde_json::to_value(event).ok())
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
                "turn {turn} must open exactly one run"
            );
            run_ids.push(started.events[0].run_id.clone());

            let answered =
                projector.project_canonical(&turn_message(turn, &format!("msg-{turn}"), "answer"));
            assert_eq!(
                event_types(&answered.events),
                vec!["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"],
                "turn {turn} must stream its own message"
            );

            let finished = projector.project_canonical(&turn_run_finished(turn));
            assert_eq!(
                event_types(&finished.events),
                vec!["TEXT_MESSAGE_END", "RUN_FINISHED"],
                "turn {turn} must close cleanly"
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
                "turn {turn} card must report running, got {running:?}"
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
                "turn {turn} result missing from {done:?}"
            );

            // The rest of the turn still streams after the sub-agent finishes.
            let after =
                projector.project_canonical(&turn_message(turn, &format!("after-{turn}"), "after"));
            assert!(
                event_types(&after.events).contains(&"TEXT_MESSAGE_CONTENT"),
                "turn {turn} must keep streaming after its sub-agent"
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
            .filter_map(|event| serde_json::to_value(event).ok())
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
            "detail line\n".repeat(200)
        );
        let mut projector = AgUiProjector::default();
        projector.project_canonical(&canonical_run_started());
        projector.project_canonical(&subagent_task_tool(
            "task-1",
            "Task",
            ToolCallStatus::InProgress,
            FieldUpdate::Set("Working\n".to_string()),
        ));

        let cards = subagent_cards(&projector.project_canonical(&subagent_task_tool(
            "task-1",
            "Task",
            ToolCallStatus::Completed,
            FieldUpdate::Set(body.clone()),
        )));
        assert_eq!(cards.len(), 1, "expected one card, got {cards:?}");
        let text = &cards[0].1;

        assert!(
            text.contains("Sub-agent completed"),
            "card must state the outcome: {text}"
        );
        assert!(
            text.contains("Added retry logic to the client."),
            "card must keep a one-line summary: {text}"
        );
        assert!(
            !text.contains("detail line"),
            "card must not dump the result body: {text}"
        );
        assert!(
            text.len() < 400,
            "card grew to {} bytes: {text}",
            text.len()
        );
    }

    #[test]
    fn a_result_summary_survives_markdown_and_empty_bodies() {
        assert_eq!(
            summarize_task_result("## Done\n\nShipped it."),
            "Shipped it."
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
            typed_ids(&opened)
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
            typed_ids(&placeholder)
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
            "card must not report a starting state: {text}"
        );
        assert!(
            text.contains("status: running"),
            "a pre-run state is reported as running: {text}"
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
            .filter_map(|event| serde_json::to_value(event).ok())
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
            "the first card must carry its child thread: {card}"
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
                FieldUpdate::Set("Auditing\n".to_string()),
            ),
        )));
        emitted.extend(typed_ids(&projector.project_canonical(
            &subagent_task_tool(
                "task-1",
                "Task",
                ToolCallStatus::Completed,
                FieldUpdate::Set("Auditing\nAll clear\n".to_string()),
            ),
        )));

        for (kind, id) in &emitted {
            assert!(
                !matches!(
                    kind.as_str(),
                    "TOOL_CALL_START" | "TOOL_CALL_ARGS" | "TOOL_CALL_RESULT" | "TOOL_CALL_END"
                ),
                "sub-agent tool leaked {kind} ({id}); all of {emitted:?}"
            );
            assert!(
                !kind.contains("tool-text") && !kind.contains("tool-content"),
                "sub-agent tool leaked {kind} ({id}); all of {emitted:?}"
            );
        }
        assert!(
            emitted.iter().any(|(_, id)| id.starts_with("subagent:")),
            "expected a sub-agent card in {emitted:?}"
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
                "<task id=\"child-1\" state=\"running\">\nReading package.json\n</task>"
                    .to_string(),
            ),
        );
        snapshot.apply(&linked);
        let live = projector.project_canonical(&linked);
        assert_eq!(
            subagent_cards(&live),
            vec![(
                "subagent:task-1".to_string(),
                "• Sub-agent working\n  Status: running\n  Latest: Reading package.json"
                    .to_string(),
            )]
        );

        let completed = subagent_task_tool(
            "task-1",
            "Research dependency options",
            ToolCallStatus::Completed,
            FieldUpdate::Set(
                "<task_result>Found three compatible options.</task_result>".to_string(),
            ),
        );
        snapshot.apply(&completed);
        let terminal_live = projector.project_canonical(&completed);
        let terminal_live_value = terminal_live
            .events
            .iter()
            .filter_map(|event| serde_json::to_value(event).ok())
            .find(|value| value["event"]["messageId"] == "subagent:task-1")
            .expect("terminal live card");
        assert_eq!(
            terminal_live_value["event"]["content"]["subAgent"]["receiverThreadIds"]
                .as_array()
                .map(Vec::len),
            Some(1),
            "terminal live update lost its child link: {terminal_live_value}"
        );
        assert_eq!(
            terminal_live_value["event"]["content"]["subAgent"]["agentStatus"],
            "completed"
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
            "snapshot lost its child link: {value}"
        );
        assert_eq!(
            value["content"]["subAgent"]["agentStatus"], "completed",
            "terminal tool status must win over the preserved running header"
        );
        assert!(
            value["content"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("Sub-agent completed")),
            "snapshot replaced the card with a tool: {value}"
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
            .and_then(|message| serde_json::to_value(message).ok())
            .expect("failed sub-agent card");
        assert!(
            failed_value["content"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("Sub-agent failed")),
            "failed snapshot used the completed heading: {failed_value}"
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
            .and_then(|message| serde_json::to_value(message).ok())
            .expect("child-failed sub-agent card");
        assert_eq!(
            child_failed_value["content"]["subAgent"]["agentStatus"], "error",
            "successful wrapper overwrote the child's failure: {child_failed_value}"
        );
        assert!(
            child_failed_value["content"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("Sub-agent failed")),
            "child failure used the completed heading: {child_failed_value}"
        );
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
                "<task id=\"child-1\" state=\"running\">\nReading package.json\n</task>"
                    .to_string(),
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
            .filter_map(|event| serde_json::to_value(event).ok())
            .find(|value| value["event"]["messageId"] == "subagent:task-1")
            .expect("failed active sub-agent card");
        assert_eq!(
            card["event"]["content"]["subAgent"]["agentStatus"],
            "failed"
        );
        assert_eq!(
            card["event"]["content"]["subAgent"]["receiverThreadIds"]
                .as_array()
                .map(Vec::len),
            Some(1),
            "run failure lost the child link: {card}"
        );
        assert!(
            card["event"]["content"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("Sub-agent failed")),
            "run failure left the card running: {card}"
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
            .and_then(|message| serde_json::to_value(message).ok())
            .expect("failed snapshot card");
        assert_eq!(
            terminal_card["content"]["subAgent"]["agentStatus"], "failed",
            "terminal snapshot resurrected the active card: {terminal_card}"
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
            .filter_map(|event| serde_json::to_value(event).ok())
            .find(|value| value["event"]["messageId"] == "subagent:task-1")
            .expect("status-only completed card");
        assert_eq!(
            completed_card["event"]["content"]["subAgent"]["agentStatus"], "completed",
            "stale running header beat terminal wrapper status: {completed_card}"
        );
        assert_eq!(
            completed_card["event"]["content"]["subAgent"]["receiverThreadIds"]
                .as_array()
                .map(Vec::len),
            Some(1)
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
            .filter_map(|event| serde_json::to_value(event).ok())
            .find(|value| value["event"]["messageId"] == "subagent:task-1")
            .expect("late child failure card");
        assert_eq!(
            corrected_card["event"]["content"]["subAgent"]["agentStatus"], "failed",
            "late child failure could not correct wrapper completion: {corrected_card}"
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
            .filter_map(|event| serde_json::to_value(event).ok())
            .find(|value| value["event"]["messageId"] == "subagent:task-2")
            .expect("remembered child failure card");
        assert_eq!(
            failed_card["event"]["content"]["subAgent"]["agentStatus"], "error",
            "wrapper completion downgraded the child failure: {failed_card}"
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
            FieldUpdate::Set(
                "<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string(),
            ),
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
            .filter_map(|event| serde_json::to_value(event).ok())
            .find(|value| value["event"]["messageId"] == "subagent:task-1")
            .expect("unresolved child failure card");
        assert_eq!(
            card["event"]["content"]["subAgent"]["agentStatus"],
            "failed"
        );
        assert!(
            projector
                .subagent_links
                .values()
                .all(|link| link.parent_run_id != "run-1"),
            "parent failure kept the unresolved link"
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
            .and_then(|message| serde_json::to_value(message).ok())
            .expect("terminal sub-agent card");
        assert_eq!(
            terminal_card["content"]["subAgent"]["agentStatus"], "failed",
            "parent failure left the completed wrapper state: {terminal_card}"
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
            FieldUpdate::Set(
                "<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string(),
            ),
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
            .filter_map(|event| serde_json::to_value(event).ok())
            .find(|value| value["event"]["messageId"] == "subagent:task-1")
            .expect("cancelled parent card");
        assert_eq!(
            card["event"]["content"]["subAgent"]["agentStatus"],
            "cancelled"
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
            .and_then(|message| serde_json::to_value(message).ok())
            .expect("cancelled snapshot card");
        assert_eq!(
            terminal_card["content"]["subAgent"]["agentStatus"], "cancelled",
            "authoritative snapshot lost cancellation cause: {terminal_card}"
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
            FieldUpdate::Set(
                "<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string(),
            ),
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
            .filter_map(|event| serde_json::to_value(event).ok())
            .find(|value| value["event"]["messageId"] == "subagent:task-1")
            .expect("cancelled child card");
        assert_eq!(
            card["event"]["content"]["subAgent"]["agentStatus"],
            "cancelled"
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
            .filter_map(|event| serde_json::to_value(event).ok())
            .find(|value| value["event"]["messageId"] == "subagent:task-1")
            .expect("re-tasked child card");
        assert_eq!(
            card["event"]["content"]["subAgent"]["agentStatus"], "completed",
            "re-task inherited the previous failure: {card}"
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
                .filter_map(|event| serde_json::to_value(event).ok())
                .all(|value| value["event"]["messageId"] != "subagent:task-3"),
            "repeated retask dropped its generation floor"
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
            .filter_map(|event| serde_json::to_value(event).ok())
            .find(|value| value["event"]["messageId"] == "subagent:task-3")
            .expect("new child terminal card");
        assert_eq!(
            current_card["event"]["content"]["subAgent"]["agentStatus"],
            "completed"
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
            .filter_map(|event| serde_json::to_value(event).ok())
            .find(|value| value["event"]["messageId"] == "subagent:task-1")
            .expect("superseded sub-agent card");
        assert_eq!(
            old_card["event"]["content"]["subAgent"]["agentStatus"], "failed",
            "superseded sub-agent stayed active: {old_card}"
        );
        assert!(
            projector
                .subagent_links
                .values()
                .all(|link| link.parent_run_id != "run-1"),
            "superseded run kept a child link"
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
                .filter_map(|event| serde_json::to_value(event).ok())
                .all(|value| value["event"]["messageId"] != "subagent:task-1"),
            "late child output updated the superseded parent"
        );
    }

    #[test]
    fn parallel_task_tools_keep_one_card_each() {
        // Two sub-agents running at once in a single turn must not share a card or a
        // revision slot: interleaved updates have to land on their own tool call.
        let mut projector = AgUiProjector::default();
        projector.project_canonical(&canonical_run_started());
        let parent_thread = "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg";

        let task_tool =
            |tool_call_id: &str, status: ToolCallStatus, content: &str| CanonicalEvent::Tool {
                agent_id: "alpha-agent".to_string(),
                thread_id: parent_thread.to_string(),
                run_id: Some("run-1".to_string()),
                source_turn_id: Some("turn-1".to_string()),
                generation: Some(1),
                tool_call_id: tool_call_id.to_string(),
                kind: ToolKind::Other,
                status,
                title: "Task".to_string(),
                content: FieldUpdate::Set(content.to_string()),
                structured_content: FieldUpdate::Set(Vec::new()),
                locations: FieldUpdate::Set(Vec::new()),
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
            "progress landed on the wrong card: {b_progress:?}"
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
            "progress landed on the wrong card: {a_progress:?}"
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
            "unexpected text {b_done:?}"
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
            "terminal result missing from {a_done:?}"
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
            FieldUpdate::Set("<task id=\"child-session\" state=\"running\"></task>".to_string()),
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
                "a status-only update must not drop the child thread link"
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
                "<task id=\"child-session\" state=\"{state}\"></task>"
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
            "an agent-driven thread must open an implicit run so its output streams"
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
            "the implicit run must be closed when the sub-agent finishes"
        );
        assert!(!projector.runs.contains_key(&child_thread));
        assert!(!projector.observed_runs.contains(&child_thread));

        assert!(
            event_types(&closing).contains(&"TEXT_MESSAGE_END"),
            "closing the implicit run must end the child's open message"
        );

        // A repeated terminal update must not close it twice.
        let repeated = projector.project_canonical(&task_tool("completed"));
        assert!(
            !repeated
                .events
                .iter()
                .any(|event| event.thread_id == child_thread),
            "closing an already-closed implicit run must be a no-op"
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
            "a re-tasked sub-agent must open a fresh implicit run"
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
            "eviction dropped an open run without a terminal event: {types:?}"
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
            "evicted observed thread opened a second run"
        );
    }

    #[test]
    fn canonical_projection_orders_multiple_text_and_reasoning_messages() {
        let mut projector = AgUiProjector::default();
        assert_eq!(
            event_types(&projector.project_canonical(&canonical_run_started()).events),
            ["RUN_STARTED"]
        );
        let first =
            projector.project_canonical(&canonical_message(MessageRole::Agent, "one", "same"));
        assert_eq!(
            event_types(&first.events),
            ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]
        );
        let repeated =
            projector.project_canonical(&canonical_message(MessageRole::Agent, "one", "same"));
        assert_eq!(event_types(&repeated.events), ["TEXT_MESSAGE_CONTENT"]);
        let second =
            projector.project_canonical(&canonical_message(MessageRole::Agent, "two", "next"));
        assert_eq!(
            event_types(&second.events),
            [
                "TEXT_MESSAGE_END",
                "TEXT_MESSAGE_START",
                "TEXT_MESSAGE_CONTENT"
            ]
        );
        let thought =
            projector.project_canonical(&canonical_message(MessageRole::Thought, "thought", "why"));
        assert_eq!(
            event_types(&thought.events),
            ["REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT"]
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
            ["TOOL_CALL_START", "TOOL_CALL_ARGS", "CUSTOM"]
        );
        assert!(projector
            .project_canonical(&tool("tool-1", ToolCallStatus::InProgress, ""))
            .events
            .is_empty());
        let completed =
            projector.project_canonical(&tool("tool-1", ToolCallStatus::Completed, "done"));
        assert_eq!(
            event_types(&completed.events),
            ["TOOL_CALL_END", "CUSTOM", "TOOL_CALL_RESULT"]
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
            ["TOOL_CALL_START", "TOOL_CALL_ARGS", "CUSTOM"]
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
                "RUN_FINISHED"
            ]
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
            event_types(&starting.events)
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
        assert_eq!(event_types(&failed_unlinked.events), ["ACTIVITY_SNAPSHOT"]);
        assert_eq!(
            serde_json::to_value(&failed_unlinked.events[0]).unwrap()["event"]["content"]
                ["subAgent"]["agentStatus"],
            "failed"
        );
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
                    "<task id=\"child-session\" state=\"{state}\">\n<task_result>done</task_result>\n</task>"
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
            "completed"
        );
        assert!(activity["event"]["content"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("Latest: done")));
        assert_eq!(
            activity["event"]["content"]["subAgent"]["receiverThreadIds"][0],
            AgentSessionId::new("alpha-agent", "child-session")
                .unwrap()
                .encode()
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
                "<task id=\"child-session\" state=\"running\"></task>".to_string(),
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
            "pending tools must not flash a Preparing update on the parent card"
        );

        let working = projector.project_canonical(&child_tool_event(ToolCallStatus::InProgress));
        let parent_activity = serde_json::to_value(&working.events[0]).unwrap();
        assert!(parent_activity["event"]["content"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("Latest: Working on Read repository")));

        let completed = projector.project_canonical(&child_tool_event(ToolCallStatus::Completed));
        assert!(
            subagent_cards(&completed).is_empty(),
            "the completed half of a tool lifecycle must reuse its working update"
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
            "completed"
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

    /// The card reports what the sub-agent is doing, and narration is not doing anything. Once a
    /// tool has run, response and reasoning chunks must keep naming that tool instead of
    /// repainting the card with streamed prose.
    #[test]
    fn a_running_card_names_the_last_tool_instead_of_streamed_narration() {
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
        let child_tool = |tool_call_id: &str, title: &str| CanonicalEvent::Tool {
            agent_id: "alpha-agent".to_string(),
            thread_id: child_thread.clone(),
            run_id: Some("child-run".to_string()),
            source_turn_id: Some("child-turn".to_string()),
            generation: Some(1),
            tool_call_id: tool_call_id.to_string(),
            kind: ToolKind::Read,
            status: ToolCallStatus::InProgress,
            title: title.to_string(),
            content: FieldUpdate::Set(String::new()),
            structured_content: FieldUpdate::Set(Vec::new()),
            locations: FieldUpdate::Set(Vec::new()),
        };

        // Before any tool has run there is nothing else to report, so narration still shows.
        let narrating = projector.project_canonical(&child_message(
            "answer-1",
            MessageRole::Agent,
            "Let me look at the code",
        ));
        assert!(subagent_cards(&narrating)[0]
            .1
            .contains("Latest: Responding: Let me look at the code"));

        let searched = projector.project_canonical(&child_tool("read-1", "Search dependencies"));
        assert!(subagent_cards(&searched)[0]
            .1
            .contains("Latest: Working on Search dependencies"));

        // Every later narration chunk keeps naming that tool, and repeats stay silent so the
        // transcript does not resize under the user's finger.
        for (index, chunk) in ["Now I will", " summarize the findings"].iter().enumerate() {
            let narrated = projector.project_canonical(&child_message(
                &format!("answer-{}", index + 2),
                MessageRole::Agent,
                chunk,
            ));
            assert!(
                subagent_cards(&narrated).is_empty(),
                "narration repainted the card: {:?}",
                subagent_cards(&narrated)
            );
        }
        let reasoning =
            projector.project_canonical(&child_message("thought-1", MessageRole::Thought, "Hmm"));
        assert!(subagent_cards(&reasoning).is_empty());

        // A genuinely new tool still updates the card.
        let edited = projector.project_canonical(&child_tool("read-2", "Edit manifest"));
        assert!(subagent_cards(&edited)[0]
            .1
            .contains("Latest: Working on Edit manifest"));

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
            "terminal card must report its outcome, got {completed:?}"
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
            serde_json::Value::String(child_thread.clone())
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
                .filter_map(|event| serde_json::to_value(event).ok())
                .all(|value| value["event"]["messageId"] != "subagent:task-1"),
            "child start regressed the parent card to a starting preview"
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
        assert!(projector
            .project_canonical(&tool(ToolCallStatus::InProgress))
            .events
            .is_empty());
        let failed = projector.project_canonical(&tool(ToolCallStatus::Failed));
        assert_eq!(event_types(&failed.events), ["TOOL_CALL_END", "CUSTOM"]);
        assert_eq!(
            serde_json::to_value(&failed.events[1]).unwrap()["event"]["value"]["status"],
            "failed"
        );
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
            ]
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
            serde_json::to_value(approval).unwrap()
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
            serde_json::to_value(user_input).unwrap()
        );
        let elicitation_resolved =
            projector.project_canonical(&CanonicalEvent::ElicitationResolved {
                agent_id: "alpha-agent".into(),
                thread_id,
                request_id: "question".into(),
                action: "cancelled".into(),
            });
        assert_eq!(
            elicitation_resolved.controls[0].0,
            "bridge/userInput.resolved"
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
            .await
        );

        let (initial, _, _) = hub.replay_since(None, 32).await;
        assert_eq!(initial.len(), 1);
        assert_eq!(initial[0]["params"]["threadId"], parent_thread_id);
        assert_eq!(
            initial[0]["params"]["event"]["content"]["subAgent"]["receiverThreadIds"][0],
            child_thread_id
        );
        assert_eq!(
            initial[0]["params"]["event"]["content"]["subAgent"]
                .as_object()
                .map(|object| object.len()),
            Some(5)
        );
        assert!(
            !hub.link_subagent(
                parent_thread_id,
                "parent-run",
                Some("parent-turn".to_string()),
                "task-1",
                child_thread_id,
            )
            .await
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
                    .is_some_and(|text| text.contains("Latest: Responding: Reading project files"))
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
        let changed_thought = projector.project_canonical(&canonical_message(
            MessageRole::Thought,
            "thought-2",
            "two",
        ));
        assert_eq!(
            event_types(&changed_thought.events),
            [
                "REASONING_MESSAGE_END",
                "REASONING_MESSAGE_START",
                "REASONING_MESSAGE_CONTENT"
            ]
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
            ]
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
            ["RUN_ERROR", "RUN_STARTED"]
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
            ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]
        );
        assert_eq!(
            serde_json::to_value(&user.events[0]).unwrap()["event"]["role"],
            "user"
        );
        let next_user =
            projector.project_canonical(&canonical_message(MessageRole::User, "next-user", "next"));
        assert_eq!(
            event_types(&next_user.events),
            [
                "TEXT_MESSAGE_END",
                "TEXT_MESSAGE_START",
                "TEXT_MESSAGE_CONTENT"
            ]
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
            let projection = projector.project_canonical(&canonical_message(
                role,
                &format!("{role:?}"),
                &content,
            ));
            let reconstructed = projection
                .events
                .iter()
                .filter_map(|envelope| envelope.event.delta.as_ref())
                .filter_map(|delta| match delta {
                    Delta::String(value) => Some(value.as_str()),
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
                false
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
                AgUiEventContent::String(value) => Some(value.as_str()),
                _ => None,
            })
            .collect::<String>();
        assert!(reconstructed.len() <= MAX_TOOL_TOTAL_BYTES);
        assert!(content.starts_with(&reconstructed));
        assert_eq!(
            projector.runs.values().next().unwrap().tools["large-tool"]
                .result_content
                .len(),
            MAX_TOOL_TOTAL_BYTES
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
            ["CUSTOM", "TEXT_MESSAGE_START"]
        );
        let value = serde_json::to_value(&projected.events[0]).unwrap();
        assert_eq!(value["event"]["name"], "dappercode.dev/message-content");
        assert_eq!(value["event"]["value"]["content"]["type"], "image");
        assert!(!value.to_string().contains("non-text content omitted"));

        let repeated_reasoning = projector.project_canonical(&canonical_message(
            MessageRole::Thought,
            "reasoning",
            "one",
        ));
        assert_eq!(
            event_types(&repeated_reasoning.events),
            ["REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT"]
        );
        let repeated_reasoning = projector.project_canonical(&canonical_message(
            MessageRole::Thought,
            "reasoning",
            "two",
        ));
        assert_eq!(
            event_types(&repeated_reasoning.events),
            ["REASONING_MESSAGE_CONTENT"]
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
            ]
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
            1
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
        let terminal_first = terminal_first_projector
            .project_canonical(&tool(ToolCallStatus::Failed, "terminal-first"));
        assert!(event_types(&terminal_first.events).contains(&"TOOL_CALL_RESULT"));
        let started = projector.project_canonical(&tool(ToolCallStatus::Pending, ""));
        assert_eq!(
            event_types(&started.events),
            ["TOOL_CALL_START", "TOOL_CALL_ARGS", "CUSTOM"]
        );
        let serialized = serde_json::to_value(&started.events[0]).unwrap();
        assert_eq!(serialized["event"]["toolCallName"], "edit");
        let partial = projector.project_canonical(&tool(ToolCallStatus::InProgress, "first"));
        assert_eq!(event_types(&partial.events), ["CUSTOM", "CUSTOM"]);
        assert_eq!(
            serde_json::to_value(&partial.events[1]).unwrap()["event"]["name"],
            "dappercode.dev/tool-text"
        );
        assert!(projector
            .project_canonical(&tool(ToolCallStatus::InProgress, "first"))
            .events
            .is_empty());
        let empty_terminal = projector.project_canonical(&tool(ToolCallStatus::Failed, ""));
        assert_eq!(
            event_types(&empty_terminal.events),
            ["TOOL_CALL_END", "CUSTOM", "CUSTOM"]
        );
        assert_eq!(
            serde_json::to_value(&empty_terminal.events[2]).unwrap()["event"]["name"],
            "dappercode.dev/tool-text"
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
            "updated title"
        );
        assert!(projector
            .project_canonical(&metadata_only)
            .events
            .is_empty());
        let changed_result = projector.project_canonical(&tool(ToolCallStatus::Failed, "second"));
        assert_eq!(
            event_types(&changed_result.events),
            ["CUSTOM", "TOOL_CALL_RESULT"]
        );
        assert_eq!(
            serde_json::to_value(&changed_result.events[1]).unwrap()["event"]["content"],
            "second"
        );
        let suffix_result = projector.project_canonical(&tool(ToolCallStatus::Failed, "second!"));
        assert_eq!(event_types(&suffix_result.events), ["TOOL_CALL_RESULT"]);
        assert_eq!(
            serde_json::to_value(&suffix_result.events[0]).unwrap()["event"]["content"],
            "!"
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
            "second! appended"
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
            snapshot.tools["tool"].content
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
            " appended"
        );
        let repeated = projector.project_canonical(&append_event);
        assert_eq!(event_types(&repeated.events), ["TOOL_CALL_RESULT"]);
        assert_eq!(
            serde_json::to_value(&repeated.events[0]).unwrap()["event"]["content"],
            " appended"
        );
        let mut cleared = append_event.clone();
        if let CanonicalEvent::Tool { content, .. } = &mut cleared {
            *content = FieldUpdate::Append(String::new());
        }
        assert!(!event_types(&projector.project_canonical(&cleared).events)
            .contains(&"TOOL_CALL_RESULT"));
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
            ]
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
            ["TOOL_CALL_START", "TOOL_CALL_ARGS", "CUSTOM", "CUSTOM"]
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
            "dappercode.dev/tool-content"
        );
        assert_eq!(
            appended_value["event"]["value"]["content"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            appended_value["event"]["value"]["locations"]
                .as_array()
                .unwrap()
                .len(),
            1
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
            "dappercode.dev/tool-meta"
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
            "dappercode.dev/tool-content"
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
            false
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
            true
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
            Value::String("value".to_string())
        );
        assert_eq!(
            field_value(&FieldUpdate::Append("suffix".to_string())),
            Value::String("suffix".to_string())
        );
        let unicode = format!("{}é", "x".repeat(7));
        assert_eq!(bounded(unicode, 8), "xxxxxxx");
        assert_eq!(bounded("short", 8), "short");
    }
}
