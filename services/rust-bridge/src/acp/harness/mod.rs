use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{ContentBlock, SessionId};
use futures_util::future::BoxFuture;
use reqwest::{Client, StatusCode};

use super::config::ResolvedAgentManifest;

mod opencode;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HarnessCapabilities {
    pub session_delete: bool,
    pub session_steer: bool,
    pub session_fork: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessLaunchConfig {
    pub extra_args: Vec<String>,
    pub http_base: String,
}

#[derive(Clone)]
pub struct HarnessContext<'a> {
    pub manifest: &'a ResolvedAgentManifest,
    pub http_base: Option<&'a str>,
}

#[derive(Clone)]
pub struct SessionContext {
    pub http: Client,
    pub http_base: String,
    pub session_id: SessionId,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone)]
pub struct HarnessDeleteRequest {
    pub affected_session_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct HarnessSteerRequest {
    pub prompt: Vec<ContentBlock>,
}

#[derive(Debug, Clone)]
pub struct HarnessForkRequest {
    /// Number of complete user turns the fork must keep, as counted in the canonical transcript.
    pub user_message_ordinal: usize,
    pub boundary: HarnessForkBoundary,
}

#[derive(Debug, Clone)]
pub enum HarnessForkBoundary {
    /// The fork must stop before this user request.
    BeforeRequest(HarnessForkBoundaryMessage),
    /// The fork keeps every recorded turn. The carried request is the newest one, so a harness can
    /// confirm the conversation has not grown since the snapshot was read without assuming its own
    /// message count matches the canonical transcript's.
    EndOfHistory(HarnessForkBoundaryMessage),
}

#[derive(Debug, Clone)]
pub struct HarnessForkBoundaryMessage {
    pub first_text: String,
    pub first_text_truncated: bool,
    pub raw_message_id_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessForkedSession {
    pub session_id: String,
    pub parent_session_id: String,
    pub directory: PathBuf,
    pub title: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
    #[error("harness URL is invalid")]
    InvalidUrl,
    #[error("harness request timed out")]
    Timeout,
    #[error("harness request failed: {0}")]
    Request(String),
    #[error("harness returned HTTP {0}")]
    Http(StatusCode),
    #[error("harness response was too large")]
    ResponseTooLarge,
    #[error("harness response was invalid: {0}")]
    InvalidResponse(String),
    #[error("harness prompt contains an unsupported ACP content block")]
    UnsupportedContent,
    #[error("harness operation timed out waiting for the session to become idle")]
    StatusTimeout,
}

#[derive(Debug)]
pub struct HarnessOperationFailure {
    error: HarnessError,
    indeterminate: bool,
}

impl HarnessOperationFailure {
    pub fn definitive(error: HarnessError) -> Self {
        Self {
            error,
            indeterminate: false,
        }
    }

    pub fn indeterminate(error: HarnessError) -> Self {
        Self {
            error,
            indeterminate: true,
        }
    }

    pub fn is_indeterminate(&self) -> bool {
        self.indeterminate
    }

    pub fn into_error(self) -> HarnessError {
        self.error
    }
}

impl std::fmt::Display for HarnessOperationFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(formatter)
    }
}

impl std::error::Error for HarnessOperationFailure {}

pub trait HarnessAdapter: Send + Sync {
    fn capabilities(&self, context: &HarnessContext<'_>) -> HarnessCapabilities;

    fn launch_config(&self) -> Option<HarnessLaunchConfig>;

    fn delete<'a>(
        &'a self,
        context: &'a SessionContext,
        request: HarnessDeleteRequest,
    ) -> BoxFuture<'a, Result<(), HarnessError>>;

    fn steer<'a>(
        &'a self,
        context: &'a SessionContext,
        request: HarnessSteerRequest,
    ) -> BoxFuture<'a, Result<(), HarnessError>>;

    #[cfg(test)]
    fn fork<'a>(
        &'a self,
        context: &'a SessionContext,
        request: HarnessForkRequest,
    ) -> BoxFuture<'a, Result<HarnessForkedSession, HarnessError>>;

    fn fork_with_outcome<'a>(
        &'a self,
        context: &'a SessionContext,
        request: HarnessForkRequest,
    ) -> BoxFuture<'a, Result<HarnessForkedSession, HarnessOperationFailure>>;

    fn wait_until_idle<'a>(
        &'a self,
        context: &'a SessionContext,
    ) -> BoxFuture<'a, Result<(), HarnessError>>;
}

pub fn harness_for_manifest(manifest: &ResolvedAgentManifest) -> Option<Arc<dyn HarnessAdapter>> {
    opencode::resolve(manifest)
}
