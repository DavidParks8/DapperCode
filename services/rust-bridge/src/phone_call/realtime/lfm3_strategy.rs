#![forbid(unsafe_code)]

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "lfm3_strategy_tests.rs"]
pub(super) mod tests;

use super::lfm3_audio::{
    build_lfm3_instructions, decode_audio_delta, derive_realtime_ws_url, encode_wav_16k_mono,
    parse_raw_tool_calls, realtime_error, synthesize_lfm3_filler_frames, transcribe_lfm3_chat_wav,
    upsample_8k_to_16k, Lfm3OutputEncoder,
};
use super::strategy::{
    BoxFuture, OnPcmuFrame, RealtimeConnectConfig, RealtimeModelSession, RealtimeModelStrategy,
    RealtimeTurnOutput,
};
use crate::phone_call::audio::RTP_FRAME_SAMPLES;
use crate::phone_call::voice::{is_loopback_base_url, VoiceError, VoicePipelineClient};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
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

type RealtimeWs = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Strategy implementation for LiquidAI LFM3-Audio over `llama.cpp`'s `/v1/realtime` WebSocket.
pub struct Lfm3AudioStrategy;

impl RealtimeModelStrategy for Lfm3AudioStrategy {
    fn id(&self) -> &'static str {
        "lfm3-audio-realtime"
    }

    fn matches_model(&self, model: &str) -> bool {
        let lower = model.trim().to_ascii_lowercase();
        lower.contains("lfm3-audio") || lower.contains("lfm3_audio")
    }

    fn connect<'a>(
        &'a self,
        config: &'a RealtimeConnectConfig,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Box<dyn RealtimeModelSession>, VoiceError>> {
        Box::pin(async move {
            let instructions =
                build_lfm3_instructions(&config.prompt_params, &config.initial_steers);
            let tools = Value::Array(
                config
                    .tools
                    .iter()
                    .map(super::strategy::RealtimeToolSpec::to_openai_tool_json)
                    .collect(),
            );
            let session =
                Lfm3RealtimeSession::connect(&config.base_url, &instructions, tools, cancel)
                    .await?;
            Ok(Box::new(session) as Box<dyn RealtimeModelSession>)
        })
    }

    fn transcribe_pcm_8k<'a>(
        &'a self,
        http: &'a reqwest::Client,
        base_url: &'a Url,
        model: &'a str,
        samples_8k: &'a [i16],
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Option<String>, VoiceError>> {
        Box::pin(async move {
            let wav = encode_wav_16k_mono(&upsample_8k_to_16k(samples_8k));
            transcribe_lfm3_chat_wav(http, base_url, model, &wav, cancel).await
        })
    }

    fn synthesize_filler_frames<'a>(
        &'a self,
        voice_client: &'a VoicePipelineClient,
        phrase: &'a str,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Option<Vec<[u8; RTP_FRAME_SAMPLES]>>> {
        Box::pin(synthesize_lfm3_filler_frames(voice_client, phrase, cancel))
    }
}

/// Active WebSocket session speaking the `llama.cpp` `/v1/realtime` protocol for LFM3-Audio.
pub struct Lfm3RealtimeSession {
    endpoint: String,
    ws: RealtimeWs,
}

impl Lfm3RealtimeSession {
    pub async fn connect(
        base_url: &Url,
        instructions: &str,
        tools: Value,
        cancel: &CancellationToken,
    ) -> Result<Self, VoiceError> {
        if !is_loopback_base_url(base_url) {
            return Err(VoiceError::InvalidEndpointUrl {
                field: "llm_base_url",
                reason: "realtime voice WebSocket requires a loopback host".to_string(),
            });
        }
        let ws_url = derive_realtime_ws_url(base_url);
        let endpoint = ws_url.to_string();
        let (ws, _) = connect_ws_bounded(&ws_url, &endpoint, cancel).await?;
        let mut session = Self { endpoint, ws };
        session
            .wait_for_event_type("session.created", cancel)
            .await?;
        session
            .send_initial_session_update(instructions, tools, cancel)
            .await?;
        Ok(session)
    }

    async fn send_initial_session_update(
        &mut self,
        instructions: &str,
        tools: Value,
        cancel: &CancellationToken,
    ) -> Result<(), VoiceError> {
        // Omit `output_modalities` so LFM3 stays in auto mode (emitting streaming text+audio on
        // chat turns AND native `function_call` items on tool turns). llama.cpp also rejects
        // mid-call `session.update` mutations after turn 1, so this is sent once at connect.
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

    async fn send_json(
        &mut self,
        payload: &Value,
        cancel: &CancellationToken,
    ) -> Result<(), VoiceError> {
        if cancel.is_cancelled() {
            return Err(VoiceError::Cancelled);
        }
        let text = payload.to_string();
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(VoiceError::Cancelled),
            res = self.ws.send(Message::Text(text.into())) => res.map_err(|err| VoiceError::InvalidResponse {
                endpoint: self.endpoint.clone(),
                reason: format!("realtime WebSocket send failed: {err}"),
            }),
        }
    }

    async fn recv_event(&mut self, cancel: &CancellationToken) -> Result<Value, VoiceError> {
        loop {
            let next = tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(VoiceError::Cancelled),
                msg = self.ws.next() => msg,
            };
            let Some(frame) = next else {
                return Err(VoiceError::InvalidResponse {
                    endpoint: self.endpoint.clone(),
                    reason: "realtime WebSocket closed unexpectedly".to_string(),
                });
            };
            match frame.map_err(|err| VoiceError::InvalidResponse {
                endpoint: self.endpoint.clone(),
                reason: format!("realtime WebSocket receive failed: {err}"),
            })? {
                Message::Text(text) => {
                    return serde_json::from_str::<Value>(&text).map_err(|err| {
                        VoiceError::InvalidResponse {
                            endpoint: self.endpoint.clone(),
                            reason: format!("invalid realtime JSON event: {err}"),
                        }
                    });
                }
                Message::Ping(payload) => {
                    let _ = self.ws.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => {
                    return Err(VoiceError::InvalidResponse {
                        endpoint: self.endpoint.clone(),
                        reason: "realtime WebSocket closed by server".to_string(),
                    });
                }
                Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
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
                        reason: format!("timed out waiting for realtime event {expected}"),
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

    async fn collect_response(
        &mut self,
        cancel: &CancellationToken,
        on_pcmu_frame: OnPcmuFrame<'_>,
    ) -> Result<RealtimeTurnOutput, VoiceError> {
        let mut spoken_text = String::new();
        let mut encoder = Lfm3OutputEncoder::new();
        let mut samples_buf: Vec<i16> = Vec::new();
        loop {
            let event = match self.recv_event(cancel).await {
                Ok(ev) => ev,
                Err(VoiceError::Cancelled) => {
                    self.cancel_and_drain().await;
                    return Ok(RealtimeTurnOutput {
                        spoken_text: spoken_text.trim().to_string(),
                        tool_calls: Vec::new(),
                        audio_frames_emitted: encoder.frames_emitted(),
                        cancelled: true,
                    });
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
                    decode_audio_delta(&event, &mut samples_buf)?;
                    if !samples_buf.is_empty() {
                        encoder.push_pcm24k(&samples_buf, on_pcmu_frame);
                    }
                }
                "response.done" => {
                    return Ok(finish_done_event(
                        &event,
                        spoken_text,
                        &mut encoder,
                        on_pcmu_frame,
                    ));
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

impl RealtimeModelSession for Lfm3RealtimeSession {
    fn run_audio_turn<'a>(
        &'a mut self,
        pcm_8k: &'a [i16],
        cancel: &'a CancellationToken,
        on_pcmu_frame: OnPcmuFrame<'a>,
    ) -> BoxFuture<'a, Result<RealtimeTurnOutput, VoiceError>> {
        Box::pin(async move {
            let pcm_16k = upsample_8k_to_16k(pcm_8k);
            if pcm_16k.is_empty() {
                return Ok(empty_turn_output());
            }
            self.send_json(&json!({ "type": "input_audio_buffer.clear" }), cancel)
                .await?;
            for chunk in pcm_16k.chunks(REALTIME_AUDIO_APPEND_SAMPLES) {
                let mut bytes = Vec::with_capacity(chunk.len().saturating_mul(2));
                for &sample in chunk {
                    bytes.extend_from_slice(&sample.to_le_bytes());
                }
                self.send_json(
                    &json!({
                        "type": "input_audio_buffer.append",
                        "audio": BASE64_STANDARD.encode(&bytes),
                    }),
                    cancel,
                )
                .await?;
            }
            self.send_json(&json!({ "type": "input_audio_buffer.commit" }), cancel)
                .await?;
            self.send_json(&json!({ "type": "response.create" }), cancel)
                .await?;
            self.collect_response(cancel, on_pcmu_frame).await
        })
    }

    fn run_text_turn<'a>(
        &'a mut self,
        user_text: &'a str,
        force_audio: bool,
        cancel: &'a CancellationToken,
        on_pcmu_frame: OnPcmuFrame<'a>,
    ) -> BoxFuture<'a, Result<RealtimeTurnOutput, VoiceError>> {
        Box::pin(async move {
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
            let request = response_create_payload(force_audio);
            self.send_json(&request, cancel).await?;
            self.collect_response(cancel, on_pcmu_frame).await
        })
    }

    fn submit_tool_output<'a>(
        &'a mut self,
        call_id: &'a str,
        output: &'a str,
        request_spoken_reply: bool,
        cancel: &'a CancellationToken,
        on_pcmu_frame: OnPcmuFrame<'a>,
    ) -> BoxFuture<'a, Result<RealtimeTurnOutput, VoiceError>> {
        Box::pin(async move {
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
                return Ok(empty_turn_output());
            }
            self.send_json(&response_create_payload(true), cancel)
                .await?;
            self.collect_response(cancel, on_pcmu_frame).await
        })
    }
}

async fn connect_ws_bounded(
    ws_url: &Url,
    endpoint: &str,
    cancel: &CancellationToken,
) -> Result<
    (
        RealtimeWs,
        tokio_tungstenite::tungstenite::http::Response<Option<Vec<u8>>>,
    ),
    VoiceError,
> {
    let connect_fut = connect_async(ws_url.as_str());
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(VoiceError::Cancelled),
        res = tokio::time::timeout(
            Duration::from_secs(REALTIME_CONNECT_TIMEOUT_SECS),
            connect_fut,
        ) => match res {
            Ok(Ok(pair)) => Ok(pair),
            Ok(Err(err)) => Err(VoiceError::InvalidResponse {
                endpoint: endpoint.to_string(),
                reason: format!("realtime WebSocket connect failed: {err}"),
            }),
            Err(_) => Err(VoiceError::InvalidResponse {
                endpoint: endpoint.to_string(),
                reason: "realtime WebSocket connect timed out".to_string(),
            }),
        },
    }
}

fn empty_turn_output() -> RealtimeTurnOutput {
    RealtimeTurnOutput {
        spoken_text: String::new(),
        tool_calls: Vec::new(),
        audio_frames_emitted: 0,
        cancelled: false,
    }
}

fn response_create_payload(force_audio: bool) -> Value {
    if force_audio {
        json!({
            "type": "response.create",
            "response": { "output_modalities": ["text", "audio"] },
        })
    } else {
        json!({ "type": "response.create" })
    }
}

fn finish_done_event(
    event: &Value,
    spoken_text: String,
    encoder: &mut Lfm3OutputEncoder,
    on_pcmu_frame: OnPcmuFrame<'_>,
) -> RealtimeTurnOutput {
    let status = event
        .pointer("/response/status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let cancelled = status == "cancelled";
    if !cancelled {
        encoder.flush_tail(&mut |frame| on_pcmu_frame(frame));
    }
    RealtimeTurnOutput {
        spoken_text: spoken_text.trim().to_string(),
        tool_calls: parse_raw_tool_calls(event),
        audio_frames_emitted: encoder.frames_emitted(),
        cancelled,
    }
}
