use crate::config::constant_time_eq;
use crate::{now_iso, BridgeError};
use base64::engine::general_purpose;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use dappercode_bridge_platform::discover_loopback_listening_ports as platform_listening_ports;
use futures_util::{stream, StreamExt};
use getrandom::fill as fill_random;
use reqwest::{Client as HttpClient, Url};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};
use tokio::sync::RwLock;
use tokio::time::timeout;

pub(crate) const BROWSER_PREVIEW_SESSION_TTL: Duration = Duration::from_secs(60 * 30);
const BROWSER_PREVIEW_MAX_SESSIONS: usize = 12;
const BROWSER_PREVIEW_DISCOVERY_HTTP_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPreviewSessionResponse {
    session_id: String,
    target_url: String,
    preview_port: u16,
    preview_base_url: Option<String>,
    bootstrap_path: String,
    created_at: String,
    last_accessed_at: String,
    expires_at: String,
}

impl std::fmt::Debug for BrowserPreviewSessionResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BrowserPreviewSessionResponse")
            .field("session_id", &"[REDACTED]")
            .field("target_url", &"[REDACTED]")
            .field("preview_port", &self.preview_port)
            .field("preview_base_url", &self.preview_base_url)
            .field("bootstrap_path", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .field("last_accessed_at", &self.last_accessed_at)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPreviewDiscoverySuggestion {
    target_url: String,
    port: u16,
    label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPreviewDiscoveryResponse {
    scanned_at: String,
    suggestions: Vec<BrowserPreviewDiscoverySuggestion>,
}

#[derive(Clone)]
struct BrowserPreviewSessionEntry {
    id: String,
    owner_client_id: u64,
    target_url: Url,
    bootstrap_token: String,
    created_at: String,
    last_accessed_at: String,
    expires_at: SystemTime,
}

#[derive(Clone)]
pub(crate) struct BrowserPreviewResolvedSession {
    pub(crate) session_id: String,
    pub(crate) target_url: Url,
}

pub(crate) struct BrowserPreviewService {
    bridge_port: u16,
    preview_port: u16,
    preview_base_url: Option<String>,
    secure_cookie: bool,
    available: AtomicBool,
    pub(crate) http: HttpClient,
    sessions: RwLock<HashMap<String, BrowserPreviewSessionEntry>>,
}

impl BrowserPreviewService {
    pub(crate) fn new(
        bridge_port: u16,
        preview_port: u16,
        preview_base_url: Option<String>,
        fallback_connect_url: Option<String>,
    ) -> Self {
        let secure_cookie = preview_base_url
            .as_deref()
            .or(fallback_connect_url.as_deref())
            .map(Url::parse)
            .and_then(Result::ok)
            .is_some_and(|url| url.scheme() == "https");
        Self {
            bridge_port,
            preview_port,
            preview_base_url,
            secure_cookie,
            available: AtomicBool::new(false),
            http: crate::tls::preview_client_builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("build browser preview client"),
            sessions: RwLock::new(HashMap::new()),
        }
    }

    pub(crate) fn is_available(&self) -> bool {
        self.available.load(Ordering::Relaxed)
    }

    pub(crate) fn set_available(&self, available: bool) {
        self.available.store(available, Ordering::Relaxed);
    }

    pub(crate) async fn create_session(
        &self,
        owner_client_id: u64,
        target_url: &str,
    ) -> Result<BrowserPreviewSessionResponse, BridgeError> {
        if !self.is_available() {
            return Err(BridgeError::server("browser preview server is unavailable"));
        }

        let target_url = normalize_browser_preview_target_url(target_url)?;
        let created_at_time = SystemTime::now();
        let expires_at = created_at_time
            .checked_add(BROWSER_PREVIEW_SESSION_TTL)
            .ok_or_else(|| BridgeError::server("could not calculate preview session expiry"))?;
        let created_at = DateTime::<Utc>::from(created_at_time).to_rfc3339();
        let session_id = random_preview_credential(24)?;
        let bootstrap_token = random_preview_credential(32)?;
        let entry = BrowserPreviewSessionEntry {
            id: session_id.clone(),
            owner_client_id,
            target_url,
            bootstrap_token,
            created_at: created_at.clone(),
            last_accessed_at: created_at,
            expires_at,
        };

        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        sessions.retain(|_, existing| existing.owner_client_id != owner_client_id);
        evict_excess_preview_sessions(&mut sessions);
        sessions.insert(session_id, entry.clone());
        Ok(self.to_session_response(&entry))
    }

    pub(crate) async fn close_session(&self, owner_client_id: u64, session_id: &str) -> bool {
        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        let owned = sessions
            .get(session_id)
            .is_some_and(|entry| entry.owner_client_id == owner_client_id);
        owned && sessions.remove(session_id).is_some()
    }

    pub(crate) async fn revoke_owner(&self, owner_client_id: u64) -> usize {
        let mut sessions = self.sessions.write().await;
        let before = sessions.len();
        sessions.retain(|_, entry| entry.owner_client_id != owner_client_id);
        before.saturating_sub(sessions.len())
    }

    pub(crate) fn secure_cookie(&self) -> bool {
        self.secure_cookie
    }

    pub(crate) async fn active_session_count(&self) -> usize {
        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        sessions.len()
    }

    pub(crate) async fn resolve_bootstrap(
        &self,
        session_id: &str,
        bootstrap_token: &str,
    ) -> Option<BrowserPreviewResolvedSession> {
        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        let entry = sessions.get_mut(session_id)?;
        if !constant_time_eq(&entry.bootstrap_token, bootstrap_token) {
            return None;
        }
        entry.last_accessed_at = now_iso();
        Some(BrowserPreviewResolvedSession {
            session_id: entry.id.clone(),
            target_url: entry.target_url.clone(),
        })
    }

    pub(crate) async fn resolve_cookie(
        &self,
        bootstrap_token: &str,
    ) -> Option<BrowserPreviewResolvedSession> {
        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        let now = now_iso();
        for entry in sessions.values_mut() {
            if constant_time_eq(&entry.bootstrap_token, bootstrap_token) {
                entry.last_accessed_at = now.clone();
                return Some(BrowserPreviewResolvedSession {
                    session_id: entry.id.clone(),
                    target_url: entry.target_url.clone(),
                });
            }
        }
        None
    }

    pub(crate) async fn discover_targets(&self) -> BrowserPreviewDiscoveryResponse {
        let candidate_ports =
            discover_loopback_listening_ports(&[self.bridge_port, self.preview_port]).await;
        let http = self.http.clone();
        let suggestions = stream::iter(candidate_ports)
            .map(|port| {
                let http = http.clone();
                async move {
                    if is_loopback_http_port_reachable(&http, port).await {
                        Some(BrowserPreviewDiscoverySuggestion {
                            target_url: format!("http://127.0.0.1:{port}"),
                            port,
                            label: browser_preview_label_for_port(port),
                        })
                    } else {
                        None
                    }
                }
            })
            .buffer_unordered(24)
            .collect::<Vec<Option<BrowserPreviewDiscoverySuggestion>>>()
            .await;
        let mut suggestions = suggestions.into_iter().flatten().collect::<Vec<_>>();
        suggestions.sort_by_key(|suggestion| suggestion.port);
        BrowserPreviewDiscoveryResponse {
            scanned_at: now_iso(),
            suggestions,
        }
    }

    fn to_session_response(
        &self,
        entry: &BrowserPreviewSessionEntry,
    ) -> BrowserPreviewSessionResponse {
        BrowserPreviewSessionResponse {
            session_id: entry.id.clone(),
            target_url: entry.target_url.to_string(),
            preview_port: self.preview_port,
            preview_base_url: self.preview_base_url.clone(),
            bootstrap_path: build_preview_bootstrap_path(
                &entry.target_url,
                &entry.id,
                &entry.bootstrap_token,
            ),
            created_at: entry.created_at.clone(),
            last_accessed_at: entry.last_accessed_at.clone(),
            expires_at: DateTime::<Utc>::from(entry.expires_at).to_rfc3339(),
        }
    }
}

fn random_preview_credential(byte_len: usize) -> Result<String, BridgeError> {
    let mut bytes = vec![0_u8; byte_len];
    fill_random(&mut bytes).map_err(|error| {
        BridgeError::server(format!("failed to generate preview credential: {error}"))
    })?;
    Ok(general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

pub(crate) fn normalize_browser_preview_target_url(raw: &str) -> Result<Url, BridgeError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(BridgeError::invalid_params("targetUrl must not be empty"));
    }
    let mut parsed = Url::parse(trimmed)
        .map_err(|error| BridgeError::invalid_params(format!("invalid targetUrl: {error}")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(BridgeError::invalid_params(
            "targetUrl must use http:// or https://",
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(BridgeError::invalid_params(
            "targetUrl must not include username or password",
        ));
    }
    let Some(host) = parsed.host_str() else {
        return Err(BridgeError::invalid_params("targetUrl host is required"));
    };
    let normalized_host = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if !matches!(normalized_host.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return Err(BridgeError::invalid_params(
            "browser preview only supports localhost, 127.0.0.1, or ::1 targets",
        ));
    }
    parsed.set_fragment(None);
    Ok(parsed)
}

fn build_preview_bootstrap_path(
    target_url: &Url,
    session_id: &str,
    bootstrap_token: &str,
) -> String {
    let mut bootstrap_url = target_url.clone();
    bootstrap_url.set_fragment(None);
    let query_pairs = bootstrap_url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    bootstrap_url.set_query(None);
    let mut serializer = bootstrap_url.query_pairs_mut();
    for (key, value) in &query_pairs {
        serializer.append_pair(key, value);
    }
    serializer.append_pair("sid", session_id);
    serializer.append_pair("st", bootstrap_token);
    drop(serializer);
    format!(
        "{}{}",
        bootstrap_url.path(),
        bootstrap_url
            .query()
            .map(|value| format!("?{value}"))
            .unwrap_or_default(),
    )
}

async fn discover_loopback_listening_ports(excluded_ports: &[u16]) -> Vec<u16> {
    let mut ports = platform_listening_ports().await;
    ports.retain(|port| !excluded_ports.contains(port));
    ports
}

async fn is_loopback_http_port_reachable(http: &HttpClient, port: u16) -> bool {
    let request = http
        .get(format!("http://127.0.0.1:{port}/"))
        .header("accept", "text/html,application/json,*/*");
    timeout(BROWSER_PREVIEW_DISCOVERY_HTTP_TIMEOUT, request.send())
        .await
        .map(|result| result.is_ok())
        .unwrap_or(false)
}

pub(crate) fn browser_preview_label_for_port(port: u16) -> String {
    match port {
        3000..=3005 => format!("Local dev server on :{port}"),
        4173 => "Vite preview on :4173".to_string(),
        4200 => "Angular dev server on :4200".to_string(),
        4321 => "Metro / Expo web on :4321".to_string(),
        5000 => "Local dev server on :5000".to_string(),
        5173 => "Vite dev server on :5173".to_string(),
        5500 => "Live Server on :5500".to_string(),
        8000 => "Local dev server on :8000".to_string(),
        8080 => "Local dev server on :8080".to_string(),
        8081 => "Metro bundler on :8081".to_string(),
        _ => format!("Local dev server on :{port}"),
    }
}

fn prune_expired_preview_sessions(sessions: &mut HashMap<String, BrowserPreviewSessionEntry>) {
    let now = SystemTime::now();
    sessions.retain(|_, entry| entry.expires_at > now);
}

fn evict_excess_preview_sessions(sessions: &mut HashMap<String, BrowserPreviewSessionEntry>) {
    while sessions.len() + 1 > BROWSER_PREVIEW_MAX_SESSIONS {
        let Some(oldest_id) = sessions
            .values()
            .min_by(|left, right| left.last_accessed_at.cmp(&right.last_accessed_at))
            .map(|entry| entry.id.clone())
        else {
            break;
        };
        sessions.remove(&oldest_id);
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "preview_tests.rs"]
mod tests;
