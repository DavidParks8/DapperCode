#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
use crate::acp::events::{CanonicalEvent, FieldUpdate, MessageRole};
use crate::acp::identity::AgentSessionId;
use crate::acp::snapshot::{
    is_subagent_task_tool, BridgeTokenTotalsSnapshot, SessionSnapshot, SnapshotMessage,
    SnapshotTimelineKind, SnapshotTool,
};
use crate::agui_generated::{
    AgUiEvent, AgUiEventContent, AgUiEventMessage as Message, AgUiEventRole, AgUiEventType,
    DeltaUnion as Delta, FluffyFunction as Function, FluffyToolCall as ToolCall,
    IndigoContent as MessageContent, MessageRole as AgUiMessageRole, ToolCallType,
};
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::wildcard_imports,
        reason = "flat sibling modules split from main.rs share crate-root symbols"
    )
)]
use crate::*;
use dappercode_bridge_core::resource_limits::NOTIFICATION_MAX_BYTES;
use sha2::{Digest, Sha256};

pub(super) const AG_UI_EVENT_METHOD: &str = "bridge/agui.event";
const CLOSED_THREAD_CAPACITY: usize = 2048;
const OBSERVED_RUN_CAPACITY: usize = 256;
const SUBAGENT_LINK_CAPACITY: usize = 2048;
const SUBAGENT_PROGRESS_CAPACITY: usize = 1024;
/// How many of a sub-agent's parallel tool calls the card tracks before dropping the oldest.
const SUBAGENT_RUNNING_TOOL_CAPACITY: usize = 16;
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
    #[serde(serialize_with = "serialize_event")]
    pub(super) event: AgUiEvent,
}

fn serialize_event<Ser: serde::Serializer>(
    event: &AgUiEvent,
    serializer: Ser,
) -> Result<Ser::Ok, Ser::Error> {
    let mut value = serde_json::to_value(event).map_err(serde::ser::Error::custom)?;
    let fields = value
        .as_object_mut()
        .ok_or_else(|| serde::ser::Error::custom("An AG-UI event must serialize as an object."))?;
    let required_nullable = match event.ag_ui_event_type {
        AgUiEventType::Custom => Some("value"),
        AgUiEventType::Raw => Some("event"),
        AgUiEventType::StateSnapshot => Some("snapshot"),
        _ => None,
    };
    fields.retain(|key, value| !value.is_null() || required_nullable == Some(key.as_str()));
    value.serialize(serializer)
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
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
struct AgUiToolState {
    generic_started: bool,
    ended: bool,
    started_at_ms: Option<i64>,
    completed_at_ms: Option<i64>,
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
    meta_kind: Option<String>,
    meta_title: Option<String>,
}

#[derive(Debug, Clone)]
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
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
    /// Every tool the sub-agent has in flight, oldest first, as `(call id, preview)`. Agents run
    /// tools in parallel, so settling one must not hand the card back while another still runs.
    running_tools: Vec<(String, String)>,
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
    source: ProgressSource,
}

/// Where a card preview came from, which decides whether a running tool may keep the card.
#[derive(Clone, PartialEq, Eq)]
enum ProgressSource {
    /// A tool the sub-agent has started, keyed by its call id. It owns the card until it settles.
    RunningTool(String),
    /// A tool that has settled, freeing the card once nothing else is still running.
    SettledTool(String),
    /// The sub-agent narrating. A tool that is still running outranks it, because naming the work
    /// says more than naming the talking about it.
    Narration,
    /// A state that speaks for itself: plans, approvals, inputs and terminal outcomes.
    Standalone,
}

#[derive(Debug, Default)]
pub(super) struct AgUiProjector {
    runs: HashMap<String, AgUiRunState>,
    closed_threads: HashSet<String>,
    subagent_links: HashMap<String, SubagentActivityLink>,
    observed_runs: VecDeque<String>,
    token_totals: HashMap<String, BridgeTokenTotalsSnapshot>,
}

#[derive(Debug, Default)]
pub(super) struct CanonicalProjection {
    pub(super) events: Vec<AgUiEventEnvelope>,
    pub(super) controls: Vec<(&'static str, Value)>,
}

impl AgUiProjector {
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::excessive_nesting,
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
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
                    close_run(
                        thread_id,
                        previous,
                        timestamp,
                        &mut projection.events,
                        "failed",
                        false,
                        true,
                    );
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
            CanonicalEvent::AgentMessage {
                thread_id, message, ..
            } => {
                let (run_id, source_turn_id) = self
                    .runs
                    .get(thread_id)
                    .map(|run| (run.run_id.clone(), run.source_turn_id.clone()))
                    .unwrap_or_else(|| (format!("{thread_id}::history"), None));
                projection.events.push(envelope(
                    thread_id,
                    &run_id,
                    source_turn_id,
                    activity_event(
                        format!("agent-message:{}", message.message_id),
                        "dappercode.agent_message",
                        agent_message_activity_content(message),
                        timestamp,
                    ),
                ));
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
                let started_at_ms = *state.started_at_ms.get_or_insert(timestamp);
                state.subagent_activity |= subagent_tool || update_has_task;
                let terminal = matches!(
                    status,
                    agent_client_protocol::v1::schema::ToolCallStatus::Completed
                        | agent_client_protocol::v1::schema::ToolCallStatus::Failed,
                );
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
                let result_revision = content.as_ref().map(|content| {
                    format!("sha256:{}", hex::encode(Sha256::digest(content.as_bytes())))
                });
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
                    "sha256:{}",
                    hex::encode(Sha256::digest(
                        serde_json::to_vec(&structured_value).unwrap_or_default()
                    )),
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
                        result.as_deref().unwrap_or(""),
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
                        let (running_tools, last_rendered) = if same_invocation {
                            previous_link
                                .map(|link| {
                                    (link.running_tools.clone(), link.last_rendered.clone())
                                })
                                .unwrap_or_default()
                        } else {
                            (Vec::new(), None)
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
                                running_tools,
                                last_rendered,
                            },
                        );
                    }
                }
                // Read after the linked branch above, which can classify this tool as a
                // sub-agent from accumulated content when the update itself carried none.
                let is_subagent_tool = state.subagent_activity;
                let known_child_thread_id = state.subagent_child_thread_id.clone();
                let linked_subagent_tool = known_child_thread_id.is_some();
                let should_render_generic = !linked_subagent_tool
                    && (!is_subagent_tool || subagent_preview.is_some() || terminal);
                if should_render_generic && !state.generic_started {
                    state.generic_started = true;
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
                            delta: Some(Delta::PurpleString("{}".to_string())),
                            ..tool_event(
                                AgUiEventType::ToolCallArgs,
                                tool_call_id.clone(),
                                timestamp,
                            )
                        },
                    ));
                }
                if terminal && !state.ended {
                    state.completed_at_ms = Some(
                        state
                            .completed_at_ms
                            .unwrap_or(timestamp.max(started_at_ms)),
                    );
                    let linked_child_still_running = subagent
                        .as_ref()
                        .is_some_and(|(task, _)| !is_terminal_subagent_status(task.state));
                    state.ended = !linked_child_still_running;
                    if state.generic_started && !linked_subagent_tool {
                        projection.events.push(envelope(
                            thread_id,
                            &run.run_id,
                            run.source_turn_id.clone(),
                            tool_event(AgUiEventType::ToolCallEnd, tool_call_id.clone(), timestamp),
                        ));
                    }
                }
                let generic_tool_started = state.generic_started;
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
                let completed_at_ms = state.completed_at_ms;
                let meta_revision = format!(
                    "{kind_wire}\0{status_wire}\0{title_wire}\0{started_at_ms}\0{:?}",
                    completed_at_ms,
                );
                let meta_changed = state.generic_started
                    && !linked_subagent_tool
                    && state.meta_revision.as_deref() != Some(meta_revision.as_str());
                if meta_changed {
                    state.meta_revision = Some(meta_revision);
                }
                state.meta_kind = Some(kind_wire.clone());
                state.meta_title = Some(title_wire.clone());
                // Once the child is linked, mirror wrapper progress onto its card. Before
                // that point the same output remains a generic tool row so the first
                // specialized card always has somewhere valid to navigate.
                if let (Some(latest), Some(child_thread_id)) = (
                    subagent_preview
                        .clone()
                        .filter(|_| is_subagent_tool && !terminal && subagent.is_none()),
                    known_child_thread_id.as_deref(),
                ) {
                    let revision = format!("{}\0running\0{latest}", child_thread_id);
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
                            "running",
                            Some(latest.as_str()),
                            timestamp,
                        ));
                    }
                }
                if let Some(child_thread_id) = known_child_thread_id
                    .as_deref()
                    .filter(|_| state.subagent_activity && terminal && subagent.is_none())
                {
                    let wrapper_failed = matches!(
                        status,
                        agent_client_protocol::v1::schema::ToolCallStatus::Failed,
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
                        child_thread_id,
                        latest.as_deref().unwrap_or(""),
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
                        subagent_links.remove(child_thread_id);
                        finished_child_thread_id = Some(child_thread_id.to_string());
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
                            "startedAtMs": started_at_ms,
                            "completedAtMs": completed_at_ms,
                        }),
                        timestamp,
                    );
                }
                if let Some(previous_content) = previous_content {
                    let content = content.clone().unwrap_or_default();
                    if linked_subagent_tool {
                        // A sub-agent's task payload is already rendered by its card.
                        // Echoing it as tool text or a tool result leaves a phantom
                        // tool card next to the card that says the same thing.
                    } else if !generic_tool_started {
                        // Placeholder text is not useful enough to create a generic row.
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
                                        run.run_id,
                                    )),
                                    role: Some(AgUiEventRole::Tool),
                                    content: Some(AgUiEventContent::PurpleString(
                                        chunk.to_string(),
                                    )),
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
                if changed_structured && generic_tool_started && !linked_subagent_tool {
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
                        stop_reason: agent_client_protocol::v1::schema::StopReason::Cancelled,
                        ..
                    },
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
                close_run(
                    thread_id,
                    run,
                    timestamp,
                    &mut projection.events,
                    if run_failed { "failed" } else { "completed" },
                    run_cancelled,
                    false,
                );
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
            CanonicalEvent::TurnTokenUsage {
                thread_id,
                input_tokens,
                output_tokens,
                reasoning_tokens,
                cached_read_tokens,
                cached_write_tokens,
                total_tokens,
                ..
            } => {
                let totals = self.token_totals.entry(thread_id.clone()).or_default();
                totals.add_turn(
                    *input_tokens,
                    *output_tokens,
                    *reasoning_tokens,
                    *cached_read_tokens,
                    *cached_write_tokens,
                    *total_tokens,
                );
                push_custom(
                    &mut projection.events,
                    &self.runs,
                    thread_id,
                    "dappercode.dev/tokenTotals",
                    serde_json::to_value(totals).expect("token totals serialize"),
                    timestamp,
                );
            }
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
                json!({ "commands": commands.iter().take(128).map(|command| {
                    let mut entry = json!({
                        "name": bounded(&command.name, 256),
                        "description": bounded(&command.description, 2 * 1024)
                    });
                    if let Some(hint) = &command.hint {
                        entry["hint"] = json!(bounded(hint, 256));
                    }
                    entry
                }).collect::<Vec<_>>() }),
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
            observed_run_id.clone(),
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
        close_run(thread_id, run, timestamp, events, "completed", false, false);
        events.push(envelope(
            thread_id,
            observed_run_id.clone(),
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
        self.token_totals.remove(thread_id);
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
            let Some(child_thread_id) = tool.subagent_child_thread_id.clone() else {
                continue;
            };
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
                    child_thread_id: Some(&child_thread_id),
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
                child_threads_to_close.push(child_thread_id);
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
        if let Some(run) = self
            .runs
            .get_mut(parent_thread_id)
            .filter(|run| run.run_id == parent_run_id)
        {
            let tool = run.tools.entry(tool_call_id.to_string()).or_default();
            tool.subagent_activity = true;
            tool.subagent_child_thread_id = Some(child_thread_id.to_string());
        }
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
                running_tools: Vec::new(),
                last_rendered: None,
            },
        );
        true
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::excessive_nesting,
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
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
        // Which tool is in flight is tracked before any of the guards below, because both of them
        // can decline to repaint the card and the link must stay accurate either way. A settled
        // tool that is deduped still has to release the card, or narration would never take over.
        {
            let Some(current) = self.subagent_links.get_mut(thread_id) else {
                return;
            };
            match &progress.source {
                ProgressSource::RunningTool(tool_call_id) => {
                    current
                        .running_tools
                        .retain(|(existing, _)| existing != tool_call_id);
                    if current.running_tools.len() >= SUBAGENT_RUNNING_TOOL_CAPACITY {
                        current.running_tools.remove(0);
                    }
                    current
                        .running_tools
                        .push((tool_call_id.clone(), progress.latest.clone()));
                }
                ProgressSource::SettledTool(tool_call_id) => current
                    .running_tools
                    .retain(|(existing, _)| existing != tool_call_id),
                ProgressSource::Narration | ProgressSource::Standalone => {}
            }
        }
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
        // A sub-agent that narrates while one of its tools is still running is still, to the user
        // watching the card, working on that tool. Naming the tool keeps every individual call
        // visible for as long as it runs instead of being wiped by the next streamed token.
        let latest = match progress.source {
            ProgressSource::Narration => self
                .subagent_links
                .get(thread_id)
                .and_then(|current| current.running_tools.last())
                .map(|(_, latest)| latest.clone())
                .unwrap_or_else(|| progress.latest.clone()),
            _ => progress.latest.clone(),
        };
        {
            let Some(current) = self.subagent_links.get_mut(thread_id) else {
                return;
            };
            let rendered = format!("{}\u{0}{latest}", progress.status);
            // Repainting an unchanged card churns the transcript under the user's finger, which
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        perfectionist::overly_long_function,
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
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
                if let Some(agent_message) = &message.agent_message {
                    messages.push(activity_message(
                        message.id.clone(),
                        "dappercode.agent_message",
                        agent_message_activity_content(agent_message),
                    ));
                    continue;
                }
                messages.push(Message {
                    id: message.id.clone(),
                    role: match message.role {
                        MessageRole::User => AgUiMessageRole::User,
                        MessageRole::Agent => AgUiMessageRole::Assistant,
                        MessageRole::Thought => AgUiMessageRole::Reasoning,
                    },
                    content: Some(MessageContent::PurpleString(snapshot_message_text(message))),
                    encrypted_value: None,
                    metadata: None,
                    subagent_run_id: None,
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
                let child_thread_id = task.as_ref().and_then(|task| {
                    AgentSessionId::new(&snapshot.agent_id, &task.session_id)
                        .ok()
                        .map(|identity| identity.encode())
                });
                if let Some(child_thread_id) = child_thread_id {
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
                            "receiverThreadIds": [child_thread_id],
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
                    with_interrupted(
                        json!({
                            "toolCallId": tool.id,
                            "kind": tool_kind_wire(tool.kind),
                            "status": tool_status_wire(tool.status),
                            "title": bounded(&tool.title, 256),
                            "startedAtMs": tool.started_at_ms,
                            "completedAtMs": tool.completed_at_ms,
                            "content": tool.structured_content,
                            "locations": tool.locations,
                            "truncated": tool.truncated,
                        }),
                        tool.interrupted,
                    ),
                ));
                messages.push(Message {
                    id: format!("tool-call:{}", tool.id),
                    role: AgUiMessageRole::Assistant,
                    content: Some(MessageContent::PurpleString(String::new())),
                    encrypted_value: None,
                    metadata: None,
                    subagent_run_id: None,
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
                        metadata: None,
                    }]),
                    error: None,
                    tool_call_id: None,
                    activity_type: None,
                });
                messages.push(Message {
                    id: format!("tool-result:{}", tool.id),
                    role: AgUiMessageRole::Tool,
                    content: Some(MessageContent::PurpleString(tool_snapshot_text(tool))),
                    encrypted_value: None,
                    metadata: None,
                    subagent_run_id: None,
                    name: None,
                    tool_calls: None,
                    error: (matches!(
                        tool.status,
                        agent_client_protocol::v1::schema::ToolCallStatus::Failed,
                    ) && !tool.interrupted)
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
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .any(|call| call.id == result_call_id);
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
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
                    let mut lines = vec![terminal_id
                        .map(|id| format!("[terminal: {id}]"))
                        .unwrap_or_else(|| "[terminal]".to_string())];
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
                return vec![line
                    .map(|line| format!("[location: {path}:{line}]"))
                    .unwrap_or_else(|| format!("[location: {path}]"))];
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

fn activity_message(id: String, activity_type: impl Into<String>, content: Value) -> Message {
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
        metadata: None,
        subagent_run_id: None,
        name: None,
        tool_calls: None,
        error: None,
        tool_call_id: None,
        activity_type: Some(activity_type.into()),
    }
}

fn agent_message_activity_content(message: &crate::agent_messaging::AgentMessageOrigin) -> Value {
    json!({
        "text": message.body,
        "agentMessage": message,
    })
}

struct TaskSubagent<'a> {
    session_id: String,
    state: &'a str,
}

fn parse_task_subagent(content: &str) -> Option<TaskSubagent<'_>> {
    // Tool content is appended across updates, so the newest `<task ...>` header wins.
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
            | ["sub", "agent", "starting"],
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
        .filter(|line| !line.is_empty())
        .filter(|line| !line.starts_with('#'))
        .find(|line| !line.starts_with("```"))
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
/// "starting" and looks stuck, so pre-run states are reported as running; the
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
            | "closed",
    )
}

fn is_failed_subagent_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "failed" | "error" | "aborted" | "cancelled" | "canceled",
    )
}

fn snapshot_subagent_status(
    tool_status: agent_client_protocol::v1::schema::ToolCallStatus,
    child_status: Option<&str>,
) -> &str {
    match tool_status {
        agent_client_protocol::v1::schema::ToolCallStatus::Completed => child_status
            .filter(|status| is_failed_subagent_status(status))
            .unwrap_or("completed"),
        agent_client_protocol::v1::schema::ToolCallStatus::Failed => child_status
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn subagent_progress(canonical: &CanonicalEvent) -> Option<SubagentProgress> {
    match canonical {
        // The task header already created an openable working card. RunStarted is
        // useful for correlation only; rendering it regresses the preview to a
        // meaningless "Starting" state until the child produces real work.
        CanonicalEvent::RunStarted { .. } => None,
        // Narration streams token by token. Echoing it onto the card scrolls prose past the user
        // faster than it can be read and repaints the transcript on every delta, which cancels the
        // tap that opens the sub-agent. The card names the activity instead, so a burst of chunks
        // renders one stable line that the identical-update guard collapses to a single event.
        CanonicalEvent::MessageChunk { role, content, .. } if !content.trim().is_empty() => {
            Some(SubagentProgress {
                status: "running",
                latest: match role {
                    MessageRole::Thought => "Reasoning",
                    MessageRole::Agent => "Responding",
                    MessageRole::User => "Received input",
                }
                .to_string(),
                revision: None,
                source: ProgressSource::Narration,
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
                agent_client_protocol::v1::schema::ToolCallStatus::Pending => None,
                agent_client_protocol::v1::schema::ToolCallStatus::Failed => {
                    Some(SubagentProgress {
                        status: "running",
                        latest: format!("Tool failed {title}"),
                        revision: Some(format!("failed:{tool_call_id}")),
                        source: ProgressSource::SettledTool(tool_call_id.clone()),
                    })
                }
                // A completed tool reuses the running tool's revision, so it never repaints the
                // card; it is projected only to hand the card back to whatever happens next.
                agent_client_protocol::v1::schema::ToolCallStatus::Completed => {
                    Some(SubagentProgress {
                        status: "running",
                        latest: format!("Working on {title}"),
                        revision: Some(format!("working:{tool_call_id}")),
                        source: ProgressSource::SettledTool(tool_call_id.clone()),
                    })
                }
                _ => Some(SubagentProgress {
                    status: "running",
                    latest: format!("Working on {title}"),
                    revision: Some(format!("working:{tool_call_id}")),
                    source: ProgressSource::RunningTool(tool_call_id.clone()),
                }),
            }
        }
        CanonicalEvent::Plan { .. } => Some(SubagentProgress {
            status: "running",
            latest: "Updating plan".to_string(),
            revision: None,
            source: ProgressSource::Standalone,
        }),
        CanonicalEvent::PermissionRequested { .. } => Some(SubagentProgress {
            status: "running",
            latest: "Waiting for approval".to_string(),
            revision: None,
            source: ProgressSource::Standalone,
        }),
        CanonicalEvent::ElicitationRequested { .. } => Some(SubagentProgress {
            status: "running",
            latest: "Waiting for input".to_string(),
            revision: None,
            source: ProgressSource::Standalone,
        }),
        CanonicalEvent::RunFinished {
            stop_reason: agent_client_protocol::v1::schema::StopReason::Cancelled,
            ..
        } => Some(SubagentProgress {
            status: "cancelled",
            latest: "Cancelled".to_string(),
            revision: None,
            source: ProgressSource::Standalone,
        }),
        CanonicalEvent::RunFinished { .. } => Some(SubagentProgress {
            status: "completed",
            latest: "Returned result".to_string(),
            revision: None,
            source: ProgressSource::Standalone,
        }),
        CanonicalEvent::RunFailed { message, .. } => Some(SubagentProgress {
            status: "failed",
            latest: bounded(message, 512),
            revision: None,
            source: ProgressSource::Standalone,
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
        timestamp: Some(timestamp),
        ag_ui_event_type,
        delta: None,
        metadata: None,
        subagent_run_id: None,
        protocol_version: None,
        usage: None,
        description: None,
        parent_tool_call_id: None,
        parent_subagent_run_id: None,
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
        delta: delta.map(Delta::PurpleString),
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
    activity_type: impl Into<String>,
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
        activity_type: Some(activity_type.into()),
        content: Some(AgUiEventContent::AnythingMap(content)),
        replace: Some(true),
        ..generated_event(AgUiEventType::ActivitySnapshot, timestamp)
    }
}

fn envelope(
    thread_id: impl Into<String>,
    run_id: impl Into<String>,
    source_turn_id: Option<String>,
    event: AgUiEvent,
) -> AgUiEventEnvelope {
    AgUiEventEnvelope {
        thread_id: thread_id.into(),
        run_id: run_id.into(),
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn close_run(
    thread_id: &str,
    mut run: AgUiRunState,
    timestamp: i64,
    events: &mut Vec<AgUiEventEnvelope>,
    dangling_tool_status: &str,
    dangling_interrupted: bool,
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
    for (tool_call_id, tool) in &run.tools {
        if !tool.ended
            && tool.generic_started
            && (!tool.subagent_activity || tool.subagent_child_thread_id.is_none())
        {
            events.push(envelope(
                thread_id,
                &run.run_id,
                run.source_turn_id.clone(),
                tool_event(AgUiEventType::ToolCallEnd, tool_call_id.clone(), timestamp),
            ));
            if let (Some(started_at_ms), Some(kind), Some(title)) =
                (tool.started_at_ms, &tool.meta_kind, &tool.meta_title)
            {
                push_structured_chunks(
                    events,
                    thread_id,
                    &run,
                    "dappercode.dev/tool-meta",
                    tool_call_id,
                    with_interrupted(
                        json!({
                            "toolCallId": tool_call_id,
                            "kind": kind,
                            "status": dangling_tool_status,
                            "title": title,
                            "startedAtMs": started_at_ms,
                            "completedAtMs": tool.completed_at_ms.unwrap_or(timestamp.max(started_at_ms)),
                        }),
                        dangling_interrupted,
                    ),
                    timestamp,
                );
            }
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
    let revision = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(serialized.as_bytes())),
    );
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
    name: impl Into<String>,
    value: Value,
    timestamp: i64,
) {
    let (run_id, source_turn_id) = runs
        .get(thread_id)
        .map(|run| (run.run_id.clone(), run.source_turn_id.clone()))
        .unwrap_or_else(|| (format!("{thread_id}::session"), None));
    events.push(envelope(
        thread_id,
        run_id,
        source_turn_id,
        custom_event(name.into(), value, timestamp),
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
    let (run_id, source_turn_id) = runs
        .get(thread_id)
        .map(|run| (run.run_id.clone(), run.source_turn_id.clone()))
        .unwrap_or_else(|| (format!("{thread_id}::session"), None));
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
fn acp_wire_value<Wire: serde::Serialize + std::fmt::Debug>(value: &Wire) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{value:?}").to_ascii_lowercase())
}

fn tool_kind_wire(kind: agent_client_protocol::v1::schema::ToolKind) -> String {
    acp_wire_value(&kind)
}

pub(crate) fn tool_status_wire(
    status: agent_client_protocol::v1::schema::ToolCallStatus,
) -> String {
    acp_wire_value(&status)
}

/// Marks tool metadata for a call that was still active when the user cancelled its run. ACP has
/// no cancelled tool status, and clients map unknown statuses to `pending`, so the status stays
/// `failed` and the separate `interrupted` flag lets newer clients render it neutrally.
pub(crate) const TOOL_META_INTERRUPTED_FIELD: &str = "interrupted";

fn with_interrupted(mut meta: Value, interrupted: bool) -> Value {
    if interrupted {
        if let Some(fields) = meta.as_object_mut() {
            fields.insert(TOOL_META_INTERRUPTED_FIELD.to_string(), Value::Bool(true));
        }
    }
    meta
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "agui_tests.rs"]
mod tests;
