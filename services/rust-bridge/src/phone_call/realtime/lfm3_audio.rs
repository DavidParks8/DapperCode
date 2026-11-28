#![forbid(unsafe_code)]

use super::strategy::{RealtimeToolInvocation, RealtimeToolSpec};
use crate::phone_call::audio::{
    encode_mulaw, Downsampler24kTo8k, MULAW_SILENCE, RTP_FRAME_SAMPLES,
};
use crate::phone_call::voice::{
    clean_transcription_text, VoiceCallPromptParams, VoiceError, VoicePipelineClient,
};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const LFM3_ASR_TIMEOUT_SECS: u64 = 6;
const LFM3_ASR_MAX_TOKENS: u32 = 64;
const LFM3_READINESS_TIMEOUT_SECS: u64 = 30;
const LFM3_ERROR_BODY_MAX_BYTES: usize = 4_096;

/// Upsamples 8 kHz telephony PCM to LFM3-Audio's native 16 kHz input rate.
#[must_use]
pub fn upsample_8k_to_16k(samples_8k: &[i16]) -> Vec<i16> {
    if samples_8k.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(samples_8k.len().saturating_mul(2));
    for window in samples_8k.windows(2) {
        let current = window[0];
        let next = window[1];
        let mid = i32::from(current).saturating_add(i32::from(next)) / 2;
        out.push(current);
        out.push(i16::try_from(mid).unwrap_or(current));
    }
    if let Some(&last) = samples_8k.last() {
        out.push(last);
        out.push(last);
    }
    out
}

/// Encodes 16 kHz mono 16-bit PCM into a RIFF/WAVE container for LFM3-Audio ASR.
#[must_use]
pub fn encode_wav_16k_mono(samples_16k: &[i16]) -> Vec<u8> {
    let sample_rate_hz: u32 = 16_000;
    let byte_rate = sample_rate_hz.saturating_mul(2);
    let data_bytes_u32 = u32::try_from(samples_16k.len())
        .unwrap_or(u32::MAX / 2)
        .saturating_mul(2);
    let riff_chunk_size = 36_u32.saturating_add(data_bytes_u32);
    let mut out = Vec::with_capacity(44_usize.saturating_add(samples_16k.len().saturating_mul(2)));
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_chunk_size.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16_u32.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&sample_rate_hz.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&2_u16.to_le_bytes());
    out.extend_from_slice(&16_u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_bytes_u32.to_le_bytes());
    for &sample in samples_16k {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

/// Encodes a 20 ms 8 kHz LFM3 realtime frame with -6 dB headroom (`0.5x`) so speech sits around
/// -14 dBFS peak: clear on speakers without overwhelming Mac speakerphone echo guards.
#[must_use]
pub fn encode_lfm3_mulaw_frame(input: &[i16; RTP_FRAME_SAMPLES]) -> [u8; RTP_FRAME_SAMPLES] {
    let mut out = [MULAW_SILENCE; RTP_FRAME_SAMPLES];
    for (dst, &src) in out.iter_mut().zip(input.iter()) {
        *dst = encode_mulaw(src / 2);
    }
    out
}

/// Streaming 24 kHz PCM -> 8 kHz mu-law encoder carrying decimation state across audio deltas.
pub struct Lfm3OutputEncoder {
    downsampler: Downsampler24kTo8k,
    pcm_8k_buf: Vec<i16>,
    frames_emitted: usize,
}

impl Lfm3OutputEncoder {
    #[must_use]
    pub fn new() -> Self {
        Self {
            downsampler: Downsampler24kTo8k::new(),
            pcm_8k_buf: Vec::new(),
            frames_emitted: 0,
        }
    }

    pub fn push_pcm24k<OnFrame: FnMut([u8; RTP_FRAME_SAMPLES]) + ?Sized>(
        &mut self,
        samples_24k: &[i16],
        on_frame: &mut OnFrame,
    ) {
        self.downsampler
            .push_pcm24k_samples(samples_24k, &mut self.pcm_8k_buf);
        let full_frames = self.pcm_8k_buf.len() / RTP_FRAME_SAMPLES;
        if full_frames == 0 {
            return;
        }
        let drain_samples = full_frames.saturating_mul(RTP_FRAME_SAMPLES);
        for chunk in self.pcm_8k_buf[..drain_samples].chunks_exact(RTP_FRAME_SAMPLES) {
            let mut frame = [0_i16; RTP_FRAME_SAMPLES];
            frame.copy_from_slice(chunk);
            on_frame(encode_lfm3_mulaw_frame(&frame));
            self.frames_emitted = self.frames_emitted.saturating_add(1);
        }
        self.pcm_8k_buf.drain(..drain_samples);
    }

    pub fn flush_tail<OnFrame: FnMut([u8; RTP_FRAME_SAMPLES]) + ?Sized>(
        &mut self,
        on_frame: &mut OnFrame,
    ) {
        if self.pcm_8k_buf.is_empty() {
            return;
        }
        let mut tail = [0_i16; RTP_FRAME_SAMPLES];
        let count = self.pcm_8k_buf.len().min(RTP_FRAME_SAMPLES);
        tail[..count].copy_from_slice(&self.pcm_8k_buf[..count]);
        self.pcm_8k_buf.clear();
        on_frame(encode_lfm3_mulaw_frame(&tail));
        self.frames_emitted = self.frames_emitted.saturating_add(1);
    }

    #[must_use]
    pub fn frames_emitted(&self) -> usize {
        self.frames_emitted
    }
}

#[must_use]
pub fn build_lfm3_instructions(
    params: &VoiceCallPromptParams,
    steers: &[String],
    tools: &[RealtimeToolSpec],
) -> String {
    let caller_name = {
        let trimmed = params.user_display_name.trim();
        if trimmed.is_empty() {
            "the user"
        } else {
            trimmed
        }
    };
    let mut prompt = format!(
        "Respond with function calls, and interleaved text and audio.\n\
         Your own name is Lily (never call the listener Lily). You are a warm, witty American woman speaking in a consistent female voice on a live phone call on behalf of {caller_name}. If asked your name, always say \"I'm Lily.\"\n\
         Speak naturally like a real person with contractions and upbeat energy. \
         Keep casual chat brief (1-2 short sentences), and take a few clear sentences whenever an explanation genuinely needs more detail instead of over-simplifying. \
         Always speak in your own natural words; never say \"the search results mention\" or \"according to the search results\". \
         Always share your own fun personal take, opinion, or concrete topic idea when asked instead of deflecting back to the listener. \
         Keep most turns as reactions or statements rather than ending every turn with a question. \
         Only say you are an AI if directly asked, and never pretend to be {caller_name}.\n\
         If they criticize your voice, pacing, or answers, apologize briefly, adjust, and keep talking.",
    );
    let guidance: Vec<&str> = tools
        .iter()
        .map(RealtimeToolSpec::guidance)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect();
    if !guidance.is_empty() {
        prompt.push_str("\nTools: ");
        prompt.push_str(&guidance.join(" "));
    }
    append_optional_line(&mut prompt, "Callee", params.callee_name.as_deref());
    append_optional_line(&mut prompt, "Call objective", Some(&params.objective));
    append_optional_line(
        &mut prompt,
        "Opening turn guidance",
        params.first_message.as_deref(),
    );
    append_optional_line(&mut prompt, "Background context", params.context.as_deref());
    for steer in steers {
        append_optional_line(&mut prompt, "Private live instruction", Some(steer));
    }
    prompt
}

fn append_optional_line(target: &mut String, label: &str, value: Option<&str>) {
    if let Some(trimmed) = value.map(str::trim).filter(|text| !text.is_empty()) {
        target.push('\n');
        target.push_str(label);
        target.push_str(": ");
        target.push_str(trimmed);
    }
}

/// Verifies that the local `llama.cpp` server hosting LFM3-Audio responds on `/models`.
pub async fn probe_lfm3_server_readiness(
    voice_client: &VoicePipelineClient,
    cancel: &CancellationToken,
) -> Result<(), VoiceError> {
    if cancel.is_cancelled() {
        return Err(VoiceError::Cancelled);
    }
    let mut models_url = voice_client.llm_base_url().clone();
    let prefix = models_url.path().trim_end_matches('/');
    models_url.set_path(&format!("{prefix}/models"));
    let request = voice_client
        .http_client()
        .get(models_url.clone())
        .timeout(Duration::from_secs(LFM3_READINESS_TIMEOUT_SECS));
    let response = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(VoiceError::Cancelled),
        res = request.send() => res.map_err(|source| VoiceError::Transport {
            endpoint: models_url.to_string(),
            source,
        })?,
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let bytes = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(VoiceError::Cancelled),
            res = response.bytes() => res.unwrap_or_default(),
        };
        let bounded = &bytes[..bytes.len().min(LFM3_ERROR_BODY_MAX_BYTES)];
        return Err(VoiceError::HttpStatus {
            endpoint: models_url.to_string(),
            status,
            body: String::from_utf8_lossy(bounded).into_owned(),
        });
    }
    Ok(())
}

pub async fn synthesize_lfm3_filler_frames(
    voice_client: &VoicePipelineClient,
    phrase: &str,
    cancel: &CancellationToken,
) -> Option<Vec<[u8; RTP_FRAME_SAMPLES]>> {
    let mut encoder = Lfm3OutputEncoder::new();
    let mut frames = Vec::new();
    voice_client
        .synthesize_speech_pcm24k(phrase, cancel, |samples_24k| {
            encoder.push_pcm24k(samples_24k, &mut |frame| frames.push(frame));
        })
        .await
        .ok()?;
    encoder.flush_tail(&mut |frame| frames.push(frame));
    if frames.is_empty() {
        None
    } else {
        Some(frames)
    }
}

#[derive(Deserialize)]
struct ChatAsrResponse {
    choices: Vec<ChatAsrChoice>,
}

#[derive(Deserialize)]
struct ChatAsrChoice {
    message: ChatAsrMessage,
}

#[derive(Deserialize)]
struct ChatAsrMessage {
    #[serde(default)]
    content: Option<String>,
}

/// Transcribes a 16 kHz WAV clip through LFM3-Audio's `/v1/chat/completions` `input_audio` path.
pub async fn transcribe_lfm3_chat_wav(
    http: &reqwest::Client,
    base_url: &Url,
    model: &str,
    wav_bytes: &[u8],
    cancel: &CancellationToken,
) -> Result<Option<String>, VoiceError> {
    if cancel.is_cancelled() || wav_bytes.is_empty() {
        return Ok(None);
    }
    let endpoint = chat_completions_url(base_url);
    let request = http
        .post(endpoint.clone())
        .timeout(Duration::from_secs(LFM3_ASR_TIMEOUT_SECS))
        .json(&build_lfm3_asr_payload(model, wav_bytes));
    let response = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(VoiceError::Cancelled),
        res = request.send() => res.map_err(|source| VoiceError::Transport {
            endpoint: endpoint.to_string(),
            source,
        })?,
    };
    if !response.status().is_success() {
        return Ok(None);
    }
    let bytes = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(VoiceError::Cancelled),
        res = response.bytes() => res.map_err(|source| VoiceError::Transport {
            endpoint: endpoint.to_string(),
            source,
        })?,
    };
    Ok(parse_lfm3_asr_bytes(&bytes))
}

fn chat_completions_url(base_url: &Url) -> Url {
    let mut endpoint = base_url.clone();
    let prefix = endpoint.path().trim_end_matches('/');
    endpoint.set_path(&format!("{prefix}/chat/completions"));
    endpoint
}

fn build_lfm3_asr_payload(model: &str, wav_bytes: &[u8]) -> Value {
    json!({
        "model": model.trim(),
        "messages": [
            { "role": "system", "content": "Perform ASR in English." },
            {
                "role": "user",
                "content": [{
                    "type": "input_audio",
                    "input_audio": {
                        "data": BASE64_STANDARD.encode(wav_bytes),
                        "format": "wav",
                    },
                }],
            },
        ],
        "temperature": 0.0,
        "max_tokens": LFM3_ASR_MAX_TOKENS,
        "repeat_penalty": 1.15,
    })
}

fn parse_lfm3_asr_bytes(bytes: &[u8]) -> Option<String> {
    let parsed: ChatAsrResponse = serde_json::from_slice(bytes).ok()?;
    let raw = parsed
        .choices
        .first()
        .and_then(|choice| choice.message.content.as_deref())
        .unwrap_or("");
    clean_transcription_text(raw)
}

#[must_use]
pub fn derive_realtime_ws_url(base_url: &Url) -> Url {
    let mut ws_url = base_url.clone();
    let scheme = match ws_url.scheme() {
        "https" | "wss" => "wss",
        _ => "ws",
    };
    let _ = ws_url.set_scheme(scheme);
    let trimmed = ws_url.path().trim_end_matches('/');
    let path = if trimmed.ends_with("/realtime") {
        trimmed.to_string()
    } else if trimmed.is_empty() {
        "/v1/realtime".to_string()
    } else {
        format!("{trimmed}/realtime")
    };
    ws_url.set_path(&path);
    ws_url.set_query(None);
    ws_url.set_fragment(None);
    ws_url
}

pub(super) fn parse_raw_tool_calls(done_event: &Value) -> Vec<RealtimeToolInvocation> {
    let Some(items) = done_event
        .pointer("/response/output")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .map(|item| {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let call_id = item
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or("realtime_tool")
                .to_string();
            let raw_args = item
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let arguments = serde_json::from_str::<Value>(raw_args).unwrap_or_else(|_| json!({}));
            RealtimeToolInvocation {
                call_id,
                name,
                arguments,
            }
        })
        .collect()
}

pub(super) fn decode_audio_delta(event: &Value, out: &mut Vec<i16>) -> Result<(), VoiceError> {
    out.clear();
    let Some(encoded) = event.get("delta").and_then(Value::as_str) else {
        return Ok(());
    };
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|err| VoiceError::InvalidResponse {
            endpoint: "realtime".to_string(),
            reason: format!("invalid base64 audio delta: {err}"),
        })?;
    out.reserve(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        out.push(i16::from_le_bytes([pair[0], pair[1]]));
    }
    Ok(())
}

pub(super) fn realtime_error(endpoint: String, event: &Value) -> VoiceError {
    let message = event
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("unknown realtime server error");
    VoiceError::InvalidResponse {
        endpoint,
        reason: message.to_string(),
    }
}
