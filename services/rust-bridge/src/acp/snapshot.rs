#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
use std::collections::{BTreeMap, HashSet, VecDeque};

use agent_client_protocol::v1::schema::{ToolCallStatus, ToolKind};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::events::{
    CanonicalEvent, CommandEntry, ConfigEntry, ConfigOptionValue, FieldUpdate, MessageRole,
    PlanEntry,
};

const MAX_MESSAGES: usize = 128;
const MAX_TOOLS: usize = 128;
const MAX_ACTIVE_TOOL_TOMBSTONES: usize = MAX_TOOLS;
const MAX_TIMELINE_ENTRIES: usize = MAX_MESSAGES + MAX_TOOLS;
const MAX_ENTRIES: usize = 128;
const MAX_TEXT_BYTES: usize = 32 * 1024;
const MAX_MESSAGE_PARTS: usize = 64;
const MAX_STRUCTURED_PART_BYTES: usize = 16 * 1024;
const MAX_STRUCTURED_FIELDS: usize = 64;
const MAX_TOOL_TEXT_BYTES: usize = 64 * 1024;
const MAX_TOOL_STRUCTURED_ITEMS: usize = 64;
const MAX_TOOL_LOCATIONS: usize = 32;
pub const MAX_SNAPSHOT_PAGE_SIZE: usize = 100;
const MAX_HISTORY_ENTRIES: usize = 1_024;
const MAX_HISTORY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
pub struct SessionSnapshot {
    pub agent_id: String,
    pub thread_id: String,
    pub history_reconstruction: bool,
    pub active_run_id: Option<String>,
    pub active_source_turn_id: Option<String>,
    pub active_generation: Option<u64>,
    pub active_tool_ids: HashSet<String>,
    pub messages: VecDeque<SnapshotMessage>,
    pub tools: BTreeMap<String, SnapshotTool>,
    #[serde(skip)]
    subagent_headers: BTreeMap<String, String>,
    pub timeline: VecDeque<SnapshotTimelineEntry>,
    pub next_sequence: u64,
    total_messages: u64,
    total_reasoning: u64,
    total_tools: u64,
    history: VecDeque<SnapshotHistoryEntry>,
    history_bytes: usize,
    unavailable_count: u64,
    pub plan: Vec<PlanEntry>,
    pub mode_id: Option<String>,
    pub config: Vec<ConfigEntry>,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub commands: Vec<CommandEntry>,
    pub usage_used: Option<u64>,
    pub usage_size: Option<u64>,
    pub usage_cost: Option<String>,
    pub token_totals: Option<BridgeTokenTotalsSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMessage {
    pub id: String,
    pub role: MessageRole,
    pub parts: Vec<serde_json::Value>,
    pub truncated: bool,
    /// What the turn that produced this response cost, attached to the agent message the turn
    /// ended on so a reloaded transcript can report per-response usage instead of only the
    /// session-wide totals.
    pub usage: Option<BridgeTurnUsageSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_message: Option<crate::agent_messaging::AgentMessageOrigin>,
}

/// The token cost of a single prompt turn, plus the model that was configured while it ran.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTurnUsageSnapshot {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: Option<u64>,
    pub cached_read_tokens: Option<u64>,
    pub cached_write_tokens: Option<u64>,
    pub total_tokens: u64,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkBoundary {
    /// Number of complete user turns the fork keeps.
    pub ordinal: usize,
    pub kind: ForkBoundaryKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForkBoundaryKind {
    /// The fork must stop before this user request.
    BeforeRequest(ForkBoundaryMessage),
    /// The boundary is the end of the conversation, so the fork keeps every recorded turn. The
    /// newest request travels with it so a harness can confirm the source has not gained a turn
    /// since the snapshot was read by identity rather than by counting messages, which a harness
    /// is free to split differently from the canonical transcript.
    EndOfHistory { newest_request: ForkBoundaryMessage },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkBoundaryMessage {
    pub message_id: String,
    pub first_text: String,
    pub first_text_truncated: bool,
    pub raw_message_id_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
pub struct SnapshotTool {
    pub id: String,
    pub generation: Option<u64>,
    pub kind: ToolKind,
    pub status: ToolCallStatus,
    pub title: String,
    pub started_at_ms: i64,
    pub completed_at_ms: Option<i64>,
    pub content: String,
    pub structured_content: Vec<serde_json::Value>,
    pub locations: Vec<serde_json::Value>,
    pub truncated: bool,
    /// Whether this tool call spawns a sub-agent.
    ///
    /// Agents rename a task tool once it reports progress (OpenCode opens it as `task` and
    /// then relabels it with the task description), so the only update that names it is the
    /// first one. Without a durable flag a running sub-agent renders as an ordinary tool until
    /// its `<task …>` result lands, which for a foreground task is when it has already finished.
    pub subagent: bool,
    /// The run was cancelled while this call was still active. ACP has no cancelled tool status,
    /// so the call keeps `Failed` (on the wire too) and this flag marks it as interrupted.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub interrupted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTimelineEntry {
    pub sequence: u64,
    pub kind: SnapshotTimelineKind,
    pub canonical_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotTimelineKind {
    Message,
    Reasoning,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotHistoryEntry {
    pub sequence: u64,
    pub kind: SnapshotTimelineKind,
    pub canonical_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<SnapshotMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<SnapshotTool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotCollectionMetadata {
    pub truncated: bool,
    pub omitted_count: u64,
    pub oldest_available_sequence: Option<u64>,
    pub newest_sequence: Option<u64>,
    pub before_cursor: Option<String>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotContinuation {
    pub revision: u64,
    pub unavailable_count: u64,
    pub earliest_available_sequence: Option<u64>,
    pub latest_available_sequence: Option<u64>,
    pub max_page_size: usize,
    pub max_history_entries: usize,
    pub max_history_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPage {
    pub entries: Vec<SnapshotHistoryEntry>,
    pub before_cursor: Option<String>,
    pub after_cursor: Option<String>,
    pub has_more_before: bool,
    pub has_more_after: bool,
    pub unavailable_count: u64,
    pub earliest_available_sequence: Option<u64>,
    pub latest_available_sequence: Option<u64>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotCursor {
    thread_id: String,
    sequence: u64,
    revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
pub struct BridgeThreadSnapshot {
    pub version: u64,
    pub timeline: Vec<SnapshotTimelineEntry>,
    pub messages: Vec<SnapshotMessage>,
    pub tools: Vec<SnapshotTool>,
    pub message_collection: SnapshotCollectionMetadata,
    pub reasoning_collection: SnapshotCollectionMetadata,
    pub tool_collection: SnapshotCollectionMetadata,
    pub continuation: SnapshotContinuation,
    pub plan: Vec<PlanEntry>,
    pub usage: BridgeUsageSnapshot,
    pub token_totals: Option<BridgeTokenTotalsSnapshot>,
    pub mode: Option<String>,
    pub config: Vec<ConfigEntry>,
    pub commands: Vec<CommandEntry>,
    pub session: BridgeSessionMetadata,
    pub active: BridgeActiveRunSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeUsageSnapshot {
    pub used: Option<u64>,
    pub size: Option<u64>,
    pub cost: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTokenTotalsSnapshot {
    pub turns: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: Option<u64>,
    pub cached_read_tokens: Option<u64>,
    pub cached_write_tokens: Option<u64>,
    pub total_tokens: u64,
}

impl BridgeTokenTotalsSnapshot {
    pub(crate) fn add_turn(
        &mut self,
        input_tokens: u64,
        output_tokens: u64,
        reasoning_tokens: Option<u64>,
        cached_read_tokens: Option<u64>,
        cached_write_tokens: Option<u64>,
        total_tokens: u64,
    ) {
        self.turns = self.turns.saturating_add(1);
        self.input_tokens = self.input_tokens.saturating_add(input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(output_tokens);
        add_reported_tokens(&mut self.reasoning_tokens, reasoning_tokens);
        add_reported_tokens(&mut self.cached_read_tokens, cached_read_tokens);
        add_reported_tokens(&mut self.cached_write_tokens, cached_write_tokens);
        self.total_tokens = self.total_tokens.saturating_add(total_tokens);
    }
}

fn add_reported_tokens(total: &mut Option<u64>, reported: Option<u64>) {
    if let Some(reported) = reported {
        *total = Some(total.unwrap_or_default().saturating_add(reported));
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSessionMetadata {
    pub agent_id: String,
    pub thread_id: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub history_reconstruction: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeActiveRunSnapshot {
    pub run_id: Option<String>,
    pub source_turn_id: Option<String>,
    pub generation: Option<u64>,
    pub tool_ids: Vec<String>,
}

impl From<SessionSnapshot> for BridgeThreadSnapshot {
    fn from(snapshot: SessionSnapshot) -> Self {
        let message_collection = snapshot.collection_metadata(SnapshotTimelineKind::Message);
        let reasoning_collection = snapshot.collection_metadata(SnapshotTimelineKind::Reasoning);
        let tool_collection = snapshot.collection_metadata(SnapshotTimelineKind::Tool);
        let continuation = snapshot.continuation();
        let mut tools = snapshot.tools;
        for (tool_call_id, header) in snapshot.subagent_headers {
            let Some(tool) = tools.get_mut(&tool_call_id) else {
                continue;
            };
            SessionSnapshot::ensure_durable_subagent_header(tool, &header);
        }
        Self {
            version: 2,
            timeline: snapshot.timeline.into_iter().collect(),
            messages: snapshot.messages.into_iter().collect(),
            tools: tools.into_values().collect(),
            message_collection,
            reasoning_collection,
            tool_collection,
            continuation,
            plan: snapshot.plan,
            usage: BridgeUsageSnapshot {
                used: snapshot.usage_used,
                size: snapshot.usage_size,
                cost: snapshot.usage_cost,
            },
            token_totals: snapshot.token_totals,
            mode: snapshot.mode_id,
            config: snapshot.config,
            commands: snapshot.commands,
            session: BridgeSessionMetadata {
                agent_id: snapshot.agent_id,
                thread_id: snapshot.thread_id,
                title: snapshot.title,
                updated_at: snapshot.updated_at,
                history_reconstruction: snapshot.history_reconstruction,
            },
            active: BridgeActiveRunSnapshot {
                run_id: snapshot.active_run_id,
                source_turn_id: snapshot.active_source_turn_id,
                generation: snapshot.active_generation,
                tool_ids: {
                    let mut ids = snapshot.active_tool_ids.into_iter().collect::<Vec<_>>();
                    ids.sort();
                    ids
                },
            },
        }
    }
}

struct ToolProjection<'a> {
    kind: &'a ToolKind,
    status: &'a ToolCallStatus,
    title: &'a str,
    content: &'a FieldUpdate<String>,
    structured_content: &'a FieldUpdate<Vec<serde_json::Value>>,
    locations: &'a FieldUpdate<Vec<serde_json::Value>>,
}

fn raw_opencode_message_id(message_id: &str) -> Option<&str> {
    let candidate = message_id
        .strip_prefix("export:")
        .and_then(|rest| rest.split_once(':'))
        .map(|(raw_id, _)| raw_id)
        .or_else(|| message_id.rsplit_once("::item::").map(|(_, raw_id)| raw_id))
        .unwrap_or(message_id);
    candidate.starts_with("msg_").then_some(candidate)
}

fn message_matches_id(message: &SnapshotMessage, message_id: &str) -> bool {
    let target_raw_id = raw_opencode_message_id(message_id);
    let message_raw_id = raw_opencode_message_id(&message.id);
    message.id == message_id || target_raw_id.is_some_and(|target| Some(target) == message_raw_id)
}

fn describe_user_message(message: &SnapshotMessage) -> ForkBoundaryMessage {
    let first_text = message
        .parts
        .iter()
        .find_map(|part| {
            (part.get("type").and_then(serde_json::Value::as_str) == Some("text"))
                .then(|| part.get("text").and_then(serde_json::Value::as_str))
                .flatten()
        })
        .unwrap_or_default()
        .trim()
        .to_string();
    ForkBoundaryMessage {
        message_id: message.id.clone(),
        first_text,
        first_text_truncated: message.truncated,
        raw_message_id_hint: raw_opencode_message_id(&message.id).map(str::to_string),
    }
}

impl SessionSnapshot {
    /// Resolves the exclusive fork boundary named by `message_id`.
    ///
    /// The identifier may name either the user request that the fork must stop before, or a
    /// response that the fork must keep along with the rest of its turn. Naming a response is what
    /// lets the newest response in a conversation be forked: it resolves to the end of history,
    /// where no later user request exists to act as the exclusive boundary. This is
    /// transport-neutral - every harness receives the same "keep this many complete user turns"
    /// instruction plus the identity of the request that bounds them.
    pub fn complete_fork_boundary(&self, message_id: &str) -> Option<ForkBoundary> {
        if self.unavailable_count != 0
            || self
                .history
                .front()
                .is_some_and(|entry| entry.sequence != 0)
        {
            return None;
        }
        let messages = self
            .history
            .iter()
            .filter(|entry| entry.kind == SnapshotTimelineKind::Message)
            .filter_map(|entry| entry.message.as_ref())
            .filter(|message| message.agent_message.is_none())
            .collect::<Vec<_>>();
        let target = messages
            .iter()
            .position(|message| message_matches_id(message, message_id))?;
        // Complete user turns kept by the fork. The target itself is excluded when it is the
        // request, and included when it is a response, which is exactly this count either way.
        let ordinal = messages[..target]
            .iter()
            .filter(|message| message.role == MessageRole::User)
            .count();
        let kind = if messages[target].role == MessageRole::User {
            ForkBoundaryKind::BeforeRequest(describe_user_message(messages[target]))
        } else if let Some(next_request) = messages[target + 1..]
            .iter()
            .find(|message| message.role == MessageRole::User)
        {
            ForkBoundaryKind::BeforeRequest(describe_user_message(next_request))
        } else {
            // A response with no request before it belongs to no turn, so there is nothing to fork.
            let newest_request = messages[..target]
                .iter()
                .rfind(|message| message.role == MessageRole::User)?;
            ForkBoundaryKind::EndOfHistory {
                newest_request: describe_user_message(newest_request),
            }
        };
        Some(ForkBoundary { ordinal, kind })
    }

    /// Restores ordinary transcript history while keeping the current metadata and any
    /// agent-message activity that arrived during reconstruction.
    pub fn restore_transcript_from(&mut self, previous: SessionSnapshot) {
        let replayed_agent_messages = self
            .messages
            .iter()
            .filter_map(|message| message.agent_message.clone())
            .collect::<Vec<_>>();
        self.messages = previous.messages;
        self.tools = previous.tools;
        self.subagent_headers = previous.subagent_headers;
        self.timeline = previous.timeline;
        self.next_sequence = previous.next_sequence;
        self.total_messages = previous.total_messages;
        self.total_reasoning = previous.total_reasoning;
        self.total_tools = previous.total_tools;
        self.history = previous.history;
        self.history_bytes = previous.history_bytes;
        self.unavailable_count = previous.unavailable_count;
        for message in replayed_agent_messages {
            self.append_agent_message(message);
        }
    }

    pub(crate) fn has_ordinary_transcript(&self) -> bool {
        !self.tools.is_empty()
            || self
                .messages
                .iter()
                .any(|message| message.agent_message.is_none())
    }

    pub fn new(agent_id: String, thread_id: String) -> Self {
        Self {
            agent_id,
            thread_id,
            ..Self::default()
        }
    }

    pub(crate) fn subagent_header(&self, tool_call_id: &str) -> Option<&str> {
        self.subagent_headers.get(tool_call_id).map(String::as_str)
    }

    pub(crate) fn has_active_subagent_tool(&self) -> bool {
        self.active_tool_ids.iter().any(|tool_call_id| {
            self.tools
                .get(tool_call_id)
                .is_some_and(|tool| tool.subagent)
                || self.subagent_headers.contains_key(tool_call_id)
        })
    }

    pub(crate) fn mark_subagent_terminal(&mut self, child_session_id: &str, status: &str) -> bool {
        let tool_call_id = self
            .subagent_headers
            .iter()
            .filter_map(|(tool_call_id, header)| {
                let matches_child = Self::task_header_id(header) == Some(child_session_id);
                let unresolved = Self::task_header_state(header)
                    .is_some_and(|state| !Self::is_terminal_subagent_state(state));
                (matches_child && unresolved).then_some(tool_call_id.clone())
            })
            .max_by_key(|tool_call_id| {
                self.history
                    .iter()
                    .rev()
                    .find(|entry| entry.canonical_id == **tool_call_id)
                    .map_or(0, |entry| entry.sequence)
            });
        let Some(tool_call_id) = tool_call_id else {
            return false;
        };
        let tool_status = if Self::is_failed_subagent_state(status) {
            ToolCallStatus::Failed
        } else {
            ToolCallStatus::Completed
        };
        self.mark_subagent_tool_terminal(&tool_call_id, status, tool_status)
    }

    pub(crate) fn mark_subagent_tool_terminal(
        &mut self,
        tool_call_id: &str,
        status: &str,
        tool_status: ToolCallStatus,
    ) -> bool {
        if !self.subagent_headers.contains_key(tool_call_id) {
            return false;
        }
        self.update_subagent_tool_terminal(tool_call_id, status, tool_status);
        true
    }

    pub fn apply(&mut self, event: &CanonicalEvent) {
        self.apply_at(event, Utc::now().timestamp_millis());
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    fn apply_at(&mut self, event: &CanonicalEvent, observed_at_ms: i64) {
        match event {
            CanonicalEvent::RunStarted {
                run_id,
                source_turn_id,
                generation,
                ..
            } => {
                if let Some(active_generation) = self.active_generation {
                    self.terminalize_active_tools(ToolCallStatus::Failed, false, observed_at_ms);
                    self.terminalize_unresolved_subagents("failed", active_generation);
                }
                self.active_run_id = Some(run_id.clone());
                self.active_source_turn_id = Some(source_turn_id.clone());
                self.active_generation = Some(*generation);
                self.active_tool_ids.clear();
            }
            CanonicalEvent::RunFinished {
                generation,
                stop_reason,
                ..
            } if self.active_generation == Some(*generation) => {
                if matches!(
                    stop_reason,
                    agent_client_protocol::v1::schema::StopReason::Cancelled,
                ) {
                    self.terminalize_active_tools(ToolCallStatus::Failed, true, observed_at_ms);
                    self.terminalize_unresolved_subagents("cancelled", *generation);
                } else {
                    self.terminalize_active_tools(ToolCallStatus::Completed, false, observed_at_ms);
                }
                self.active_run_id = None;
                self.active_source_turn_id = None;
                self.active_generation = None;
                self.active_tool_ids.clear();
            }
            CanonicalEvent::RunFailed { generation, .. }
                if self.active_generation == Some(*generation) =>
            {
                self.terminalize_active_tools(ToolCallStatus::Failed, false, observed_at_ms);
                self.terminalize_unresolved_subagents("failed", *generation);
                self.active_run_id = None;
                self.active_source_turn_id = None;
                self.active_generation = None;
                self.active_tool_ids.clear();
            }
            CanonicalEvent::MessageChunk {
                message_id,
                role,
                content,
                content_block,
                ..
            } => self.append_message(
                message_id.clone(),
                *role,
                content.clone(),
                content_block.clone(),
            ),
            CanonicalEvent::AgentMessage { message, .. } => {
                self.append_agent_message(message.clone())
            }
            CanonicalEvent::Tool {
                tool_call_id,
                generation,
                kind,
                status,
                title,
                content,
                structured_content,
                locations,
                ..
            } => self.apply_tool(
                tool_call_id,
                *generation,
                observed_at_ms,
                ToolProjection {
                    kind,
                    status,
                    title,
                    content,
                    structured_content,
                    locations,
                },
            ),
            CanonicalEvent::Plan { entries, .. } => {
                self.plan = entries
                    .iter()
                    .take(MAX_ENTRIES)
                    .cloned()
                    .map(bound_plan)
                    .collect()
            }
            CanonicalEvent::Mode { id, .. } => {
                self.mode_id = Some(bound(id.clone(), MAX_TEXT_BYTES))
            }
            CanonicalEvent::Config { entries, .. } => {
                self.config = entries
                    .iter()
                    .take(MAX_ENTRIES)
                    .cloned()
                    .map(bound_config)
                    .collect()
            }
            CanonicalEvent::SessionInfo {
                title, updated_at, ..
            } => {
                apply_field(&mut self.title, title);
                apply_field(&mut self.updated_at, updated_at);
            }
            CanonicalEvent::Commands { commands, .. } => {
                self.commands = commands
                    .iter()
                    .take(MAX_ENTRIES)
                    .cloned()
                    .map(bound_command)
                    .collect()
            }
            CanonicalEvent::Usage {
                used, size, cost, ..
            } => {
                self.usage_used = Some(*used);
                self.usage_size = Some(*size);
                self.usage_cost = cost.clone().map(|value| bound(value, MAX_TEXT_BYTES));
            }
            CanonicalEvent::TurnTokenUsage {
                input_tokens,
                output_tokens,
                reasoning_tokens,
                cached_read_tokens,
                cached_write_tokens,
                total_tokens,
                ..
            } => {
                self.token_totals.get_or_insert_default().add_turn(
                    *input_tokens,
                    *output_tokens,
                    *reasoning_tokens,
                    *cached_read_tokens,
                    *cached_write_tokens,
                    *total_tokens,
                );
                self.attach_turn_usage(BridgeTurnUsageSnapshot {
                    input_tokens: *input_tokens,
                    output_tokens: *output_tokens,
                    reasoning_tokens: *reasoning_tokens,
                    cached_read_tokens: *cached_read_tokens,
                    cached_write_tokens: *cached_write_tokens,
                    total_tokens: *total_tokens,
                    model: self.configured_model_label(),
                });
            }
            CanonicalEvent::RunFinished { .. }
            | CanonicalEvent::RunFailed { .. }
            | CanonicalEvent::PermissionRequested { .. }
            | CanonicalEvent::PermissionResolved { .. }
            | CanonicalEvent::ElicitationRequested { .. }
            | CanonicalEvent::ElicitationResolved { .. }
            | CanonicalEvent::Ignored { .. } => {}
        }
    }

    pub(crate) fn append_message(
        &mut self,
        id: String,
        role: MessageRole,
        content: String,
        content_block: Option<serde_json::Value>,
    ) {
        if let Some(message) = self.messages.iter_mut().find(|message| message.id == id) {
            message.truncated |= append_message_text(&mut message.parts, content);
            if let Some(content_block) = content_block {
                message.truncated |= content_block
                    .get("truncated")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                message.truncated |= append_structured_part(&mut message.parts, content_block);
            }
            let message = message.clone();
            self.update_history_message(&message);
            return;
        }
        if self.messages.len() == MAX_MESSAGES {
            let removed = self.messages.pop_front().expect("full message snapshot");
            self.timeline
                .retain(|entry| entry.canonical_id != removed.id);
        }
        self.push_timeline(
            if role == MessageRole::Thought {
                SnapshotTimelineKind::Reasoning
            } else {
                SnapshotTimelineKind::Message
            },
            id.clone(),
        );
        let mut parts = Vec::new();
        let mut truncated = append_message_text(&mut parts, content);
        if let Some(content_block) = content_block {
            truncated |= content_block
                .get("truncated")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            truncated |= append_structured_part(&mut parts, content_block);
        }
        self.messages.push_back(SnapshotMessage {
            id,
            role,
            parts,
            truncated,
            usage: None,
            agent_message: None,
        });
        let message = self.messages.back().expect("message was inserted").clone();
        self.attach_history_message(message);
    }

    pub(crate) fn append_message_after(
        &mut self,
        id: String,
        role: MessageRole,
        content: String,
        content_block: Option<serde_json::Value>,
        after_timeline_id: Option<&str>,
    ) {
        let already_present = self.messages.iter().any(|message| message.id == id);
        self.append_message(id.clone(), role, content, content_block);
        if already_present {
            return;
        }
        match after_timeline_id {
            Some(after_timeline_id) if after_timeline_id != id => {
                self.reposition_message_after(&id, after_timeline_id);
            }
            Some(_) => {}
            None => self.reposition_message_at_start(&id),
        }
    }

    pub(crate) fn append_agent_message(
        &mut self,
        origin: crate::agent_messaging::AgentMessageOrigin,
    ) {
        let id = format!("agent-message:{}", origin.message_id);
        if let Some(message) = self.messages.iter_mut().find(|message| message.id == id) {
            if message.agent_message.is_some() {
                message.agent_message = Some(origin);
                let message = message.clone();
                self.update_history_message(&message);
                return;
            }
        }
        self.append_message(id.clone(), MessageRole::User, origin.body.clone(), None);
        if let Some(message) = self.messages.iter_mut().find(|message| message.id == id) {
            message.agent_message = Some(origin);
            let message = message.clone();
            self.update_history_message(&message);
        }
    }

    pub(crate) fn latest_timeline_canonical_id(&self) -> Option<&str> {
        self.timeline
            .back()
            .map(|entry| entry.canonical_id.as_str())
    }

    pub(crate) fn append_agent_message_after(
        &mut self,
        origin: crate::agent_messaging::AgentMessageOrigin,
        after_timeline_id: Option<&str>,
    ) {
        let id = format!("agent-message:{}", origin.message_id);
        let already_present = self.messages.iter().any(|message| message.id == id);
        self.append_agent_message(origin);
        if already_present {
            return;
        }
        let Some(after_timeline_id) = after_timeline_id.filter(|anchor| *anchor != id) else {
            return;
        };
        self.reposition_message_after(&id, after_timeline_id);
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    fn reposition_message_after(&mut self, message_id: &str, after_timeline_id: &str) {
        let Some((anchor_index, anchor_sequence)) = self
            .timeline
            .iter()
            .enumerate()
            .find(|(_, entry)| entry.canonical_id == after_timeline_id)
            .map(|(index, entry)| (index, entry.sequence))
        else {
            return;
        };
        if !self
            .history
            .iter()
            .any(|entry| entry.canonical_id == after_timeline_id)
        {
            return;
        }
        let Some(timeline_index) = self
            .timeline
            .iter()
            .position(|entry| entry.canonical_id == message_id)
        else {
            return;
        };
        let Some(history_index) = self
            .history
            .iter()
            .rposition(|entry| entry.canonical_id == message_id && entry.message.is_some())
        else {
            return;
        };
        let insertion_after_sequence = self
            .timeline
            .iter()
            .skip(anchor_index + 1)
            .take_while(|entry| {
                entry.canonical_id != message_id
                    && self.messages.iter().any(|message| {
                        message.id == entry.canonical_id && message.agent_message.is_some()
                    })
            })
            .map(|entry| entry.sequence)
            .last()
            .unwrap_or(anchor_sequence);
        let Some(mut timeline_entry) = self.timeline.remove(timeline_index) else {
            return;
        };
        let Some(mut history_entry) = self.history.remove(history_index) else {
            return;
        };

        for entry in &mut self.timeline {
            if entry.sequence > insertion_after_sequence {
                entry.sequence = entry.sequence.saturating_add(1);
            }
        }
        for entry in &mut self.history {
            if entry.sequence > insertion_after_sequence {
                entry.sequence = entry.sequence.saturating_add(1);
            }
        }
        timeline_entry.sequence = insertion_after_sequence.saturating_add(1);
        history_entry.sequence = timeline_entry.sequence;
        let timeline_insert = self
            .timeline
            .iter()
            .position(|entry| entry.sequence > timeline_entry.sequence)
            .unwrap_or(self.timeline.len());
        self.timeline.insert(timeline_insert, timeline_entry);
        let history_insert = self
            .history
            .iter()
            .position(|entry| entry.sequence > history_entry.sequence)
            .unwrap_or(self.history.len());
        self.history.insert(history_insert, history_entry);

        if let Some(message_index) = self
            .messages
            .iter()
            .position(|message| message.id == message_id)
        {
            let message = self
                .messages
                .remove(message_index)
                .expect("message index came from the snapshot");
            let next_message_id = self
                .timeline
                .iter()
                .skip(timeline_insert + 1)
                .find(|entry| entry.kind == SnapshotTimelineKind::Message)
                .map(|entry| entry.canonical_id.as_str());
            if let Some(next_index) = next_message_id.and_then(|next_id| {
                self.messages
                    .iter()
                    .position(|candidate| candidate.id == next_id)
            }) {
                self.messages.insert(next_index, message);
            } else {
                self.messages.push_back(message);
            }
        }
        self.history_bytes = self.history.iter().map(history_entry_bytes).sum();
        self.enforce_history_bounds();
    }

    fn reposition_message_at_start(&mut self, message_id: &str) {
        let Some(timeline_index) = self
            .timeline
            .iter()
            .position(|entry| entry.canonical_id == message_id)
        else {
            return;
        };
        let Some(history_index) = self
            .history
            .iter()
            .rposition(|entry| entry.canonical_id == message_id && entry.message.is_some())
        else {
            return;
        };
        let Some(mut timeline_entry) = self.timeline.remove(timeline_index) else {
            return;
        };
        let Some(mut history_entry) = self.history.remove(history_index) else {
            return;
        };
        for entry in &mut self.timeline {
            entry.sequence = entry.sequence.saturating_add(1);
        }
        for entry in &mut self.history {
            entry.sequence = entry.sequence.saturating_add(1);
        }
        timeline_entry.sequence = 0;
        history_entry.sequence = 0;
        self.timeline.push_front(timeline_entry);
        self.history.push_front(history_entry);

        if let Some(message_index) = self
            .messages
            .iter()
            .position(|message| message.id == message_id)
        {
            let message = self
                .messages
                .remove(message_index)
                .expect("message index came from the snapshot");
            self.messages.push_front(message);
        }
        self.history_bytes = self.history.iter().map(history_entry_bytes).sum();
        self.enforce_history_bounds();
    }

    /// Records what a finished turn cost on the agent message the turn ended on. The transcript
    /// renders the affordance under a response, so an assistant message is the only anchor that
    /// survives a reload; a turn that produced no agent message simply reports nothing.
    fn attach_turn_usage(&mut self, usage: BridgeTurnUsageSnapshot) {
        let Some(message) = self
            .messages
            .iter_mut()
            .rev()
            .find(|message| message.role == MessageRole::Agent)
        else {
            return;
        };
        message.usage = Some(usage);
        let message = message.clone();
        self.update_history_message(&message);
    }

    /// The display name of the model the session is configured with, preferring the option label
    /// the agent advertises over the raw identifier it stores.
    fn configured_model_label(&self) -> Option<String> {
        let entry = self
            .config
            .iter()
            .find(|entry| entry.category.as_deref() == Some("model"))
            .or_else(|| self.config.iter().find(|entry| entry.id == "model"))?;
        let label = entry
            .options
            .iter()
            .find(|option| option.value == entry.value)
            .map(|option| option.name.clone())
            .unwrap_or_else(|| entry.value.clone());
        let label = label.trim();
        (!label.is_empty()).then(|| bound(label.to_string(), MAX_TEXT_BYTES))
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
    fn apply_tool(
        &mut self,
        id: &str,
        generation: Option<u64>,
        observed_at_ms: i64,
        projection: ToolProjection<'_>,
    ) {
        if self.tools.len() >= MAX_TOOLS && !self.tools.contains_key(id) {
            let oldest = self
                .timeline
                .iter()
                .find(|entry| {
                    entry.kind == SnapshotTimelineKind::Tool
                        && self.tools.contains_key(&entry.canonical_id)
                })
                .map(|entry| entry.canonical_id.clone())
                .expect("full tool snapshot");
            self.tools.remove(&oldest);
            let unresolved_subagent = self
                .subagent_headers
                .get(&oldest)
                .and_then(|header| Self::task_header_state(header))
                .is_some_and(|state| !Self::is_terminal_subagent_state(state));
            if !self.active_tool_ids.contains(&oldest) && !unresolved_subagent {
                self.subagent_headers.remove(&oldest);
            }
            self.timeline.retain(|entry| entry.canonical_id != oldest);
            self.enforce_active_tool_tombstone_bounds();
        }
        let mut retained_tool = None;
        if !self.tools.contains_key(id) {
            let prior_entry = self
                .history
                .iter()
                .rev()
                .filter(|entry| entry.canonical_id == id)
                .find(|entry| entry.tool.is_some())
                .cloned();
            if let Some(prior_entry) = prior_entry {
                retained_tool = prior_entry.tool.clone();
                if let Some(header) = prior_entry
                    .tool
                    .as_ref()
                    .and_then(|tool| Self::latest_valid_task_header(&tool.content))
                {
                    self.subagent_headers
                        .insert(id.to_string(), header.to_string());
                }
                let position = self
                    .timeline
                    .iter()
                    .position(|entry| entry.sequence > prior_entry.sequence)
                    .unwrap_or(self.timeline.len());
                self.timeline.insert(
                    position,
                    SnapshotTimelineEntry {
                        sequence: prior_entry.sequence,
                        kind: SnapshotTimelineKind::Tool,
                        canonical_id: id.to_string(),
                    },
                );
            } else {
                if !self.active_tool_ids.contains(id) {
                    self.subagent_headers.remove(id);
                }
                self.push_timeline(SnapshotTimelineKind::Tool, id.to_string());
            }
        }
        let terminal = matches!(
            projection.status,
            ToolCallStatus::Completed | ToolCallStatus::Failed,
        );
        if generation == self.active_generation {
            if terminal {
                self.active_tool_ids.remove(id);
            } else {
                self.active_tool_ids.insert(id.to_string());
            }
        }
        let existing = self.tools.get(id).cloned().or(retained_tool);
        let started_at_ms = existing
            .as_ref()
            .map(|tool| tool.started_at_ms)
            .unwrap_or(observed_at_ms);
        let completed_at_ms = if terminal {
            Some(
                existing
                    .as_ref()
                    .and_then(|tool| tool.completed_at_ms)
                    .unwrap_or(observed_at_ms.max(started_at_ms)),
            )
        } else {
            existing.as_ref().and_then(|tool| tool.completed_at_ms)
        };
        let mut tool = SnapshotTool {
            id: id.to_string(),
            generation,
            kind: *projection.kind,
            status: *projection.status,
            title: bound(projection.title.to_string(), MAX_TEXT_BYTES),
            started_at_ms,
            completed_at_ms,
            content: existing
                .as_ref()
                .map(|tool| tool.content.clone())
                .unwrap_or_default(),
            structured_content: existing
                .as_ref()
                .map(|tool| tool.structured_content.clone())
                .unwrap_or_default(),
            locations: existing
                .as_ref()
                .map(|tool| tool.locations.clone())
                .unwrap_or_default(),
            truncated: existing.as_ref().is_some_and(|tool| tool.truncated),
            // Sticky: a later update that renames the tool must not un-classify it.
            subagent: existing.as_ref().is_some_and(|tool| tool.subagent)
                || self.subagent_headers.contains_key(id)
                || is_subagent_task_tool(*projection.kind, projection.title),
            interrupted: false,
        };
        tool.truncated |= apply_tool_text(&mut tool.content, projection.content);
        if let Some(header) = Self::latest_valid_task_header(&tool.content) {
            tool.subagent = true;
            let incoming_state = Self::task_header_state(header);
            let preserved_terminal = self
                .subagent_headers
                .get(id)
                .and_then(|preserved| Self::task_header_state(preserved))
                .is_some_and(Self::is_terminal_subagent_state);
            let incoming_nonterminal =
                incoming_state.is_some_and(|state| !Self::is_terminal_subagent_state(state));
            if !(terminal && preserved_terminal && incoming_nonterminal) {
                self.subagent_headers
                    .insert(id.to_string(), bound(header.to_string(), MAX_TEXT_BYTES));
            }
        }
        // A `<task ...>` header is only refreshed while the run that emitted it is alive.
        // Replayed events carry no generation and are never followed by a `RunFinished`, so a
        // tool call that history records as settled keeps whatever header it last saw --
        // typically `state="running"`. Left alone, every restart resurrects a finished
        // sub-agent and the thread reads as still working forever. Live events are untouched:
        // their run owns reconciliation and terminalizes the header when it ends.
        if generation.is_none() && terminal {
            if let Some(header) = self.subagent_headers.get(id) {
                if Self::task_header_state(header)
                    .is_some_and(|state| !Self::is_terminal_subagent_state(state))
                {
                    let settled = if matches!(projection.status, ToolCallStatus::Failed) {
                        "failed"
                    } else {
                        "completed"
                    };
                    let normalized = Self::task_header_with_state(header, settled);
                    self.subagent_headers
                        .insert(id.to_string(), bound(normalized, MAX_TEXT_BYTES));
                }
            }
            if let Some(header) = self.subagent_headers.get(id).cloned() {
                Self::ensure_durable_subagent_header(&mut tool, &header);
            }
        }
        tool.truncated |= apply_tool_values(
            &mut tool.structured_content,
            projection.structured_content,
            MAX_TOOL_STRUCTURED_ITEMS,
        );
        tool.truncated |= apply_tool_values(
            &mut tool.locations,
            projection.locations,
            MAX_TOOL_LOCATIONS,
        );
        self.tools.insert(id.to_string(), tool.clone());
        self.attach_or_update_history_tool(tool);
    }

    fn latest_valid_task_header(content: &str) -> Option<&str> {
        content
            .rmatch_indices("<task ")
            .map(|(index, _)| &content[index..])
            .filter_map(|candidate| {
                let end = candidate.find('>')?;
                let header = &candidate[..=end];
                (header.contains(r#"id=""#) && header.contains(r#"state=""#)).then_some(header)
            })
            .next()
    }

    fn ensure_durable_subagent_header(tool: &mut SnapshotTool, preserved_header: &str) {
        let current_header = Self::latest_valid_task_header(&tool.content);
        let preserved_terminal =
            Self::task_header_state(preserved_header).is_some_and(Self::is_terminal_subagent_state);
        let current_nonterminal = current_header
            .and_then(Self::task_header_state)
            .is_some_and(|state| !Self::is_terminal_subagent_state(state));
        let tool_terminal = matches!(
            tool.status,
            ToolCallStatus::Completed | ToolCallStatus::Failed,
        );
        let source_header = if tool_terminal && preserved_terminal && current_nonterminal {
            preserved_header
        } else {
            current_header.unwrap_or(preserved_header)
        };
        let child_state = Self::task_header_state(source_header);
        let state = match tool.status {
            ToolCallStatus::Completed => child_state
                .filter(|state| Self::is_failed_subagent_state(state))
                .unwrap_or("completed"),
            ToolCallStatus::Failed => child_state
                .filter(|state| Self::is_failed_subagent_state(state))
                .unwrap_or("failed"),
            _ => child_state
                .filter(|state| Self::is_terminal_subagent_state(state))
                .unwrap_or("running"),
        };
        let normalized_header = Self::task_header_with_state(source_header, state);
        let combined = if let Some(current_header) = current_header {
            let mut content = tool.content.clone();
            if let Some(start) = content.rfind(current_header) {
                content.replace_range(start..start + current_header.len(), &normalized_header);
            }
            content
        } else {
            format!("{normalized_header}\n{}", tool.content)
        };
        let bounded = bound(combined.clone(), MAX_TOOL_TEXT_BYTES);
        tool.truncated |= bounded.len() < combined.len();
        tool.content = bounded;
    }

    fn task_header_with_state(header: &str, state: &str) -> String {
        let Some(value_start) = header
            .find(r#"state=""#)
            .map(|index| index + r#"state=""#.len())
        else {
            return header.to_string();
        };
        let Some(value_end) = header[value_start..]
            .find('"')
            .map(|index| value_start + index)
        else {
            return header.to_string();
        };
        let mut normalized = header.to_string();
        normalized.replace_range(value_start..value_end, state);
        normalized
    }

    fn task_header_state(header: &str) -> Option<&str> {
        let value_start = header.find(r#"state=""#)? + r#"state=""#.len();
        let value_end = header[value_start..].find('"')? + value_start;
        Some(&header[value_start..value_end])
    }

    fn task_header_id(header: &str) -> Option<&str> {
        let value_start = header.find(r#"id=""#)? + r#"id=""#.len();
        let value_end = header[value_start..].find('"')? + value_start;
        Some(&header[value_start..value_end])
    }

    fn is_terminal_subagent_state(state: &str) -> bool {
        matches!(
            state.trim().to_ascii_lowercase().as_str(),
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

    fn is_failed_subagent_state(state: &str) -> bool {
        matches!(
            state.trim().to_ascii_lowercase().as_str(),
            "failed" | "error" | "aborted" | "cancelled" | "canceled",
        )
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    fn terminalize_active_tools(
        &mut self,
        status: ToolCallStatus,
        interrupted: bool,
        completed_at_ms: i64,
    ) {
        let active_tool_ids = self.active_tool_ids.iter().cloned().collect::<Vec<_>>();
        let updates = active_tool_ids
            .iter()
            .filter_map(|tool_call_id| {
                let tool = self.tools.get_mut(tool_call_id)?;
                tool.status = status;
                tool.interrupted = interrupted;
                tool.completed_at_ms = Some(
                    tool.completed_at_ms
                        .unwrap_or(completed_at_ms.max(tool.started_at_ms)),
                );
                Some(tool.clone())
            })
            .collect::<Vec<_>>();
        for tool in updates {
            self.attach_or_update_history_tool(tool);
        }

        for tool_call_id in &active_tool_ids {
            if self.tools.contains_key(tool_call_id) {
                continue;
            }
            let header = self.subagent_headers.get(tool_call_id).cloned();
            let Some(index) = self
                .history
                .iter()
                .enumerate()
                .rev()
                .find_map(|(index, entry)| (entry.canonical_id == *tool_call_id).then_some(index))
            else {
                continue;
            };
            self.mutate_history_entry_at(index, |entry| {
                let Some(tool) = entry.tool.as_mut() else {
                    return;
                };
                tool.status = status;
                tool.interrupted = interrupted;
                tool.completed_at_ms = Some(
                    tool.completed_at_ms
                        .unwrap_or(completed_at_ms.max(tool.started_at_ms)),
                );
                if let Some(header) = header {
                    Self::ensure_durable_subagent_header(tool, &header);
                }
            });
        }
        for tool_call_id in active_tool_ids {
            if !self.tools.contains_key(&tool_call_id) {
                self.subagent_headers.remove(&tool_call_id);
            }
        }
    }

    fn terminalize_unresolved_subagents(&mut self, status: &str, generation: u64) {
        let unresolved = self
            .subagent_headers
            .iter()
            .filter_map(|(tool_call_id, header)| {
                let child_status = Self::task_header_state(header)?;
                let belongs_to_generation = self.tool_generation(tool_call_id) == Some(generation);
                (!Self::is_terminal_subagent_state(child_status) && belongs_to_generation)
                    .then_some(tool_call_id.clone())
            })
            .collect::<Vec<_>>();
        let tool_status = if Self::is_failed_subagent_state(status) {
            ToolCallStatus::Failed
        } else {
            ToolCallStatus::Completed
        };
        for tool_call_id in unresolved {
            self.update_subagent_tool_terminal(&tool_call_id, status, tool_status);
        }
    }

    /// Settles sub-agent headers that outlived the run which was writing them.
    ///
    /// A `<task …>` header is only refreshed while the run that emitted it is alive. Live runs
    /// reconcile it through `RunFinished`, but a replayed history never emits one, so a tool call
    /// that is already `completed` keeps whatever header it last saw, typically
    /// `state="running"`. Persisting that contradiction makes a finished thread report a working
    /// sub-agent forever, on every future read, so the snapshot settles it as soon as the
    /// reconstruction that produced it commits.
    pub fn settle_unresolved_subagents_without_run(&mut self) {
        if self.active_generation.is_some() {
            return;
        }
        let unresolved = self
            .subagent_headers
            .iter()
            .filter_map(|(tool_call_id, header)| {
                let child_status = Self::task_header_state(header)?;
                if Self::is_terminal_subagent_state(child_status) {
                    return None;
                }
                let status = self.tool_status(tool_call_id)?;
                matches!(status, ToolCallStatus::Completed | ToolCallStatus::Failed)
                    .then(|| (tool_call_id.clone(), status))
            })
            .collect::<Vec<_>>();
        for (tool_call_id, tool_status) in unresolved {
            let status = if matches!(tool_status, ToolCallStatus::Failed) {
                "failed"
            } else {
                "completed"
            };
            self.update_subagent_tool_terminal(&tool_call_id, status, tool_status);
        }
    }

    fn tool_status(&self, tool_call_id: &str) -> Option<ToolCallStatus> {
        self.tools
            .get(tool_call_id)
            .map(|tool| tool.status)
            .or_else(|| {
                self.history
                    .iter()
                    .rev()
                    .find(|entry| entry.canonical_id == tool_call_id)
                    .and_then(|entry| entry.tool.as_ref())
                    .map(|tool| tool.status)
            })
    }

    fn tool_generation(&self, tool_call_id: &str) -> Option<u64> {
        self.tools
            .get(tool_call_id)
            .and_then(|tool| tool.generation)
            .or_else(|| {
                self.history
                    .iter()
                    .rev()
                    .find(|entry| entry.canonical_id == tool_call_id)
                    .and_then(|entry| entry.tool.as_ref())
                    .and_then(|tool| tool.generation)
            })
    }

    fn update_subagent_tool_terminal(
        &mut self,
        tool_call_id: &str,
        status: &str,
        tool_status: ToolCallStatus,
    ) {
        if let Some(header) = self.subagent_headers.get_mut(tool_call_id) {
            *header = Self::task_header_with_state(header, status);
        }
        let header = self.subagent_headers.get(tool_call_id).cloned();
        let current = self.tools.get_mut(tool_call_id).map(|tool| {
            tool.status = tool_status;
            if let Some(header) = &header {
                Self::ensure_durable_subagent_header(tool, header);
            }
            tool.clone()
        });
        if let Some(current) = current {
            self.attach_or_update_history_tool(current);
        } else if let Some(index) = self
            .history
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, entry)| (entry.canonical_id == tool_call_id).then_some(index))
        {
            self.mutate_history_entry_at(index, |entry| {
                let Some(tool) = entry.tool.as_mut() else {
                    return;
                };
                tool.status = tool_status;
                if let Some(header) = &header {
                    Self::ensure_durable_subagent_header(tool, header);
                }
            });
        }
        self.active_tool_ids.remove(tool_call_id);
        if !self.tools.contains_key(tool_call_id) {
            self.subagent_headers.remove(tool_call_id);
        }
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_nesting,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    fn enforce_active_tool_tombstone_bounds(&mut self) {
        while self
            .subagent_headers
            .keys()
            .chain(self.active_tool_ids.iter())
            .filter(|tool_call_id| self.is_retained_tool_tombstone(tool_call_id))
            .collect::<HashSet<_>>()
            .len()
            > MAX_ACTIVE_TOOL_TOMBSTONES
        {
            let Some(expired) = self
                .history
                .iter()
                .filter(|entry| self.is_retained_tool_tombstone(&entry.canonical_id))
                .min_by_key(|entry| entry.sequence)
                .map(|entry| entry.canonical_id.clone())
                .or_else(|| {
                    self.subagent_headers
                        .keys()
                        .chain(self.active_tool_ids.iter())
                        .find(|tool_call_id| self.is_retained_tool_tombstone(tool_call_id))
                        .cloned()
                })
            else {
                break;
            };
            let header = self.subagent_headers.get(&expired).cloned();
            if let Some(index) = self
                .history
                .iter()
                .enumerate()
                .rev()
                .find_map(|(index, entry)| (entry.canonical_id == expired).then_some(index))
            {
                self.mutate_history_entry_at(index, |entry| {
                    let Some(tool) = entry.tool.as_mut() else {
                        return;
                    };
                    tool.status = ToolCallStatus::Failed;
                    if let Some(header) = header {
                        Self::ensure_durable_subagent_header(tool, &header);
                    }
                });
            }
            self.active_tool_ids.remove(&expired);
            self.subagent_headers.remove(&expired);
        }
    }

    fn is_retained_tool_tombstone(&self, tool_call_id: &str) -> bool {
        if self.tools.contains_key(tool_call_id) {
            return false;
        }
        self.active_tool_ids.contains(tool_call_id)
            || self
                .subagent_headers
                .get(tool_call_id)
                .and_then(|header| Self::task_header_state(header))
                .is_some_and(|state| !Self::is_terminal_subagent_state(state))
    }

    fn push_timeline(&mut self, kind: SnapshotTimelineKind, canonical_id: String) {
        if self.timeline.len() == MAX_TIMELINE_ENTRIES {
            self.timeline.pop_front();
        }
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        match kind {
            SnapshotTimelineKind::Message => {
                self.total_messages = self.total_messages.saturating_add(1)
            }
            SnapshotTimelineKind::Reasoning => {
                self.total_reasoning = self.total_reasoning.saturating_add(1)
            }
            SnapshotTimelineKind::Tool => self.total_tools = self.total_tools.saturating_add(1),
        }
        self.timeline.push_back(SnapshotTimelineEntry {
            sequence,
            kind,
            canonical_id: canonical_id.clone(),
        });
        self.push_history(SnapshotHistoryEntry {
            sequence,
            kind,
            canonical_id,
            message: None,
            tool: None,
        });
    }

    fn attach_history_message(&mut self, message: SnapshotMessage) {
        self.update_history_message(&message);
    }

    fn update_history_message(&mut self, message: &SnapshotMessage) {
        let index = self
            .history
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, entry)| {
                (entry.canonical_id == message.id && entry.message.is_some()).then_some(index)
            })
            .or_else(|| {
                self.history
                    .iter()
                    .enumerate()
                    .rev()
                    .find_map(|(index, entry)| (entry.canonical_id == message.id).then_some(index))
            });
        if let Some(index) = index {
            self.mutate_history_entry_at(index, |entry| {
                entry.message = Some(message.clone());
            });
        }
    }

    fn attach_or_update_history_tool(&mut self, mut tool: SnapshotTool) {
        if let Some(header) = self.subagent_headers.get(&tool.id).cloned() {
            Self::ensure_durable_subagent_header(&mut tool, &header);
        }
        if let Some(index) = self
            .history
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, entry)| (entry.canonical_id == tool.id).then_some(index))
        {
            self.mutate_history_entry_at(index, |entry| {
                entry.tool = Some(tool);
            });
        }
    }

    fn push_history(&mut self, entry: SnapshotHistoryEntry) {
        self.history_bytes = self
            .history_bytes
            .saturating_add(history_entry_bytes(&entry));
        self.history.push_back(entry);
        self.enforce_history_bounds();
    }

    #[cfg(test)]
    fn remeasure_history(&mut self) {
        self.history_bytes = self.history.iter().map(history_entry_bytes).sum();
        self.enforce_history_bounds();
    }

    fn mutate_history_entry_at(
        &mut self,
        index: usize,
        update: impl FnOnce(&mut SnapshotHistoryEntry),
    ) {
        let old_bytes = history_entry_bytes(
            self.history
                .get(index)
                .expect("history mutation index is valid"),
        );
        update(
            self.history
                .get_mut(index)
                .expect("history mutation index is valid"),
        );
        let new_bytes = history_entry_bytes(
            self.history
                .get(index)
                .expect("history mutation index is valid"),
        );
        self.history_bytes = self
            .history_bytes
            .saturating_sub(old_bytes)
            .saturating_add(new_bytes);
        self.enforce_history_bounds();
    }

    fn enforce_history_bounds(&mut self) {
        while self.history.len() > MAX_HISTORY_ENTRIES || self.history_bytes > MAX_HISTORY_BYTES {
            let removed = self
                .history
                .pop_front()
                .expect("bounded history is nonempty");
            self.history_bytes = self
                .history_bytes
                .saturating_sub(history_entry_bytes(&removed));
            self.unavailable_count = self.unavailable_count.saturating_add(1);
        }
    }

    fn collection_metadata(&self, kind: SnapshotTimelineKind) -> SnapshotCollectionMetadata {
        let sequences = self
            .timeline
            .iter()
            .filter(|entry| entry.kind == kind)
            .map(|entry| entry.sequence)
            .collect::<Vec<_>>();
        let retained = sequences.len() as u64;
        let total = match kind {
            SnapshotTimelineKind::Message => self.total_messages,
            SnapshotTimelineKind::Reasoning => self.total_reasoning,
            SnapshotTimelineKind::Tool => self.total_tools,
        };
        let oldest = sequences.first().copied();
        SnapshotCollectionMetadata {
            truncated: total > retained,
            omitted_count: total.saturating_sub(retained),
            oldest_available_sequence: oldest,
            newest_sequence: sequences.last().copied(),
            before_cursor: oldest.map(|sequence| self.cursor(sequence)),
            revision: self.next_sequence,
        }
    }

    fn continuation(&self) -> SnapshotContinuation {
        SnapshotContinuation {
            revision: self.next_sequence,
            unavailable_count: self.unavailable_count,
            earliest_available_sequence: self.history.front().map(|entry| entry.sequence),
            latest_available_sequence: self.history.back().map(|entry| entry.sequence),
            max_page_size: MAX_SNAPSHOT_PAGE_SIZE,
            max_history_entries: MAX_HISTORY_ENTRIES,
            max_history_bytes: MAX_HISTORY_BYTES,
        }
    }

    fn cursor(&self, sequence: u64) -> String {
        serde_json::to_vec(&SnapshotCursor {
            thread_id: self.thread_id.clone(),
            sequence,
            revision: self.next_sequence,
        })
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .expect("snapshot cursor DTO is serializable")
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub fn page(
        &self,
        before: Option<&str>,
        after: Option<&str>,
        limit: usize,
    ) -> Result<SnapshotPage, &'static str> {
        if before.is_some() && after.is_some() {
            return Err("beforeCursor and afterCursor are mutually exclusive");
        }
        let decode = |value: &str| -> Result<SnapshotCursor, &'static str> {
            let bytes = URL_SAFE_NO_PAD
                .decode(value)
                .map_err(|_| "invalid snapshot cursor")?;
            let cursor: SnapshotCursor =
                serde_json::from_slice(&bytes).map_err(|_| "invalid snapshot cursor")?;
            let valid_identity = cursor.thread_id == self.thread_id;
            let valid_revision = cursor.revision <= self.next_sequence;
            if !(valid_identity & valid_revision) {
                return Err("invalid snapshot cursor");
            }
            Ok(cursor)
        };
        let before = match before {
            Some(cursor) => Some(decode(cursor)?),
            None => None,
        };
        let after = match after {
            Some(cursor) => Some(decode(cursor)?),
            None => None,
        };
        let limit = limit.clamp(1, MAX_SNAPSHOT_PAGE_SIZE);
        let reverse_entries = before.is_some();
        let mut entries = if let Some(cursor) = before {
            self.history
                .iter()
                .rev()
                .filter(|entry| entry.sequence < cursor.sequence)
                .take(limit)
                .cloned()
                .collect::<Vec<_>>()
        } else if let Some(cursor) = after {
            self.history
                .iter()
                .filter(|entry| entry.sequence > cursor.sequence)
                .take(limit)
                .cloned()
                .collect::<Vec<_>>()
        } else {
            self.history.iter().take(limit).cloned().collect::<Vec<_>>()
        };
        if reverse_entries {
            entries.reverse();
        }
        let first = entries.first().map(|entry| entry.sequence);
        let last = entries.last().map(|entry| entry.sequence);
        let earliest = self.history.front().map(|entry| entry.sequence);
        let latest = self.history.back().map(|entry| entry.sequence);
        let has_more_before = first.unwrap_or(0) > earliest.unwrap_or(0);
        let has_more_after = last.unwrap_or(u64::MAX) < latest.unwrap_or(u64::MAX);
        Ok(SnapshotPage {
            before_cursor: first.map(|sequence| self.cursor(sequence)),
            after_cursor: last.map(|sequence| self.cursor(sequence)),
            has_more_before,
            has_more_after,
            entries,
            unavailable_count: self.unavailable_count,
            earliest_available_sequence: earliest,
            latest_available_sequence: latest,
            revision: self.next_sequence,
        })
    }
}

fn history_entry_bytes(entry: &SnapshotHistoryEntry) -> usize {
    #[cfg(test)]
    HISTORY_ENTRY_MEASUREMENTS.with(|measurements| {
        measurements.set(measurements.get().saturating_add(1));
    });
    serde_json::to_vec(entry)
        .expect("snapshot history DTO is serializable")
        .len()
}

#[cfg(test)]
thread_local! {
    static HISTORY_ENTRY_MEASUREMENTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn append_message_text(parts: &mut Vec<serde_json::Value>, content: String) -> bool {
    if content.is_empty() {
        return false;
    }
    if let Some(text) = parts
        .last_mut()
        .and_then(serde_json::Value::as_object_mut)
        .filter(|part| part.get("type").and_then(serde_json::Value::as_str) == Some("text"))
        .and_then(|part| part.get_mut("text"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
    {
        let (joined, truncated) = bounded_append(text, &content, MAX_TEXT_BYTES);
        *parts.last_mut().expect("text part exists") = serde_json::json!({
            "type": "text",
            "text": joined,
        });
        truncated
    } else {
        if parts.len() >= MAX_MESSAGE_PARTS {
            return true;
        }
        let original_len = content.len();
        let bounded = bound(content, MAX_TEXT_BYTES);
        let truncated = bounded.len() < original_len;
        parts.push(serde_json::json!({"type": "text", "text": bounded}));
        truncated
    }
}

fn append_structured_part(parts: &mut Vec<serde_json::Value>, value: serde_json::Value) -> bool {
    if parts.len() >= MAX_MESSAGE_PARTS {
        return true;
    }
    let (value, truncated) = bound_json(value, MAX_STRUCTURED_PART_BYTES, MAX_STRUCTURED_FIELDS);
    parts.push(value);
    truncated
}

fn apply_field(target: &mut Option<String>, update: &FieldUpdate) {
    match update {
        FieldUpdate::Unchanged => {}
        FieldUpdate::Clear => *target = None,
        FieldUpdate::Set(value) => *target = Some(bound(value.clone(), MAX_TEXT_BYTES)),
        FieldUpdate::Append(value) => {
            let mut combined = target.take().unwrap_or_default();
            combined.push_str(value);
            *target = Some(bound(combined, MAX_TEXT_BYTES));
        }
    }
}

/// Whether a tool call spawns a sub-agent.
///
/// The title is the only protocol-visible name a tool call has, and agents rename a task tool
/// as soon as it reports a description, so this must run on every update and its result must be
/// remembered rather than recomputed from the latest title.
pub(crate) fn is_subagent_task_tool(kind: ToolKind, title: &str) -> bool {
    let normalized = title
        .trim()
        .to_ascii_lowercase()
        .replace(['-', '_', ' '], "");
    matches!(normalized.as_str(), "task" | "spawnagent" | "subagent")
        || kind == ToolKind::Think && normalized.contains("agent")
}

fn apply_tool_text(target: &mut String, update: &FieldUpdate<String>) -> bool {
    match update {
        FieldUpdate::Unchanged => false,
        FieldUpdate::Clear => {
            target.clear();
            false
        }
        FieldUpdate::Set(value) => {
            *target = bound(value.clone(), MAX_TOOL_TEXT_BYTES);
            target.len() < value.len()
        }
        FieldUpdate::Append(value) => {
            let (bounded, truncated) = bounded_append(target.clone(), value, MAX_TOOL_TEXT_BYTES);
            *target = bounded;
            truncated
        }
    }
}

fn apply_tool_values(
    target: &mut Vec<serde_json::Value>,
    update: &FieldUpdate<Vec<serde_json::Value>>,
    max_items: usize,
) -> bool {
    match update {
        FieldUpdate::Unchanged => false,
        FieldUpdate::Clear => {
            target.clear();
            false
        }
        FieldUpdate::Set(values) => {
            target.clear();
            append_bounded_values(target, values, max_items)
        }
        FieldUpdate::Append(values) => append_bounded_values(target, values, max_items),
    }
}

fn append_bounded_values(
    target: &mut Vec<serde_json::Value>,
    values: &[serde_json::Value],
    max_items: usize,
) -> bool {
    let mut truncated = target.len().saturating_add(values.len()) > max_items;
    for value in values.iter().take(max_items.saturating_sub(target.len())) {
        let (value, value_truncated) = bound_json(
            value.clone(),
            MAX_STRUCTURED_PART_BYTES,
            MAX_STRUCTURED_FIELDS,
        );
        target.push(value);
        truncated |= value_truncated;
    }
    truncated
}

fn bounded_append(mut current: String, appended: &str, max: usize) -> (String, bool) {
    if current.len() >= max {
        return (bound(current, max), !appended.is_empty());
    }
    let remaining = max - current.len();
    let bounded = bound(appended.to_string(), remaining);
    let truncated = bounded.len() < appended.len();
    current.push_str(&bounded);
    (current, truncated)
}

fn bound_json(
    value: serde_json::Value,
    max_bytes: usize,
    max_fields: usize,
) -> (serde_json::Value, bool) {
    fn walk(
        value: serde_json::Value,
        fields: &mut usize,
        truncated: &mut bool,
    ) -> serde_json::Value {
        match value {
            serde_json::Value::String(value) => {
                let bounded = bound(value.clone(), MAX_STRUCTURED_PART_BYTES);
                *truncated |= bounded.len() < value.len();
                serde_json::Value::String(bounded)
            }
            serde_json::Value::Array(values) => {
                *truncated |= values.len() > MAX_STRUCTURED_FIELDS;
                serde_json::Value::Array(
                    values
                        .into_iter()
                        .take(MAX_STRUCTURED_FIELDS)
                        .map(|value| walk(value, fields, truncated))
                        .collect(),
                )
            }
            serde_json::Value::Object(values) => serde_json::Value::Object(
                values
                    .into_iter()
                    .filter(|(key, _)| !matches!(key.as_str(), "rawInput" | "rawOutput" | "_meta"))
                    .filter_map(|(key, value)| {
                        if *fields >= MAX_STRUCTURED_FIELDS {
                            *truncated = true;
                            return None;
                        }
                        *fields += 1;
                        Some((bound(key, 256), walk(value, fields, truncated)))
                    })
                    .collect(),
            ),
            value => value,
        }
    }
    let mut fields = 0;
    let mut truncated = false;
    let mut bounded = walk(value, &mut fields, &mut truncated);
    if serde_json::to_vec(&bounded).map_or(true, |bytes| bytes.len() > max_bytes) {
        bounded = serde_json::json!({"type":"truncated","truncated":true});
        truncated = true;
    }
    let _ = max_fields;
    (bounded, truncated)
}
fn bound_plan(mut entry: PlanEntry) -> PlanEntry {
    entry.content = bound(entry.content, MAX_TEXT_BYTES);
    entry.priority = bound(entry.priority, MAX_TEXT_BYTES);
    entry.status = bound(entry.status, MAX_TEXT_BYTES);
    entry
}
fn bound_config(mut entry: ConfigEntry) -> ConfigEntry {
    entry.id = bound(entry.id, MAX_TEXT_BYTES);
    entry.value = bound(entry.value, MAX_TEXT_BYTES);
    entry.name = bound(entry.name, MAX_TEXT_BYTES);
    entry.description = entry.description.map(|value| bound(value, MAX_TEXT_BYTES));
    entry.category = entry.category.map(|value| bound(value, 256));
    entry.options = entry
        .options
        .into_iter()
        .take(MAX_ENTRIES)
        .map(bound_config_option)
        .collect();
    entry
}

fn bound_config_option(mut entry: ConfigOptionValue) -> ConfigOptionValue {
    entry.value = bound(entry.value, MAX_TEXT_BYTES);
    entry.name = bound(entry.name, MAX_TEXT_BYTES);
    entry.description = entry.description.map(|value| bound(value, MAX_TEXT_BYTES));
    entry
}
fn bound_command(mut entry: CommandEntry) -> CommandEntry {
    entry.name = bound(entry.name, MAX_TEXT_BYTES);
    entry.description = bound(entry.description, MAX_TEXT_BYTES);
    entry.hint = entry.hint.map(|value| bound(value, MAX_TEXT_BYTES));
    entry
}
fn bound(mut value: String, max: usize) -> String {
    if value.len() > max {
        let mut end = max;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
    }
    value
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "snapshot_tests.rs"]
mod tests;
