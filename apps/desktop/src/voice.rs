use std::io::Read;

use anyhow::{bail, Context, Result};
use dappercode_desktop_core::{
    AppPaths, PhoneCallSettings, SecretStore, DEFAULT_SIP_TRANSPORT, DEFAULT_VOICE_BASE_URL,
    DEFAULT_VOICE_LLM_MODEL, DEFAULT_VOICE_STT_MODEL, DEFAULT_VOICE_TTS_MODEL,
    DEFAULT_VOICE_TTS_VOICE,
};
use serde::Serialize;

use super::{emit, ensure_no_args, option, print_help, take_flag};

const MAX_SIP_PASSWORD_STDIN_BYTES: u64 = 4_112;

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VoiceStatus {
    pub(super) configured: bool,
    pub(super) secret_present: bool,
    pub(super) secret_backend: Option<String>,
    pub(super) settings: Option<PhoneCallSettings>,
}

pub(super) fn run(
    mut args: Vec<String>,
    human: bool,
    paths: &AppPaths,
    secrets: &SecretStore,
) -> Result<()> {
    let Some(subcommand) = args.first().cloned() else {
        bail!("missing voice subcommand; run 'dappercode help'");
    };
    args.remove(0);
    match subcommand.as_str() {
        "help" | "--help" | "-h" => {
            print_help();
            Ok(())
        }
        "configure" => emit(
            configure_voice(args, std::io::stdin().lock(), paths, secrets)?,
            human,
        ),
        "status" => {
            ensure_no_args(&args)?;
            emit(voice_status(paths, secrets)?, human)
        }
        "clear" => {
            ensure_no_args(&args)?;
            emit(clear_voice(paths, secrets)?, human)
        }
        _ => bail!("unknown voice subcommand '{subcommand}'; run 'dappercode help'"),
    }
}

pub(super) fn configure_voice(
    mut args: Vec<String>,
    stdin: impl Read,
    paths: &AppPaths,
    secrets: &SecretStore,
) -> Result<VoiceStatus> {
    let sip_password_stdin = take_flag(&mut args, "--sip-password-stdin");
    let sip_server = option(&mut args, "--sip-server");
    let sip_transport = option(&mut args, "--sip-transport");
    let sip_username = option(&mut args, "--sip-username");
    let caller_id = option(&mut args, "--caller-id");
    let display_name = option(&mut args, "--display-name");
    let stt_base_url = option(&mut args, "--stt-base-url");
    let stt_model = option(&mut args, "--stt-model");
    let llm_base_url = option(&mut args, "--llm-base-url");
    let llm_model = option(&mut args, "--llm-model");
    let tts_base_url = option(&mut args, "--tts-base-url");
    let tts_model = option(&mut args, "--tts-model");
    let tts_voice = option(&mut args, "--tts-voice");
    ensure_no_args(&args)?;

    let new_password = if sip_password_stdin {
        let mut raw = String::new();
        stdin
            .take(MAX_SIP_PASSWORD_STDIN_BYTES)
            .read_to_string(&mut raw)
            .context("failed to read SIP password from stdin")?;
        let password = raw.trim_end_matches(['\r', '\n']);
        if password.trim().is_empty() {
            bail!("SIP password read from stdin must not be empty");
        }
        if password.contains(['\r', '\n', '\0']) {
            bail!("SIP password must be a single line without control characters");
        }
        Some(password.to_string())
    } else {
        None
    };

    let (settings, backend) =
        paths.configure_phone_call(secrets, new_password.as_deref(), |existing| {
            Ok(PhoneCallSettings {
                sip_server: sip_server
                    .or_else(|| existing.map(|s| s.sip_server.clone()))
                    .context("--sip-server is required")?,
                sip_transport: sip_transport
                    .or_else(|| existing.map(|s| s.sip_transport.clone()))
                    .unwrap_or_else(|| DEFAULT_SIP_TRANSPORT.to_string()),
                sip_username: sip_username
                    .or_else(|| existing.map(|s| s.sip_username.clone()))
                    .context("--sip-username is required")?,
                caller_id: caller_id
                    .or_else(|| existing.map(|s| s.caller_id.clone()))
                    .context("--caller-id is required")?,
                user_display_name: display_name
                    .or_else(|| existing.map(|s| s.user_display_name.clone()))
                    .context("--display-name is required")?,
                stt_base_url: stt_base_url
                    .or_else(|| existing.map(|s| s.stt_base_url.clone()))
                    .unwrap_or_else(|| DEFAULT_VOICE_BASE_URL.to_string()),
                stt_model: stt_model
                    .or_else(|| existing.map(|s| s.stt_model.clone()))
                    .unwrap_or_else(|| DEFAULT_VOICE_STT_MODEL.to_string()),
                llm_base_url: llm_base_url
                    .or_else(|| existing.map(|s| s.llm_base_url.clone()))
                    .unwrap_or_else(|| DEFAULT_VOICE_BASE_URL.to_string()),
                llm_model: llm_model
                    .or_else(|| existing.map(|s| s.llm_model.clone()))
                    .unwrap_or_else(|| DEFAULT_VOICE_LLM_MODEL.to_string()),
                tts_base_url: tts_base_url
                    .or_else(|| existing.map(|s| s.tts_base_url.clone()))
                    .unwrap_or_else(|| DEFAULT_VOICE_BASE_URL.to_string()),
                tts_model: tts_model
                    .or_else(|| existing.map(|s| s.tts_model.clone()))
                    .unwrap_or_else(|| DEFAULT_VOICE_TTS_MODEL.to_string()),
                tts_voice: tts_voice
                    .or_else(|| existing.map(|s| s.tts_voice.clone()))
                    .unwrap_or_else(|| DEFAULT_VOICE_TTS_VOICE.to_string()),
            })
        })?;
    Ok(VoiceStatus {
        configured: true,
        secret_present: true,
        secret_backend: Some(backend.as_str().to_string()),
        settings: Some(settings),
    })
}

pub(super) fn voice_status(paths: &AppPaths, secrets: &SecretStore) -> Result<VoiceStatus> {
    let _lease = paths.acquire_config_lease()?;
    let settings = paths.load_config()?.phone_call;
    let secret = secrets.load_sip_password(paths)?;
    let secret_present = secret.is_some();
    Ok(VoiceStatus {
        configured: settings.is_some() && secret_present,
        secret_present,
        secret_backend: secret.map(|(_, backend)| backend.as_str().to_string()),
        settings,
    })
}

pub(super) fn clear_voice(paths: &AppPaths, secrets: &SecretStore) -> Result<VoiceStatus> {
    paths.update_config_then(
        |config| {
            config.phone_call = None;
            Ok(())
        },
        || secrets.delete_sip_password(paths),
    )?;
    Ok(VoiceStatus {
        configured: false,
        secret_present: false,
        secret_backend: None,
        settings: None,
    })
}
