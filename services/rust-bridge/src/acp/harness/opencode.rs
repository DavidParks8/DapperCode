#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_client_protocol::v1::schema::ContentBlock;
use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};

use super::{
    HarnessAdapter, HarnessAgentMessageOutcome, HarnessAgentMessageRequest, HarnessCapabilities,
    HarnessContext, HarnessDeleteRequest, HarnessError, HarnessForkBoundary,
    HarnessForkBoundaryMessage, HarnessForkRequest, HarnessForkedSession, HarnessLaunchConfig,
    HarnessOperationFailure, HarnessSteerRequest, SessionContext,
};
use crate::acp::config::ResolvedAgentManifest;

const OPENCODE_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const OPENCODE_STATUS_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const OPENCODE_STATUS_POLL_INTERVAL: Duration = Duration::from_millis(250);
const OPENCODE_IDLE_CONFIRMATION: Duration = Duration::from_secs(1);
const MAX_OPENCODE_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_OPENCODE_SESSION_ID_BYTES: usize = 1_024;
const OPENCODE_BACKGROUND_SUBAGENTS_ENV: &str = "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS";

pub(super) fn resolve(manifest: &ResolvedAgentManifest) -> Option<Arc<dyn HarnessAdapter>> {
    is_verified_opencode_acp(manifest)
        .then(|| Arc::new(OpenCodeHarnessAdapter) as Arc<dyn HarnessAdapter>)
}

fn is_verified_opencode_acp(manifest: &ResolvedAgentManifest) -> bool {
    manifest.agent_id == "opencode"
        && manifest.argv == ["acp"]
        && is_opencode_executable(&manifest.executable)
}

fn is_opencode_executable(executable: &Path) -> bool {
    if matches!(
        executable.file_name().and_then(|name| name.to_str()),
        Some("opencode" | "opencode.exe"),
    ) {
        return true;
    }

    executable
        .ancestors()
        .skip(1)
        .take(4)
        .filter_map(|parent| parent.file_name()?.to_str())
        .any(|name| {
            let name = name.to_ascii_lowercase();
            name == "opencode" || name == "opencode-ai" || name.starts_with("opencode-")
        })
}

struct OpenCodeHarnessAdapter;

fn opencode_fork_with_outcome<'a>(
    context: &'a SessionContext,
    request: HarnessForkRequest,
) -> BoxFuture<'a, Result<HarnessForkedSession, HarnessOperationFailure>> {
    async move {
        let source_session_id = context.session_id.to_string();
        let boundary = resolve_opencode_message_id(context, &request)
            .await
            .map_err(HarnessOperationFailure::definitive)?;
        let mut url = session_action_url(context, &source_session_id, "fork")
            .map_err(HarnessOperationFailure::definitive)?;
        url.query_pairs_mut()
            .append_pair("directory", context.cwd.to_string_lossy().as_ref());
        let response = timed_send(context.http.post(url).json(&OpenCodeForkRequest {
            message_id: boundary.message_id,
        }))
        .await
        .map_err(HarnessOperationFailure::indeterminate)?;
        if !response.status().is_success() {
            return Err(HarnessOperationFailure::indeterminate(HarnessError::Http(
                response.status(),
            )));
        }
        let bytes = bounded_body(response)
            .await
            .map_err(HarnessOperationFailure::indeterminate)?;
        let forked = serde_json::from_slice::<OpenCodeForkResponse>(&bytes)
            .map_err(|error| error.to_string())
            .map_err(HarnessError::InvalidResponse)
            .map_err(HarnessOperationFailure::indeterminate)?;
        validate_fork_response(&forked, &source_session_id, &context.cwd)
            .map_err(HarnessOperationFailure::indeterminate)?;
        let forked_session_id = forked.id.clone();
        let copied_user_messages = opencode_messages(context, &forked_session_id)
            .await
            .map_err(HarnessOperationFailure::indeterminate)?
            .into_iter()
            .filter(|message| message.info.role == "user")
            .count();
        if copied_user_messages != boundary.user_message_ordinal {
            return Err(HarnessOperationFailure::indeterminate(
                HarnessError::InvalidResponse(
                    "fork did not preserve the requested exclusive message boundary".to_string(),
                ),
            ));
        }
        Ok(HarnessForkedSession {
            session_id: forked.id,
            parent_session_id: source_session_id,
            directory: PathBuf::from(forked.directory),
            title: forked.title,
        })
    }
    .boxed()
}

fn allocate_loopback_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()?
        .local_addr()
        .ok()
        .map(|address| address.port())
}

impl HarnessAdapter for OpenCodeHarnessAdapter {
    fn capabilities(&self, context: &HarnessContext<'_>) -> HarnessCapabilities {
        let available = is_verified_opencode_acp(context.manifest) && context.http_base.is_some();
        HarnessCapabilities {
            session_delete: available,
            session_steer: available,
            session_fork: available,
            live_agent_message: available,
        }
    }

    fn launch_config(&self) -> Option<HarnessLaunchConfig> {
        let port = allocate_loopback_port()?;
        Some(HarnessLaunchConfig {
            extra_args: vec!["--port".to_string(), port.to_string()],
            extra_environment: BTreeMap::from([(
                OPENCODE_BACKGROUND_SUBAGENTS_ENV.to_string(),
                "true".to_string(),
            )]),
            http_base: format!("http://127.0.0.1:{port}"),
        })
    }

    fn delete<'a>(
        &'a self,
        context: &'a SessionContext,
        request: HarnessDeleteRequest,
    ) -> BoxFuture<'a, Result<(), HarnessError>> {
        async move {
            let session_id = context.session_id.to_string();
            let mut delete_url = session_url(context, Some(&session_id))?;
            delete_url
                .query_pairs_mut()
                .append_pair("directory", context.cwd.to_string_lossy().as_ref());
            let response = timed_send(context.http.delete(delete_url)).await?;
            if !response.status().is_success() && response.status() != StatusCode::NOT_FOUND {
                return Err(HarnessError::Http(response.status()));
            }

            for affected_session_id in &request.affected_session_ids {
                if opencode_session_exists(context, affected_session_id).await? {
                    return Err(HarnessError::InvalidResponse(
                        "session still exists after deletion".to_string(),
                    ));
                }
            }
            Ok(())
        }
        .boxed()
    }

    fn session_exists<'a>(
        &'a self,
        context: &'a SessionContext,
    ) -> BoxFuture<'a, Result<bool, HarnessError>> {
        async move { opencode_session_exists(context, &context.session_id.to_string()).await }
            .boxed()
    }

    fn steer<'a>(
        &'a self,
        context: &'a SessionContext,
        request: HarnessSteerRequest,
    ) -> BoxFuture<'a, Result<(), HarnessError>> {
        async move {
            let mut abort_url =
                session_action_url(context, &context.session_id.to_string(), "abort")?;
            abort_url
                .query_pairs_mut()
                .append_pair("directory", context.cwd.to_string_lossy().as_ref());
            let response = timed_send(context.http.post(abort_url)).await?;
            if !response.status().is_success() {
                return Err(HarnessError::Http(response.status()));
            }

            let parts = opencode_prompt_parts(&request.prompt)?;
            let mut prompt_url =
                session_action_url(context, &context.session_id.to_string(), "prompt_async")?;
            prompt_url
                .query_pairs_mut()
                .append_pair("directory", context.cwd.to_string_lossy().as_ref());
            let response = timed_send(
                context
                    .http
                    .post(prompt_url)
                    .json(&OpenCodePromptRequest { parts }),
            )
            .await?;
            if response.status() != StatusCode::NO_CONTENT && !response.status().is_success() {
                return Err(HarnessError::Http(response.status()));
            }
            Ok(())
        }
        .boxed()
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    fn deliver_agent_message<'a>(
        &'a self,
        context: &'a SessionContext,
        request: HarnessAgentMessageRequest,
    ) -> BoxFuture<'a, Result<HarnessAgentMessageOutcome, HarnessOperationFailure>> {
        async move {
            let parts = opencode_prompt_parts(&request.prompt)
                .map_err(HarnessOperationFailure::definitive)?;
            if request.promote_blocking_subagents {
                let mut background_url = experimental_session_action_url(context, "background")
                    .map_err(HarnessOperationFailure::definitive)?;
                background_url
                    .query_pairs_mut()
                    .append_pair("directory", context.cwd.to_string_lossy().as_ref());
                let response = timed_send(context.http.post(background_url))
                    .await
                    .map_err(HarnessOperationFailure::definitive)?;
                if response.status() == StatusCode::NOT_FOUND {
                    return Ok(HarnessAgentMessageOutcome::Deferred);
                }
                if !response.status().is_success() {
                    return Err(HarnessOperationFailure::definitive(HarnessError::Http(
                        response.status(),
                    )));
                }
                let promoted = bounded_body(response)
                    .await
                    .map_err(HarnessOperationFailure::definitive)
                    .and_then(|bytes| {
                        serde_json::from_slice::<bool>(&bytes)
                            .map_err(|error| error.to_string())
                            .map_err(HarnessError::InvalidResponse)
                            .map_err(HarnessOperationFailure::definitive)
                    })?;
                if !promoted {
                    return Ok(HarnessAgentMessageOutcome::Deferred);
                }
            }

            let mut prompt_url =
                session_action_url(context, &context.session_id.to_string(), "prompt_async")
                    .map_err(HarnessOperationFailure::definitive)?;
            prompt_url
                .query_pairs_mut()
                .append_pair("directory", context.cwd.to_string_lossy().as_ref());
            let response = timed_agent_message_send(
                context
                    .http
                    .post(prompt_url)
                    .json(&OpenCodePromptRequest { parts }),
            )
            .await?;
            if response.status() != StatusCode::NO_CONTENT && !response.status().is_success() {
                return Err(HarnessOperationFailure::definitive(HarnessError::Http(
                    response.status(),
                )));
            }
            Ok(HarnessAgentMessageOutcome::Delivered)
        }
        .boxed()
    }

    #[cfg(test)]
    fn fork<'a>(
        &'a self,
        context: &'a SessionContext,
        request: HarnessForkRequest,
    ) -> BoxFuture<'a, Result<HarnessForkedSession, HarnessError>> {
        async move {
            opencode_fork_with_outcome(context, request)
                .await
                .map_err(HarnessOperationFailure::into_error)
        }
        .boxed()
    }

    fn fork_with_outcome<'a>(
        &'a self,
        context: &'a SessionContext,
        request: HarnessForkRequest,
    ) -> BoxFuture<'a, Result<HarnessForkedSession, HarnessOperationFailure>> {
        opencode_fork_with_outcome(context, request)
    }

    fn wait_until_idle<'a>(
        &'a self,
        context: &'a SessionContext,
    ) -> BoxFuture<'a, Result<(), HarnessError>> {
        wait_for_opencode_idle(
            context,
            OPENCODE_STATUS_TIMEOUT,
            OPENCODE_STATUS_POLL_INTERVAL,
            OPENCODE_IDLE_CONFIRMATION,
        )
        .boxed()
    }
}

fn validate_fork_response(
    forked: &OpenCodeForkResponse,
    source_session_id: &str,
    cwd: &Path,
) -> Result<(), HarnessError> {
    let invalid_id = forked.id.is_empty()
        || forked.id.len() > MAX_OPENCODE_SESSION_ID_BYTES
        || forked.id == source_session_id;
    let invalid_origin = forked
        .parent_id
        .as_deref()
        .is_some_and(|parent_id| parent_id != source_session_id)
        || Path::new(&forked.directory) != cwd;
    if invalid_id || invalid_origin {
        return Err(HarnessError::InvalidResponse(
            "fork identity, parent, or directory did not match the request".to_string(),
        ));
    }
    Ok(())
}

async fn wait_for_opencode_idle(
    context: &SessionContext,
    timeout: Duration,
    poll_interval: Duration,
    idle_confirmation: Duration,
) -> Result<(), HarnessError> {
    let started = Instant::now();
    let mut idle_since = None;
    loop {
        let mut url = context
            .http_base
            .parse::<Url>()
            .map_err(|_| HarnessError::InvalidUrl)?
            .join("session/status")
            .map_err(|_| HarnessError::InvalidUrl)?;
        url.query_pairs_mut()
            .append_pair("directory", context.cwd.to_string_lossy().as_ref());
        let response = timed_send(context.http.get(url)).await?;
        if !response.status().is_success() {
            return Err(HarnessError::Http(response.status()));
        }
        let bytes = bounded_body(response).await?;
        let statuses = serde_json::from_slice::<HashMap<String, OpenCodeSessionStatus>>(&bytes)
            .map_err(|error| error.to_string())
            .map_err(HarnessError::InvalidResponse)?;
        let is_idle = matches!(
            statuses.get(&context.session_id.to_string()),
            None | Some(OpenCodeSessionStatus {
                status_type: OpenCodeSessionStatusType::Idle,
            }),
        );
        if is_idle {
            let since = idle_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= idle_confirmation {
                return Ok(());
            }
        } else {
            idle_since = None;
        }
        if started.elapsed() >= timeout {
            return Err(HarnessError::StatusTimeout);
        }
        tokio::time::sleep(poll_interval).await;
    }
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
async fn resolve_opencode_message_id(
    context: &SessionContext,
    request: &HarnessForkRequest,
) -> Result<ResolvedOpenCodeForkBoundary, HarnessError> {
    let messages = opencode_messages(context, &context.session_id.to_string()).await?;
    let users = messages
        .iter()
        .filter(|message| message.info.role == "user")
        .collect::<Vec<_>>();
    let boundary = match &request.boundary {
        HarnessForkBoundary::BeforeRequest(boundary) => boundary,
        HarnessForkBoundary::EndOfHistory(newest_request) => {
            // The boundary is the end of the conversation, so OpenCode is asked to copy the whole
            // session. Requiring its newest request to still be the one the snapshot recorded keeps
            // this fail-closed when the session gained a turn, and unlike a count comparison it
            // survives OpenCode splitting one request into several canonical transcript messages.
            let newest = users.last().ok_or_else(|| {
                HarnessError::InvalidResponse("OpenCode history has no request to fork".to_string())
            })?;
            if !opencode_message_matches_boundary(newest, newest_request) {
                return Err(HarnessError::InvalidResponse(
                    "fork boundary is no longer at the end of OpenCode history".to_string(),
                ));
            }
            return Ok(ResolvedOpenCodeForkBoundary {
                message_id: None,
                user_message_ordinal: users.len(),
            });
        }
    };
    let (user_message_ordinal, message) =
        if let Some(raw_message_id_hint) = boundary.raw_message_id_hint.as_deref() {
            users
                .iter()
                .enumerate()
                .find(|(_, message)| message.info.id == raw_message_id_hint)
                .map(|(ordinal, message)| (ordinal, *message))
                .ok_or_else(|| {
                    HarnessError::InvalidResponse(
                        "fork boundary identity is not present in OpenCode history".to_string(),
                    )
                })?
        } else {
            (
                request.user_message_ordinal,
                *users.get(request.user_message_ordinal).ok_or_else(|| {
                    HarnessError::InvalidResponse(
                        "fork boundary is not present in OpenCode history".to_string(),
                    )
                })?,
            )
        };
    if !fork_boundary_text_matches(
        opencode_first_text(message),
        &boundary.first_text,
        boundary.first_text_truncated,
    ) {
        return Err(HarnessError::InvalidResponse(
            "fork boundary does not match OpenCode history".to_string(),
        ));
    }
    Ok(ResolvedOpenCodeForkBoundary {
        message_id: Some(message.info.id.clone()),
        user_message_ordinal,
    })
}

fn opencode_first_text(message: &OpenCodeMessage) -> &str {
    message
        .parts
        .iter()
        .find_map(|part| {
            (part.kind == "text")
                .then_some(part.text.as_deref())
                .flatten()
        })
        .unwrap_or_default()
        .trim()
}

fn opencode_message_matches_boundary(
    message: &OpenCodeMessage,
    boundary: &HarnessForkBoundaryMessage,
) -> bool {
    match boundary.raw_message_id_hint.as_deref() {
        Some(raw_message_id_hint) => message.info.id == raw_message_id_hint,
        None => fork_boundary_text_matches(
            opencode_first_text(message),
            &boundary.first_text,
            boundary.first_text_truncated,
        ),
    }
}

struct ResolvedOpenCodeForkBoundary {
    /// `None` asks OpenCode to copy every message, which is how the end of the conversation is
    /// expressed through an API that otherwise names an excluded message.
    message_id: Option<String>,
    user_message_ordinal: usize,
}

fn fork_boundary_text_matches(actual: &str, expected: &str, expected_truncated: bool) -> bool {
    if expected_truncated {
        actual.starts_with(expected)
    } else {
        actual == expected
    }
}

async fn opencode_messages(
    context: &SessionContext,
    session_id: &str,
) -> Result<Vec<OpenCodeMessage>, HarnessError> {
    let mut url = session_url(context, Some(session_id))?;
    url.path_segments_mut()
        .map_err(|_| HarnessError::InvalidUrl)?
        .push("message");
    url.query_pairs_mut()
        .append_pair("directory", context.cwd.to_string_lossy().as_ref());
    let response = timed_send(context.http.get(url)).await?;
    if !response.status().is_success() {
        return Err(HarnessError::Http(response.status()));
    }
    let bytes = bounded_body(response).await?;
    serde_json::from_slice(&bytes)
        .map_err(|error| error.to_string())
        .map_err(HarnessError::InvalidResponse)
}

async fn opencode_session_exists(
    context: &SessionContext,
    session_id: &str,
) -> Result<bool, HarnessError> {
    let mut url = session_url(context, Some(session_id))?;
    url.query_pairs_mut()
        .append_pair("directory", context.cwd.to_string_lossy().as_ref());
    let response = timed_send(context.http.get(url)).await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(false);
    }
    if !response.status().is_success() {
        return Err(HarnessError::Http(response.status()));
    }
    let bytes = bounded_body(response).await?;
    let session = serde_json::from_slice::<OpenCodeSessionRow>(&bytes)
        .map_err(|error| error.to_string())
        .map_err(HarnessError::InvalidResponse)?;
    if session.id != session_id {
        return Err(HarnessError::InvalidResponse(
            "session lookup returned a different session".to_string(),
        ));
    }
    Ok(true)
}

fn session_url(context: &SessionContext, session_id: Option<&str>) -> Result<Url, HarnessError> {
    let mut url = Url::parse(&context.http_base).map_err(|_| HarnessError::InvalidUrl)?;
    let mut path = url
        .path_segments_mut()
        .map_err(|_| HarnessError::InvalidUrl)?;
    path.pop_if_empty().push("session");
    if let Some(session_id) = session_id {
        path.push(session_id);
    }
    drop(path);
    Ok(url)
}

fn session_action_url(
    context: &SessionContext,
    session_id: &str,
    action: &str,
) -> Result<Url, HarnessError> {
    let mut url = session_url(context, Some(session_id))?;
    url.path_segments_mut()
        .map_err(|_| HarnessError::InvalidUrl)?
        .push(action);
    Ok(url)
}

fn experimental_session_action_url(
    context: &SessionContext,
    action: &str,
) -> Result<Url, HarnessError> {
    let mut url = Url::parse(&context.http_base).map_err(|_| HarnessError::InvalidUrl)?;
    url.path_segments_mut()
        .map_err(|_| HarnessError::InvalidUrl)?
        .pop_if_empty()
        .push("experimental")
        .push("session")
        .push(&context.session_id.to_string())
        .push(action);
    Ok(url)
}

async fn timed_send(builder: reqwest::RequestBuilder) -> Result<reqwest::Response, HarnessError> {
    tokio::time::timeout(OPENCODE_REQUEST_TIMEOUT, builder.send())
        .await
        .map_err(|_| HarnessError::Timeout)?
        .map_err(reqwest::Error::without_url)
        .map_err(|error| error.to_string())
        .map_err(HarnessError::Request)
}

async fn timed_agent_message_send(
    builder: reqwest::RequestBuilder,
) -> Result<reqwest::Response, HarnessOperationFailure> {
    timed_agent_message_send_with_timeout(builder, OPENCODE_REQUEST_TIMEOUT).await
}

async fn timed_agent_message_send_with_timeout(
    builder: reqwest::RequestBuilder,
    timeout: Duration,
) -> Result<reqwest::Response, HarnessOperationFailure> {
    match tokio::time::timeout(timeout, builder.send()).await {
        Err(_) => Err(HarnessOperationFailure::indeterminate(
            HarnessError::Timeout,
        )),
        Ok(Ok(response)) => Ok(response),
        Ok(Err(error)) => {
            let definitive = error.is_builder() || error.is_connect() || error.is_redirect();
            let error = HarnessError::Request(error.without_url().to_string());
            if definitive {
                Err(HarnessOperationFailure::definitive(error))
            } else {
                Err(HarnessOperationFailure::indeterminate(error))
            }
        }
    }
}

async fn bounded_body(response: reqwest::Response) -> Result<Vec<u8>, HarnessError> {
    let bytes = tokio::time::timeout(OPENCODE_REQUEST_TIMEOUT, response.bytes())
        .await
        .map_err(|_| HarnessError::Timeout)?
        .map_err(|error| error.to_string())
        .map_err(HarnessError::Request)?;
    if bytes.len() > MAX_OPENCODE_RESPONSE_BYTES {
        return Err(HarnessError::ResponseTooLarge);
    }
    Ok(bytes.to_vec())
}

fn opencode_prompt_parts(prompt: &[ContentBlock]) -> Result<Vec<OpenCodePromptPart>, HarnessError> {
    prompt
        .iter()
        .map(|block| {
            let value = serde_json::to_value(block)
                .map_err(|error| error.to_string())
                .map_err(HarnessError::InvalidResponse)?;
            match value.get("type").and_then(serde_json::Value::as_str) {
                Some("text") => value
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .map(|text| OpenCodePromptPart::Text {
                        text: text.to_string(),
                    })
                    .ok_or(HarnessError::UnsupportedContent),
                Some("resourceLink") => {
                    let url = value
                        .get("uri")
                        .and_then(serde_json::Value::as_str)
                        .ok_or(HarnessError::UnsupportedContent)?;
                    let filename = value
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string);
                    let mime = value
                        .get("mimeType")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("application/octet-stream")
                        .to_string();
                    Ok(OpenCodePromptPart::File {
                        mime,
                        url: url.to_string(),
                        filename,
                    })
                }
                _ => Err(HarnessError::UnsupportedContent),
            }
        })
        .collect()
}

#[derive(Deserialize)]
struct OpenCodeSessionRow {
    id: String,
}

#[derive(Deserialize)]
struct OpenCodeMessage {
    info: OpenCodeMessageInfo,
    #[serde(default)]
    parts: Vec<OpenCodeMessagePart>,
}

#[derive(Deserialize)]
struct OpenCodeMessageInfo {
    id: String,
    role: String,
}

#[derive(Deserialize)]
struct OpenCodeMessagePart {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

#[derive(Serialize)]
struct OpenCodeForkRequest {
    #[serde(rename = "messageID")]
    #[serde(skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
}

#[derive(Deserialize)]
struct OpenCodeForkResponse {
    id: String,
    #[serde(rename = "parentID")]
    parent_id: Option<String>,
    directory: String,
    title: Option<String>,
}

#[derive(Serialize)]
struct OpenCodePromptRequest {
    parts: Vec<OpenCodePromptPart>,
}

#[derive(Deserialize)]
struct OpenCodeSessionStatus {
    #[serde(rename = "type")]
    status_type: OpenCodeSessionStatusType,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum OpenCodeSessionStatusType {
    Idle,
    Busy,
    Retry,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum OpenCodePromptPart {
    Text {
        text: String,
    },
    File {
        mime: String,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
    },
}

#[cfg(test)]
#[path = "opencode_tests.rs"]
mod tests;
