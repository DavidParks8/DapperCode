#![forbid(unsafe_code)]

use crate::phone_call::audio::RTP_FRAME_SAMPLES;
use crate::phone_call::voice::{VoiceCallPromptParams, VoiceError, VoicePipelineClient};
use reqwest::Url;
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

pub type BoxFuture<'a, Output> = Pin<Box<dyn Future<Output = Output> + Send + 'a>>;
pub type OnPcmuFrame<'a> = &'a mut (dyn FnMut([u8; RTP_FRAME_SAMPLES]) + Send);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimeToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub prompt_guidance: Option<&'static str>,
    pub parameters: Value,
}

impl RealtimeToolSpec {
    #[must_use]
    pub fn guidance(&self) -> &str {
        self.prompt_guidance.unwrap_or(self.description)
    }

    #[must_use]
    pub fn to_openai_tool_json(&self) -> Value {
        json!({
            "type": "function",
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimeToolInvocation {
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimeTurnOutput {
    pub spoken_text: String,
    pub tool_calls: Vec<RealtimeToolInvocation>,
    pub audio_frames_emitted: usize,
    pub cancelled: bool,
}

#[derive(Debug, Clone)]
pub struct RealtimeConnectConfig {
    pub base_url: Url,
    pub model: String,
    pub prompt_params: VoiceCallPromptParams,
    pub initial_steers: Vec<String>,
    pub tools: Vec<RealtimeToolSpec>,
}

/// Active realtime model session operating on 8 kHz telephony PCM input and 8 kHz PCMU output.
/// Implementations encapsulate wire protocol, resampling, headroom, and tool-call framing.
pub trait RealtimeModelSession: Send {
    fn run_audio_turn<'a>(
        &'a mut self,
        pcm_8k: &'a [i16],
        cancel: &'a CancellationToken,
        on_pcmu_frame: OnPcmuFrame<'a>,
    ) -> BoxFuture<'a, Result<RealtimeTurnOutput, VoiceError>>;

    fn run_text_turn<'a>(
        &'a mut self,
        user_text: &'a str,
        force_audio: bool,
        cancel: &'a CancellationToken,
        on_pcmu_frame: OnPcmuFrame<'a>,
    ) -> BoxFuture<'a, Result<RealtimeTurnOutput, VoiceError>>;

    fn submit_tool_output<'a>(
        &'a mut self,
        call_id: &'a str,
        output: &'a str,
        request_spoken_reply: bool,
        cancel: &'a CancellationToken,
        on_pcmu_frame: OnPcmuFrame<'a>,
    ) -> BoxFuture<'a, Result<RealtimeTurnOutput, VoiceError>>;
}

/// Strategy contract for a realtime speech-to-speech model family.
/// Adding or swapping a model only requires implementing this trait and registering it in
/// `RealtimeStrategyRegistry::default()`.
pub trait RealtimeModelStrategy: Send + Sync {
    fn id(&self) -> &'static str;

    fn matches_model(&self, model: &str) -> bool;

    /// Returns true when this strategy handles the configured model and endpoint topology.
    /// Defaults to matching on model name alone; strategies requiring a single shared endpoint
    /// can override this.
    fn matches_endpoints(&self, model: &str, _llm_base: &Url, _tts_base: &Url) -> bool {
        self.matches_model(model)
    }

    /// Checks whether the backing realtime provider is ready before dialing a call.
    fn check_readiness<'a>(
        &'a self,
        voice_client: &'a VoicePipelineClient,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<(), VoiceError>>;

    fn connect<'a>(
        &'a self,
        config: &'a RealtimeConnectConfig,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Box<dyn RealtimeModelSession>, VoiceError>>;

    fn transcribe_pcm_8k<'a>(
        &'a self,
        http: &'a reqwest::Client,
        base_url: &'a Url,
        model: &'a str,
        samples_8k: &'a [i16],
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Option<String>, VoiceError>>;

    fn synthesize_filler_frames<'a>(
        &'a self,
        voice_client: &'a VoicePipelineClient,
        phrase: &'a str,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Option<Vec<[u8; RTP_FRAME_SAMPLES]>>>;
}
