use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
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
const MAX_PAGE_SIZE: usize = 100;
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
            | AcpRuntimeError::Interaction(InteractionError::Response(_))
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
            .map_err(|error| AgentManagerError::InvalidManifestSet(error.to_string()))?;
        value.validate(approved_roots)?;
        Ok(value)
    }

    pub fn load(path: &Path, approved_roots: &[PathBuf]) -> Result<Self, AgentManagerError> {
        let input = std::fs::read_to_string(path)
            .map_err(|error| AgentManagerError::ManifestRead(error.to_string()))?;
        Self::parse(&input, approved_roots)
    }

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
                    agent.resolved.agent_id
                )));
            }
            if agent.enabled {
                enabled += 1;
                agent.resolved.validate(approved_roots).map_err(|error| {
                    AgentManagerError::InvalidManifestSet(format!(
                        "{}: {error}",
                        agent.resolved.agent_id
                    ))
                })?;
            }
            if agent.display_name.trim().is_empty() || agent.display_name.len() > 256 {
                return Err(AgentManagerError::InvalidManifestSet(format!(
                    "invalid display name for {}",
                    agent.resolved.agent_id
                )));
            }
            if !valid_agent_icon(agent.icon.as_deref())
                || agent.resolved.resolved_version.len() > 2_048
                || agent.resolved.provenance.len() > 2_048
            {
                return Err(AgentManagerError::InvalidManifestSet(format!(
                    "descriptor metadata is too large for {}",
                    agent.resolved.agent_id
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
                    | crate::agent_messaging::AgentMessageDisposition::Steering
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
                    "failed to reconcile queued agent-message activities after restart: {error}"
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
                    .unwrap_or_else(|| Utc::now().timestamp_millis().max(0) as u64),
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
                crate::agent_messaging::AgentMessageDisposition::Sent
            ) && !matches!(
                disposition,
                crate::agent_messaging::AgentMessageDisposition::Sent
            );
            let cancelled_reactivation = matches!(
                current,
                crate::agent_messaging::AgentMessageDisposition::Cancelled
            ) && !matches!(
                disposition,
                crate::agent_messaging::AgentMessageDisposition::Cancelled
                    | crate::agent_messaging::AgentMessageDisposition::Sent
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
                "agent-message journal exceeds {MAX_AGENT_MESSAGE_JOURNAL_BYTES} bytes"
            )));
        }
        atomic_write_private(path, &bytes)
            .await
            .map_err(|error| AgentManagerError::AgentMessaging(error.to_string()))?;
        self.entries = staged;
        Ok(())
    }
}

fn agent_message_journal_bytes(entries: &[AgentMessageJournalEntry]) -> Option<Vec<u8>> {
    serde_json::to_vec(&AgentMessageJournalFile {
        version: AGENT_MESSAGE_JOURNAL_VERSION,
        entries: entries.to_vec(),
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
        .map_err(|error| AgentManagerError::SessionIndex(error.to_string()))?;
        #[cfg(test)]
        if self.fail_writes {
            return Err(AgentManagerError::SessionIndex(
                "injected session index write failure".to_string(),
            ));
        }
        atomic_write_private(path, &bytes)
            .await
            .map_err(|error| AgentManagerError::SessionIndex(error.to_string()))?;
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

#[cfg(test)]
#[derive(Clone)]
struct PolicySnapshotBarrier {
    reached: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

#[cfg(test)]
impl PolicySnapshotBarrier {
    async fn wait_until_reached(&self) {
        self.reached.notified().await;
    }

    fn release(&self) {
        self.release.notify_one();
    }
}

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
    policy_snapshot_barrier: Mutex<Option<PolicySnapshotBarrier>>,
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
            .map_err(|error| AgentManagerError::SessionIndex(error.to_string()))?;
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
                workspace_root.to_string_lossy()
            ))
        })?;
        if let Some((_, Err(error))) = results
            .iter()
            .find(|(manifest, _)| manifest.resolved.agent_id == preferred_agent_id)
        {
            for (_, result) in &results {
                if let Ok((connection, _)) = result {
                    let _ = connection.shutdown().await;
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
            http: reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap_or_default(),
            #[cfg(test)]
            policy_snapshot_barrier: Mutex::new(None),
        })
    }

    #[cfg(test)]
    async fn pause_next_policy_snapshot(&self) -> PolicySnapshotBarrier {
        let barrier = PolicySnapshotBarrier {
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
            .map_err(|error| AgentManagerError::AgentMessaging(error.to_string()))
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
            .map_err(|error| AgentOperationFailure::indeterminate(error.into()))?;
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

    #[cfg(test)]
    pub async fn resume_session(
        &self,
        thread_id: &str,
        cwd: impl Into<PathBuf>,
    ) -> Result<ManagedSession, AgentManagerError> {
        self.resume_session_with_policy(thread_id, cwd, ApprovalPolicy::Untrusted)
            .await
    }

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
        let (restoration, credential) = if connection.negotiated().supports_session_resume() {
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
        } else {
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
                            "{error}; durable rollback also failed: {rollback_error}"
                        )),
                    )),
                    None => Err(AgentOperationFailure::indeterminate(error)),
                }
            }
        }
    }

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
                    if connection.negotiated().supports_session_resume() {
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
                    } else if connection.negotiated().supports_session_load() {
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
                    "failed to reconcile received agent-message activity {message_id}: {error}"
                );
            }
        }
    }

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

    /// Sessions OpenCode reports as spawned by `parent_thread_id`.
    ///
    /// A foreground `task` tool only names its child once it has finished, so the tool's own
    /// updates cannot be used to attach to a sub-agent while it works. OpenCode's HTTP server
    /// knows about the child as soon as it is created, which is what makes live streaming
    /// possible. Any failure is reported as "no children" so a sub-agent still resolves the
    /// slow way when the server cannot be reached.
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
        prompt: Vec<agent_client_protocol::schema::v1::ContentBlock>,
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
        prompt: Vec<agent_client_protocol::schema::v1::ContentBlock>,
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

    pub async fn prompt_with_policy_outcome(
        &self,
        thread_id: &str,
        prompt: Vec<agent_client_protocol::schema::v1::ContentBlock>,
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
            Err(AcpRuntimeError::SessionBusy | AcpRuntimeError::UnknownSession(_))
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
            if let Some(barrier) = self.policy_snapshot_barrier.lock().await.take() {
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
                    "approval policy was committed but live delivery to agent {agent_id} failed: {error}"
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

    #[allow(clippy::too_many_arguments)]
    pub async fn deliver_live_agent_message(
        &self,
        thread_id: &str,
        expected_run_id: String,
        expected_source_turn_id: String,
        prompt_generation: u64,
        interaction_epoch: u64,
        prompt: Vec<agent_client_protocol::schema::v1::ContentBlock>,
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

    pub async fn steer(
        &self,
        thread_id: &str,
        expected_run_id: String,
        expected_source_turn_id: String,
        prompt_generation: u64,
        interaction_epoch: u64,
        prompt: Vec<agent_client_protocol::schema::v1::ContentBlock>,
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
                            snapshot.thread_id, expected_source_turn_id
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
                    snapshot.thread_id, expected_source_turn_id
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
                    stop_reason: agent_client_protocol::schema::v1::StopReason::EndTurn,
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
                let _ = connection.shutdown().await;
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
        first_error.map_or(Ok(()), Err)
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
                candidate.to_string_lossy()
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
        config_options: Option<Vec<agent_client_protocol::schema::v1::SessionConfigOption>>,
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
                            "warning: failed to publish restored session config option {option_id}: {error}"
                        );
                    }
                }
                Err(error) => {
                    eprintln!(
                        "warning: failed to restore session config option {option_id} after resume: {error}"
                    );
                }
            }
        }
    }

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
            if let Some(title) = entry.title.clone() {
                snapshot.title = Some(title);
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
    let marker = "id=\"";
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
        .filter(|part| part.part_type == "tool" && part.tool.as_deref() == Some("task"))
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
                part.id.unwrap_or_else(|| index.to_string())
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
                        agent_client_protocol::schema::v1::ToolCallStatus::Completed
                    }
                    Some("error") => agent_client_protocol::schema::v1::ToolCallStatus::Failed,
                    Some("running") => {
                        agent_client_protocol::schema::v1::ToolCallStatus::InProgress
                    }
                    _ => agent_client_protocol::schema::v1::ToolCallStatus::Pending,
                };
                let content = state.output.or(state.error).unwrap_or_default();
                events.push(CanonicalEvent::Tool {
                    agent_id: identity.agent_id.clone(),
                    thread_id: thread_id.clone(),
                    run_id: None,
                    source_turn_id: None,
                    generation: None,
                    tool_call_id: canonical_id,
                    kind: agent_client_protocol::schema::v1::ToolKind::Other,
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
                                        | "max"
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

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod catalog_tests {
    use agent_client_protocol::schema::v1::ToolCallStatus;

    use super::*;
    use crate::acp::session::AcpSession;
    use crate::acp::snapshot::{BridgeThreadSnapshot, SnapshotTimelineKind};

    #[test]
    fn parses_opencode_verbose_model_catalog() {
        let catalog = parse_opencode_model_catalog(
            br#"opencode/demo
{
  "id": "demo",
  "providerID": "opencode",
  "name": "Demo Model",
  "limit": { "context": 200000 },
  "capabilities": { "reasoning": true },
    "variants": { "high": { "reasoningEffort": "high" }, "max": {} }
}
"#,
        );
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].id, "opencode/demo");
        assert_eq!(catalog[0].display_name, "Demo Model");
        assert_eq!(catalog[0].context_window, Some(200000));
        assert_eq!(catalog[0].reasoning_effort, vec!["high", "max"]);
    }

    #[test]
    fn parses_related_sessions_from_opencode_export() {
        let document = serde_json::from_slice::<OpenCodeExportDocument>(
            br#"{
                    "messages": [{
                        "info": { "id": "message-parent", "role": "assistant" },
                        "parts": [
                            {
                                "type": "tool",
                                "tool": "task",
                                "state": {
                                    "input": { "description": "Ask subagent about hobbies" },
                                    "output": "<task id=\"child-fallback\" state=\"completed\"></task>",
                                    "metadata": { "sessionId": "child-session" }
                                }
                            },
                            {
                                "type": "tool",
                                "tool": "task",
                                "state": {
                                    "input": { "description": " " },
                                    "output": "<task id=\"child-fallback\" state=\"completed\"></task>"
                                }
                            },
                            {
                                "type": "tool",
                                "tool": "task",
                                "state": {
                                    "output": "<task id=\"child-fallback\" state=\"completed\"></task>"
                                }
                            },
                            {
                                "type": "tool",
                                "tool": "task"
                            },
                            {
                                "type": "tool",
                                "tool": "read",
                                "state": {}
                            }
                        ]
                    }]
                }"#,
        )
        .unwrap();
        let related = parse_opencode_related_sessions(document);
        assert_eq!(related.len(), 2);
        assert_eq!(related[0].session_id, "child-fallback");
        assert_eq!(related[0].title, None);
        assert_eq!(related[1].session_id, "child-session");
        assert_eq!(
            related[1].title.as_deref(),
            Some("Ask subagent about hobbies")
        );
        assert_eq!(
            snapshot_task_session_id("<task id=\"\" state=\"running\">"),
            None
        );
        assert_eq!(
            snapshot_task_session_id(&format!(
                "<task id=\"{}\" state=\"running\">",
                "x".repeat(1_025)
            )),
            None
        );
    }

    #[test]
    fn converts_opencode_export_messages_to_canonical_transcript_events() {
        let document = serde_json::from_slice::<OpenCodeExportDocument>(
            br#"{
                    "messages": [
                        {
                            "info": { "id": "user-message", "role": "user" },
                            "parts": [{ "id": "user-text", "type": "text", "text": "Hello" }]
                        },
                        {
                            "info": { "id": "assistant-message", "role": "assistant" },
                            "parts": [
                                { "id": "thought", "type": "reasoning", "text": "Thinking" },
                                { "id": "answer", "type": "text", "text": "Hi there" }
                            ]
                        }
                    ]
                }"#,
        )
        .unwrap();
        let identity = AgentSessionId::new("opencode", "child-session").unwrap();
        let events = exported_session_events(&identity, document);
        assert_eq!(events.len(), 3);
        assert!(matches!(
            events[0],
            CanonicalEvent::MessageChunk {
                role: MessageRole::User,
                ..
            }
        ));
        assert!(matches!(
            events[1],
            CanonicalEvent::MessageChunk {
                role: MessageRole::Thought,
                ..
            }
        ));
        assert!(matches!(
            events[2],
            CanonicalEvent::MessageChunk {
                role: MessageRole::Agent,
                ..
            }
        ));
    }

    /// A sub-agent opened while it is still working reproduces the reported defect: the read
    /// finds an empty transcript and starts `opencode export`, the agent streams its thought
    /// and its answer during the seconds that subprocess takes, and the export -- captured
    /// mid-answer, so it carries the prompt and the same reasoning but no answer yet -- lands
    /// afterwards. Replaying it restated the reasoning under a second, exported id and filed
    /// the prompt below the answer it produced, which is what the sub-agent chat rendered.
    #[tokio::test]
    async fn keeps_a_live_subagent_transcript_chronological_and_unduplicated() {
        let identity = AgentSessionId::new("opencode", "child-session").unwrap();
        let thread_id = identity.encode();
        let session = AcpSession::new("opencode".to_string(), thread_id.clone());
        let reasoning = "The user is asking for a harness test confirmation.";
        let answer = "Confirmed - read-only smoke test, no files modified.";
        let prompt = "This is a harness test. Please respond with a brief confirmation message.";

        for (role, message_id, content) in [
            (MessageRole::Thought, "msg_answer::thought", reasoning),
            (MessageRole::Agent, "msg_answer::agent", answer),
        ] {
            session
                .emit(CanonicalEvent::MessageChunk {
                    agent_id: identity.agent_id.clone(),
                    thread_id: thread_id.clone(),
                    run_id: None,
                    source_turn_id: None,
                    generation: None,
                    role,
                    message_id: message_id.to_string(),
                    content: content.to_string(),
                    content_block: None,
                })
                .await;
        }

        let document = serde_json::from_value::<OpenCodeExportDocument>(serde_json::json!({
            "messages": [
                {
                    "info": { "id": "msg_prompt", "role": "user" },
                    "parts": [{ "id": "prt_prompt", "type": "text", "text": prompt }]
                },
                {
                    "info": { "id": "msg_answer", "role": "assistant" },
                    "parts": [{ "id": "prt_thought", "type": "reasoning", "text": reasoning }]
                }
            ]
        }))
        .unwrap();
        assert!(
            !session
                .seed_history(exported_session_events(&identity, document))
                .await
        );

        let snapshot = BridgeThreadSnapshot::from(session.snapshot().await);
        let texts = snapshot
            .messages
            .iter()
            .map(|message| {
                (
                    message.id.clone(),
                    message.role,
                    message
                        .parts
                        .iter()
                        .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
                        .collect::<String>(),
                )
            })
            .collect::<Vec<_>>();

        // Every reasoning turn keeps exactly one identity: the same thought must never be
        // restated under a second id.
        let reasoning_ids = texts
            .iter()
            .filter(|(_, role, text)| *role == MessageRole::Thought && text == reasoning)
            .map(|(id, _, _)| id.clone())
            .collect::<Vec<_>>();
        assert_eq!(reasoning_ids, vec!["msg_answer::thought".to_string()]);
        assert_eq!(
            snapshot
                .timeline
                .iter()
                .filter(|entry| entry.kind == SnapshotTimelineKind::Reasoning)
                .count(),
            1
        );

        // The rendered order is the timeline order, and it must stay chronological: nothing
        // may be filed after the answer that already streamed.
        assert_eq!(
            snapshot
                .timeline
                .iter()
                .map(|entry| (entry.kind, entry.canonical_id.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (SnapshotTimelineKind::Reasoning, "msg_answer::thought"),
                (SnapshotTimelineKind::Message, "msg_answer::agent"),
            ]
        );
        assert!(snapshot
            .timeline
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence));
        assert!(!texts.iter().any(|(id, _, _)| id.starts_with("export:")));
    }

    #[tokio::test]
    async fn seeds_exported_history_into_a_transcript_that_has_none() {
        let identity = AgentSessionId::new("opencode", "cold-session").unwrap();
        let session = AcpSession::new("opencode".to_string(), identity.encode());
        let document = serde_json::from_value::<OpenCodeExportDocument>(serde_json::json!({
            "messages": [
                {
                    "info": { "id": "msg_prompt", "role": "user" },
                    "parts": [{ "id": "prt_prompt", "type": "text", "text": "Summarize" }]
                },
                {
                    "info": { "id": "msg_answer", "role": "assistant" },
                    "parts": [
                        { "id": "prt_first", "type": "reasoning", "text": "Reading" },
                        { "id": "prt_answer", "type": "text", "text": "Done" },
                        { "id": "prt_second", "type": "reasoning", "text": "Checking" }
                    ]
                }
            ]
        }))
        .unwrap();

        assert!(
            session
                .seed_history(exported_session_events(&identity, document))
                .await
        );

        let snapshot = BridgeThreadSnapshot::from(session.snapshot().await);
        // Two distinct reasoning turns in one message stay two rows, in the order the
        // export recorded them.
        assert_eq!(
            snapshot
                .timeline
                .iter()
                .map(|entry| entry.kind)
                .collect::<Vec<_>>(),
            vec![
                SnapshotTimelineKind::Message,
                SnapshotTimelineKind::Reasoning,
                SnapshotTimelineKind::Message,
                SnapshotTimelineKind::Reasoning,
            ]
        );
        assert_eq!(
            snapshot
                .timeline
                .iter()
                .map(|entry| entry.canonical_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "export:msg_prompt:prt_prompt",
                "export:msg_answer:prt_first",
                "export:msg_answer:prt_answer",
                "export:msg_answer:prt_second",
            ]
        );
    }

    #[test]
    fn converts_opencode_export_tool_states_to_canonical_events() {
        let document = serde_json::from_slice::<OpenCodeExportDocument>(
            br#"{
                    "messages": [{
                        "info": { "id": "tool-message", "role": "assistant" },
                        "parts": [
                            { "id": "metadata", "type": "metadata" },
                            { "id": "missing-state", "type": "tool", "tool": "read" },
                            {
                                "id": "completed",
                                "type": "tool",
                                "tool": "read",
                                "state": { "status": "completed", "output": "done" }
                            },
                            {
                                "id": "failed",
                                "type": "tool",
                                "state": { "status": "error", "title": "Failure", "error": "bad" }
                            },
                            {
                                "id": "running",
                                "type": "tool",
                                "state": { "status": "running" }
                            },
                            {
                                "type": "tool",
                                "state": { "status": "unknown" }
                            }
                        ]
                    }]
                }"#,
        )
        .unwrap();
        let identity = AgentSessionId::new("opencode", "tool-session").unwrap();
        let events = exported_session_events(&identity, document);
        let statuses = events
            .iter()
            .map(|event| match event {
                CanonicalEvent::Tool { status, .. } => *status,
                _ => panic!("expected tool event"),
            })
            .collect::<Vec<_>>();

        assert_eq!(
            statuses,
            vec![
                ToolCallStatus::Completed,
                ToolCallStatus::Failed,
                ToolCallStatus::InProgress,
                ToolCallStatus::Pending,
            ]
        );
        assert!(matches!(
            &events[0],
            CanonicalEvent::Tool {
                title,
                content: FieldUpdate::Set(content),
                ..
            } if title == "read" && content == "done"
        ));
        assert!(matches!(
            &events[1],
            CanonicalEvent::Tool {
                title,
                content: FieldUpdate::Set(content),
                ..
            } if title == "Failure" && content == "bad"
        ));
        assert!(matches!(
            &events[3],
            CanonicalEvent::Tool {
                title,
                content: FieldUpdate::Set(content),
                ..
            } if title == "tool" && content.is_empty()
        ));
    }

    #[test]
    fn model_catalog_handles_invalid_json_and_non_reasoning_models() {
        let catalog = parse_opencode_model_catalog(
            br#"{invalid}
{
  "id": "plain",
  "providerID": "provider",
  "name": "",
  "capabilities": { "reasoning": false },
  "variants": { "unsupported": {} }
}
"#,
        );

        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].display_name, "provider/plain");
        assert_eq!(catalog[0].context_window, None);
        assert!(catalog[0].reasoning_effort.is_empty());
        assert!(parse_opencode_model_catalog(&[0xff]).is_empty());
    }
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
        .map(|value| u64::from_be_bytes(value.try_into().expect("cursor length checked")) as usize)
        .filter(|value| *value <= MAX_SESSIONS)
        .ok_or(AgentManagerError::InvalidCursor)
}

fn encode_cursor(offset: usize) -> String {
    format!(
        "v1.{}",
        URL_SAFE_NO_PAD.encode((offset as u64).to_be_bytes())
    )
}

fn redact_error(error: &AcpRuntimeError) -> String {
    let _ = (error, MAX_ERROR_BYTES);
    "ACP agent startup failed (details redacted)".to_string()
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

    use agent_client_protocol::schema::v1::{
        AgentCapabilities, CancelNotification, CloseSessionResponse, DeleteSessionResponse,
        InitializeRequest, InitializeResponse, ListSessionsRequest, ListSessionsResponse,
        LoadSessionResponse, McpCapabilities, NewSessionResponse, PromptResponse,
        ResumeSessionResponse, SessionCapabilities, SessionCloseCapabilities, SessionConfigOption,
        SessionDeleteCapabilities, SessionInfo, SessionListCapabilities, SessionResumeCapabilities,
        SetSessionConfigOptionResponse, StopReason, ToolCallStatus, ToolKind,
    };
    use agent_client_protocol::Agent;
    use axum::extract::{Path as AxumPath, Query, State};
    use axum::http::StatusCode as AxumStatusCode;
    use axum::response::IntoResponse;
    use axum::routing::{delete, get, post};
    use axum::{Json, Router};
    use sha2::{Digest, Sha256};
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::mpsc;

    #[test]
    fn unavailable_connection_before_dispatch_is_a_definitive_failure() {
        let failure = classify_runtime_operation_failure(AcpRuntimeError::ConnectionUnavailable(
            "already closed".to_string(),
        ));
        assert!(!failure.is_indeterminate());
        let failure = classify_harness_operation_failure(HarnessOperationFailure::indeterminate(
            HarnessError::Timeout,
        ));
        assert!(failure.is_indeterminate());
    }

    fn echo_digest() -> String {
        let bytes = std::fs::read("/bin/echo").expect("read /bin/echo");
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    fn manifest(agent_id: &str, display_name: &str) -> LocalAgentManifest {
        LocalAgentManifest {
            enabled: true,
            display_name: display_name.to_string(),
            icon: Some(format!("https://cdn.example.test/{agent_id}.png")),
            resolved: ResolvedAgentManifest {
                agent_id: agent_id.to_string(),
                executable: PathBuf::from("/bin/echo"),
                argv: vec![],
                environment: BTreeMap::new(),
                resolved_version: "1.2.3".to_string(),
                provenance: "local registry snapshot".to_string(),
                verified_digest: echo_digest(),
                integrity: crate::acp::config::RuntimeIntegrity::Executable,
            },
        }
    }

    fn sent_agent_message(
        message_id: &str,
        related_thread_id: &str,
    ) -> crate::agent_messaging::AgentMessageOrigin {
        crate::agent_messaging::AgentMessageOrigin {
            message_id: message_id.to_string(),
            direction: crate::agent_messaging::AgentMessageDirection::Sent,
            related_thread_id: related_thread_id.to_string(),
            related_title: Some("Worker".to_string()),
            relation: AgentRelationKind::SubAgent,
            disposition: crate::agent_messaging::AgentMessageDisposition::Sent,
            body: "Check the queue lifecycle.".to_string(),
        }
    }

    #[test]
    fn agent_icons_match_shared_policy_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../contracts/agent-icon-policy.json"))
                .expect("parse icon policy fixture");
        for policy_case in fixture["cases"].as_array().expect("icon cases") {
            let value = policy_case["value"].as_str();
            let expected = policy_case["valid"].as_bool().expect("valid flag");
            assert_eq!(
                valid_agent_icon(value),
                expected,
                "{}",
                policy_case["name"].as_str().expect("case name")
            );
        }
        assert!(!valid_agent_icon(Some(&format!(
            "https://example.test/{}",
            "x".repeat(2_048)
        ))));
    }

    #[tokio::test]
    async fn manager_projects_native_extension_capabilities_without_a_harness() {
        let connection = native_extension_connection("native-agent").await;
        let manager = AgentManager::from_start_results(
            "native-agent".to_string(),
            vec![(manifest("native-agent", "Native"), Ok(connection))],
        )
        .await
        .expect("manager");
        let capabilities = manager
            .list_agents()
            .into_iter()
            .find(|agent| agent.agent_id == "native-agent")
            .and_then(|agent| agent.capabilities)
            .expect("native capabilities");
        assert!(capabilities.session_steer);
        assert!(capabilities.session_fork);
        assert!(capabilities.session_delete);
        assert!(manager
            .supports_steer(
                &AgentSessionId::new("native-agent", "source")
                    .expect("identity")
                    .encode()
            )
            .expect("native steer support"));
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_injects_one_shared_agent_message_transport_only_when_supported() {
        let service = crate::agent_messaging::AgentMessagingService::start(
            std::sync::Weak::<crate::runtime_backend::RuntimeBackend>::new(),
            std::sync::Weak::<crate::BridgeQueueService>::new(),
            crate::scheduled_prompts::ScheduledPromptService::inert_for_test(),
        )
        .await
        .expect("shared MCP listener starts");
        let config = service.config();
        let http_url = config.http_url.clone();
        let sse_url = config.sse_url.clone();
        let (http_observed, mut http_requests) = mpsc::unbounded_channel();
        let (sse_observed, mut sse_requests) = mpsc::unbounded_channel();
        let (stdio_observed, mut stdio_requests) = mpsc::unbounded_channel();
        let http = mcp_observing_connection(
            "http-agent",
            McpCapabilities::new().http(true).sse(true),
            http_observed,
        )
        .await;
        let sse =
            mcp_observing_connection("sse-agent", McpCapabilities::new().sse(true), sse_observed)
                .await;
        let stdio =
            mcp_observing_connection("stdio-agent", McpCapabilities::new(), stdio_observed).await;
        let manager = AgentManager::from_start_results(
            "http-agent".to_string(),
            vec![
                (manifest("http-agent", "HTTP"), Ok(http)),
                (manifest("sse-agent", "SSE"), Ok(sse)),
                (manifest("stdio-agent", "Stdio"), Ok(stdio)),
            ],
        )
        .await
        .expect("manager");
        manager
            .attach_agent_messaging(config)
            .expect("attach shared MCP service");

        for agent_id in ["http-agent", "sse-agent", "stdio-agent"] {
            manager
                .new_session(agent_id, NewSessionRequest::new("/tmp"))
                .await
                .expect("session starts");
        }

        let http_servers = http_requests.recv().await.expect("HTTP request");
        assert_eq!(http_servers.as_array().expect("HTTP server array").len(), 1);
        assert_eq!(http_servers[0]["url"], http_url);
        assert_eq!(http_servers[0]["headers"][0]["name"], "Authorization");
        assert!(!http_servers[0]["url"]
            .as_str()
            .expect("HTTP MCP URL")
            .contains("dcm_"));

        let sse_servers = sse_requests.recv().await.expect("SSE request");
        assert_eq!(sse_servers.as_array().expect("SSE server array").len(), 1);
        assert_eq!(sse_servers[0]["url"], sse_url);
        assert_eq!(sse_servers[0]["headers"][0]["name"], "Authorization");

        let stdio_servers = stdio_requests.recv().await.expect("stdio request");
        assert_eq!(
            stdio_servers
                .as_array()
                .expect("stdio-only server array")
                .len(),
            0
        );

        manager.shutdown().await;
        service.shutdown().await;
    }

    #[tokio::test]
    async fn manager_keeps_session_lifecycle_available_when_messaging_credentials_are_saturated() {
        let service = crate::agent_messaging::AgentMessagingService::start(
            std::sync::Weak::<crate::runtime_backend::RuntimeBackend>::new(),
            std::sync::Weak::<crate::BridgeQueueService>::new(),
            crate::scheduled_prompts::ScheduledPromptService::inert_for_test(),
        )
        .await
        .expect("shared MCP listener starts");
        let config = service.config();
        let mut reserved = Vec::new();
        loop {
            match config.stage_credential("reserved-agent") {
                Ok(credential) => reserved.push(credential),
                Err(McpCredentialError::LimitReached) => break,
                Err(error) => panic!("unexpected credential staging failure: {error}"),
            }
        }
        assert_eq!(reserved.len(), 4_096);

        let (observed, mut requests) = mpsc::unbounded_channel();
        let connection =
            mcp_observing_connection("http-agent", McpCapabilities::new().http(true), observed)
                .await;
        let manager = AgentManager::from_start_results(
            "http-agent".to_string(),
            vec![(manifest("http-agent", "HTTP"), Ok(connection))],
        )
        .await
        .expect("manager");
        manager
            .attach_agent_messaging(config)
            .expect("attach shared MCP service");

        manager
            .new_session("http-agent", NewSessionRequest::new("/tmp"))
            .await
            .expect("session lifecycle remains available");
        assert!(requests
            .recv()
            .await
            .expect("new-session MCP servers")
            .as_array()
            .expect("MCP server array")
            .is_empty());

        manager.shutdown().await;
        drop(reserved);
        service.shutdown().await;
    }

    #[tokio::test]
    async fn manager_projects_fork_support_for_a_canonicalized_opencode_launcher() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let connection = connection_with_capabilities(
            "opencode",
            AgentCapabilities::new().load_session(true),
            observed_tx,
        )
        .await;
        let mut opencode = manifest("opencode", "OpenCode");
        opencode.resolved.executable =
            PathBuf::from("/opt/homebrew/lib/node_modules/opencode-ai/dist/cli.js");
        opencode.resolved.argv = vec!["acp".to_string()];
        let mut manager = AgentManager::from_start_results(
            "opencode".to_string(),
            vec![(opencode, Ok(connection))],
        )
        .await
        .expect("manager");
        manager
            .agents
            .get_mut("opencode")
            .expect("OpenCode runtime")
            .http_base = Some("http://127.0.0.1:4096".to_string());

        let capabilities = manager
            .list_agents()
            .into_iter()
            .find(|agent| agent.agent_id == "opencode")
            .and_then(|agent| agent.capabilities)
            .expect("OpenCode capabilities");
        assert!(capabilities.session_fork);

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_rejects_native_forks_that_reuse_source_or_existing_ids() {
        let connection = native_extension_connection("native-agent").await;
        let session = connection
            .0
            .ensure_session(SessionId::new("source"))
            .await
            .expect("source session");
        let manager = AgentManager::from_start_results(
            "native-agent".to_string(),
            vec![(manifest("native-agent", "Native"), Ok(connection))],
        )
        .await
        .expect("manager");
        let identity = AgentSessionId::new("native-agent", "source").unwrap();
        let thread_id = identity.encode();
        manager
            .session_index
            .lock()
            .await
            .insert_all([
                index_entry(
                    AgentSessionId::new("a-agent", "source").unwrap(),
                    PathBuf::from("/tmp"),
                ),
                index_entry(
                    AgentSessionId::new("native-agent", "aaa").unwrap(),
                    PathBuf::from("/tmp"),
                ),
                index_entry(identity, PathBuf::from("/tmp")),
                index_entry(
                    AgentSessionId::new("native-agent", "existing").unwrap(),
                    PathBuf::from("/tmp"),
                ),
            ])
            .await
            .expect("source index");
        for id in ["first-id", "source-id", "existing-id"] {
            session
                .emit(CanonicalEvent::MessageChunk {
                    agent_id: "native-agent".to_string(),
                    thread_id: thread_id.clone(),
                    run_id: None,
                    source_turn_id: None,
                    generation: None,
                    role: MessageRole::User,
                    message_id: id.to_string(),
                    content: id.to_string(),
                    content_block: None,
                })
                .await;
        }

        assert!(matches!(
            manager.fork_session(&thread_id, "source-id").await,
            Err(AgentManagerError::Fork(_))
        ));
        assert!(matches!(
            manager.fork_session(&thread_id, "existing-id").await,
            Err(AgentManagerError::Fork(_))
        ));
        let (generation, _) = session
            .admit_prompt("run".to_string(), "turn".to_string())
            .await
            .expect("native prompt");
        let epoch = manager
            .prepare_steer(&thread_id)
            .await
            .expect("prepare native steer");
        manager
            .steer(
                &thread_id,
                "run".to_string(),
                "turn".to_string(),
                generation,
                epoch,
                Vec::new(),
            )
            .await
            .expect("native steer");
        manager.shutdown().await;
    }

    async fn connection(
        agent_id: &str,
        supports_list: bool,
        listed_session: &str,
        observed: mpsc::UnboundedSender<String>,
    ) -> (AcpConnection, NegotiatedInitialize) {
        let listed_session = listed_session.to_string();
        let new_session = format!("{agent_id}-new");
        let prompt_agent = agent_id.to_string();
        let cancel_agent = agent_id.to_string();
        let capabilities = if supports_list {
            AgentCapabilities::new().session_capabilities(
                SessionCapabilities::new().list(SessionListCapabilities::new()),
            )
        } else {
            AgentCapabilities::new()
        };
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version)
                            .agent_capabilities(capabilities.clone()),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new(new_session.clone()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: ListSessionsRequest, responder, _| {
                    responder.respond(ListSessionsResponse::new(vec![SessionInfo::new(
                        listed_session.clone(),
                        "/tmp",
                    )]))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let observed = observed.clone();
                    async move |_request: PromptRequest, responder, _| {
                        let _ = observed.send(format!("prompt:{prompt_agent}"));
                        responder.respond(PromptResponse::new(StopReason::EndTurn))
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_notification(
                async move |_request: CancelNotification, _| {
                    let _ = observed.send(format!("cancel:{cancel_agent}"));
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("test agent starts")
    }

    async fn connection_with_capabilities(
        agent_id: &str,
        capabilities: AgentCapabilities,
        observed: mpsc::UnboundedSender<String>,
    ) -> (AcpConnection, NegotiatedInitialize) {
        let load_agent = agent_id.to_string();
        let resume_agent = agent_id.to_string();
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version)
                            .agent_capabilities(capabilities.clone()),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let observed = observed.clone();
                    async move |_request: LoadSessionRequest, responder, _| {
                        let _ = observed.send(format!("load:{load_agent}"));
                        responder.respond(LoadSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: ResumeSessionRequest, responder, _| {
                    let _ = observed.send(format!("resume:{resume_agent}"));
                    responder.respond(ResumeSessionResponse::new())
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("capability agent starts")
    }

    async fn mcp_observing_connection(
        agent_id: &str,
        capabilities: McpCapabilities,
        observed: mpsc::UnboundedSender<serde_json::Value>,
    ) -> (AcpConnection, NegotiatedInitialize) {
        let session_id = format!("{agent_id}-session");
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version).agent_capabilities(
                            AgentCapabilities::new().mcp_capabilities(capabilities.clone()),
                        ),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: NewSessionRequest, responder, _| {
                    observed
                        .send(
                            serde_json::to_value(request.mcp_servers)
                                .expect("serialize observed MCP servers"),
                        )
                        .expect("observe MCP servers");
                    responder.respond(NewSessionResponse::new(session_id.clone()))
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("MCP-observing agent starts")
    }

    async fn deleting_connection(
        agent_id: &str,
        supports_delete: bool,
        supports_close: bool,
        observed: mpsc::UnboundedSender<String>,
    ) -> (AcpConnection, NegotiatedInitialize) {
        let mut session_capabilities =
            SessionCapabilities::new().list(SessionListCapabilities::new());
        if supports_delete {
            session_capabilities = session_capabilities.delete(SessionDeleteCapabilities::new());
        }
        if supports_close {
            session_capabilities = session_capabilities.close(SessionCloseCapabilities::new());
        }
        let capabilities = AgentCapabilities::new().session_capabilities(session_capabilities);
        let listed_agent = agent_id.to_string();
        let delete_agent = agent_id.to_string();
        let close_agent = agent_id.to_string();
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version)
                            .agent_capabilities(capabilities.clone()),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: ListSessionsRequest, responder, _| {
                    responder.respond(ListSessionsResponse::new(vec![SessionInfo::new(
                        format!("{listed_agent}-listed"),
                        "/tmp",
                    )]))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let observed = observed.clone();
                    async move |request: DeleteSessionRequest, responder, _| {
                        let _ =
                            observed.send(format!("delete:{delete_agent}:{}", request.session_id));
                        responder.respond(DeleteSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let observed = observed.clone();
                    async move |request: CloseSessionRequest, responder, _| {
                        let _ =
                            observed.send(format!("close:{close_agent}:{}", request.session_id));
                        responder.respond(CloseSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: PromptRequest, responder, _| {
                    responder.respond(PromptResponse::new(StopReason::EndTurn))
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("deleting agent starts")
    }

    async fn post_apply_deleting_connection(
        agent_id: &str,
        observed: mpsc::UnboundedSender<String>,
    ) -> (AcpConnection, NegotiatedInitialize) {
        let deleted = Arc::new(AtomicBool::new(false));
        let listed_agent = agent_id.to_string();
        let listed_deleted = deleted.clone();
        let delete_agent = agent_id.to_string();
        let delete_applied = deleted.clone();
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version).agent_capabilities(
                            AgentCapabilities::new().session_capabilities(
                                SessionCapabilities::new()
                                    .list(SessionListCapabilities::new())
                                    .delete(SessionDeleteCapabilities::new()),
                            ),
                        ),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: ListSessionsRequest, responder, _| {
                    let sessions = if listed_deleted.load(Ordering::Acquire) {
                        Vec::new()
                    } else {
                        vec![SessionInfo::new(format!("{listed_agent}-listed"), "/tmp")]
                    };
                    responder.respond(ListSessionsResponse::new(sessions))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: DeleteSessionRequest, responder, _| {
                    delete_applied.store(true, Ordering::Release);
                    let _ = observed.send(format!("delete:{delete_agent}:{}", request.session_id));
                    responder.respond(DeleteSessionResponse::new())
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("post-apply deleting agent starts")
    }

    async fn native_extension_connection(agent_id: &str) -> (AcpConnection, NegotiatedInitialize) {
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    let mut response = InitializeResponse::new(request.protocol_version)
                        .agent_capabilities(AgentCapabilities::new().session_capabilities(
                            SessionCapabilities::new().delete(SessionDeleteCapabilities::new()),
                        ));
                    response.meta = serde_json::from_value(serde_json::json!({
                        "dappercode.dev": {
                            "version": 1,
                            "capabilities": {
                                "sessionSteer": {
                                    "method": "_dappercode.dev/session/steer",
                                    "version": 1
                                },
                                "sessionFork": {
                                    "method": "_dappercode.dev/session/fork",
                                    "version": 1
                                }
                            }
                        }
                    }))
                    .ok();
                    responder.respond(response)
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: ForkRequest, responder, _| {
                    let session_id = match request.message_id.as_deref() {
                        Some("source-id") => request.session_id,
                        Some("existing-id") => SessionId::new("existing"),
                        _ => SessionId::new("forked"),
                    };
                    responder.respond(crate::acp::runtime::ForkResponse {
                        session_id,
                        title: Some("Forked".to_string()),
                    })
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: SteerRequest, responder, _| {
                    responder.respond(crate::acp::runtime::SteerResponse { accepted: true })
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("native extension agent starts")
    }

    #[derive(Clone)]
    struct OpenCodeDeleteServerState {
        observed: mpsc::UnboundedSender<(String, Option<String>)>,
        status: AxumStatusCode,
        delete_removes: bool,
        deleted: Arc<AtomicBool>,
    }

    async fn handle_opencode_delete(
        AxumPath(session_id): AxumPath<String>,
        Query(query): Query<HashMap<String, String>>,
        State(state): State<OpenCodeDeleteServerState>,
    ) -> AxumStatusCode {
        let _ = state
            .observed
            .send((session_id, query.get("directory").cloned()));
        if state.status.is_success() && state.delete_removes {
            state.deleted.store(true, Ordering::SeqCst);
        }
        state.status
    }

    async fn handle_opencode_get(
        AxumPath(session_id): AxumPath<String>,
        State(state): State<OpenCodeDeleteServerState>,
    ) -> Result<Json<serde_json::Value>, AxumStatusCode> {
        if state.deleted.load(Ordering::SeqCst) {
            Err(AxumStatusCode::NOT_FOUND)
        } else {
            Ok(Json(serde_json::json!({ "id": session_id })))
        }
    }

    async fn opencode_delete_server(
        status: AxumStatusCode,
        delete_removes: bool,
    ) -> (
        String,
        mpsc::UnboundedReceiver<(String, Option<String>)>,
        tokio::task::JoinHandle<()>,
    ) {
        let (observed, observed_rx) = mpsc::unbounded_channel();
        let deleted = Arc::new(AtomicBool::new(false));
        let app = Router::new()
            .route(
                "/session/{session_id}",
                delete(handle_opencode_delete).get(handle_opencode_get),
            )
            .with_state(OpenCodeDeleteServerState {
                observed,
                status,
                delete_removes,
                deleted,
            });
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind OpenCode delete fixture");
        let base = format!(
            "http://{}",
            listener.local_addr().expect("fixture local address")
        );
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve OpenCode delete fixture");
        });
        (base, observed_rx, task)
    }

    async fn reconstructing_connection(
        agent_id: &str,
        capabilities: AgentCapabilities,
        requests: Arc<std::sync::atomic::AtomicUsize>,
        fail: bool,
        response_barrier: Option<Arc<(tokio::sync::Notify, tokio::sync::Notify)>>,
    ) -> (AcpConnection, NegotiatedInitialize) {
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version)
                            .agent_capabilities(capabilities.clone()),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let requests = requests.clone();
                    let response_barrier = response_barrier.clone();
                    async move |request: LoadSessionRequest, responder, connection| {
                        requests.fetch_add(1, Ordering::SeqCst);
                        if let Some(barrier) = &response_barrier {
                            barrier.0.notify_one();
                            barrier.1.notified().await;
                        }
                        if fail {
                            return responder.respond_with_error(
                                agent_client_protocol::Error::internal_error(),
                            );
                        }
                        let update = serde_json::from_value(serde_json::json!({
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "restored"},
                            "messageId": "restored-message"
                        }))
                        .expect("typed update");
                        connection.send_notification(
                            agent_client_protocol::schema::v1::SessionNotification::new(
                                request.session_id,
                                update,
                            ),
                        )?;
                        responder.respond(LoadSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let requests = requests.clone();
                    let response_barrier = response_barrier.clone();
                    async move |request: ResumeSessionRequest, responder, connection| {
                        requests.fetch_add(1, Ordering::SeqCst);
                        if let Some(barrier) = &response_barrier {
                            barrier.0.notify_one();
                            barrier.1.notified().await;
                        }
                        if fail {
                            return responder.respond_with_error(
                                agent_client_protocol::Error::internal_error(),
                            );
                        }
                        let update = serde_json::from_value(serde_json::json!({
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "restored"},
                            "messageId": "restored-message"
                        }))
                        .expect("typed update");
                        connection.send_notification(
                            agent_client_protocol::schema::v1::SessionNotification::new(
                                request.session_id,
                                update,
                            ),
                        )?;
                        responder.respond(ResumeSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("reconstructing agent starts")
    }

    async fn paginated_connection(agent_id: &str) -> (AcpConnection, NegotiatedInitialize) {
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version).agent_capabilities(
                            AgentCapabilities::new().session_capabilities(
                                SessionCapabilities::new().list(SessionListCapabilities::new()),
                            ),
                        ),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: ListSessionsRequest, responder, _| {
                    let response = if request.cursor.as_deref() == Some("page-2") {
                        ListSessionsResponse::new(vec![
                            SessionInfo::new("alpha", "/tmp"),
                            SessionInfo::new("duplicate", "/tmp"),
                        ])
                        .next_cursor("page-2")
                    } else {
                        ListSessionsResponse::new(vec![
                            SessionInfo::new("zulu", "/tmp"),
                            SessionInfo::new("duplicate", "/tmp"),
                            SessionInfo::new("", "/tmp"),
                            SessionInfo::new(
                                "invalid-cwd",
                                "/definitely/missing/dappercode-remote-workspace",
                            ),
                        ])
                        .next_cursor("page-2")
                    };
                    responder.respond(response)
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("paginated agent starts")
    }

    #[derive(Clone, Copy)]
    enum PaginationFixture {
        Endless,
        Empty,
        DuplicateOnly,
        MaxSessions,
        Failure,
    }

    async fn adversarial_paginated_connection(
        agent_id: &str,
        fixture: PaginationFixture,
        requests: Arc<std::sync::atomic::AtomicUsize>,
    ) -> (AcpConnection, NegotiatedInitialize) {
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version).agent_capabilities(
                            AgentCapabilities::new().session_capabilities(
                                SessionCapabilities::new().list(SessionListCapabilities::new()),
                            ),
                        ),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: ListSessionsRequest, responder, _| {
                    let request = requests.fetch_add(1, Ordering::SeqCst);
                    let response = match fixture {
                        PaginationFixture::Endless => {
                            ListSessionsResponse::new(vec![SessionInfo::new(
                                format!("session-{request}"),
                                "/tmp",
                            )])
                            .next_cursor(format!("cursor-{request}"))
                        }
                        PaginationFixture::Empty => ListSessionsResponse::new(Vec::new())
                            .next_cursor(format!("cursor-{request}")),
                        PaginationFixture::DuplicateOnly => {
                            ListSessionsResponse::new(vec![SessionInfo::new("duplicate", "/tmp")])
                                .next_cursor(format!("cursor-{request}"))
                        }
                        PaginationFixture::MaxSessions => ListSessionsResponse::new(
                            (0..MAX_SESSIONS)
                                .map(|index| SessionInfo::new(format!("session-{index}"), "/tmp"))
                                .collect(),
                        ),
                        PaginationFixture::Failure => {
                            return responder
                                .respond_with_error(agent_client_protocol::Error::internal_error())
                        }
                    };
                    responder.respond(response)
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("adversarial paginated agent starts")
    }

    #[test]
    fn local_manifest_set_rejects_duplicates_missing_preferred_and_empty_enabled_set() {
        let alpha = manifest("alpha-orbit", "Alpha Orbit");
        let roots = [PathBuf::from("/bin")];
        let duplicate = LocalAgentManifestSet {
            preferred_agent_id: "alpha-orbit".into(),
            agents: vec![alpha.clone(), alpha.clone()],
        };
        assert!(duplicate.validate(&roots).is_err());
        let missing = LocalAgentManifestSet {
            preferred_agent_id: "missing".into(),
            agents: vec![alpha.clone()],
        };
        assert!(missing.validate(&roots).is_err());
        let mut disabled = alpha;
        disabled.enabled = false;
        let empty = LocalAgentManifestSet {
            preferred_agent_id: "alpha-orbit".into(),
            agents: vec![disabled],
        };
        assert!(empty.validate(&roots).is_err());
    }

    #[test]
    fn local_manifest_requires_executable_digest_and_typed_integrity() {
        let value = serde_json::to_value(LocalAgentManifestSet {
            preferred_agent_id: "alpha-orbit".into(),
            agents: vec![manifest("alpha-orbit", "Alpha Orbit")],
        })
        .expect("serialize manifest");
        let mut missing = value.clone();
        missing["agents"][0]
            .as_object_mut()
            .expect("agent object")
            .remove("verifiedDigest");
        assert!(LocalAgentManifestSet::parse(
            &serde_json::to_string(&missing).expect("serialize missing digest"),
            &[PathBuf::from("/bin")]
        )
        .is_err());

        let mut missing_integrity = value;
        missing_integrity["agents"][0]
            .as_object_mut()
            .expect("agent object")
            .remove("integrity");
        assert!(LocalAgentManifestSet::parse(
            &serde_json::to_string(&missing_integrity).expect("serialize missing integrity"),
            &[PathBuf::from("/bin")]
        )
        .is_err());
    }

    #[tokio::test]
    async fn preferred_failure_is_fatal_and_nonpreferred_failure_is_visible_and_redacted() {
        let preferred = manifest("alpha-orbit", "Alpha Orbit");
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let sibling = connection("beta-lab", false, "unused", observed_tx).await;
        let result = AgentManager::from_start_results(
            "alpha-orbit".into(),
            vec![
                (manifest("beta-lab", "Beta Lab"), Ok(sibling)),
                (
                    preferred,
                    Err(AcpRuntimeError::Connection("/secret/token=value".into())),
                ),
            ],
        )
        .await;
        assert!(matches!(result, Err(AgentManagerError::PreferredStart(_))));

        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let ready = connection("alpha-orbit", false, "unused", observed_tx).await;
        let manager = AgentManager::from_start_results(
            "alpha-orbit".into(),
            vec![
                (manifest("alpha-orbit", "Alpha Orbit"), Ok(ready)),
                (
                    manifest("beta-lab", "Beta Lab"),
                    Err(AcpRuntimeError::Connection("/secret/token=value".into())),
                ),
            ],
        )
        .await
        .expect("nonpreferred failure is nonfatal");
        let beta = manager
            .list_agents()
            .into_iter()
            .find(|agent| agent.agent_id == "beta-lab")
            .unwrap();
        assert_eq!(beta.lifecycle, AgentLifecycle::Unavailable);
        assert_eq!(
            beta.last_error.as_deref(),
            Some("ACP agent startup failed (details redacted)")
        );
        assert!(!serde_json::to_string(&beta).unwrap().contains("secret"));
    }

    #[tokio::test]
    async fn generic_routing_opaque_pagination_fallback_interactions_and_shutdown() {
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let alpha = connection("alpha-orbit", true, "alpha-history", observed_tx.clone()).await;
        let beta = connection("beta-lab", false, "unused", observed_tx).await;
        let manager = AgentManager::from_start_results(
            "alpha-orbit".into(),
            vec![
                (manifest("alpha-orbit", "Alpha Orbit"), Ok(alpha)),
                (manifest("beta-lab", "Beta Lab"), Ok(beta)),
            ],
        )
        .await
        .expect("manager starts");
        assert_eq!(manager.preferred_agent_id(), "alpha-orbit");
        assert_eq!(manager.list_agents().len(), 2);

        let beta_session = manager
            .new_session("beta-lab", NewSessionRequest::new("/tmp"))
            .await
            .expect("explicit beta session");
        let decoded = AgentSessionId::decode(&beta_session.thread_id).unwrap();
        assert_eq!(decoded.agent_id, "beta-lab");
        assert_eq!(decoded.acp_session_id, "beta-lab-new");

        assert_eq!(
            manager.loaded_session_ids().await,
            vec![beta_session.thread_id.clone()]
        );

        let first_page = manager.list_sessions(None, 1).await.unwrap();
        assert_eq!(first_page.sessions.len(), 1);
        assert_eq!(first_page.next_cursor, Some(encode_cursor(1)));
        let second_page = manager
            .list_sessions(Some(&encode_cursor(1)), 100)
            .await
            .unwrap();
        assert_eq!(second_page.sessions.len(), 1);
        let listed = [
            first_page.sessions[0].clone(),
            second_page.sessions[0].clone(),
        ];
        assert!(listed.iter().any(|session| {
            AgentSessionId::decode(&session.thread_id)
                .is_ok_and(|identity| identity.acp_session_id == "alpha-history")
        }));
        assert!(listed
            .iter()
            .any(|session| session.thread_id == beta_session.thread_id));
        assert_eq!(
            manager.loaded_session_ids().await,
            vec![beta_session.thread_id.clone()]
        );

        let fallback_id = AgentSessionId::new("beta-lab", "opaque/unknown:session")
            .unwrap()
            .encode();
        assert!(matches!(
            manager.read_session(&fallback_id).await,
            Err(AgentManagerError::Runtime(AcpRuntimeError::UnknownSession(
                _
            )))
        ));
        assert_eq!(
            manager.loaded_session_ids().await,
            vec![beta_session.thread_id.clone()]
        );
        assert!(matches!(
            manager.resume_session(&fallback_id, "/tmp").await,
            Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
                "session/resume or session/load"
            )))
        ));

        let mut events = manager.take_events().await.expect("manager event receiver");
        manager
            .prompt(
                &beta_session.thread_id,
                vec!["hello".into()],
                "run-beta".into(),
                "turn-beta".into(),
            )
            .await
            .unwrap();
        assert_eq!(observed_rx.recv().await.as_deref(), Some("prompt:beta-lab"));
        let started = events.recv().await.unwrap();
        assert!(
            matches!(started, CanonicalEvent::RunStarted { agent_id, .. } if agent_id == "beta-lab")
        );
        assert!(matches!(
            manager.cancel_turn("invalid-thread", "turn-beta").await,
            Err(AgentManagerError::InvalidThreadId)
        ));
        let unavailable = AgentSessionId::new("offline-agent", "session")
            .unwrap()
            .encode();
        assert!(matches!(
            manager.cancel_turn(&unavailable, "turn-beta").await,
            Err(AgentManagerError::UnknownAgent(_))
        ));
        manager
            .prepare_steer(&beta_session.thread_id)
            .await
            .unwrap();
        assert!(manager.pending_permissions().await.is_empty());
        assert!(manager.pending_elicitations().await.is_empty());
        let _ = manager.read_session("invalid-thread").await;
        let _ = manager.read_session(&unavailable).await;

        manager.shutdown().await;
        assert!(manager
            .list_agents()
            .iter()
            .all(|agent| agent.lifecycle == AgentLifecycle::Stopped));
        manager.shutdown().await;
    }

    #[test]
    fn local_manifest_set_validates_counts_descriptors_and_enabled_agents() {
        let roots = [PathBuf::from("/bin")];
        let empty = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: Vec::new(),
        };
        assert!(empty.validate(&roots).is_err());

        let oversized = LocalAgentManifestSet {
            preferred_agent_id: "agent-0".to_string(),
            agents: (0..=MAX_AGENTS)
                .map(|index| manifest(&format!("agent-{index}"), "Agent"))
                .collect(),
        };
        assert!(oversized.validate(&roots).is_err());

        let mut invalid_enabled = manifest("alpha", "Alpha");
        invalid_enabled.resolved.executable = PathBuf::from("/does/not/exist");
        let invalid_enabled = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![invalid_enabled],
        };
        assert!(invalid_enabled.validate(&roots).is_err());

        let mut disabled_invalid = manifest("disabled", "Disabled");
        disabled_invalid.enabled = false;
        disabled_invalid.resolved.executable = PathBuf::from("/does/not/exist");
        let disabled_invalid = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![manifest("alpha", "Alpha"), disabled_invalid],
        };
        assert!(disabled_invalid.validate(&roots).is_ok());

        let blank_name_agent = manifest("alpha", " ");
        let blank_name = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![blank_name_agent],
        };
        assert!(blank_name.validate(&roots).is_err());
        let long_name_agent = manifest("alpha", &"x".repeat(257));
        let long_name = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![long_name_agent],
        };
        assert!(long_name.validate(&roots).is_err());

        let mut bad_icon = manifest("alpha", "Alpha");
        bad_icon.icon = Some("bad\0icon".to_string());
        let bad_icon = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![bad_icon],
        };
        assert!(bad_icon.validate(&roots).is_err());
        let mut long_icon = manifest("alpha", "Alpha");
        long_icon.icon = Some("x".repeat(2_049));
        let long_icon = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![long_icon],
        };
        assert!(long_icon.validate(&roots).is_err());

        let mut long_version = manifest("alpha", "Alpha");
        long_version.resolved.resolved_version = "x".repeat(2_049);
        let long_version = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![long_version],
        };
        assert!(long_version.validate(&roots).is_err());
        let mut long_provenance = manifest("alpha", "Alpha");
        long_provenance.resolved.provenance = "x".repeat(2_049);
        let long_provenance = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![long_provenance],
        };
        assert!(long_provenance.validate(&roots).is_err());
    }

    #[test]
    fn local_manifest_parse_load_and_cursor_validation_are_strict() {
        let roots = [PathBuf::from("/bin")];
        assert!(LocalAgentManifestSet::parse("not json", &roots).is_err());
        assert!(LocalAgentManifestSet::load(Path::new("/does/not/exist"), &roots).is_err());
        assert_eq!(decode_cursor(None).unwrap(), 0);
        assert_eq!(decode_cursor(Some(&encode_cursor(42))).unwrap(), 42);
        assert!(decode_cursor(Some("v0.invalid")).is_err());
        assert!(decode_cursor(Some("v1.invalid")).is_err());
        assert!(decode_cursor(Some(&encode_cursor(MAX_SESSIONS + 1))).is_err());
        assert_eq!(
            redact_error(&AcpRuntimeError::Connection("secret".to_string())),
            "ACP agent startup failed (details redacted)"
        );
    }

    #[tokio::test]
    async fn manager_reports_unknown_unavailable_and_invalid_routes() {
        let (observed, _) = mpsc::unbounded_channel();
        let ready = connection("alpha", false, "unused", observed).await;
        let manager = AgentManager::from_start_results(
            "alpha".to_string(),
            vec![
                (manifest("alpha", "Alpha"), Ok(ready)),
                (
                    manifest("beta", "Beta"),
                    Err(AcpRuntimeError::Connection("failed".to_string())),
                ),
            ],
        )
        .await
        .unwrap();
        assert!(matches!(
            manager
                .new_session("missing", NewSessionRequest::new("/tmp"))
                .await,
            Err(AgentManagerError::UnknownAgent(_))
        ));
        assert!(matches!(
            manager
                .new_session("beta", NewSessionRequest::new("/tmp"))
                .await,
            Err(AgentManagerError::AgentUnavailable(_))
        ));
        assert!(matches!(
            manager.read_session("invalid").await,
            Err(AgentManagerError::InvalidThreadId)
        ));
        assert!(matches!(
            manager.list_sessions(Some("invalid"), 0).await,
            Err(AgentManagerError::InvalidCursor)
        ));
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_merges_remote_history_but_loaded_list_remains_live_only() {
        let (observed, _) = mpsc::unbounded_channel();
        let ready = connection("alpha", true, "remote-history", observed).await;
        let manager = AgentManager::from_start_results(
            "alpha".to_string(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .unwrap();
        let remote = manager.list_sessions(None, 100).await.unwrap().sessions;
        assert_eq!(remote.len(), 1);
        assert_eq!(
            AgentSessionId::decode(&remote[0].thread_id)
                .unwrap()
                .acp_session_id,
            "remote-history"
        );
        assert!(manager.loaded_session_ids().await.is_empty());
        assert_eq!(
            manager
                .list_sessions_for(None, 100, Some("alpha"))
                .await
                .unwrap()
                .sessions
                .len(),
            1
        );
        assert!(manager
            .list_sessions_for(None, 100, Some("missing"))
            .await
            .unwrap()
            .sessions
            .is_empty());
        let created = manager
            .new_session("alpha", NewSessionRequest::new("/tmp"))
            .await
            .unwrap();
        let created_again = manager.read_session(&created.thread_id).await.unwrap();
        assert_eq!(created_again.thread_id, created.thread_id);
        let sessions = manager.list_sessions(None, 100).await.unwrap().sessions;
        assert_eq!(sessions.len(), 2);
        assert_eq!(
            sessions
                .iter()
                .filter(|session| session.thread_id == created.thread_id)
                .count(),
            1
        );
        assert_eq!(manager.loaded_session_ids().await, vec![created.thread_id]);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn retirement_reconciliation_distinguishes_live_absent_and_mixed_indexed_sessions() {
        let (observed, _) = mpsc::unbounded_channel();
        let ready = connection("alpha", true, "live-session", observed).await;
        let manager = AgentManager::from_start_results(
            "alpha".to_string(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .unwrap();
        let live = AgentSessionId::new("alpha", "live-session").unwrap();
        let absent = AgentSessionId::new("alpha", "absent-session").unwrap();
        let absent_child = AgentSessionId::new("alpha", "absent-child").unwrap();
        let cwd = std::env::current_dir().unwrap();
        let mut absent_child_entry = index_entry(absent_child.clone(), cwd.clone());
        absent_child_entry.parent_acp_session_id = Some(absent.acp_session_id.clone());
        manager
            .session_index
            .lock()
            .await
            .insert_all([
                index_entry(live.clone(), cwd.clone()),
                index_entry(absent.clone(), cwd),
                absent_child_entry,
            ])
            .await
            .unwrap();
        manager
            .connection("alpha")
            .unwrap()
            .ensure_session(SessionId::new(absent.acp_session_id.clone()))
            .await
            .expect("seed a stale locally cached session");

        assert_eq!(
            manager.reconcile_retirement_plan(&[live.encode()]).await,
            RetirementPlanReconciliation::Present
        );
        assert_eq!(
            manager.reconcile_retirement_plan(&[absent.encode()]).await,
            RetirementPlanReconciliation::Absent
        );
        let mut expanded_absent = vec![absent.encode(), absent_child.encode()];
        expanded_absent.sort();
        assert_eq!(
            manager
                .expand_retirement_family(&[absent.encode()])
                .await
                .unwrap(),
            expanded_absent
        );
        assert_eq!(
            manager
                .reconcile_retirement_plan(&[live.encode(), absent.encode()])
                .await,
            RetirementPlanReconciliation::Indeterminate
        );
        manager
            .finalize_confirmed_deleted_sessions(&[absent.encode()])
            .await
            .unwrap();
        manager
            .finalize_confirmed_deleted_sessions(&[absent.encode()])
            .await
            .unwrap();
        assert!(!manager
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .any(|entry| entry.acp_session_id == "absent-session"));
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_preserves_remote_session_summary_metadata() {
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version).agent_capabilities(
                            AgentCapabilities::new().session_capabilities(
                                SessionCapabilities::new().list(SessionListCapabilities::new()),
                            ),
                        ),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: ListSessionsRequest, responder, _| {
                    responder.respond(ListSessionsResponse::new(vec![SessionInfo::new(
                        "summary-session",
                        "/tmp",
                    )
                    .title("Real session title")
                    .updated_at("2026-07-21T14:17:00Z")]))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("summary-session"))
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, negotiated) =
            AcpConnection::start_transport("alpha".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("summary agent starts");
        let manager = AgentManager::from_start_results(
            "alpha".to_string(),
            vec![(manifest("alpha", "Alpha"), Ok((connection, negotiated)))],
        )
        .await
        .expect("manager starts");

        let created = manager
            .new_session("alpha", NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let page = manager
            .list_sessions(None, 10)
            .await
            .expect("list succeeds");
        let summary = &page.sessions[0].snapshot;
        assert_eq!(summary.title.as_deref(), Some("Real session title"));
        assert_eq!(summary.updated_at.as_deref(), Some("2026-07-21T14:17:00Z"));
        assert_eq!(summary.thread_id, created.thread_id);

        let renamed = manager
            .rename_session(&created.thread_id, "Manual title")
            .await
            .expect("session renamed");
        assert_eq!(renamed.snapshot.title.as_deref(), Some("Manual title"));
        let refreshed = manager
            .list_sessions(None, 10)
            .await
            .expect("list after rename");
        assert_eq!(
            refreshed.sessions[0].snapshot.title.as_deref(),
            Some("Manual title")
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn discovered_subagent_inherits_parent_workspace_and_loads() {
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let ready = connection_with_capabilities(
            "alpha",
            AgentCapabilities::new().load_session(true),
            observed_tx,
        )
        .await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .expect("manager starts");
        let parent = AgentSessionId::new("alpha", "parent-session").unwrap();
        let parent_thread_id = parent.encode();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry_with_policy(
                parent.clone(),
                PathBuf::from("/tmp"),
                ApprovalPolicy::Never,
            )])
            .await
            .unwrap();

        let child_thread_id = manager
            .adopt_related_session(&parent_thread_id, "child-session", Some("Child task"))
            .await
            .expect("child adopted");
        let child = manager
            .read_session(&child_thread_id)
            .await
            .expect("child loads through ACP");
        assert_eq!(child.cwd, PathBuf::from("/tmp"));
        assert_eq!(
            child.parent_thread_id.as_deref(),
            Some(parent_thread_id.as_str())
        );
        assert_eq!(
            AgentSessionId::decode(&child.thread_id)
                .unwrap()
                .acp_session_id,
            "child-session"
        );
        assert_eq!(
            manager
                .session_index
                .lock()
                .await
                .entries
                .iter()
                .find(|entry| entry.acp_session_id == "child-session")
                .expect("child indexed")
                .approval_policy,
            ApprovalPolicy::Never
        );
        assert_eq!(
            manager
                .connection("alpha")
                .unwrap()
                .approval_policy(&SessionId::new("child-session"))
                .await,
            ApprovalPolicy::Never
        );
        assert_eq!(observed_rx.recv().await.as_deref(), Some("load:alpha"));
        manager
            .session_index
            .lock()
            .await
            .set_approval_policy(&parent, ApprovalPolicy::Untrusted)
            .await
            .unwrap();
        manager
            .adopt_related_session(&parent_thread_id, "child-session", Some("Child task"))
            .await
            .expect("existing child policy refreshed");
        assert_eq!(
            manager
                .session_index
                .lock()
                .await
                .entries
                .iter()
                .find(|entry| entry.acp_session_id == "child-session")
                .expect("child remains indexed")
                .approval_policy,
            ApprovalPolicy::Untrusted
        );
        assert_eq!(
            manager
                .connection("alpha")
                .unwrap()
                .approval_policy(&SessionId::new("child-session"))
                .await,
            ApprovalPolicy::Untrusted
        );
        manager
            .resume_session_with_policy(&parent_thread_id, "/tmp", ApprovalPolicy::OnRequest)
            .await
            .expect("parent workspace resume refreshes its family");
        assert_eq!(
            manager
                .connection("alpha")
                .unwrap()
                .approval_policy(&SessionId::new("child-session"))
                .await,
            ApprovalPolicy::OnRequest
        );
        assert!(manager
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .filter(|entry| {
                entry.acp_session_id == "parent-session" || entry.acp_session_id == "child-session"
            })
            .all(|entry| entry.approval_policy == ApprovalPolicy::OnRequest));
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn concurrent_subagent_adoption_keeps_the_canonical_parent_policy() {
        let (observed, _) = mpsc::unbounded_channel();
        let ready = connection("alpha", false, "unused", observed).await;
        let child_id = SessionId::new("shared-child");
        ready
            .0
            .ensure_session(child_id.clone())
            .await
            .expect("child session loaded");
        let manager = Arc::new(
            AgentManager::from_start_results(
                "alpha".into(),
                vec![(manifest("alpha", "Alpha"), Ok(ready))],
            )
            .await
            .expect("manager starts"),
        );
        let first_parent = AgentSessionId::new("alpha", "first-parent").unwrap();
        let second_parent = AgentSessionId::new("alpha", "second-parent").unwrap();
        let child = AgentSessionId::new("alpha", child_id.to_string()).unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([
                index_entry_with_policy(
                    first_parent.clone(),
                    PathBuf::from("/tmp"),
                    ApprovalPolicy::Never,
                ),
                index_entry_with_policy(
                    second_parent.clone(),
                    PathBuf::from("/tmp"),
                    ApprovalPolicy::Untrusted,
                ),
            ])
            .await
            .unwrap();

        let first_adoption = {
            let manager = manager.clone();
            let parent = first_parent.encode();
            let child = child.acp_session_id.clone();
            tokio::spawn(async move { manager.adopt_related_session(&parent, &child, None).await })
        };
        let second_adoption = {
            let manager = manager.clone();
            let parent = second_parent.encode();
            let child = child.acp_session_id.clone();
            tokio::spawn(async move { manager.adopt_related_session(&parent, &child, None).await })
        };
        first_adoption
            .await
            .expect("first adoption task")
            .expect("first parent discovery");
        second_adoption
            .await
            .expect("second adoption task")
            .expect("second parent discovery");

        let indexed_child = manager
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| entry.acp_session_id == child.acp_session_id)
            .cloned()
            .expect("child remains indexed");
        let expected_policy = match indexed_child.parent_acp_session_id.as_deref() {
            Some(parent) if parent == first_parent.acp_session_id => ApprovalPolicy::Never,
            Some(parent) if parent == second_parent.acp_session_id => ApprovalPolicy::Untrusted,
            parent => panic!("unexpected canonical parent: {parent:?}"),
        };
        assert_eq!(indexed_child.approval_policy, expected_policy);
        assert_eq!(
            manager
                .connection("alpha")
                .unwrap()
                .approval_policy(&child_id)
                .await,
            expected_policy
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn global_policy_uses_the_locked_pending_to_indexed_classification() {
        let (observed, _) = mpsc::unbounded_channel();
        let ready = connection("alpha", false, "unused", observed).await;
        let manager = Arc::new(
            AgentManager::from_start_results(
                "alpha".into(),
                vec![(manifest("alpha", "Alpha"), Ok(ready))],
            )
            .await
            .expect("manager starts"),
        );
        let identity = AgentSessionId::new("alpha", "transitioning").unwrap();
        let thread_id = identity.encode();
        let operation = manager
            .session_operation_lock(&thread_id)
            .await
            .lock_owned()
            .await;
        manager.pending_durable_sessions.lock().await.insert(
            thread_id,
            index_entry_with_policy(
                identity.clone(),
                PathBuf::from("/tmp"),
                ApprovalPolicy::Untrusted,
            ),
        );
        let snapshot = manager.pause_next_policy_snapshot().await;
        let update = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .set_all_session_approval_policies(ApprovalPolicy::Never)
                    .await
            })
        };
        snapshot.wait_until_reached().await;
        let transitioned = manager
            .pending_durable_sessions
            .lock()
            .await
            .remove(&identity.encode())
            .expect("pending session");
        manager
            .session_index
            .lock()
            .await
            .insert_all([transitioned])
            .await
            .unwrap();
        snapshot.release();
        drop(operation);

        update
            .await
            .expect("policy task")
            .expect("policy update succeeds");
        assert_eq!(
            manager
                .session_index
                .lock()
                .await
                .entries
                .iter()
                .find(|entry| entry.acp_session_id == identity.acp_session_id)
                .expect("session indexed")
                .approval_policy,
            ApprovalPolicy::Never
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn committed_global_policy_succeeds_when_live_delivery_is_unavailable() {
        let (observed, _) = mpsc::unbounded_channel();
        let ready = connection("alpha", false, "unused", observed).await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![
                (manifest("alpha", "Alpha"), Ok(ready)),
                (
                    manifest("beta", "Beta"),
                    Err(AcpRuntimeError::Connection("offline".to_string())),
                ),
            ],
        )
        .await
        .expect("manager starts");
        let offline = AgentSessionId::new("beta", "offline-session").unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry_with_policy(
                offline.clone(),
                PathBuf::from("/tmp"),
                ApprovalPolicy::Untrusted,
            )])
            .await
            .unwrap();

        manager
            .set_all_session_approval_policies(ApprovalPolicy::Never)
            .await
            .expect("durably committed policy is acknowledged");
        assert_eq!(
            manager
                .session_index
                .lock()
                .await
                .entries
                .iter()
                .find(|entry| entry.acp_session_id == offline.acp_session_id)
                .expect("offline session indexed")
                .approval_policy,
            ApprovalPolicy::Never
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn parent_prompt_updates_loaded_descendant_policies_before_dispatch() {
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let ready = connection("alpha", false, "unused", observed_tx).await;
        let child_id = SessionId::new("loaded-child");
        ready
            .0
            .ensure_session(child_id.clone())
            .await
            .expect("child session loaded");
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .expect("manager starts");
        let parent = manager
            .new_session("alpha", NewSessionRequest::new("/tmp"))
            .await
            .expect("parent session created");
        let parent_identity = AgentSessionId::decode(&parent.thread_id).unwrap();
        let child_identity = AgentSessionId::new("alpha", child_id.to_string()).unwrap();
        let mut child_entry = index_entry(child_identity.clone(), PathBuf::from("/tmp"));
        child_entry.parent_acp_session_id = Some(parent_identity.acp_session_id.clone());
        manager
            .session_index
            .lock()
            .await
            .insert_all([child_entry])
            .await
            .unwrap();

        manager
            .set_all_session_approval_policies(ApprovalPolicy::OnRequest)
            .await
            .expect("global policy applied");
        assert_eq!(
            manager
                .connection("alpha")
                .unwrap()
                .approval_policy(&SessionId::new(parent_identity.acp_session_id.clone()))
                .await,
            ApprovalPolicy::OnRequest
        );
        assert_eq!(
            manager
                .connection("alpha")
                .unwrap()
                .approval_policy(&child_id)
                .await,
            ApprovalPolicy::OnRequest
        );

        manager
            .prompt_with_policy_outcome(
                &parent.thread_id,
                vec!["update policy".into()],
                "family-run".to_string(),
                "family-turn".to_string(),
                ApprovalPolicy::Never,
            )
            .await
            .expect("parent prompt admitted");

        assert_eq!(
            manager
                .connection("alpha")
                .unwrap()
                .approval_policy(&child_id)
                .await,
            ApprovalPolicy::Never
        );
        let policies = manager
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .map(|entry| entry.approval_policy)
            .collect::<Vec<_>>();
        assert_eq!(policies, vec![ApprovalPolicy::Never, ApprovalPolicy::Never]);
        assert_eq!(observed_rx.recv().await.as_deref(), Some("prompt:alpha"));
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn late_child_terminal_loads_and_updates_the_parent_session() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let ready = connection_with_capabilities(
            "alpha",
            AgentCapabilities::new().load_session(true),
            observed_tx,
        )
        .await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .expect("manager starts");
        let parent = AgentSessionId::new("alpha", "parent-session").unwrap();
        let parent_thread_id = parent.encode();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(parent.clone(), PathBuf::from("/tmp"))])
            .await
            .unwrap();
        manager
            .read_session(&parent_thread_id)
            .await
            .expect("parent loads");
        let (_, parent_session_id, connection) = manager.route_thread(&parent_thread_id).unwrap();
        let parent_session = connection
            .session(&parent_session_id)
            .await
            .expect("loaded parent session");
        parent_session
            .emit(CanonicalEvent::Tool {
                agent_id: "alpha".to_string(),
                thread_id: parent_thread_id.clone(),
                run_id: Some("run-1".to_string()),
                source_turn_id: Some("turn-1".to_string()),
                generation: Some(1),
                tool_call_id: "task-1".to_string(),
                kind: ToolKind::Other,
                status: ToolCallStatus::InProgress,
                title: "Research dependency options".to_string(),
                content: FieldUpdate::Set(
                    "<task id=\"child-session\" state=\"running\">\nWorking\n</task>".to_string(),
                ),
                structured_content: FieldUpdate::Set(Vec::new()),
                locations: FieldUpdate::Set(Vec::new()),
            })
            .await;
        manager
            .agent_message_journal
            .lock()
            .await
            .upsert_many(vec![(
                parent_thread_id.clone(),
                Some("task-1".to_string()),
                sent_agent_message(
                    "terminal-update-message",
                    &AgentSessionId::new("alpha", "child-session")
                        .unwrap()
                        .encode(),
                ),
            )])
            .await
            .unwrap();

        let child_thread_id = manager
            .adopt_related_session(&parent_thread_id, "child-session", Some("Child task"))
            .await
            .expect("child adopted");
        let updated_parent = manager
            .mark_parent_subagent_terminal(&child_thread_id, "failed")
            .await
            .expect("parent correction succeeds")
            .expect("parent was updated");
        assert_eq!(
            updated_parent.snapshot.tools["task-1"].status,
            ToolCallStatus::Failed
        );
        assert_eq!(
            updated_parent.snapshot.subagent_header("task-1"),
            Some("<task id=\"child-session\" state=\"failed\">")
        );
        assert!(updated_parent.snapshot.messages.iter().any(|message| {
            message
                .agent_message
                .as_ref()
                .is_some_and(|origin| origin.message_id == "terminal-update-message")
        }));

        manager
            .note_subagent_link(&parent_thread_id, &child_thread_id, "task-old")
            .await;
        manager.note_subagent_started(&child_thread_id, 1).await;
        manager
            .note_subagent_link(&parent_thread_id, &child_thread_id, "task-new")
            .await;
        assert!(
            manager
                .accepted_subagent_terminal(&child_thread_id, 1)
                .await
                .is_none(),
            "stale child generation was accepted for a newer retask"
        );
        manager.note_subagent_started(&child_thread_id, 2).await;
        let current = manager
            .accepted_subagent_terminal(&child_thread_id, 2)
            .await
            .expect("current child generation was rejected");
        assert_eq!(current.tool_call_id, "task-new");
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn retask_after_retired_correlation_rejects_duplicate_old_terminal() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let ready = connection("alpha", false, "unused", observed_tx).await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .expect("manager starts");

        manager
            .note_subagent_link("parent", "child", "task-1")
            .await;
        manager.note_subagent_started("child", 1).await;
        let accepted = manager
            .accepted_subagent_terminal("child", 1)
            .await
            .expect("linked terminal accepted");
        assert_eq!(accepted.tool_call_id, "task-1");
        manager.retire_subagent_link("child", "task-1").await;

        manager
            .note_subagent_link("parent", "child", "task-2")
            .await;
        assert!(
            manager
                .accepted_subagent_terminal("child", 1)
                .await
                .is_none(),
            "duplicate old terminal was accepted for the rearmed retask"
        );
        manager.note_subagent_started("child", 2).await;
        let rearmed = manager
            .accepted_subagent_terminal("child", 2)
            .await
            .expect("new link rearmed correlation");
        assert_eq!(rearmed.tool_call_id, "task-2");
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn failed_parent_correction_keeps_terminal_correlation_retryable() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let ready = connection("alpha", false, "unused", observed_tx).await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .expect("manager starts");

        manager
            .note_subagent_link("parent", "child", "task-1")
            .await;
        manager.note_subagent_started("child", 1).await;
        assert!(manager
            .accepted_subagent_terminal("child", 1)
            .await
            .is_some());
        // A failed parent correction leaves the target armed for a duplicate
        // terminal notification to retry.
        assert!(manager
            .accepted_subagent_terminal("child", 1)
            .await
            .is_some());
        manager.retire_subagent_link("child", "task-1").await;
        assert!(manager
            .accepted_subagent_terminal("child", 1)
            .await
            .is_none());
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn terminal_task_link_does_not_authorize_a_later_independent_child_run() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let ready = connection("alpha", false, "unused", observed_tx).await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .expect("manager starts");

        manager
            .note_subagent_link("parent", "child", "task-1")
            .await;
        manager.retire_subagent_link("child", "task-1").await;
        manager.note_subagent_started("child", 2).await;
        assert!(
            manager
                .accepted_subagent_terminal("child", 2)
                .await
                .is_none(),
            "terminal wrapper left correlation armed for an independent child run"
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn terminal_discovered_task_retires_manager_correlation_even_when_adoption_fails() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let ready = connection("alpha", false, "unused", observed_tx).await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .expect("manager starts");

        manager
            .note_subagent_link("parent", "child", "task-terminal")
            .await;
        manager.retire_subagent_link("child", "task-terminal").await;
        // No adoption/index operation succeeds in this scenario. Retirement must
        // still happen before that fallible work.
        manager.note_subagent_started("child", 1).await;
        assert!(manager
            .accepted_subagent_terminal("child", 1)
            .await
            .is_none());
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn persisted_parent_task_snapshot_adopts_child_session() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let ready = connection("alpha", false, "unused", observed_tx).await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .expect("manager starts");
        let parent = manager
            .new_session("alpha", NewSessionRequest::new("/tmp"))
            .await
            .expect("parent created");
        let parent_identity = AgentSessionId::decode(&parent.thread_id).unwrap();
        manager
            .session_index
            .lock()
            .await
            .set_approval_policy(&parent_identity, ApprovalPolicy::Never)
            .await
            .unwrap();
        let (_, session_id, connection) = manager.route_thread(&parent.thread_id).unwrap();
        let session = connection
            .session(&session_id)
            .await
            .expect("parent loaded");
        session
            .emit(CanonicalEvent::Tool {
                agent_id: "alpha".into(),
                thread_id: parent.thread_id.clone(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                tool_call_id: "task-persisted".into(),
                kind: agent_client_protocol::schema::v1::ToolKind::Other,
                status: agent_client_protocol::schema::v1::ToolCallStatus::Completed,
                title: "task".into(),
                content: FieldUpdate::Set(
                    "<task id=\"child-persisted\" state=\"completed\"></task>".into(),
                ),
                structured_content: FieldUpdate::Set(Vec::new()),
                locations: FieldUpdate::Set(Vec::new()),
            })
            .await;

        manager
            .read_session(&parent.thread_id)
            .await
            .expect("parent read");
        let child_entry = manager
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| entry.agent_id == "alpha" && entry.acp_session_id == "child-persisted")
            .cloned()
            .expect("child indexed");
        assert_eq!(
            child_entry.parent_acp_session_id.as_deref(),
            Some(parent_identity.acp_session_id.as_str())
        );
        assert_eq!(child_entry.approval_policy, ApprovalPolicy::Never);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_consumes_remote_pages_and_dedupes_repeated_cursor_results() {
        let ready = paginated_connection("alpha").await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .unwrap();
        let sessions = manager.list_sessions(None, 100).await.unwrap().sessions;
        let session_ids = sessions
            .iter()
            .map(|session| {
                AgentSessionId::decode(&session.thread_id)
                    .unwrap()
                    .acp_session_id
            })
            .collect::<Vec<_>>();
        assert_eq!(session_ids, vec!["alpha", "duplicate", "zulu"]);
        let page = manager.list_sessions(None, 100).await.unwrap();
        assert_eq!(
            page.diagnostics,
            vec![SessionListDiagnostic::RepeatedCursor]
        );
        assert!(manager.loaded_session_ids().await.is_empty());
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_bounds_endless_empty_and_duplicate_only_remote_pagination() {
        for (fixture, expected_requests, expected_diagnostic, expected_sessions) in [
            (
                PaginationFixture::Endless,
                MAX_SESSION_LIST_PAGES,
                SessionListDiagnostic::PageBudgetExhausted,
                MAX_SESSION_LIST_PAGES + 1,
            ),
            (
                PaginationFixture::Empty,
                1,
                SessionListDiagnostic::EmptyPage,
                1,
            ),
            (
                PaginationFixture::DuplicateOnly,
                2,
                SessionListDiagnostic::DuplicateOnlyPage,
                2,
            ),
            (
                PaginationFixture::MaxSessions,
                1,
                SessionListDiagnostic::MaxSessionsReached,
                MAX_SESSIONS,
            ),
            (
                PaginationFixture::Failure,
                1,
                SessionListDiagnostic::NativeListFailed,
                1,
            ),
        ] {
            let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let ready = adversarial_paginated_connection("alpha", fixture, requests.clone()).await;
            let manager = AgentManager::from_start_results(
                "alpha".into(),
                vec![(manifest("alpha", "Alpha"), Ok(ready))],
            )
            .await
            .unwrap();
            manager
                .session_index
                .lock()
                .await
                .insert_all([index_entry(
                    AgentSessionId::new("alpha", "durable-only").unwrap(),
                    PathBuf::from("/tmp"),
                )])
                .await
                .unwrap();
            let page = manager.list_sessions(None, 100).await.unwrap();
            assert_eq!(requests.load(Ordering::SeqCst), expected_requests);
            assert_eq!(page.sessions.len(), expected_sessions.min(MAX_PAGE_SIZE));
            assert!(page.sessions.iter().any(|session| {
                AgentSessionId::decode(&session.thread_id)
                    .is_ok_and(|identity| identity.acp_session_id == "durable-only")
            }));
            assert_eq!(page.diagnostics, vec![expected_diagnostic]);
            assert!(page.partial);
            manager.shutdown().await;
        }
    }

    #[tokio::test]
    async fn durable_index_survives_restart_for_agent_without_list_capability() {
        let directory =
            std::env::temp_dir().join(format!("dappercode-session-index-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let index_path = directory.join(SESSION_INDEX_FILE);
        let (observed, _) = mpsc::unbounded_channel();
        let first_connection = connection("alpha", false, "unused", observed).await;
        let first = AgentManager::from_start_results_with_index(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(first_connection))],
            Some(index_path.clone()),
            PathBuf::from("/tmp"),
            true,
        )
        .await
        .unwrap();
        let created = first
            .new_session("alpha", NewSessionRequest::new("/tmp"))
            .await
            .unwrap();
        first.shutdown().await;

        let (observed, _) = mpsc::unbounded_channel();
        let restarted_connection = connection("alpha", false, "unused", observed).await;
        let restarted = AgentManager::from_start_results_with_index(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(restarted_connection))],
            Some(index_path),
            PathBuf::from("/tmp"),
            true,
        )
        .await
        .unwrap();
        let history = restarted.list_sessions(None, 1).await.unwrap();
        assert_eq!(history.sessions.len(), 1);
        assert_eq!(history.sessions[0].thread_id, created.thread_id);
        assert_eq!(
            history.sessions[0].cwd,
            std::fs::canonicalize("/tmp").unwrap()
        );
        assert!(history.next_cursor.is_none());
        assert!(restarted.loaded_session_ids().await.is_empty());
        restarted.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn durable_reads_lazy_reconstruct_typed_history_once_for_read_and_page() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-session-lazy-read-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let index_path = directory.join(SESSION_INDEX_FILE);
        let identity = AgentSessionId::new("alpha", "durable").unwrap();
        let mut index = DurableSessionIndex::load(Some(index_path.clone())).await;
        index
            .insert_all([index_entry(identity.clone(), directory.clone())])
            .await
            .unwrap();

        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let capabilities = AgentCapabilities::new().session_capabilities(
            SessionCapabilities::new().resume(SessionResumeCapabilities::new()),
        );
        let response_barrier = Arc::new((tokio::sync::Notify::new(), tokio::sync::Notify::new()));
        let ready = reconstructing_connection(
            "alpha",
            capabilities,
            requests.clone(),
            false,
            Some(response_barrier.clone()),
        )
        .await;
        let manager = Arc::new(
            AgentManager::from_start_results_with_index(
                "alpha".into(),
                vec![(manifest("alpha", "Alpha"), Ok(ready))],
                Some(index_path),
                directory.clone(),
                false,
            )
            .await
            .unwrap(),
        );
        let thread_id = identity.encode();
        let first = {
            let manager = manager.clone();
            let thread_id = thread_id.clone();
            tokio::spawn(async move { manager.read_session(&thread_id).await })
        };
        response_barrier.0.notified().await;
        assert!(manager.loaded_session_ids().await.is_empty());
        let second = {
            let manager = manager.clone();
            let thread_id = thread_id.clone();
            tokio::spawn(async move { manager.read_session(&thread_id).await })
        };
        tokio::task::yield_now().await;
        assert!(!second.is_finished());
        response_barrier.1.notify_one();
        let first = first.await.unwrap();
        let second = second.await.unwrap();
        for session in [first.unwrap(), second.unwrap()] {
            assert_eq!(session.snapshot.messages.len(), 1);
            assert_eq!(session.snapshot.messages[0].parts[0]["text"], "restored");
        }
        let page = manager
            .snapshot_page(&thread_id, None, None, 10)
            .await
            .unwrap();
        assert_eq!(page.entries.len(), 1);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        manager.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn durable_read_falls_back_to_load_and_rejects_unsupported_or_invalid_cwd() {
        for (capabilities, expected_requests) in [
            (AgentCapabilities::new().load_session(true), 1),
            (AgentCapabilities::new(), 0),
        ] {
            let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let ready =
                reconstructing_connection("alpha", capabilities, requests.clone(), false, None)
                    .await;
            let manager = AgentManager::from_start_results(
                "alpha".into(),
                vec![(manifest("alpha", "Alpha"), Ok(ready))],
            )
            .await
            .unwrap();
            let identity = AgentSessionId::new("alpha", "durable").unwrap();
            manager
                .session_index
                .lock()
                .await
                .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
                .await
                .unwrap();
            let result = manager.read_session(&identity.encode()).await;
            if expected_requests == 1 {
                assert_eq!(result.unwrap().snapshot.messages.len(), 1);
            } else {
                assert!(matches!(
                    result,
                    Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
                        "session/resume or session/load"
                    )))
                ));
            }
            assert_eq!(requests.load(Ordering::SeqCst), expected_requests);
            manager.shutdown().await;
        }

        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ready = reconstructing_connection(
            "alpha",
            AgentCapabilities::new().load_session(true),
            requests.clone(),
            false,
            None,
        )
        .await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .unwrap();
        let identity = AgentSessionId::new("alpha", "stale").unwrap();
        manager.session_index.lock().await.entries.push(index_entry(
            identity.clone(),
            PathBuf::from("/definitely/missing/dappercode-workspace"),
        ));
        assert!(matches!(
            manager.read_session(&identity.encode()).await,
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn failed_lazy_reconstruction_does_not_register_empty_live_session() {
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ready = reconstructing_connection(
            "alpha",
            AgentCapabilities::new().load_session(true),
            requests.clone(),
            true,
            None,
        )
        .await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .unwrap();
        let identity = AgentSessionId::new("alpha", "fails").unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
            .await
            .unwrap();
        assert!(manager.read_session(&identity.encode()).await.is_err());
        assert!(manager.loaded_session_ids().await.is_empty());
        assert!(manager.read_session(&identity.encode()).await.is_err());
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn durable_index_rejects_invalid_storage_and_bounds_valid_entries() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-session-index-validation-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(SESSION_INDEX_FILE);

        for contents in [
            br#"{"version":2,"sessions":[]}"#.as_slice(),
            br#"{"version":1,"sessions":[],"extra":true}"#.as_slice(),
            b"not json".as_slice(),
        ] {
            std::fs::write(&path, contents).unwrap();
            assert!(DurableSessionIndex::load(Some(path.clone()))
                .await
                .entries
                .is_empty());
        }
        std::fs::write(
            &path,
            br#"{"version":2,"sessions":[{"agentId":"alpha","acpSessionId":"legacy","cwd":"/tmp"}]}"#,
        )
        .unwrap();
        let legacy = DurableSessionIndex::load(Some(path.clone())).await;
        assert_eq!(legacy.entries.len(), 1);
        assert_eq!(legacy.entries[0].approval_policy, ApprovalPolicy::Untrusted);
        std::fs::write(&path, vec![b'x'; MAX_SESSION_INDEX_BYTES + 1]).unwrap();
        assert!(DurableSessionIndex::load(Some(path.clone()))
            .await
            .entries
            .is_empty());

        let valid = SessionIndexEntry {
            agent_id: "alpha".into(),
            acp_session_id: "valid".into(),
            cwd: PathBuf::from("/tmp"),
            approval_policy: ApprovalPolicy::Untrusted,
            title: None,
            parent_acp_session_id: None,
            forked_from_acp_session_id: None,
        };
        let other_session = SessionIndexEntry {
            agent_id: "alpha".into(),
            acp_session_id: "valid-two".into(),
            cwd: PathBuf::from("/tmp"),
            approval_policy: ApprovalPolicy::Untrusted,
            title: None,
            parent_acp_session_id: None,
            forked_from_acp_session_id: None,
        };
        let other_agent = SessionIndexEntry {
            agent_id: "beta".into(),
            acp_session_id: "valid".into(),
            cwd: PathBuf::from("/tmp"),
            approval_policy: ApprovalPolicy::Untrusted,
            title: None,
            parent_acp_session_id: None,
            forked_from_acp_session_id: None,
        };
        let entries = sanitize_index_entries(vec![
            valid.clone(),
            valid.clone(),
            other_session.clone(),
            other_agent.clone(),
            SessionIndexEntry {
                agent_id: "bad/agent".into(),
                acp_session_id: "invalid".into(),
                cwd: PathBuf::from("/tmp"),
                approval_policy: ApprovalPolicy::Untrusted,
                title: None,
                parent_acp_session_id: None,
                forked_from_acp_session_id: None,
            },
            SessionIndexEntry {
                agent_id: "alpha".into(),
                acp_session_id: "relative".into(),
                cwd: PathBuf::from("relative"),
                approval_policy: ApprovalPolicy::Untrusted,
                title: None,
                parent_acp_session_id: None,
                forked_from_acp_session_id: None,
            },
            SessionIndexEntry {
                agent_id: "alpha".into(),
                acp_session_id: "oversized-cwd".into(),
                cwd: PathBuf::from(format!("/{}", "x".repeat(MAX_SESSION_CWD_BYTES))),
                approval_policy: ApprovalPolicy::Untrusted,
                title: None,
                parent_acp_session_id: None,
                forked_from_acp_session_id: None,
            },
            SessionIndexEntry {
                agent_id: "alpha".into(),
                acp_session_id: "self-parent".into(),
                cwd: PathBuf::from("/tmp"),
                approval_policy: ApprovalPolicy::Untrusted,
                title: None,
                parent_acp_session_id: Some("self-parent".into()),
                forked_from_acp_session_id: None,
            },
        ]);
        assert_eq!(entries, vec![valid, other_session, other_agent]);

        let mut persisted = DurableSessionIndex::load(Some(path.clone())).await;
        persisted
            .insert_all([SessionIndexEntry {
                agent_id: "alpha".into(),
                acp_session_id: "titled".into(),
                cwd: PathBuf::from("/tmp"),
                approval_policy: ApprovalPolicy::Untrusted,
                title: Some("Manual title".into()),
                parent_acp_session_id: None,
                forked_from_acp_session_id: None,
            }])
            .await
            .unwrap();
        persisted
            .set_approval_policy(
                &AgentSessionId::new("alpha", "titled").unwrap(),
                ApprovalPolicy::Never,
            )
            .await
            .unwrap();
        let reloaded = DurableSessionIndex::load(Some(path.clone())).await;
        assert_eq!(reloaded.entries[0].title.as_deref(), Some("Manual title"));
        assert_eq!(reloaded.entries[0].approval_policy, ApprovalPolicy::Never);

        let mut memory_only = DurableSessionIndex::load(None).await;
        let original = SessionIndexEntry {
            agent_id: "alpha".into(),
            acp_session_id: "memory".into(),
            cwd: PathBuf::from("/tmp/original"),
            approval_policy: ApprovalPolicy::Never,
            title: Some("Original title".into()),
            parent_acp_session_id: Some("original-parent".into()),
            forked_from_acp_session_id: None,
        };
        memory_only.insert_all([original]).await.unwrap();
        memory_only
            .insert_all([SessionIndexEntry {
                agent_id: "alpha".into(),
                acp_session_id: "memory".into(),
                cwd: PathBuf::from("/tmp/updated"),
                approval_policy: ApprovalPolicy::Untrusted,
                title: None,
                parent_acp_session_id: None,
                forked_from_acp_session_id: None,
            }])
            .await
            .unwrap();
        assert_eq!(memory_only.entries.len(), 1);
        assert_eq!(memory_only.entries[0].cwd, PathBuf::from("/tmp/updated"));
        assert_eq!(
            memory_only.entries[0].title.as_deref(),
            Some("Original title")
        );
        assert_eq!(
            memory_only.entries[0].parent_acp_session_id.as_deref(),
            Some("original-parent")
        );
        assert_eq!(
            memory_only.entries[0].approval_policy,
            ApprovalPolicy::Never
        );
        let replacement = SessionIndexEntry {
            agent_id: "alpha".into(),
            acp_session_id: "memory".into(),
            cwd: PathBuf::from("/tmp/replaced"),
            approval_policy: ApprovalPolicy::Untrusted,
            title: Some("Replacement title".into()),
            parent_acp_session_id: Some("replacement-parent".into()),
            forked_from_acp_session_id: None,
        };
        memory_only.insert_all([replacement.clone()]).await.unwrap();
        memory_only.insert_all([replacement]).await.unwrap();
        assert_eq!(
            memory_only.entries[0].title.as_deref(),
            Some("Replacement title")
        );
        assert_eq!(
            memory_only.entries[0].parent_acp_session_id.as_deref(),
            Some("original-parent")
        );
        assert_eq!(
            memory_only.entries[0].approval_policy,
            ApprovalPolicy::Never
        );
        memory_only
            .set_approval_policy(
                &AgentSessionId::new("alpha", "memory").unwrap(),
                ApprovalPolicy::Untrusted,
            )
            .await
            .unwrap();
        assert_eq!(
            memory_only.entries[0].approval_policy,
            ApprovalPolicy::Untrusted
        );
        memory_only
            .insert_all((0..=MAX_SESSIONS).map(|index| {
                index_entry(
                    AgentSessionId::new("alpha", format!("bounded-{index:04}")).unwrap(),
                    PathBuf::from("/tmp"),
                )
            }))
            .await
            .unwrap();
        assert_eq!(memory_only.entries.len(), MAX_SESSIONS);
        assert!(!memory_only
            .entries
            .iter()
            .any(|entry| entry.acp_session_id == "bounded-0000"));

        let missing_parent = directory.join("missing").join(SESSION_INDEX_FILE);
        let mut unwritable = DurableSessionIndex::load(Some(missing_parent)).await;
        let before = unwritable.entries.clone();
        assert!(matches!(
            unwritable
                .insert_all([index_entry(
                    AgentSessionId::new("alpha", "failed-write").unwrap(),
                    PathBuf::from("/tmp"),
                )])
                .await,
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert_eq!(unwritable.entries, before);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn durable_policy_sweep_skips_sessions_that_vanished_after_its_snapshot() {
        let mut index = DurableSessionIndex::load(None).await;
        let existing = AgentSessionId::new("alpha", "existing").unwrap();
        let vanished = AgentSessionId::new("alpha", "vanished").unwrap();
        index
            .insert_all([index_entry(existing.clone(), PathBuf::from("/tmp"))])
            .await
            .unwrap();

        index
            .set_existing_approval_policies(&[
                (vanished, ApprovalPolicy::Never),
                (existing.clone(), ApprovalPolicy::Never),
            ])
            .await
            .expect("vanished sessions do not reject the whole policy sweep");

        assert_eq!(index.entries.len(), 1);
        assert_eq!(index.entries[0].acp_session_id, existing.acp_session_id);
        assert_eq!(index.entries[0].approval_policy, ApprovalPolicy::Never);
    }

    #[tokio::test]
    async fn durable_index_write_failure_rolls_back_and_retry_survives_restart() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-session-index-transaction-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(SESSION_INDEX_FILE);
        let original = index_entry(
            AgentSessionId::new("alpha", "original").unwrap(),
            directory.clone(),
        );
        let retry = index_entry(
            AgentSessionId::new("alpha", "retry").unwrap(),
            directory.clone(),
        );
        let mut index = DurableSessionIndex::load(Some(path.clone())).await;
        index.insert_all([original.clone()]).await.unwrap();
        let old_bytes = std::fs::read(&path).unwrap();
        index.fail_writes = true;
        assert!(matches!(
            index.insert_all([retry.clone()]).await,
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert_eq!(index.entries, vec![original.clone()]);
        assert_eq!(std::fs::read(&path).unwrap(), old_bytes);

        index.fail_writes = false;
        index
            .insert_all([retry.clone(), retry.clone()])
            .await
            .unwrap();
        assert_eq!(index.entries, vec![original.clone(), retry.clone()]);
        let restarted = DurableSessionIndex::load(Some(path)).await;
        assert_eq!(restarted.entries, vec![original, retry]);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn create_durability_failure_is_explicit_and_pending_list_flush_retries() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-session-create-durability-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let index_path = directory.join(SESSION_INDEX_FILE);
        let (observed, _) = mpsc::unbounded_channel();
        let ready = connection("alpha", false, "unused", observed).await;
        let manager = AgentManager::from_start_results_with_index(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
            Some(index_path.clone()),
            directory.clone(),
            false,
        )
        .await
        .unwrap();
        manager.session_index.lock().await.fail_writes = true;
        let failure = manager
            .new_session_with_policy_outcome(
                "alpha",
                NewSessionRequest::new(directory.clone()),
                ApprovalPolicy::Never,
                RequestCancellation::default(),
            )
            .await
            .expect_err("post-creation durability failure is reported");
        assert!(failure.is_indeterminate());
        assert!(matches!(
            failure.into_error(),
            AgentManagerError::SessionIndex(_)
        ));
        assert_eq!(manager.loaded_session_ids().await.len(), 1);
        let pending = manager.pending_durable_sessions.lock().await;
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending
                .values()
                .next()
                .expect("pending session")
                .approval_policy,
            ApprovalPolicy::Never
        );
        drop(pending);
        assert!(manager.session_index.lock().await.entries.is_empty());

        manager.session_index.lock().await.fail_writes = false;
        let listed = manager.list_sessions(None, 10).await.unwrap();
        assert_eq!(listed.sessions.len(), 1);
        assert!(manager.pending_durable_sessions.lock().await.is_empty());
        assert_eq!(manager.session_index.lock().await.entries.len(), 1);
        manager.shutdown().await;

        let restarted = DurableSessionIndex::load(Some(index_path)).await;
        assert_eq!(restarted.entries.len(), 1);
        assert_eq!(restarted.entries[0].approval_policy, ApprovalPolicy::Never);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn resume_durability_failure_retains_live_session_and_flushes_on_retry() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-session-resume-durability-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let index_path = directory.join(SESSION_INDEX_FILE);
        let (observed, _) = mpsc::unbounded_channel();
        let ready = connection_with_capabilities(
            "alpha",
            AgentCapabilities::new().load_session(true),
            observed,
        )
        .await;
        let manager = AgentManager::from_start_results_with_index(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
            Some(index_path.clone()),
            directory.clone(),
            false,
        )
        .await
        .unwrap();
        manager.session_index.lock().await.fail_writes = true;
        let identity = AgentSessionId::new("alpha", "resume-pending").unwrap();
        assert!(matches!(
            manager
                .resume_session(&identity.encode(), directory.clone())
                .await,
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert_eq!(manager.loaded_session_ids().await, vec![identity.encode()]);
        assert_eq!(manager.pending_durable_sessions.lock().await.len(), 1);

        manager.session_index.lock().await.fail_writes = false;
        let listed = manager.list_sessions(None, 10).await.unwrap();
        assert_eq!(listed.sessions.len(), 1);
        assert!(manager.pending_durable_sessions.lock().await.is_empty());
        manager.shutdown().await;
        assert_eq!(
            DurableSessionIndex::load(Some(index_path))
                .await
                .entries
                .len(),
            1
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn workspace_policy_canonicalizes_relative_paths_and_rejects_outside_root() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-session-workspace-policy-{}",
            uuid::Uuid::new_v4()
        ));
        let nested = directory.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let file = directory.join("file");
        std::fs::write(&file, "not a directory").unwrap();
        let manager = AgentManager::from_start_results_with_index(
            "alpha".into(),
            Vec::new(),
            None,
            directory.clone(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(
            manager.validate_cwd(Path::new("nested")).unwrap(),
            std::fs::canonicalize(&nested).unwrap()
        );
        assert!(matches!(
            manager.validate_cwd(Path::new("/tmp")),
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert!(matches!(
            manager.validate_cwd(&file),
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert!(manager.flush_pending_durable_sessions().await.is_ok());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn manager_delete_removes_the_durable_entry_and_stops_listing_the_session() {
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("delete-agent", true, false, observed_tx).await;
        let manager = AgentManager::from_start_results(
            "delete-agent".to_string(),
            vec![(manifest("delete-agent", "Delete"), Ok(connection))],
        )
        .await
        .unwrap();
        let identity = AgentSessionId::new("delete-agent", "delete-agent-listed").unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
            .await
            .unwrap();
        let thread_id = identity.encode();
        assert!(manager
            .list_sessions(None, 100)
            .await
            .unwrap()
            .sessions
            .iter()
            .any(|session| session.thread_id == thread_id));

        manager.delete_session(&thread_id).await.unwrap();

        assert_eq!(
            observed_rx.recv().await.as_deref(),
            Some("delete:delete-agent:delete-agent-listed")
        );
        assert!(manager.session_index.lock().await.entries.is_empty());
        assert!(manager.loaded_session_ids().await.is_empty());
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_delete_session_index_failure_retains_family_evidence_after_acp_apply() {
        let directory = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("delete-index-failure-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let connection = post_apply_deleting_connection("delete-agent", observed_tx).await;
        let manager = AgentManager::from_start_results_with_index(
            "delete-agent".to_string(),
            vec![(manifest("delete-agent", "Delete"), Ok(connection))],
            Some(directory.join(SESSION_INDEX_FILE)),
            directory.clone(),
            false,
        )
        .await
        .unwrap();
        let parent = AgentSessionId::new("delete-agent", "delete-agent-listed").unwrap();
        let child = AgentSessionId::new("delete-agent", "indexed-child").unwrap();
        let mut child_entry = index_entry(child.clone(), directory.clone());
        child_entry.parent_acp_session_id = Some(parent.acp_session_id.clone());
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(parent.clone(), directory.clone()), child_entry])
            .await
            .unwrap();
        manager
            .connection("delete-agent")
            .unwrap()
            .ensure_session(SessionId::new(parent.acp_session_id.clone()))
            .await
            .expect("seed a locally cached session before deletion");
        manager.session_index.lock().await.fail_writes = true;

        assert!(matches!(
            manager.delete_session(&parent.encode()).await,
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert_eq!(
            observed_rx.recv().await.as_deref(),
            Some("delete:delete-agent:delete-agent-listed")
        );
        let mut retained = manager
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .map(|entry| entry.acp_session_id.clone())
            .collect::<Vec<_>>();
        retained.sort();
        assert_eq!(
            retained,
            vec![
                "delete-agent-listed".to_string(),
                "indexed-child".to_string()
            ]
        );
        assert_eq!(
            manager.reconcile_retirement_plan(&[parent.encode()]).await,
            RetirementPlanReconciliation::Absent
        );
        let mut expanded = manager
            .expand_retirement_family(&[parent.encode()])
            .await
            .unwrap();
        expanded.sort();
        let mut expected = vec![parent.encode(), child.encode()];
        expected.sort();
        assert_eq!(expanded, expected);

        manager.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn manager_delete_waits_for_the_session_operation_lock() {
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("delete-agent", true, false, observed_tx).await;
        let manager = Arc::new(
            AgentManager::from_start_results(
                "delete-agent".to_string(),
                vec![(manifest("delete-agent", "Delete"), Ok(connection))],
            )
            .await
            .unwrap(),
        );
        let identity = AgentSessionId::new("delete-agent", "delete-agent-listed").unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
            .await
            .unwrap();
        let thread_id = identity.encode();
        let operation = manager
            .session_operation_lock(&thread_id)
            .await
            .lock_owned()
            .await;
        let deletion = {
            let manager = manager.clone();
            let thread_id = thread_id.clone();
            tokio::spawn(async move { manager.delete_session(&thread_id).await })
        };

        assert!(
            tokio::time::timeout(Duration::from_millis(50), observed_rx.recv())
                .await
                .is_err(),
            "delete reached the agent while a policy/family operation owned the session lock"
        );
        drop(operation);
        deletion
            .await
            .expect("delete task")
            .expect("delete succeeds after operation finishes");
        assert_eq!(
            observed_rx.recv().await.as_deref(),
            Some("delete:delete-agent:delete-agent-listed")
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn prepared_scope_hook_failure_aborts_before_acp_delete() {
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("delete-agent", true, false, observed_tx).await;
        let manager = AgentManager::from_start_results(
            "delete-agent".to_string(),
            vec![(manifest("delete-agent", "Delete"), Ok(connection))],
        )
        .await
        .unwrap();
        let identity = AgentSessionId::new("delete-agent", "delete-agent-listed").unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
            .await
            .unwrap();
        manager
            .connection("delete-agent")
            .unwrap()
            .ensure_session(SessionId::new(identity.acp_session_id.clone()))
            .await
            .expect("seed loaded session");
        let thread_id = identity.encode();

        let deletion = manager
            .prepare_session_deletion(&thread_id)
            .await
            .expect("lock deletion scope");
        assert_eq!(deletion.affected_thread_ids(), vec![thread_id.clone()]);
        let hook_result: Result<(), &str> = Err("injected pre-delete hook failure");
        assert!(hook_result.is_err());
        deletion.abort().await;

        assert!(
            observed_rx.try_recv().is_err(),
            "ACP deletion is only invoked by executing a successfully prepared plan"
        );
        assert_eq!(manager.session_index.lock().await.entries.len(), 1);
        assert!(manager.loaded_session_ids().await.contains(&thread_id));
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn operation_lock_pruning_preserves_identity_while_contended() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("delete-agent", true, false, observed_tx).await;
        let manager = AgentManager::from_start_results(
            "delete-agent".to_string(),
            vec![(manifest("delete-agent", "Delete"), Ok(connection))],
        )
        .await
        .unwrap();
        let thread_id = "contended-thread";
        let original = manager.session_operation_lock(thread_id).await;
        let held = original.clone().lock_owned().await;
        let waiter = {
            let operation = original.clone();
            tokio::spawn(async move { operation.lock_owned().await })
        };
        tokio::task::yield_now().await;

        manager.prune_session_operation_lock(thread_id).await;
        let while_queued = manager.session_operation_lock(thread_id).await;
        assert!(Arc::ptr_eq(&original, &while_queued));

        drop(held);
        let waiter_guard = waiter.await.expect("operation waiter");
        manager.prune_session_operation_lock(thread_id).await;
        let while_held = manager.session_operation_lock(thread_id).await;
        assert!(Arc::ptr_eq(&original, &while_held));

        drop(waiter_guard);
        drop(while_held);
        drop(while_queued);
        drop(original);
        manager.prune_session_operation_lock(thread_id).await;
        assert!(!manager
            .reconstruction_locks
            .lock()
            .await
            .contains_key(thread_id));
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn stale_subagent_adoption_cannot_recreate_a_child_after_parent_deletion() {
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("delete-agent", true, false, observed_tx).await;
        let manager = Arc::new(
            AgentManager::from_start_results(
                "delete-agent".to_string(),
                vec![(manifest("delete-agent", "Delete"), Ok(connection))],
            )
            .await
            .unwrap(),
        );
        let parent = AgentSessionId::new("delete-agent", "parent").unwrap();
        let child = AgentSessionId::new("delete-agent", "child").unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(parent.clone(), PathBuf::from("/tmp"))])
            .await
            .unwrap();
        let mut stale_child = index_entry(child, PathBuf::from("/tmp"));
        stale_child.parent_acp_session_id = Some(parent.acp_session_id.clone());
        let parent_thread_id = parent.encode();
        let operation = manager
            .session_operation_lock(&parent_thread_id)
            .await
            .lock_owned()
            .await;
        let deletion = {
            let manager = manager.clone();
            let parent_thread_id = parent_thread_id.clone();
            tokio::spawn(async move { manager.delete_session(&parent_thread_id).await })
        };
        tokio::task::yield_now().await;
        let adoption = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .persist_inherited_entries(std::slice::from_ref(&stale_child))
                    .await
            })
        };
        tokio::task::yield_now().await;

        drop(operation);
        deletion
            .await
            .expect("delete task")
            .expect("parent deletion succeeds");
        assert_eq!(
            observed_rx.recv().await.as_deref(),
            Some("delete:delete-agent:parent")
        );
        assert!(matches!(
            adoption.await.expect("adoption task"),
            Err(AgentManagerError::SessionIndex(message))
                if message == "parent session is no longer indexed"
        ));
        assert!(manager.session_index.lock().await.entries.is_empty());
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_fork_rejects_busy_missing_first_unindexed_and_unsupported_sources() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("plain-agent", false, false, observed_tx).await;
        let session_id = SessionId::new("fork-source");
        let session = connection
            .0
            .ensure_session(session_id.clone())
            .await
            .expect("source session");
        let manager = AgentManager::from_start_results(
            "plain-agent".to_string(),
            vec![(manifest("plain-agent", "Plain"), Ok(connection))],
        )
        .await
        .expect("manager");
        let identity = AgentSessionId::new("plain-agent", "fork-source").unwrap();
        let thread_id = identity.encode();
        let unknown_agent = manager
            .new_session_with_cancellation_outcome(
                "missing-agent",
                NewSessionRequest::new("."),
                RequestCancellation::default(),
            )
            .await
            .expect_err("unknown agent is rejected before session creation");
        assert!(!unknown_agent.is_indeterminate());
        assert!(matches!(
            unknown_agent.into_error(),
            AgentManagerError::UnknownAgent(_)
        ));

        let (generation, _) = session
            .admit_prompt("run".to_string(), "turn".to_string())
            .await
            .expect("active prompt");
        assert!(matches!(
            manager.fork_session(&thread_id, "missing").await,
            Err(AgentManagerError::Runtime(AcpRuntimeError::SessionBusy))
        ));
        session
            .emit(CanonicalEvent::RunFinished {
                agent_id: "plain-agent".to_string(),
                thread_id: thread_id.clone(),
                run_id: "run".to_string(),
                source_turn_id: "turn".to_string(),
                generation,
                stop_reason: StopReason::EndTurn,
            })
            .await;
        let missing_boundary = manager
            .fork_session_with_outcome(&thread_id, "missing")
            .await
            .expect_err("missing boundary is rejected before forking");
        assert!(!missing_boundary.is_indeterminate());
        assert!(matches!(
            missing_boundary.into_error(),
            AgentManagerError::Fork(_)
        ));

        for (id, content) in [("user-1", "first"), ("user-2", "second")] {
            session
                .emit(CanonicalEvent::MessageChunk {
                    agent_id: "plain-agent".to_string(),
                    thread_id: thread_id.clone(),
                    run_id: None,
                    source_turn_id: None,
                    generation: None,
                    role: MessageRole::User,
                    message_id: id.to_string(),
                    content: content.to_string(),
                    content_block: None,
                })
                .await;
        }
        session
            .emit(CanonicalEvent::MessageChunk {
                agent_id: "plain-agent".to_string(),
                thread_id: thread_id.clone(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::Agent,
                message_id: "agent-2".to_string(),
                content: "answer".to_string(),
                content_block: None,
            })
            .await;
        assert!(matches!(
            manager.fork_session(&thread_id, "user-1").await,
            Err(AgentManagerError::Fork(_))
        ));
        assert!(matches!(
            manager.fork_session(&thread_id, "user-2").await,
            Err(AgentManagerError::SessionIndex(_))
        ));
        // The newest response names the end of history, so it resolves the same way any request
        // does and only fails later, on the missing index entry.
        assert!(matches!(
            manager.fork_session(&thread_id, "agent-2").await,
            Err(AgentManagerError::SessionIndex(_))
        ));

        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(identity, PathBuf::from("/tmp"))])
            .await
            .expect("index source");
        assert!(matches!(
            manager.fork_session(&thread_id, "user-2").await,
            Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
                "session/fork"
            )))
        ));
        assert!(!manager
            .supports_steer(&thread_id)
            .expect("unsupported steer projection"));
        let epoch = manager
            .prepare_steer(&thread_id)
            .await
            .expect("prepare unsupported steer");
        assert!(matches!(
            manager
                .steer(
                    &thread_id,
                    "run".to_string(),
                    "turn".to_string(),
                    1,
                    epoch + 1,
                    Vec::new(),
                )
                .await,
            Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
                "stale steer interaction epoch"
            )))
        ));
        assert!(matches!(
            manager
                .steer(
                    &thread_id,
                    "run".to_string(),
                    "turn".to_string(),
                    1,
                    epoch,
                    Vec::new(),
                )
                .await,
            Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
                "session/steer"
            )))
        ));
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_rolls_back_an_adapter_fork_that_cannot_be_reconstructed() {
        async fn messages(AxumPath(session_id): AxumPath<String>) -> Json<serde_json::Value> {
            if session_id == "source" {
                Json(serde_json::json!([
                    {"info": {"id": "raw-1", "role": "user"}, "parts": [{"type": "text", "text": "first"}]},
                    {"info": {"id": "raw-2", "role": "user"}, "parts": [{"type": "text", "text": "second"}]}
                ]))
            } else {
                Json(serde_json::json!([
                    {"info": {"id": "raw-1", "role": "user"}, "parts": [{"type": "text", "text": "first"}]}
                ]))
            }
        }

        let app = Router::new()
            .route("/session/{session_id}/message", get(messages))
            .route(
                "/session/source/fork",
                post(|| async {
                    Json(serde_json::json!({
                        "id": "forked",
                        "parentID": "source",
                        "directory": "/tmp",
                        "title": "Forked"
                    }))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let http_base = format!(
            "http://{}",
            listener.local_addr().expect("fixture local address")
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve fork fixture");
        });

        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("opencode", false, true, observed_tx).await;
        let session_id = SessionId::new("source");
        let session = connection
            .0
            .ensure_session(session_id)
            .await
            .expect("source session");
        let mut opencode = manifest("opencode", "OpenCode");
        opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
        opencode.resolved.argv = vec!["acp".to_string()];
        let mut manager = AgentManager::from_start_results(
            "opencode".to_string(),
            vec![(opencode, Ok(connection))],
        )
        .await
        .expect("manager");
        manager
            .agents
            .get_mut("opencode")
            .expect("runtime")
            .http_base = Some(http_base);
        let identity = AgentSessionId::new("opencode", "source").unwrap();
        let thread_id = identity.encode();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
            .await
            .expect("source index");
        for (id, text) in [("user-1", "first"), ("user-2", "second")] {
            session
                .emit(CanonicalEvent::MessageChunk {
                    agent_id: "opencode".to_string(),
                    thread_id: thread_id.clone(),
                    run_id: None,
                    source_turn_id: None,
                    generation: None,
                    role: MessageRole::User,
                    message_id: id.to_string(),
                    content: text.to_string(),
                    content_block: None,
                })
                .await;
        }

        assert!(matches!(
            manager.fork_session(&thread_id, "user-2").await,
            Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
                "session/resume or session/load"
            )))
        ));
        assert_eq!(manager.session_index.lock().await.entries.len(), 1);
        assert!(manager
            .agents
            .get("opencode")
            .and_then(|runtime| runtime.connection.as_ref())
            .expect("connection")
            .session(&SessionId::new("forked"))
            .await
            .is_none());

        server.abort();
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_deletes_opencode_sessions_through_its_loopback_api() {
        let (acp_observed_tx, mut acp_observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("opencode", false, true, acp_observed_tx).await;
        for session_id in ["opencode-listed", "opencode-child", "opencode-grandchild"] {
            connection
                .0
                .ensure_session(SessionId::new(session_id))
                .await
                .expect("load OpenCode session");
        }
        let mut opencode = manifest("opencode", "OpenCode");
        opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
        opencode.resolved.argv = vec!["acp".to_string()];
        let mut manager = AgentManager::from_start_results(
            "opencode".to_string(),
            vec![(opencode, Ok(connection))],
        )
        .await
        .unwrap();
        let (http_base, mut http_observed, server) =
            opencode_delete_server(AxumStatusCode::OK, true).await;
        manager
            .agents
            .get_mut("opencode")
            .expect("OpenCode runtime")
            .http_base = Some(http_base);
        let identity = AgentSessionId::new("opencode", "opencode-listed").unwrap();
        let child_identity = AgentSessionId::new("opencode", "opencode-child").unwrap();
        let grandchild_identity = AgentSessionId::new("opencode", "opencode-grandchild").unwrap();
        let mut child_entry = index_entry(child_identity.clone(), PathBuf::from("/tmp"));
        child_entry.parent_acp_session_id = Some(identity.acp_session_id.clone());
        let mut grandchild_entry = index_entry(grandchild_identity.clone(), PathBuf::from("/tmp"));
        grandchild_entry.parent_acp_session_id = Some(child_identity.acp_session_id.clone());
        manager
            .session_index
            .lock()
            .await
            .insert_all([
                index_entry(identity.clone(), PathBuf::from("/tmp")),
                child_entry,
            ])
            .await
            .unwrap();
        let thread_id = identity.encode();

        assert!(manager
            .list_agents()
            .into_iter()
            .find(|agent| agent.agent_id == "opencode")
            .and_then(|agent| agent.capabilities)
            .is_some_and(|capabilities| capabilities.session_delete));

        manager
            .session_index
            .lock()
            .await
            .insert_all([grandchild_entry])
            .await
            .unwrap();
        let expected_family = vec![
            identity.encode(),
            child_identity.encode(),
            grandchild_identity.encode(),
        ];
        let deletion = manager
            .prepare_session_deletion(&thread_id)
            .await
            .expect("lock the authoritative family before ACP deletion");
        assert_eq!(deletion.affected_thread_ids(), expected_family);
        assert!(http_observed.try_recv().is_err());
        assert!(acp_observed_rx.try_recv().is_err());
        assert_eq!(deletion.execute().await.unwrap(), expected_family);

        assert_eq!(
            http_observed.recv().await,
            Some(("opencode-listed".to_string(), Some("/tmp".to_string())))
        );
        assert_eq!(
            acp_observed_rx.recv().await.as_deref(),
            Some("close:opencode:opencode-listed")
        );
        assert_eq!(
            acp_observed_rx.recv().await.as_deref(),
            Some("close:opencode:opencode-child")
        );
        assert_eq!(
            acp_observed_rx.recv().await.as_deref(),
            Some("close:opencode:opencode-grandchild")
        );
        assert!(acp_observed_rx.try_recv().is_err());
        assert!(manager.session_index.lock().await.entries.is_empty());
        assert!(manager.loaded_session_ids().await.is_empty());
        manager.shutdown().await;
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn runtime_delete_uses_global_barrier_and_authoritative_dynamic_family() {
        let directory = std::env::current_dir()
            .expect("current directory")
            .join("target")
            .join(format!(
                "runtime-authoritative-delete-{}",
                uuid::Uuid::new_v4()
            ));
        std::fs::create_dir_all(&directory).expect("create runtime deletion test directory");
        let (acp_observed_tx, mut acp_observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("opencode", false, true, acp_observed_tx).await;
        for session_id in ["parent", "child", "grandchild"] {
            connection
                .0
                .ensure_session(SessionId::new(session_id))
                .await
                .expect("load OpenCode family session");
        }
        let mut opencode = manifest("opencode", "OpenCode");
        opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
        opencode.resolved.argv = vec!["acp".to_string()];
        let mut manager = AgentManager::from_start_results_with_index(
            "opencode".to_string(),
            vec![(opencode, Ok(connection))],
            None,
            directory.clone(),
            true,
        )
        .await
        .expect("manager");
        let (http_base, mut http_observed, server) =
            opencode_delete_server(AxumStatusCode::OK, true).await;
        manager
            .agents
            .get_mut("opencode")
            .expect("OpenCode runtime")
            .http_base = Some(http_base);

        let parent = AgentSessionId::new("opencode", "parent").unwrap();
        let child = AgentSessionId::new("opencode", "child").unwrap();
        let grandchild = AgentSessionId::new("opencode", "grandchild").unwrap();
        let mut child_entry = index_entry(child.clone(), directory.clone());
        child_entry.parent_acp_session_id = Some(parent.acp_session_id.clone());
        let mut grandchild_entry = index_entry(grandchild.clone(), directory.clone());
        grandchild_entry.parent_acp_session_id = Some(child.acp_session_id.clone());
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(parent.clone(), directory.clone()), child_entry])
            .await
            .expect("index initial family");
        let manager = Arc::new(manager);
        let hub = Arc::new(crate::client_hub::ClientHub::new());
        let retirement_journal = Arc::new(
            crate::retirement_journal::ThreadRetirementJournal::load(
                directory.join("thread-retirements.json"),
            )
            .await
            .expect("load retirement journal"),
        );
        let backend = crate::runtime_backend::RuntimeBackend::from_manager_for_test(
            manager.clone(),
            hub.clone(),
            retirement_journal.clone(),
        )
        .await;
        let queue = crate::bridge_protocol::BridgeQueueService::new(backend.clone(), hub.clone());
        let scheduler = crate::scheduled_prompts::ScheduledPromptService::start_paused(
            directory.join("scheduled-prompts.json"),
            Arc::downgrade(&queue),
            hub,
        )
        .await
        .expect("start paused scheduler");
        backend
            .attach_thread_lifecycle(Arc::downgrade(&queue), Arc::downgrade(&scheduler))
            .await
            .expect("attach production deletion services");

        let parent_thread_id = parent.encode();
        let child_thread_id = child.encode();
        let grandchild_thread_id = grandchild.encode();
        queue.threads.write().await.insert(
            parent_thread_id.clone(),
            crate::bridge_protocol::BridgeThreadQueueRuntime {
                items: std::collections::VecDeque::from([
                    crate::bridge_protocol::BridgeQueuedMessageEntry {
                        id: "concurrent-dispatch".to_string(),
                        submission_id: "concurrent-dispatch".to_string(),
                        created_at: "now".to_string(),
                        content: "dispatch before deletion".to_string(),
                        turn_start: serde_json::json!({
                            "input": [{
                                "type": "text",
                                "text": "dispatch before deletion",
                                "text_elements": []
                            }]
                        }),
                        agent_message: None,
                    },
                ]),
                ..crate::bridge_protocol::BridgeThreadQueueRuntime::default()
            },
        );
        let manager_operation = manager
            .session_operation_lock(&parent_thread_id)
            .await
            .lock_owned()
            .await;
        let dispatch = tokio::spawn({
            let queue = queue.clone();
            let parent_thread_id = parent_thread_id.clone();
            async move { queue.drain_thread_queue(parent_thread_id).await }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if queue
                    .threads
                    .read()
                    .await
                    .get(&parent_thread_id)
                    .is_some_and(|runtime| runtime.turn_start_in_flight)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("queue dispatch reaches the manager operation");

        let scheduler_operation = scheduler
            .begin_thread_retirement(&[AgentSessionId::new("opencode", "unrelated")
                .unwrap()
                .encode()])
            .await
            .expect("hold scheduler operation");
        let schedule_admitted = Arc::new(tokio::sync::Notify::new());
        *queue
            .retirement_fence
            .admission_acquired
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(schedule_admitted.clone());
        let scheduling = tokio::spawn({
            let scheduler = scheduler.clone();
            let child_thread_id = child_thread_id.clone();
            async move {
                scheduler
                    .schedule(
                        &child_thread_id,
                        "schedule before deletion".to_string(),
                        &(chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
                    )
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(1), schedule_admitted.notified())
            .await
            .expect("concurrent schedule acquires admission before scheduler operation");

        let barrier_attempted = Arc::new(tokio::sync::Notify::new());
        *queue
            .retirement_fence
            .begin_attempted
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(barrier_attempted.clone());
        let deletion = tokio::spawn({
            let backend = backend.clone();
            let parent_thread_id = parent_thread_id.clone();
            async move {
                backend
                    .request_internal(
                        "thread/delete",
                        Some(serde_json::json!({"threadId": parent_thread_id})),
                    )
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(1), barrier_attempted.notified())
            .await
            .expect("runtime deletion queues the global admission barrier");
        assert!(!deletion.is_finished());
        manager
            .session_index
            .lock()
            .await
            .insert_all([grandchild_entry])
            .await
            .expect("admitted work indexes a dynamic descendant before planning");

        scheduler
            .rollback_thread_retirement(scheduler_operation)
            .await;
        scheduling
            .await
            .expect("schedule task")
            .expect("admitted schedule completes");
        drop(manager_operation);
        tokio::time::timeout(Duration::from_secs(1), dispatch)
            .await
            .expect("admitted dispatch drains before deletion planning")
            .expect("dispatch task");
        let result = tokio::time::timeout(Duration::from_secs(1), deletion)
            .await
            .expect("global-barrier deletion completes")
            .expect("deletion task")
            .expect("runtime deletion succeeds");
        assert_eq!(
            result,
            serde_json::json!({"ok": true, "threadId": parent_thread_id})
        );

        assert_eq!(
            http_observed.recv().await,
            Some((
                "parent".to_string(),
                Some(directory.to_string_lossy().into_owned())
            ))
        );
        let mut closed = Vec::new();
        for _ in 0..3 {
            closed.push(acp_observed_rx.recv().await.expect("closed family session"));
        }
        closed.sort();
        assert_eq!(
            closed,
            vec![
                "close:opencode:child".to_string(),
                "close:opencode:grandchild".to_string(),
                "close:opencode:parent".to_string(),
            ]
        );
        assert!(manager.session_index.lock().await.entries.is_empty());
        assert!(retirement_journal.entries().await.is_empty());
        for deleted_thread_id in [&parent_thread_id, &child_thread_id, &grandchild_thread_id] {
            assert!(scheduler.list(deleted_thread_id).await.is_empty());
            assert!(!queue.threads.read().await.contains_key(deleted_thread_id));
            assert_eq!(
                queue
                    .retirement_fence
                    .admit(deleted_thread_id)
                    .await
                    .unwrap_err(),
                "thread is being deleted"
            );
        }

        scheduler.shutdown().await;
        backend.shutdown().await;
        server.abort();
        let _ = server.await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn manager_keeps_opencode_session_when_loopback_claims_success_without_deleting() {
        let (acp_observed_tx, _acp_observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("opencode", false, true, acp_observed_tx).await;
        let mut opencode = manifest("opencode", "OpenCode");
        opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
        opencode.resolved.argv = vec!["acp".to_string()];
        let mut manager = AgentManager::from_start_results(
            "opencode".to_string(),
            vec![(opencode, Ok(connection))],
        )
        .await
        .unwrap();
        let (http_base, _http_observed, server) =
            opencode_delete_server(AxumStatusCode::OK, false).await;
        manager
            .agents
            .get_mut("opencode")
            .expect("OpenCode runtime")
            .http_base = Some(http_base);
        let identity = AgentSessionId::new("opencode", "opencode-listed").unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
            .await
            .unwrap();

        assert!(matches!(
            manager.delete_session(&identity.encode()).await,
            Err(AgentManagerError::Harness(_))
        ));
        assert_eq!(manager.session_index.lock().await.entries.len(), 1);
        manager.shutdown().await;
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn manager_opencode_steer_returns_after_handoff_admission() {
        let (acp_observed_tx, _acp_observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("opencode", false, true, acp_observed_tx).await;
        let session_id = SessionId::new("opencode-listed");
        connection
            .0
            .ensure_session(session_id.clone())
            .await
            .expect("load OpenCode session");
        let session = connection
            .0
            .session(&session_id)
            .await
            .expect("loaded OpenCode session");
        let (generation, _) = session
            .admit_prompt("run".to_string(), "turn".to_string())
            .await
            .expect("admit source prompt");
        let abort_calls = Arc::new(AtomicUsize::new(0));
        let abort_calls_for_route = abort_calls.clone();
        let status_idle = Arc::new(AtomicBool::new(false));
        let status_idle_for_route = status_idle.clone();
        let app = Router::new()
            .route(
                "/session/opencode-listed/abort",
                post(move || {
                    let abort_calls = abort_calls_for_route.clone();
                    async move {
                        if abort_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                            AxumStatusCode::OK
                        } else {
                            AxumStatusCode::INTERNAL_SERVER_ERROR
                        }
                    }
                }),
            )
            .route(
                "/session/opencode-listed/prompt_async",
                post(|| async { AxumStatusCode::NO_CONTENT }),
            )
            .route(
                "/session/status",
                get(move || {
                    let status_idle = status_idle_for_route.clone();
                    async move {
                        if status_idle.load(Ordering::SeqCst) {
                            Json(serde_json::json!({}))
                        } else {
                            Json(serde_json::json!({
                                "opencode-listed": {"type": "busy"}
                            }))
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let http_base = format!(
            "http://{}",
            listener.local_addr().expect("fixture local address")
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve OpenCode steer fixture");
        });

        let mut opencode = manifest("opencode", "OpenCode");
        opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
        opencode.resolved.argv = vec!["acp".to_string()];
        let mut manager = AgentManager::from_start_results(
            "opencode".to_string(),
            vec![(opencode, Ok(connection))],
        )
        .await
        .unwrap();
        manager
            .agents
            .get_mut("opencode")
            .expect("OpenCode runtime")
            .http_base = Some(http_base);
        let identity = AgentSessionId::new("opencode", "opencode-listed").unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
            .await
            .unwrap();
        let epoch = manager
            .prepare_steer(&identity.encode())
            .await
            .expect("prepare steer");
        let prompt = vec![serde_json::from_value(serde_json::json!({
            "type": "text",
            "text": "replacement"
        }))
        .expect("text content block")];

        tokio::time::timeout(
            Duration::from_millis(250),
            manager.steer(
                &identity.encode(),
                "run".to_string(),
                "turn".to_string(),
                generation,
                epoch,
                prompt,
            ),
        )
        .await
        .expect("steer returns after prompt admission")
        .expect("steer succeeds");
        assert_eq!(
            session.snapshot().await.active_generation,
            Some(generation + 1)
        );
        assert!(session.snapshot().await.messages.iter().any(|message| {
            message.role == MessageRole::User
                && message.parts.iter().any(|part| {
                    part.get("text").and_then(serde_json::Value::as_str) == Some("replacement")
                })
        }));
        let failed_epoch = manager
            .prepare_steer(&identity.encode())
            .await
            .expect("prepare failed steer");
        assert!(matches!(
            manager
                .steer(
                    &identity.encode(),
                    "run".to_string(),
                    "turn".to_string(),
                    generation + 1,
                    failed_epoch,
                    vec![serde_json::from_value(serde_json::json!({
                        "type": "text",
                        "text": "rejected replacement"
                    }))
                    .expect("text content block")],
                )
                .await,
            Err(AgentManagerError::Harness(HarnessError::Http(
                reqwest::StatusCode::INTERNAL_SERVER_ERROR
            )))
        ));
        assert_eq!(
            session.operation().await,
            Some(("run".to_string(), "turn".to_string(), generation + 1))
        );
        status_idle.store(true, Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if session.operation().await.is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("steered generation settles");

        server.abort();
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_delivers_opencode_agent_message_without_aborting_the_active_generation() {
        let (acp_observed_tx, _acp_observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("opencode", false, true, acp_observed_tx).await;
        let session_id = SessionId::new("opencode-listed");
        connection
            .0
            .ensure_session(session_id.clone())
            .await
            .expect("load OpenCode session");
        let session = connection
            .0
            .session(&session_id)
            .await
            .expect("loaded OpenCode session");
        let (generation, _) = session
            .admit_prompt("run".to_string(), "turn".to_string())
            .await
            .expect("admit source prompt");
        session
            .emit(CanonicalEvent::Tool {
                agent_id: "opencode".to_string(),
                thread_id: AgentSessionId::new("opencode", "opencode-listed")
                    .unwrap()
                    .encode(),
                run_id: Some("run".to_string()),
                source_turn_id: Some("turn".to_string()),
                generation: Some(generation),
                tool_call_id: "task-child".to_string(),
                kind: ToolKind::Other,
                status: ToolCallStatus::InProgress,
                title: "task".to_string(),
                content: FieldUpdate::Set(String::new()),
                structured_content: FieldUpdate::Set(Vec::new()),
                locations: FieldUpdate::Set(Vec::new()),
            })
            .await;

        let (http_observed_tx, mut http_observed_rx) = mpsc::unbounded_channel();
        let background_observed = http_observed_tx.clone();
        let prompt_observed = http_observed_tx;
        let app = Router::new()
            .route(
                "/experimental/session/opencode-listed/background",
                post(move || {
                    let observed = background_observed.clone();
                    async move {
                        observed
                            .send(("background".to_string(), serde_json::Value::Null))
                            .expect("observe background request");
                        Json(true)
                    }
                }),
            )
            .route(
                "/session/opencode-listed/prompt_async",
                post(move |Json(body): Json<serde_json::Value>| {
                    let observed = prompt_observed.clone();
                    async move {
                        observed
                            .send(("prompt".to_string(), body))
                            .expect("observe prompt request");
                        AxumStatusCode::NO_CONTENT
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let http_base = format!(
            "http://{}",
            listener.local_addr().expect("fixture local address")
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve OpenCode live-message fixture");
        });

        let mut opencode = manifest("opencode", "OpenCode");
        opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
        opencode.resolved.argv = vec!["acp".to_string()];
        let mut manager = AgentManager::from_start_results(
            "opencode".to_string(),
            vec![(opencode, Ok(connection))],
        )
        .await
        .expect("manager");
        let identity = AgentSessionId::new("opencode", "opencode-listed").unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
            .await
            .expect("source index");
        let prompt = || {
            vec![serde_json::from_value(serde_json::json!({
                "type": "text",
                "text": "child needs guidance"
            }))
            .expect("text content block")]
        };
        assert!(!manager
            .supports_live_agent_message(&identity.encode())
            .expect("missing live-message capability"));
        let unsupported = manager
            .deliver_live_agent_message(
                &identity.encode(),
                "run".to_string(),
                "turn".to_string(),
                generation,
                0,
                prompt(),
            )
            .await
            .expect_err("missing harness is rejected");
        assert!(!unsupported.is_indeterminate());
        assert!(unsupported.to_string().contains("live agent messaging"));

        manager
            .agents
            .get_mut("opencode")
            .expect("OpenCode runtime")
            .http_base = Some(http_base);
        assert!(manager
            .supports_live_agent_message(&identity.encode())
            .expect("live-message capability"));
        let epoch = manager
            .current_steer_epoch(&identity.encode())
            .await
            .expect("read live-message epoch");
        let stale_epoch = manager
            .deliver_live_agent_message(
                &identity.encode(),
                "run".to_string(),
                "turn".to_string(),
                generation,
                epoch + 1,
                prompt(),
            )
            .await
            .expect_err("stale epoch is rejected");
        assert!(!stale_epoch.is_indeterminate());
        assert!(stale_epoch
            .to_string()
            .contains("stale agent-message interaction epoch"));
        let stale_correlation = manager
            .deliver_live_agent_message(
                &identity.encode(),
                "stale-run".to_string(),
                "turn".to_string(),
                generation,
                epoch,
                prompt(),
            )
            .await
            .expect_err("stale correlation is rejected");
        assert!(!stale_correlation.is_indeterminate());
        assert!(stale_correlation
            .to_string()
            .contains("stale agent-message correlation"));
        assert!(http_observed_rx.try_recv().is_err());

        manager
            .deliver_live_agent_message(
                &identity.encode(),
                "run".to_string(),
                "turn".to_string(),
                generation,
                epoch,
                prompt(),
            )
            .await
            .expect("deliver live agent message");

        assert_eq!(
            http_observed_rx.recv().await,
            Some(("background".to_string(), serde_json::Value::Null))
        );
        assert_eq!(
            http_observed_rx.recv().await,
            Some((
                "prompt".to_string(),
                serde_json::json!({
                    "parts": [{"type": "text", "text": "child needs guidance"}]
                })
            ))
        );
        assert!(http_observed_rx.try_recv().is_err());
        assert_eq!(
            session.operation().await,
            Some(("run".to_string(), "turn".to_string(), generation))
        );

        server.abort();
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_delete_is_rejected_and_keeps_the_session_when_the_agent_cannot_delete() {
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("plain-agent", false, false, observed_tx).await;
        let manager = AgentManager::from_start_results(
            "plain-agent".to_string(),
            vec![(manifest("plain-agent", "Plain"), Ok(connection))],
        )
        .await
        .unwrap();
        let identity = AgentSessionId::new("plain-agent", "plain-agent-listed").unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
            .await
            .unwrap();
        let thread_id = identity.encode();

        assert!(matches!(
            manager.delete_session(&thread_id).await,
            Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
                "session/delete"
            )))
        ));

        assert!(observed_rx.try_recv().is_err());
        assert_eq!(manager.session_index.lock().await.entries.len(), 1);
        assert!(manager
            .list_sessions(None, 100)
            .await
            .unwrap()
            .sessions
            .iter()
            .any(|session| session.thread_id == thread_id));
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_delete_rejects_an_unroutable_thread() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let connection = deleting_connection("delete-agent", true, false, observed_tx).await;
        let manager = AgentManager::from_start_results(
            "delete-agent".to_string(),
            vec![(manifest("delete-agent", "Delete"), Ok(connection))],
        )
        .await
        .unwrap();

        assert!(manager.delete_session("not-a-thread-id").await.is_err());
        manager.shutdown().await;
    }

    fn model_config_option(current: &str) -> SessionConfigOption {
        serde_json::from_value(serde_json::json!({
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": current,
            "options": [
                {"value": "default-model", "name": "Default Model"},
                {"value": "chosen-model", "name": "Chosen Model"},
            ],
        }))
        .expect("model config option")
    }

    /// Mirrors agents such as OpenCode, which answer `session/resume` with a freshly defaulted
    /// configuration instead of the session's current one.
    async fn model_resetting_connection(
        agent_id: &str,
        model: Arc<Mutex<String>>,
    ) -> (AcpConnection, NegotiatedInitialize) {
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version).agent_capabilities(
                            AgentCapabilities::new().session_capabilities(
                                SessionCapabilities::new().resume(SessionResumeCapabilities::new()),
                            ),
                        ),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let model = model.clone();
                    async move |_: NewSessionRequest, responder, _| {
                        let current = model.lock().await.clone();
                        responder.respond(
                            NewSessionResponse::new("model-session")
                                .config_options(vec![model_config_option(&current)]),
                        )
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let model = model.clone();
                    async move |request: SetSessionConfigOptionRequest, responder, _| {
                        let SessionConfigOptionValue::ValueId { value } = request.value else {
                            return responder
                                .respond_with_error(agent_client_protocol::Error::internal_error());
                        };
                        let value = value.to_string();
                        *model.lock().await = value.clone();
                        responder.respond(SetSessionConfigOptionResponse::new(vec![
                            model_config_option(&value),
                        ]))
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let model = model.clone();
                    async move |_: ResumeSessionRequest, responder, _| {
                        *model.lock().await = "default-model".to_string();
                        responder.respond(
                            ResumeSessionResponse::new()
                                .config_options(vec![model_config_option("default-model")]),
                        )
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("model resetting agent starts")
    }

    #[tokio::test]
    async fn manager_resume_keeps_the_configured_model_when_the_agent_resets_it() {
        let model = Arc::new(Mutex::new("default-model".to_string()));
        let connection = model_resetting_connection("model-agent", model.clone()).await;
        let manager = AgentManager::from_start_results(
            "model-agent".to_string(),
            vec![(manifest("model-agent", "Model"), Ok(connection))],
        )
        .await
        .expect("manager");
        let session = manager
            .new_session("model-agent", NewSessionRequest::new("/tmp"))
            .await
            .expect("session starts");
        let thread_id = session.thread_id.clone();

        let configured = manager
            .set_session_config_option(
                &thread_id,
                "model",
                SessionConfigOptionValue::value_id("chosen-model"),
            )
            .await
            .expect("model applied");
        assert_eq!(
            configured
                .snapshot
                .config
                .iter()
                .find(|entry| entry.id == "model")
                .map(|entry| entry.value.as_str()),
            Some("chosen-model")
        );

        let resumed = manager
            .resume_session_with_policy(&thread_id, "/tmp", ApprovalPolicy::Untrusted)
            .await
            .expect("session resumes");

        assert_eq!(
            resumed
                .snapshot
                .config
                .iter()
                .find(|entry| entry.id == "model")
                .map(|entry| entry.value.as_str()),
            Some("chosen-model"),
            "resume must not discard the configured model"
        );
        assert_eq!(model.lock().await.as_str(), "chosen-model");

        let read = manager
            .read_session(&thread_id)
            .await
            .expect("session read");
        assert_eq!(
            read.snapshot
                .config
                .iter()
                .find(|entry| entry.id == "model")
                .map(|entry| entry.value.as_str()),
            Some("chosen-model")
        );
    }

    #[tokio::test]
    async fn config_update_snapshot_includes_restored_agent_messages() {
        let model = Arc::new(Mutex::new("default-model".to_string()));
        let connection = model_resetting_connection("model-agent", model).await;
        let manager = AgentManager::from_start_results(
            "model-agent".to_string(),
            vec![(manifest("model-agent", "Model"), Ok(connection))],
        )
        .await
        .expect("manager");
        let session = manager
            .new_session("model-agent", NewSessionRequest::new("/tmp"))
            .await
            .expect("session starts");
        manager
            .agent_message_journal
            .lock()
            .await
            .upsert_many(vec![(
                session.thread_id.clone(),
                None,
                sent_agent_message("config-update-message", "child-thread"),
            )])
            .await
            .unwrap();

        let configured = manager
            .set_session_config_option(
                &session.thread_id,
                "model",
                SessionConfigOptionValue::value_id("chosen-model"),
            )
            .await
            .expect("model applied");

        assert!(configured.snapshot.messages.iter().any(|message| {
            message
                .agent_message
                .as_ref()
                .is_some_and(|origin| origin.message_id == "config-update-message")
        }));
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn reconstructed_recipient_prompt_reconciles_interrupted_journal_to_sent() {
        let model = Arc::new(Mutex::new("default-model".to_string()));
        let connection = model_resetting_connection("model-agent", model).await;
        let manager = AgentManager::from_start_results(
            "model-agent".to_string(),
            vec![(manifest("model-agent", "Model"), Ok(connection))],
        )
        .await
        .expect("manager");
        let session = manager
            .new_session("model-agent", NewSessionRequest::new("/tmp"))
            .await
            .expect("session starts");
        let mut received = sent_agent_message("recovered-message", "parent-thread");
        received.direction = crate::agent_messaging::AgentMessageDirection::Received;
        received.relation = AgentRelationKind::Parent;
        received.disposition = crate::agent_messaging::AgentMessageDisposition::Cancelled;
        let mut sent = sent_agent_message("recovered-message", &session.thread_id);
        sent.disposition = crate::agent_messaging::AgentMessageDisposition::Cancelled;
        manager
            .agent_message_journal
            .lock()
            .await
            .upsert_many(vec![
                (session.thread_id.clone(), None, received.clone()),
                ("parent-thread".to_string(), None, sent),
            ])
            .await
            .expect("interrupted activity persists");
        let mut snapshot =
            SessionSnapshot::new("model-agent".to_string(), session.thread_id.clone());
        received.disposition = crate::agent_messaging::AgentMessageDisposition::Queued;
        snapshot.append_agent_message_after(received, None);

        manager.reconcile_received_agent_messages(&snapshot).await;

        let reconciled = manager
            .agent_message_journal
            .lock()
            .await
            .messages_for_id("recovered-message");
        assert_eq!(reconciled.len(), 2);
        assert!(reconciled.iter().all(|(_, message)| {
            message.disposition == crate::agent_messaging::AgentMessageDisposition::Sent
        }));
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_resume_prefers_resume_and_falls_back_to_load() {
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let resume_capabilities = AgentCapabilities::new().session_capabilities(
            SessionCapabilities::new().resume(SessionResumeCapabilities::new()),
        );
        let load_capabilities = AgentCapabilities::new().load_session(true);
        let resume =
            connection_with_capabilities("resume-agent", resume_capabilities, observed_tx.clone())
                .await;
        let load = connection_with_capabilities("load-agent", load_capabilities, observed_tx).await;
        let manager = AgentManager::from_start_results(
            "resume-agent".to_string(),
            vec![
                (manifest("resume-agent", "Resume"), Ok(resume)),
                (manifest("load-agent", "Load"), Ok(load)),
            ],
        )
        .await
        .unwrap();
        let resume_thread = AgentSessionId::new("resume-agent", "resume-session")
            .unwrap()
            .encode();
        manager
            .resume_session_with_policy(&resume_thread, "/tmp", ApprovalPolicy::Never)
            .await
            .unwrap();
        assert_eq!(
            observed_rx.recv().await.as_deref(),
            Some("resume:resume-agent")
        );
        let load_thread = AgentSessionId::new("load-agent", "load-session")
            .unwrap()
            .encode();
        manager
            .resume_session_with_policy(&load_thread, "/tmp", ApprovalPolicy::OnRequest)
            .await
            .unwrap();
        assert_eq!(observed_rx.recv().await.as_deref(), Some("load:load-agent"));
        {
            let index = manager.session_index.lock().await;
            let entries = &index.entries;
            assert_eq!(
                entries
                    .iter()
                    .find(|entry| entry.acp_session_id == "resume-session")
                    .expect("resumed session indexed")
                    .approval_policy,
                ApprovalPolicy::Never
            );
            assert_eq!(
                entries
                    .iter()
                    .find(|entry| entry.acp_session_id == "load-session")
                    .expect("loaded session indexed")
                    .approval_policy,
                ApprovalPolicy::OnRequest
            );
        }
        manager
            .resume_session(&resume_thread, "/tmp")
            .await
            .unwrap();
        assert_eq!(
            observed_rx.recv().await.as_deref(),
            Some("resume:resume-agent")
        );
        assert_eq!(
            manager
                .session_index
                .lock()
                .await
                .entries
                .iter()
                .find(|entry| entry.acp_session_id == "resume-session")
                .expect("resumed session remains indexed")
                .approval_policy,
            ApprovalPolicy::Untrusted
        );
        let listed = manager.list_sessions(None, 100).await.unwrap().sessions;
        assert_eq!(listed.len(), 2);
        assert_eq!(
            listed
                .iter()
                .filter(|session| session.thread_id == resume_thread)
                .count(),
            1
        );
        assert_eq!(
            listed
                .iter()
                .filter(|session| session.thread_id == load_thread)
                .count(),
            1
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_resume_without_restoration_capability_leaves_registry_unchanged() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let connection =
            connection_with_capabilities("plain-agent", AgentCapabilities::new(), observed_tx)
                .await;
        let manager = AgentManager::from_start_results(
            "plain-agent".to_string(),
            vec![(manifest("plain-agent", "Plain"), Ok(connection))],
        )
        .await
        .unwrap();
        let thread_id = AgentSessionId::new("plain-agent", "missing-session")
            .unwrap()
            .encode();
        assert!(matches!(
            manager.resume_session(&thread_id, "/tmp").await,
            Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
                "session/resume or session/load"
            )))
        ));
        assert!(manager.loaded_session_ids().await.is_empty());
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_mailbox_backpressures_and_preserves_terminal_interaction_order() {
        let manager = AgentManager::from_start_results("agent".into(), Vec::new())
            .await
            .expect("manager starts");
        let mut events = manager.take_events().await.expect("manager event receiver");
        for index in 0..1_024 {
            manager
                .events
                .send(CanonicalEvent::Ignored {
                    agent_id: "agent".into(),
                    thread_id: Some("thread".into()),
                    kind: format!("filler-{index}"),
                })
                .await
                .expect("mailbox open");
        }
        let producer = {
            let sender = manager.events.clone();
            tokio::spawn(async move {
                sender
                    .send(CanonicalEvent::PermissionResolved {
                        agent_id: "agent".into(),
                        thread_id: "thread".into(),
                        request_id: "request".into(),
                        outcome: "cancelled".into(),
                    })
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert!(!producer.is_finished());
        for index in 0..1_024 {
            assert!(matches!(
                events.recv().await,
                Some(CanonicalEvent::Ignored { kind, .. }) if kind == format!("filler-{index}")
            ));
        }
        producer
            .await
            .expect("producer task")
            .expect("mailbox open");
        assert!(matches!(
            events.recv().await,
            Some(CanonicalEvent::PermissionResolved { request_id, .. }) if request_id == "request"
        ));
    }

    #[tokio::test]
    async fn manager_state_paths_cover_stopped_pagination_and_invalid_tracking() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let ready = connection("ready-agent", false, "unused", observed_tx).await;
        let manager = AgentManager::from_start_results(
            "ready-agent".into(),
            vec![
                (manifest("ready-agent", "Ready"), Ok(ready)),
                (
                    manifest("offline-agent", "Offline"),
                    Err(AcpRuntimeError::Connection("offline".into())),
                ),
            ],
        )
        .await
        .expect("manager starts");
        assert!(manager.take_events().await.is_some());
        assert!(manager.take_events().await.is_none());

        let page = manager
            .list_sessions(Some(&encode_cursor(1)), 1)
            .await
            .expect("nonzero page");
        assert!(page.sessions.is_empty());
        assert!(page.next_cursor.is_none());
        assert!(manager.pending_permissions().await.is_empty());
        assert!(manager.pending_elicitations().await.is_empty());

        let loaded = manager
            .new_session("ready-agent", NewSessionRequest::new("/tmp"))
            .await
            .unwrap();
        manager.session_index.lock().await.fail_writes = true;
        manager.pending_durable_sessions.lock().await.insert(
            loaded.thread_id.clone(),
            index_entry(
                AgentSessionId::decode(&loaded.thread_id).unwrap(),
                PathBuf::from("/tmp"),
            ),
        );

        let unknown = AgentSessionId::new("unknown-agent", "session").unwrap();
        let _ = manager
            .track_session(unknown.clone(), PathBuf::from("/tmp"))
            .await;
        let _ = manager.track_session(unknown, PathBuf::from("/tmp")).await;
        let _ = manager
            .track_session(
                AgentSessionId::new("ready-agent", "missing").unwrap(),
                PathBuf::from("/tmp"),
            )
            .await;
        manager
            .tracked_sessions
            .lock()
            .await
            .insert("not-a-thread-id".to_string(), Uuid::new_v4());
        manager.flush_events().await;

        manager.shutdown().await;
        let _ = manager.list_agents();
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn session_forwarder_stops_on_upstream_and_downstream_closure() {
        let thread_id = "thread".to_string();
        let instance_id = Uuid::new_v4();
        let tracked = Arc::new(Mutex::new(HashMap::from([(
            thread_id.clone(),
            instance_id,
        )])));
        let (upstream, receiver) = canonical_event_channel(1);
        let (downstream, _events) = canonical_event_channel(1);
        drop(upstream);
        forward_session_events(
            receiver,
            downstream,
            tracked.clone(),
            thread_id.clone(),
            instance_id,
        )
        .await;
        assert!(!tracked.lock().await.contains_key(&thread_id));

        let stale_instance_id = Uuid::new_v4();
        let current_instance_id = Uuid::new_v4();
        tracked
            .lock()
            .await
            .insert(thread_id.clone(), current_instance_id);
        let (upstream, receiver) = canonical_event_channel(1);
        let (downstream, events) = canonical_event_channel(1);
        drop(events);
        upstream
            .send(CanonicalEvent::Ignored {
                agent_id: "agent".into(),
                thread_id: None,
                kind: "closed".into(),
            })
            .await
            .expect("upstream open");
        forward_session_events(
            receiver,
            downstream,
            tracked.clone(),
            thread_id.clone(),
            stale_instance_id,
        )
        .await;
        assert_eq!(
            tracked.lock().await.get(&thread_id),
            Some(&current_instance_id)
        );
    }

    #[tokio::test]
    async fn evicted_session_replacement_forwards_once_and_survives_old_task_cleanup() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let connection = connection("agent", true, "history", observed_tx).await;
        let manager = AgentManager::from_start_results(
            "agent".into(),
            vec![(manifest("agent", "Agent"), Ok(connection))],
        )
        .await
        .expect("manager starts");
        let created = manager
            .new_session("agent", NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let identity = AgentSessionId::decode(&created.thread_id).unwrap();
        let session_id = SessionId::new(identity.acp_session_id.clone());
        let connection = manager.connection("agent").unwrap();
        let old_session = connection.session(&session_id).await.unwrap();
        let old_instance_id = old_session.instance_id();
        let mut events = manager.take_events().await.expect("manager event receiver");

        connection.evict_session(&session_id).await;
        let replacement = connection.ensure_session(session_id).await.unwrap();
        let replacement_instance_id = replacement.instance_id();
        assert_ne!(old_instance_id, replacement_instance_id);
        manager.register_session_events(&identity).await;
        assert_eq!(
            manager
                .tracked_sessions
                .lock()
                .await
                .get(&created.thread_id),
            Some(&replacement_instance_id)
        );

        replacement
            .emit(CanonicalEvent::Ignored {
                agent_id: "agent".into(),
                thread_id: Some(created.thread_id.clone()),
                kind: "replacement".into(),
            })
            .await;
        replacement.flush_events().await;
        assert!(matches!(
            events.recv().await,
            Some(CanonicalEvent::Ignored { kind, .. }) if kind == "replacement"
        ));
        assert!(matches!(
            events.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        drop(old_session);
        tokio::task::yield_now().await;
        assert_eq!(
            manager
                .tracked_sessions
                .lock()
                .await
                .get(&created.thread_id),
            Some(&replacement_instance_id)
        );
    }

    #[tokio::test]
    async fn agent_relations_are_limited_to_direct_index_edges() {
        let (alpha_tx, _alpha_rx) = mpsc::unbounded_channel();
        let (beta_tx, _beta_rx) = mpsc::unbounded_channel();
        let alpha = connection("alpha", false, "unused", alpha_tx).await;
        let beta = connection("beta", false, "unused", beta_tx).await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![
                (manifest("alpha", "Alpha"), Ok(alpha)),
                (manifest("beta", "Beta"), Ok(beta)),
            ],
        )
        .await
        .expect("manager starts");

        let parent = AgentSessionId::new("alpha", "parent").unwrap();
        let child = AgentSessionId::new("alpha", "child").unwrap();
        let sibling = AgentSessionId::new("alpha", "sibling").unwrap();
        let grandchild = AgentSessionId::new("alpha", "grandchild").unwrap();
        let cross_agent = AgentSessionId::new("beta", "other").unwrap();
        let mut parent_entry = index_entry(parent.clone(), PathBuf::from("/tmp"));
        parent_entry.title = Some("Parent".into());
        let mut child_entry = index_entry(child.clone(), PathBuf::from("/tmp"));
        child_entry.title = Some("Worker".into());
        child_entry.parent_acp_session_id = Some(parent.acp_session_id.clone());
        let mut sibling_entry = index_entry(sibling.clone(), PathBuf::from("/tmp"));
        sibling_entry.parent_acp_session_id = Some(parent.acp_session_id.clone());
        let mut grandchild_entry = index_entry(grandchild.clone(), PathBuf::from("/tmp"));
        grandchild_entry.title = Some("Nested worker".into());
        grandchild_entry.parent_acp_session_id = Some(child.acp_session_id.clone());
        manager
            .session_index
            .lock()
            .await
            .insert_all([
                parent_entry,
                child_entry,
                sibling_entry,
                grandchild_entry,
                index_entry(cross_agent.clone(), PathBuf::from("/tmp")),
            ])
            .await
            .expect("index family");
        manager
            .connection("alpha")
            .unwrap()
            .ensure_session(SessionId::new(child.acp_session_id.clone()))
            .await
            .expect("load caller");

        let relations = manager
            .agent_relations(&child.encode())
            .await
            .expect("child relations");
        assert!(
            serde_json::to_value(&relations)
                .expect("relations serialize")
                .get("caller")
                .is_none(),
            "the recipient listing must not expose the caller as a target"
        );
        assert_eq!(
            relations.parent,
            Some(AgentRelationSession {
                thread_id: parent.encode(),
                title: Some("Parent".into()),
                status: AgentRelationStatus::Unloaded,
            })
        );
        assert_eq!(
            relations.children,
            vec![AgentRelationSession {
                thread_id: grandchild.encode(),
                title: Some("Nested worker".into()),
                status: AgentRelationStatus::Unloaded,
            }]
        );
        assert!(!relations.children_truncated);

        assert_eq!(
            manager
                .direct_agent_relation(&child.encode(), &parent.encode())
                .await,
            Ok(AgentRelationKind::Parent)
        );
        assert_eq!(
            manager
                .direct_agent_relation(&child.encode(), &grandchild.encode())
                .await,
            Ok(AgentRelationKind::SubAgent)
        );
        assert_eq!(
            manager
                .direct_agent_relation(&parent.encode(), &grandchild.encode())
                .await,
            Err(AgentRelationError::NotDirect)
        );
        assert_eq!(
            manager
                .direct_agent_relation(&child.encode(), &sibling.encode())
                .await,
            Err(AgentRelationError::NotDirect)
        );
        assert_eq!(
            manager
                .direct_agent_relation(&child.encode(), &cross_agent.encode())
                .await,
            Err(AgentRelationError::CrossAgent)
        );
        assert_eq!(
            manager
                .direct_agent_relation(&child.encode(), &child.encode())
                .await,
            Err(AgentRelationError::SelfTarget)
        );
        assert!(matches!(
            manager
                .direct_agent_relation(
                    &child.encode(),
                    &AgentSessionId::new("alpha", "missing").unwrap().encode(),
                )
                .await,
            Err(AgentRelationError::UnknownTarget(_))
        ));
        assert_eq!(
            manager.agent_relations("invalid").await,
            Err(AgentRelationError::InvalidThreadId)
        );

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn direct_agent_relation_resolution_is_not_limited_by_the_listing_cap() {
        let (alpha_tx, _alpha_rx) = mpsc::unbounded_channel();
        let alpha = connection("alpha", false, "unused", alpha_tx).await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(alpha))],
        )
        .await
        .expect("manager starts");

        let parent = AgentSessionId::new("alpha", "parent").unwrap();
        let mut parent_entry = index_entry(parent.clone(), PathBuf::from("/tmp"));
        parent_entry.title = Some("Parent".into());
        let mut entries = vec![parent_entry];
        let mut children = Vec::new();
        for index in 0..(MAX_AGENT_RELATION_CHILDREN + 2) {
            let child =
                AgentSessionId::new("alpha", format!("child-{index:03}")).expect("child identity");
            let mut entry = index_entry(child.clone(), PathBuf::from("/tmp"));
            entry.title = Some(format!("Worker {index:03}"));
            entry.parent_acp_session_id = Some(parent.acp_session_id.clone());
            entries.push(entry);
            children.push(child);
        }
        manager
            .session_index
            .lock()
            .await
            .insert_all(entries)
            .await
            .expect("index parent and children");
        manager
            .connection("alpha")
            .unwrap()
            .ensure_session(SessionId::new(parent.acp_session_id.clone()))
            .await
            .expect("load parent");

        let listed = manager
            .agent_relations(&parent.encode())
            .await
            .expect("parent relations");
        assert_eq!(listed.children.len(), MAX_AGENT_RELATION_CHILDREN);
        assert!(listed.children_truncated);
        let target = children
            .into_iter()
            .find(|child| {
                listed
                    .children
                    .iter()
                    .all(|relation| relation.thread_id != child.encode())
            })
            .expect("at least one direct child is omitted from the listing");
        manager
            .connection("alpha")
            .unwrap()
            .ensure_session(SessionId::new(target.acp_session_id.clone()))
            .await
            .expect("load omitted target");

        let (relation, caller, recipient) = manager
            .direct_agent_relation_sessions(&parent.encode(), &target.encode())
            .await
            .expect("resolve omitted direct child");
        assert_eq!(relation, AgentRelationKind::SubAgent);
        assert_eq!(caller.thread_id, parent.encode());
        assert_eq!(caller.status, AgentRelationStatus::Idle);
        assert_eq!(recipient.thread_id, target.encode());
        assert_eq!(recipient.status, AgentRelationStatus::Idle);

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn agent_message_journal_is_bounded_deduplicated_and_restart_safe() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-agent-message-journal-{}",
            Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let path = directory.join(AGENT_MESSAGE_JOURNAL_FILE);
        let thread_id = AgentSessionId::new("alpha", "parent").unwrap().encode();
        let related_thread_id = AgentSessionId::new("alpha", "child").unwrap().encode();
        let origin = |message_id: String, disposition| crate::agent_messaging::AgentMessageOrigin {
            message_id,
            direction: crate::agent_messaging::AgentMessageDirection::Sent,
            related_thread_id: related_thread_id.clone(),
            related_title: Some("Worker".to_string()),
            relation: AgentRelationKind::SubAgent,
            disposition,
            body: "Check the queue lifecycle.".to_string(),
        };

        let mut journal = DurableAgentMessageJournal::load(Some(path.clone())).await;
        journal
            .upsert_many(vec![(
                thread_id.clone(),
                Some("tool-before-send".to_string()),
                origin(
                    "message-1".to_string(),
                    crate::agent_messaging::AgentMessageDisposition::Queued,
                ),
            )])
            .await
            .unwrap();
        journal
            .upsert_many(vec![(
                thread_id.clone(),
                Some("later-message".to_string()),
                origin(
                    "message-1".to_string(),
                    crate::agent_messaging::AgentMessageDisposition::Steering,
                ),
            )])
            .await
            .unwrap();
        journal
            .upsert_many(vec![(
                thread_id.clone(),
                None,
                origin(
                    "restart-queued".to_string(),
                    crate::agent_messaging::AgentMessageDisposition::Queued,
                ),
            )])
            .await
            .unwrap();

        let mut journal = DurableAgentMessageJournal::load(Some(path.clone())).await;
        assert_eq!(journal.entries.len(), 2);
        assert_eq!(
            journal.entries[0].message.disposition,
            crate::agent_messaging::AgentMessageDisposition::Cancelled
        );
        assert_eq!(
            journal.entries[1].message.disposition,
            crate::agent_messaging::AgentMessageDisposition::Cancelled
        );
        assert_eq!(
            journal.entries[0].after_timeline_id.as_deref(),
            Some("tool-before-send")
        );
        assert_eq!(
            journal
                .update_disposition(
                    "message-1",
                    crate::agent_messaging::AgentMessageDisposition::Sent,
                )
                .await
                .unwrap(),
            vec![(
                thread_id.clone(),
                origin(
                    "message-1".to_string(),
                    crate::agent_messaging::AgentMessageDisposition::Sent,
                ),
            )]
        );
        assert_eq!(
            DurableAgentMessageJournal::load(Some(path.clone()))
                .await
                .entries[0]
                .message
                .disposition,
            crate::agent_messaging::AgentMessageDisposition::Sent
        );
        assert!(journal
            .update_disposition(
                "message-1",
                crate::agent_messaging::AgentMessageDisposition::Steering,
            )
            .await
            .expect("terminal sent disposition remains monotonic")
            .is_empty());
        assert!(journal
            .update_disposition(
                "restart-queued",
                crate::agent_messaging::AgentMessageDisposition::Queued,
            )
            .await
            .expect("cancelled disposition cannot reactivate queued work")
            .is_empty());
        assert_eq!(
            journal.entries[0].message.disposition,
            crate::agent_messaging::AgentMessageDisposition::Sent
        );
        assert_eq!(
            journal.entries[1].message.disposition,
            crate::agent_messaging::AgentMessageDisposition::Cancelled
        );
        journal
            .remove_message("restart-queued")
            .await
            .expect("provisional message can be removed");
        assert!(journal
            .entries
            .iter()
            .all(|entry| entry.message.message_id != "restart-queued"));
        journal.path = None;
        for index in 0..=MAX_AGENT_MESSAGE_JOURNAL_ENTRIES {
            journal
                .upsert(
                    &thread_id,
                    origin(
                        format!("bounded-{index}"),
                        crate::agent_messaging::AgentMessageDisposition::Sent,
                    ),
                )
                .await
                .unwrap();
        }
        assert_eq!(journal.entries.len(), MAX_AGENT_MESSAGE_JOURNAL_ENTRIES);
        assert!(agent_message_journal_bytes(&journal.entries)
            .is_some_and(|bytes| bytes.len() <= MAX_AGENT_MESSAGE_JOURNAL_BYTES));

        journal.path = Some(path.clone());
        journal
            .remove_threads(std::slice::from_ref(&thread_id))
            .await
            .unwrap();
        assert!(DurableAgentMessageJournal::load(Some(path))
            .await
            .entries
            .is_empty());
        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn retirement_reconciliation_handles_invalid_missing_and_unavailable_agents() {
        let cwd = std::env::current_dir().unwrap();
        let indexed_unknown = AgentSessionId::new("unknown", "indexed").unwrap();
        let absent_unknown = AgentSessionId::new("unknown", "absent").unwrap();
        let manager = AgentManager::from_start_results("none".to_string(), Vec::new())
            .await
            .unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(indexed_unknown.clone(), cwd.clone())])
            .await
            .unwrap();
        assert_eq!(
            manager.reconcile_retirement_plan(&[]).await,
            RetirementPlanReconciliation::Indeterminate
        );
        assert_eq!(
            manager
                .reconcile_retirement_plan(&["not-an-opaque-thread".to_string()])
                .await,
            RetirementPlanReconciliation::Indeterminate
        );
        assert_eq!(
            manager
                .reconcile_retirement_plan(&[indexed_unknown.encode(), absent_unknown.encode(),])
                .await,
            RetirementPlanReconciliation::Indeterminate
        );
        manager
            .finalize_confirmed_deleted_sessions(&[absent_unknown.encode()])
            .await
            .unwrap();
        manager.shutdown().await;

        let unavailable_indexed = AgentSessionId::new("unavailable", "indexed").unwrap();
        let unavailable_absent = AgentSessionId::new("unavailable", "absent").unwrap();
        let (observed, _) = mpsc::unbounded_channel();
        let ready_connection = connection("ready", false, "unused", observed).await;
        let manager = AgentManager::from_start_results(
            "ready".to_string(),
            vec![
                (manifest("ready", "Ready"), Ok(ready_connection)),
                (
                    manifest("unavailable", "Unavailable"),
                    Err(AcpRuntimeError::Connection("offline".to_string())),
                ),
            ],
        )
        .await
        .unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(unavailable_indexed.clone(), cwd.clone())])
            .await
            .unwrap();
        assert_eq!(
            manager
                .reconcile_retirement_plan(&[
                    unavailable_indexed.encode(),
                    unavailable_absent.encode(),
                ])
                .await,
            RetirementPlanReconciliation::Indeterminate
        );
        manager.shutdown().await;

        let (observed, _) = mpsc::unbounded_channel();
        let plain_connection = connection("plain", false, "unused", observed).await;
        let plain_indexed = AgentSessionId::new("plain", "indexed").unwrap();
        let plain_absent = AgentSessionId::new("plain", "absent").unwrap();
        let manager = AgentManager::from_start_results(
            "plain".to_string(),
            vec![(manifest("plain", "Plain"), Ok(plain_connection))],
        )
        .await
        .unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(plain_indexed.clone(), cwd)])
            .await
            .unwrap();
        assert_eq!(
            manager
                .reconcile_retirement_plan(&[plain_indexed.encode(), plain_absent.encode()])
                .await,
            RetirementPlanReconciliation::Indeterminate
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn opencode_retirement_reconciliation_uses_exact_session_statuses() {
        async fn exact_session(AxumPath(session_id): AxumPath<String>) -> impl IntoResponse {
            match session_id.as_str() {
                "live" => Json(serde_json::json!({"id": "live"})).into_response(),
                "absent" => AxumStatusCode::NOT_FOUND.into_response(),
                "wrong" => Json(serde_json::json!({"id": "different"})).into_response(),
                _ => AxumStatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }

        let app = Router::new().route("/session/{session_id}", get(exact_session));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let (observed, _) = mpsc::unbounded_channel();
        let connection = connection("opencode", false, "unused", observed).await;
        let mut opencode = manifest("opencode", "OpenCode");
        opencode.resolved.executable = PathBuf::from("/usr/local/bin/opencode");
        opencode.resolved.argv = vec!["acp".to_string()];
        let mut manager = AgentManager::from_start_results(
            "opencode".to_string(),
            vec![(opencode, Ok(connection))],
        )
        .await
        .unwrap();
        manager.agents.get_mut("opencode").unwrap().http_base = Some(http_base);
        let identities = ["live", "absent", "wrong", "failure"]
            .map(|session_id| AgentSessionId::new("opencode", session_id).unwrap());
        let cwd = std::env::current_dir().unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all(
                identities
                    .iter()
                    .cloned()
                    .map(|identity| index_entry(identity, cwd.clone())),
            )
            .await
            .unwrap();

        assert_eq!(
            manager
                .reconcile_retirement_plan(&[identities[0].encode()])
                .await,
            RetirementPlanReconciliation::Present
        );
        assert_eq!(
            manager
                .reconcile_retirement_plan(&[identities[1].encode()])
                .await,
            RetirementPlanReconciliation::Absent
        );
        for identity in [&identities[2], &identities[3]] {
            assert_eq!(
                manager
                    .reconcile_retirement_plan(&[identity.encode()])
                    .await,
                RetirementPlanReconciliation::Indeterminate
            );
        }
        assert_eq!(
            manager
                .reconcile_retirement_plan(&[identities[0].encode(), identities[1].encode(),])
                .await,
            RetirementPlanReconciliation::Indeterminate
        );
        let unindexed = AgentSessionId::new("opencode", "unindexed").unwrap();
        assert_eq!(
            manager
                .reconcile_retirement_plan(&[unindexed.encode()])
                .await,
            RetirementPlanReconciliation::Absent
        );

        manager.shutdown().await;
        server.abort();
        let _ = server.await;
    }
}
