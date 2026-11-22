#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use agent_client_protocol::v1::schema::{
    CloseSessionRequest, DeleteSessionRequest, ElicitationContentValue, ListSessionsRequest,
    LoadSessionRequest, McpServer, NewSessionRequest, PromptRequest, ResumeSessionRequest,
    SessionConfigOptionValue, SessionId, SetSessionConfigOptionRequest,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{SecondsFormat, TimeZone, Utc};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tokio::process::Command as AsyncCommand;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::agent_messaging::{
    AgentMessagingMcpConfig, AgentRelationError, AgentRelationKind, AgentRelationSession,
    AgentRelationStatus, AgentRelations, McpCredentialError, PendingMcpCredential,
};
use crate::storage::atomic_write_private;

use super::config::ResolvedAgentManifest;
use super::events::{
    canonical_event_channel, CanonicalEvent, CanonicalEventReceiver, CanonicalEventSender,
    FieldUpdate, MessageRole,
};
use super::harness::{
    harness_for_manifest, HarnessAdapter, HarnessAgentMessageOutcome, HarnessAgentMessageRequest,
    HarnessContext, HarnessDeleteRequest, HarnessError, HarnessForkBoundary,
    HarnessForkBoundaryMessage, HarnessForkRequest, HarnessOperationFailure, HarnessSteerRequest,
    SessionContext,
};
use super::identity::AgentSessionId;
use super::interactions::{
    ApprovalPolicy, InteractionError, PendingElicitationSummary, PendingPermissionSummary,
};
use super::runtime::{
    AcpConnection, AcpRuntimeError, ForkRequest, NegotiatedInitialize, PromptAdmission,
    RequestCancellation, SteerRequest,
};
use super::snapshot::{ForkBoundaryKind, ForkBoundaryMessage, SessionSnapshot, SnapshotPage};

const MAX_AGENTS: usize = 128;
const MAX_SESSIONS: usize = 2_048;
const MAX_AGENT_RELATION_CHILDREN: usize = 128;
pub(crate) const MAX_PAGE_SIZE: usize = 100;
const MAX_SESSION_LIST_PAGES: usize = 32;
const MAX_ERROR_BYTES: usize = 2_048;
const SESSION_INDEX_VERSION: u64 = 2;
const MAX_SESSION_INDEX_BYTES: usize = 256 * 1024;
const MAX_SESSION_CWD_BYTES: usize = 4_096;
const SESSION_INDEX_FILE: &str = "session-index.json";
const AGENT_MESSAGE_JOURNAL_VERSION: u64 = 1;
const AGENT_MESSAGE_JOURNAL_FILE: &str = "agent-message-journal.json";
const MAX_AGENT_MESSAGE_JOURNAL_ENTRIES: usize = 512;
const MAX_AGENT_MESSAGE_JOURNAL_BYTES: usize = 4 * 1024 * 1024;
const MAX_AGENT_MESSAGE_ID_BYTES: usize = 128;
const MAX_AGENT_MESSAGE_ANCHOR_BYTES: usize = 512;
const MAX_AGENT_MESSAGE_BODY_BYTES: usize = 48 * 1024;
const OPENCODE_SESSION_CATALOG_TIMEOUT: Duration = Duration::from_secs(3);
const OPENCODE_CHILD_LOOKUP_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_OPENCODE_CHILD_SESSIONS: usize = 32;
const MAX_OPENCODE_SESSION_CATALOG_BYTES: usize = 256 * 1024;
const OPENCODE_MODEL_CATALOG_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OPENCODE_MODEL_CATALOG_BYTES: usize = 2 * 1024 * 1024;
const OPENCODE_EXPORT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OPENCODE_EXPORT_BYTES: usize = 4 * 1024 * 1024;

pub type AgentId = String;
type AgentStartResult = (
    LocalAgentManifest,
    Result<(AcpConnection, NegotiatedInitialize), AcpRuntimeError>,
);

#[derive(Debug, thiserror::Error)]
pub enum AgentManagerError {
    #[error("invalid local ACP manifest set: {0}")]
    InvalidManifestSet(String),
    #[error("failed to read local ACP manifest set: {0}")]
    ManifestRead(String),
    #[error("preferred ACP agent failed to start: {0}")]
    PreferredStart(String),
    #[error("ACP agent is unavailable: {0}")]
    AgentUnavailable(String),
    #[error("unknown ACP agent: {0}")]
    UnknownAgent(String),
    #[error("invalid opaque ACP thread ID")]
    InvalidThreadId,
    #[error("invalid opaque ACP pagination cursor")]
    InvalidCursor,
    #[error("failed to persist ACP session index: {0}")]
    SessionIndex(String),
    #[error("conversation fork failed: {0}")]
    Fork(String),
    #[error("agent messaging MCP configuration failed: {0}")]
    AgentMessaging(String),
    #[error("failed to initialize the ACP agent HTTP client: {0}")]
    HttpClient(#[source] reqwest::Error),
    #[error(transparent)]
    Harness(#[from] HarnessError),
    #[error(transparent)]
    Runtime(#[from] AcpRuntimeError),
}

#[derive(Debug)]
pub struct AgentOperationFailure {
    error: AgentManagerError,
    indeterminate: bool,
}

impl AgentOperationFailure {
    fn definitive(error: AgentManagerError) -> Self {
        Self {
            error,
            indeterminate: false,
        }
    }

    fn indeterminate(error: AgentManagerError) -> Self {
        Self {
            error,
            indeterminate: true,
        }
    }

    pub fn is_indeterminate(&self) -> bool {
        self.indeterminate
    }

    #[cfg(test)]
    pub fn into_error(self) -> AgentManagerError {
        self.error
    }
}

impl std::fmt::Display for AgentOperationFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(formatter)
    }
}

impl std::error::Error for AgentOperationFailure {}

fn classify_runtime_operation_failure(error: AcpRuntimeError) -> AgentOperationFailure {
    let indeterminate = matches!(
        &error,
        AcpRuntimeError::Connection(_)
            | AcpRuntimeError::ConnectionTaskEnded
            | AcpRuntimeError::CommandResponseDropped
            | AcpRuntimeError::RequestTimeout
            | AcpRuntimeError::RequestCancelled
            | AcpRuntimeError::Interaction(InteractionError::Response(_)),
    );
    let error = AgentManagerError::Runtime(error);
    if indeterminate {
        AgentOperationFailure::indeterminate(error)
    } else {
        AgentOperationFailure::definitive(error)
    }
}

fn classify_harness_operation_failure(failure: HarnessOperationFailure) -> AgentOperationFailure {
    let indeterminate = failure.is_indeterminate();
    let error = AgentManagerError::Harness(failure.into_error());
    if indeterminate {
        AgentOperationFailure::indeterminate(error)
    } else {
        AgentOperationFailure::definitive(error)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalAgentManifest {
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    pub display_name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(flatten)]
    pub resolved: ResolvedAgentManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalAgentManifestSet {
    pub preferred_agent_id: AgentId,
    pub agents: Vec<LocalAgentManifest>,
}

impl LocalAgentManifestSet {
    pub fn parse(input: &str, approved_roots: &[PathBuf]) -> Result<Self, AgentManagerError> {
        let value: Self = serde_json::from_str(input)
            .map_err(|error| error.to_string())
            .map_err(AgentManagerError::InvalidManifestSet)?;
        value.validate(approved_roots)?;
        Ok(value)
    }

    pub fn load(path: &Path, approved_roots: &[PathBuf]) -> Result<Self, AgentManagerError> {
        let input = std::fs::read_to_string(path)
            .map_err(|error| error.to_string())
            .map_err(AgentManagerError::ManifestRead)?;
        Self::parse(&input, approved_roots)
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    fn validate(&self, approved_roots: &[PathBuf]) -> Result<(), AgentManagerError> {
        if self.agents.is_empty() || self.agents.len() > MAX_AGENTS {
            return Err(AgentManagerError::InvalidManifestSet(
                "agent count is outside the supported range".to_string(),
            ));
        }
        let mut ids = HashSet::new();
        let mut enabled = 0usize;
        for agent in &self.agents {
            if !ids.insert(agent.resolved.agent_id.clone()) {
                return Err(AgentManagerError::InvalidManifestSet(format!(
                    "duplicate agent ID: {}",
                    agent.resolved.agent_id,
                )));
            }
            if agent.enabled {
                enabled += 1;
                agent.resolved.validate(approved_roots).map_err(|error| {
                    AgentManagerError::InvalidManifestSet(format!(
                        "{}: {error}",
                        agent.resolved.agent_id,
                    ))
                })?;
            }
            if agent.display_name.trim().is_empty() || agent.display_name.len() > 256 {
                return Err(AgentManagerError::InvalidManifestSet(format!(
                    "invalid display name for {}",
                    agent.resolved.agent_id,
                )));
            }
            if !valid_agent_icon(agent.icon.as_deref())
                || agent.resolved.resolved_version.len() > 2_048
                || agent.resolved.provenance.len() > 2_048
            {
                return Err(AgentManagerError::InvalidManifestSet(format!(
                    "descriptor metadata is too large for {}",
                    agent.resolved.agent_id,
                )));
            }
        }
        if enabled == 0 {
            return Err(AgentManagerError::InvalidManifestSet(
                "at least one agent must be enabled".to_string(),
            ));
        }
        if !self
            .agents
            .iter()
            .any(|agent| agent.enabled && agent.resolved.agent_id == self.preferred_agent_id)
        {
            return Err(AgentManagerError::InvalidManifestSet(
                "preferred agent is missing or disabled".to_string(),
            ));
        }
        Ok(())
    }
}

fn valid_agent_icon(icon: Option<&str>) -> bool {
    let Some(icon) = icon else { return true };
    if icon.is_empty() || icon.len() > 2_048 {
        return false;
    }
    Url::parse(icon).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentLifecycle {
    Ready,
    Unavailable,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub session_list: bool,
    pub session_load: bool,
    pub session_resume: bool,
    pub session_steer: bool,
    pub session_fork: bool,
    pub session_delete: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDescriptor {
    pub agent_id: AgentId,
    pub display_name: String,
    pub icon: Option<String>,
    pub version: String,
    pub provenance: String,
    pub lifecycle: AgentLifecycle,
    pub last_error: Option<String>,
    pub capabilities: Option<AgentCapabilities>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSession {
    pub thread_id: String,
    pub agent_id: AgentId,
    pub cwd: PathBuf,
    pub parent_thread_id: Option<String>,
    pub snapshot: SessionSnapshot,
}

#[derive(Debug, Deserialize)]
struct OpenCodeSessionCatalogRow {
    id: String,
    title: Option<String>,
    updated: Option<u64>,
    created: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeChildSessionRow {
    id: String,
    title: Option<String>,
    #[serde(rename = "parentID")]
    parent_id: Option<String>,
}

/// A session that OpenCode reports as spawned by another session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HarnessChildSession {
    pub(crate) acp_session_id: String,
    pub(crate) title: Option<String>,
}

#[derive(Debug, Clone)]
struct OpenCodeSessionSummary {
    title: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessModelCatalogEntry {
    pub id: String,
    pub display_name: String,
    pub provider_id: String,
    pub provider_name: String,
    pub context_window: Option<u64>,
    pub reasoning_effort: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeModelCatalogDocument {
    id: String,
    #[serde(rename = "providerID")]
    provider_id: String,
    name: String,
    limit: Option<OpenCodeModelLimit>,
    capabilities: Option<OpenCodeModelCapabilities>,
    variants: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeModelLimit {
    context: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeModelCapabilities {
    reasoning: Option<bool>,
}

#[derive(Debug, Clone)]
struct OpenCodeRelatedSession {
    session_id: String,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeExportDocument {
    #[serde(default)]
    messages: Vec<OpenCodeExportMessage>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeExportMessage {
    info: OpenCodeExportMessageInfo,
    #[serde(default)]
    parts: Vec<OpenCodeExportPart>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeExportMessageInfo {
    id: String,
    role: String,
}

#[derive(Debug, Deserialize)]
struct OpenCodeExportPart {
    id: Option<String>,
    #[serde(rename = "type")]
    part_type: String,
    text: Option<String>,
    tool: Option<String>,
    state: Option<OpenCodeExportToolState>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeExportToolState {
    status: Option<String>,
    title: Option<String>,
    input: Option<OpenCodeExportToolInput>,
    output: Option<String>,
    error: Option<String>,
    metadata: Option<OpenCodeExportToolMetadata>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeExportToolInput {
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeExportToolMetadata {
    session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSessionPage {
    pub sessions: Vec<ManagedSession>,
    pub next_cursor: Option<String>,
    pub partial: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<SessionListDiagnostic>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionListDiagnostic {
    PageBudgetExhausted,
    MaxSessionsReached,
    NativeListFailed,
    EmptyPage,
    DuplicateOnlyPage,
    RepeatedCursor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetirementPlanReconciliation {
    Present,
    Absent,
    Indeterminate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionIndexEntry {
    agent_id: AgentId,
    acp_session_id: String,
    cwd: PathBuf,
    #[serde(default)]
    approval_policy: ApprovalPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_acp_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    forked_from_acp_session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionIndexFile {
    version: u64,
    sessions: Vec<SessionIndexEntry>,
}

struct DurableSessionIndex {
    path: Option<PathBuf>,
    entries: Vec<SessionIndexEntry>,
    #[cfg(test)]
    fail_writes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentMessageJournalEntry {
    thread_id: String,
    observed_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    after_timeline_id: Option<String>,
    message: crate::agent_messaging::AgentMessageOrigin,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentMessageJournalFile {
    version: u64,
    entries: Vec<AgentMessageJournalEntry>,
}

struct DurableAgentMessageJournal {
    path: Option<PathBuf>,
    entries: Vec<AgentMessageJournalEntry>,
}

impl DurableAgentMessageJournal {
    async fn load(path: Option<PathBuf>) -> Self {
        let Some(path) = path else {
            return Self {
                path: None,
                entries: Vec::new(),
            };
        };
        let mut entries = match tokio::fs::read(&path).await {
            Ok(bytes) if bytes.len() <= MAX_AGENT_MESSAGE_JOURNAL_BYTES => {
                serde_json::from_slice::<AgentMessageJournalFile>(&bytes)
                    .ok()
                    .filter(|journal| journal.version == AGENT_MESSAGE_JOURNAL_VERSION)
                    .map(|journal| sanitize_agent_message_journal(journal.entries))
                    .unwrap_or_default()
            }
            Ok(_) => {
                eprintln!("agent-message journal exceeded its size limit; ignoring it");
                Vec::new()
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                eprintln!("failed to load agent-message journal: {error}");
                Vec::new()
            }
        };
        let reconciled_in_flight_entries = entries.iter_mut().fold(false, |reconciled, entry| {
            if matches!(
                entry.message.disposition,
                crate::agent_messaging::AgentMessageDisposition::Queued
                    | crate::agent_messaging::AgentMessageDisposition::Steering,
            ) {
                entry.message.disposition =
                    crate::agent_messaging::AgentMessageDisposition::Cancelled;
                true
            } else {
                reconciled
            }
        });
        let mut journal = Self {
            path: Some(path),
            entries,
        };
        if reconciled_in_flight_entries {
            let staged = journal.entries.clone();
            if let Err(error) = journal.persist(staged).await {
                eprintln!(
                    "failed to reconcile queued agent-message activities after restart: {error}",
                );
            }
        }
        journal
    }

    #[cfg(test)]
    async fn upsert(
        &mut self,
        thread_id: &str,
        message: crate::agent_messaging::AgentMessageOrigin,
    ) -> Result<(), AgentManagerError> {
        self.upsert_many(vec![(thread_id.to_string(), None, message)])
            .await
    }

    async fn upsert_many(
        &mut self,
        messages: Vec<(
            String,
            Option<String>,
            crate::agent_messaging::AgentMessageOrigin,
        )>,
    ) -> Result<(), AgentManagerError> {
        let mut staged = self.entries.clone();
        for (thread_id, after_timeline_id, message) in messages {
            let existing = staged
                .iter()
                .position(|entry| {
                    entry.thread_id == thread_id && entry.message.message_id == message.message_id
                })
                .map(|index| staged.remove(index));
            staged.push(AgentMessageJournalEntry {
                thread_id,
                observed_at_ms: existing
                    .as_ref()
                    .map(|entry| entry.observed_at_ms)
                    .unwrap_or_else(|| Utc::now().timestamp_millis().max(0).unsigned_abs()),
                after_timeline_id: existing
                    .and_then(|entry| entry.after_timeline_id)
                    .or(after_timeline_id),
                message,
            });
        }
        while staged.len() > MAX_AGENT_MESSAGE_JOURNAL_ENTRIES {
            staged.remove(0);
        }
        while staged.len() > 1
            && agent_message_journal_bytes(&staged)
                .is_none_or(|bytes| bytes.len() > MAX_AGENT_MESSAGE_JOURNAL_BYTES)
        {
            staged.remove(0);
        }
        self.persist(staged).await
    }

    async fn remove_threads(&mut self, thread_ids: &[String]) -> Result<(), AgentManagerError> {
        let staged = self
            .entries
            .iter()
            .filter(|entry| !thread_ids.contains(&entry.thread_id))
            .cloned()
            .collect::<Vec<_>>();
        if staged.len() == self.entries.len() {
            return Ok(());
        }
        self.persist(staged).await
    }

    async fn remove_message(&mut self, message_id: &str) -> Result<(), AgentManagerError> {
        let staged = self
            .entries
            .iter()
            .filter(|entry| entry.message.message_id != message_id)
            .cloned()
            .collect::<Vec<_>>();
        if staged.len() == self.entries.len() {
            return Ok(());
        }
        self.persist(staged).await
    }

    async fn update_disposition(
        &mut self,
        message_id: &str,
        disposition: crate::agent_messaging::AgentMessageDisposition,
    ) -> Result<Vec<(String, crate::agent_messaging::AgentMessageOrigin)>, AgentManagerError> {
        let mut staged = self.entries.clone();
        let mut updates = Vec::new();
        for entry in &mut staged {
            let current = entry.message.disposition;
            let terminal_downgrade = matches!(
                current,
                crate::agent_messaging::AgentMessageDisposition::Sent,
            ) && !matches!(
                disposition,
                crate::agent_messaging::AgentMessageDisposition::Sent,
            );
            let cancelled_reactivation = matches!(
                current,
                crate::agent_messaging::AgentMessageDisposition::Cancelled,
            ) && !matches!(
                disposition,
                crate::agent_messaging::AgentMessageDisposition::Cancelled
                    | crate::agent_messaging::AgentMessageDisposition::Sent,
            );
            if entry.message.message_id == message_id
                && current != disposition
                && !terminal_downgrade
                && !cancelled_reactivation
            {
                entry.message.disposition = disposition;
                updates.push((entry.thread_id.clone(), entry.message.clone()));
            }
        }
        if updates.is_empty() {
            return Ok(updates);
        }
        self.persist(staged).await?;
        Ok(updates)
    }

    fn entries_for_thread(&self, thread_id: &str) -> Vec<AgentMessageJournalEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.thread_id == thread_id)
            .cloned()
            .collect()
    }

    fn messages_for_id(
        &self,
        message_id: &str,
    ) -> Vec<(String, crate::agent_messaging::AgentMessageOrigin)> {
        self.entries
            .iter()
            .filter(|entry| entry.message.message_id == message_id)
            .map(|entry| (entry.thread_id.clone(), entry.message.clone()))
            .collect()
    }

    async fn persist(
        &mut self,
        staged: Vec<AgentMessageJournalEntry>,
    ) -> Result<(), AgentManagerError> {
        let Some(path) = &self.path else {
            self.entries = staged;
            return Ok(());
        };
        let bytes = agent_message_journal_bytes(&staged).ok_or_else(|| {
            AgentManagerError::AgentMessaging(
                "failed to serialize the agent-message journal".to_string(),
            )
        })?;
        if bytes.len() > MAX_AGENT_MESSAGE_JOURNAL_BYTES {
            return Err(AgentManagerError::AgentMessaging(format!(
                "agent-message journal exceeds {MAX_AGENT_MESSAGE_JOURNAL_BYTES} bytes",
            )));
        }
        atomic_write_private(path, &bytes)
            .await
            .map_err(|error| error.to_string())
            .map_err(AgentManagerError::AgentMessaging)?;
        self.entries = staged;
        Ok(())
    }
}

fn agent_message_journal_bytes(entries: &[AgentMessageJournalEntry]) -> Option<Vec<u8>> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AgentMessageJournalFileRef<'a> {
        version: u64,
        entries: &'a [AgentMessageJournalEntry],
    }

    serde_json::to_vec(&AgentMessageJournalFileRef {
        version: AGENT_MESSAGE_JOURNAL_VERSION,
        entries,
    })
    .ok()
}

fn sanitize_agent_message_journal(
    entries: Vec<AgentMessageJournalEntry>,
) -> Vec<AgentMessageJournalEntry> {
    let mut sanitized = entries
        .into_iter()
        .filter(|entry| {
            AgentSessionId::decode(&entry.thread_id).is_ok()
                && AgentSessionId::decode(&entry.message.related_thread_id).is_ok()
                && !entry.message.message_id.is_empty()
                && entry.message.message_id.len() <= MAX_AGENT_MESSAGE_ID_BYTES
                && entry.after_timeline_id.as_ref().is_none_or(|anchor| {
                    !anchor.is_empty() && anchor.len() <= MAX_AGENT_MESSAGE_ANCHOR_BYTES
                })
                && !entry.message.body.is_empty()
                && entry.message.body.len() <= MAX_AGENT_MESSAGE_BODY_BYTES
                && entry
                    .message
                    .related_title
                    .as_ref()
                    .is_none_or(|title| valid_session_title(title))
        })
        .collect::<Vec<_>>();
    sanitized.sort_by_key(|entry| entry.observed_at_ms);
    sanitized.reverse();
    let mut seen = HashSet::new();
    sanitized
        .retain(|entry| seen.insert((entry.thread_id.clone(), entry.message.message_id.clone())));
    sanitized.reverse();
    if sanitized.len() > MAX_AGENT_MESSAGE_JOURNAL_ENTRIES {
        sanitized.drain(0..sanitized.len() - MAX_AGENT_MESSAGE_JOURNAL_ENTRIES);
    }
    while sanitized.len() > 1
        && agent_message_journal_bytes(&sanitized)
            .is_none_or(|bytes| bytes.len() > MAX_AGENT_MESSAGE_JOURNAL_BYTES)
    {
        sanitized.remove(0);
    }
    sanitized
}

impl DurableSessionIndex {
    async fn load(path: Option<PathBuf>) -> Self {
        let Some(path) = path else {
            return Self {
                path: None,
                entries: Vec::new(),
                #[cfg(test)]
                fail_writes: false,
            };
        };
        let entries = match tokio::fs::read(&path).await {
            Ok(bytes) if bytes.len() <= MAX_SESSION_INDEX_BYTES => {
                serde_json::from_slice::<SessionIndexFile>(&bytes)
                    .ok()
                    .filter(|index| index.version == SESSION_INDEX_VERSION)
                    .map(|index| sanitize_index_entries(index.sessions))
                    .unwrap_or_default()
            }
            Ok(_) => {
                eprintln!("ACP session index exceeded its size limit; ignoring it");
                Vec::new()
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                eprintln!("failed to load ACP session index: {error}");
                Vec::new()
            }
        };
        Self {
            path: Some(path),
            entries,
            #[cfg(test)]
            fail_writes: false,
        }
    }

    async fn insert_all(
        &mut self,
        entries: impl IntoIterator<Item = SessionIndexEntry>,
    ) -> Result<(), AgentManagerError> {
        self.insert_entries(entries.into_iter().collect()).await
    }

    async fn insert_entries(
        &mut self,
        entries: Vec<SessionIndexEntry>,
    ) -> Result<(), AgentManagerError> {
        self.merge_entries(entries, false).await
    }

    async fn insert_inherited_entries(
        &mut self,
        entries: Vec<SessionIndexEntry>,
    ) -> Result<(), AgentManagerError> {
        self.merge_entries(entries, true).await
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn merge_entries(
        &mut self,
        entries: Vec<SessionIndexEntry>,
        replace_approval_policy: bool,
    ) -> Result<(), AgentManagerError> {
        let mut staged = self.entries.clone();
        let mut changed = false;
        for entry in entries {
            if let Some(existing) = staged.iter_mut().find(|existing| {
                existing.agent_id == entry.agent_id
                    && existing.acp_session_id == entry.acp_session_id
            }) {
                let mut merged = entry;
                if merged.title.is_none() {
                    merged.title = existing.title.clone();
                }
                if existing.parent_acp_session_id.is_some()
                    || merged.parent_acp_session_id.is_none()
                {
                    merged.parent_acp_session_id = existing.parent_acp_session_id.clone();
                }
                if merged.forked_from_acp_session_id.is_none() {
                    merged.forked_from_acp_session_id = existing.forked_from_acp_session_id.clone();
                }
                if !replace_approval_policy {
                    merged.approval_policy = existing.approval_policy;
                }
                if *existing != merged {
                    *existing = merged;
                    changed = true;
                }
            } else {
                staged.push(entry);
                changed = true;
            }
        }
        if !changed {
            return Ok(());
        }
        staged.sort();
        if staged.len() > MAX_SESSIONS {
            staged.drain(0..staged.len() - MAX_SESSIONS);
        }
        self.persist(staged).await
    }

    #[cfg(test)]
    async fn set_approval_policy(
        &mut self,
        identity: &AgentSessionId,
        policy: ApprovalPolicy,
    ) -> Result<(), AgentManagerError> {
        self.set_approval_policies(&[(identity.clone(), policy)])
            .await
    }

    async fn set_approval_policies(
        &mut self,
        updates: &[(AgentSessionId, ApprovalPolicy)],
    ) -> Result<(), AgentManagerError> {
        self.update_approval_policies(updates, true).await
    }

    async fn set_existing_approval_policies(
        &mut self,
        updates: &[(AgentSessionId, ApprovalPolicy)],
    ) -> Result<(), AgentManagerError> {
        self.update_approval_policies(updates, false).await
    }

    async fn update_approval_policies(
        &mut self,
        updates: &[(AgentSessionId, ApprovalPolicy)],
        require_all: bool,
    ) -> Result<(), AgentManagerError> {
        let mut staged = self.entries.clone();
        let mut changed = false;
        for (identity, policy) in updates {
            let Some(entry) = staged.iter_mut().find(|entry| {
                entry.agent_id == identity.agent_id
                    && entry.acp_session_id == identity.acp_session_id
            }) else {
                if require_all {
                    return Err(AgentManagerError::SessionIndex(
                        "session is not indexed".to_string(),
                    ));
                }
                continue;
            };
            if entry.approval_policy != *policy {
                entry.approval_policy = *policy;
                changed = true;
            }
        }
        if !changed {
            return Ok(());
        }
        self.persist(staged).await
    }

    async fn remove_all(&mut self, identities: &[AgentSessionId]) -> Result<(), AgentManagerError> {
        let staged = self
            .entries
            .iter()
            .filter(|entry| {
                !identities.iter().any(|identity| {
                    entry.agent_id == identity.agent_id
                        && entry.acp_session_id == identity.acp_session_id
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        if staged.len() == self.entries.len() {
            return Ok(());
        }
        self.persist(staged).await
    }

    async fn persist(&mut self, staged: Vec<SessionIndexEntry>) -> Result<(), AgentManagerError> {
        let Some(path) = &self.path else {
            self.entries = staged;
            return Ok(());
        };
        let bytes = serde_json::to_vec(&SessionIndexFile {
            version: SESSION_INDEX_VERSION,
            sessions: staged.clone(),
        })
        .map_err(|error| error.to_string())
        .map_err(AgentManagerError::SessionIndex)?;
        #[cfg(test)]
        if self.fail_writes {
            return Err(AgentManagerError::SessionIndex(
                "injected session index write failure".to_string(),
            ));
        }
        atomic_write_private(path, &bytes)
            .await
            .map_err(|error| error.to_string())
            .map_err(AgentManagerError::SessionIndex)?;
        self.entries = staged;
        Ok(())
    }
}

fn sanitize_index_entries(entries: Vec<SessionIndexEntry>) -> Vec<SessionIndexEntry> {
    let mut entries = entries
        .into_iter()
        .filter(|entry| {
            AgentSessionId::new(&entry.agent_id, &entry.acp_session_id).is_ok()
                && entry.cwd.is_absolute()
                && entry.cwd.as_os_str().len() <= MAX_SESSION_CWD_BYTES
                && entry
                    .title
                    .as_ref()
                    .is_none_or(|title| valid_session_title(title))
                && entry.parent_acp_session_id.as_ref().is_none_or(|parent| {
                    parent != &entry.acp_session_id
                        && AgentSessionId::new(&entry.agent_id, parent).is_ok()
                })
                && entry
                    .forked_from_acp_session_id
                    .as_ref()
                    .is_none_or(|source| {
                        source != &entry.acp_session_id
                            && AgentSessionId::new(&entry.agent_id, source).is_ok()
                    })
        })
        .collect::<Vec<_>>();
    entries.sort();
    entries.dedup_by(|left, right| {
        left.agent_id == right.agent_id && left.acp_session_id == right.acp_session_id
    });
    entries.truncate(MAX_SESSIONS);
    entries
}

fn index_entry(identity: AgentSessionId, cwd: PathBuf) -> SessionIndexEntry {
    index_entry_with_policy(identity, cwd, ApprovalPolicy::Untrusted)
}

fn index_entry_with_policy(
    identity: AgentSessionId,
    cwd: PathBuf,
    approval_policy: ApprovalPolicy,
) -> SessionIndexEntry {
    SessionIndexEntry {
        agent_id: identity.agent_id,
        acp_session_id: identity.acp_session_id,
        cwd,
        approval_policy,
        title: None,
        parent_acp_session_id: None,
        forked_from_acp_session_id: None,
    }
}

fn empty_managed_session(identity: &AgentSessionId, cwd: PathBuf) -> ManagedSession {
    let thread_id = identity.encode();
    ManagedSession {
        thread_id: thread_id.clone(),
        agent_id: identity.agent_id.clone(),
        cwd,
        parent_thread_id: None,
        snapshot: SessionSnapshot::new(identity.agent_id.clone(), thread_id),
    }
}

fn listed_managed_session(
    identity: &AgentSessionId,
    cwd: PathBuf,
    title: Option<String>,
    updated_at: Option<String>,
) -> ManagedSession {
    let thread_id = identity.encode();
    let mut snapshot = SessionSnapshot::new(identity.agent_id.clone(), thread_id.clone());
    snapshot.apply(&CanonicalEvent::SessionInfo {
        agent_id: identity.agent_id.clone(),
        thread_id: thread_id.clone(),
        title: title.map_or(FieldUpdate::Unchanged, FieldUpdate::Set),
        updated_at: updated_at.map_or(FieldUpdate::Unchanged, FieldUpdate::Set),
    });
    ManagedSession {
        thread_id,
        agent_id: identity.agent_id.clone(),
        cwd,
        parent_thread_id: None,
        snapshot,
    }
}

fn add_durable_sessions(
    sessions: &mut BTreeMap<String, ManagedSession>,
    durable: &[SessionIndexEntry],
    agent_id: &str,
) {
    for entry in durable.iter().filter(|entry| entry.agent_id == agent_id) {
        if let Ok(identity) = AgentSessionId::new(&entry.agent_id, &entry.acp_session_id) {
            let session = sessions
                .entry(identity.encode())
                .or_insert_with(|| empty_managed_session(&identity, entry.cwd.clone()));
            if let Some(title) = &entry.title {
                session.snapshot.title = Some(title.clone());
            }
            session.parent_thread_id = parent_thread_id(entry);
        }
    }
}

struct AgentRuntime {
    manifest: LocalAgentManifest,
    connection: Option<AcpConnection>,
    negotiated: Option<NegotiatedInitialize>,
    lifecycle: AgentLifecycle,
    last_error: Option<String>,
    /// Base URL of the agent's own HTTP server, when the bridge was able to place it.
    http_base: Option<String>,
    harness: Option<Arc<dyn HarnessAdapter>>,
}

#[derive(Debug, Clone)]
struct SubagentGenerationState {
    parent_thread_id: String,
    tool_call_id: String,
    observed_generation: Option<u64>,
    minimum_generation: Option<u64>,
    armed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcceptedSubagentTerminal {
    pub(crate) parent_thread_id: String,
    pub(crate) tool_call_id: String,
}

const MAX_TRACKED_SUBAGENT_GENERATIONS: usize = 2048;

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
pub struct AgentManager {
    agents: HashMap<AgentId, AgentRuntime>,
    preferred_agent_id: AgentId,
    tracked_sessions: Arc<Mutex<HashMap<String, Uuid>>>,
    session_index: Arc<Mutex<DurableSessionIndex>>,
    agent_message_journal: Mutex<DurableAgentMessageJournal>,
    pending_durable_sessions: Mutex<HashMap<String, SessionIndexEntry>>,
    reconstruction_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    subagent_generations: Mutex<HashMap<String, SubagentGenerationState>>,
    workspace_root: PathBuf,
    allow_outside_root_cwd: bool,
    events: CanonicalEventSender,
    event_receiver: Mutex<Option<CanonicalEventReceiver>>,
    agent_messaging: OnceLock<AgentMessagingMcpConfig>,
    stopped: AtomicBool,
    http: reqwest::Client,
    #[cfg(test)]
    policy_snapshot_barrier: Mutex<Option<tests::PolicySnapshotBarrier>>,
}

pub(crate) struct PreparedSessionDeletion<'a> {
    manager: &'a AgentManager,
    identity: AgentSessionId,
    session_id: SessionId,
    connection: AcpConnection,
    native_delete: bool,
    affected: Vec<AgentSessionId>,
    operations: Vec<tokio::sync::OwnedMutexGuard<()>>,
}

impl PreparedSessionDeletion<'_> {
    pub(crate) fn affected_thread_ids(&self) -> Vec<String> {
        self.affected.iter().map(AgentSessionId::encode).collect()
    }

    pub(crate) async fn abort(self) {
        let Self {
            manager,
            affected,
            operations,
            ..
        } = self;
        drop(operations);
        for identity in affected {
            manager
                .prune_session_operation_lock(&identity.encode())
                .await;
        }
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
    pub(crate) async fn execute(self) -> Result<Vec<String>, AgentManagerError> {
        let Self {
            manager,
            identity,
            session_id,
            connection,
            native_delete,
            affected,
            operations,
        } = self;
        for affected_identity in &affected {
            let affected_session_id = SessionId::new(affected_identity.acp_session_id.clone());
            if let Some(session) = connection.session(&affected_session_id).await {
                if session.snapshot().await.active_run_id.is_some() {
                    let _ = connection.cancel(affected_session_id).await;
                }
            }
        }
        if native_delete {
            connection
                .delete_session(DeleteSessionRequest::new(session_id))
                .await?;
        } else {
            if connection.negotiated().supports_session_close() {
                for affected_identity in &affected {
                    connection
                        .close_session(CloseSessionRequest::new(
                            affected_identity.acp_session_id.clone(),
                        ))
                        .await?;
                }
            }
            let (harness, context) = manager
                .harness_session_context(&identity, session_id.clone())
                .await?;
            harness
                .delete(
                    &context,
                    HarnessDeleteRequest {
                        affected_session_ids: affected
                            .iter()
                            .map(|identity| identity.acp_session_id.clone())
                            .collect(),
                    },
                )
                .await?;
            for affected_identity in &affected {
                connection
                    .evict_session(&SessionId::new(affected_identity.acp_session_id.clone()))
                    .await;
            }
        }
        manager
            .session_index
            .lock()
            .await
            .remove_all(&affected)
            .await?;
        let deleted_thread_ids = affected
            .iter()
            .map(AgentSessionId::encode)
            .collect::<Vec<_>>();
        for deleted_thread_id in &deleted_thread_ids {
            manager
                .pending_durable_sessions
                .lock()
                .await
                .remove(deleted_thread_id);
            manager
                .tracked_sessions
                .lock()
                .await
                .remove(deleted_thread_id);
            manager
                .subagent_generations
                .lock()
                .await
                .remove(deleted_thread_id);
        }
        drop(operations);
        for deleted_thread_id in &deleted_thread_ids {
            manager
                .prune_session_operation_lock(deleted_thread_id)
                .await;
        }
        if let Some(config) = manager.agent_messaging.get() {
            config.revoke_threads(deleted_thread_ids.iter().map(String::as_str));
        }
        if let Err(error) = manager
            .agent_message_journal
            .lock()
            .await
            .remove_threads(&deleted_thread_ids)
            .await
        {
            eprintln!("failed to prune deleted sessions from the agent-message journal: {error}");
        }
        Ok(deleted_thread_ids)
    }
}

impl AgentManager {
    pub async fn start(
        manifests: LocalAgentManifestSet,
        approved_roots: &[PathBuf],
        host_environment: &BTreeMap<String, String>,
        initialize_timeout: Duration,
        storage_root: &Path,
        state_dir: &Path,
        allow_outside_root_cwd: bool,
    ) -> Result<Self, AgentManagerError> {
        manifests.validate(approved_roots)?;
        let preferred_agent_id = manifests.preferred_agent_id.clone();
        let mut results = Vec::new();
        let mut http_bases = Vec::new();
        for manifest in manifests.agents.into_iter().filter(|agent| agent.enabled) {
            let (result, http_base) = Self::start_agent(
                &manifest.resolved,
                approved_roots,
                host_environment,
                initialize_timeout,
            )
            .await;
            if let Some(http_base) = http_base {
                http_bases.push((manifest.resolved.agent_id.clone(), http_base));
            }
            results.push((manifest, result));
        }
        let storage_dir = state_dir.to_path_buf();
        tokio::fs::create_dir_all(&storage_dir)
            .await
            .map_err(|error| error.to_string())
            .map_err(AgentManagerError::SessionIndex)?;
        let mut manager = Self::from_start_results_with_index(
            preferred_agent_id,
            results,
            Some(storage_dir.join(SESSION_INDEX_FILE)),
            storage_root.to_path_buf(),
            allow_outside_root_cwd,
        )
        .await?;
        for (agent_id, http_base) in http_bases {
            if let Some(runtime) = manager.agents.get_mut(&agent_id) {
                runtime.http_base = Some(http_base);
            }
        }
        Ok(manager)
    }

    /// Starts one agent with any launch configuration supplied by its verified harness adapter.
    ///
    /// Adapter launch configuration is opportunistic. If the configured start fails, the manager
    /// retries ordinary ACP startup so optional harness integration cannot make the agent unusable.
    async fn start_agent(
        manifest: &ResolvedAgentManifest,
        approved_roots: &[PathBuf],
        host_environment: &BTreeMap<String, String>,
        initialize_timeout: Duration,
    ) -> (
        Result<(AcpConnection, NegotiatedInitialize), AcpRuntimeError>,
        Option<String>,
    ) {
        if let Some(launch) =
            harness_for_manifest(manifest).and_then(|harness| harness.launch_config())
        {
            let result = AcpConnection::start(
                manifest,
                approved_roots,
                host_environment,
                initialize_timeout,
                &launch.extra_args,
                &launch.extra_environment,
            )
            .await;
            if result.is_ok() {
                return (result, Some(launch.http_base));
            }
        }
        (
            AcpConnection::start(
                manifest,
                approved_roots,
                host_environment,
                initialize_timeout,
                &[],
                &BTreeMap::new(),
            )
            .await,
            None,
        )
    }

    #[cfg(test)]
    async fn from_start_results(
        preferred_agent_id: AgentId,
        results: Vec<AgentStartResult>,
    ) -> Result<Self, AgentManagerError> {
        Self::from_start_results_with_index(
            preferred_agent_id,
            results,
            None,
            std::env::temp_dir(),
            true,
        )
        .await
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_nesting,
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn from_start_results_with_index(
        preferred_agent_id: AgentId,
        results: Vec<AgentStartResult>,
        session_index_path: Option<PathBuf>,
        workspace_root: PathBuf,
        allow_outside_root_cwd: bool,
    ) -> Result<Self, AgentManagerError> {
        let workspace_root = std::fs::canonicalize(&workspace_root).map_err(|error| {
            AgentManagerError::SessionIndex(format!(
                "session workspace root is invalid or inaccessible ({}): {error}",
                workspace_root.to_string_lossy(),
            ))
        })?;
        if let Some((_, Err(error))) = results
            .iter()
            .find(|(manifest, _)| manifest.resolved.agent_id == preferred_agent_id)
        {
            for (_, result) in &results {
                if let Ok((connection, _)) = result {
                    if connection.shutdown().await.is_err() {
                        eprintln!("ACP agent shutdown failed (details redacted)");
                    }
                }
            }
            return Err(AgentManagerError::PreferredStart(redact_error(error)));
        }
        let mut agents = HashMap::new();
        for (manifest, result) in results {
            let agent_id = manifest.resolved.agent_id.clone();
            let harness = harness_for_manifest(&manifest.resolved);
            match result {
                Ok((connection, negotiated)) => {
                    agents.insert(
                        agent_id,
                        AgentRuntime {
                            manifest,
                            connection: Some(connection),
                            negotiated: Some(negotiated),
                            lifecycle: AgentLifecycle::Ready,
                            last_error: None,
                            http_base: None,
                            harness,
                        },
                    );
                }
                Err(error) => {
                    agents.insert(
                        agent_id,
                        AgentRuntime {
                            manifest,
                            connection: None,
                            negotiated: None,
                            lifecycle: AgentLifecycle::Unavailable,
                            last_error: Some(redact_error(&error)),
                            http_base: None,
                            harness,
                        },
                    );
                }
            }
        }
        let (events, event_receiver) = canonical_event_channel(1_024);
        let agent_message_journal_path = session_index_path
            .as_ref()
            .map(|path| path.with_file_name(AGENT_MESSAGE_JOURNAL_FILE));
        let session_index = DurableSessionIndex::load(session_index_path).await;
        let agent_message_journal =
            DurableAgentMessageJournal::load(agent_message_journal_path).await;
        Ok(Self {
            agents,
            preferred_agent_id,
            tracked_sessions: Arc::new(Mutex::new(HashMap::new())),
            session_index: Arc::new(Mutex::new(session_index)),
            agent_message_journal: Mutex::new(agent_message_journal),
            pending_durable_sessions: Mutex::new(HashMap::new()),
            reconstruction_locks: Mutex::new(HashMap::new()),
            subagent_generations: Mutex::new(HashMap::new()),
            workspace_root,
            allow_outside_root_cwd,
            events,
            event_receiver: Mutex::new(Some(event_receiver)),
            agent_messaging: OnceLock::new(),
            stopped: AtomicBool::new(false),
            // Loopback only: the agent's HTTP server is never reached through a proxy.
            http: crate::tls::http_client_builder()
                .no_proxy()
                .build()
                .map_err(AgentManagerError::HttpClient)?,
            #[cfg(test)]
            policy_snapshot_barrier: Mutex::new(None),
        })
    }

    #[cfg(test)]
    async fn pause_next_policy_snapshot(&self) -> tests::PolicySnapshotBarrier {
        let barrier = tests::PolicySnapshotBarrier {
            reached: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
        };
        *self.policy_snapshot_barrier.lock().await = Some(barrier.clone());
        barrier
    }

    pub fn preferred_agent_id(&self) -> &str {
        &self.preferred_agent_id
    }

    pub(crate) fn attach_agent_messaging(
        &self,
        config: AgentMessagingMcpConfig,
    ) -> Result<(), AgentManagerError> {
        self.agent_messaging.set(config).map_err(|_| {
            AgentManagerError::AgentMessaging(
                "shared agent messaging MCP service is already attached".to_string(),
            )
        })
    }

    fn append_agent_messaging_server(
        &self,
        agent_id: &str,
        mcp_servers: &mut Vec<McpServer>,
    ) -> Result<Option<PendingMcpCredential>, AgentManagerError> {
        let Some(config) = self.agent_messaging.get() else {
            return Ok(None);
        };
        let runtime = self
            .agents
            .get(agent_id)
            .ok_or_else(|| AgentManagerError::UnknownAgent(agent_id.to_string()))?;
        let preference = runtime
            .negotiated
            .as_ref()
            .map(NegotiatedInitialize::mcp_transport_preference)
            .unwrap_or_default();
        if preference == super::runtime::McpTransportPreference::Unavailable {
            return Ok(None);
        }
        let credential = match config.stage_credential(agent_id) {
            Ok(credential) => credential,
            Err(McpCredentialError::LimitReached) => return Ok(None),
            Err(error) => {
                return Err(AgentManagerError::AgentMessaging(error.to_string()));
            }
        };
        let descriptor = config.descriptor(preference, &credential).ok_or_else(|| {
            AgentManagerError::AgentMessaging(
                "eligible agent did not resolve to an MCP transport".to_string(),
            )
        })?;
        mcp_servers.push(descriptor);
        Ok(Some(credential))
    }

    fn activate_agent_messaging_credential(
        &self,
        credential: Option<PendingMcpCredential>,
        thread_id: &str,
    ) -> Result<(), AgentManagerError> {
        let Some(credential) = credential else {
            return Ok(());
        };
        self.agent_messaging
            .get()
            .ok_or_else(|| {
                AgentManagerError::AgentMessaging(
                    "shared agent messaging MCP service was detached".to_string(),
                )
            })?
            .activate_credential(credential, thread_id)
            .map_err(|error| error.to_string())
            .map_err(AgentManagerError::AgentMessaging)
    }

    pub fn list_agents(&self) -> Vec<AgentDescriptor> {
        let mut descriptors = self
            .agents
            .values()
            .map(|runtime| {
                let failed = runtime
                    .connection
                    .as_ref()
                    .and_then(AcpConnection::failure_message)
                    .is_some();
                AgentDescriptor {
                    agent_id: runtime.manifest.resolved.agent_id.clone(),
                    display_name: runtime.manifest.display_name.clone(),
                    icon: runtime.manifest.icon.clone(),
                    version: runtime.manifest.resolved.resolved_version.clone(),
                    provenance: runtime.manifest.resolved.provenance.clone(),
                    lifecycle: if self.stopped.load(Ordering::SeqCst) {
                        AgentLifecycle::Stopped
                    } else if failed {
                        AgentLifecycle::Unavailable
                    } else {
                        runtime.lifecycle.clone()
                    },
                    last_error: if failed {
                        Some("ACP agent connection failed (details redacted)".to_string())
                    } else {
                        runtime.last_error.clone()
                    },
                    capabilities: runtime.negotiated.as_ref().map(|_| capabilities(runtime)),
                }
            })
            .collect::<Vec<_>>();
        descriptors.sort_by(|left, right| left.agent_id.cmp(&right.agent_id));
        descriptors
    }

    pub async fn harness_model_catalog(
        &self,
        agent_id: Option<&str>,
    ) -> Vec<HarnessModelCatalogEntry> {
        let Some(runtime) = agent_id
            .and_then(|agent_id| self.agents.get(agent_id))
            .or_else(|| self.agents.get(&self.preferred_agent_id))
        else {
            return Vec::new();
        };
        if runtime.harness.is_none() {
            return Vec::new();
        }
        let mut command = AsyncCommand::new(&runtime.manifest.resolved.executable);
        command
            .args(["models", "--verbose"])
            .current_dir(&self.workspace_root)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for name in ["PATH", "HOME", "TMPDIR", "LANG", "XDG_CONFIG_HOME"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let Ok(child) = command.spawn() else {
            return Vec::new();
        };
        let Ok(Ok(output)) =
            tokio::time::timeout(OPENCODE_MODEL_CATALOG_TIMEOUT, child.wait_with_output()).await
        else {
            return Vec::new();
        };
        if !output.status.success() || output.stdout.len() > MAX_OPENCODE_MODEL_CATALOG_BYTES {
            return Vec::new();
        }
        parse_opencode_model_catalog(&output.stdout)
    }

    pub async fn take_events(&self) -> Option<CanonicalEventReceiver> {
        self.event_receiver.lock().await.take()
    }

    #[cfg(test)]
    pub async fn new_session(
        &self,
        agent_id: &str,
        request: NewSessionRequest,
    ) -> Result<ManagedSession, AgentManagerError> {
        self.new_session_with_cancellation(agent_id, request, RequestCancellation::default())
            .await
    }

    #[cfg(test)]
    pub async fn new_session_with_cancellation(
        &self,
        agent_id: &str,
        request: NewSessionRequest,
        cancellation: RequestCancellation,
    ) -> Result<ManagedSession, AgentManagerError> {
        self.new_session_with_cancellation_outcome(agent_id, request, cancellation)
            .await
            .map_err(AgentOperationFailure::into_error)
    }

    #[cfg(test)]
    pub async fn new_session_with_cancellation_outcome(
        &self,
        agent_id: &str,
        request: NewSessionRequest,
        cancellation: RequestCancellation,
    ) -> Result<ManagedSession, AgentOperationFailure> {
        self.new_session_with_policy_outcome(
            agent_id,
            request,
            ApprovalPolicy::Untrusted,
            cancellation,
        )
        .await
    }

    pub async fn new_session_with_policy_outcome(
        &self,
        agent_id: &str,
        mut request: NewSessionRequest,
        approval_policy: ApprovalPolicy,
        cancellation: RequestCancellation,
    ) -> Result<ManagedSession, AgentOperationFailure> {
        let cwd = self
            .validate_cwd(&request.cwd)
            .map_err(AgentOperationFailure::definitive)?;
        request.cwd = cwd.clone();
        let connection = self
            .connection(agent_id)
            .map_err(AgentOperationFailure::definitive)?;
        let credential = self
            .append_agent_messaging_server(agent_id, &mut request.mcp_servers)
            .map_err(AgentOperationFailure::definitive)?;
        let response = connection
            .new_session_with_cancellation(request, cancellation)
            .await
            .map_err(classify_runtime_operation_failure)?;
        let session_id = response.session_id.clone();
        let identity = AgentSessionId::new(agent_id, session_id.to_string()).map_err(|_| {
            AgentOperationFailure::indeterminate(AgentManagerError::InvalidThreadId)
        })?;
        connection
            .set_approval_policy(&session_id, approval_policy)
            .await
            .map_err(|error| error.into())
            .map_err(AgentOperationFailure::indeterminate)?;
        self.track_session_with_policy(identity, cwd, approval_policy)
            .await
            .map_err(AgentOperationFailure::indeterminate)?;
        self.apply_config_options(connection, &session_id, response.config_options)
            .await
            .map_err(AgentOperationFailure::indeterminate)?;
        let managed = self
            .read_known_session(agent_id, &session_id)
            .await
            .map_err(AgentOperationFailure::indeterminate)?;
        self.activate_agent_messaging_credential(credential, &managed.thread_id)
            .map_err(AgentOperationFailure::indeterminate)?;
        Ok(managed)
    }

    #[cfg(test)]
    pub async fn list_sessions(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ManagedSessionPage, AgentManagerError> {
        self.list_sessions_for(cursor, limit, None).await
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
    pub async fn list_sessions_for(
        &self,
        cursor: Option<&str>,
        limit: usize,
        agent_filter: Option<&str>,
    ) -> Result<ManagedSessionPage, AgentManagerError> {
        self.flush_pending_durable_sessions().await?;
        let offset = decode_cursor(cursor)?;
        let limit = limit.clamp(1, MAX_PAGE_SIZE);
        let durable = self.session_index.lock().await.entries.clone();
        let mut sessions = BTreeMap::new();
        let mut discovered = Vec::new();
        let mut diagnostics = Vec::new();
        let mut agent_ids = self.agents.keys().cloned().collect::<Vec<_>>();
        agent_ids.sort();
        for agent_id in agent_ids {
            if agent_filter.is_some_and(|filter| filter != agent_id) {
                continue;
            }
            let runtime = &self.agents[&agent_id];
            let opencode_summaries = self.opencode_session_summaries(runtime).await;
            let Some(connection) = &runtime.connection else {
                add_durable_sessions(&mut sessions, &durable, &agent_id);
                continue;
            };
            if runtime
                .negotiated
                .as_ref()
                .is_some_and(NegotiatedInitialize::supports_session_list)
            {
                let mut remote_cursor = None;
                let mut seen_cursors = HashSet::new();
                for page_index in 0..MAX_SESSION_LIST_PAGES {
                    let response = match connection
                        .list_sessions(ListSessionsRequest::new().cursor(remote_cursor.clone()))
                        .await
                    {
                        Ok(response) => response,
                        Err(_) => {
                            diagnostics.push(SessionListDiagnostic::NativeListFailed);
                            break;
                        }
                    };
                    let sessions_before = sessions.len();
                    let page_was_empty = response.sessions.is_empty();
                    for remote in response.sessions {
                        if let Ok(identity) =
                            AgentSessionId::new(&agent_id, remote.session_id.to_string())
                        {
                            if let Ok(cwd) = self.validate_cwd(&remote.cwd) {
                                discovered.push(index_entry(identity.clone(), cwd.clone()));
                                let opencode_summary = opencode_summaries
                                    .get(&remote.session_id.to_string().to_ascii_lowercase());
                                let title = durable
                                    .iter()
                                    .find(|entry| {
                                        entry.agent_id == identity.agent_id
                                            && entry.acp_session_id == identity.acp_session_id
                                    })
                                    .and_then(|entry| entry.title.clone())
                                    .or_else(|| remote.title.clone())
                                    .or_else(|| {
                                        opencode_summary.and_then(|summary| summary.title.clone())
                                    });
                                let updated_at = remote.updated_at.clone().or_else(|| {
                                    opencode_summary.and_then(|summary| summary.updated_at.clone())
                                });
                                sessions.entry(identity.encode()).or_insert_with(|| {
                                    listed_managed_session(&identity, cwd, title, updated_at)
                                });
                            }
                        }
                    }
                    let made_progress = sessions.len() > sessions_before;
                    let Some(next_cursor) = response.next_cursor else {
                        break;
                    };
                    if page_was_empty {
                        diagnostics.push(SessionListDiagnostic::EmptyPage);
                        break;
                    }
                    if !made_progress {
                        diagnostics.push(SessionListDiagnostic::DuplicateOnlyPage);
                        break;
                    }
                    if !seen_cursors.insert(next_cursor.clone()) {
                        diagnostics.push(SessionListDiagnostic::RepeatedCursor);
                        break;
                    }
                    if sessions.len() >= MAX_SESSIONS {
                        diagnostics.push(SessionListDiagnostic::MaxSessionsReached);
                        break;
                    }
                    if page_index + 1 == MAX_SESSION_LIST_PAGES {
                        diagnostics.push(SessionListDiagnostic::PageBudgetExhausted);
                        break;
                    }
                    remote_cursor = Some(next_cursor);
                }
            }
            for session in connection.loaded_sessions().await {
                let mut snapshot = session.snapshot().await;
                if let Some(summary) = sessions.get(&snapshot.thread_id) {
                    if snapshot.title.is_none() {
                        snapshot.title = summary.snapshot.title.clone();
                    }
                    if snapshot.updated_at.is_none() {
                        snapshot.updated_at = summary.snapshot.updated_at.clone();
                    }
                }
                if let Some(entry) = durable.iter().find(|entry| {
                    AgentSessionId::new(&entry.agent_id, &entry.acp_session_id)
                        .is_ok_and(|identity| identity.encode() == snapshot.thread_id)
                }) {
                    if let Some(title) = &entry.title {
                        snapshot.title = Some(title.clone());
                    }
                }
                if let Some(entry) = durable.iter().find(|entry| {
                    AgentSessionId::new(&entry.agent_id, &entry.acp_session_id)
                        .is_ok_and(|identity| identity.encode() == snapshot.thread_id)
                }) {
                    sessions.insert(
                        snapshot.thread_id.clone(),
                        ManagedSession {
                            thread_id: snapshot.thread_id.clone(),
                            agent_id: snapshot.agent_id.clone(),
                            cwd: entry.cwd.clone(),
                            parent_thread_id: parent_thread_id(entry),
                            snapshot,
                        },
                    );
                }
            }
            add_durable_sessions(&mut sessions, &durable, &agent_id);
        }
        self.session_index
            .lock()
            .await
            .insert_all(discovered)
            .await?;
        let durable_thread_ids = durable
            .iter()
            .filter(|entry| agent_filter.is_none_or(|filter| filter == entry.agent_id))
            .filter_map(|entry| AgentSessionId::new(&entry.agent_id, &entry.acp_session_id).ok())
            .map(|identity| identity.encode())
            .collect::<HashSet<_>>();
        let mut sessions = sessions.into_values().collect::<Vec<_>>();
        if sessions.len() > MAX_SESSIONS {
            diagnostics.push(SessionListDiagnostic::MaxSessionsReached);
            sessions.sort_by(|left, right| {
                let left_durable = durable_thread_ids.contains(&left.thread_id);
                let right_durable = durable_thread_ids.contains(&right.thread_id);
                right_durable
                    .cmp(&left_durable)
                    .then_with(|| left.thread_id.cmp(&right.thread_id))
            });
            sessions.truncate(MAX_SESSIONS);
        }
        sessions.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
        let total = sessions.len();
        let sessions = sessions
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        let next_offset = offset.saturating_add(sessions.len());
        diagnostics.dedup();
        Ok(ManagedSessionPage {
            sessions,
            next_cursor: (next_offset < total).then(|| encode_cursor(next_offset)),
            partial: !diagnostics.is_empty(),
            diagnostics,
        })
    }

    pub async fn loaded_session_ids(&self) -> Vec<String> {
        let mut loaded = Vec::new();
        for runtime in self.agents.values() {
            let Some(connection) = &runtime.connection else {
                continue;
            };
            for session in connection.loaded_sessions().await {
                loaded.push(session.snapshot().await.thread_id);
                if loaded.len() == MAX_SESSIONS {
                    break;
                }
            }
            if loaded.len() == MAX_SESSIONS {
                break;
            }
        }
        loaded.sort();
        loaded.dedup();
        loaded
    }

    pub(crate) async fn runtime_activity(&self) -> (usize, usize) {
        let mut activity = (0, 0);
        for runtime in self.agents.values() {
            if let Some(connection) = &runtime.connection {
                let (active_runs, other_live_work) = connection.runtime_activity().await;
                activity.0 += active_runs;
                activity.1 += other_live_work;
            }
        }
        activity
    }

    #[cfg(test)]
    pub async fn resume_session(
        &self,
        thread_id: &str,
        cwd: impl Into<PathBuf>,
    ) -> Result<ManagedSession, AgentManagerError> {
        self.resume_session_with_policy(thread_id, cwd, ApprovalPolicy::Untrusted)
            .await
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub async fn resume_session_with_policy(
        &self,
        thread_id: &str,
        cwd: impl Into<PathBuf>,
        approval_policy: ApprovalPolicy,
    ) -> Result<ManagedSession, AgentManagerError> {
        let (identity, session_id, connection) = self.route_thread(thread_id)?;
        let cwd = self.validate_cwd(&cwd.into())?;
        if !connection.negotiated().supports_session_resume()
            && !connection.negotiated().supports_session_load()
        {
            return Err(AcpRuntimeError::Unsupported("session/resume or session/load").into());
        }
        let (family, operations) = loop {
            let mut family = self.indexed_session_family(&identity).await;
            family.sort_by_key(AgentSessionId::encode);
            let mut operations = Vec::with_capacity(family.len());
            for family_identity in &family {
                operations.push(
                    self.session_operation_lock(&family_identity.encode())
                        .await
                        .lock_owned()
                        .await,
                );
            }
            let mut current = self.indexed_session_family(&identity).await;
            current.sort_by_key(AgentSessionId::encode);
            if current == family {
                break (family, operations);
            }
            drop(operations);
        };
        let previous_policies = {
            let mut index = self.session_index.lock().await;
            let previous_policies = family
                .iter()
                .filter_map(|family_identity| {
                    index.entries.iter().find_map(|entry| {
                        (entry.agent_id == family_identity.agent_id
                            && entry.acp_session_id == family_identity.acp_session_id)
                            .then_some((family_identity.clone(), entry.approval_policy))
                    })
                })
                .collect::<Vec<_>>();
            if !previous_policies.is_empty() {
                let updates = previous_policies
                    .iter()
                    .map(|(family_identity, _)| (family_identity.clone(), approval_policy))
                    .collect::<Vec<_>>();
                index.set_approval_policies(&updates).await?;
            }
            previous_policies
        };
        let policy_session_ids = family
            .iter()
            .map(|family_identity| SessionId::new(family_identity.acp_session_id.clone()))
            .collect::<Vec<_>>();
        let configured_selections = self.configured_selections(connection, &session_id).await;
        // This operation returns the transcript; ACP resume explicitly omits history replay.
        let (restoration, credential) = if connection.negotiated().supports_session_load() {
            let mut request = LoadSessionRequest::new(session_id.clone(), cwd.clone());
            let credential =
                self.append_agent_messaging_server(&identity.agent_id, &mut request.mcp_servers)?;
            (
                connection
                    .load_session_with_policy_for_sessions(
                        request,
                        approval_policy,
                        policy_session_ids,
                    )
                    .await
                    .map(|response| response.config_options),
                credential,
            )
        } else {
            let mut request = ResumeSessionRequest::new(session_id.clone(), cwd.clone());
            let credential =
                self.append_agent_messaging_server(&identity.agent_id, &mut request.mcp_servers)?;
            (
                connection
                    .resume_session_with_policy_for_sessions(
                        request,
                        approval_policy,
                        policy_session_ids,
                    )
                    .await
                    .map(|response| response.config_options),
                credential,
            )
        };
        let restoration = match restoration {
            Ok(config_options) => config_options,
            Err(error @ (AcpRuntimeError::SessionBusy | AcpRuntimeError::UnknownSession(_))) => {
                if !previous_policies.is_empty() {
                    self.session_index
                        .lock()
                        .await
                        .set_approval_policies(&previous_policies)
                        .await?;
                }
                return Err(error.into());
            }
            Err(error) => return Err(error.into()),
        };
        self.track_session_with_policy_locked(identity, cwd, approval_policy)
            .await?;
        self.apply_config_options(connection, &session_id, restoration)
            .await?;
        self.restore_configured_selections(connection, &session_id, &configured_selections)
            .await;
        drop(operations);
        let managed = self
            .read_known_session_from(connection, &session_id)
            .await?;
        self.activate_agent_messaging_credential(credential, &managed.thread_id)?;
        Ok(managed)
    }

    pub async fn set_session_config_option(
        &self,
        thread_id: &str,
        config_id: &str,
        value: SessionConfigOptionValue,
    ) -> Result<ManagedSession, AgentManagerError> {
        let (_, session_id, connection) = self.route_thread(thread_id)?;
        let response = connection
            .set_session_config_option(SetSessionConfigOptionRequest::new(
                session_id.clone(),
                config_id.to_string(),
                value,
            ))
            .await?;
        self.apply_config_options(connection, &session_id, Some(response.config_options))
            .await?;
        self.read_known_session_from(connection, &session_id).await
    }

    pub async fn rename_session(
        &self,
        thread_id: &str,
        title: &str,
    ) -> Result<ManagedSession, AgentManagerError> {
        let identity =
            AgentSessionId::decode(thread_id).map_err(|_| AgentManagerError::InvalidThreadId)?;
        let title = title.trim();
        if !valid_session_title(title) {
            return Err(AgentManagerError::SessionIndex(
                "session title is empty or exceeds 256 bytes".to_string(),
            ));
        }
        let current = self
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| {
                entry.agent_id == identity.agent_id
                    && entry.acp_session_id == identity.acp_session_id
            })
            .cloned()
            .ok_or_else(|| AgentManagerError::SessionIndex("session is not indexed".to_string()))?;
        self.session_index
            .lock()
            .await
            .insert_all([SessionIndexEntry {
                title: Some(title.to_string()),
                ..current
            }])
            .await?;
        self.read_session(thread_id).await
    }

    #[cfg(test)]
    pub async fn fork_session(
        &self,
        thread_id: &str,
        message_id: &str,
    ) -> Result<ManagedSession, AgentManagerError> {
        self.fork_session_with_outcome(thread_id, message_id)
            .await
            .map_err(AgentOperationFailure::into_error)
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
    pub async fn fork_session_with_outcome(
        &self,
        thread_id: &str,
        message_id: &str,
    ) -> Result<ManagedSession, AgentOperationFailure> {
        self.flush_pending_durable_sessions()
            .await
            .map_err(AgentOperationFailure::definitive)?;
        let (source, source_session_id, connection) = self
            .route_thread(thread_id)
            .map_err(AgentOperationFailure::definitive)?;
        let source_session = connection
            .session(&source_session_id)
            .await
            .ok_or_else(|| {
                AgentOperationFailure::definitive(AgentManagerError::Runtime(
                    AcpRuntimeError::UnknownSession(source_session_id.to_string()),
                ))
            })?;
        let snapshot = source_session.snapshot().await;
        if snapshot.active_run_id.is_some() {
            return Err(AgentOperationFailure::definitive(
                AgentManagerError::Runtime(AcpRuntimeError::SessionBusy),
            ));
        }
        let boundary = snapshot.complete_fork_boundary(message_id).ok_or_else(|| {
            AgentOperationFailure::definitive(AgentManagerError::Fork(
                "fork boundary is unavailable or the session history is incomplete".to_string(),
            ))
        })?;
        if boundary.ordinal == 0 {
            return Err(AgentOperationFailure::definitive(AgentManagerError::Fork(
                "the first user request has no earlier conversation to fork".to_string(),
            )));
        }
        let source_entry = self
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| {
                entry.agent_id == source.agent_id && entry.acp_session_id == source.acp_session_id
            })
            .cloned()
            .ok_or_else(|| {
                AgentOperationFailure::definitive(AgentManagerError::SessionIndex(
                    "source session is not durably indexed".to_string(),
                ))
            })?;

        let native_fork = connection.negotiated().supports_session_fork();
        let (forked_session_id, title, directory) = if native_fork {
            let user_message_ordinal = u64::try_from(boundary.ordinal).map_err(|_| {
                AgentOperationFailure::definitive(AgentManagerError::Fork(
                    "fork boundary ordinal is invalid".to_string(),
                ))
            })?;
            let response = connection
                .fork_session_extension(ForkRequest {
                    session_id: source_session_id.clone(),
                    message_id: match &boundary.kind {
                        ForkBoundaryKind::BeforeRequest(request) => Some(
                            request
                                .raw_message_id_hint
                                .clone()
                                .unwrap_or_else(|| request.message_id.clone()),
                        ),
                        ForkBoundaryKind::EndOfHistory { .. } => None,
                    },
                    user_message_ordinal,
                })
                .await
                .map_err(classify_runtime_operation_failure)?;
            (
                response.session_id.to_string(),
                response.title,
                source_entry.cwd.clone(),
            )
        } else {
            let runtime = self.agents.get(&source.agent_id).ok_or_else(|| {
                AgentOperationFailure::definitive(AgentManagerError::UnknownAgent(
                    source.agent_id.clone(),
                ))
            })?;
            if !harness_capabilities(runtime).session_fork {
                return Err(AgentOperationFailure::definitive(
                    AgentManagerError::Runtime(AcpRuntimeError::Unsupported("session/fork")),
                ));
            }
            let (harness, context) = self
                .harness_session_context(&source, source_session_id.clone())
                .await
                .map_err(AgentOperationFailure::definitive)?;
            let forked = harness
                .fork_with_outcome(
                    &context,
                    HarnessForkRequest {
                        user_message_ordinal: boundary.ordinal,
                        boundary: match boundary.kind {
                            ForkBoundaryKind::BeforeRequest(request) => {
                                HarnessForkBoundary::BeforeRequest(harness_fork_boundary_message(
                                    request,
                                ))
                            }
                            ForkBoundaryKind::EndOfHistory { newest_request } => {
                                HarnessForkBoundary::EndOfHistory(harness_fork_boundary_message(
                                    newest_request,
                                ))
                            }
                        },
                    },
                )
                .await
                .map_err(|failure| {
                    let indeterminate = failure.is_indeterminate();
                    let error = AgentManagerError::Harness(failure.into_error());
                    if indeterminate {
                        AgentOperationFailure::indeterminate(error)
                    } else {
                        AgentOperationFailure::definitive(error)
                    }
                })?;
            (
                forked.session_id,
                forked.title,
                self.validate_cwd(&forked.directory)
                    .map_err(AgentOperationFailure::indeterminate)?,
            )
        };

        let forked_identity =
            AgentSessionId::new(&source.agent_id, &forked_session_id).map_err(|_| {
                AgentOperationFailure::indeterminate(AgentManagerError::Fork(
                    "invalid forked session ID".to_string(),
                ))
            })?;
        if forked_identity.acp_session_id == source.acp_session_id {
            return Err(AgentOperationFailure::indeterminate(
                AgentManagerError::Fork("fork returned the source session ID".to_string()),
            ));
        }
        let forked_thread_id = forked_identity.encode();
        let mut operation_thread_ids = vec![source.encode(), forked_thread_id.clone()];
        operation_thread_ids.sort();
        operation_thread_ids.dedup();
        let mut operations = Vec::with_capacity(operation_thread_ids.len());
        for operation_thread_id in operation_thread_ids {
            operations.push(
                self.session_operation_lock(&operation_thread_id)
                    .await
                    .lock_owned()
                    .await,
            );
        }
        {
            let mut index = self.session_index.lock().await;
            if index.entries.iter().any(|entry| {
                entry.agent_id == forked_identity.agent_id
                    && entry.acp_session_id == forked_identity.acp_session_id
            }) {
                return Err(AgentOperationFailure::indeterminate(
                    AgentManagerError::Fork("fork returned an existing session ID".to_string()),
                ));
            }
            let approval_policy = index
                .entries
                .iter()
                .find(|entry| {
                    entry.agent_id == source.agent_id
                        && entry.acp_session_id == source.acp_session_id
                })
                .map(|entry| entry.approval_policy)
                .ok_or_else(|| {
                    AgentOperationFailure::indeterminate(AgentManagerError::SessionIndex(
                        "source session is no longer durably indexed".to_string(),
                    ))
                })?;
            index
                .insert_all([SessionIndexEntry {
                    agent_id: forked_identity.agent_id.clone(),
                    acp_session_id: forked_identity.acp_session_id.clone(),
                    cwd: directory,
                    approval_policy,
                    title: title.filter(|title| valid_session_title(title)),
                    parent_acp_session_id: None,
                    forked_from_acp_session_id: Some(source.acp_session_id.clone()),
                }])
                .await
                .map_err(AgentOperationFailure::indeterminate)?;
        }
        drop(operations);
        match self.read_session(&forked_thread_id).await {
            Ok(session) => Ok(session),
            Err(error) => {
                let rollback_operation = self
                    .session_operation_lock(&forked_thread_id)
                    .await
                    .lock_owned()
                    .await;
                let rollback_error = self
                    .session_index
                    .lock()
                    .await
                    .remove_all(std::slice::from_ref(&forked_identity))
                    .await
                    .err();
                connection
                    .evict_session(&SessionId::new(forked_identity.acp_session_id))
                    .await;
                self.tracked_sessions.lock().await.remove(&forked_thread_id);
                self.pending_durable_sessions
                    .lock()
                    .await
                    .remove(&forked_thread_id);
                drop(rollback_operation);
                self.prune_session_operation_lock(&forked_thread_id).await;
                match rollback_error {
                    Some(rollback_error) => Err(AgentOperationFailure::indeterminate(
                        AgentManagerError::Fork(format!(
                            "{error}; durable rollback also failed: {rollback_error}",
                        )),
                    )),
                    None => Err(AgentOperationFailure::indeterminate(error)),
                }
            }
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
    pub(crate) async fn reconcile_retirement_plan(
        &self,
        thread_ids: &[String],
    ) -> RetirementPlanReconciliation {
        let mut identities = Vec::with_capacity(thread_ids.len());
        for thread_id in thread_ids {
            let Ok(identity) = AgentSessionId::decode(thread_id) else {
                return RetirementPlanReconciliation::Indeterminate;
            };
            identities.push(identity);
        }
        if identities.is_empty() {
            return RetirementPlanReconciliation::Indeterminate;
        }

        let indexed = self.session_index.lock().await.entries.clone();
        let mut by_agent = BTreeMap::<String, Vec<AgentSessionId>>::new();
        for identity in identities {
            by_agent
                .entry(identity.agent_id.clone())
                .or_default()
                .push(identity);
        }

        let mut saw_present = false;
        let mut saw_absent = false;
        let mut saw_indeterminate = false;
        for (agent_id, identities) in by_agent {
            let Some(runtime) = self.agents.get(&agent_id) else {
                for identity in identities {
                    if indexed.iter().any(|entry| {
                        entry.agent_id == identity.agent_id
                            && entry.acp_session_id == identity.acp_session_id
                    }) {
                        saw_indeterminate = true;
                    } else {
                        saw_absent = true;
                    }
                }
                continue;
            };
            let Some(connection) = runtime.connection.as_ref() else {
                for identity in identities {
                    if indexed.iter().any(|entry| {
                        entry.agent_id == identity.agent_id
                            && entry.acp_session_id == identity.acp_session_id
                    }) {
                        saw_indeterminate = true;
                    } else {
                        saw_absent = true;
                    }
                }
                continue;
            };
            if connection.negotiated().supports_session_list() {
                match Self::authoritative_session_ids(connection).await {
                    Ok(listed) => {
                        for identity in identities {
                            if listed.contains(&identity.acp_session_id) {
                                saw_present = true;
                            } else {
                                saw_absent = true;
                            }
                        }
                    }
                    Err(()) => saw_indeterminate = true,
                }
                continue;
            }

            if harness_capabilities(runtime).session_delete {
                let Some(harness) = runtime.harness.as_ref() else {
                    saw_indeterminate = true;
                    continue;
                };
                for identity in identities {
                    if !indexed.iter().any(|entry| {
                        entry.agent_id == identity.agent_id
                            && entry.acp_session_id == identity.acp_session_id
                    }) {
                        saw_absent = true;
                        continue;
                    }
                    let session_id = SessionId::new(identity.acp_session_id.clone());
                    let Ok((_, context)) =
                        self.harness_session_context(&identity, session_id).await
                    else {
                        saw_indeterminate = true;
                        continue;
                    };
                    match harness.session_exists(&context).await {
                        Ok(true) => saw_present = true,
                        Ok(false) => saw_absent = true,
                        Err(_) => saw_indeterminate = true,
                    }
                }
            } else {
                for identity in identities {
                    if indexed.iter().any(|entry| {
                        entry.agent_id == identity.agent_id
                            && entry.acp_session_id == identity.acp_session_id
                    }) {
                        saw_indeterminate = true;
                    } else {
                        saw_absent = true;
                    }
                }
            }
        }

        if saw_indeterminate || (saw_present && saw_absent) {
            RetirementPlanReconciliation::Indeterminate
        } else if saw_present {
            RetirementPlanReconciliation::Present
        } else if saw_absent {
            RetirementPlanReconciliation::Absent
        } else {
            RetirementPlanReconciliation::Indeterminate
        }
    }

    pub(crate) async fn expand_retirement_family(
        &self,
        thread_ids: &[String],
    ) -> Result<Vec<String>, AgentManagerError> {
        let roots = thread_ids
            .iter()
            .map(|thread_id| {
                AgentSessionId::decode(thread_id).map_err(|_| AgentManagerError::InvalidThreadId)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut expanded = Vec::new();
        for root in roots {
            expanded.extend(
                self.indexed_session_family(&root)
                    .await
                    .into_iter()
                    .map(|identity| identity.encode()),
            );
        }
        expanded.sort();
        expanded.dedup();
        Ok(expanded)
    }

    async fn authoritative_session_ids(connection: &AcpConnection) -> Result<HashSet<String>, ()> {
        let mut remote_cursor = None;
        let mut seen_cursors = HashSet::new();
        let mut sessions = HashSet::new();
        for page_index in 0..MAX_SESSION_LIST_PAGES {
            let response = connection
                .list_sessions(ListSessionsRequest::new().cursor(remote_cursor.clone()))
                .await
                .map_err(|_| ())?;
            let page_was_empty = response.sessions.is_empty();
            let before = sessions.len();
            for session in response.sessions {
                sessions.insert(session.session_id.to_string());
                if sessions.len() > MAX_SESSIONS {
                    return Err(());
                }
            }
            let Some(next_cursor) = response.next_cursor else {
                return Ok(sessions);
            };
            if page_was_empty
                || sessions.len() == before
                || !seen_cursors.insert(next_cursor.clone())
                || page_index + 1 == MAX_SESSION_LIST_PAGES
            {
                return Err(());
            }
            remote_cursor = Some(next_cursor);
        }
        Err(())
    }

    pub(crate) async fn finalize_confirmed_deleted_sessions(
        &self,
        thread_ids: &[String],
    ) -> Result<(), AgentManagerError> {
        let identities = thread_ids
            .iter()
            .map(|thread_id| {
                AgentSessionId::decode(thread_id).map_err(|_| AgentManagerError::InvalidThreadId)
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.session_index
            .lock()
            .await
            .remove_all(&identities)
            .await?;
        for identity in &identities {
            let thread_id = identity.encode();
            if let Some(connection) = self
                .agents
                .get(&identity.agent_id)
                .and_then(|runtime| runtime.connection.as_ref())
            {
                connection
                    .evict_session(&SessionId::new(identity.acp_session_id.clone()))
                    .await;
            }
            self.pending_durable_sessions
                .lock()
                .await
                .remove(&thread_id);
            self.tracked_sessions.lock().await.remove(&thread_id);
            self.subagent_generations.lock().await.remove(&thread_id);
            self.prune_session_operation_lock(&thread_id).await;
        }
        if let Some(config) = self.agent_messaging.get() {
            config.revoke_threads(thread_ids.iter().map(String::as_str));
        }
        self.agent_message_journal
            .lock()
            .await
            .remove_threads(thread_ids)
            .await
    }

    pub(crate) async fn prepare_session_deletion(
        &self,
        thread_id: &str,
    ) -> Result<PreparedSessionDeletion<'_>, AgentManagerError> {
        let (identity, session_id, connection) = self.route_thread(thread_id)?;
        let native_delete = connection.negotiated().supports_session_delete();
        let harness_delete = self
            .agents
            .get(&identity.agent_id)
            .is_some_and(|runtime| harness_capabilities(runtime).session_delete);
        if !native_delete && !harness_delete {
            return Err(AcpRuntimeError::Unsupported("session/delete").into());
        }
        let (affected, operations) = loop {
            let affected = if !native_delete && harness_delete {
                self.indexed_session_family(&identity).await
            } else {
                vec![identity.clone()]
            };
            let mut sorted_affected = affected.clone();
            sorted_affected.sort_by_key(AgentSessionId::encode);
            let mut operations = Vec::with_capacity(affected.len());
            for affected_identity in &sorted_affected {
                operations.push(
                    self.session_operation_lock(&affected_identity.encode())
                        .await
                        .lock_owned()
                        .await,
                );
            }
            let mut current = if !native_delete && harness_delete {
                self.indexed_session_family(&identity).await
            } else {
                vec![identity.clone()]
            };
            current.sort_by_key(AgentSessionId::encode);
            if current == sorted_affected {
                break (affected, operations);
            }
            drop(operations);
        };
        Ok(PreparedSessionDeletion {
            manager: self,
            identity,
            session_id,
            connection: connection.clone(),
            native_delete,
            affected,
            operations,
        })
    }

    #[cfg(test)]
    pub async fn delete_session(&self, thread_id: &str) -> Result<Vec<String>, AgentManagerError> {
        self.prepare_session_deletion(thread_id)
            .await?
            .execute()
            .await
    }

    async fn harness_session_context(
        &self,
        identity: &AgentSessionId,
        session_id: SessionId,
    ) -> Result<(Arc<dyn HarnessAdapter>, SessionContext), AgentManagerError> {
        let runtime = self
            .agents
            .get(&identity.agent_id)
            .ok_or_else(|| AgentManagerError::UnknownAgent(identity.agent_id.clone()))?;
        let harness = runtime
            .harness
            .clone()
            .ok_or(AcpRuntimeError::Unsupported("harness operation"))?;
        let http_base = runtime
            .http_base
            .clone()
            .ok_or(AcpRuntimeError::Unsupported("harness HTTP API"))?;
        let cwd = {
            let index = self.session_index.lock().await;
            index
                .entries
                .iter()
                .find(|entry| {
                    entry.agent_id == identity.agent_id
                        && entry.acp_session_id == identity.acp_session_id
                })
                .map(|entry| entry.cwd.clone())
        }
        .ok_or_else(|| {
            AgentManagerError::SessionIndex(
                "session is not indexed for harness dispatch".to_string(),
            )
        })?;
        Ok((
            harness,
            SessionContext {
                http: self.http.clone(),
                http_base,
                session_id,
                cwd,
            },
        ))
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_nesting,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn indexed_session_family(&self, root: &AgentSessionId) -> Vec<AgentSessionId> {
        let entries = self.session_index.lock().await.entries.clone();
        let mut affected = vec![root.clone()];
        let mut seen = HashSet::from([root.acp_session_id.clone()]);
        let mut parent_index = 0;
        while parent_index < affected.len() {
            let parent_id = affected[parent_index].acp_session_id.clone();
            for entry in &entries {
                if entry.agent_id == root.agent_id
                    && entry.parent_acp_session_id.as_deref() == Some(parent_id.as_str())
                    && seen.insert(entry.acp_session_id.clone())
                {
                    if let Ok(identity) =
                        AgentSessionId::new(&entry.agent_id, &entry.acp_session_id)
                    {
                        affected.push(identity);
                    }
                }
            }
            parent_index += 1;
        }
        affected
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub async fn read_session(&self, thread_id: &str) -> Result<ManagedSession, AgentManagerError> {
        let (identity, session_id, connection) = self.route_thread(thread_id)?;
        let requires_reconstruction = match connection.session(&session_id).await {
            Some(session) => session.snapshot().await.history_reconstruction,
            None => true,
        };
        if requires_reconstruction {
            let operation_lock = self.session_operation_lock(thread_id).await;
            let _operation = operation_lock.lock().await;
            let requires_reconstruction = match connection.session(&session_id).await {
                Some(session) => session.snapshot().await.history_reconstruction,
                None => true,
            };
            if requires_reconstruction {
                let entry = self
                    .session_index
                    .lock()
                    .await
                    .entries
                    .iter()
                    .find(|entry| {
                        entry.agent_id == identity.agent_id
                            && entry.acp_session_id == identity.acp_session_id
                    })
                    .cloned()
                    .ok_or_else(|| AcpRuntimeError::UnknownSession(session_id.to_string()))?;
                let cwd = self.validate_cwd(&entry.cwd)?;
                let configured_selections =
                    self.configured_selections(connection, &session_id).await;
                let (config_options, credential) =
                    if connection.negotiated().supports_session_load() {
                        let mut request = LoadSessionRequest::new(session_id.clone(), cwd);
                        let credential = self.append_agent_messaging_server(
                            &identity.agent_id,
                            &mut request.mcp_servers,
                        )?;
                        (
                            connection
                                .load_session_with_policy(request, entry.approval_policy)
                                .await?
                                .config_options,
                            credential,
                        )
                    } else if connection.negotiated().supports_session_resume() {
                        let mut request = ResumeSessionRequest::new(session_id.clone(), cwd);
                        let credential = self.append_agent_messaging_server(
                            &identity.agent_id,
                            &mut request.mcp_servers,
                        )?;
                        (
                            connection
                                .resume_session_with_policy(request, entry.approval_policy)
                                .await?
                                .config_options,
                            credential,
                        )
                    } else {
                        return Err(
                            AcpRuntimeError::Unsupported("session/resume or session/load").into(),
                        );
                    };
                self.register_session_events(&identity).await;
                self.apply_config_options(connection, &session_id, config_options)
                    .await?;
                self.restore_configured_selections(connection, &session_id, &configured_selections)
                    .await;
                let managed = self
                    .read_known_session_from(connection, &session_id)
                    .await?;
                self.activate_agent_messaging_credential(credential, &managed.thread_id)?;
                return Ok(managed);
            }
        }
        self.read_known_session_from(connection, &session_id).await
    }

    pub(crate) async fn thread_is_authoritatively_absent(&self, thread_id: &str) -> bool {
        let Ok((identity, session_id, connection)) = self.route_thread(thread_id) else {
            return false;
        };
        let operation_lock = self.session_operation_lock(thread_id).await;
        let _operation = operation_lock.lock().await;
        if connection.session(&session_id).await.is_some()
            || self.session_index.lock().await.entries.iter().any(|entry| {
                entry.agent_id == identity.agent_id
                    && entry.acp_session_id == identity.acp_session_id
            })
            || !connection.negotiated().supports_session_list()
        {
            return false;
        }
        // A missing local index entry alone is not deletion evidence (e.g. failed startup IO).
        Self::authoritative_session_ids(connection)
            .await
            .is_ok_and(|sessions| !sessions.contains(&identity.acp_session_id))
    }

    async fn apply_agent_message_journal(&self, snapshot: &mut SessionSnapshot) {
        let entries = self
            .agent_message_journal
            .lock()
            .await
            .entries_for_thread(&snapshot.thread_id);
        for entry in entries {
            snapshot.append_agent_message_after(entry.message, entry.after_timeline_id.as_deref());
        }
    }

    async fn reconcile_received_agent_messages(&self, snapshot: &SessionSnapshot) {
        let message_ids = snapshot
            .messages
            .iter()
            .filter_map(|message| message.agent_message.as_ref())
            .filter(|message| {
                message.direction == crate::agent_messaging::AgentMessageDirection::Received
                    && message.disposition
                        != crate::agent_messaging::AgentMessageDisposition::Cancelled
            })
            .map(|message| message.message_id.clone())
            .collect::<HashSet<_>>();
        if message_ids.is_empty() {
            return;
        }

        let mut journal = self.agent_message_journal.lock().await;
        for message_id in message_ids {
            let was_interrupted =
                journal
                    .messages_for_id(&message_id)
                    .iter()
                    .any(|(_, message)| {
                        message.disposition
                            == crate::agent_messaging::AgentMessageDisposition::Cancelled
                    });
            if !was_interrupted {
                continue;
            }
            if let Err(error) = journal
                .update_disposition(
                    &message_id,
                    crate::agent_messaging::AgentMessageDisposition::Sent,
                )
                .await
            {
                eprintln!(
                    "failed to reconcile received agent-message activity {message_id}: {error}",
                );
            }
        }
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(crate) async fn agent_relations(
        &self,
        caller_thread_id: &str,
    ) -> Result<AgentRelations, AgentRelationError> {
        let caller = AgentSessionId::decode(caller_thread_id)
            .map_err(|_| AgentRelationError::InvalidThreadId)?;
        let (parent_entry, mut child_entries) = {
            let index = self.session_index.lock().await;
            let caller_entry = index
                .entries
                .iter()
                .find(|entry| {
                    entry.agent_id == caller.agent_id
                        && entry.acp_session_id == caller.acp_session_id
                })
                .cloned()
                .ok_or_else(|| AgentRelationError::UnknownCaller(caller_thread_id.to_string()))?;
            let parent_entry = caller_entry
                .parent_acp_session_id
                .as_ref()
                .and_then(|parent_id| {
                    index
                        .entries
                        .iter()
                        .find(|entry| {
                            entry.agent_id == caller.agent_id && entry.acp_session_id == *parent_id
                        })
                        .cloned()
                });
            let child_entries = index
                .entries
                .iter()
                .filter(|entry| {
                    entry.agent_id == caller.agent_id
                        && entry.parent_acp_session_id.as_deref()
                            == Some(caller.acp_session_id.as_str())
                })
                .cloned()
                .collect::<Vec<_>>();
            (parent_entry, child_entries)
        };

        child_entries.sort_by(|left, right| {
            left.title
                .as_deref()
                .unwrap_or_default()
                .cmp(right.title.as_deref().unwrap_or_default())
                .then_with(|| left.acp_session_id.cmp(&right.acp_session_id))
        });
        let children_truncated = child_entries.len() > MAX_AGENT_RELATION_CHILDREN;
        child_entries.truncate(MAX_AGENT_RELATION_CHILDREN);

        let parent = match parent_entry {
            Some(entry) => Some(self.agent_relation_session(&entry).await),
            None => None,
        };
        let mut children = Vec::with_capacity(child_entries.len());
        for entry in child_entries {
            children.push(self.agent_relation_session(&entry).await);
        }
        Ok(AgentRelations {
            parent,
            children,
            children_truncated,
        })
    }

    #[cfg(test)]
    pub(crate) async fn direct_agent_relation(
        &self,
        caller_thread_id: &str,
        target_thread_id: &str,
    ) -> Result<AgentRelationKind, AgentRelationError> {
        self.direct_agent_relation_sessions(caller_thread_id, target_thread_id)
            .await
            .map(|(relation, _, _)| relation)
    }

    pub(crate) async fn direct_agent_relation_sessions(
        &self,
        caller_thread_id: &str,
        target_thread_id: &str,
    ) -> Result<
        (
            AgentRelationKind,
            AgentRelationSession,
            AgentRelationSession,
        ),
        AgentRelationError,
    > {
        let caller = AgentSessionId::decode(caller_thread_id)
            .map_err(|_| AgentRelationError::InvalidThreadId)?;
        let target = AgentSessionId::decode(target_thread_id)
            .map_err(|_| AgentRelationError::InvalidThreadId)?;
        if caller == target {
            return Err(AgentRelationError::SelfTarget);
        }
        if caller.agent_id != target.agent_id {
            return Err(AgentRelationError::CrossAgent);
        }

        let (caller_entry, target_entry, relation) = {
            let index = self.session_index.lock().await;
            let caller_entry = index
                .entries
                .iter()
                .find(|entry| {
                    entry.agent_id == caller.agent_id
                        && entry.acp_session_id == caller.acp_session_id
                })
                .cloned()
                .ok_or_else(|| AgentRelationError::UnknownCaller(caller_thread_id.to_string()))?;
            let target_entry = index
                .entries
                .iter()
                .find(|entry| {
                    entry.agent_id == target.agent_id
                        && entry.acp_session_id == target.acp_session_id
                })
                .cloned()
                .ok_or_else(|| AgentRelationError::UnknownTarget(target_thread_id.to_string()))?;
            let relation = if caller_entry.parent_acp_session_id.as_deref()
                == Some(target_entry.acp_session_id.as_str())
            {
                AgentRelationKind::Parent
            } else if target_entry.parent_acp_session_id.as_deref()
                == Some(caller_entry.acp_session_id.as_str())
            {
                AgentRelationKind::SubAgent
            } else {
                return Err(AgentRelationError::NotDirect);
            };
            (caller_entry, target_entry, relation)
        };

        Ok((
            relation,
            self.agent_relation_session(&caller_entry).await,
            self.agent_relation_session(&target_entry).await,
        ))
    }

    pub(crate) async fn record_agent_messages(
        &self,
        messages: Vec<(String, crate::agent_messaging::AgentMessageOrigin)>,
    ) -> Result<(), AgentManagerError> {
        let mut journal_messages = Vec::with_capacity(messages.len());
        for (thread_id, message) in messages {
            let managed = self.read_session(&thread_id).await?;
            let after_timeline_id = managed
                .snapshot
                .latest_timeline_canonical_id()
                .map(str::to_string);
            let (_, session_id, connection) = self.route_thread(&thread_id)?;
            if connection.session(&session_id).await.is_none() {
                return Err(AcpRuntimeError::UnknownSession(session_id.to_string()).into());
            }
            journal_messages.push((thread_id, after_timeline_id, message));
        }
        self.agent_message_journal
            .lock()
            .await
            .upsert_many(journal_messages)
            .await?;
        Ok(())
    }

    pub(crate) async fn publish_agent_message(&self, message_id: &str) {
        let messages = self
            .agent_message_journal
            .lock()
            .await
            .messages_for_id(message_id);
        for (thread_id, message) in messages {
            let Ok((identity, session_id, connection)) = self.route_thread(&thread_id) else {
                continue;
            };
            let Some(session) = connection.session(&session_id).await else {
                continue;
            };
            session
                .emit(CanonicalEvent::AgentMessage {
                    agent_id: identity.agent_id,
                    thread_id,
                    message,
                })
                .await;
        }
    }

    pub(crate) async fn remove_agent_message(
        &self,
        message_id: &str,
    ) -> Result<(), AgentManagerError> {
        self.agent_message_journal
            .lock()
            .await
            .remove_message(message_id)
            .await
    }

    pub(crate) async fn update_agent_message_disposition(
        &self,
        message_id: &str,
        disposition: crate::agent_messaging::AgentMessageDisposition,
    ) -> Result<(), AgentManagerError> {
        let updates = self
            .agent_message_journal
            .lock()
            .await
            .update_disposition(message_id, disposition)
            .await?;
        for (thread_id, message) in updates {
            let Ok((identity, session_id, connection)) = self.route_thread(&thread_id) else {
                continue;
            };
            let Some(session) = connection.session(&session_id).await else {
                continue;
            };
            session
                .emit(CanonicalEvent::AgentMessage {
                    agent_id: identity.agent_id,
                    thread_id,
                    message,
                })
                .await;
        }
        Ok(())
    }

    pub async fn snapshot_page(
        &self,
        thread_id: &str,
        before: Option<&str>,
        after: Option<&str>,
        limit: usize,
    ) -> Result<SnapshotPage, AgentManagerError> {
        let session = self.read_session(thread_id).await?;
        session
            .snapshot
            .page(before, after, limit)
            .map_err(|_| AgentManagerError::InvalidCursor)
    }

    pub async fn mark_parent_subagent_terminal(
        &self,
        child_thread_id: &str,
        status: &str,
    ) -> Result<Option<ManagedSession>, AgentManagerError> {
        let (child, _, _) = self.route_thread(child_thread_id)?;
        let parent_thread_id = {
            let index = self.session_index.lock().await;
            index
                .entries
                .iter()
                .find(|entry| {
                    entry.agent_id == child.agent_id && entry.acp_session_id == child.acp_session_id
                })
                .and_then(parent_thread_id)
        };
        let Some(parent_thread_id) = parent_thread_id else {
            return Ok(None);
        };
        self.read_session(&parent_thread_id).await?;
        let (_, parent_session_id, connection) = self.route_thread(&parent_thread_id)?;
        let Some(parent_session) = connection.session(&parent_session_id).await else {
            return Ok(None);
        };
        let changed = parent_session
            .mark_subagent_terminal(&child.acp_session_id, status)
            .await;
        if !changed {
            return Ok(None);
        }
        self.read_known_session_from(connection, &parent_session_id)
            .await
            .map(Some)
    }

    pub async fn mark_parent_subagent_tool_terminal(
        &self,
        parent_thread_id: &str,
        tool_call_id: &str,
        status: &str,
    ) -> Result<Option<ManagedSession>, AgentManagerError> {
        self.read_session(parent_thread_id).await?;
        let (_, parent_session_id, connection) = self.route_thread(parent_thread_id)?;
        let Some(parent_session) = connection.session(&parent_session_id).await else {
            return Ok(None);
        };
        if !parent_session
            .mark_subagent_tool_terminal(tool_call_id, status)
            .await
        {
            return Ok(None);
        }
        self.read_known_session_from(connection, &parent_session_id)
            .await
            .map(Some)
    }

    pub async fn note_subagent_link(
        &self,
        parent_thread_id: &str,
        child_thread_id: &str,
        tool_call_id: &str,
    ) {
        let mut generations = self.subagent_generations.lock().await;
        if !generations.contains_key(child_thread_id)
            && generations.len() >= MAX_TRACKED_SUBAGENT_GENERATIONS
        {
            if let Some(expired) = generations.keys().next().cloned() {
                generations.remove(&expired);
            }
        }
        match generations.get_mut(child_thread_id) {
            Some(state)
                if state.parent_thread_id == parent_thread_id
                    && state.tool_call_id == tool_call_id
                    && state.armed => {}
            Some(state) => {
                state.parent_thread_id = parent_thread_id.to_string();
                state.tool_call_id = tool_call_id.to_string();
                let observed_floor = state
                    .observed_generation
                    .map(|generation| generation.saturating_add(1));
                state.minimum_generation = match (state.minimum_generation, observed_floor) {
                    (Some(existing), Some(observed)) => Some(existing.max(observed)),
                    (Some(existing), None) => Some(existing),
                    (None, Some(observed)) => Some(observed),
                    (None, None) => None,
                };
                state.armed = true;
            }
            None => {
                generations.insert(
                    child_thread_id.to_string(),
                    SubagentGenerationState {
                        parent_thread_id: parent_thread_id.to_string(),
                        tool_call_id: tool_call_id.to_string(),
                        observed_generation: None,
                        minimum_generation: None,
                        armed: true,
                    },
                );
            }
        }
    }

    pub async fn retire_subagent_link(&self, child_thread_id: &str, tool_call_id: &str) {
        let mut generations = self.subagent_generations.lock().await;
        if let Some(state) = generations
            .get_mut(child_thread_id)
            .filter(|state| state.tool_call_id == tool_call_id)
        {
            state.armed = false;
            // Keep the last observed generation as a bounded tombstone. A later
            // retask can then reject a duplicate terminal from the old child run.
        }
    }

    pub async fn note_subagent_started(&self, child_thread_id: &str, generation: u64) {
        let mut generations = self.subagent_generations.lock().await;
        let Some(state) = generations.get_mut(child_thread_id) else {
            return;
        };
        if state
            .minimum_generation
            .is_some_and(|minimum| generation < minimum)
        {
            return;
        }
        state.observed_generation = Some(generation);
    }

    pub async fn accepted_subagent_terminal(
        &self,
        child_thread_id: &str,
        generation: u64,
    ) -> Option<AcceptedSubagentTerminal> {
        let generations = self.subagent_generations.lock().await;
        let state = generations.get(child_thread_id)?;
        if !state.armed {
            return None;
        }
        if state
            .minimum_generation
            .is_some_and(|minimum| generation < minimum)
        {
            return None;
        }
        let accepted = state
            .observed_generation
            .is_none_or(|observed| observed == generation);
        accepted.then(|| AcceptedSubagentTerminal {
            parent_thread_id: state.parent_thread_id.clone(),
            tool_call_id: state.tool_call_id.clone(),
        })
    }

    pub async fn tracks_subagent_generation(&self, child_thread_id: &str) -> bool {
        self.subagent_generations
            .lock()
            .await
            .contains_key(child_thread_id)
    }

    /// Whether this thread's agent can be asked which sub-agents it has spawned.
    ///
    /// Agents that cannot only reveal a sub-agent through the task tool itself, so there is
    /// nothing to poll for and the sub-agent resolves when the tool reports it.
    pub(crate) fn can_discover_subagents(&self, thread_id: &str) -> bool {
        let Ok(identity) = AgentSessionId::decode(thread_id) else {
            return false;
        };
        self.agents
            .get(&identity.agent_id)
            .is_some_and(|runtime| runtime.http_base.is_some() && runtime.harness.is_some())
    }

    /// Sessions OpenCode reports as spawned by the given parent thread.
    ///
    /// A foreground `task` tool only names its child once it has finished, so the tool's own
    /// updates cannot be used to attach to a sub-agent while it works. OpenCode's HTTP server
    /// knows about the child as soon as it is created, which is what makes live streaming
    /// possible. Any failure is reported as "no children" so a sub-agent still resolves the
    /// slow way when the server cannot be reached.
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(crate) async fn harness_child_sessions(
        &self,
        parent_thread_id: &str,
    ) -> Vec<HarnessChildSession> {
        let Ok(parent) = AgentSessionId::decode(parent_thread_id) else {
            return Vec::new();
        };
        let Some(runtime) = self.agents.get(&parent.agent_id) else {
            return Vec::new();
        };
        if runtime.harness.is_none() {
            return Vec::new();
        }
        let Some(http_base) = runtime.http_base.as_deref() else {
            return Vec::new();
        };
        let cwd = {
            let index = self.session_index.lock().await;
            index
                .entries
                .iter()
                .find(|entry| {
                    entry.agent_id == parent.agent_id
                        && entry.acp_session_id == parent.acp_session_id
                })
                .map(|entry| entry.cwd.clone())
        };
        let Some(cwd) = cwd else {
            return Vec::new();
        };
        let Ok(url) = reqwest::Url::parse_with_params(
            &format!("{http_base}/session/{}/children", parent.acp_session_id),
            [("directory", cwd.to_string_lossy().as_ref())],
        ) else {
            return Vec::new();
        };
        let request = self.http.get(url).send();
        let Ok(Ok(response)) = tokio::time::timeout(OPENCODE_CHILD_LOOKUP_TIMEOUT, request).await
        else {
            return Vec::new();
        };
        if !response.status().is_success() {
            return Vec::new();
        }
        let Ok(rows) = response.json::<Vec<OpenCodeChildSessionRow>>().await else {
            return Vec::new();
        };
        rows.into_iter()
            .filter(|row| row.parent_id.as_deref() == Some(parent.acp_session_id.as_str()))
            .filter_map(|row| {
                let acp_session_id = row.id.trim().to_string();
                if acp_session_id.is_empty() || acp_session_id.len() > 1_024 {
                    return None;
                }
                Some(HarnessChildSession {
                    title: row
                        .title
                        .map(|title| title.trim().to_string())
                        .filter(|title| valid_session_title(title)),
                    acp_session_id,
                })
            })
            .take(MAX_OPENCODE_CHILD_SESSIONS)
            .collect()
    }

    pub async fn adopt_related_session(
        &self,
        parent_thread_id: &str,
        child_session_id: &str,
        title: Option<&str>,
    ) -> Result<String, AgentManagerError> {
        let parent = AgentSessionId::decode(parent_thread_id)
            .map_err(|_| AgentManagerError::InvalidThreadId)?;
        let child = AgentSessionId::new(parent.agent_id.clone(), child_session_id.to_string())
            .map_err(|_| AgentManagerError::InvalidThreadId)?;
        if child.acp_session_id == parent.acp_session_id {
            return Err(AgentManagerError::InvalidThreadId);
        }
        let mut operation_thread_ids = vec![parent.encode(), child.encode()];
        operation_thread_ids.sort();
        operation_thread_ids.dedup();
        let mut operations = Vec::with_capacity(operation_thread_ids.len());
        for operation_thread_id in operation_thread_ids {
            operations.push(
                self.session_operation_lock(&operation_thread_id)
                    .await
                    .lock_owned()
                    .await,
            );
        }
        let parent_entry = self
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| {
                entry.agent_id == parent.agent_id && entry.acp_session_id == parent.acp_session_id
            })
            .cloned()
            .ok_or_else(|| {
                AgentManagerError::SessionIndex("parent session is not indexed".to_string())
            })?;
        let entry = SessionIndexEntry {
            agent_id: child.agent_id.clone(),
            acp_session_id: child.acp_session_id.clone(),
            cwd: parent_entry.cwd,
            approval_policy: parent_entry.approval_policy,
            title: title
                .filter(|title| valid_session_title(title))
                .map(str::to_string),
            parent_acp_session_id: Some(parent.acp_session_id),
            forked_from_acp_session_id: None,
        };
        self.persist_inherited_entries_locked(std::slice::from_ref(&entry))
            .await?;
        drop(operations);
        Ok(child.encode())
    }

    #[cfg(test)]
    pub async fn prompt(
        &self,
        thread_id: &str,
        prompt: Vec<agent_client_protocol::v1::schema::ContentBlock>,
        run_id: String,
        source_turn_id: String,
    ) -> Result<PromptAdmission, AgentManagerError> {
        self.prompt_with_outcome(thread_id, prompt, run_id, source_turn_id)
            .await
            .map_err(AgentOperationFailure::into_error)
    }

    #[cfg(test)]
    pub async fn prompt_with_outcome(
        &self,
        thread_id: &str,
        prompt: Vec<agent_client_protocol::v1::schema::ContentBlock>,
        run_id: String,
        source_turn_id: String,
    ) -> Result<PromptAdmission, AgentOperationFailure> {
        self.prompt_with_policy_outcome(
            thread_id,
            prompt,
            run_id,
            source_turn_id,
            ApprovalPolicy::Untrusted,
        )
        .await
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub async fn prompt_with_policy_outcome(
        &self,
        thread_id: &str,
        prompt: Vec<agent_client_protocol::v1::schema::ContentBlock>,
        run_id: String,
        source_turn_id: String,
        approval_policy: ApprovalPolicy,
    ) -> Result<PromptAdmission, AgentOperationFailure> {
        let (identity, session_id, connection) = self
            .route_thread(thread_id)
            .map_err(AgentOperationFailure::definitive)?;
        let (family, operations) = loop {
            let mut family = self.indexed_session_family(&identity).await;
            family.sort_by_key(AgentSessionId::encode);
            let mut operations = Vec::with_capacity(family.len());
            for family_identity in &family {
                operations.push(
                    self.session_operation_lock(&family_identity.encode())
                        .await
                        .lock_owned()
                        .await,
                );
            }
            let mut current = self.indexed_session_family(&identity).await;
            current.sort_by_key(AgentSessionId::encode);
            if current == family {
                break (family, operations);
            }
            drop(operations);
        };
        let (previous_policies, policy_updates) = {
            let mut index = self.session_index.lock().await;
            let previous_policies = family
                .iter()
                .map(|family_identity| {
                    index
                        .entries
                        .iter()
                        .find(|entry| {
                            entry.agent_id == family_identity.agent_id
                                && entry.acp_session_id == family_identity.acp_session_id
                        })
                        .map(|entry| (family_identity.clone(), entry.approval_policy))
                        .ok_or_else(|| {
                            AgentOperationFailure::definitive(AgentManagerError::SessionIndex(
                                "session family contains an unindexed session".to_string(),
                            ))
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let policy_updates = family
                .iter()
                .cloned()
                .map(|family_identity| (family_identity, approval_policy))
                .collect::<Vec<_>>();
            index
                .set_approval_policies(&policy_updates)
                .await
                .map_err(AgentOperationFailure::definitive)?;
            (previous_policies, policy_updates)
        };
        let policy_session_ids = policy_updates
            .iter()
            .map(|(family_identity, _)| SessionId::new(family_identity.acp_session_id.clone()))
            .collect();
        let result = connection
            .prompt_with_policy_for_sessions(
                PromptRequest::new(session_id, prompt),
                run_id,
                source_turn_id,
                approval_policy,
                policy_session_ids,
            )
            .await;
        if matches!(
            result,
            Err(AcpRuntimeError::SessionBusy | AcpRuntimeError::UnknownSession(_)),
        ) {
            self.session_index
                .lock()
                .await
                .set_approval_policies(&previous_policies)
                .await
                .map_err(AgentOperationFailure::definitive)?;
        }
        drop(operations);
        result.map_err(classify_runtime_operation_failure)
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    #[cfg_attr(
        all(test, dylint_lib = "perfectionist"),
        expect(
            perfectionist::excessive_cognitive_complexity,
            reason = "test barrier instrumentation pushes cognitive complexity above cap only under cfg(test)"
        )
    )]
    pub async fn set_all_session_approval_policies(
        &self,
        approval_policy: ApprovalPolicy,
    ) -> Result<(), AgentManagerError> {
        let (indexed_entries, pending_entries, identities, operations) = loop {
            let indexed_entries = self.session_index.lock().await.entries.clone();
            let pending_entries = self
                .pending_durable_sessions
                .lock()
                .await
                .values()
                .cloned()
                .collect::<Vec<_>>();
            let mut identities = indexed_entries
                .iter()
                .chain(&pending_entries)
                .map(|entry| {
                    AgentSessionId::new(&entry.agent_id, &entry.acp_session_id)
                        .map_err(|_| AgentManagerError::InvalidThreadId)
                })
                .collect::<Result<Vec<_>, _>>()?;
            identities.sort_by_key(AgentSessionId::encode);
            identities.dedup();
            #[cfg(test)]
            let snapshot_barrier = self.policy_snapshot_barrier.lock().await.take();
            #[cfg(test)]
            if let Some(barrier) = snapshot_barrier {
                barrier.reached.notify_one();
                barrier.release.notified().await;
            }
            let mut operations = Vec::with_capacity(identities.len());
            for identity in &identities {
                operations.push(
                    self.session_operation_lock(&identity.encode())
                        .await
                        .lock_owned()
                        .await,
                );
            }
            let current_indexed = self.session_index.lock().await.entries.clone();
            let current_pending = self
                .pending_durable_sessions
                .lock()
                .await
                .values()
                .cloned()
                .collect::<Vec<_>>();
            let mut current = current_indexed
                .iter()
                .chain(&current_pending)
                .map(|entry| {
                    AgentSessionId::new(&entry.agent_id, &entry.acp_session_id)
                        .map_err(|_| AgentManagerError::InvalidThreadId)
                })
                .collect::<Result<Vec<_>, _>>()?;
            current.sort_by_key(AgentSessionId::encode);
            current.dedup();
            if current == identities {
                break (current_indexed, current_pending, identities, operations);
            }
            drop(operations);
        };
        let updates = indexed_entries
            .iter()
            .map(|entry| {
                AgentSessionId::new(&entry.agent_id, &entry.acp_session_id)
                    .map(|identity| (identity, approval_policy))
                    .map_err(|_| AgentManagerError::InvalidThreadId)
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.session_index
            .lock()
            .await
            .set_existing_approval_policies(&updates)
            .await?;
        let mut pending = self.pending_durable_sessions.lock().await;
        for entry in pending_entries {
            let identity = AgentSessionId::new(&entry.agent_id, &entry.acp_session_id)
                .map_err(|_| AgentManagerError::InvalidThreadId)?;
            if let Some(current) = pending.get_mut(&identity.encode()) {
                current.approval_policy = approval_policy;
            }
        }
        drop(pending);

        let mut sessions_by_agent = BTreeMap::<AgentId, Vec<SessionId>>::new();
        for identity in identities {
            sessions_by_agent
                .entry(identity.agent_id)
                .or_default()
                .push(SessionId::new(identity.acp_session_id));
        }
        for (agent_id, session_ids) in sessions_by_agent {
            let result = match self.connection(&agent_id) {
                Ok(connection) => connection
                    .set_approval_policies(&session_ids, approval_policy)
                    .await
                    .map_err(AgentManagerError::from),
                Err(error) => Err(error),
            };
            if let Err(error) = result {
                eprintln!(
                    "approval policy was committed but live delivery to agent {agent_id} failed: {error}",
                );
            }
        }
        drop(operations);
        Ok(())
    }

    pub async fn cancel_turn(
        &self,
        thread_id: &str,
        expected_source_turn_id: &str,
    ) -> Result<(), AgentManagerError> {
        let (_, session_id, connection) = self.route_thread(thread_id)?;
        connection
            .cancel_turn(session_id, expected_source_turn_id)
            .await?;
        Ok(())
    }

    pub async fn prepare_steer(&self, thread_id: &str) -> Result<u64, AgentManagerError> {
        let (_, session_id, connection) = self.route_thread(thread_id)?;
        Ok(connection.prepare_steer(&session_id).await?)
    }

    pub async fn current_steer_epoch(&self, thread_id: &str) -> Result<u64, AgentManagerError> {
        let (_, session_id, connection) = self.route_thread(thread_id)?;
        Ok(connection.current_steer_epoch(&session_id).await?)
    }

    pub async fn verify_steer_epoch(
        &self,
        thread_id: &str,
        epoch: u64,
    ) -> Result<bool, AgentManagerError> {
        let (_, session_id, connection) = self.route_thread(thread_id)?;
        Ok(connection.verify_steer_epoch(&session_id, epoch).await?)
    }

    pub fn supports_steer(&self, thread_id: &str) -> Result<bool, AgentManagerError> {
        let (identity, _, connection) = self.route_thread(thread_id)?;
        let runtime = self
            .agents
            .get(&identity.agent_id)
            .ok_or_else(|| AgentManagerError::UnknownAgent(identity.agent_id.clone()))?;
        Ok(connection.negotiated().supports_session_steer()
            || harness_capabilities(runtime).session_steer)
    }

    pub fn supports_live_agent_message(&self, thread_id: &str) -> Result<bool, AgentManagerError> {
        let (identity, _, _) = self.route_thread(thread_id)?;
        let runtime = self
            .agents
            .get(&identity.agent_id)
            .ok_or_else(|| AgentManagerError::UnknownAgent(identity.agent_id.clone()))?;
        Ok(harness_capabilities(runtime).live_agent_message)
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub async fn deliver_live_agent_message(
        &self,
        thread_id: &str,
        expected_run_id: String,
        expected_source_turn_id: String,
        prompt_generation: u64,
        interaction_epoch: u64,
        prompt: Vec<agent_client_protocol::v1::schema::ContentBlock>,
    ) -> Result<HarnessAgentMessageOutcome, AgentOperationFailure> {
        let (identity, session_id, connection) = self
            .route_thread(thread_id)
            .map_err(AgentOperationFailure::definitive)?;
        let runtime = self.agents.get(&identity.agent_id).ok_or_else(|| {
            AgentOperationFailure::definitive(AgentManagerError::UnknownAgent(
                identity.agent_id.clone(),
            ))
        })?;
        if !harness_capabilities(runtime).live_agent_message {
            return Err(AgentOperationFailure::definitive(
                AcpRuntimeError::Unsupported("live agent messaging").into(),
            ));
        }
        self.flush_pending_durable_sessions()
            .await
            .map_err(AgentOperationFailure::definitive)?;
        if !connection
            .verify_steer_epoch(&session_id, interaction_epoch)
            .await
            .map_err(classify_runtime_operation_failure)?
        {
            return Err(AgentOperationFailure::definitive(
                AcpRuntimeError::Unsupported("stale agent-message interaction epoch").into(),
            ));
        }
        let session = connection.session(&session_id).await.ok_or_else(|| {
            AgentOperationFailure::definitive(
                AcpRuntimeError::UnknownSession(session_id.to_string()).into(),
            )
        })?;
        if session.operation().await
            != Some((expected_run_id, expected_source_turn_id, prompt_generation))
        {
            return Err(AgentOperationFailure::definitive(
                AcpRuntimeError::Unsupported("stale agent-message correlation").into(),
            ));
        }
        let promote_blocking_subagents = session.snapshot().await.has_active_subagent_tool();
        let (harness, context) = self
            .harness_session_context(&identity, session_id)
            .await
            .map_err(AgentOperationFailure::definitive)?;
        harness
            .deliver_agent_message(
                &context,
                HarnessAgentMessageRequest {
                    prompt,
                    promote_blocking_subagents,
                },
            )
            .await
            .map_err(classify_harness_operation_failure)
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub async fn steer(
        &self,
        thread_id: &str,
        expected_run_id: String,
        expected_source_turn_id: String,
        prompt_generation: u64,
        interaction_epoch: u64,
        prompt: Vec<agent_client_protocol::v1::schema::ContentBlock>,
    ) -> Result<(), AgentManagerError> {
        let (identity, session_id, connection) = self.route_thread(thread_id)?;
        let transcript_prompt = prompt.clone();
        if connection.negotiated().supports_session_steer() {
            connection
                .steer(
                    SteerRequest {
                        session_id: session_id.clone(),
                        expected_run_id: expected_run_id.clone(),
                        expected_source_turn_id: expected_source_turn_id.clone(),
                        prompt_generation,
                        prompt,
                    },
                    interaction_epoch,
                )
                .await?;
            if let Some(session) = connection.session(&session_id).await {
                let snapshot = session.snapshot().await;
                session
                    .emit_prompt_transcript(
                        &transcript_prompt,
                        Some(expected_run_id),
                        Some(expected_source_turn_id.clone()),
                        Some(prompt_generation),
                        format!(
                            "{}::user::{}::steer::{prompt_generation}",
                            snapshot.thread_id, expected_source_turn_id,
                        ),
                    )
                    .await;
            }
            return Ok(());
        }

        self.flush_pending_durable_sessions().await?;
        if !connection
            .verify_steer_epoch(&session_id, interaction_epoch)
            .await?
        {
            return Err(AcpRuntimeError::Unsupported("stale steer interaction epoch").into());
        }
        let runtime = self
            .agents
            .get(&identity.agent_id)
            .ok_or_else(|| AgentManagerError::UnknownAgent(identity.agent_id.clone()))?;
        if !harness_capabilities(runtime).session_steer {
            return Err(AcpRuntimeError::Unsupported("session/steer").into());
        }
        let (harness, context) = self
            .harness_session_context(&identity, session_id.clone())
            .await?;
        let session = connection
            .session(&session_id)
            .await
            .ok_or_else(|| AcpRuntimeError::UnknownSession(session_id.to_string()))?;
        session
            .reserve_handoff(
                &expected_run_id,
                &expected_source_turn_id,
                prompt_generation,
            )
            .await
            .map_err(AcpRuntimeError::Unsupported)?;
        if let Err(error) = harness
            .steer(&context, HarnessSteerRequest { prompt })
            .await
        {
            session.release_handoff().await;
            return Err(error.into());
        }
        let generation = match session
            .admit_handoff(expected_run_id.clone(), expected_source_turn_id.clone())
            .await
        {
            Ok((generation, _)) => generation,
            Err(error) => {
                session.release_handoff().await;
                return Err(AcpRuntimeError::Unsupported(error).into());
            }
        };
        let snapshot = session.snapshot().await;
        session
            .emit_prompt_transcript(
                &transcript_prompt,
                Some(expected_run_id.clone()),
                Some(expected_source_turn_id.clone()),
                Some(generation),
                format!(
                    "{}::user::{}::steer::{generation}",
                    snapshot.thread_id, expected_source_turn_id,
                ),
            )
            .await;
        tokio::spawn(async move {
            if let Err(error) = harness.wait_until_idle(&context).await {
                session
                    .fail_generation(
                        expected_run_id,
                        expected_source_turn_id,
                        generation,
                        error.to_string(),
                    )
                    .await;
                return;
            }
            let snapshot = session.snapshot().await;
            session
                .emit(CanonicalEvent::RunFinished {
                    agent_id: snapshot.agent_id,
                    thread_id: snapshot.thread_id,
                    run_id: expected_run_id,
                    source_turn_id: expected_source_turn_id,
                    generation,
                    stop_reason: agent_client_protocol::v1::schema::StopReason::EndTurn,
                })
                .await;
        });
        Ok(())
    }

    pub async fn resolve_permission_with_outcome(
        &self,
        thread_id: &str,
        request_id: &str,
        option_id: &str,
    ) -> Result<(), AgentOperationFailure> {
        let (_, _, connection) = self
            .route_thread(thread_id)
            .map_err(AgentOperationFailure::definitive)?;
        connection
            .resolve_permission(thread_id, request_id, option_id)
            .await
            .map_err(classify_runtime_operation_failure)?;
        Ok(())
    }

    pub async fn cancel_permission_with_outcome(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), AgentOperationFailure> {
        let (_, _, connection) = self
            .route_thread(thread_id)
            .map_err(AgentOperationFailure::definitive)?;
        connection
            .cancel_permission(thread_id, request_id)
            .await
            .map_err(classify_runtime_operation_failure)?;
        Ok(())
    }

    pub async fn pending_permissions(&self) -> Vec<PendingPermissionSummary> {
        let mut pending = Vec::new();
        for runtime in self.agents.values() {
            if let Some(connection) = &runtime.connection {
                pending.extend(connection.pending_permissions().await);
            }
        }
        pending.sort_by_key(|request| request.requested_order);
        pending.truncate(MAX_SESSIONS);
        pending
    }

    pub async fn pending_elicitations(&self) -> Vec<PendingElicitationSummary> {
        let mut pending = Vec::new();
        for runtime in self.agents.values() {
            if let Some(connection) = &runtime.connection {
                pending.extend(connection.pending_elicitations().await);
            }
        }
        pending.sort_by_key(|request| request.requested_order);
        pending.truncate(MAX_SESSIONS);
        pending
    }

    pub async fn accept_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
        values: BTreeMap<String, ElicitationContentValue>,
    ) -> Result<(), AgentManagerError> {
        let (_, _, connection) = self.route_thread(thread_id)?;
        connection
            .accept_elicitation(thread_id, request_id, values)
            .await?;
        Ok(())
    }

    pub async fn decline_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), AgentManagerError> {
        let (_, _, connection) = self.route_thread(thread_id)?;
        connection
            .decline_elicitation(thread_id, request_id)
            .await?;
        Ok(())
    }

    pub async fn cancel_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), AgentManagerError> {
        let (_, _, connection) = self.route_thread(thread_id)?;
        connection.cancel_elicitation(thread_id, request_id).await?;
        Ok(())
    }

    pub async fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(config) = self.agent_messaging.get() {
            config.revoke_all();
        }
        for runtime in self.agents.values() {
            if let Some(connection) = &runtime.connection {
                if connection.shutdown().await.is_err() {
                    eprintln!("ACP agent shutdown failed (details redacted)");
                }
            }
        }
    }

    pub async fn flush_events(&self) {
        if let Err(error) = self.flush_pending_durable_sessions().await {
            eprintln!("{error}");
        }
        let tracked = self.tracked_sessions.lock().await.clone();
        for thread_id in tracked.keys() {
            let Ok((_, session_id, connection)) = self.route_thread(thread_id) else {
                continue;
            };
            if let Some(session) = connection.session(&session_id).await {
                session.flush_events().await;
            }
        }
        let _ = self.events.flush().await;
    }

    fn connection(&self, agent_id: &str) -> Result<&AcpConnection, AgentManagerError> {
        let runtime = self
            .agents
            .get(agent_id)
            .ok_or_else(|| AgentManagerError::UnknownAgent(agent_id.to_string()))?;
        runtime
            .connection
            .as_ref()
            .ok_or_else(|| AgentManagerError::AgentUnavailable(agent_id.to_string()))
    }

    async fn agent_relation_session(&self, entry: &SessionIndexEntry) -> AgentRelationSession {
        let connection = self
            .agents
            .get(&entry.agent_id)
            .filter(|runtime| matches!(runtime.lifecycle, AgentLifecycle::Ready))
            .and_then(|runtime| runtime.connection.clone());
        let status = match connection {
            Some(connection) => match connection
                .session(&SessionId::new(entry.acp_session_id.clone()))
                .await
            {
                Some(session) if session.snapshot().await.active_run_id.is_some() => {
                    AgentRelationStatus::Running
                }
                Some(_) => AgentRelationStatus::Idle,
                None => AgentRelationStatus::Unloaded,
            },
            None => AgentRelationStatus::Unavailable,
        };
        let identity = AgentSessionId::new(&entry.agent_id, &entry.acp_session_id)
            .expect("durable session index contains validated identities");
        AgentRelationSession {
            thread_id: identity.encode(),
            title: entry.title.clone(),
            status,
        }
    }

    fn route_thread(
        &self,
        thread_id: &str,
    ) -> Result<(AgentSessionId, SessionId, &AcpConnection), AgentManagerError> {
        let identity =
            AgentSessionId::decode(thread_id).map_err(|_| AgentManagerError::InvalidThreadId)?;
        let connection = self.connection(&identity.agent_id)?;
        let session_id = SessionId::new(identity.acp_session_id.clone());
        Ok((identity, session_id, connection))
    }

    async fn session_operation_lock(&self, thread_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.reconstruction_locks.lock().await;
        locks
            .entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn prune_session_operation_lock(&self, thread_id: &str) {
        let mut locks = self.reconstruction_locks.lock().await;
        let can_remove = locks
            .get(thread_id)
            .is_some_and(|lock| Arc::strong_count(lock) == 1);
        if can_remove {
            locks.remove(thread_id);
        }
    }

    async fn apply_entry_approval_policies_locked(
        &self,
        entries: &[SessionIndexEntry],
    ) -> Result<(), AgentManagerError> {
        let mut first_error = None;
        for entry in entries {
            let identity = match AgentSessionId::new(&entry.agent_id, &entry.acp_session_id) {
                Ok(identity) => identity,
                Err(_) => {
                    first_error.get_or_insert(AgentManagerError::InvalidThreadId);
                    continue;
                }
            };
            let result = match self.connection(&identity.agent_id) {
                Ok(connection) => connection
                    .set_approval_policy(
                        &SessionId::new(identity.acp_session_id),
                        entry.approval_policy,
                    )
                    .await
                    .map_err(AgentManagerError::from),
                Err(error) => Err(error),
            };
            if first_error.is_none() {
                first_error = result.err();
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    async fn persist_inherited_entries(
        &self,
        entries: &[SessionIndexEntry],
    ) -> Result<(), AgentManagerError> {
        let mut thread_ids = entries
            .iter()
            .flat_map(|entry| {
                [
                    Some(entry.acp_session_id.as_str()),
                    entry.parent_acp_session_id.as_deref(),
                ]
                .into_iter()
                .flatten()
                .map(|session_id| {
                    AgentSessionId::new(&entry.agent_id, session_id)
                        .map(|identity| identity.encode())
                        .map_err(|_| AgentManagerError::InvalidThreadId)
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        thread_ids.sort();
        thread_ids.dedup();
        let mut operations = Vec::with_capacity(thread_ids.len());
        for thread_id in thread_ids {
            operations.push(
                self.session_operation_lock(&thread_id)
                    .await
                    .lock_owned()
                    .await,
            );
        }
        let result = self.persist_inherited_entries_locked(entries).await;
        drop(operations);
        result
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_nesting,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn persist_inherited_entries_locked(
        &self,
        entries: &[SessionIndexEntry],
    ) -> Result<(), AgentManagerError> {
        let entries = {
            let mut index = self.session_index.lock().await;
            let mut entries = entries.to_vec();
            for entry in &mut entries {
                let existing = index
                    .entries
                    .iter()
                    .find(|existing| {
                        existing.agent_id == entry.agent_id
                            && existing.acp_session_id == entry.acp_session_id
                    })
                    .cloned();
                if let Some(existing) = existing.as_ref() {
                    if existing.parent_acp_session_id.is_some()
                        && existing.parent_acp_session_id != entry.parent_acp_session_id
                    {
                        *entry = existing.clone();
                        continue;
                    }
                }
                let Some(parent_id) = entry.parent_acp_session_id.as_deref() else {
                    continue;
                };
                let parent = index
                    .entries
                    .iter()
                    .find(|parent| {
                        parent.agent_id == entry.agent_id && parent.acp_session_id == parent_id
                    })
                    .ok_or_else(|| {
                        AgentManagerError::SessionIndex(
                            "parent session is no longer indexed".to_string(),
                        )
                    })?;
                entry.approval_policy = parent.approval_policy;
            }
            index.insert_inherited_entries(entries.clone()).await?;
            entries
        };
        self.apply_entry_approval_policies_locked(&entries).await
    }

    #[cfg(test)]
    async fn track_session(
        &self,
        identity: AgentSessionId,
        cwd: PathBuf,
    ) -> Result<(), AgentManagerError> {
        self.track_session_with_policy(identity, cwd, ApprovalPolicy::Untrusted)
            .await
    }

    async fn track_session_with_policy(
        &self,
        identity: AgentSessionId,
        cwd: PathBuf,
        approval_policy: ApprovalPolicy,
    ) -> Result<(), AgentManagerError> {
        let operation = self
            .session_operation_lock(&identity.encode())
            .await
            .lock_owned()
            .await;
        let result = self
            .track_session_with_policy_locked(identity, cwd, approval_policy)
            .await;
        drop(operation);
        result
    }

    async fn track_session_with_policy_locked(
        &self,
        identity: AgentSessionId,
        cwd: PathBuf,
        approval_policy: ApprovalPolicy,
    ) -> Result<(), AgentManagerError> {
        self.register_session_events(&identity).await;
        let thread_id = identity.encode();
        let entry = index_entry_with_policy(identity, cwd, approval_policy);
        self.pending_durable_sessions
            .lock()
            .await
            .insert(thread_id.clone(), entry.clone());
        self.session_index
            .lock()
            .await
            .insert_all(std::iter::once(entry.clone()))
            .await?;
        let mut pending = self.pending_durable_sessions.lock().await;
        if pending.get(&thread_id) == Some(&entry) {
            pending.remove(&thread_id);
        }
        Ok(())
    }

    async fn flush_pending_durable_sessions(&self) -> Result<(), AgentManagerError> {
        let mut pending_thread_ids = self
            .pending_durable_sessions
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        pending_thread_ids.sort();
        let mut operations = Vec::with_capacity(pending_thread_ids.len());
        for thread_id in &pending_thread_ids {
            operations.push(
                self.session_operation_lock(thread_id)
                    .await
                    .lock_owned()
                    .await,
            );
        }
        let pending = self
            .pending_durable_sessions
            .lock()
            .await
            .iter()
            .filter(|(thread_id, _)| pending_thread_ids.binary_search(thread_id).is_ok())
            .map(|(_, entry)| entry.clone())
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return Ok(());
        }
        self.session_index
            .lock()
            .await
            .insert_all(pending.clone())
            .await?;
        self.pending_durable_sessions
            .lock()
            .await
            .retain(|_, entry| !pending.contains(entry));
        drop(operations);
        Ok(())
    }

    async fn register_session_events(&self, identity: &AgentSessionId) {
        let thread_id = identity.encode();
        let Ok(connection) = self.connection(&identity.agent_id) else {
            return;
        };
        let session_id = SessionId::new(identity.acp_session_id.clone());
        let Some(session) = connection.session(&session_id).await else {
            return;
        };
        let instance_id = session.instance_id();
        let Some(receiver) = session.take_events().await else {
            return;
        };
        self.tracked_sessions
            .lock()
            .await
            .insert(thread_id.clone(), instance_id);
        let events = self.events.clone();
        let tracked_sessions = self.tracked_sessions.clone();
        tokio::spawn(forward_session_events(
            receiver,
            events,
            tracked_sessions,
            thread_id,
            instance_id,
        ));
    }

    fn validate_cwd(&self, cwd: &Path) -> Result<PathBuf, AgentManagerError> {
        let candidate = if cwd.is_absolute() {
            cwd.to_path_buf()
        } else {
            self.workspace_root.join(cwd)
        };
        let canonical = std::fs::canonicalize(&candidate).map_err(|error| {
            AgentManagerError::SessionIndex(format!(
                "session workspace is invalid or inaccessible ({}): {error}",
                candidate.to_string_lossy(),
            ))
        })?;
        if !canonical.is_dir()
            || (!self.allow_outside_root_cwd && !canonical.starts_with(&self.workspace_root))
        {
            return Err(AgentManagerError::SessionIndex(
                "session workspace is outside the allowed root or is not a directory".to_string(),
            ));
        }
        if canonical.as_os_str().len() > MAX_SESSION_CWD_BYTES {
            return Err(AgentManagerError::SessionIndex(
                "session workspace path exceeds the durable index limit".to_string(),
            ));
        }
        Ok(canonical)
    }

    async fn read_known_session(
        &self,
        agent_id: &str,
        session_id: &SessionId,
    ) -> Result<ManagedSession, AgentManagerError> {
        self.read_known_session_from(self.connection(agent_id)?, session_id)
            .await
    }

    async fn opencode_session_summaries(
        &self,
        runtime: &AgentRuntime,
    ) -> HashMap<String, OpenCodeSessionSummary> {
        if runtime.harness.is_none() {
            return HashMap::new();
        }
        let mut command = AsyncCommand::new(&runtime.manifest.resolved.executable);
        command
            .args(["session", "list", "--format", "json", "--max-count", "100"])
            .current_dir(&self.workspace_root)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for name in ["PATH", "HOME", "TMPDIR", "LANG", "XDG_CONFIG_HOME"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let Ok(child) = command.spawn() else {
            return HashMap::new();
        };
        let Ok(Ok(output)) =
            tokio::time::timeout(OPENCODE_SESSION_CATALOG_TIMEOUT, child.wait_with_output()).await
        else {
            return HashMap::new();
        };
        if !output.status.success() || output.stdout.len() > MAX_OPENCODE_SESSION_CATALOG_BYTES {
            return HashMap::new();
        }
        let Ok(rows) = serde_json::from_slice::<Vec<OpenCodeSessionCatalogRow>>(&output.stdout)
        else {
            return HashMap::new();
        };
        rows.into_iter()
            .filter_map(|row| {
                let id = row.id.trim().to_ascii_lowercase();
                if id.is_empty() || id.len() > 1_024 {
                    return None;
                }
                let title = row.title.and_then(|title| {
                    let title = title.trim();
                    (!title.is_empty() && title.len() <= 512).then(|| title.to_string())
                });
                let updated_at = row.updated.or(row.created).and_then(milliseconds_to_iso);
                Some((id, OpenCodeSessionSummary { title, updated_at }))
            })
            .collect()
    }

    async fn apply_config_options(
        &self,
        connection: &AcpConnection,
        session_id: &SessionId,
        config_options: Option<Vec<agent_client_protocol::v1::schema::SessionConfigOption>>,
    ) -> Result<(), AgentManagerError> {
        let Some(config_options) = config_options.filter(|options| !options.is_empty()) else {
            return Ok(());
        };
        let session = connection
            .session(session_id)
            .await
            .ok_or_else(|| AcpRuntimeError::UnknownSession(session_id.to_string()))?;
        let snapshot = session.snapshot().await;
        session
            .emit(CanonicalEvent::Config {
                agent_id: snapshot.agent_id,
                thread_id: snapshot.thread_id,
                entries: super::handlers::config_entries(config_options),
            })
            .await;
        Ok(())
    }

    /// Captures the session's selectable configuration (model, mode, thought level, ...) so it can
    /// survive a resume/load: some agents answer those requests with a freshly defaulted config,
    /// which would otherwise silently discard the user's choices.
    async fn configured_selections(
        &self,
        connection: &AcpConnection,
        session_id: &SessionId,
    ) -> Vec<(String, String)> {
        let Some(session) = connection.session(session_id).await else {
            return Vec::new();
        };
        session
            .snapshot()
            .await
            .config
            .into_iter()
            .filter(|entry| !entry.options.is_empty())
            .map(|entry| (entry.id, entry.value))
            .collect()
    }

    async fn restore_configured_selections(
        &self,
        connection: &AcpConnection,
        session_id: &SessionId,
        selections: &[(String, String)],
    ) {
        for (option_id, value) in selections {
            let Some(session) = connection.session(session_id).await else {
                return;
            };
            let Some(option) = session
                .snapshot()
                .await
                .config
                .into_iter()
                .find(|entry| &entry.id == option_id)
            else {
                continue;
            };
            if &option.value == value || !option.options.iter().any(|choice| &choice.value == value)
            {
                continue;
            }
            let restored = connection
                .set_session_config_option(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    option_id.clone(),
                    SessionConfigOptionValue::value_id(value.clone()),
                ))
                .await;
            match restored {
                Ok(response) => {
                    if let Err(error) = self
                        .apply_config_options(connection, session_id, Some(response.config_options))
                        .await
                    {
                        eprintln!(
                            "warning: failed to publish restored session config option {option_id}: {error}",
                        );
                    }
                }
                Err(error) => {
                    eprintln!(
                        "warning: failed to restore session config option {option_id} after resume: {error}",
                    );
                }
            }
        }
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::excessive_nesting,
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn read_known_session_from(
        &self,
        connection: &AcpConnection,
        session_id: &SessionId,
    ) -> Result<ManagedSession, AgentManagerError> {
        let session = connection
            .session(session_id)
            .await
            .ok_or_else(|| AcpRuntimeError::UnknownSession(session_id.to_string()))?;
        let mut snapshot = session.snapshot().await;
        let identity = AgentSessionId::decode(&snapshot.thread_id)
            .map_err(|_| AgentManagerError::InvalidThreadId)?;
        let entry = self
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| {
                entry.agent_id == identity.agent_id
                    && entry.acp_session_id == identity.acp_session_id
            })
            .cloned()
            .ok_or_else(|| {
                AgentManagerError::SessionIndex(
                    "session has no durable canonical workspace path".to_string(),
                )
            })?;
        if entry.forked_from_acp_session_id.is_none() {
            self.adopt_snapshot_subagents(&snapshot, &entry.cwd).await?;
            self.adopt_exported_subagents(&identity, &entry.cwd).await?;
        }
        // Agent-message activities are a durable overlay, not proof that the agent replayed its
        // conversation. An activity-only snapshot still needs its ordinary transcript hydrated.
        if !snapshot.has_ordinary_transcript() {
            self.seed_exported_session(&identity, &entry.cwd, &session)
                .await;
            snapshot = session.snapshot().await;
        }
        if let Some(title) = &entry.title {
            snapshot.title = Some(title.clone());
        } else if snapshot.title.is_none() || snapshot.updated_at.is_none() {
            if let Some(runtime) = self.agents.get(&identity.agent_id) {
                let summaries = self.opencode_session_summaries(runtime).await;
                if let Some(summary) = summaries.get(&identity.acp_session_id.to_ascii_lowercase())
                {
                    if snapshot.title.is_none() {
                        snapshot.title = summary.title.clone();
                    }
                    if snapshot.updated_at.is_none() {
                        snapshot.updated_at = summary.updated_at.clone();
                    }
                }
            }
        }
        let parent_thread_id = parent_thread_id(&entry);
        self.reconcile_received_agent_messages(&snapshot).await;
        self.apply_agent_message_journal(&mut snapshot).await;
        Ok(ManagedSession {
            thread_id: snapshot.thread_id.clone(),
            agent_id: snapshot.agent_id.clone(),
            cwd: entry.cwd,
            parent_thread_id,
            snapshot,
        })
    }

    async fn adopt_snapshot_subagents(
        &self,
        snapshot: &SessionSnapshot,
        cwd: &Path,
    ) -> Result<(), AgentManagerError> {
        let parent = AgentSessionId::decode(&snapshot.thread_id)
            .map_err(|_| AgentManagerError::InvalidThreadId)?;
        let approval_policy = self
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| {
                entry.agent_id == parent.agent_id && entry.acp_session_id == parent.acp_session_id
            })
            .map(|entry| entry.approval_policy)
            .unwrap_or_default();
        let entries = snapshot
            .tools
            .values()
            .filter_map(|tool| snapshot_task_session_id(&tool.content))
            .filter_map(|session_id| {
                AgentSessionId::new(parent.agent_id.clone(), session_id)
                    .ok()
                    .filter(|child| child.acp_session_id != parent.acp_session_id)
            })
            .map(|child| SessionIndexEntry {
                agent_id: child.agent_id,
                acp_session_id: child.acp_session_id,
                cwd: cwd.to_path_buf(),
                approval_policy,
                title: None,
                parent_acp_session_id: Some(parent.acp_session_id.clone()),
                forked_from_acp_session_id: None,
            })
            .collect::<Vec<_>>();
        if !entries.is_empty() {
            self.persist_inherited_entries(&entries).await?;
        }
        Ok(())
    }

    async fn adopt_exported_subagents(
        &self,
        parent: &AgentSessionId,
        cwd: &Path,
    ) -> Result<(), AgentManagerError> {
        let approval_policy = self
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| {
                entry.agent_id == parent.agent_id && entry.acp_session_id == parent.acp_session_id
            })
            .map(|entry| entry.approval_policy)
            .unwrap_or_default();
        let entries = self
            .opencode_related_sessions(parent, cwd)
            .await
            .into_iter()
            .filter_map(|related| {
                AgentSessionId::new(parent.agent_id.clone(), related.session_id)
                    .ok()
                    .filter(|child| child.acp_session_id != parent.acp_session_id)
                    .map(|child| SessionIndexEntry {
                        agent_id: child.agent_id,
                        acp_session_id: child.acp_session_id,
                        cwd: cwd.to_path_buf(),
                        approval_policy,
                        title: related.title.filter(|title| valid_session_title(title)),
                        parent_acp_session_id: Some(parent.acp_session_id.clone()),
                        forked_from_acp_session_id: None,
                    })
            })
            .collect::<Vec<_>>();
        if !entries.is_empty() {
            self.persist_inherited_entries(&entries).await?;
        }
        Ok(())
    }

    async fn opencode_related_sessions(
        &self,
        parent: &AgentSessionId,
        cwd: &Path,
    ) -> Vec<OpenCodeRelatedSession> {
        let Some(document) = self.opencode_export(parent, cwd).await else {
            return Vec::new();
        };
        parse_opencode_related_sessions(document)
    }

    async fn opencode_export(
        &self,
        identity: &AgentSessionId,
        cwd: &Path,
    ) -> Option<OpenCodeExportDocument> {
        let runtime = self.agents.get(&identity.agent_id)?;
        runtime.harness.as_ref()?;
        let mut command = AsyncCommand::new(&runtime.manifest.resolved.executable);
        command
            .args(["export", &identity.acp_session_id])
            .current_dir(cwd)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for name in ["PATH", "HOME", "TMPDIR", "LANG", "XDG_CONFIG_HOME"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let Ok(child) = command.spawn() else {
            return None;
        };
        let Ok(Ok(output)) =
            tokio::time::timeout(OPENCODE_EXPORT_TIMEOUT, child.wait_with_output()).await
        else {
            return None;
        };
        if !output.status.success() || output.stdout.len() > MAX_OPENCODE_EXPORT_BYTES {
            return None;
        }
        serde_json::from_slice(&output.stdout).ok()
    }

    async fn seed_exported_session(
        &self,
        identity: &AgentSessionId,
        cwd: &Path,
        session: &super::session::AcpSession,
    ) {
        let Some(document) = self.opencode_export(identity, cwd).await else {
            return;
        };
        session
            .seed_history(exported_session_events(identity, document))
            .await;
    }
}

fn snapshot_task_session_id(content: &str) -> Option<String> {
    let header = content
        .trim_start()
        .strip_prefix("<task ")?
        .split_once('>')?
        .0;
    let marker = r#"id=""#;
    let value = header.split_once(marker)?.1.split_once('"')?.0.trim();
    (!value.is_empty() && value.len() <= 1_024).then(|| value.to_string())
}

fn parse_opencode_related_sessions(
    document: OpenCodeExportDocument,
) -> Vec<OpenCodeRelatedSession> {
    let mut related = document
        .messages
        .into_iter()
        .flat_map(|message| message.parts)
        .filter(|part| part.part_type == "tool")
        .filter(|part| part.tool.as_deref() == Some("task"))
        .filter_map(|part| {
            let state = part.state?;
            let session_id = state
                .metadata
                .and_then(|metadata| metadata.session_id)
                .or_else(|| state.output.as_deref().and_then(snapshot_task_session_id))?;
            let title = state
                .input
                .and_then(|input| input.description)
                .map(|title| title.trim().to_string())
                .filter(|title| valid_session_title(title));
            Some(OpenCodeRelatedSession { session_id, title })
        })
        .collect::<Vec<_>>();
    related.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    related.dedup_by(|left, right| left.session_id == right.session_id);
    related.truncate(128);
    related
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn exported_session_events(
    identity: &AgentSessionId,
    document: OpenCodeExportDocument,
) -> Vec<CanonicalEvent> {
    let thread_id = identity.encode();
    let mut events = Vec::new();
    for message in document.messages {
        for (index, part) in message.parts.into_iter().enumerate() {
            let canonical_id = format!(
                "export:{}:{}",
                message.info.id,
                part.id.unwrap_or_else(|| index.to_string()),
            );
            let role = match (message.info.role.as_str(), part.part_type.as_str()) {
                (_, "reasoning") => Some(MessageRole::Thought),
                ("user", "text") => Some(MessageRole::User),
                ("assistant", "text") => Some(MessageRole::Agent),
                _ => None,
            };
            if let (Some(role), Some(text)) = (role, part.text.as_deref()) {
                if !text.trim().is_empty() {
                    events.push(CanonicalEvent::MessageChunk {
                        agent_id: identity.agent_id.clone(),
                        thread_id: thread_id.clone(),
                        run_id: None,
                        source_turn_id: None,
                        generation: None,
                        role,
                        message_id: canonical_id,
                        content: text.to_string(),
                        content_block: None,
                    });
                }
                continue;
            }
            if part.part_type == "tool" {
                let Some(state) = part.state else {
                    continue;
                };
                let status = match state.status.as_deref() {
                    Some("completed") => {
                        agent_client_protocol::v1::schema::ToolCallStatus::Completed
                    }
                    Some("error") => agent_client_protocol::v1::schema::ToolCallStatus::Failed,
                    Some("running") => {
                        agent_client_protocol::v1::schema::ToolCallStatus::InProgress
                    }
                    _ => agent_client_protocol::v1::schema::ToolCallStatus::Pending,
                };
                let content = state.output.or(state.error).unwrap_or_default();
                events.push(CanonicalEvent::Tool {
                    agent_id: identity.agent_id.clone(),
                    thread_id: thread_id.clone(),
                    run_id: None,
                    source_turn_id: None,
                    generation: None,
                    tool_call_id: canonical_id,
                    kind: agent_client_protocol::v1::schema::ToolKind::Other,
                    status,
                    title: state
                        .title
                        .or(part.tool)
                        .unwrap_or_else(|| "tool".to_string()),
                    content: FieldUpdate::Set(content),
                    structured_content: FieldUpdate::Set(Vec::new()),
                    locations: FieldUpdate::Set(Vec::new()),
                });
            }
        }
    }
    events
}

fn valid_session_title(title: &str) -> bool {
    let title = title.trim();
    !title.is_empty() && title.len() <= 256 && !title.chars().any(char::is_control)
}

fn parent_thread_id(entry: &SessionIndexEntry) -> Option<String> {
    entry
        .parent_acp_session_id
        .as_ref()
        .and_then(|parent| AgentSessionId::new(&entry.agent_id, parent).ok())
        .map(|identity| identity.encode())
}

fn milliseconds_to_iso(milliseconds: u64) -> Option<String> {
    let milliseconds = i64::try_from(milliseconds).ok()?;
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
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
fn parse_opencode_model_catalog(bytes: &[u8]) -> Vec<HarnessModelCatalogEntry> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Vec::new();
    };
    let mut models = Vec::new();
    let mut object_start: Option<usize> = None;
    let mut depth = 0usize;
    for (index, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        let byte_offset = text
            .lines()
            .take(index)
            .map(|previous| previous.len() + 1)
            .sum::<usize>();
        if object_start.is_none() && trimmed.starts_with('{') {
            object_start = Some(byte_offset);
            depth = 0;
        }
        if object_start.is_some() {
            depth = depth.saturating_add(trimmed.bytes().filter(|byte| *byte == b'{').count());
            depth = depth.saturating_sub(trimmed.bytes().filter(|byte| *byte == b'}').count());
            if depth == 0 {
                let start = object_start.take().unwrap_or(byte_offset);
                let end = byte_offset.saturating_add(line.len());
                if let Ok(document) =
                    serde_json::from_str::<OpenCodeModelCatalogDocument>(&text[start..end])
                {
                    let id = format!("{}/{}", document.provider_id, document.id);
                    let display_name = if document.name.trim().is_empty() {
                        id.clone()
                    } else {
                        document.name
                    };
                    let mut reasoning_effort = if document
                        .capabilities
                        .as_ref()
                        .and_then(|capabilities| capabilities.reasoning)
                        .unwrap_or(false)
                    {
                        document
                            .variants
                            .unwrap_or_default()
                            .into_keys()
                            .filter(|value| {
                                matches!(
                                    value.as_str(),
                                    "none"
                                        | "minimal"
                                        | "low"
                                        | "medium"
                                        | "high"
                                        | "xhigh"
                                        | "max",
                                )
                            })
                            .collect()
                    } else {
                        Vec::new()
                    };
                    reasoning_effort.sort();
                    models.push(HarnessModelCatalogEntry {
                        id,
                        display_name,
                        provider_id: document.provider_id.clone(),
                        provider_name: document.provider_id,
                        context_window: document.limit.and_then(|limit| limit.context),
                        reasoning_effort,
                    });
                }
            }
        }
    }
    models.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    models.truncate(128);
    models
}

fn remove_session_event_registration(
    tracked: &mut HashMap<String, Uuid>,
    thread_id: &str,
    instance_id: Uuid,
) -> bool {
    if tracked.get(thread_id) != Some(&instance_id) {
        return false;
    }
    tracked.remove(thread_id);
    true
}

async fn forward_session_events(
    mut receiver: CanonicalEventReceiver,
    events: CanonicalEventSender,
    tracked_sessions: Arc<Mutex<HashMap<String, Uuid>>>,
    thread_id: String,
    instance_id: Uuid,
) {
    while let Some(event) = receiver.recv().await {
        if events.send(event).await.is_err() {
            eprintln!("ACP manager canonical event mailbox closed during session forwarding");
            break;
        }
    }
    let mut tracked = tracked_sessions.lock().await;
    remove_session_event_registration(&mut tracked, &thread_id, instance_id);
}

fn harness_fork_boundary_message(message: ForkBoundaryMessage) -> HarnessForkBoundaryMessage {
    HarnessForkBoundaryMessage {
        first_text: message.first_text,
        first_text_truncated: message.first_text_truncated,
        raw_message_id_hint: message.raw_message_id_hint,
    }
}

fn harness_capabilities(runtime: &AgentRuntime) -> super::harness::HarnessCapabilities {
    runtime
        .harness
        .as_ref()
        .map(|harness| {
            harness.capabilities(&HarnessContext {
                manifest: &runtime.manifest.resolved,
                http_base: runtime.http_base.as_deref(),
            })
        })
        .unwrap_or_default()
}

fn capabilities(runtime: &AgentRuntime) -> AgentCapabilities {
    let native = runtime
        .negotiated
        .as_ref()
        .map(NegotiatedInitialize::native_capabilities)
        .unwrap_or_default();
    let harness = harness_capabilities(runtime);
    AgentCapabilities {
        session_list: native.session_list,
        session_load: native.session_load,
        session_resume: native.session_resume,
        session_steer: native.session_steer || harness.session_steer,
        session_fork: native.session_fork || harness.session_fork,
        session_delete: native.session_delete || harness.session_delete,
    }
}

fn decode_cursor(cursor: Option<&str>) -> Result<usize, AgentManagerError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    cursor
        .strip_prefix("v1.")
        .and_then(|value| URL_SAFE_NO_PAD.decode(value).ok())
        .filter(|value| value.len() == std::mem::size_of::<u64>())
        .map(<[u8; 8]>::try_from)
        .map(|bytes| bytes.expect("cursor length checked"))
        .map(u64::from_be_bytes)
        .map(usize::try_from)
        .and_then(Result::ok)
        .filter(|value| *value <= MAX_SESSIONS)
        .ok_or(AgentManagerError::InvalidCursor)
}

fn encode_cursor(offset: usize) -> String {
    format!(
        "v1.{}",
        URL_SAFE_NO_PAD.encode((offset as u64).to_be_bytes()),
    )
}

fn redact_error(error: &AcpRuntimeError) -> String {
    let _ = (error, MAX_ERROR_BYTES);
    "ACP agent startup failed (details redacted)".to_string()
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "manager_tests.rs"]
mod tests;
