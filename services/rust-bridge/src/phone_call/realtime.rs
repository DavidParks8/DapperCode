#![forbid(unsafe_code)]

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "realtime_tests.rs"]
pub(super) mod tests;

use super::voice::{
    clean_transcription_text, is_loopback_base_url, VoiceCallPromptParams, VoiceError,
    VoiceToolCall,
};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;

pub const DEFAULT_LFM3_AUDIO_MODEL: &str = "LiquidAI/LFM3-Audio-2B-GGUF:Q8_0";
const REALTIME_CONNECT_TIMEOUT_SECS: u64 = 15;
const REALTIME_SETUP_TIMEOUT_SECS: u64 = 15;
const REALTIME_CANCEL_DRAIN_MS: u64 = 1_500;
const REALTIME_AUDIO_APPEND_SAMPLES: usize = 3_200; // 200 ms @ 16 kHz
const REALTIME_ASR_TIMEOUT_SECS: u64 = 6;
const REALTIME_ASR_MAX_TOKENS: u32 = 64;

type RealtimeWs = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[must_use]
pub fn is_realtime_s2s_model(model: &str) -> bool {
    let lower = model.trim().to_ascii_lowercase();
    lower.contains("lfm3-audio") || lower.contains("lfm3_audio")
}

#[must_use]
pub fn derive_realtime_ws_url(base: &Url) -> Url {
    let mut ws_url = base.clone();
    let scheme = if base.scheme().eq_ignore_ascii_case("https") {
        "wss"
    } else {
        "ws"
    };
    let _ = ws_url.set_scheme(scheme);
    let prefix = ws_url.path().trim_end_matches('/');
    let path = if prefix.is_empty() {
        "/v1/realtime".to_string()
    } else if prefix.ends_with("/realtime") {
        prefix.to_string()
    } else {
        format!("{prefix}/realtime")
    };
    ws_url.set_path(&path);
    ws_url.set_query(None);
    ws_url
}

/// Upsamples 8 kHz mono 16-bit PCM to 16 kHz using linear interpolation between adjacent samples.
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

/// Encodes 16 kHz mono 16-bit linear PCM into a RIFF/WAVE container for LFM3-Audio ASR.
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

#[must_use]
pub fn build_realtime_instructions(params: &VoiceCallPromptParams, steers: &[String]) -> String {
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
         You are Lily, a warm, witty American woman speaking in a consistent female voice on a live phone call on behalf of {caller_name}.\n\
         Speak naturally like a real person: 1-2 short sentences, contractions, and upbeat energy. \
         Always share your own fun personal take, opinion, or concrete topic idea when asked instead of deflecting back to the listener. \
         Keep most turns as reactions or statements rather than ending every turn with a question. \
         Only say you are an AI if directly asked, and never pretend to be {caller_name}.\n\
         If they criticize your voice or pacing, apologize briefly, adjust, and keep talking. \
         Call send_dtmf only for automated phone menus. \
         Call end_call immediately when the other person says goodbye, bye, asks to hang up or stop, refuses to talk, says it is a wrong number, or reports an emergency.",
    );
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

#[must_use]
pub fn build_realtime_tools(can_end_call: bool) -> Value {
    let mut tools = vec![send_dtmf_tool_schema()];
    if can_end_call {
        tools.push(end_call_tool_schema());
    }
    Value::Array(tools)
}

fn send_dtmf_tool_schema() -> Value {
    json!({
        "type": "function",
        "name": "send_dtmf",
        "description": "Press keypad digits ONLY when an automated IVR phone menu asks you to press a number.",
        "parameters": {
            "type": "object",
            "properties": {
                "digits": {
                    "type": "string",
                    "description": "Literal keypad symbols such as 1, 2, *, or #."
                }
            },
            "required": ["digits"]
        }
    })
}

fn end_call_tool_schema() -> Value {
    json!({
        "type": "function",
        "name": "end_call",
        "description": "End the phone call ONLY when the recipient explicitly asks to stop or hang up, refuses to continue, reports a wrong number/emergency, or says goodbye after the call is resolved.",
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Short reason for ending the call."
                },
                "outcome_summary": {
                    "type": "string",
                    "description": "Brief summary of what happened on the call."
                }
            },
            "required": ["reason"]
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimeTurnOutput {
    pub spoken_text: String,
    pub tool_calls: Vec<VoiceToolCall>,
    pub audio_samples_emitted: usize,
    pub cancelled: bool,
}

pub struct RealtimeSession {
    endpoint: String,
    ws: RealtimeWs,
}

impl RealtimeSession {
    pub async fn connect(
        base_url: &Url,
        instructions: &str,
        tools: Value,
        cancel: &CancellationToken,
    ) -> Result<Self, VoiceError> {
        if !is_loopback_base_url(base_url) {
            return Err(VoiceError::InvalidEndpointUrl {
                field: "llm_base_url",
                reason: "realtime voice WebSocket must use a loopback host".to_string(),
            });
        }
        let ws_url = derive_realtime_ws_url(base_url);
        let endpoint = ws_url.to_string();
        let connect_fut = connect_async(ws_url.as_str());
        let (ws, _) = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(VoiceError::Cancelled),
            res = tokio::time::timeout(
                Duration::from_secs(REALTIME_CONNECT_TIMEOUT_SECS),
                connect_fut,
            ) => match res {
                Ok(Ok(pair)) => pair,
                Ok(Err(err)) => return Err(VoiceError::InvalidResponse {
                    endpoint,
                    reason: format!("realtime WebSocket connect failed: {err}"),
                }),
                Err(_) => return Err(VoiceError::InvalidResponse {
                    endpoint,
                    reason: "realtime WebSocket connect timed out".to_string(),
                }),
            },
        };

        let mut session = Self { endpoint, ws };
        session
            .wait_for_event_type("session.created", cancel)
            .await?;
        session.update_session(instructions, tools, cancel).await?;
        Ok(session)
    }

    async fn update_session(
        &mut self,
        instructions: &str,
        tools: Value,
        cancel: &CancellationToken,
    ) -> Result<(), VoiceError> {
        self.send_json(
            &json!({
                "type": "session.update",
                "session": {
                    "type": "realtime",
                    "instructions": instructions,
                    "tools": tools,
                },
            }),
            cancel,
        )
        .await?;
        self.wait_for_event_type("session.updated", cancel).await
    }

    pub async fn run_audio_turn<OnAudio>(
        &mut self,
        pcm_16k: &[i16],
        cancel: &CancellationToken,
        on_audio_24k: OnAudio,
    ) -> Result<RealtimeTurnOutput, VoiceError>
    where
        OnAudio: FnMut(&[i16]),
    {
        if pcm_16k.is_empty() {
            return Ok(RealtimeTurnOutput {
                spoken_text: String::new(),
                tool_calls: Vec::new(),
                audio_samples_emitted: 0,
                cancelled: false,
            });
        }
        self.send_json(&json!({ "type": "input_audio_buffer.clear" }), cancel)
            .await?;
        for chunk in pcm_16k.chunks(REALTIME_AUDIO_APPEND_SAMPLES) {
            let mut bytes = Vec::with_capacity(chunk.len().saturating_mul(2));
            for &sample in chunk {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            let encoded = BASE64_STANDARD.encode(&bytes);
            self.send_json(
                &json!({
                    "type": "input_audio_buffer.append",
                    "audio": encoded,
                }),
                cancel,
            )
            .await?;
        }
        self.send_json(&json!({ "type": "input_audio_buffer.commit" }), cancel)
            .await?;
        self.send_json(&json!({ "type": "response.create" }), cancel)
            .await?;
        self.collect_response(cancel, on_audio_24k).await
    }

    pub async fn run_text_turn<OnAudio>(
        &mut self,
        user_text: &str,
        force_audio: bool,
        cancel: &CancellationToken,
        on_audio_24k: OnAudio,
    ) -> Result<RealtimeTurnOutput, VoiceError>
    where
        OnAudio: FnMut(&[i16]),
    {
        self.send_json(
            &json!({
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": user_text }],
                },
            }),
            cancel,
        )
        .await?;
        let request = if force_audio {
            json!({
                "type": "response.create",
                "response": { "output_modalities": ["text", "audio"] },
            })
        } else {
            json!({ "type": "response.create" })
        };
        self.send_json(&request, cancel).await?;
        self.collect_response(cancel, on_audio_24k).await
    }

    pub async fn submit_tool_output<OnAudio>(
        &mut self,
        call_id: &str,
        output: &str,
        request_spoken_reply: bool,
        cancel: &CancellationToken,
        on_audio_24k: OnAudio,
    ) -> Result<RealtimeTurnOutput, VoiceError>
    where
        OnAudio: FnMut(&[i16]),
    {
        self.send_json(
            &json!({
                "type": "conversation.item.create",
                "item": {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
                },
            }),
            cancel,
        )
        .await?;
        if !request_spoken_reply {
            return Ok(RealtimeTurnOutput {
                spoken_text: String::new(),
                tool_calls: Vec::new(),
                audio_samples_emitted: 0,
                cancelled: false,
            });
        }
        self.send_json(
            &json!({
                "type": "response.create",
                "response": { "output_modalities": ["text", "audio"] },
            }),
            cancel,
        )
        .await?;
        self.collect_response(cancel, on_audio_24k).await
    }

    async fn send_json(
        &mut self,
        payload: &Value,
        cancel: &CancellationToken,
    ) -> Result<(), VoiceError> {
        let text = payload.to_string();
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(VoiceError::Cancelled),
            res = self.ws.send(Message::Text(text.into())) => res.map_err(|err| {
                VoiceError::InvalidResponse {
                    endpoint: self.endpoint.clone(),
                    reason: format!("realtime WebSocket send failed: {err}"),
                }
            }),
        }
    }

    async fn recv_event(&mut self, cancel: &CancellationToken) -> Result<Value, VoiceError> {
        loop {
            let next_msg = tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(VoiceError::Cancelled),
                item = self.ws.next() => item,
            };
            match next_msg {
                Some(Ok(Message::Text(text))) => {
                    return serde_json::from_str(&text).map_err(|err| {
                        VoiceError::InvalidResponse {
                            endpoint: self.endpoint.clone(),
                            reason: format!("invalid realtime JSON event: {err}"),
                        }
                    });
                }
                Some(Ok(Message::Ping(data))) => {
                    let _ = self.ws.send(Message::Pong(data)).await;
                }
                Some(Ok(Message::Pong(_) | Message::Binary(_) | Message::Frame(_))) => {}
                Some(Ok(Message::Close(_))) | None => {
                    return Err(VoiceError::InvalidResponse {
                        endpoint: self.endpoint.clone(),
                        reason: "realtime WebSocket closed unexpectedly".to_string(),
                    });
                }
                Some(Err(err)) => {
                    return Err(VoiceError::InvalidResponse {
                        endpoint: self.endpoint.clone(),
                        reason: format!("realtime WebSocket read failed: {err}"),
                    });
                }
            }
        }
    }

    async fn wait_for_event_type(
        &mut self,
        expected: &str,
        cancel: &CancellationToken,
    ) -> Result<(), VoiceError> {
        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(REALTIME_SETUP_TIMEOUT_SECS);
        loop {
            let event = tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(VoiceError::Cancelled),
                () = tokio::time::sleep_until(deadline) => {
                    return Err(VoiceError::InvalidResponse {
                        endpoint: self.endpoint.clone(),
                        reason: format!("timed out waiting for realtime event '{expected}'"),
                    });
                }
                res = self.recv_event(cancel) => res?,
            };
            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
            if event_type == expected {
                return Ok(());
            }
            if event_type == "error" {
                return Err(realtime_error(self.endpoint.clone(), &event));
            }
        }
    }

    async fn collect_response<OnAudio>(
        &mut self,
        cancel: &CancellationToken,
        mut on_audio_24k: OnAudio,
    ) -> Result<RealtimeTurnOutput, VoiceError>
    where
        OnAudio: FnMut(&[i16]),
    {
        let mut spoken_text = String::new();
        let mut audio_samples_emitted = 0usize;
        let mut samples_buf: Vec<i16> = Vec::new();
        loop {
            let event = match self.recv_event(cancel).await {
                Ok(ev) => ev,
                Err(VoiceError::Cancelled) => {
                    self.cancel_and_drain().await;
                    return Ok(cancelled_turn_output(spoken_text, audio_samples_emitted));
                }
                Err(err) => return Err(err),
            };
            match event.get("type").and_then(Value::as_str).unwrap_or("") {
                "response.output_text.delta" | "response.output_audio_transcript.delta" => {
                    if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                        spoken_text.push_str(delta);
                    }
                }
                "response.output_audio.delta" | "response.audio.delta" => {
                    audio_samples_emitted = audio_samples_emitted.saturating_add(emit_audio_delta(
                        &event,
                        &mut samples_buf,
                        &mut on_audio_24k,
                    )?);
                }
                "response.done" => {
                    return finish_response_done(&event, spoken_text, audio_samples_emitted);
                }
                "error" => return Err(realtime_error(self.endpoint.clone(), &event)),
                _ => {}
            }
        }
    }

    async fn cancel_and_drain(&mut self) {
        let cancel_msg = json!({ "type": "response.cancel" }).to_string();
        let _ = self.ws.send(Message::Text(cancel_msg.into())).await;
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(REALTIME_CANCEL_DRAIN_MS);
        let noop = CancellationToken::new();
        loop {
            let next = tokio::select! {
                () = tokio::time::sleep_until(deadline) => break,
                res = self.recv_event(&noop) => res,
            };
            let Ok(event) = next else {
                break;
            };
            if matches!(
                event.get("type").and_then(Value::as_str),
                Some("response.done" | "error"),
            ) {
                break;
            }
        }
    }
}

fn cancelled_turn_output(spoken_text: String, audio_samples_emitted: usize) -> RealtimeTurnOutput {
    RealtimeTurnOutput {
        spoken_text: spoken_text.trim().to_string(),
        tool_calls: Vec::new(),
        audio_samples_emitted,
        cancelled: true,
    }
}

fn emit_audio_delta<OnAudio: FnMut(&[i16])>(
    event: &Value,
    samples_buf: &mut Vec<i16>,
    on_audio_24k: &mut OnAudio,
) -> Result<usize, VoiceError> {
    let Some(delta) = event.get("delta").and_then(Value::as_str) else {
        return Ok(0);
    };
    decode_pcm16_base64(delta, samples_buf)?;
    if samples_buf.is_empty() {
        return Ok(0);
    }
    on_audio_24k(samples_buf);
    Ok(samples_buf.len())
}

fn finish_response_done(
    event: &Value,
    spoken_text: String,
    audio_samples_emitted: usize,
) -> Result<RealtimeTurnOutput, VoiceError> {
    let tool_calls = parse_realtime_tool_calls(event)?;
    let status = event
        .pointer("/response/status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    Ok(RealtimeTurnOutput {
        spoken_text: spoken_text.trim().to_string(),
        tool_calls,
        audio_samples_emitted,
        cancelled: status == "cancelled",
    })
}

fn realtime_error(endpoint: String, event: &Value) -> VoiceError {
    let message = event
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("unknown realtime server error");
    VoiceError::InvalidResponse {
        endpoint,
        reason: message.to_string(),
    }
}

fn decode_pcm16_base64(encoded: &str, out: &mut Vec<i16>) -> Result<(), VoiceError> {
    out.clear();
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

fn parse_realtime_tool_calls(done_event: &Value) -> Result<Vec<VoiceToolCall>, VoiceError> {
    let Some(items) = done_event
        .pointer("/response/output")
        .and_then(Value::as_array)
    else {
        return Ok(Vec::new());
    };
    let mut calls = Vec::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            continue;
        }
        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
        let call_id = item
            .get("call_id")
            .and_then(Value::as_str)
            .unwrap_or("realtime_tool")
            .to_string();
        let raw_args = item
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(raw_args).unwrap_or_else(|_| json!({}));
        if let Some(tool) = map_realtime_tool_call(name, call_id, &parsed)? {
            calls.push(tool);
        }
    }
    Ok(calls)
}

fn map_realtime_tool_call(
    name: &str,
    call_id: String,
    args: &Value,
) -> Result<Option<VoiceToolCall>, VoiceError> {
    match name {
        "send_dtmf" => Ok(map_send_dtmf_tool(call_id, args)),
        "hold_call" => Ok(Some(map_hold_call_tool(call_id, args))),
        "end_call" => Ok(Some(map_end_call_tool(call_id, args))),
        _ => Ok(None),
    }
}

fn map_send_dtmf_tool(call_id: String, args: &Value) -> Option<VoiceToolCall> {
    let digits = args
        .get("digits")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let normalized: String = digits
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .filter(|ch| *ch != '-')
        .map(|ch| ch.to_ascii_uppercase())
        .filter(|ch| matches!(ch, '0'..='9' | '*' | '#' | 'A'..='D'))
        .collect();
    if normalized.is_empty() {
        return None;
    }
    Some(VoiceToolCall::SendDtmf {
        call_id,
        digits: normalized,
    })
}

fn map_hold_call_tool(call_id: String, args: &Value) -> VoiceToolCall {
    let reason = args
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("Recipient asked to hold")
        .to_string();
    VoiceToolCall::WaitSilently {
        call_id,
        reason,
        on_hold: true,
    }
}

fn map_end_call_tool(call_id: String, args: &Value) -> VoiceToolCall {
    let reason = args
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("Call completed")
        .to_string();
    let outcome_summary = args
        .get("outcome_summary")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(&reason)
        .to_string();
    VoiceToolCall::EndCall {
        call_id,
        reason,
        outcome_summary,
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

/// Transcribes a WAV utterance through LFM3-Audio's `/v1/chat/completions` `input_audio` path.
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
        .timeout(Duration::from_secs(REALTIME_ASR_TIMEOUT_SECS))
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
        "max_tokens": REALTIME_ASR_MAX_TOKENS,
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
