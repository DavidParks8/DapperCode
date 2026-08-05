use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1::ContentBlock;
use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};

use super::{
    HarnessAdapter, HarnessCapabilities, HarnessContext, HarnessDeleteRequest, HarnessError,
    HarnessForkRequest, HarnessForkedSession, HarnessLaunchConfig, HarnessSteerRequest,
    SessionContext,
};
use crate::acp::config::ResolvedAgentManifest;

const OPENCODE_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const OPENCODE_STATUS_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const OPENCODE_STATUS_POLL_INTERVAL: Duration = Duration::from_millis(250);
const OPENCODE_IDLE_CONFIRMATION: Duration = Duration::from_secs(1);
const MAX_OPENCODE_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_OPENCODE_SESSION_ID_BYTES: usize = 1_024;

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
    if executable
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name, "opencode" | "opencode.exe"))
    {
        return true;
    }

    executable
        .ancestors()
        .skip(1)
        .take(4)
        .filter_map(|parent| parent.file_name().and_then(|name| name.to_str()))
        .any(|name| {
            let name = name.to_ascii_lowercase();
            matches!(name.as_str(), "opencode" | "opencode-ai") || name.starts_with("opencode-")
        })
}

struct OpenCodeHarnessAdapter;

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
        }
    }

    fn launch_config(&self) -> Option<HarnessLaunchConfig> {
        let port = allocate_loopback_port()?;
        Some(HarnessLaunchConfig {
            extra_args: vec!["--port".to_string(), port.to_string()],
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

            let mut list_url = session_url(context, None)?;
            list_url
                .query_pairs_mut()
                .append_pair("directory", context.cwd.to_string_lossy().as_ref())
                .append_pair("limit", "2048");
            let response = timed_send(context.http.get(list_url)).await?;
            if !response.status().is_success() {
                return Err(HarnessError::Http(response.status()));
            }
            let bytes = bounded_body(response).await?;
            let listed = serde_json::from_slice::<Vec<OpenCodeSessionRow>>(&bytes)
                .map_err(|error| HarnessError::InvalidResponse(error.to_string()))?;
            let affected = request
                .affected_session_ids
                .iter()
                .map(String::as_str)
                .collect::<HashSet<_>>();
            if listed
                .iter()
                .any(|session| affected.contains(session.id.as_str()))
            {
                return Err(HarnessError::InvalidResponse(
                    "session is still listed after deletion".to_string(),
                ));
            }
            Ok(())
        }
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

    fn fork<'a>(
        &'a self,
        context: &'a SessionContext,
        request: HarnessForkRequest,
    ) -> BoxFuture<'a, Result<HarnessForkedSession, HarnessError>> {
        async move {
            let source_session_id = context.session_id.to_string();
            let boundary = resolve_opencode_message_id(context, &request).await?;
            let mut url = session_action_url(context, &source_session_id, "fork")?;
            url.query_pairs_mut()
                .append_pair("directory", context.cwd.to_string_lossy().as_ref());
            let response = timed_send(context.http.post(url).json(&OpenCodeForkRequest {
                message_id: Some(boundary.message_id),
            }))
            .await?;
            if !response.status().is_success() {
                return Err(HarnessError::Http(response.status()));
            }
            let bytes = bounded_body(response).await?;
            let forked = serde_json::from_slice::<OpenCodeForkResponse>(&bytes)
                .map_err(|error| HarnessError::InvalidResponse(error.to_string()))?;
            validate_fork_response(&forked, &source_session_id, &context.cwd)?;
            let forked_session_id = forked.id.clone();
            let copied_user_messages = opencode_messages(context, &forked_session_id)
                .await?
                .into_iter()
                .filter(|message| message.info.role == "user")
                .count();
            if copied_user_messages != boundary.user_message_ordinal {
                return Err(HarnessError::InvalidResponse(
                    "fork did not preserve the requested exclusive message boundary".to_string(),
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
    if forked.id.is_empty()
        || forked.id.len() > MAX_OPENCODE_SESSION_ID_BYTES
        || forked.id == source_session_id
        || forked
            .parent_id
            .as_deref()
            .is_some_and(|parent_id| parent_id != source_session_id)
        || Path::new(&forked.directory) != cwd
    {
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
            .map_err(|error| HarnessError::InvalidResponse(error.to_string()))?;
        let is_idle = matches!(
            statuses.get(&context.session_id.to_string()),
            None | Some(OpenCodeSessionStatus {
                status_type: OpenCodeSessionStatusType::Idle,
            })
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

async fn resolve_opencode_message_id(
    context: &SessionContext,
    request: &HarnessForkRequest,
) -> Result<ResolvedOpenCodeForkBoundary, HarnessError> {
    let messages = opencode_messages(context, &context.session_id.to_string()).await?;
    let users = messages
        .iter()
        .filter(|message| message.info.role == "user")
        .collect::<Vec<_>>();
    let (user_message_ordinal, message) =
        if let Some(raw_message_id_hint) = request.raw_message_id_hint.as_deref() {
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
    let first_text = message
        .parts
        .iter()
        .find_map(|part| {
            (part.kind == "text")
                .then_some(part.text.as_deref())
                .flatten()
        })
        .unwrap_or_default()
        .trim();
    if !fork_boundary_text_matches(
        first_text,
        &request.first_text,
        request.first_text_truncated,
    ) {
        return Err(HarnessError::InvalidResponse(
            "fork boundary does not match OpenCode history".to_string(),
        ));
    }
    Ok(ResolvedOpenCodeForkBoundary {
        message_id: message.info.id.clone(),
        user_message_ordinal,
    })
}

struct ResolvedOpenCodeForkBoundary {
    message_id: String,
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
    serde_json::from_slice(&bytes).map_err(|error| HarnessError::InvalidResponse(error.to_string()))
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

async fn timed_send(builder: reqwest::RequestBuilder) -> Result<reqwest::Response, HarnessError> {
    tokio::time::timeout(OPENCODE_REQUEST_TIMEOUT, builder.send())
        .await
        .map_err(|_| HarnessError::Timeout)?
        .map_err(|error| HarnessError::Request(error.without_url().to_string()))
}

async fn bounded_body(response: reqwest::Response) -> Result<Vec<u8>, HarnessError> {
    let bytes = tokio::time::timeout(OPENCODE_REQUEST_TIMEOUT, response.bytes())
        .await
        .map_err(|_| HarnessError::Timeout)?
        .map_err(|error| HarnessError::Request(error.to_string()))?;
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
                .map_err(|error| HarnessError::InvalidResponse(error.to_string()))?;
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
mod tests {
    use super::*;
    use crate::acp::config::RuntimeIntegrity;
    use agent_client_protocol::schema::v1::SessionId;
    use axum::extract::{Path as AxumPath, State};
    use axum::routing::{delete, get, post};
    use axum::{Json, Router};
    use reqwest::Client;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::mpsc;

    async fn fixture_context(
        app: Router,
        session_id: &str,
    ) -> (SessionContext, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });
        (
            SessionContext {
                http: Client::new(),
                http_base: format!("http://{address}/"),
                session_id: SessionId::new(session_id),
                cwd: std::env::current_dir().expect("current directory"),
            },
            server,
        )
    }

    fn manifest(executable: &str, agent_id: &str, argv: &[&str]) -> ResolvedAgentManifest {
        ResolvedAgentManifest {
            agent_id: agent_id.to_string(),
            executable: PathBuf::from(executable),
            argv: argv.iter().map(|value| (*value).to_string()).collect(),
            environment: BTreeMap::new(),
            resolved_version: "1".to_string(),
            provenance: "test".to_string(),
            verified_digest: format!("sha256:{}", "0".repeat(64)),
            integrity: RuntimeIntegrity::Executable,
        }
    }

    #[test]
    fn only_the_exact_opencode_invocation_selects_the_harness() {
        assert!(is_verified_opencode_acp(&manifest(
            "/usr/local/bin/opencode",
            "opencode",
            &["acp"]
        )));
        assert!(is_verified_opencode_acp(&manifest(
            "opencode.exe",
            "opencode",
            &["acp"]
        )));
        assert!(is_verified_opencode_acp(&manifest(
            "/opt/homebrew/lib/node_modules/opencode-ai/dist/cli.js",
            "opencode",
            &["acp"]
        )));
        assert!(!is_verified_opencode_acp(&manifest(
            "/usr/local/bin/other",
            "opencode",
            &["acp"]
        )));
        assert!(!is_verified_opencode_acp(&manifest(
            "/opt/homebrew/lib/node_modules/unrelated/dist/cli.js",
            "opencode",
            &["acp"]
        )));
        assert!(!is_verified_opencode_acp(&manifest(
            "/usr/local/bin/opencode",
            "spoofed",
            &["acp"]
        )));
        assert!(!is_verified_opencode_acp(&manifest(
            "/usr/local/bin/opencode",
            "opencode",
            &[]
        )));
        assert!(fork_boundary_text_matches(
            "second request with a long tail",
            "second request",
            true
        ));
        assert!(!fork_boundary_text_matches(
            "second request with a long tail",
            "second request",
            false
        ));

        let verified = manifest("/usr/local/bin/opencode", "opencode", &["acp"]);
        assert_eq!(
            OpenCodeHarnessAdapter.capabilities(&HarnessContext {
                manifest: &verified,
                http_base: None,
            }),
            HarnessCapabilities::default()
        );
        let spoofed = manifest("/usr/local/bin/other", "opencode", &["acp"]);
        assert_eq!(
            OpenCodeHarnessAdapter.capabilities(&HarnessContext {
                manifest: &spoofed,
                http_base: Some("http://127.0.0.1"),
            }),
            HarnessCapabilities::default()
        );
        let launch = OpenCodeHarnessAdapter
            .launch_config()
            .expect("loopback launch configuration");
        assert_eq!(launch.extra_args[0], "--port");
        assert!(launch.http_base.starts_with("http://127.0.0.1:"));
    }

    #[test]
    fn fork_response_validation_rejects_each_mismatched_field() {
        let cwd = std::env::current_dir().expect("current directory");
        let valid = || OpenCodeForkResponse {
            id: "forked".to_string(),
            parent_id: Some("source".to_string()),
            directory: cwd.to_string_lossy().to_string(),
            title: None,
        };
        assert!(validate_fork_response(&valid(), "source", &cwd).is_ok());

        let mut forked = valid();
        forked.id.clear();
        assert!(matches!(
            validate_fork_response(&forked, "source", &cwd),
            Err(HarnessError::InvalidResponse(_))
        ));
        let mut forked = valid();
        forked.id = "x".repeat(MAX_OPENCODE_SESSION_ID_BYTES + 1);
        assert!(validate_fork_response(&forked, "source", &cwd).is_err());
        let mut forked = valid();
        forked.id = "source".to_string();
        assert!(validate_fork_response(&forked, "source", &cwd).is_err());
        let mut forked = valid();
        forked.parent_id = Some("other".to_string());
        assert!(validate_fork_response(&forked, "source", &cwd).is_err());
        let mut forked = valid();
        forked.directory = cwd.join("other").to_string_lossy().to_string();
        assert!(validate_fork_response(&forked, "source", &cwd).is_err());
    }

    #[tokio::test]
    async fn opencode_delete_handles_not_found_and_surfaces_http_and_verification_failures() {
        let adapter = OpenCodeHarnessAdapter;
        let request = || HarnessDeleteRequest {
            affected_session_ids: vec!["source".to_string()],
        };

        let app = Router::new()
            .route(
                "/session/source",
                delete(|| async { StatusCode::NOT_FOUND }),
            )
            .route("/session", get(|| async { Json(serde_json::json!([])) }));
        let (context, server) = fixture_context(app, "source").await;
        adapter
            .delete(&context, request())
            .await
            .expect("not found is already deleted");
        server.abort();

        let app = Router::new().route(
            "/session/source",
            delete(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
        );
        let (context, server) = fixture_context(app, "source").await;
        assert!(matches!(
            adapter.delete(&context, request()).await,
            Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
        ));
        server.abort();

        let app = Router::new()
            .route("/session/source", delete(|| async { StatusCode::OK }))
            .route(
                "/session",
                get(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
            );
        let (context, server) = fixture_context(app, "source").await;
        assert!(matches!(
            adapter.delete(&context, request()).await,
            Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
        ));
        server.abort();

        let app = Router::new()
            .route("/session/source", delete(|| async { StatusCode::OK }))
            .route(
                "/session",
                get(|| async { Json(serde_json::json!([{"id": "source"}])) }),
            );
        let (context, server) = fixture_context(app, "source").await;
        assert!(matches!(
            adapter.delete(&context, request()).await,
            Err(HarnessError::InvalidResponse(_))
        ));
        server.abort();
    }

    #[tokio::test]
    async fn opencode_steer_surfaces_abort_prompt_and_content_failures() {
        let adapter = OpenCodeHarnessAdapter;
        let text = || {
            serde_json::from_value(serde_json::json!({"type": "text", "text": "replacement"}))
                .expect("text content")
        };

        let app = Router::new().route(
            "/session/source/abort",
            post(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
        );
        let (context, server) = fixture_context(app, "source").await;
        assert!(matches!(
            adapter
                .steer(
                    &context,
                    HarnessSteerRequest {
                        prompt: vec![text()],
                    },
                )
                .await,
            Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
        ));
        server.abort();

        let app = Router::new()
            .route("/session/source/abort", post(|| async { StatusCode::OK }))
            .route(
                "/session/source/prompt_async",
                post(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
            );
        let (context, server) = fixture_context(app, "source").await;
        assert!(matches!(
            adapter
                .steer(
                    &context,
                    HarnessSteerRequest {
                        prompt: vec![text()],
                    },
                )
                .await,
            Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
        ));
        server.abort();

        let app = Router::new()
            .route("/session/source/abort", post(|| async { StatusCode::OK }))
            .route(
                "/session/source/prompt_async",
                post(|| async { StatusCode::OK }),
            );
        let (context, server) = fixture_context(app, "source").await;
        adapter
            .steer(
                &context,
                HarnessSteerRequest {
                    prompt: vec![text()],
                },
            )
            .await
            .expect("successful non-204 prompt response");
        server.abort();

        let image: ContentBlock = serde_json::from_value(serde_json::json!({
            "type": "image",
            "data": "aW1hZ2U=",
            "mimeType": "image/png"
        }))
        .expect("image content");
        assert!(matches!(
            opencode_prompt_parts(&[image]),
            Err(HarnessError::UnsupportedContent)
        ));
    }

    #[derive(Clone)]
    struct ForkServerState {
        directory: String,
        observed: mpsc::UnboundedSender<String>,
    }

    async fn opencode_messages_fixture(
        AxumPath(session_id): AxumPath<String>,
    ) -> Json<serde_json::Value> {
        let users = if session_id == "source" {
            serde_json::json!([
                {"info": {"id": "raw-user-1", "role": "user"}, "parts": [{"type": "text", "text": "first"}]},
                {"info": {"id": "raw-user-2", "role": "user"}, "parts": [{"type": "text", "text": "second"}]}
            ])
        } else {
            serde_json::json!([
                {"info": {"id": "raw-user-1", "role": "user"}, "parts": [{"type": "text", "text": "first"}]}
            ])
        };
        Json(users)
    }

    async fn opencode_mismatched_messages_fixture(
        AxumPath(session_id): AxumPath<String>,
    ) -> Json<serde_json::Value> {
        if session_id == "source" {
            opencode_messages_fixture(AxumPath(session_id)).await
        } else {
            Json(serde_json::json!([]))
        }
    }

    async fn opencode_fork_fixture(
        State(state): State<ForkServerState>,
        Json(body): Json<serde_json::Value>,
    ) -> Json<serde_json::Value> {
        let _ = state.observed.send(
            body.get("messageID")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
        );
        Json(serde_json::json!({
            "id": "forked",
            "directory": state.directory,
            "title": "Forked"
        }))
    }

    #[tokio::test]
    async fn opencode_fork_resolves_exact_identity_despite_snapshot_ordinal_drift() {
        let directory = std::env::current_dir().expect("current directory");
        let (observed, mut observed_rx) = mpsc::unbounded_channel();
        let app = Router::new()
            .route(
                "/session/{session_id}/message",
                get(opencode_messages_fixture),
            )
            .route("/session/source/fork", post(opencode_fork_fixture))
            .with_state(ForkServerState {
                directory: directory.to_string_lossy().to_string(),
                observed,
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });
        let context = SessionContext {
            http: Client::new(),
            http_base: format!("http://{address}/"),
            session_id: SessionId::new("source"),
            cwd: directory.clone(),
        };

        let forked = OpenCodeHarnessAdapter
            .fork(
                &context,
                HarnessForkRequest {
                    user_message_ordinal: 0,
                    first_text: "second".to_string(),
                    first_text_truncated: false,
                    raw_message_id_hint: Some("raw-user-2".to_string()),
                },
            )
            .await
            .expect("fork succeeds");
        assert_eq!(forked.session_id, "forked");
        assert_eq!(forked.parent_session_id, "source");
        assert_eq!(forked.directory, directory);
        assert_eq!(observed_rx.recv().await.as_deref(), Some("raw-user-2"));
        server.abort();
    }

    #[tokio::test]
    async fn opencode_fork_and_message_validation_fail_closed() {
        let request = |first_text: &str, raw_message_id_hint: Option<&str>| HarnessForkRequest {
            user_message_ordinal: 1,
            first_text: first_text.to_string(),
            first_text_truncated: false,
            raw_message_id_hint: raw_message_id_hint.map(str::to_string),
        };

        let app = Router::new()
            .route(
                "/session/{session_id}/message",
                get(opencode_mismatched_messages_fixture),
            )
            .route(
                "/session/source/fork",
                post(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
            );
        let (context, server) = fixture_context(app, "source").await;
        assert!(matches!(
            OpenCodeHarnessAdapter
                .fork(&context, request("second", None))
                .await,
            Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
        ));
        server.abort();

        let app = Router::new()
            .route(
                "/session/{session_id}/message",
                get(opencode_mismatched_messages_fixture),
            )
            .route(
                "/session/source/fork",
                post(|| async {
                    Json(serde_json::json!({
                        "id": "forked",
                        "parentID": "source",
                        "directory": std::env::current_dir()
                            .expect("current directory")
                            .to_string_lossy(),
                        "title": "Forked"
                    }))
                }),
            );
        let (context, server) = fixture_context(app, "source").await;
        assert!(matches!(
            OpenCodeHarnessAdapter
                .fork(
                    &context,
                    HarnessForkRequest {
                        user_message_ordinal: 1,
                        first_text: "second".to_string(),
                        first_text_truncated: false,
                        raw_message_id_hint: None,
                    },
                )
                .await,
            Err(HarnessError::InvalidResponse(_))
        ));
        server.abort();

        let app = Router::new().route(
            "/session/{session_id}/message",
            get(opencode_messages_fixture),
        );
        let (context, server) = fixture_context(app, "source").await;
        assert!(matches!(
            resolve_opencode_message_id(&context, &request("different", None)).await,
            Err(HarnessError::InvalidResponse(_))
        ));
        assert!(matches!(
            resolve_opencode_message_id(&context, &request("second", Some("wrong"))).await,
            Err(HarnessError::InvalidResponse(_))
        ));
        server.abort();

        let app = Router::new().route(
            "/session/source/message",
            get(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
        );
        let (context, server) = fixture_context(app, "source").await;
        assert!(matches!(
            opencode_messages(&context, "source").await,
            Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
        ));
        server.abort();

        let app = Router::new().route(
            "/session/source/message",
            get(|| async { "x".repeat(MAX_OPENCODE_RESPONSE_BYTES + 1) }),
        );
        let (context, server) = fixture_context(app, "source").await;
        assert!(matches!(
            opencode_messages(&context, "source").await,
            Err(HarnessError::ResponseTooLarge)
        ));
        server.abort();
    }

    #[derive(Clone, Copy)]
    enum StatusFixtureMode {
        BusyThenAbsent,
        Absent,
        Idle,
        Busy,
        Failure,
    }

    #[derive(Clone)]
    struct StatusFixtureState {
        calls: Arc<AtomicUsize>,
        mode: StatusFixtureMode,
    }

    async fn opencode_status_fixture(
        State(state): State<StatusFixtureState>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let call = state.calls.fetch_add(1, Ordering::SeqCst);
        match state.mode {
            StatusFixtureMode::BusyThenAbsent if call == 0 => (
                StatusCode::OK,
                Json(serde_json::json!({"source": {"type": "busy"}})),
            ),
            StatusFixtureMode::Busy => (
                StatusCode::OK,
                Json(serde_json::json!({"source": {"type": "busy"}})),
            ),
            StatusFixtureMode::Idle => (
                StatusCode::OK,
                Json(serde_json::json!({"source": {"type": "idle"}})),
            ),
            StatusFixtureMode::Failure => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "failed"})),
            ),
            StatusFixtureMode::BusyThenAbsent | StatusFixtureMode::Absent => {
                (StatusCode::OK, Json(serde_json::json!({})))
            }
        }
    }

    async fn status_fixture_context(
        mode: StatusFixtureMode,
    ) -> (
        SessionContext,
        Arc<AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        let calls = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/session/status", get(opencode_status_fixture))
            .with_state(StatusFixtureState {
                calls: calls.clone(),
                mode,
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });
        (
            SessionContext {
                http: Client::new(),
                http_base: format!("http://{address}/"),
                session_id: SessionId::new("source"),
                cwd: std::env::current_dir().expect("current directory"),
            },
            calls,
            server,
        )
    }

    #[tokio::test]
    async fn opencode_status_polling_accepts_absence_only_after_confirmation_and_surfaces_failures()
    {
        for mode in [
            StatusFixtureMode::BusyThenAbsent,
            StatusFixtureMode::Absent,
            StatusFixtureMode::Idle,
        ] {
            let (context, calls, server) = status_fixture_context(mode).await;
            wait_for_opencode_idle(
                &context,
                Duration::from_millis(100),
                Duration::from_millis(5),
                Duration::from_millis(10),
            )
            .await
            .expect("absence confirms idle");
            assert!(calls.load(Ordering::SeqCst) >= 3);
            server.abort();
        }

        let (context, _, server) = status_fixture_context(StatusFixtureMode::Busy).await;
        assert!(matches!(
            wait_for_opencode_idle(
                &context,
                Duration::from_millis(20),
                Duration::from_millis(5),
                Duration::from_millis(10),
            )
            .await,
            Err(HarnessError::StatusTimeout)
        ));
        server.abort();

        let (context, _, server) = status_fixture_context(StatusFixtureMode::Failure).await;
        assert!(matches!(
            wait_for_opencode_idle(
                &context,
                Duration::from_millis(100),
                Duration::from_millis(5),
                Duration::from_millis(10),
            )
            .await,
            Err(HarnessError::Http(StatusCode::INTERNAL_SERVER_ERROR))
        ));
        server.abort();
    }
}
