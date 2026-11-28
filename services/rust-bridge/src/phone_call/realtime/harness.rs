#![forbid(unsafe_code)]

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "harness_tests.rs"]
pub(super) mod tests;

use super::farewell::{
    finish_cancelled_call, finish_deadline_call, finish_pending_end, maybe_arm_mutual_farewell,
    record_cancelled_speech, record_completed_speech,
};
use super::registry::RealtimeStrategyRegistry;
use super::state::{
    RealtimeAudioState, RealtimeDialogState, RealtimeLoopState, RealtimeTurnRequest,
};
use super::strategy::{
    RealtimeConnectConfig, RealtimeModelSession, RealtimeModelStrategy, RealtimeTurnOutput,
};
use super::tool_loop::{
    dispatch_tool_calls, handle_pending_tool_done, poll_pending_tools, ToolJoinResult,
};
use super::tools::RealtimeToolRegistry;
use super::turn_runner::{
    cancel_active_turn, flush_deferred_audio_turn, handle_completed_utterance,
    handle_short_check_result, maybe_dispatch_pending_turn, poll_active_realtime_turn,
    poll_short_check, process_inbound_frame, queue_opening_greeting, record_user_text,
};
use crate::phone_call::audio::VadEvent;
use crate::phone_call::sip::{InboundRtpAudioFrame, SipCallEvent, SipCallHandle};
use crate::phone_call::voice::VoiceError;
use crate::phone_call::{
    publish_in_call_card_update, recv_optional_inbound_audio, recv_optional_sip_event,
    requests_immediate_speech_stop, set_call_hold, settle_connected_call, sync_shared_transcript,
    wait_for_pending_end, CallLoopExit, ConnectedCallContext,
};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

type TurnJoinResult = Result<
    (
        Box<dyn RealtimeModelSession>,
        Result<RealtimeTurnOutput, VoiceError>,
    ),
    tokio::task::JoinError,
>;
type ShortCheckJoinResult = Result<Result<Option<String>, VoiceError>, tokio::task::JoinError>;

enum HarnessEvent {
    Cancelled,
    CallDeadline,
    PendingEndReady,
    Sip(Option<SipCallEvent>),
    Steer(String),
    BackgroundAsr(String, bool),
    InboundAudio(Option<Box<InboundRtpAudioFrame>>),
    SpeechQuiet,
    ContinuationDue,
    ShortCheckDone(ShortCheckJoinResult),
    ToolDone(usize, ToolJoinResult),
    TurnDone(TurnJoinResult),
    OpeningDue,
}

/// Runs a connected realtime speech-to-speech phone call using the registered strategy and tool
/// registry for the configured model.
pub(in crate::phone_call) async fn run_connected_realtime_call(mut ctx: ConnectedCallContext) {
    let registry = RealtimeStrategyRegistry::default();
    let sip_handle = ctx.sip_session.control_handle();
    let Some(strategy) = registry.resolve_for_client(&ctx.voice_client) else {
        let _ = sip_handle.hangup().await;
        settle_connected_call(
            &ctx,
            Vec::new(),
            CallLoopExit::Failed {
                error: format!(
                    "no realtime voice strategy registered for model '{}'",
                    ctx.voice_client.llm_model(),
                ),
            },
        )
        .await;
        return;
    };
    let tools = RealtimeToolRegistry::with_default_phone_tools(
        Arc::clone(&strategy),
        ctx.voice_client.clone(),
        ctx.slot.cancel.child_token(),
    );
    run_connected_realtime_call_with_strategy(&mut ctx, strategy, tools).await;
}

/// Entrypoint accepting injected strategy and tool registries for dependency inversion and testing.
pub(in crate::phone_call) async fn run_connected_realtime_call_with_strategy(
    ctx: &mut ConnectedCallContext,
    strategy: Arc<dyn RealtimeModelStrategy>,
    tools: RealtimeToolRegistry,
) {
    let sip_handle = ctx.sip_session.control_handle();
    let mut event_rx = ctx.sip_session.take_event_receiver();
    let mut inbound_audio_rx = ctx.sip_session.take_inbound_audio_receiver();
    let dialog = RealtimeDialogState::new(ctx, strategy, tools);

    let Some(session) = connect_realtime_or_settle(ctx, &sip_handle, &dialog).await else {
        return;
    };

    let mut state = RealtimeLoopState {
        dialog,
        audio: RealtimeAudioState::new(),
        transport_on_hold: false,
        opening_greeting_pending: true,
        opening_window_elapsed: false,
        pending_turn: None,
        pending_end: None,
        session: Some(session),
        active_turn: None,
    };

    let opening_deadline = tokio::time::Instant::now() + ctx.service.timeouts.opening_greeting_wait;
    let call_deadline = tokio::time::Instant::now() + ctx.service.timeouts.max_call_duration;

    let exit = run_realtime_loop(
        ctx,
        &sip_handle,
        &mut event_rx,
        &mut inbound_audio_rx,
        &mut state,
        opening_deadline,
        call_deadline,
    )
    .await;

    ctx.slot.cancel.cancel();
    settle_connected_call(ctx, state.dialog.conversation.transcript().to_vec(), exit).await;
}

async fn connect_realtime_or_settle(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    dialog: &RealtimeDialogState,
) -> Option<Box<dyn RealtimeModelSession>> {
    let connect_config = RealtimeConnectConfig {
        base_url: ctx.voice_client.llm_base_url().clone(),
        model: ctx.voice_client.llm_model().to_string(),
        prompt_params: dialog.prompt_params.clone(),
        initial_steers: ctx.initial_steers.clone(),
        tools: dialog.tools.specs(),
    };
    match dialog
        .strategy
        .connect(&connect_config, &ctx.slot.cancel)
        .await
    {
        Ok(session) => Some(session),
        Err(VoiceError::Cancelled) => {
            let _ = sip_handle.hangup().await;
            settle_connected_call(
                ctx,
                dialog.conversation.transcript().to_vec(),
                CallLoopExit::Completed {
                    end_reason: "mobile_hangup".to_string(),
                    outcome_summary: None,
                },
            )
            .await;
            None
        }
        Err(err) => {
            let _ = sip_handle.hangup().await;
            settle_connected_call(
                ctx,
                dialog.conversation.transcript().to_vec(),
                CallLoopExit::Failed {
                    error: format!("{} ({}): {err}", dialog.strategy.id(), connect_config.model),
                },
            )
            .await;
            None
        }
    }
}

async fn run_realtime_loop(
    ctx: &mut ConnectedCallContext,
    sip_handle: &SipCallHandle,
    event_rx: &mut Option<mpsc::Receiver<SipCallEvent>>,
    inbound_audio_rx: &mut Option<mpsc::Receiver<InboundRtpAudioFrame>>,
    state: &mut RealtimeLoopState,
    opening_deadline: tokio::time::Instant,
    call_deadline: tokio::time::Instant,
) -> CallLoopExit {
    loop {
        let event = poll_next_event(
            ctx,
            event_rx,
            inbound_audio_rx,
            state,
            opening_deadline,
            call_deadline,
        )
        .await;
        if let Some(exit) =
            handle_harness_event(ctx, sip_handle, event_rx, inbound_audio_rx, state, event).await
        {
            return exit;
        }
        maybe_dispatch_pending_turn(ctx, sip_handle, state);
    }
}

async fn poll_next_event(
    ctx: &mut ConnectedCallContext,
    event_rx: &mut Option<mpsc::Receiver<SipCallEvent>>,
    inbound_audio_rx: &mut Option<mpsc::Receiver<InboundRtpAudioFrame>>,
    state: &mut RealtimeLoopState,
    opening_deadline: tokio::time::Instant,
    call_deadline: tokio::time::Instant,
) -> HarnessEvent {
    let pending_end_ready = state.pending_end.is_some()
        && state.active_turn.is_none()
        && state.pending_turn.is_none()
        && state.dialog.pending_tools.is_none();
    let opening_ready = state.opening_greeting_pending
        && !state.opening_window_elapsed
        && state.active_turn.is_none();
    let quiet_at = state.audio.speech_quiet_deadline.unwrap_or(call_deadline);
    let cont_at = state.audio.continuation_deadline.unwrap_or(call_deadline);
    tokio::select! {
        biased;
        () = ctx.slot.cancel.cancelled() => HarnessEvent::Cancelled,
        () = tokio::time::sleep_until(call_deadline) => HarnessEvent::CallDeadline,
        () = wait_for_pending_end(&state.pending_end), if pending_end_ready => HarnessEvent::PendingEndReady,
        sip_ev = recv_optional_sip_event(event_rx), if event_rx.is_some() => HarnessEvent::Sip(sip_ev),
        Some(text) = ctx.steer_rx.recv() => HarnessEvent::Steer(text),
        Some((text, near)) = state.audio.bg_asr_rx.recv() => HarnessEvent::BackgroundAsr(text, near),
        audio_opt = recv_optional_inbound_audio(inbound_audio_rx), if inbound_audio_rx.is_some() => HarnessEvent::InboundAudio(audio_opt.map(Box::new)),
        () = tokio::time::sleep_until(quiet_at), if state.audio.speech_quiet_deadline.is_some() => HarnessEvent::SpeechQuiet,
        () = tokio::time::sleep_until(cont_at), if state.audio.continuation_deadline.is_some() => HarnessEvent::ContinuationDue,
        res = poll_short_check(&mut state.audio.short_check), if state.audio.short_check.is_some() => HarnessEvent::ShortCheckDone(res),
        (idx, res) = poll_pending_tools(&mut state.dialog.pending_tools), if state.dialog.pending_tools.is_some() => HarnessEvent::ToolDone(idx, res),
        res = poll_active_realtime_turn(&mut state.active_turn), if state.active_turn.is_some() => HarnessEvent::TurnDone(res),
        () = tokio::time::sleep_until(opening_deadline), if opening_ready => HarnessEvent::OpeningDue,
    }
}

async fn handle_harness_event(
    ctx: &mut ConnectedCallContext,
    sip_handle: &SipCallHandle,
    event_rx: &mut Option<mpsc::Receiver<SipCallEvent>>,
    inbound_audio_rx: &mut Option<mpsc::Receiver<InboundRtpAudioFrame>>,
    state: &mut RealtimeLoopState,
    event: HarnessEvent,
) -> Option<CallLoopExit> {
    match event {
        HarnessEvent::Cancelled => Some(finish_cancelled_call(ctx, sip_handle, state).await),
        HarnessEvent::CallDeadline => Some(finish_deadline_call(sip_handle, state).await),
        HarnessEvent::PendingEndReady => Some(finish_pending_end(sip_handle, state).await),
        HarnessEvent::Sip(sip_ev) => {
            handle_sip_event_opt(ctx, sip_handle, event_rx, state, sip_ev).await
        }
        HarnessEvent::Steer(text) => {
            handle_realtime_steer(ctx, sip_handle, state, &text).await;
            None
        }
        HarnessEvent::BackgroundAsr(text, near) => {
            handle_background_asr(ctx, state, &text, near).await;
            None
        }
        HarnessEvent::InboundAudio(frame_opt) => {
            handle_inbound_audio_opt(
                ctx,
                sip_handle,
                inbound_audio_rx,
                state,
                frame_opt.map(|boxed| *boxed),
            )
            .await;
            None
        }
        HarnessEvent::SpeechQuiet => {
            handle_speech_quiet(ctx, sip_handle, state).await;
            None
        }
        HarnessEvent::ContinuationDue => {
            state.audio.continuation_deadline = None;
            flush_deferred_audio_turn(ctx, sip_handle, state).await;
            None
        }
        HarnessEvent::ShortCheckDone(res) => {
            handle_short_check_result(ctx, sip_handle, state, res).await;
            None
        }
        HarnessEvent::ToolDone(idx, res) => {
            handle_pending_tool_done(state, idx, res);
            None
        }
        HarnessEvent::TurnDone(res) => handle_realtime_turn_done(ctx, sip_handle, state, res).await,
        HarnessEvent::OpeningDue => {
            state.opening_window_elapsed = true;
            queue_opening_greeting(state);
            None
        }
    }
}

async fn handle_sip_event_opt(
    ctx: &mut ConnectedCallContext,
    sip_handle: &SipCallHandle,
    event_rx: &mut Option<mpsc::Receiver<SipCallEvent>>,
    state: &mut RealtimeLoopState,
    sip_ev: Option<SipCallEvent>,
) -> Option<CallLoopExit> {
    let Some(event) = sip_ev else {
        *event_rx = None;
        return None;
    };
    match event {
        SipCallEvent::Ended { reason } => {
            cancel_active_turn(state, sip_handle);
            Some(CallLoopExit::Completed {
                end_reason: reason,
                outcome_summary: None,
            })
        }
        SipCallEvent::HoldChanged {
            on_hold,
            negotiated_dtmf_pt,
        } => {
            ctx.negotiated_dtmf_pt = negotiated_dtmf_pt;
            if state.transport_on_hold != on_hold {
                state.transport_on_hold = on_hold;
                set_call_hold(&ctx.slot, &mut state.dialog.conversation, on_hold);
                state.audio.vad.set_ivr_mode(on_hold);
                if on_hold {
                    cancel_active_turn(state, sip_handle);
                }
                publish_in_call_card_update(ctx, state.dialog.conversation.transcript()).await;
            }
            None
        }
        SipCallEvent::Ringing | SipCallEvent::Connected { .. } => None,
    }
}

async fn handle_realtime_steer(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    instruction: &str,
) {
    state.dialog.conversation.inject_steer(instruction);
    sync_shared_transcript(&ctx.slot, state.dialog.conversation.transcript());
    publish_in_call_card_update(ctx, state.dialog.conversation.transcript()).await;
    if requests_immediate_speech_stop(instruction) {
        cancel_active_turn(state, sip_handle);
    }
    if !state.transport_on_hold {
        state.opening_greeting_pending = false;
        state.pending_turn = Some(RealtimeTurnRequest::Text {
            prompt: format!(
                "[Private live instruction from caller]: {instruction}. Follow this naturally on the call.",
            ),
            force_audio: true,
        });
    }
}

async fn handle_background_asr(
    ctx: &ConnectedCallContext,
    state: &mut RealtimeLoopState,
    text: &str,
    near_audio: bool,
) {
    if !state
        .audio
        .echo_tracker
        .matches_self_echo(text, near_audio, None, Instant::now())
    {
        state.dialog.last_callee_text = Some(text.to_string());
        record_user_text(ctx, state, text).await;
    }
}

async fn handle_inbound_audio_opt(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    inbound_audio_rx: &mut Option<mpsc::Receiver<InboundRtpAudioFrame>>,
    state: &mut RealtimeLoopState,
    frame_opt: Option<InboundRtpAudioFrame>,
) {
    let Some(frame) = frame_opt else {
        *inbound_audio_rx = None;
        return;
    };
    if let Some((samples, near)) = process_inbound_frame(ctx, sip_handle, state, frame).await {
        handle_completed_utterance(ctx, sip_handle, state, samples, near).await;
    }
}

async fn handle_speech_quiet(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
) {
    state.audio.speech_quiet_deadline = None;
    if let Some(VadEvent::UtteranceComplete(samples)) = state.audio.vad.finish_after_media_quiet() {
        let near = state.audio.take_utterance_near_outbound(Instant::now());
        handle_completed_utterance(ctx, sip_handle, state, samples, near).await;
    }
}

async fn handle_realtime_turn_done(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    join_res: TurnJoinResult,
) -> Option<CallLoopExit> {
    state.active_turn = None;
    let (session, turn_res) = match join_res {
        Ok(pair) => pair,
        Err(err) => {
            let _ = sip_handle.hangup().await;
            return Some(CallLoopExit::Failed {
                error: format!("realtime voice task failed: {err}"),
            });
        }
    };
    state.session = Some(session);

    let out = match turn_res {
        Ok(out) => out,
        Err(VoiceError::Cancelled) => return None,
        Err(err) => {
            let _ = sip_handle.hangup().await;
            return Some(CallLoopExit::Failed {
                error: err.to_string(),
            });
        }
    };
    if out.cancelled {
        record_cancelled_speech(ctx, state, &out.spoken_text).await;
        return None;
    }

    let had_tools = !out.tool_calls.is_empty();
    record_completed_speech(ctx, state, &out.spoken_text).await;
    if let Some(exit) = dispatch_tool_calls(
        ctx,
        sip_handle,
        state,
        out.tool_calls,
        !out.spoken_text.is_empty(),
    )
    .await
    {
        return Some(exit);
    }
    maybe_arm_mutual_farewell(state, had_tools, &out.spoken_text);
    None
}
