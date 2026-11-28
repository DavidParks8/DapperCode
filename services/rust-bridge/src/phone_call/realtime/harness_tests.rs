use crate::phone_call::audio::RTP_FRAME_SAMPLES;
use crate::phone_call::realtime::farewell::is_mutual_farewell;
use crate::phone_call::realtime::registry::RealtimeStrategyRegistry;
use crate::phone_call::realtime::strategy::{
    BoxFuture, OnPcmuFrame, RealtimeConnectConfig, RealtimeModelSession, RealtimeModelStrategy,
    RealtimeTurnOutput,
};
use crate::phone_call::realtime::turn_runner::should_precheck_utterance;
use crate::phone_call::voice::{VoiceError, VoicePipelineClient};
use reqwest::Url;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

struct FakeCustomRealtimeSession;

impl RealtimeModelSession for FakeCustomRealtimeSession {
    fn run_audio_turn<'a>(
        &'a mut self,
        _pcm_8k: &'a [i16],
        _cancel: &'a CancellationToken,
        _on_pcmu_frame: OnPcmuFrame<'a>,
    ) -> BoxFuture<'a, Result<RealtimeTurnOutput, VoiceError>> {
        Box::pin(async {
            Ok(RealtimeTurnOutput {
                spoken_text: "Hello from fake strategy.".to_string(),
                tool_calls: Vec::new(),
                audio_frames_emitted: 0,
                cancelled: false,
            })
        })
    }

    fn run_text_turn<'a>(
        &'a mut self,
        _user_text: &'a str,
        _force_audio: bool,
        _cancel: &'a CancellationToken,
        _on_pcmu_frame: OnPcmuFrame<'a>,
    ) -> BoxFuture<'a, Result<RealtimeTurnOutput, VoiceError>> {
        Box::pin(async {
            Ok(RealtimeTurnOutput {
                spoken_text: "Fake greeting.".to_string(),
                tool_calls: Vec::new(),
                audio_frames_emitted: 0,
                cancelled: false,
            })
        })
    }

    fn submit_tool_output<'a>(
        &'a mut self,
        _call_id: &'a str,
        _output: &'a str,
        _request_spoken_reply: bool,
        _cancel: &'a CancellationToken,
        _on_pcmu_frame: OnPcmuFrame<'a>,
    ) -> BoxFuture<'a, Result<RealtimeTurnOutput, VoiceError>> {
        Box::pin(async {
            Ok(RealtimeTurnOutput {
                spoken_text: String::new(),
                tool_calls: Vec::new(),
                audio_frames_emitted: 0,
                cancelled: false,
            })
        })
    }
}

struct FakeCustomRealtimeStrategy;

impl RealtimeModelStrategy for FakeCustomRealtimeStrategy {
    fn id(&self) -> &'static str {
        "fake-custom-realtime"
    }

    fn matches_model(&self, model: &str) -> bool {
        model.starts_with("custom-realtime/")
    }

    fn connect<'a>(
        &'a self,
        _config: &'a RealtimeConnectConfig,
        _cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Box<dyn RealtimeModelSession>, VoiceError>> {
        Box::pin(async { Ok(Box::new(FakeCustomRealtimeSession) as Box<dyn RealtimeModelSession>) })
    }

    fn transcribe_pcm_8k<'a>(
        &'a self,
        _http: &'a reqwest::Client,
        _base_url: &'a Url,
        _model: &'a str,
        _samples_8k: &'a [i16],
        _cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Option<String>, VoiceError>> {
        Box::pin(async { Ok(Some("fake transcript".to_string())) })
    }

    fn synthesize_filler_frames<'a>(
        &'a self,
        _voice_client: &'a VoicePipelineClient,
        _phrase: &'a str,
        _cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Option<Vec<[u8; RTP_FRAME_SAMPLES]>>> {
        Box::pin(async { None })
    }
}

#[test]
fn strategy_registry_swaps_models_without_touching_harness() {
    let default_registry = RealtimeStrategyRegistry::default();
    assert!(default_registry.supports_model("LiquidAI/LFM3-Audio-2B-GGUF:Q8_0"));
    assert!(!default_registry.supports_model("custom-realtime/v1"));

    let custom_registry = RealtimeStrategyRegistry::new(vec![Arc::new(FakeCustomRealtimeStrategy)]);
    let resolved = custom_registry
        .resolve("custom-realtime/v1")
        .expect("custom strategy resolved");
    assert_eq!(resolved.id(), "fake-custom-realtime");
    assert!(!custom_registry.supports_model("LiquidAI/LFM3-Audio-2B-GGUF:Q8_0"));
}

#[test]
fn harness_farewell_and_precheck_helpers_handle_edge_cases() {
    assert!(is_mutual_farewell(
        Some("Goodbye."),
        "Goodbye! Have a great day!",
    ));
    assert!(is_mutual_farewell(
        Some("Okay, bye!"),
        "Take care, talk to you later!",
    ));
    assert!(!is_mutual_farewell(
        Some("Bye, daddy!"),
        "Goodbye! Have a great day!",
    ));
    assert!(!is_mutual_farewell(
        Some("Can you play Goodbye Yellow Brick Road for me please?"),
        "Sure, I can talk about that song!",
    ));
    assert!(!is_mutual_farewell(
        Some("How is white chocolate made?"),
        "Have a great day!",
    ));

    assert!(should_precheck_utterance(24_000, true));
    assert!(!should_precheck_utterance(48_000, true));
    assert!(should_precheck_utterance(4_000, false));
    assert!(!should_precheck_utterance(24_000, false));
}
