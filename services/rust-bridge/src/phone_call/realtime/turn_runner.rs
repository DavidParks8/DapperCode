#![forbid(unsafe_code)]

use super::state::{ActiveRealtimeTurn, PendingShortCheck, RealtimeLoopState, RealtimeTurnRequest};
use super::strategy::{RealtimeModelSession, RealtimeTurnOutput};
use super::tools::{ActiveToolTask, ToolOutcome};
use crate::phone_call::audio::{
    mulaw_frame_mean_abs, VadEvent, RTP_FRAME_SAMPLES, VAD_MAX_UTTERANCE_SAMPLES,
    VAD_PREROLL_FRAMES,
};
use crate::phone_call::room_attention::{AttentionDecision, UtteranceAcoustics};
use crate::phone_call::sip::{InboundRtpAudioFrame, SipCallHandle};
use crate::phone_call::voice::{is_substantive_reply, VoiceError};
use crate::phone_call::{
    is_incomplete_utterance, publish_in_call_card_update, set_call_hold, sync_shared_transcript,
    wait_for_outbound_media_drain, ConnectedCallContext, END_CALL_QUIET_GRACE,
    INCOMPLETE_UTTERANCE_DEFER,
};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const SHORT_SPEECH_CHECK_SAMPLES: usize = 16_000; // 2.0 s of net speech @ 8 kHz
const MAX_ECHO_PRECHECK_SAMPLES: usize = 40_000; // 5.0 s: longer clips are unambiguously human speech
const MAX_DEFERRED_AUDIO_SAMPLES: usize = VAD_MAX_UTTERANCE_SAMPLES;

#[must_use]
pub fn should_precheck_utterance(net_speech_samples: usize, near_assistant: bool) -> bool {
    net_speech_samples < SHORT_SPEECH_CHECK_SAMPLES
        || (near_assistant && net_speech_samples < MAX_ECHO_PRECHECK_SAMPLES)
}

pub(super) fn cancel_active_turn(state: &mut RealtimeLoopState, sip_handle: &SipCallHandle) {
    if let Some(turn) = &state.active_turn {
        turn.cancel.cancel();
    }
    if let Some(tool_task) = state.dialog.active_tool.take() {
        tool_task.cancel.cancel();
        tool_task.handle.abort();
        state.dialog.cancelled_tool_call_id = Some(tool_task.call_id);
    }
    sip_handle.clear_outbound_audio();
}

pub(super) async fn process_inbound_frame(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    frame: InboundRtpAudioFrame,
) -> Option<(Vec<i16>, bool)> {
    let now = Instant::now();
    let outbound_mean = mulaw_frame_mean_abs(&frame.outbound_pcmu);
    if frame.outbound_playing {
        state.audio.echo_tracker.note_outbound_audio(now);
        state.audio.last_outbound_at = Some(now);
    }
    if mulaw_frame_mean_abs(&frame.inbound_pcmu)
        >= state
            .audio
            .vad
            .speech_threshold(frame.outbound_playing, outbound_mean)
    {
        state.audio.continuation_deadline = None;
        let hangover = u32::try_from(state.audio.vad.hangover_frames()).expect("bounded hangover");
        state.audio.speech_quiet_deadline =
            Some(tokio::time::Instant::now() + Duration::from_millis(20) * hangover);
    }
    match state.audio.vad.process_mulaw_frame(
        &frame.inbound_pcmu,
        frame.outbound_playing,
        outbound_mean,
    ) {
        Some(VadEvent::BargeIn) => {
            state.audio.echo_tracker.note_vad_pending(true, now);
            state.audio.utterance_near_outbound = true;
            cancel_active_turn(state, sip_handle);
            publish_in_call_card_update(ctx, state.dialog.conversation.transcript()).await;
            None
        }
        Some(VadEvent::UtteranceComplete(samples)) => {
            state.audio.speech_quiet_deadline = None;
            let near = state.audio.take_utterance_near_outbound(now);
            Some((samples, near))
        }
        None => {
            let pending = state.audio.vad.has_pending_speech();
            state.audio.note_pending_speech(pending, now);
            None
        }
    }
}

pub(super) async fn handle_completed_utterance(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    samples_8k: Vec<i16>,
    near_assistant: bool,
) {
    let now = Instant::now();
    let acoustics = UtteranceAcoustics::from_pcm_8k(&samples_8k);
    if state
        .dialog
        .attention
        .should_drop_before_asr(&acoustics, now)
    {
        return;
    }
    let overhead_frames = VAD_PREROLL_FRAMES.saturating_add(state.audio.vad.hangover_frames());
    let net_speech_samples = samples_8k
        .len()
        .saturating_sub(overhead_frames.saturating_mul(RTP_FRAME_SAMPLES));
    if should_precheck_utterance(net_speech_samples, near_assistant)
        || state
            .dialog
            .attention
            .should_precheck_for_side_talk(&acoustics, now)
    {
        start_short_check(
            ctx,
            state,
            samples_8k,
            acoustics,
            now,
            near_assistant,
            net_speech_samples < SHORT_SPEECH_CHECK_SAMPLES,
        );
        return;
    }
    state
        .dialog
        .attention
        .note_directed_user_turn(&acoustics, now);
    let combined = combine_with_deferred(&mut state.audio.deferred_audio_8k, samples_8k);
    state.audio.continuation_deadline = None;
    spawn_background_asr(ctx, state, combined.clone(), near_assistant);
    enqueue_realtime_audio_turn(ctx, sip_handle, state, combined);
}

fn start_short_check(
    ctx: &ConnectedCallContext,
    state: &mut RealtimeLoopState,
    samples_8k: Vec<i16>,
    acoustics: UtteranceAcoustics,
    captured_at: Instant,
    near_assistant: bool,
    is_short_clip: bool,
) {
    if let Some(old) = state.audio.short_check.take() {
        old.handle.abort();
    }
    let strategy = Arc::clone(&state.dialog.strategy);
    let http = ctx.voice_client.http_client().clone();
    let base = ctx.voice_client.llm_base_url().clone();
    let model = ctx.voice_client.llm_model().to_string();
    let cancel = ctx.slot.cancel.child_token();
    let task_samples = samples_8k.clone();
    let handle = tokio::spawn(async move {
        strategy
            .transcribe_pcm_8k(&http, &base, &model, &task_samples, &cancel)
            .await
    });
    state.audio.short_check = Some(PendingShortCheck {
        samples_8k,
        acoustics,
        captured_at,
        near_assistant_audio: near_assistant,
        is_short_clip,
        handle,
    });
}

pub(super) async fn handle_short_check_result(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    result: Result<Result<Option<String>, VoiceError>, tokio::task::JoinError>,
) {
    let Some(check) = state.audio.short_check.take() else {
        return;
    };
    let Ok(Ok(Some(text))) = result else {
        if !check.is_short_clip {
            let combined =
                combine_with_deferred(&mut state.audio.deferred_audio_8k, check.samples_8k);
            state.audio.continuation_deadline = None;
            enqueue_realtime_audio_turn(ctx, sip_handle, state, combined);
        }
        return;
    };
    if is_ignored_precheck_utterance(state, &text, &check) {
        return;
    }
    if state.pending_end.is_some() && !is_substantive_reply(&text) {
        record_user_text(ctx, state, &text).await;
        if let Some(end) = &mut state.pending_end {
            end.deadline = tokio::time::Instant::now() + END_CALL_QUIET_GRACE;
        }
        return;
    }
    if is_incomplete_utterance(&text) {
        append_bounded_samples(&mut state.audio.deferred_audio_8k, &check.samples_8k);
        state.audio.continuation_deadline =
            Some(tokio::time::Instant::now() + INCOMPLETE_UTTERANCE_DEFER);
        return;
    }
    state.dialog.last_callee_text = Some(text.clone());
    record_user_text(ctx, state, &text).await;
    let combined = combine_with_deferred(&mut state.audio.deferred_audio_8k, check.samples_8k);
    state.audio.continuation_deadline = None;
    enqueue_realtime_audio_turn(ctx, sip_handle, state, combined);
}

fn is_ignored_precheck_utterance(
    state: &mut RealtimeLoopState,
    text: &str,
    check: &PendingShortCheck,
) -> bool {
    state.audio.echo_tracker.matches_self_echo(
        text,
        check.near_assistant_audio,
        None,
        Instant::now(),
    ) || state.dialog.attention.classify_transcribed_utterance(
        text,
        &check.acoustics,
        check.captured_at,
    ) == AttentionDecision::SideConversation
}

pub(super) async fn record_user_text(
    ctx: &ConnectedCallContext,
    state: &mut RealtimeLoopState,
    text: &str,
) {
    state.dialog.conversation.push_callee_utterance(text);
    sync_shared_transcript(&ctx.slot, state.dialog.conversation.transcript());
    publish_in_call_card_update(ctx, state.dialog.conversation.transcript()).await;
}

pub(super) async fn flush_deferred_audio_turn(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
) {
    if state.audio.deferred_audio_8k.is_empty() || state.audio.vad.has_pending_speech() {
        return;
    }
    let audio = std::mem::take(&mut state.audio.deferred_audio_8k);
    spawn_background_asr(ctx, state, audio.clone(), false);
    enqueue_realtime_audio_turn(ctx, sip_handle, state, audio);
}

pub(super) fn enqueue_realtime_audio_turn(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    samples_8k: Vec<i16>,
) {
    state.pending_end = None;
    state.opening_greeting_pending = false;
    state.opening_window_elapsed = true;
    state.dialog.callee_has_spoken = true;
    if state.dialog.conversation.is_on_hold() && !state.transport_on_hold {
        set_call_hold(&ctx.slot, &mut state.dialog.conversation, false);
        state.audio.vad.set_ivr_mode(false);
    }
    cancel_active_turn(state, sip_handle);
    state.pending_turn = Some(RealtimeTurnRequest::Audio {
        pcm_8k: samples_8k,
        cancelled_tool_call_id: state.dialog.cancelled_tool_call_id.take(),
    });
}

pub(super) fn queue_opening_greeting(state: &mut RealtimeLoopState) {
    if state.transport_on_hold
        || state.audio.vad.has_pending_speech()
        || state.audio.short_check.is_some()
    {
        return;
    }
    state.opening_greeting_pending = false;
    let cue = match state
        .dialog
        .prompt_params
        .first_message
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        Some(first) => {
            format!("The call just connected. Open naturally with this greeting: {first}")
        }
        None => "The call just connected. Greet the other person warmly and briefly.".to_string(),
    };
    state.pending_turn = Some(RealtimeTurnRequest::Text {
        prompt: cue,
        force_audio: true,
    });
}

pub(super) fn maybe_dispatch_pending_turn(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
) {
    if state.transport_on_hold
        || state.active_turn.is_some()
        || state.audio.vad.has_pending_speech()
        || state.session.is_none()
    {
        return;
    }
    if state.opening_greeting_pending
        && state.opening_window_elapsed
        && state.pending_turn.is_none()
    {
        queue_opening_greeting(state);
    }
    let Some(request) = state.pending_turn.take() else {
        return;
    };
    let session = state.session.take().expect("checked is_some");
    state.active_turn = Some(spawn_realtime_turn(
        session,
        request,
        sip_handle,
        &ctx.slot.cancel,
    ));
}

fn spawn_realtime_turn(
    session: Box<dyn RealtimeModelSession>,
    request: RealtimeTurnRequest,
    sip_handle: &SipCallHandle,
    parent_cancel: &CancellationToken,
) -> ActiveRealtimeTurn {
    let cancel = parent_cancel.child_token();
    let task_cancel = cancel.clone();
    let rtp = sip_handle.clone();
    let handle =
        tokio::spawn(
            async move { execute_realtime_turn(session, request, rtp, task_cancel).await },
        );
    ActiveRealtimeTurn { cancel, handle }
}

async fn execute_realtime_turn(
    mut session: Box<dyn RealtimeModelSession>,
    request: RealtimeTurnRequest,
    rtp: SipCallHandle,
    task_cancel: CancellationToken,
) -> (
    Box<dyn RealtimeModelSession>,
    Result<RealtimeTurnOutput, VoiceError>,
) {
    let mut emit_frame = |frame: [u8; RTP_FRAME_SAMPLES]| {
        if !task_cancel.is_cancelled() {
            rtp.enqueue_pcmu_frames(vec![frame]);
        }
    };
    let result = match request {
        RealtimeTurnRequest::Audio {
            pcm_8k,
            cancelled_tool_call_id,
        } => {
            run_audio_request(
                session.as_mut(),
                &pcm_8k,
                cancelled_tool_call_id.as_deref(),
                &task_cancel,
                &mut emit_frame,
            )
            .await
        }
        RealtimeTurnRequest::Text {
            prompt,
            force_audio,
        } => {
            session
                .run_text_turn(&prompt, force_audio, &task_cancel, &mut emit_frame)
                .await
        }
        RealtimeTurnRequest::ToolOutput {
            call_id,
            output,
            request_spoken_reply,
        } => {
            session
                .submit_tool_output(
                    &call_id,
                    &output,
                    request_spoken_reply,
                    &task_cancel,
                    &mut emit_frame,
                )
                .await
        }
    };
    if let Ok(ref out) = result {
        if !out.cancelled && out.audio_frames_emitted > 0 {
            let _ = wait_for_outbound_media_drain(&rtp, &task_cancel).await;
        }
    }
    (session, result)
}

async fn run_audio_request(
    session: &mut dyn RealtimeModelSession,
    pcm_8k: &[i16],
    cancelled_tool_call_id: Option<&str>,
    cancel: &CancellationToken,
    emit_frame: &mut (dyn FnMut([u8; RTP_FRAME_SAMPLES]) + Send),
) -> Result<RealtimeTurnOutput, VoiceError> {
    if let Some(call_id) = cancelled_tool_call_id {
        let mut ignore = |_| {};
        session
            .submit_tool_output(call_id, r#"{"cancelled":true}"#, false, cancel, &mut ignore)
            .await?;
    }
    session.run_audio_turn(pcm_8k, cancel, emit_frame).await
}

fn spawn_background_asr(
    ctx: &ConnectedCallContext,
    state: &RealtimeLoopState,
    samples_8k: Vec<i16>,
    near_assistant: bool,
) {
    let strategy = Arc::clone(&state.dialog.strategy);
    let http = ctx.voice_client.http_client().clone();
    let base = ctx.voice_client.llm_base_url().clone();
    let model = ctx.voice_client.llm_model().to_string();
    let cancel = ctx.slot.cancel.child_token();
    let tx = state.audio.bg_asr_tx.clone();
    tokio::spawn(async move {
        if let Ok(Some(text)) = strategy
            .transcribe_pcm_8k(&http, &base, &model, &samples_8k, &cancel)
            .await
        {
            let _ = tx.send((text, near_assistant));
        }
    });
}

fn append_bounded_samples(target: &mut Vec<i16>, extra: &[i16]) {
    let remaining = MAX_DEFERRED_AUDIO_SAMPLES.saturating_sub(target.len());
    let count = remaining.min(extra.len());
    target.extend_from_slice(&extra[..count]);
}

fn combine_with_deferred(deferred: &mut Vec<i16>, latest: Vec<i16>) -> Vec<i16> {
    if deferred.is_empty() {
        return latest;
    }
    let mut combined = std::mem::take(deferred);
    append_bounded_samples(&mut combined, &latest);
    combined
}

pub(super) async fn poll_short_check(
    slot: &mut Option<PendingShortCheck>,
) -> Result<Result<Option<String>, VoiceError>, tokio::task::JoinError> {
    match slot.as_mut() {
        Some(check) => (&mut check.handle).await,
        None => std::future::pending().await,
    }
}

pub(super) async fn poll_active_tool(
    slot: &mut Option<ActiveToolTask>,
) -> Result<ToolOutcome, tokio::task::JoinError> {
    match slot.as_mut() {
        Some(task) => (&mut task.handle).await,
        None => std::future::pending().await,
    }
}

pub(super) async fn poll_active_realtime_turn(
    slot: &mut Option<ActiveRealtimeTurn>,
) -> Result<
    (
        Box<dyn RealtimeModelSession>,
        Result<RealtimeTurnOutput, VoiceError>,
    ),
    tokio::task::JoinError,
> {
    match slot.as_mut() {
        Some(turn) => (&mut turn.handle).await,
        None => std::future::pending().await,
    }
}
