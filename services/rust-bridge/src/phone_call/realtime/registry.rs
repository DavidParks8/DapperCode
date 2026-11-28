#![forbid(unsafe_code)]

use super::lfm3_strategy::Lfm3AudioStrategy;
use super::strategy::RealtimeModelStrategy;
use crate::phone_call::voice::VoicePipelineClient;
use std::sync::Arc;

/// Central registry for realtime speech-to-speech model strategies.
/// Registering or swapping a realtime model requires only implementing [`RealtimeModelStrategy`]
/// and adding it here.
#[derive(Clone)]
pub struct RealtimeStrategyRegistry {
    strategies: Vec<Arc<dyn RealtimeModelStrategy>>,
}

impl Default for RealtimeStrategyRegistry {
    fn default() -> Self {
        Self::new(vec![Arc::new(Lfm3AudioStrategy)])
    }
}

impl RealtimeStrategyRegistry {
    #[must_use]
    pub fn new(strategies: Vec<Arc<dyn RealtimeModelStrategy>>) -> Self {
        Self { strategies }
    }

    #[must_use]
    pub fn resolve_for_client(
        &self,
        client: &VoicePipelineClient,
    ) -> Option<Arc<dyn RealtimeModelStrategy>> {
        self.strategies
            .iter()
            .find(|strategy| {
                strategy.matches_endpoints(
                    client.llm_model(),
                    client.llm_base_url(),
                    client.tts_base_url(),
                )
            })
            .cloned()
    }

    #[cfg(test)]
    #[must_use]
    pub fn supports_model(&self, model: &str) -> bool {
        self.strategies
            .iter()
            .any(|strategy| strategy.matches_model(model))
    }
}
