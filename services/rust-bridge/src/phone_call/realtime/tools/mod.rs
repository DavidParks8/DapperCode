#![forbid(unsafe_code)]

pub(crate) mod end_call;
pub(crate) mod send_dtmf;
pub(crate) mod web_search;

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "mod_tests.rs"]
pub(super) mod tests;

use super::strategy::{BoxFuture, RealtimeModelStrategy, RealtimeToolInvocation, RealtimeToolSpec};
use crate::phone_call::audio::RTP_FRAME_SAMPLES;
use crate::phone_call::voice::VoicePipelineClient;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct FillerClip {
    pub text: &'static str,
    pub frames: Vec<[u8; RTP_FRAME_SAMPLES]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolEffect {
    None,
    SetIvrMode(bool),
    ScheduleCallEnd { reason: String, summary: String },
    FailCall(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutcome {
    pub call_id: String,
    pub output: String,
    pub request_spoken_reply: bool,
    pub effect: ToolEffect,
}

pub struct ActiveToolTask {
    pub cancel: CancellationToken,
    pub call_id: String,
    pub handle: JoinHandle<ToolOutcome>,
}

pub enum ToolDispatch {
    Immediate(ToolOutcome),
    Async {
        task: ActiveToolTask,
        filler: Option<FillerClip>,
    },
}

/// Abstraction for transmitting DTMF tones so `SendDtmfTool` does not depend on SIP internals.
pub trait DtmfTransmitter: Send + Sync {
    fn transmit(&self, digits: &str) -> Result<(), String>;
}

/// Shared execution context passed to self-contained realtime tools.
pub struct ToolExecutionContext<'a> {
    pub http: &'a reqwest::Client,
    pub dtmf: &'a dyn DtmfTransmitter,
    pub callee_has_spoken: bool,
    pub assistant_spoke_in_turn: bool,
    pub call_cancel: &'a CancellationToken,
}

/// Self-contained realtime tool contract (Microsoft Agent Framework-style).
pub trait RealtimeTool: Send + Sync {
    fn name(&self) -> &'static str;

    fn spec(&self) -> RealtimeToolSpec;

    fn dispatch(
        self: Arc<Self>,
        invocation: RealtimeToolInvocation,
        ctx: &ToolExecutionContext<'_>,
    ) -> ToolDispatch;
}

/// Generic registry that exposes tool schemas to the realtime model and dispatches tool
/// invocations without the call loop knowing about any concrete tool implementation.
#[derive(Clone, Default)]
pub struct RealtimeToolRegistry {
    ordered: Vec<Arc<dyn RealtimeTool>>,
    by_name: HashMap<&'static str, Arc<dyn RealtimeTool>>,
}

impl RealtimeToolRegistry {
    #[must_use]
    pub fn with_default_phone_tools(
        strategy: Arc<dyn RealtimeModelStrategy>,
        voice_client: VoicePipelineClient,
        cancel: CancellationToken,
    ) -> Self {
        let mut registry = Self::default();
        registry.register(Arc::new(send_dtmf::SendDtmfTool));
        registry.register(Arc::new(web_search::WebSearchTool::new(
            strategy,
            voice_client,
            cancel,
        )));
        registry.register(Arc::new(end_call::EndCallTool));
        registry
    }

    pub fn register(&mut self, tool: Arc<dyn RealtimeTool>) {
        let name = tool.name();
        self.by_name.insert(name, Arc::clone(&tool));
        self.ordered.retain(|existing| existing.name() != name);
        self.ordered.push(tool);
    }

    #[must_use]
    pub fn specs(&self) -> Vec<RealtimeToolSpec> {
        self.ordered.iter().map(|tool| tool.spec()).collect()
    }

    #[must_use]
    pub fn dispatch(
        &self,
        invocation: RealtimeToolInvocation,
        ctx: &ToolExecutionContext<'_>,
    ) -> ToolDispatch {
        let Some(tool) = self.by_name.get(invocation.name.as_str()).cloned() else {
            return ToolDispatch::Immediate(ToolOutcome {
                call_id: invocation.call_id,
                output: r#"{"error":"unknown_tool"}"#.to_string(),
                request_spoken_reply: false,
                effect: ToolEffect::None,
            });
        };
        tool.dispatch(invocation, ctx)
    }
}

/// Convenience helper for spawning an async tool future as an [`ActiveToolTask`].
pub(crate) fn spawn_async_tool(
    call_id: String,
    call_cancel: &CancellationToken,
    future_fn: impl FnOnce(CancellationToken) -> BoxFuture<'static, ToolOutcome>,
) -> ActiveToolTask {
    let cancel = call_cancel.child_token();
    let fut = future_fn(cancel.clone());
    let handle = tokio::spawn(fut);
    ActiveToolTask {
        cancel,
        call_id,
        handle,
    }
}
