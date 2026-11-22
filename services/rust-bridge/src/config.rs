#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
use crate::phone_call::sip::SipTransportKind;
use crate::phone_call::voice::{
    VoicePipelineConfig, DEFAULT_LLM_MODEL, DEFAULT_OLLAMA_OPENAI_BASE_URL, DEFAULT_STT_MODEL,
    DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE,
};
use axum::http::header::ORIGIN;
use axum::http::HeaderMap;
use dappercode_bridge_core::protocol_constants::DEFAULT_ATTACHMENTS_DIR_NAME;
use dappercode_bridge_path_policy::PathPolicy;
use reqwest::Url;
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::time::Duration;
use std::{env, fmt};

fn config_env(name: &str) -> Result<String, env::VarError> {
    #[cfg(test)]
    {
        tests::config_env_for_test(name)
    }
    #[cfg(not(test))]
    {
        env::var(name)
    }
}

pub(crate) const DEFAULT_WS_MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const DEFAULT_WS_MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const DEFAULT_WS_PER_CLIENT_IN_FLIGHT: usize = 16;
pub(crate) const DEFAULT_WS_GLOBAL_IN_FLIGHT: usize = 128;

#[derive(Clone)]
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
pub(crate) struct BridgeConfig {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) preview_host: String,
    pub(crate) preview_port: u16,
    pub(crate) preview_enabled: bool,
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
    pub(crate) allow_query_token_auth: bool,
    pub(crate) allow_outside_root_cwd: bool,
    pub(crate) show_pairing_qr: bool,
    pub(crate) ws_limits: WebSocketResourceLimits,
    pub(crate) phone_call: Option<PhoneCallRuntimeConfig>,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct PhoneCallRuntimeConfig {
    pub(crate) server_host: String,
    pub(crate) server_port: u16,
    pub(crate) transport: SipTransportKind,
    pub(crate) sip_username: String,
    pub(crate) sip_password: String,
    pub(crate) caller_id: String,
    pub(crate) user_display_name: String,
    pub(crate) voice: VoicePipelineConfig,
}

impl fmt::Debug for PhoneCallRuntimeConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PhoneCallRuntimeConfig")
            .field("server_host", &self.server_host)
            .field("server_port", &self.server_port)
            .field("transport", &self.transport)
            .field("sip_username", &self.sip_username)
            .field("sip_password", &"[REDACTED]")
            .field("caller_id", &self.caller_id)
            .field("user_display_name", &self.user_display_name)
            .field("voice", &self.voice)
            .finish()
    }
}

#[derive(Debug, Clone)]
pub(crate) struct WebSocketResourceLimits {
    pub(crate) max_frame_bytes: usize,
    pub(crate) max_message_bytes: usize,
    pub(crate) per_client_in_flight: usize,
    pub(crate) global_in_flight: usize,
}

impl BridgeConfig {
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(crate) fn from_env() -> Result<Self, String> {
        let host = config_env("BRIDGE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = config_env("BRIDGE_PORT")
            .ok()
            .map(|v| v.parse::<u16>())
            .and_then(Result::ok)
            .unwrap_or(8787);
        let preview_host =
            config_env("BRIDGE_PREVIEW_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let preview_port = config_env("BRIDGE_PREVIEW_PORT")
            .ok()
            .map(|v| v.parse::<u16>())
            .and_then(Result::ok)
            .unwrap_or_else(|| port.checked_add(1).unwrap_or(8788));
        let preview_enabled = !parse_bool_env("BRIDGE_DISABLE_BROWSER_PREVIEW");
        if preview_enabled && preview_port == port {
            return Err("BRIDGE_PREVIEW_PORT must differ from BRIDGE_PORT".to_string());
        }
        let connect_url = parse_connect_url_env("BRIDGE_CONNECT_URL")?;
        let preview_connect_url = parse_connect_url_env("BRIDGE_PREVIEW_CONNECT_URL")?;

        let configured_workdir = config_env("BRIDGE_WORKDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let workdir = resolve_bridge_workdir(configured_workdir)?;

        // The desktop app points these at its central data directory so nothing app-owned lands in
        // a repository. The development flow keeps working through the workdir-relative defaults.
        let state_dir = parse_absolute_dir_env("BRIDGE_STATE_DIR", workdir.join(".dappercode"))?;
        let attachments_dir = parse_unresolved_absolute_dir_env(
            "BRIDGE_ATTACHMENTS_DIR",
            workdir.join(DEFAULT_ATTACHMENTS_DIR_NAME),
        )?;

        let acp_manifest_path = config_env("ACP_AGENT_MANIFEST")
            .map(PathBuf::from)
            .unwrap_or_else(|_| workdir.join(".dappercode/agents.json"));
        let acp_approved_executable_roots =
            parse_path_list_env("ACP_AGENT_ROOTS", &[workdir.join(".dappercode/agents")])?;
        let acp_initialize_timeout =
            Duration::from_millis(parse_positive_u64_env("ACP_INITIALIZE_TIMEOUT_MS", 15_000)?);
        let auth_token = config_env("BRIDGE_AUTH_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let allow_insecure_no_auth = parse_bool_env("BRIDGE_ALLOW_INSECURE_NO_AUTH");
        if auth_token.is_none() && !allow_insecure_no_auth {
            return Err(
                "BRIDGE_AUTH_TOKEN is required. Set BRIDGE_ALLOW_INSECURE_NO_AUTH=true only for local development."
                    .to_string(),
            );
        }
        if auth_token.is_none() {
            validate_no_auth_listener(&host)?;
        }

        let auth_enabled = auth_token.is_some();
        let no_auth_allowed_origins = parse_origin_csv_env("BRIDGE_NO_AUTH_ALLOWED_ORIGINS")?;
        let allow_query_token_auth = parse_bool_env("BRIDGE_ALLOW_QUERY_TOKEN_AUTH");
        let allow_outside_root_cwd =
            parse_bool_env_with_default("BRIDGE_ALLOW_OUTSIDE_ROOT_CWD", true);
        let show_pairing_qr = parse_bool_env_with_default("BRIDGE_SHOW_PAIRING_QR", true);
        let ws_limits = WebSocketResourceLimits::from_env()?;
        let phone_call = PhoneCallRuntimeConfig::from_env()?;

        Ok(Self {
            host,
            port,
            preview_host,
            preview_port,
            preview_enabled,
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
            allow_query_token_auth,
            allow_outside_root_cwd,
            show_pairing_qr,
            ws_limits,
            phone_call,
        })
    }

    pub(crate) fn is_authorized(&self, headers: &HeaderMap, query_token: Option<&str>) -> bool {
        if !self.auth_enabled {
            return true;
        }

        self.is_authorized_with_bridge_token(headers, query_token)
    }

    pub(crate) fn is_browser_origin_allowed(&self, headers: &HeaderMap) -> bool {
        if self.auth_enabled {
            return true;
        }

        let mut origins = headers.get_all(ORIGIN).iter();
        let Some(raw_origin) = origins.next() else {
            return true;
        };
        if origins.next().is_some() {
            return false;
        }
        let Ok(raw_origin) = raw_origin.to_str() else {
            return false;
        };
        let Some(origin) = normalize_browser_origin(raw_origin) else {
            return false;
        };

        origin == listener_origin(&self.host, self.port)
            || self.no_auth_allowed_origins.contains(&origin)
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

const MAX_SIP_USERNAME_BYTES: usize = 256;
const MAX_SIP_PASSWORD_BYTES: usize = 4_096;
const MAX_USER_DISPLAY_NAME_BYTES: usize = 128;

impl PhoneCallRuntimeConfig {
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(crate) fn from_env() -> Result<Option<Self>, String> {
        let sip_server = read_optional_env_trimmed("PHONE_CALL_SIP_SERVER")?;
        let sip_transport = read_optional_env_trimmed("PHONE_CALL_SIP_TRANSPORT")?;
        let sip_username = read_optional_env_trimmed("PHONE_CALL_SIP_USERNAME")?;
        let sip_password = read_optional_env_raw("PHONE_CALL_SIP_PASSWORD")?;
        let caller_id = read_optional_env_trimmed("PHONE_CALL_CALLER_ID")?;

        let sip_unconfigured = sip_server.is_none()
            && sip_transport.is_none()
            && sip_username.is_none()
            && sip_password.is_none();
        if sip_unconfigured && caller_id.is_none() {
            return Ok(None);
        }

        let raw_server = sip_server.ok_or_else(|| {
            "PHONE_CALL_SIP_SERVER is required when phone call configuration is partially set"
                .to_string()
        })?;
        let (server_host, server_port) = parse_sip_server_host_port(&raw_server)?;

        let raw_caller_id = caller_id.ok_or_else(|| {
            "PHONE_CALL_CALLER_ID is required when phone call configuration is partially set"
                .to_string()
        })?;
        let caller_id = validate_e164_phone_number("PHONE_CALL_CALLER_ID", &raw_caller_id)?;

        let transport = match sip_transport.as_deref() {
            Some(raw) if raw.eq_ignore_ascii_case("udp") => SipTransportKind::Udp,
            Some(raw) if raw.eq_ignore_ascii_case("tls") => SipTransportKind::Tls,
            Some(other) => {
                return Err(format!(
                    "PHONE_CALL_SIP_TRANSPORT must be 'udp' or 'tls' (got '{other}')",
                ));
            }
            None => {
                if server_port == SipTransportKind::Tls.default_port() {
                    SipTransportKind::Tls
                } else {
                    SipTransportKind::Udp
                }
            }
        };

        let (sip_username, sip_password) = match (sip_username, sip_password) {
            (Some(username), Some(password)) => {
                if username.len() > MAX_SIP_USERNAME_BYTES || username.chars().any(char::is_control)
                {
                    return Err(format!(
                        "PHONE_CALL_SIP_USERNAME must be at most {MAX_SIP_USERNAME_BYTES} bytes and free of control characters",
                    ));
                }
                if password.trim().is_empty()
                    || password.len() > MAX_SIP_PASSWORD_BYTES
                    || password.contains(['\r', '\n', '\0'])
                {
                    return Err(format!(
                        "PHONE_CALL_SIP_PASSWORD must be non-empty, at most {MAX_SIP_PASSWORD_BYTES} bytes, and free of control characters",
                    ));
                }
                (username, password)
            }
            (None, None) => (String::new(), String::new()),
            (Some(_), None) => {
                return Err(
                    "PHONE_CALL_SIP_PASSWORD is required when PHONE_CALL_SIP_USERNAME is set"
                        .to_string(),
                );
            }
            (None, Some(_)) => {
                return Err(
                    "PHONE_CALL_SIP_USERNAME is required when PHONE_CALL_SIP_PASSWORD is set"
                        .to_string(),
                );
            }
        };

        let user_display_name =
            read_optional_env_trimmed("PHONE_CALL_USER_DISPLAY_NAME")?.unwrap_or_default();
        if user_display_name.len() > MAX_USER_DISPLAY_NAME_BYTES
            || user_display_name.chars().any(char::is_control)
        {
            return Err(format!(
                "PHONE_CALL_USER_DISPLAY_NAME must be at most {MAX_USER_DISPLAY_NAME_BYTES} bytes and free of control characters",
            ));
        }

        let voice = VoicePipelineConfig {
            stt_base_url: read_optional_env_trimmed("PHONE_CALL_STT_BASE_URL")?
                .unwrap_or_else(|| DEFAULT_OLLAMA_OPENAI_BASE_URL.to_string()),
            stt_model: read_optional_env_trimmed("PHONE_CALL_STT_MODEL")?
                .unwrap_or_else(|| DEFAULT_STT_MODEL.to_string()),
            llm_base_url: read_optional_env_trimmed("PHONE_CALL_LLM_BASE_URL")?
                .unwrap_or_else(|| DEFAULT_OLLAMA_OPENAI_BASE_URL.to_string()),
            llm_model: read_optional_env_trimmed("PHONE_CALL_LLM_MODEL")?
                .unwrap_or_else(|| DEFAULT_LLM_MODEL.to_string()),
            tts_base_url: read_optional_env_trimmed("PHONE_CALL_TTS_BASE_URL")?
                .unwrap_or_else(|| DEFAULT_OLLAMA_OPENAI_BASE_URL.to_string()),
            tts_model: read_optional_env_trimmed("PHONE_CALL_TTS_MODEL")?
                .unwrap_or_else(|| DEFAULT_TTS_MODEL.to_string()),
            tts_voice: read_optional_env_trimmed("PHONE_CALL_TTS_VOICE")?
                .unwrap_or_else(|| DEFAULT_TTS_VOICE.to_string()),
        };
        voice
            .validate()
            .map_err(|err| format!("invalid phone call voice configuration: {err}"))?;

        Ok(Some(Self {
            server_host,
            server_port,
            transport,
            sip_username,
            sip_password,
            caller_id,
            user_display_name,
            voice,
        }))
    }
}

pub(crate) fn validate_e164_phone_number(field: &str, raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let Some(digits) = trimmed.strip_prefix('+') else {
        return Err(format!("{field} must be in E.164 format starting with '+'"));
    };
    if !(7..=15).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!(
            "{field} must start with '+' followed by 7 to 15 ASCII digits",
        ));
    }
    Ok(trimmed.to_string())
}

fn read_optional_env_trimmed(name: &str) -> Result<Option<String>, String> {
    match config_env(name) {
        Ok(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(format!("{name} contains invalid UTF-8")),
    }
}

fn read_optional_env_raw(name: &str) -> Result<Option<String>, String> {
    match config_env(name) {
        Ok(raw) => {
            if raw.is_empty() {
                Ok(None)
            } else {
                Ok(Some(raw))
            }
        }
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(format!("{name} contains invalid UTF-8")),
    }
}

fn parse_sip_server_host_port(value: &str) -> Result<(String, u16), String> {
    if value.is_empty()
        || value.len() > 265
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("PHONE_CALL_SIP_SERVER must be a valid host:port".to_string());
    }
    let (host, port_str) = if let Some(rest) = value.strip_prefix('[') {
        let (ipv6_str, port_part) = rest
            .split_once("]:")
            .ok_or_else(|| "PHONE_CALL_SIP_SERVER IPv6 address must use [host]:port".to_string())?;
        ipv6_str
            .parse::<Ipv6Addr>()
            .map_err(|_| "PHONE_CALL_SIP_SERVER contains an invalid IPv6 address".to_string())?;
        (ipv6_str.to_string(), port_part)
    } else {
        let (host_part, port_part) = value
            .rsplit_once(':')
            .ok_or_else(|| "PHONE_CALL_SIP_SERVER must include a :port".to_string())?;
        let invalid_edges = host_part.is_empty()
            || host_part.starts_with('.')
            || host_part.starts_with('-')
            || host_part.ends_with('-');
        let invalid_chars = host_part.contains(':')
            || host_part.contains("..")
            || !host_part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'));
        if invalid_edges || invalid_chars {
            return Err("PHONE_CALL_SIP_SERVER contains an invalid host".to_string());
        }
        if host_part
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        {
            host_part.parse::<Ipv4Addr>().map_err(|_| {
                "PHONE_CALL_SIP_SERVER contains an invalid IPv4 address".to_string()
            })?;
        }
        (host_part.to_string(), port_part)
    };

    let port = port_str
        .parse::<u16>()
        .map_err(|_| "PHONE_CALL_SIP_SERVER port must be in 1..=65535".to_string())?;
    if port == 0 {
        return Err("PHONE_CALL_SIP_SERVER port must be non-zero".to_string());
    }
    Ok((host, port))
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
    PathPolicy::validate_workdir(raw_workdir)
}

/// Resolves a directory environment variable, creating it when absent.
///
/// The value must be absolute so that a bridge started from any working directory reaches the same
/// state, and so a relative path can never resolve into an unexpected part of the repository.
fn parse_absolute_dir_env(name: &str, default: PathBuf) -> Result<PathBuf, String> {
    let configured = match config_env(name) {
        Ok(raw) if !raw.trim().is_empty() => PathBuf::from(raw.trim()),
        _ => default,
    };
    if !configured.is_absolute() {
        return Err(format!(
            "{name} must be an absolute path (got: {})",
            configured.to_string_lossy(),
        ));
    }

    std::fs::create_dir_all(&configured).map_err(|error| {
        format!(
            "{name} could not be created ({}): {error}",
            configured.to_string_lossy(),
        )
    })?;
    std::fs::canonicalize(&configured).map_err(|error| {
        format!(
            "{name} is invalid or inaccessible ({}): {error}",
            configured.to_string_lossy(),
        )
    })
}

fn parse_unresolved_absolute_dir_env(name: &str, default: PathBuf) -> Result<PathBuf, String> {
    let configured = match config_env(name) {
        Ok(raw) if !raw.trim().is_empty() => PathBuf::from(raw.trim()),
        _ => default,
    };
    if !configured.is_absolute() {
        return Err(format!(
            "{name} must be an absolute path (got: {})",
            configured.to_string_lossy(),
        ));
    }
    Ok(configured)
}

pub(crate) fn parse_bool_env(name: &str) -> bool {
    config_env(name)
        .map(|value| value.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

pub(crate) fn parse_bool_env_with_default(name: &str, default: bool) -> bool {
    config_env(name)
        .map(|raw| {
            let value = raw.trim();
            if value.eq_ignore_ascii_case("true") {
                true
            } else if value.eq_ignore_ascii_case("false") {
                false
            } else {
                default
            }
        })
        .unwrap_or(default)
}

pub(crate) fn parse_positive_usize_env(name: &str, default: usize) -> Result<usize, String> {
    let Some(raw) = config_env(name).ok() else {
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
    let Some(raw) = config_env(name).ok() else {
        return Ok(default);
    };
    raw.trim()
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{name} must be a positive integer"))
}

fn parse_path_list_env(name: &str, defaults: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let paths = config_env(name)
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
    let Some(raw) = config_env(name)
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

fn parse_origin_csv_env(name: &str) -> Result<HashSet<String>, String> {
    let Some(raw) = config_env(name).ok() else {
        return Ok(HashSet::new());
    };

    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            normalize_browser_origin(entry).ok_or_else(|| {
                format!(
                    "{name} entries must be exact http:// or https:// origins without paths, credentials, queries, fragments, or wildcards: {entry}",
                )
            })
        })
        .collect()
}

fn normalize_browser_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") || trimmed.contains('*') {
        return None;
    }

    let parsed = Url::parse(trimmed).ok()?;
    let invalid_authority = !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some();
    let has_path_or_suffix = !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some();
    if invalid_authority || has_path_or_suffix {
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
#[path = "config_tests.rs"]
mod tests;
