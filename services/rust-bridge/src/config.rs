use std::{collections::HashSet, env, net::IpAddr, path::PathBuf, time::Duration};

use axum::http::{header::ORIGIN, HeaderMap};
use reqwest::Url;

use crate::{
    path_policy::PathPolicy, services::TerminalExecPolicy, url_redaction::redact_url_credentials,
};

pub(crate) const DEFAULT_WS_MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const DEFAULT_WS_MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const DEFAULT_WS_PER_CLIENT_IN_FLIGHT: usize = 16;
pub(crate) const DEFAULT_WS_GLOBAL_IN_FLIGHT: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TransportMode {
    PrivateBearer,
    TailnetPinnedTls,
}

impl TransportMode {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::PrivateBearer => "privateBearer",
            Self::TailnetPinnedTls => "tailnetPinnedTls",
        }
    }

    fn from_env() -> Result<Self, String> {
        let value = parse_string_env_with_default("BRIDGE_TRANSPORT_MODE", "privateBearer")?;
        match value.trim() {
            "privateBearer" => Ok(Self::PrivateBearer),
            "tailnetPinnedTls" => Ok(Self::TailnetPinnedTls),
            _ => Err("BRIDGE_TRANSPORT_MODE must be privateBearer or tailnetPinnedTls".to_string()),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NetworkMode {
    Local,
    Tailscale,
}

impl NetworkMode {
    fn from_env() -> Result<Self, String> {
        let value = parse_string_env_with_default("BRIDGE_NETWORK_MODE", "local")?;
        match value.trim() {
            "local" => Ok(Self::Local),
            "tailscale" => Ok(Self::Tailscale),
            _ => Err("BRIDGE_NETWORK_MODE must be local or tailscale".to_string()),
        }
    }
}

#[derive(Clone)]
pub(crate) struct BridgeConfig {
    pub(crate) transport_mode: TransportMode,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) preview_host: String,
    pub(crate) preview_port: u16,
    pub(crate) connect_url: Option<String>,
    pub(crate) preview_connect_url: Option<String>,
    pub(crate) workdir: PathBuf,
    /// Directory holding bridge-owned state (session index, push registry).
    pub(crate) state_dir: PathBuf,
    /// Directory holding mobile uploads.
    pub(crate) attachments_dir: PathBuf,
    pub(crate) acp_manifest_path: PathBuf,
    pub(crate) acp_approved_executable_roots: Vec<PathBuf>,
    pub(crate) acp_initialize_timeout: Duration,
    pub(crate) auth_token: Option<String>,
    pub(crate) auth_enabled: bool,
    pub(crate) allow_insecure_no_auth: bool,
    pub(crate) no_auth_allowed_origins: HashSet<String>,
    pub(crate) enforce_authenticated_origins: bool,
    pub(crate) authenticated_allowed_origins: HashSet<String>,
    pub(crate) allow_query_token_auth: bool,
    pub(crate) allow_outside_root_cwd: bool,
    pub(crate) terminal_exec_policies: HashSet<TerminalExecPolicy>,
    pub(crate) show_pairing_qr: bool,
    pub(crate) ws_limits: WebSocketResourceLimits,
}

#[derive(Debug, Clone)]
pub(crate) struct WebSocketResourceLimits {
    pub(crate) max_frame_bytes: usize,
    pub(crate) max_message_bytes: usize,
    pub(crate) per_client_in_flight: usize,
    pub(crate) global_in_flight: usize,
}

impl BridgeConfig {
    pub(crate) fn from_env() -> Result<Self, String> {
        let transport_mode = TransportMode::from_env()?;
        let network_mode = NetworkMode::from_env()?;
        let host = env::var("BRIDGE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = env::var("BRIDGE_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(8787);
        let preview_host =
            env::var("BRIDGE_PREVIEW_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let preview_port = env::var("BRIDGE_PREVIEW_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or_else(|| port.checked_add(1).unwrap_or(8788));
        if preview_port == port {
            return Err("BRIDGE_PREVIEW_PORT must differ from BRIDGE_PORT".to_string());
        }
        let connect_url = parse_connect_url_env("BRIDGE_CONNECT_URL")?;
        let preview_connect_url = parse_connect_url_env("BRIDGE_PREVIEW_CONNECT_URL")?;

        let configured_workdir = env::var("BRIDGE_WORKDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let workdir = resolve_bridge_workdir(configured_workdir)?;

        // The desktop app points these at its central data directory so nothing app-owned lands in
        // a repository. The development flow keeps working through the workdir-relative defaults.
        let state_dir = parse_absolute_dir_env("BRIDGE_STATE_DIR", workdir.join(".dappercode"))?;
        let attachments_dir = parse_absolute_dir_env(
            "BRIDGE_ATTACHMENTS_DIR",
            workdir.join(crate::attachments::DEFAULT_ATTACHMENTS_DIR_NAME),
        )?;

        let acp_manifest_path = env::var("ACP_AGENT_MANIFEST")
            .map(PathBuf::from)
            .unwrap_or_else(|_| workdir.join(".dappercode/agents.json"));
        let acp_approved_executable_roots =
            parse_path_list_env("ACP_AGENT_ROOTS", &[workdir.join(".dappercode/agents")])?;
        let acp_initialize_timeout =
            Duration::from_millis(parse_positive_u64_env("ACP_INITIALIZE_TIMEOUT_MS", 15_000)?);
        let auth_token = env::var("BRIDGE_AUTH_TOKEN")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let allow_insecure_no_auth = parse_bool_env("BRIDGE_ALLOW_INSECURE_NO_AUTH")?;
        let no_auth_allowed_origins = parse_origin_csv_env("BRIDGE_NO_AUTH_ALLOWED_ORIGINS")?;
        let enforce_authenticated_origins = parse_bool_env("BRIDGE_ENFORCE_AUTHENTICATED_ORIGINS")?;
        let authenticated_allowed_origins =
            parse_origin_csv_env("BRIDGE_AUTHENTICATED_ALLOWED_ORIGINS")?;
        let allow_query_token_auth = parse_bool_env("BRIDGE_ALLOW_QUERY_TOKEN_AUTH")?;
        let pinned_tls_identity = parse_optional_absolute_path_env("BRIDGE_PINNED_TLS_IDENTITY")?;
        let pinned_tls_device_registry =
            parse_optional_absolute_path_env("BRIDGE_PINNED_TLS_DEVICE_REGISTRY")?;
        validate_transport_configuration(TransportValidation {
            transport_mode,
            network_mode,
            host: &host,
            auth_token: auth_token.as_deref(),
            allow_insecure_no_auth,
            allow_query_token_auth,
            connect_url: connect_url.as_deref(),
            preview_connect_url: preview_connect_url.as_deref(),
            pinned_tls_identity: pinned_tls_identity.as_deref(),
            pinned_tls_device_registry: pinned_tls_device_registry.as_deref(),
        })?;
        let auth_enabled = auth_token.is_some();
        let allow_outside_root_cwd =
            parse_bool_env_with_default("BRIDGE_ALLOW_OUTSIDE_ROOT_CWD", true)?;
        let show_pairing_qr = parse_bool_env_with_default("BRIDGE_SHOW_PAIRING_QR", true)?;
        let ws_limits = WebSocketResourceLimits::from_env()?;

        let terminal_exec_policies = parse_terminal_exec_policies_env()?;

        Ok(Self {
            transport_mode,
            host,
            port,
            preview_host,
            preview_port,
            connect_url,
            preview_connect_url,
            workdir,
            state_dir,
            attachments_dir,
            acp_manifest_path,
            acp_approved_executable_roots,
            acp_initialize_timeout,
            auth_token,
            auth_enabled,
            allow_insecure_no_auth,
            no_auth_allowed_origins,
            enforce_authenticated_origins,
            authenticated_allowed_origins,
            allow_query_token_auth,
            allow_outside_root_cwd,
            terminal_exec_policies,
            show_pairing_qr,
            ws_limits,
        })
    }

    pub(crate) fn is_authorized(&self, headers: &HeaderMap, query_token: Option<&str>) -> bool {
        if !self.auth_enabled {
            return true;
        }

        self.is_authorized_with_bridge_token(headers, query_token)
    }

    pub(crate) fn is_browser_origin_allowed(&self, headers: &HeaderMap) -> bool {
        let policy = match (self.transport_mode, self.auth_enabled) {
            (TransportMode::TailnetPinnedTls, _) => {
                BrowserOriginPolicy::ExactAllowlist(&self.authenticated_allowed_origins)
            }
            (TransportMode::PrivateBearer, true) if !self.enforce_authenticated_origins => {
                return true;
            }
            (TransportMode::PrivateBearer, true) => {
                BrowserOriginPolicy::ExactAllowlist(&self.authenticated_allowed_origins)
            }
            (TransportMode::PrivateBearer, false) => BrowserOriginPolicy::LoopbackDevelopment,
        };

        let origin = match request_browser_origin(headers) {
            Ok(None) => return true,
            Ok(Some(origin)) => origin,
            Err(()) => return false,
        };

        match policy {
            BrowserOriginPolicy::ExactAllowlist(allowed) => allowed.contains(&origin),
            BrowserOriginPolicy::LoopbackDevelopment => {
                origin == listener_origin(&self.host, self.port)
                    || self.no_auth_allowed_origins.contains(&origin)
            }
        }
    }

    pub(crate) fn is_authorized_with_bridge_token(
        &self,
        headers: &HeaderMap,
        query_token: Option<&str>,
    ) -> bool {
        let expected = match &self.auth_token {
            Some(token) => token,
            None => return false,
        };

        if let Some(token) = extract_bearer_token(headers) {
            if constant_time_eq(token, expected) {
                return true;
            }
        }

        if self.allow_query_token_auth {
            if let Some(token) = query_token.map(str::trim).filter(|token| !token.is_empty()) {
                if constant_time_eq(token, expected) {
                    return true;
                }
            }
        }

        false
    }
}

enum BrowserOriginPolicy<'a> {
    ExactAllowlist(&'a HashSet<String>),
    LoopbackDevelopment,
}

#[derive(Clone, Copy)]
struct TransportValidation<'a> {
    transport_mode: TransportMode,
    network_mode: NetworkMode,
    host: &'a str,
    auth_token: Option<&'a str>,
    allow_insecure_no_auth: bool,
    allow_query_token_auth: bool,
    connect_url: Option<&'a str>,
    preview_connect_url: Option<&'a str>,
    pinned_tls_identity: Option<&'a std::path::Path>,
    pinned_tls_device_registry: Option<&'a std::path::Path>,
}

fn request_browser_origin(headers: &HeaderMap) -> Result<Option<String>, ()> {
    let mut origins = headers.get_all(ORIGIN).iter();
    let Some(raw_origin) = origins.next() else {
        return Ok(None);
    };
    if origins.next().is_some() {
        return Err(());
    }
    let raw_origin = raw_origin.to_str().map_err(|_| ())?;
    normalize_browser_origin(raw_origin).map(Some).ok_or(())
}

fn validate_transport_configuration(input: TransportValidation<'_>) -> Result<(), String> {
    match input.transport_mode {
        TransportMode::PrivateBearer => {
            if input.auth_token.is_none() && !input.allow_insecure_no_auth {
                return Err(
                    "BRIDGE_AUTH_TOKEN is required. Set BRIDGE_ALLOW_INSECURE_NO_AUTH=true only for local development."
                        .to_string(),
                );
            }
            if input.auth_token.is_none() {
                validate_no_auth_listener(input.host)?;
            }
            Ok(())
        }
        TransportMode::TailnetPinnedTls => validate_pinned_tls_configuration(&input),
    }
}

fn validate_pinned_tls_configuration(input: &TransportValidation<'_>) -> Result<(), String> {
    if input.network_mode != NetworkMode::Tailscale {
        return Err("tailnetPinnedTls requires BRIDGE_NETWORK_MODE=tailscale".to_string());
    }
    if input.auth_token.is_some() {
        return Err(
            "tailnetPinnedTls rejects BRIDGE_AUTH_TOKEN; bearer credentials cannot be used by the pinned TLS listener"
                .to_string(),
        );
    }
    if input.allow_query_token_auth {
        return Err("tailnetPinnedTls rejects BRIDGE_ALLOW_QUERY_TOKEN_AUTH=true".to_string());
    }
    if input.allow_insecure_no_auth {
        return Err("tailnetPinnedTls rejects BRIDGE_ALLOW_INSECURE_NO_AUTH=true".to_string());
    }
    require_https_url("BRIDGE_CONNECT_URL", input.connect_url)?;
    require_https_url("BRIDGE_PREVIEW_CONNECT_URL", input.preview_connect_url)?;
    if input.pinned_tls_identity.is_none() {
        return Err(
            "tailnetPinnedTls requires BRIDGE_PINNED_TLS_IDENTITY for the future bridge identity"
                .to_string(),
        );
    }
    if input.pinned_tls_device_registry.is_none() {
        return Err(
            "tailnetPinnedTls requires BRIDGE_PINNED_TLS_DEVICE_REGISTRY for the future enrolled-device registry"
                .to_string(),
        );
    }

    Err(
        "tailnetPinnedTls is not yet available; the dedicated pinned TLS listener and device registry enforcement are not implemented, and the bridge will not fall back to HTTP/bearer routes"
            .to_string(),
    )
}

fn require_https_url(name: &str, value: Option<&str>) -> Result<(), String> {
    if value.is_some_and(|url| url.starts_with("https://")) {
        Ok(())
    } else {
        Err(format!(
            "tailnetPinnedTls requires {name} to be an explicit https:// URL; HTTP and fallback routes are rejected"
        ))
    }
}

impl WebSocketResourceLimits {
    pub(crate) fn from_env() -> Result<Self, String> {
        let limits = Self {
            max_frame_bytes: parse_positive_usize_env(
                "BRIDGE_WS_MAX_FRAME_BYTES",
                DEFAULT_WS_MAX_FRAME_BYTES,
            )?,
            max_message_bytes: parse_positive_usize_env(
                "BRIDGE_WS_MAX_MESSAGE_BYTES",
                DEFAULT_WS_MAX_MESSAGE_BYTES,
            )?,
            per_client_in_flight: parse_positive_usize_env(
                "BRIDGE_WS_PER_CLIENT_IN_FLIGHT",
                DEFAULT_WS_PER_CLIENT_IN_FLIGHT,
            )?,
            global_in_flight: parse_positive_usize_env(
                "BRIDGE_WS_GLOBAL_IN_FLIGHT",
                DEFAULT_WS_GLOBAL_IN_FLIGHT,
            )?,
        };
        limits.validate()?;
        Ok(limits)
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.max_frame_bytes > self.max_message_bytes {
            return Err(
                "BRIDGE_WS_MAX_FRAME_BYTES must not exceed BRIDGE_WS_MAX_MESSAGE_BYTES".to_string(),
            );
        }
        if self.per_client_in_flight > self.global_in_flight {
            return Err(
                "BRIDGE_WS_PER_CLIENT_IN_FLIGHT must not exceed BRIDGE_WS_GLOBAL_IN_FLIGHT"
                    .to_string(),
            );
        }
        Ok(())
    }
}

fn extract_bearer_token(headers: &HeaderMap) -> Option<&str> {
    let raw = headers.get("authorization")?.to_str().ok()?;
    let mut parts = raw.split_whitespace();
    let scheme = parts.next()?;
    let token = parts.next()?;
    if !scheme.eq_ignore_ascii_case("bearer") || parts.next().is_some() {
        return None;
    }
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed)
}

pub(crate) fn constant_time_eq(left: &str, right: &str) -> bool {
    let left_bytes = left.as_bytes();
    let right_bytes = right.as_bytes();
    let max_len = left_bytes.len().max(right_bytes.len());

    let mut diff = left_bytes.len() ^ right_bytes.len();
    for index in 0..max_len {
        let left_byte = *left_bytes.get(index).unwrap_or(&0);
        let right_byte = *right_bytes.get(index).unwrap_or(&0);
        diff |= (left_byte ^ right_byte) as usize;
    }

    diff == 0
}

pub(crate) fn resolve_bridge_workdir(raw_workdir: PathBuf) -> Result<PathBuf, String> {
    PathPolicy::new(raw_workdir, false).map(|policy| policy.root().to_path_buf())
}

/// Resolves a directory environment variable, creating it when absent.
///
/// The value must be absolute so that a bridge started from any working directory reaches the same
/// state, and so a relative path can never resolve into an unexpected part of the repository.
fn parse_absolute_dir_env(name: &str, default: PathBuf) -> Result<PathBuf, String> {
    let configured = match env::var(name) {
        Ok(raw) if !raw.trim().is_empty() => PathBuf::from(raw.trim()),
        _ => default,
    };
    if !configured.is_absolute() {
        return Err(format!(
            "{name} must be an absolute path (got: {})",
            configured.to_string_lossy()
        ));
    }
    std::fs::create_dir_all(&configured).map_err(|error| {
        format!(
            "{name} could not be created ({}): {error}",
            configured.to_string_lossy()
        )
    })?;
    std::fs::canonicalize(&configured).map_err(|error| {
        format!(
            "{name} is invalid or inaccessible ({}): {error}",
            configured.to_string_lossy()
        )
    })
}

pub(crate) fn parse_bool_env(name: &str) -> Result<bool, String> {
    parse_bool_env_with_default(name, false)
}

fn parse_string_env_with_default(name: &str, default: &str) -> Result<String, String> {
    match env::var(name) {
        Ok(value) => Ok(value),
        Err(env::VarError::NotPresent) => Ok(default.to_string()),
        Err(env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid UTF-8")),
    }
}

pub(crate) fn parse_bool_env_with_default(name: &str, default: bool) -> Result<bool, String> {
    match env::var(name) {
        Ok(raw) => {
            let value = raw.trim();
            if value.eq_ignore_ascii_case("true") {
                Ok(true)
            } else if value.eq_ignore_ascii_case("false") {
                Ok(false)
            } else {
                Err(format!("{name} must be true or false"))
            }
        }
        Err(env::VarError::NotPresent) => Ok(default),
        Err(env::VarError::NotUnicode(_)) => Err(format!("{name} must be true or false")),
    }
}

pub(crate) fn parse_positive_usize_env(name: &str, default: usize) -> Result<usize, String> {
    let Some(raw) = env::var(name).ok() else {
        return Ok(default);
    };
    let value = raw
        .trim()
        .parse::<usize>()
        .map_err(|_| format!("{name} must be a positive integer"))?;
    if value == 0 {
        return Err(format!("{name} must be greater than zero"));
    }
    Ok(value)
}

fn parse_positive_u64_env(name: &str, default: u64) -> Result<u64, String> {
    let Some(raw) = env::var(name).ok() else {
        return Ok(default);
    };
    raw.trim()
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{name} must be a positive integer"))
}

fn parse_path_list_env(name: &str, defaults: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let paths = env::var(name)
        .ok()
        .map(|raw| {
            env::split_paths(&raw)
                .filter(|entry| !entry.as_os_str().is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| defaults.to_vec());
    if paths.is_empty() || paths.iter().any(|path| !path.is_absolute()) {
        return Err(format!("{name} must contain absolute paths"));
    }
    Ok(paths)
}

fn parse_optional_absolute_path_env(name: &str) -> Result<Option<PathBuf>, String> {
    let Some(path) = env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    else {
        return Ok(None);
    };
    if !path.is_absolute() {
        return Err(format!("{name} must be an absolute path"));
    }
    Ok(Some(path))
}

pub(crate) fn normalize_connect_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut parsed = Url::parse(trimmed).ok()?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return None,
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }

    let normalized_path = parsed.path().trim_end_matches('/').to_string();
    let final_path = if normalized_path.is_empty() {
        ""
    } else {
        normalized_path.as_str()
    };
    parsed.set_path(final_path);
    parsed.set_query(None);
    parsed.set_fragment(None);

    Some(parsed.to_string().trim_end_matches('/').to_string())
}

fn parse_connect_url_env(name: &str) -> Result<Option<String>, String> {
    let Some(raw) = env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    normalize_connect_url(&raw)
        .ok_or_else(|| format!("{name} must be a valid http:// or https:// base URL"))
        .map(Some)
}

fn parse_terminal_exec_policies_env() -> Result<HashSet<TerminalExecPolicy>, String> {
    let raw = env::var("BRIDGE_TERMINAL_EXEC_POLICIES").unwrap_or_default();
    parse_terminal_exec_policies(&raw)
}

fn parse_terminal_exec_policies(raw: &str) -> Result<HashSet<TerminalExecPolicy>, String> {
    let mut policies = HashSet::new();
    for entry in raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let policy = TerminalExecPolicy::parse(entry).ok_or_else(|| {
            format!(
                "unsupported BRIDGE_TERMINAL_EXEC_POLICIES entry: {entry}; supported policies: pwd, ls, cat"
            )
        })?;
        policies.insert(policy);
    }
    Ok(policies)
}

fn parse_origin_csv_env(name: &str) -> Result<HashSet<String>, String> {
    let Some(raw) = env::var(name).ok() else {
        return Ok(HashSet::new());
    };

    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            normalize_browser_origin(entry).ok_or_else(|| {
                format!(
                    "{name} entries must be exact http:// or https:// origins without paths, credentials, queries, fragments, or wildcards: {}",
                    redact_url_credentials(entry)
                )
            })
        })
        .collect()
}

fn normalize_browser_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("null")
        || trimmed.contains(['*', '\\'])
        || trimmed.chars().any(char::is_whitespace)
    {
        return None;
    }
    let (scheme, authority_with_suffix) = trimmed.split_once("://")?;
    if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") {
        return None;
    }
    let authority = authority_with_suffix
        .strip_suffix('/')
        .unwrap_or(authority_with_suffix);
    if authority.is_empty() || authority.contains(['/', '?', '#']) {
        return None;
    }

    let parsed = Url::parse(trimmed).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }

    Some(parsed.origin().ascii_serialization())
}

fn listener_origin(host: &str, port: u16) -> String {
    let host = host.trim();
    let raw = if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("http://[{host}]:{port}")
    } else {
        format!("http://{host}:{port}")
    };
    normalize_browser_origin(&raw).expect("validated listener origin")
}

fn is_strict_loopback_listener(host: &str) -> bool {
    host.trim()
        .parse::<IpAddr>()
        .map(|address| address.is_loopback())
        .unwrap_or(false)
}

fn validate_no_auth_listener(host: &str) -> Result<(), String> {
    if is_strict_loopback_listener(host) {
        Ok(())
    } else {
        Err(
            "BRIDGE_ALLOW_INSECURE_NO_AUTH=true requires BRIDGE_HOST to be a literal loopback IP address (for example 127.0.0.1 or ::1)"
                .to_string(),
        )
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

    const CONFIG_ENV_NAMES: &[&str] = &[
        "BRIDGE_TRANSPORT_MODE",
        "BRIDGE_NETWORK_MODE",
        "BRIDGE_HOST",
        "BRIDGE_PORT",
        "BRIDGE_PREVIEW_HOST",
        "BRIDGE_PREVIEW_PORT",
        "BRIDGE_CONNECT_URL",
        "BRIDGE_PREVIEW_CONNECT_URL",
        "BRIDGE_WORKDIR",
        "BRIDGE_STATE_DIR",
        "BRIDGE_ATTACHMENTS_DIR",
        "ACP_AGENT_MANIFEST",
        "ACP_AGENT_ROOTS",
        "ACP_INITIALIZE_TIMEOUT_MS",
        "BRIDGE_AUTH_TOKEN",
        "BRIDGE_ALLOW_INSECURE_NO_AUTH",
        "BRIDGE_NO_AUTH_ALLOWED_ORIGINS",
        "BRIDGE_ENFORCE_AUTHENTICATED_ORIGINS",
        "BRIDGE_AUTHENTICATED_ALLOWED_ORIGINS",
        "BRIDGE_ALLOW_QUERY_TOKEN_AUTH",
        "BRIDGE_PINNED_TLS_IDENTITY",
        "BRIDGE_PINNED_TLS_DEVICE_REGISTRY",
        "BRIDGE_ALLOW_OUTSIDE_ROOT_CWD",
        "BRIDGE_SHOW_PAIRING_QR",
        "BRIDGE_WS_MAX_FRAME_BYTES",
        "BRIDGE_WS_MAX_MESSAGE_BYTES",
        "BRIDGE_WS_PER_CLIENT_IN_FLIGHT",
        "BRIDGE_WS_GLOBAL_IN_FLIGHT",
        "BRIDGE_TERMINAL_EXEC_POLICIES",
    ];

    struct RestoreEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);

    impl RestoreEnv {
        fn cleared(names: &'static [&'static str]) -> Self {
            let previous = names
                .iter()
                .map(|name| {
                    let value = env::var_os(name);
                    unsafe { env::remove_var(name) };
                    (*name, value)
                })
                .collect();
            Self(previous)
        }
    }

    impl Drop for RestoreEnv {
        fn drop(&mut self) {
            for (name, value) in self.0.drain(..) {
                if let Some(value) = value {
                    unsafe { env::set_var(name, value) };
                } else {
                    unsafe { env::remove_var(name) };
                }
            }
        }
    }

    /// Scratch directory that cleans itself up, mirroring the helper the attachment tests use so
    /// the bridge keeps its dependency-free test setup.
    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = env::temp_dir().join(format!(
                "dappercode-config-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("system clock")
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Serializes the process-wide environment mutations these tests need.
    struct DirEnvGuard {
        name: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl DirEnvGuard {
        fn set(name: &'static str, value: &std::path::Path) -> Self {
            let previous = env::var_os(name);
            env::set_var(name, value);
            Self { name, previous }
        }

        fn set_raw(name: &'static str, value: &str) -> Self {
            let previous = env::var_os(name);
            env::set_var(name, value);
            Self { name, previous }
        }
    }

    impl Drop for DirEnvGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => env::set_var(self.name, value),
                None => env::remove_var(self.name),
            }
        }
    }

    #[test]
    fn state_and_attachment_directories_default_beside_the_workspace() {
        let temp = TestDir::new();
        let workdir = temp.path().canonicalize().expect("canonical workdir");

        let state = parse_absolute_dir_env(
            "BRIDGE_STATE_DIR_UNSET_FOR_TEST",
            workdir.join(".dappercode"),
        )
        .expect("default state dir");
        assert_eq!(state, workdir.join(".dappercode"));
        assert!(state.is_dir(), "the default state directory is created");
    }

    #[test]
    fn an_explicit_state_directory_overrides_the_default() {
        let temp = TestDir::new();
        let configured = temp.path().join("central/state");
        let _guard = DirEnvGuard::set("BRIDGE_STATE_DIR", &configured);

        let resolved = parse_absolute_dir_env("BRIDGE_STATE_DIR", temp.path().join("ignored"))
            .expect("explicit state dir");
        assert_eq!(resolved, configured.canonicalize().expect("canonical"));
        assert!(!temp.path().join("ignored").exists());
    }

    #[test]
    fn a_blank_directory_variable_falls_back_to_the_default() {
        let temp = TestDir::new();
        let _guard = DirEnvGuard::set_raw("BRIDGE_STATE_DIR", "   ");

        let resolved = parse_absolute_dir_env("BRIDGE_STATE_DIR", temp.path().join("fallback"))
            .expect("fallback state dir");
        assert_eq!(
            resolved,
            temp.path()
                .join("fallback")
                .canonicalize()
                .expect("canonical")
        );
    }

    #[test]
    fn a_relative_directory_variable_is_rejected() {
        let temp = TestDir::new();
        let _guard = DirEnvGuard::set_raw("BRIDGE_STATE_DIR", "relative/state");

        let error = parse_absolute_dir_env("BRIDGE_STATE_DIR", temp.path().to_path_buf())
            .expect_err("relative paths must be rejected");
        assert!(error.contains("must be an absolute path"), "{error}");
    }

    #[test]
    fn a_directory_variable_that_cannot_be_created_is_reported() {
        let temp = TestDir::new();
        let blocking_file = temp.path().join("blocked");
        std::fs::write(&blocking_file, b"file").expect("write blocking file");
        let _guard = DirEnvGuard::set("BRIDGE_STATE_DIR", &blocking_file.join("child"));

        let error = parse_absolute_dir_env("BRIDGE_STATE_DIR", temp.path().to_path_buf())
            .expect_err("a file cannot host a directory");
        assert!(error.contains("could not be created"), "{error}");
    }

    fn no_auth_config(host: &str) -> BridgeConfig {
        BridgeConfig {
            transport_mode: TransportMode::PrivateBearer,
            host: host.to_string(),
            port: 8787,
            preview_host: "127.0.0.1".to_string(),
            preview_port: 8788,
            connect_url: None,
            preview_connect_url: None,
            workdir: PathBuf::from("/tmp/workdir"),
            state_dir: PathBuf::from("/tmp/workdir/.dappercode"),
            attachments_dir: PathBuf::from("/tmp/workdir/.dappercode-attachments"),
            acp_manifest_path: PathBuf::from("/tmp/workdir/.dappercode/agents.json"),
            acp_approved_executable_roots: vec![PathBuf::from("/bin")],
            acp_initialize_timeout: Duration::from_secs(15),
            auth_token: None,
            auth_enabled: false,
            allow_insecure_no_auth: true,
            no_auth_allowed_origins: HashSet::new(),
            enforce_authenticated_origins: false,
            authenticated_allowed_origins: HashSet::new(),
            allow_query_token_auth: false,
            allow_outside_root_cwd: false,
            terminal_exec_policies: HashSet::new(),
            show_pairing_qr: false,
            ws_limits: WebSocketResourceLimits {
                max_frame_bytes: DEFAULT_WS_MAX_FRAME_BYTES,
                max_message_bytes: DEFAULT_WS_MAX_MESSAGE_BYTES,
                per_client_in_flight: DEFAULT_WS_PER_CLIENT_IN_FLIGHT,
                global_in_flight: DEFAULT_WS_GLOBAL_IN_FLIGHT,
            },
        }
    }

    fn headers_with_origin(origin: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(ORIGIN, origin.parse().expect("valid test header"));
        headers
    }

    fn private_bearer_validation(host: &str) -> TransportValidation<'_> {
        TransportValidation {
            transport_mode: TransportMode::PrivateBearer,
            network_mode: NetworkMode::Local,
            host,
            auth_token: Some("secret"),
            allow_insecure_no_auth: false,
            allow_query_token_auth: false,
            connect_url: None,
            preview_connect_url: None,
            pinned_tls_identity: None,
            pinned_tls_device_registry: None,
        }
    }

    fn pinned_transport_validation() -> TransportValidation<'static> {
        TransportValidation {
            transport_mode: TransportMode::TailnetPinnedTls,
            network_mode: NetworkMode::Tailscale,
            host: "100.64.0.1",
            auth_token: None,
            allow_insecure_no_auth: false,
            allow_query_token_auth: false,
            connect_url: Some("https://bridge.tailnet"),
            preview_connect_url: Some("https://preview.tailnet"),
            pinned_tls_identity: Some(std::path::Path::new("/tmp/bridge-identity")),
            pinned_tls_device_registry: Some(std::path::Path::new("/tmp/device-registry")),
        }
    }

    #[test]
    fn no_auth_listener_requires_literal_loopback_ip() {
        for host in ["127.0.0.1", "127.42.0.9", "::1"] {
            assert!(
                validate_no_auth_listener(host).is_ok(),
                "expected {host} to pass"
            );
        }
        for host in ["0.0.0.0", "::", "192.168.1.20", "10.0.0.4", "localhost"] {
            assert!(
                validate_no_auth_listener(host).is_err(),
                "expected {host} to fail"
            );
        }
    }

    #[test]
    fn no_auth_allows_originless_operator_and_native_clients() {
        assert!(no_auth_config("127.0.0.1").is_browser_origin_allowed(&HeaderMap::new()));
    }

    #[test]
    fn no_auth_allows_only_same_or_explicit_exact_browser_origins() {
        let mut config = no_auth_config("127.0.0.1");
        config
            .no_auth_allowed_origins
            .insert("https://trusted.example".to_string());

        assert!(config.is_browser_origin_allowed(&headers_with_origin("http://127.0.0.1:8787")));
        assert!(config.is_browser_origin_allowed(&headers_with_origin("https://trusted.example")));
        assert!(
            !config.is_browser_origin_allowed(&headers_with_origin("https://trusted.example:444"))
        );
        assert!(!config.is_browser_origin_allowed(&headers_with_origin("https://evil.example")));
        assert!(!config.is_browser_origin_allowed(&headers_with_origin("http://192.168.1.20:8787")));
        assert!(!config.is_browser_origin_allowed(&headers_with_origin("*")));
        assert!(!config.is_browser_origin_allowed(&headers_with_origin("null")));

        let mut malformed_origin = HeaderMap::new();
        malformed_origin.insert(
            ORIGIN,
            axum::http::HeaderValue::from_bytes(b"\xff").unwrap(),
        );
        assert!(!config.is_browser_origin_allowed(&malformed_origin));

        let mut duplicate_origins = headers_with_origin("http://127.0.0.1:8787");
        duplicate_origins.append(ORIGIN, "https://evil.example".parse().unwrap());
        assert!(!config.is_browser_origin_allowed(&duplicate_origins));
    }

    #[test]
    fn no_auth_recognizes_ipv6_listener_origin() {
        let config = no_auth_config("::1");
        assert!(config.is_browser_origin_allowed(&headers_with_origin("http://[::1]:8787")));
        assert!(!config.is_browser_origin_allowed(&headers_with_origin("http://127.0.0.1:8787")));
    }

    #[test]
    fn configured_origins_reject_wildcards_null_and_non_origins() {
        assert_eq!(
            normalize_browser_origin("https://trusted.example/"),
            Some("https://trusted.example".to_string())
        );
        for origin in [
            "*",
            "null",
            "https://*.example.com",
            "https:example.com",
            r"https:\example.com",
            "https://user@example.com",
            "https://:secret@example.com",
            "https://example.com/path",
            "https://trusted.example/path/..",
            "https://example.com?query=1",
            "https://example .com",
            "http://",
            "file:///tmp/index.html",
        ] {
            assert!(
                normalize_browser_origin(origin).is_none(),
                "expected {origin} to fail"
            );
        }
    }

    #[test]
    fn authenticated_mode_does_not_apply_no_auth_origin_policy() {
        let mut config = no_auth_config("127.0.0.1");
        config.auth_enabled = true;
        config.auth_token = Some("secret".to_string());
        assert!(config.is_browser_origin_allowed(&headers_with_origin("https://evil.example")));
    }

    #[test]
    fn authenticated_origin_enforcement_uses_only_exact_compatibility_origins() {
        let mut config = no_auth_config("127.0.0.1");
        config.auth_enabled = true;
        config.auth_token = Some("secret".to_string());
        config.enforce_authenticated_origins = true;
        config
            .authenticated_allowed_origins
            .insert("https://trusted.example".to_string());

        assert!(config.is_browser_origin_allowed(&HeaderMap::new()));
        assert!(config.is_browser_origin_allowed(&headers_with_origin("https://trusted.example")));
        for origin in [
            "http://127.0.0.1:8787",
            "https://evil.example",
            "https://trusted.example:444",
            "*",
            "null",
        ] {
            assert!(
                !config.is_browser_origin_allowed(&headers_with_origin(origin)),
                "accepted {origin}"
            );
        }

        let mut duplicate = headers_with_origin("https://trusted.example");
        duplicate.append(ORIGIN, "https://trusted.example".parse().unwrap());
        assert!(!config.is_browser_origin_allowed(&duplicate));

        let mut malformed = HeaderMap::new();
        malformed.insert(
            ORIGIN,
            axum::http::HeaderValue::from_bytes(b"\xff").unwrap(),
        );
        assert!(!config.is_browser_origin_allowed(&malformed));
    }

    #[test]
    fn pinned_origin_policy_is_mandatory_even_without_the_migration_flag() {
        let mut config = no_auth_config("127.0.0.1");
        config.transport_mode = TransportMode::TailnetPinnedTls;
        config.enforce_authenticated_origins = false;
        config
            .authenticated_allowed_origins
            .insert("https://trusted.example".to_string());

        assert!(config.is_browser_origin_allowed(&HeaderMap::new()));
        assert!(config.is_browser_origin_allowed(&headers_with_origin("https://trusted.example")));
        assert!(!config.is_browser_origin_allowed(&headers_with_origin("https://evil.example")));
    }

    #[test]
    fn pinned_transport_validation_rejects_each_unsafe_or_incomplete_configuration() {
        let validate = |input| {
            validate_transport_configuration(input)
                .expect_err("tailnetPinnedTls must remain unavailable in Stage 0")
        };

        let mut input = pinned_transport_validation();
        input.network_mode = NetworkMode::Local;
        assert!(validate(input).contains("BRIDGE_NETWORK_MODE=tailscale"));

        let mut input = pinned_transport_validation();
        input.auth_token = Some("legacy-token");
        assert!(validate(input).contains("rejects BRIDGE_AUTH_TOKEN"));

        let mut input = pinned_transport_validation();
        input.allow_query_token_auth = true;
        assert!(validate(input).contains("BRIDGE_ALLOW_QUERY_TOKEN_AUTH"));

        let mut input = pinned_transport_validation();
        input.allow_insecure_no_auth = true;
        assert!(validate(input).contains("BRIDGE_ALLOW_INSECURE_NO_AUTH"));

        for connect_url in [
            None,
            Some("http://bridge.tailnet"),
            Some("HTTPS://bridge.tailnet"),
        ] {
            let mut input = pinned_transport_validation();
            input.connect_url = connect_url;
            assert!(validate(input).contains("BRIDGE_CONNECT_URL"));
        }

        for preview_url in [
            None,
            Some("http://preview.tailnet"),
            Some("HTTPS://preview.tailnet"),
        ] {
            let mut input = pinned_transport_validation();
            input.preview_connect_url = preview_url;
            assert!(validate(input).contains("BRIDGE_PREVIEW_CONNECT_URL"));
        }

        let mut input = pinned_transport_validation();
        input.pinned_tls_identity = None;
        assert!(validate(input).contains("BRIDGE_PINNED_TLS_IDENTITY"));

        let mut input = pinned_transport_validation();
        input.pinned_tls_device_registry = None;
        assert!(validate(input).contains("BRIDGE_PINNED_TLS_DEVICE_REGISTRY"));

        assert!(validate(pinned_transport_validation()).contains("not yet available"));
    }

    #[test]
    fn private_bearer_validation_preserves_authenticated_and_loopback_development_modes() {
        let mut input = private_bearer_validation("192.168.1.20");
        input.allow_query_token_auth = true;
        assert!(validate_transport_configuration(input).is_ok());

        let mut input = private_bearer_validation("127.0.0.1");
        input.auth_token = None;
        assert!(validate_transport_configuration(input).is_err());

        input.allow_insecure_no_auth = true;
        assert!(validate_transport_configuration(input).is_ok());

        input.host = "0.0.0.0";
        assert!(validate_transport_configuration(input).is_err());
    }

    #[test]
    fn legacy_private_bearer_environment_uses_safe_canonical_defaults() {
        let _restore = RestoreEnv::cleared(CONFIG_ENV_NAMES);
        let temp = TestDir::new();
        unsafe {
            env::set_var("BRIDGE_WORKDIR", temp.path());
            env::set_var("BRIDGE_AUTH_TOKEN", " legacy-secret ");
        }

        let config = BridgeConfig::from_env().expect("legacy environment should migrate");
        assert_eq!(config.transport_mode, TransportMode::PrivateBearer);
        assert_eq!(config.transport_mode.as_str(), "privateBearer");
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 8787);
        assert_eq!(config.preview_host, "127.0.0.1");
        assert_eq!(config.preview_port, 8788);
        assert_eq!(config.auth_token.as_deref(), Some("legacy-secret"));
        assert!(config.auth_enabled);
        assert!(!config.allow_insecure_no_auth);
        assert!(!config.allow_query_token_auth);
        assert!(!config.enforce_authenticated_origins);
        assert!(config.no_auth_allowed_origins.is_empty());
        assert!(config.authenticated_allowed_origins.is_empty());
        assert!(config.allow_outside_root_cwd);
        assert!(config.show_pairing_qr);
        assert_eq!(
            config.acp_manifest_path,
            config.workdir.join(".dappercode/agents.json")
        );
        assert_eq!(
            config.acp_approved_executable_roots,
            vec![config.workdir.join(".dappercode/agents")]
        );
        assert_eq!(config.acp_initialize_timeout, Duration::from_millis(15_000));
        assert_eq!(
            config.attachments_dir,
            config
                .workdir
                .join(crate::attachments::DEFAULT_ATTACHMENTS_DIR_NAME)
        );
        assert_eq!(config.ws_limits.max_frame_bytes, DEFAULT_WS_MAX_FRAME_BYTES);
        assert_eq!(
            config.ws_limits.max_message_bytes,
            DEFAULT_WS_MAX_MESSAGE_BYTES
        );
        assert_eq!(
            config.ws_limits.per_client_in_flight,
            DEFAULT_WS_PER_CLIENT_IN_FLIGHT
        );
        assert_eq!(
            config.ws_limits.global_in_flight,
            DEFAULT_WS_GLOBAL_IN_FLIGHT
        );
    }

    #[test]
    fn pinned_environment_rejects_every_legacy_or_incomplete_input() {
        let _restore = RestoreEnv::cleared(CONFIG_ENV_NAMES);
        let temp = TestDir::new();
        let configure_valid_shape = || unsafe {
            env::set_var("BRIDGE_TRANSPORT_MODE", "tailnetPinnedTls");
            env::set_var("BRIDGE_NETWORK_MODE", "tailscale");
            env::set_var("BRIDGE_WORKDIR", temp.path());
            env::set_var("BRIDGE_CONNECT_URL", "https://bridge.tailnet");
            env::set_var("BRIDGE_PREVIEW_CONNECT_URL", "https://preview.tailnet");
            env::set_var("BRIDGE_PINNED_TLS_IDENTITY", "/tmp/identity");
            env::set_var("BRIDGE_PINNED_TLS_DEVICE_REGISTRY", "/tmp/registry");
        };
        let error = || match BridgeConfig::from_env() {
            Ok(_) => panic!("pinned mode must fail closed"),
            Err(error) => error,
        };

        configure_valid_shape();
        assert_eq!(TransportMode::TailnetPinnedTls.as_str(), "tailnetPinnedTls");
        assert!(error().contains("not yet available"));

        unsafe { env::set_var("BRIDGE_NETWORK_MODE", "local") };
        assert!(error().contains("BRIDGE_NETWORK_MODE=tailscale"));
        configure_valid_shape();

        unsafe { env::set_var("BRIDGE_AUTH_TOKEN", "legacy-secret") };
        assert!(error().contains("rejects BRIDGE_AUTH_TOKEN"));
        unsafe { env::remove_var("BRIDGE_AUTH_TOKEN") };

        unsafe { env::set_var("BRIDGE_ALLOW_QUERY_TOKEN_AUTH", "true") };
        assert!(error().contains("BRIDGE_ALLOW_QUERY_TOKEN_AUTH"));
        unsafe { env::remove_var("BRIDGE_ALLOW_QUERY_TOKEN_AUTH") };

        unsafe { env::set_var("BRIDGE_ALLOW_INSECURE_NO_AUTH", "true") };
        assert!(error().contains("BRIDGE_ALLOW_INSECURE_NO_AUTH"));
        unsafe { env::remove_var("BRIDGE_ALLOW_INSECURE_NO_AUTH") };

        unsafe { env::remove_var("BRIDGE_CONNECT_URL") };
        assert!(error().contains("BRIDGE_CONNECT_URL"));
        unsafe { env::set_var("BRIDGE_CONNECT_URL", "https://bridge.tailnet") };

        unsafe { env::remove_var("BRIDGE_PREVIEW_CONNECT_URL") };
        assert!(error().contains("BRIDGE_PREVIEW_CONNECT_URL"));
        unsafe { env::set_var("BRIDGE_PREVIEW_CONNECT_URL", "https://preview.tailnet") };

        unsafe { env::remove_var("BRIDGE_PINNED_TLS_IDENTITY") };
        assert!(error().contains("BRIDGE_PINNED_TLS_IDENTITY"));
        unsafe { env::set_var("BRIDGE_PINNED_TLS_IDENTITY", "relative/identity") };
        assert!(error().contains("must be an absolute path"));
        unsafe { env::set_var("BRIDGE_PINNED_TLS_IDENTITY", "/tmp/identity") };

        unsafe { env::remove_var("BRIDGE_PINNED_TLS_DEVICE_REGISTRY") };
        assert!(error().contains("BRIDGE_PINNED_TLS_DEVICE_REGISTRY"));
        unsafe { env::set_var("BRIDGE_PINNED_TLS_DEVICE_REGISTRY", "relative/registry") };
        assert!(error().contains("must be an absolute path"));
    }

    #[test]
    fn authenticated_origin_enforcement_rejects_unlisted_and_duplicate_origins() {
        let mut config = no_auth_config("127.0.0.1");
        config.auth_enabled = true;
        config.auth_token = Some("secret".to_string());
        config.enforce_authenticated_origins = true;

        assert!(config.is_browser_origin_allowed(&HeaderMap::new()));
        assert!(!config.is_browser_origin_allowed(&headers_with_origin("https://app.example")));

        config
            .authenticated_allowed_origins
            .insert("https://app.example".to_string());
        assert!(config.is_browser_origin_allowed(&headers_with_origin("https://app.example")));
        assert!(!config.is_browser_origin_allowed(&headers_with_origin("https://app.example/path")));

        let mut duplicate = headers_with_origin("https://app.example");
        duplicate.append(ORIGIN, "https://app.example".parse().unwrap());
        assert!(!config.is_browser_origin_allowed(&duplicate));
    }

    #[test]
    fn terminal_policy_parser_is_explicit_and_deny_by_default() {
        assert!(parse_terminal_exec_policies("").unwrap().is_empty());
        assert_eq!(
            parse_terminal_exec_policies(" pwd, cat ").unwrap(),
            HashSet::from([TerminalExecPolicy::Pwd, TerminalExecPolicy::Read])
        );
        assert!(parse_terminal_exec_policies("git").is_err());
    }

    #[test]
    fn authorization_covers_bearer_and_query_token_variants() {
        let mut config = no_auth_config("127.0.0.1");
        assert!(config.is_authorized(&HeaderMap::new(), None));

        config.auth_enabled = true;
        assert!(!config.is_authorized(&HeaderMap::new(), None));
        config.auth_token = Some("secret".to_string());

        for raw in [
            "Basic secret",
            "Bearer",
            "Bearer secret extra",
            "Bearer wrong",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", raw.parse().unwrap());
            assert!(!config.is_authorized(&headers, None), "accepted {raw}");
        }

        let mut headers = HeaderMap::new();
        headers.insert("authorization", "bEaReR secret".parse().unwrap());
        assert!(config.is_authorized(&headers, None));

        config.allow_query_token_auth = true;
        assert!(!config.is_authorized(&HeaderMap::new(), Some("   ")));
        assert!(!config.is_authorized(&HeaderMap::new(), Some("wrong")));
        assert!(config.is_authorized(&HeaderMap::new(), Some(" secret ")));
    }

    #[test]
    fn connect_url_normalization_rejects_unsafe_values_and_strips_suffixes() {
        assert_eq!(normalize_connect_url("   "), None);
        assert_eq!(normalize_connect_url("not a url"), None);
        assert_eq!(normalize_connect_url("ftp://example.com"), None);
        assert_eq!(normalize_connect_url("https://user@example.com"), None);
        assert_eq!(normalize_connect_url("https://:secret@example.com"), None);
        assert_eq!(
            normalize_connect_url("https://example.com/"),
            Some("https://example.com".into())
        );
        assert_eq!(
            normalize_connect_url(" https://example.com/base///?query=1#fragment "),
            Some("https://example.com/base".into())
        );
    }

    #[test]
    fn executable_root_environment_rejects_empty_and_relative_lists() {
        let _restore = RestoreEnv::cleared(&["ACP_AGENT_ROOTS"]);
        unsafe { env::set_var("ACP_AGENT_ROOTS", "") };
        assert!(parse_path_list_env("ACP_AGENT_ROOTS", &[]).is_err());
        unsafe { env::set_var("ACP_AGENT_ROOTS", "relative/path") };
        assert!(parse_path_list_env("ACP_AGENT_ROOTS", &[]).is_err());
    }

    #[test]
    fn websocket_limits_validate_both_relationships() {
        assert!(WebSocketResourceLimits {
            max_frame_bytes: 2,
            max_message_bytes: 1,
            per_client_in_flight: 1,
            global_in_flight: 1,
        }
        .validate()
        .is_err());
        assert!(WebSocketResourceLimits {
            max_frame_bytes: 1,
            max_message_bytes: 1,
            per_client_in_flight: 2,
            global_in_flight: 1,
        }
        .validate()
        .is_err());
        assert!(WebSocketResourceLimits {
            max_frame_bytes: 1,
            max_message_bytes: 1,
            per_client_in_flight: 1,
            global_in_flight: 1,
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn environment_parsers_cover_missing_valid_and_invalid_values() {
        let suffix = uuid::Uuid::new_v4();
        let bool_name = format!("DAPPERCODE_TEST_BOOL_{suffix}");
        let default_bool_name = format!("DAPPERCODE_TEST_DEFAULT_BOOL_{suffix}");
        let usize_name = format!("DAPPERCODE_TEST_USIZE_{suffix}");
        let url_name = format!("DAPPERCODE_TEST_URL_{suffix}");
        let origin_name = format!("DAPPERCODE_TEST_ORIGIN_{suffix}");

        assert!(!parse_bool_env(&bool_name).unwrap());
        unsafe { env::set_var(&bool_name, " TRUE ") };
        assert!(parse_bool_env(&bool_name).unwrap());
        unsafe { env::set_var(&bool_name, "false") };
        assert!(!parse_bool_env(&bool_name).unwrap());
        unsafe { env::set_var(&bool_name, "tru") };
        assert_eq!(
            parse_bool_env(&bool_name).unwrap_err(),
            format!("{bool_name} must be true or false")
        );

        assert!(parse_bool_env_with_default(&default_bool_name, true).unwrap());
        unsafe { env::set_var(&default_bool_name, "true") };
        assert!(parse_bool_env_with_default(&default_bool_name, false).unwrap());
        unsafe { env::set_var(&default_bool_name, "false") };
        assert!(!parse_bool_env_with_default(&default_bool_name, true).unwrap());
        unsafe { env::set_var(&default_bool_name, "invalid") };
        assert_eq!(
            parse_bool_env_with_default(&default_bool_name, true).unwrap_err(),
            format!("{default_bool_name} must be true or false")
        );

        assert_eq!(parse_positive_usize_env(&usize_name, 7).unwrap(), 7);
        unsafe { env::set_var(&usize_name, "9") };
        assert_eq!(parse_positive_usize_env(&usize_name, 7).unwrap(), 9);
        unsafe { env::set_var(&usize_name, "0") };
        assert!(parse_positive_usize_env(&usize_name, 7).is_err());
        unsafe { env::set_var(&usize_name, "invalid") };
        assert!(parse_positive_usize_env(&usize_name, 7).is_err());

        assert_eq!(parse_connect_url_env(&url_name).unwrap(), None);
        unsafe { env::set_var(&url_name, "  ") };
        assert_eq!(parse_connect_url_env(&url_name).unwrap(), None);
        unsafe { env::set_var(&url_name, "https://example.com/path/") };
        assert_eq!(
            parse_connect_url_env(&url_name).unwrap(),
            Some("https://example.com/path".into())
        );
        unsafe { env::set_var(&url_name, "ftp://example.com") };
        assert!(parse_connect_url_env(&url_name).is_err());

        assert!(parse_origin_csv_env(&origin_name).unwrap().is_empty());
        unsafe { env::set_var(&origin_name, "https://one.example, https://two.example") };
        assert_eq!(parse_origin_csv_env(&origin_name).unwrap().len(), 2);
        unsafe { env::set_var(&origin_name, "https://example.com/path") };
        assert!(parse_origin_csv_env(&origin_name).is_err());

        for name in [
            bool_name,
            default_bool_name,
            usize_name,
            url_name,
            origin_name,
        ] {
            unsafe { env::remove_var(name) };
        }
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_transport_and_network_modes_fail_closed() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};

        let invalid = OsString::from_vec(vec![0xff]);
        unsafe { env::set_var("BRIDGE_TRANSPORT_MODE", &invalid) };
        assert_eq!(
            TransportMode::from_env().unwrap_err(),
            "BRIDGE_TRANSPORT_MODE must be valid UTF-8"
        );
        unsafe { env::remove_var("BRIDGE_TRANSPORT_MODE") };

        unsafe { env::set_var("BRIDGE_NETWORK_MODE", invalid) };
        assert_eq!(
            NetworkMode::from_env().unwrap_err(),
            "BRIDGE_NETWORK_MODE must be valid UTF-8"
        );
        unsafe { env::remove_var("BRIDGE_NETWORK_MODE") };
    }

    #[test]
    fn bridge_config_loads_a_fully_configured_environment() {
        let _restore = RestoreEnv::cleared(CONFIG_ENV_NAMES);
        let root = std::env::temp_dir().join(format!("dappercode-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let values = [
            ("BRIDGE_TRANSPORT_MODE", "privateBearer"),
            ("BRIDGE_NETWORK_MODE", "local"),
            ("BRIDGE_HOST", "127.0.0.1"),
            ("BRIDGE_PORT", "9000"),
            ("BRIDGE_PREVIEW_HOST", "127.0.0.1"),
            ("BRIDGE_PREVIEW_PORT", "9001"),
            ("BRIDGE_CONNECT_URL", "https://bridge.example/base/"),
            ("BRIDGE_PREVIEW_CONNECT_URL", "https://preview.example/"),
            ("BRIDGE_WORKDIR", root.to_str().unwrap()),
            ("ACP_AGENT_MANIFEST", "/tmp/agents.json"),
            ("ACP_AGENT_ROOTS", "/bin:/usr/bin"),
            ("ACP_INITIALIZE_TIMEOUT_MS", "2500"),
            ("BRIDGE_AUTH_TOKEN", "secret"),
            ("BRIDGE_ALLOW_INSECURE_NO_AUTH", "false"),
            ("BRIDGE_NO_AUTH_ALLOWED_ORIGINS", "https://trusted.example"),
            ("BRIDGE_ENFORCE_AUTHENTICATED_ORIGINS", "true"),
            (
                "BRIDGE_AUTHENTICATED_ALLOWED_ORIGINS",
                "https://app.example",
            ),
            ("BRIDGE_ALLOW_QUERY_TOKEN_AUTH", "true"),
            ("BRIDGE_PINNED_TLS_IDENTITY", "/tmp/identity"),
            ("BRIDGE_PINNED_TLS_DEVICE_REGISTRY", "/tmp/registry"),
            ("BRIDGE_ALLOW_OUTSIDE_ROOT_CWD", "false"),
            ("BRIDGE_SHOW_PAIRING_QR", "false"),
            ("BRIDGE_WS_MAX_FRAME_BYTES", "1024"),
            ("BRIDGE_WS_MAX_MESSAGE_BYTES", "2048"),
            ("BRIDGE_WS_PER_CLIENT_IN_FLIGHT", "2"),
            ("BRIDGE_WS_GLOBAL_IN_FLIGHT", "4"),
            ("BRIDGE_TERMINAL_EXEC_POLICIES", "pwd,ls,cat"),
        ];
        for (name, value) in values {
            unsafe { env::set_var(name, value) };
        }

        let config = BridgeConfig::from_env().unwrap();
        assert_eq!(config.transport_mode, TransportMode::PrivateBearer);
        assert_eq!(config.port, 9000);
        assert_eq!(config.preview_port, 9001);
        assert_eq!(
            config.connect_url.as_deref(),
            Some("https://bridge.example/base")
        );
        assert_eq!(config.acp_manifest_path, PathBuf::from("/tmp/agents.json"));
        assert_eq!(config.acp_approved_executable_roots.len(), 2);
        assert_eq!(config.acp_initialize_timeout, Duration::from_millis(2500));
        assert!(config.auth_enabled);
        assert!(config.enforce_authenticated_origins);
        assert!(config
            .authenticated_allowed_origins
            .contains("https://app.example"));
        assert!(config.allow_query_token_auth);
        assert!(!config.allow_outside_root_cwd);
        assert_eq!(config.ws_limits.global_in_flight, 4);
        assert_eq!(config.terminal_exec_policies.len(), 3);

        unsafe { env::remove_var("BRIDGE_TRANSPORT_MODE") };
        assert_eq!(
            BridgeConfig::from_env().unwrap().transport_mode,
            TransportMode::PrivateBearer
        );
        unsafe { env::set_var("BRIDGE_TRANSPORT_MODE", "unsupported") };
        let error = match BridgeConfig::from_env() {
            Ok(_) => panic!("unsupported transport mode was accepted"),
            Err(error) => error,
        };
        assert!(error.contains("privateBearer or tailnetPinnedTls"));
        unsafe { env::set_var("BRIDGE_TRANSPORT_MODE", "privateBearer") };

        unsafe { env::set_var("BRIDGE_PREVIEW_PORT", "9000") };
        assert!(BridgeConfig::from_env().is_err());
        unsafe {
            env::set_var("BRIDGE_PREVIEW_PORT", "9001");
        }
        assert!(BridgeConfig::from_env().is_ok());

        unsafe {
            env::remove_var("BRIDGE_AUTH_TOKEN");
            env::set_var("BRIDGE_ALLOW_INSECURE_NO_AUTH", "false");
        }
        assert!(BridgeConfig::from_env().is_err());
        unsafe {
            env::set_var("BRIDGE_ALLOW_INSECURE_NO_AUTH", "true");
            env::set_var("BRIDGE_HOST", "0.0.0.0");
        }
        assert!(BridgeConfig::from_env().is_err());
        unsafe { env::set_var("BRIDGE_HOST", "127.0.0.1") };
        assert!(!BridgeConfig::from_env().unwrap().auth_enabled);

        assert_eq!(normalize_connect_url("https://user:pass@example.com"), None);
        assert_eq!(normalize_connect_url("https://:pass@example.com"), None);
        assert_eq!(normalize_browser_origin(""), None);
        assert_eq!(
            normalize_browser_origin("https://user:pass@example.com"),
            None
        );
        assert_eq!(
            normalize_browser_origin("https://example.com/#fragment"),
            None
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
