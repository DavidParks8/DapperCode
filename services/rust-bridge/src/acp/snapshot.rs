use std::collections::{BTreeMap, HashSet, VecDeque};

use agent_client_protocol::schema::v1::{ToolCallStatus, ToolKind};
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
    /// Agents rename a task tool once it reports progress -- OpenCode opens it as `task` and
    /// then relabels it with the task description -- so the only update that names it is the
    /// first one. Without a durable flag a running sub-agent renders as an ordinary tool until
    /// its `<task …>` result lands, which for a foreground task is when it has already finished.
    pub subagent: bool,
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
        .and_then(|rest| rest.split_once(':').map(|(raw_id, _)| raw_id))
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

    /// Restores the transcript recorded before a reload while keeping the session
    /// metadata (mode, commands, config, plan, usage, title) that the agent just
    /// reported. Used when a reload replays no history at all.
    pub fn restore_transcript_from(&mut self, previous: SessionSnapshot) {
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

    fn apply_at(&mut self, event: &CanonicalEvent, observed_at_ms: i64) {
        match event {
            CanonicalEvent::RunStarted {
                run_id,
                source_turn_id,
                generation,
                ..
            } => {
                if let Some(active_generation) = self.active_generation {
                    self.terminalize_active_tools(ToolCallStatus::Failed, observed_at_ms);
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
                    agent_client_protocol::schema::v1::StopReason::Cancelled
                ) {
                    self.terminalize_active_tools(ToolCallStatus::Failed, observed_at_ms);
                    self.terminalize_unresolved_subagents("cancelled", *generation);
                } else {
                    self.terminalize_active_tools(ToolCallStatus::Completed, observed_at_ms);
                }
                self.active_run_id = None;
                self.active_source_turn_id = None;
                self.active_generation = None;
                self.active_tool_ids.clear();
            }
            CanonicalEvent::RunFailed { generation, .. }
                if self.active_generation == Some(*generation) =>
            {
                self.terminalize_active_tools(ToolCallStatus::Failed, observed_at_ms);
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

    fn append_message(
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
        });
        let message = self.messages.back().expect("message was inserted").clone();
        self.attach_history_message(message);
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
                .find(|entry| entry.canonical_id == id && entry.tool.is_some())
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
            ToolCallStatus::Completed | ToolCallStatus::Failed
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
        // A `<task …>` header is only refreshed while the run that emitted it is alive.
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
                (header.contains("id=\"") && header.contains("state=\"")).then_some(header)
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
            ToolCallStatus::Completed | ToolCallStatus::Failed
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
            .find("state=\"")
            .map(|index| index + "state=\"".len())
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
        let value_start = header.find("state=\"")? + "state=\"".len();
        let value_end = header[value_start..].find('"')? + value_start;
        Some(&header[value_start..value_end])
    }

    fn task_header_id(header: &str) -> Option<&str> {
        let value_start = header.find("id=\"")? + "id=\"".len();
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
                | "closed"
        )
    }

    fn is_failed_subagent_state(state: &str) -> bool {
        matches!(
            state.trim().to_ascii_lowercase().as_str(),
            "failed" | "error" | "aborted" | "cancelled" | "canceled"
        )
    }

    fn terminalize_active_tools(&mut self, status: ToolCallStatus, completed_at_ms: i64) {
        let active_tool_ids = self.active_tool_ids.iter().cloned().collect::<Vec<_>>();
        let updates = active_tool_ids
            .iter()
            .filter_map(|tool_call_id| {
                let tool = self.tools.get_mut(tool_call_id)?;
                tool.status = status;
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
    /// that is already `completed` keeps whatever header it last saw — typically
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
mod tests {
    use agent_client_protocol::schema::v1::{StopReason, ToolCallStatus, ToolKind};

    use super::*;

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
            .contains("state=\"completed\""));

        // Sweeping again is idempotent: it must not reopen or relabel a settled header.
        snapshot.settle_unresolved_subagents_without_run();

        assert!(snapshot
            .subagent_header("call-task-1")
            .expect("settled sub-agent header")
            .contains("state=\"completed\""));
        assert!(!snapshot
            .tools
            .get("call-task-1")
            .expect("tool")
            .content
            .contains("state=\"running\""));
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
            .contains("state=\"failed\""));
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
            .contains("state=\"running\""));

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
            .contains("state=\"running\""));
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
            vec![serde_json::json!({"type":"text","text":"one two"})]
        );
        assert_eq!(
            snapshot.active_tool_ids,
            HashSet::from(["tool".to_string()])
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
            Some(ToolCallStatus::Failed)
        );

        let mut orphaned_header = SessionSnapshot::new("agent".to_string(), "thread".to_string());
        orphaned_header.subagent_headers.insert(
            "missing".to_string(),
            "<task id=\"child\" state=\"running\">".to_string(),
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
            Some("<task id=\"child-1\" state=\"running\">")
        );

        let restored_source = snapshot.clone();
        let mut restored = SessionSnapshot::new("agent".to_string(), "thread".to_string());
        restored.restore_transcript_from(restored_source);
        assert_eq!(
            restored.subagent_header("task-1"),
            Some("<task id=\"child-1\" state=\"running\">")
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
            "paged history lost terminal sub-agent metadata: {paged_tool:?}"
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
            Some("<task id=\"child-1\" state=\"running\">")
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
            "evicted history lost sub-agent metadata: {evicted_history_tool:?}"
        );

        let durable = BridgeThreadSnapshot::from(snapshot);
        assert_eq!(durable.tools.len(), 1);
        assert!(
            durable.tools[0]
                .content
                .starts_with("<task id=\"child-1\" state=\"completed\">\n"),
            "durable thread snapshot lost sub-agent classification: {:?}",
            durable.tools[0]
        );
        let serialized = serde_json::to_value(durable).expect("serializable snapshot");
        assert!(
            serialized.get("subagentHeaders").is_none(),
            "internal metadata leaked into the bridge contract: {serialized}"
        );

        let mut child_failed =
            SessionSnapshot::new("agent".to_string(), "failed-thread".to_string());
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
            child_failed.tools[0]
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
            "evicted active task stayed running: {history_tool:?}"
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
            "plain terminal update lost evicted child failure: {durable_tool:?}"
        );
        assert_eq!(
            snapshot
                .history
                .iter()
                .filter(|entry| entry.canonical_id == "task-active")
                .count(),
            1,
            "restoring an evicted tool duplicated paged history"
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
            snapshot.active_tool_ids.len()
        );
        assert!(
            snapshot
                .history
                .iter()
                .filter_map(|entry| entry.tool.as_ref())
                .any(|tool| tool.status == ToolCallStatus::Failed),
            "expiring a tombstone did not terminalize its history"
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
            "fixture did not roll the active task out of history"
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
            "late update lost rolled-over classification: {task:?}"
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
            durable.tools[0]
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
            vec![serde_json::json!({"kind":"retained"})]
        );
        assert_eq!(
            restored.locations,
            vec![serde_json::json!({"path":"src/a.rs"})]
        );
        assert_eq!(
            snapshot
                .history
                .iter()
                .filter(|entry| entry.canonical_id == "task-active")
                .count(),
            1,
            "late append duplicated retained history"
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
            Some("<task id=\"child-1\" state=\"running\">")
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
            Some("<task id=\"child-1\" state=\"running\">")
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
                content: FieldUpdate::Set(format!(
                    "<task id=\"child-1\" state=\"{state}\">\n</task>"
                )),
                structured_content: FieldUpdate::Set(Vec::new()),
                locations: FieldUpdate::Set(Vec::new()),
            });
        }

        assert!(snapshot.mark_subagent_terminal("child-1", "failed"));
        assert_eq!(
            snapshot.subagent_header("task-1"),
            Some("<task id=\"child-1\" state=\"completed\">")
        );
        assert_eq!(
            snapshot.subagent_header("task-2"),
            Some("<task id=\"child-1\" state=\"failed\">")
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
            durable.tools[0]
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
            ]
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
                content: FieldUpdate::Set(format!(
                    "<task id=\"child-1\" state=\"{state}\">\n</task>"
                )),
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

        assert!(snapshot.mark_subagent_tool_terminal(
            "task-current",
            "failed",
            ToolCallStatus::Failed,
        ));
        assert_eq!(
            snapshot.subagent_header("task-old"),
            Some("<task id=\"child-1\" state=\"completed\">")
        );
        assert_eq!(
            snapshot.subagent_header("task-current"),
            Some("<task id=\"child-1\" state=\"failed\">")
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
            durable.tools[0]
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
            ]
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
        });
        snapshot.messages.push_back(SnapshotMessage {
            id: "reasoning-1".to_string(),
            role: MessageRole::Thought,
            parts: vec![serde_json::json!({"type":"text","text":"Snapshot reasoning"})],
            truncated: false,
            usage: None,
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
        snapshot.commands = vec![CommandEntry {
            name: "test".to_string(),
            description: "Run tests".to_string(),
        }];
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
            manifest["fixtures"]["threadSnapshot"]["acpSnapshot"]
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
                .sum::<usize>()
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
            ToolCallStatus::Completed
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
            0
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
            MAX_TEXT_BYTES - 1
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
        assert_eq!(snapshot.usage_used, Some(3));
        assert_eq!(snapshot.usage_size, Some(10));
        assert_eq!(
            snapshot.usage_cost.as_deref().unwrap().len(),
            MAX_TEXT_BYTES
        );
    }

    #[test]
    fn snapshot_without_turn_usage_exposes_null_token_totals() {
        let snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());

        assert_eq!(
            serde_json::to_value(BridgeThreadSnapshot::from(snapshot)).unwrap()["tokenTotals"],
            serde_json::Value::Null
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
            }
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
            })
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
            })
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
            120
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
            7
        );
        assert_eq!(
            serde_json::to_value(BridgeThreadSnapshot::from(snapshot)).unwrap()["messages"][2]
                ["usage"],
            serde_json::json!({
                "inputTokens": 7,
                "outputTokens": 3,
                "reasoningTokens": null,
                "cachedReadTokens": null,
                "cachedWriteTokens": null,
                "totalTokens": 10,
                "model": "GPT-5.6 Sol",
            })
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
            Some("opaque-model".to_string())
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
            14
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
            })
        );
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
            })
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
            })
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
            })
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
            })
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
            })
        );
    }
}
