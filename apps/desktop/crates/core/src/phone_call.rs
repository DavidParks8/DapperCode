use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::{
    config::{insert_env, BridgeRuntimeConfig},
    secrets::{SecretBackend, SecretStore},
    store::{AppPaths, ConfigSideEffects},
};

pub const DEFAULT_SIP_TRANSPORT: &str = "tls";
pub const DEFAULT_VOICE_BASE_URL: &str = "http://127.0.0.1:11434/v1";
pub const DEFAULT_VOICE_LLM_MODEL: &str = "gemma4:e4b";
pub const DEFAULT_VOICE_TTS_MODEL: &str = "phonon";
pub const DEFAULT_VOICE_TTS_VOICE: &str = "default";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhoneCallSettings {
    pub sip_server: String,
    #[serde(default = "default_sip_transport")]
    pub sip_transport: String,
    pub sip_username: String,
    pub caller_id: String,
    pub user_display_name: String,
    #[serde(default = "default_voice_base_url")]
    pub stt_base_url: String,
    #[serde(default = "default_voice_llm_model")]
    pub stt_model: String,
    #[serde(default = "default_voice_base_url")]
    pub llm_base_url: String,
    #[serde(default = "default_voice_llm_model")]
    pub llm_model: String,
    #[serde(default = "default_voice_base_url")]
    pub tts_base_url: String,
    #[serde(default = "default_voice_tts_model")]
    pub tts_model: String,
    #[serde(default = "default_voice_tts_voice")]
    pub tts_voice: String,
}

impl AppPaths {
    pub fn configure_phone_call(
        &self,
        secrets: &SecretStore,
        new_password: Option<&str>,
        mutate: impl FnOnce(Option<&PhoneCallSettings>) -> Result<PhoneCallSettings>,
    ) -> Result<(PhoneCallSettings, SecretBackend)> {
        let mut side_effects = PhoneCallSideEffects {
            paths: self,
            secrets,
            new_password,
            previous_password: None,
        };
        self.update_config_with_side_effects(
            |config| {
                let next = mutate(config.phone_call.as_ref())?;
                config.phone_call = Some(next.clone());
                Ok(next)
            },
            &mut side_effects,
        )
    }
}

impl BridgeRuntimeConfig {
    /// Reads settings and their secret under the same lease as `voice configure`.
    /// Missing credentials disable calling, not the rest of the bridge.
    pub fn apply_phone_call(&mut self, paths: &AppPaths, secrets: &SecretStore) -> Result<()> {
        let _lease = paths.acquire_config_lease()?;
        let Some(settings) = paths.load_config()?.phone_call else {
            return Ok(());
        };
        let Some((sip_password, _backend)) = secrets.load_sip_password(paths)? else {
            return Ok(());
        };
        settings.validate()?;
        let entries = [
            ("PHONE_CALL_SIP_SERVER", settings.sip_server.as_str()),
            ("PHONE_CALL_SIP_TRANSPORT", settings.sip_transport.as_str()),
            ("PHONE_CALL_SIP_USERNAME", settings.sip_username.as_str()),
            ("PHONE_CALL_SIP_PASSWORD", sip_password.as_str()),
            ("PHONE_CALL_CALLER_ID", settings.caller_id.as_str()),
            (
                "PHONE_CALL_USER_DISPLAY_NAME",
                settings.user_display_name.as_str(),
            ),
            ("PHONE_CALL_STT_BASE_URL", settings.stt_base_url.as_str()),
            ("PHONE_CALL_STT_MODEL", settings.stt_model.as_str()),
            ("PHONE_CALL_LLM_BASE_URL", settings.llm_base_url.as_str()),
            ("PHONE_CALL_LLM_MODEL", settings.llm_model.as_str()),
            ("PHONE_CALL_TTS_BASE_URL", settings.tts_base_url.as_str()),
            ("PHONE_CALL_TTS_MODEL", settings.tts_model.as_str()),
            ("PHONE_CALL_TTS_VOICE", settings.tts_voice.as_str()),
        ];
        for (key, value) in entries {
            insert_env(&mut self.values, key, value.to_string())?;
        }
        Ok(())
    }
}

struct PhoneCallSideEffects<'a> {
    paths: &'a AppPaths,
    secrets: &'a SecretStore,
    new_password: Option<&'a str>,
    previous_password: Option<Option<String>>,
}

impl ConfigSideEffects for PhoneCallSideEffects<'_> {
    type Output = SecretBackend;

    fn apply(&mut self) -> Result<Self::Output> {
        let existing = self.secrets.load_sip_password(self.paths)?;
        match self.new_password {
            Some(password) => {
                self.previous_password = Some(existing.map(|(value, _)| value));
                self.secrets.store_sip_password(self.paths, password)
            }
            None => existing
                .map(|(_, backend)| backend)
                .context("--sip-password-stdin is required when no SIP password is stored"),
        }
    }

    fn rollback(&mut self) -> Result<()> {
        let Some(previous) = self.previous_password.take() else {
            return Ok(());
        };
        match previous {
            Some(password) => self
                .secrets
                .store_sip_password(self.paths, &password)
                .map(|_| ()),
            None => self.secrets.delete_sip_password(self.paths),
        }
    }
}

impl PhoneCallSettings {
    pub fn validate(&self) -> Result<()> {
        validate_host_port(&self.sip_server)?;
        if !matches!(self.sip_transport.as_str(), "udp" | "tls") {
            bail!("sipTransport must be 'udp' or 'tls'");
        }
        validate_bounded_text("sipUsername", &self.sip_username, 256)?;
        validate_e164(&self.caller_id)?;
        validate_bounded_text("userDisplayName", &self.user_display_name, 128)?;
        validate_loopback_url("sttBaseUrl", &self.stt_base_url)?;
        validate_bounded_text("sttModel", &self.stt_model, 256)?;
        validate_loopback_url("llmBaseUrl", &self.llm_base_url)?;
        validate_bounded_text("llmModel", &self.llm_model, 256)?;
        validate_loopback_url("ttsBaseUrl", &self.tts_base_url)?;
        validate_bounded_text("ttsModel", &self.tts_model, 256)?;
        validate_bounded_text("ttsVoice", &self.tts_voice, 256)?;
        Ok(())
    }
}

fn validate_bounded_text(field: &str, value: &str, max_bytes: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        bail!(
            "{field} must be non-empty, at most {max_bytes} bytes, and free of control characters"
        );
    }
    Ok(())
}

fn validate_host_port(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 265
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        bail!("sipServer must be a valid host:port");
    }
    let port_str = if let Some(rest) = value.strip_prefix('[') {
        let (ipv6, port_part) = rest
            .split_once("]:")
            .context("sipServer IPv6 address must use [host]:port")?;
        ipv6.parse::<std::net::Ipv6Addr>()
            .context("sipServer contains an invalid IPv6 address")?;
        port_part
    } else {
        let (host, port_part) = value
            .rsplit_once(':')
            .context("sipServer must include a :port")?;
        if host.is_empty()
            || host.contains(':')
            || host.contains("..")
            || host.starts_with('.')
            || host.starts_with('-')
            || host.ends_with('-')
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
        {
            bail!("sipServer contains an invalid host");
        }
        if host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
            host.parse::<std::net::Ipv4Addr>()
                .context("sipServer contains an invalid IPv4 address")?;
        }
        port_part
    };
    let port: u16 = port_str
        .parse()
        .context("sipServer port must be an integer in 1..=65535")?;
    if port == 0 {
        bail!("sipServer port must be non-zero");
    }
    Ok(())
}

fn validate_e164(value: &str) -> Result<()> {
    let Some(digits) = value.strip_prefix('+') else {
        bail!("callerId must be in E.164 format starting with '+'");
    };
    if !(7..=15).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        bail!("callerId must start with '+' followed by 7 to 15 ASCII digits");
    }
    Ok(())
}

fn validate_loopback_url(field: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 1024
        || value
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '\\' | '@' | '?' | '#'))
    {
        bail!("{field} must be a valid loopback HTTP/HTTPS URL");
    }
    let Some((scheme, rest)) = value.split_once("://") else {
        bail!("{field} must start with http:// or https://");
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        bail!("{field} must use http or https");
    }
    let (authority, _path) = rest.split_once('/').unwrap_or((rest, ""));
    if authority.is_empty() {
        bail!("{field} is missing a host");
    }
    let port_str = if let Some(bracketed) = authority.strip_prefix('[') {
        if let Some(ipv6) = bracketed.strip_suffix(']') {
            if ipv6 != "::1" {
                bail!("{field} host must be 127.0.0.1, ::1, or localhost");
            }
            None
        } else if let Some((ipv6, port)) = bracketed.split_once("]:") {
            if ipv6 != "::1" {
                bail!("{field} host must be 127.0.0.1, ::1, or localhost");
            }
            Some(port)
        } else {
            bail!("{field} contains an invalid IPv6 host");
        }
    } else {
        let (host, port) = match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        };
        if host != "127.0.0.1" && !host.eq_ignore_ascii_case("localhost") {
            bail!("{field} host must be 127.0.0.1, ::1, or localhost");
        }
        port
    };
    if let Some(port_str) = port_str {
        let port: u16 = port_str
            .parse()
            .with_context(|| format!("{field} port must be an integer in 1..=65535"))?;
        if port == 0 {
            bail!("{field} port must be non-zero");
        }
    }
    Ok(())
}

fn default_sip_transport() -> String {
    DEFAULT_SIP_TRANSPORT.to_string()
}
fn default_voice_base_url() -> String {
    DEFAULT_VOICE_BASE_URL.to_string()
}
fn default_voice_llm_model() -> String {
    DEFAULT_VOICE_LLM_MODEL.to_string()
}
fn default_voice_tts_model() -> String {
    DEFAULT_VOICE_TTS_MODEL.to_string()
}
fn default_voice_tts_voice() -> String {
    DEFAULT_VOICE_TTS_VOICE.to_string()
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::{secrets::generate_token, store::atomic_private_write};
    use std::{collections::BTreeMap, sync::mpsc, time::Duration};

    #[test]
    fn worker_phone_call_settings_and_password_wait_for_the_same_config_commit() {
        let directory = tempfile::tempdir().unwrap();
        let paths = AppPaths::for_tests(directory.path().to_path_buf());
        let secrets = SecretStore::file_backend_for_tests();
        let settings: PhoneCallSettings = serde_json::from_value(serde_json::json!({
            "sipServer": "sip.example.test:5061", "sipUsername": "old-account",
            "callerId": "+15551234567", "userDisplayName": "Example Caller"
        }))
        .unwrap();
        paths
            .configure_phone_call(&secrets, Some(&generate_token()), |_| Ok(settings))
            .unwrap();

        // Pause account reconfiguration after its secret write but before the config commit.
        let lease = paths.acquire_config_lease().unwrap();
        let next_password = generate_token();
        secrets.store_sip_password(&paths, &next_password).unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (completed_tx, completed_rx) = mpsc::channel();
        let worker_paths = paths.clone();
        let worker = std::thread::spawn(move || {
            let mut runtime = BridgeRuntimeConfig {
                values: BTreeMap::new(),
                host: "127.0.0.1".to_string(),
                port: 8787,
                connect_url: "http://127.0.0.1:8787".to_string(),
                auth_token: generate_token(),
                secret_backend: SecretBackend::File,
            };
            entered_tx.send(()).unwrap();
            let outcome =
                runtime.apply_phone_call(&worker_paths, &SecretStore::file_backend_for_tests());
            completed_tx.send((outcome, runtime)).unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let blocked = completed_rx.recv_timeout(Duration::from_millis(100));
        let mut next = paths.load_config().unwrap();
        next.phone_call.as_mut().unwrap().sip_username = "new-account".to_string();
        atomic_private_write(
            &paths.config_path(),
            &serde_json::to_vec_pretty(&next).unwrap(),
        )
        .unwrap();
        drop(lease);
        assert!(matches!(blocked, Err(mpsc::RecvTimeoutError::Timeout)));
        let (outcome, runtime) = completed_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        outcome.unwrap();
        worker.join().unwrap();
        assert_eq!(runtime.values["PHONE_CALL_SIP_USERNAME"], "new-account");
        assert_eq!(runtime.values["PHONE_CALL_SIP_PASSWORD"], next_password);
    }
}
