#![forbid(unsafe_code)]

use super::state::{RealtimeLoopState, RealtimeTurnRequest};
use super::strategy::RealtimeToolInvocation;
use super::tools::{DtmfTransmitter, ToolDispatch, ToolEffect, ToolExecutionContext, ToolOutcome};
use crate::phone_call::sip::SipCallHandle;
use crate::phone_call::{
    transmit_dtmf, CallLoopExit, ConnectedCallContext, PendingCallEnd, END_CALL_QUIET_GRACE,
};
use std::time::Instant;

pub(super) type ToolJoinResult = Result<ToolOutcome, tokio::task::JoinError>;

struct SipDtmfAdapter<'a> {
    sip_handle: &'a SipCallHandle,
    negotiated_dtmf_pt: Option<u8>,
}

impl DtmfTransmitter for SipDtmfAdapter<'_> {
    fn transmit(&self, digits: &str) -> Result<(), String> {
        transmit_dtmf(self.sip_handle, self.negotiated_dtmf_pt, digits)
    }
}

/// Dispatches all tool invocations returned by a realtime model turn through the generic
/// `RealtimeToolRegistry`, supporting both immediate and non-blocking async tools.
pub(super) async fn dispatch_tool_calls(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    invocations: Vec<RealtimeToolInvocation>,
    assistant_spoke_in_turn: bool,
) -> Option<CallLoopExit> {
    let dtmf = SipDtmfAdapter {
        sip_handle,
        negotiated_dtmf_pt: ctx.negotiated_dtmf_pt,
    };
    let tool_ctx = ToolExecutionContext {
        http: ctx.voice_client.http_client(),
        dtmf: &dtmf,
        callee_has_spoken: state.dialog.callee_has_spoken,
        assistant_spoke_in_turn,
        call_cancel: &ctx.slot.cancel,
    };
    for invocation in invocations {
        match state.dialog.tools.dispatch(invocation, &tool_ctx) {
            ToolDispatch::Immediate(outcome) => {
                if let Some(exit) = apply_tool_outcome(sip_handle, state, outcome).await {
                    return Some(exit);
                }
            }
            ToolDispatch::Async { task, filler } => {
                if let Some(clip) = filler {
                    let now = Instant::now();
                    state
                        .audio
                        .echo_tracker
                        .record_assistant_speech(clip.text, now);
                    state.audio.last_outbound_at = Some(now);
                    sip_handle.enqueue_pcmu_frames(clip.frames);
                }
                state.dialog.active_tool = Some(task);
            }
        }
    }
    None
}

pub(super) async fn handle_active_tool_done(
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    join_res: ToolJoinResult,
) -> Option<CallLoopExit> {
    let task = state.dialog.active_tool.take()?;
    match join_res {
        Ok(outcome) => apply_tool_outcome(sip_handle, state, outcome).await,
        Err(_) => {
            state.dialog.cancelled_tool_call_id = Some(task.call_id);
            None
        }
    }
}

async fn apply_tool_outcome(
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    outcome: ToolOutcome,
) -> Option<CallLoopExit> {
    match outcome.effect {
        ToolEffect::None => {}
        ToolEffect::SetIvrMode(enabled) => state.audio.vad.set_ivr_mode(enabled),
        ToolEffect::ScheduleCallEnd { reason, summary } => {
            state.pending_end = Some(PendingCallEnd {
                reason,
                summary,
                deadline: tokio::time::Instant::now() + END_CALL_QUIET_GRACE,
            });
        }
        ToolEffect::FailCall(error) => {
            let _ = sip_handle.hangup().await;
            return Some(CallLoopExit::Failed { error });
        }
    }
    state.pending_turn = Some(RealtimeTurnRequest::ToolOutput {
        call_id: outcome.call_id,
        output: outcome.output,
        request_spoken_reply: outcome.request_spoken_reply,
    });
    None
}
