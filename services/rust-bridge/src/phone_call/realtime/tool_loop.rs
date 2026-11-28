#![forbid(unsafe_code)]

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "tool_loop_tests.rs"]
pub(super) mod tests;

use super::state::{RealtimeLoopState, RealtimeTurnRequest, ToolOutputSubmission};
use super::strategy::{RealtimeModelSession, RealtimeToolInvocation, RealtimeTurnOutput};
use super::tools::{
    ActiveToolTask, FillerClip, RealtimeToolRegistry, ToolDispatch, ToolExecutionContext, ToolHost,
    ToolOutcome,
};
use crate::phone_call::audio::RTP_FRAME_SAMPLES;
use crate::phone_call::sip::SipCallHandle;
use crate::phone_call::voice::VoiceError;
use crate::phone_call::{
    transmit_dtmf, CallLoopExit, ConnectedCallContext, PendingCallEnd, END_CALL_QUIET_GRACE,
};
use std::future::Future;
use std::pin::Pin;
use std::task::Poll;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

pub(super) type ToolJoinResult = Result<ToolOutcome, tokio::task::JoinError>;

/// Tracks all immediate outputs and in-flight async tool tasks emitted by a single model response
/// so every `function_call` returns a `function_call_output` before the next model turn runs.
pub(super) struct PendingToolBatch {
    completed: Vec<ToolOutputSubmission>,
    request_spoken_reply: bool,
    active: Vec<ActiveToolTask>,
}

impl PendingToolBatch {
    pub(super) fn is_empty(&self) -> bool {
        self.active.is_empty()
    }

    pub(super) fn cancel_all(self) -> Vec<ToolOutputSubmission> {
        let mut outputs = self.completed;
        for task in self.active {
            task.cancel.cancel();
            task.handle.abort();
            outputs.push(ToolOutputSubmission {
                call_id: task.call_id,
                output: r#"{"cancelled":true}"#.to_string(),
            });
        }
        outputs
    }

    fn record_completed(&mut self, index: usize, join_res: ToolJoinResult) {
        let task = self.active.remove(index);
        match join_res {
            Ok(outcome) => {
                self.request_spoken_reply |= outcome.request_spoken_reply;
                self.completed.push(ToolOutputSubmission {
                    call_id: outcome.call_id,
                    output: outcome.output,
                });
            }
            Err(_) => {
                self.completed.push(ToolOutputSubmission {
                    call_id: task.call_id,
                    output: r#"{"cancelled":true}"#.to_string(),
                });
            }
        }
    }

    fn into_turn_request(self) -> Option<RealtimeTurnRequest> {
        if self.completed.is_empty() {
            return None;
        }
        Some(RealtimeTurnRequest::ToolOutputs {
            outputs: self.completed,
            request_spoken_reply: self.request_spoken_reply,
        })
    }
}

pub(super) struct BatchDispatchOutcome {
    pub batch: PendingToolBatch,
    pub filler: Option<FillerClip>,
}

/// Pure generic batch dispatcher that runs every invocation in a model turn against `registry`
/// without knowing about any concrete tool implementation.
pub(super) fn dispatch_tool_batch(
    registry: &RealtimeToolRegistry,
    invocations: Vec<RealtimeToolInvocation>,
    http: &reqwest::Client,
    host: &mut dyn ToolHost,
    call_cancel: &CancellationToken,
) -> BatchDispatchOutcome {
    let mut completed = Vec::new();
    let mut active = Vec::new();
    let mut request_spoken_reply = false;
    let mut filler = None;
    let mut tool_ctx = ToolExecutionContext {
        http,
        host,
        call_cancel,
    };
    for invocation in invocations {
        match registry.dispatch(invocation, &mut tool_ctx) {
            ToolDispatch::Immediate(outcome) => {
                request_spoken_reply |= outcome.request_spoken_reply;
                completed.push(ToolOutputSubmission {
                    call_id: outcome.call_id,
                    output: outcome.output,
                });
            }
            ToolDispatch::Async {
                task,
                filler: maybe_clip,
            } => {
                if filler.is_none() {
                    filler = maybe_clip;
                }
                active.push(task);
            }
        }
    }
    BatchDispatchOutcome {
        batch: PendingToolBatch {
            completed,
            request_spoken_reply,
            active,
        },
        filler,
    }
}

struct CallToolHost<'a> {
    ctx: &'a ConnectedCallContext,
    sip_handle: &'a SipCallHandle,
    state: &'a mut RealtimeLoopState,
    assistant_spoke_in_turn: bool,
    fatal_error: Option<String>,
}

impl ToolHost for CallToolHost<'_> {
    fn callee_has_spoken(&self) -> bool {
        self.state.dialog.callee_has_spoken
    }

    fn assistant_spoke_in_turn(&self) -> bool {
        self.assistant_spoke_in_turn
    }

    fn transmit_dtmf(&mut self, digits: &str) -> Result<(), String> {
        transmit_dtmf(self.sip_handle, self.ctx.negotiated_dtmf_pt, digits)
    }

    fn set_ivr_mode(&mut self, enabled: bool) {
        self.state.audio.vad.set_ivr_mode(enabled);
    }

    fn schedule_call_end(&mut self, reason: String, summary: String) {
        self.state.pending_end = Some(PendingCallEnd {
            reason,
            summary,
            deadline: tokio::time::Instant::now() + END_CALL_QUIET_GRACE,
        });
    }

    fn fail_call(&mut self, error: String) {
        if self.fatal_error.is_none() {
            self.fatal_error = Some(error);
        }
    }
}

/// Dispatches all tool invocations returned by a realtime model turn through the generic
/// [`RealtimeToolRegistry`], queueing every output and tracking every concurrent async task.
pub(super) async fn dispatch_tool_calls(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    invocations: Vec<RealtimeToolInvocation>,
    assistant_spoke_in_turn: bool,
) -> Option<CallLoopExit> {
    if invocations.is_empty() {
        return None;
    }
    if let Some(previous) = state.dialog.pending_tools.take() {
        state
            .dialog
            .cancelled_tool_outputs
            .extend(previous.cancel_all());
    }
    let tools = state.dialog.tools.clone();
    let (dispatched, fatal_error) = {
        let mut host = CallToolHost {
            ctx,
            sip_handle,
            state,
            assistant_spoke_in_turn,
            fatal_error: None,
        };
        let dispatched = dispatch_tool_batch(
            &tools,
            invocations,
            ctx.voice_client.http_client(),
            &mut host,
            &ctx.slot.cancel,
        );
        (dispatched, host.fatal_error)
    };
    if let Some(error) = fatal_error {
        let _ = dispatched.batch.cancel_all();
        let _ = sip_handle.hangup().await;
        return Some(CallLoopExit::Failed { error });
    }
    store_dispatched_batch(sip_handle, state, dispatched);
    None
}

fn store_dispatched_batch(
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    dispatched: BatchDispatchOutcome,
) {
    if dispatched.batch.is_empty() {
        if let Some(request) = dispatched.batch.into_turn_request() {
            state.pending_turn = Some(request);
        }
        return;
    }
    if let Some(clip) = dispatched.filler {
        let now = Instant::now();
        state
            .audio
            .echo_tracker
            .record_assistant_speech(clip.text, now);
        state.audio.last_outbound_at = Some(now);
        sip_handle.enqueue_pcmu_frames(clip.frames);
    }
    state.dialog.pending_tools = Some(dispatched.batch);
}

/// Polls all in-flight async tools in a cancel-safe manner, returning the index and join result
/// of the first task to complete.
pub(super) async fn poll_pending_tools(
    slot: &mut Option<PendingToolBatch>,
) -> (usize, ToolJoinResult) {
    let Some(batch) = slot.as_mut() else {
        return std::future::pending().await;
    };
    if batch.active.is_empty() {
        return std::future::pending().await;
    }
    std::future::poll_fn(|cx| {
        for (idx, task) in batch.active.iter_mut().enumerate() {
            if let Poll::Ready(res) = Pin::new(&mut task.handle).poll(cx) {
                return Poll::Ready((idx, res));
            }
        }
        Poll::Pending
    })
    .await
}

pub(super) fn handle_pending_tool_done(
    state: &mut RealtimeLoopState,
    index: usize,
    join_res: ToolJoinResult,
) {
    let Some(mut batch) = state.dialog.pending_tools.take() else {
        return;
    };
    batch.record_completed(index, join_res);
    if batch.is_empty() {
        if let Some(request) = batch.into_turn_request() {
            state.pending_turn = Some(request);
        }
    } else {
        state.dialog.pending_tools = Some(batch);
    }
}

/// Submits every completed tool output from a turn in order, triggering a model response only
/// after the final output when `request_spoken_reply` is true.
pub(super) async fn submit_tool_outputs_batch(
    session: &mut dyn RealtimeModelSession,
    outputs: &[ToolOutputSubmission],
    request_spoken_reply: bool,
    cancel: &CancellationToken,
    emit_frame: &mut (dyn FnMut([u8; RTP_FRAME_SAMPLES]) + Send),
) -> Result<RealtimeTurnOutput, VoiceError> {
    let mut last_out = RealtimeTurnOutput {
        spoken_text: String::new(),
        tool_calls: Vec::new(),
        audio_frames_emitted: 0,
        cancelled: false,
    };
    let last_idx = outputs.len().saturating_sub(1);
    for (idx, item) in outputs.iter().enumerate() {
        last_out = session
            .submit_tool_output(
                &item.call_id,
                &item.output,
                idx == last_idx && request_spoken_reply,
                cancel,
                emit_frame,
            )
            .await?;
    }
    Ok(last_out)
}
