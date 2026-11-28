#![forbid(unsafe_code)]

pub(crate) mod farewell;
pub(crate) mod harness;
pub(crate) mod lfm3_audio;
pub(crate) mod lfm3_strategy;
pub(crate) mod registry;
pub(crate) mod strategy;
pub(crate) mod tools;

pub(in crate::phone_call) use harness::run_connected_realtime_call;
pub(crate) use lfm3_strategy::DEFAULT_LFM3_AUDIO_MODEL;

mod state;
mod tool_loop;
mod turn_runner;

use registry::RealtimeStrategyRegistry;

/// Returns true when any registered realtime speech-to-speech strategy handles `model`.
#[must_use]
pub fn is_realtime_s2s_model(model: &str) -> bool {
    RealtimeStrategyRegistry::default().supports_model(model)
}
