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
