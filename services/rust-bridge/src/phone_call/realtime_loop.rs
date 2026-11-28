#![forbid(unsafe_code)]

use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::audio::{
    encode_mulaw, mulaw_frame_mean_abs, Downsampler24kTo8k, TelephonyVad, VadEvent, MULAW_SILENCE,
    RTP_FRAME_SAMPLES, VAD_MAX_UTTERANCE_SAMPLES, VAD_PREROLL_FRAMES,
};
use super::realtime::{
    build_realtime_instructions, build_realtime_tools, encode_wav_16k_mono,
    transcribe_lfm3_chat_wav, upsample_8k_to_16k, RealtimeSession, RealtimeTurnOutput,
};
use super::sip::{InboundRtpAudioFrame, SipCallEvent, SipCallHandle};
use super::voice::{
    is_substantive_reply, VoiceCallPromptParams, VoiceConversation, VoiceError, VoiceToolCall,
};
use super::web_search::{execute_web_search, sanitize_query, SearchFillerBank};
use super::{
    is_incomplete_utterance, publish_in_call_card_update, recv_optional_inbound_audio,
    recv_optional_sip_event, set_call_hold, settle_connected_call, sync_shared_transcript,
    transmit_dtmf, wait_for_outbound_media_drain, wait_for_pending_end, AssistantEchoTracker,
    CallLoopExit, ConnectedCallContext, EndTrigger, PendingCallEnd, END_CALL_QUIET_GRACE,
    INCOMPLETE_UTTERANCE_DEFER,
};

const SHORT_SPEECH_CHECK_SAMPLES: usize = 16_000; // 2.0 s of net speech @ 8 kHz
const MAX_ECHO_PRECHECK_SAMPLES: usize = 40_000; // 5.0 s: longer clips are unambiguously human speech
const REALTIME_ECHO_WINDOW: Duration = Duration::from_millis(1_000);
const MAX_DEFERRED_AUDIO_SAMPLES: usize = VAD_MAX_UTTERANCE_SAMPLES;

enum RealtimeTurnRequest {
    Audio {
        pcm_16k: Vec<i16>,
        cancelled_tool_call_id: Option<String>,
    },
    Text {
        prompt: String,
        force_audio: bool,
    },
    ToolOutput {
        call_id: String,
        output: String,
        request_spoken_reply: bool,
    },
}

struct ActiveWebSearch {
    cancel: CancellationToken,
    call_id: String,
    handle: JoinHandle<String>,
}

struct ActiveRealtimeTurn {
    cancel: CancellationToken,
    handle: JoinHandle<(RealtimeSession, Result<RealtimeTurnOutput, VoiceError>)>,
}

struct PendingShortCheck {
    samples_8k: Vec<i16>,
    near_assistant_audio: bool,
    is_short_clip: bool,
    handle: JoinHandle<Result<Option<String>, VoiceError>>,
}

struct RealtimeDialogState {
    conversation: VoiceConversation,
    prompt_params: VoiceCallPromptParams,
    steers: Vec<String>,
    callee_has_spoken: bool,
    last_callee_text: Option<String>,
    last_search_query: Option<String>,
    search_fillers: SearchFillerBank,
    active_search: Option<ActiveWebSearch>,
    cancelled_tool_call_id: Option<String>,
}

impl RealtimeDialogState {
    fn new(ctx: &ConnectedCallContext) -> Self {
        let prompt_params = VoiceCallPromptParams {
            user_display_name: ctx.runtime_config.user_display_name.clone(),
            callee_name: ctx.validated.callee_name.clone(),
            objective: ctx.validated.objective.clone(),
            first_message: ctx.validated.first_message.clone(),
            context: ctx.validated.context.clone(),
        };
        let mut conversation = VoiceConversation::new(prompt_params.clone());
        for steer in &ctx.initial_steers {
            conversation.inject_steer(steer);
        }
        sync_shared_transcript(&ctx.slot, conversation.transcript());
        let search_fillers = SearchFillerBank::start_warming(
            ctx.voice_client.clone(),
            ctx.slot.cancel.child_token(),
        );
        Self {
            conversation,
            prompt_params,
            steers: ctx.initial_steers.clone(),
            callee_has_spoken: false,
            last_callee_text: None,
            last_search_query: None,
            search_fillers,
            active_search: None,
            cancelled_tool_call_id: None,
        }
    }

    fn build_instructions(&self) -> String {
        build_realtime_instructions(&self.prompt_params, &self.steers)
    }
}

struct RealtimeAudioState {
    vad: TelephonyVad,
    echo_tracker: AssistantEchoTracker,
    last_outbound_at: Option<Instant>,
    utterance_near_outbound: bool,
    deferred_audio_8k: Vec<i16>,
    continuation_deadline: Option<tokio::time::Instant>,
    speech_quiet_deadline: Option<tokio::time::Instant>,
    short_check: Option<PendingShortCheck>,
    bg_asr_tx: mpsc::UnboundedSender<(String, bool)>,
    bg_asr_rx: mpsc::UnboundedReceiver<(String, bool)>,
}

impl RealtimeAudioState {
    fn new() -> Self {
        let (bg_asr_tx, bg_asr_rx) = mpsc::unbounded_channel();
        Self {
            vad: TelephonyVad::new(),
            echo_tracker: AssistantEchoTracker::default(),
            last_outbound_at: None,
            utterance_near_outbound: false,
            deferred_audio_8k: Vec::new(),
            continuation_deadline: None,
            speech_quiet_deadline: None,
            short_check: None,
            bg_asr_tx,
            bg_asr_rx,
        }
    }

    fn within_realtime_echo_window(&self, now: Instant) -> bool {
        self.last_outbound_at
            .is_some_and(|at| now.saturating_duration_since(at) <= REALTIME_ECHO_WINDOW)
    }

    fn note_pending_speech(&mut self, pending: bool, now: Instant) {
        self.echo_tracker.note_vad_pending(pending, now);
        if pending && self.within_realtime_echo_window(now) {
            self.utterance_near_outbound = true;
        } else if !pending {
            self.utterance_near_outbound = false;
        }
    }

    fn take_utterance_near_outbound(&mut self, now: Instant) -> bool {
        let _ = self.echo_tracker.take_utterance_near_audio(now);
        let near = self.utterance_near_outbound || self.within_realtime_echo_window(now);
        self.utterance_near_outbound = false;
        near
    }
}

struct RealtimeLoopState {
    dialog: RealtimeDialogState,
    audio: RealtimeAudioState,
    transport_on_hold: bool,
    opening_greeting_pending: bool,
    opening_window_elapsed: bool,
    pending_turn: Option<RealtimeTurnRequest>,
    pending_end: Option<PendingCallEnd>,
    session: Option<RealtimeSession>,
    active_turn: Option<ActiveRealtimeTurn>,
}

pub(super) async fn run_connected_realtime_call(mut ctx: ConnectedCallContext) {
    let sip_handle = ctx.sip_session.control_handle();
    let mut event_rx = ctx.sip_session.take_event_receiver();
    let mut inbound_audio_rx = ctx.sip_session.take_inbound_audio_receiver();
    let dialog = RealtimeDialogState::new(&ctx);

    let Some(session) = connect_realtime_or_settle(&ctx, &sip_handle, &dialog).await else {
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

    let exit = run_realtime_select_loop(
        &mut ctx,
        &sip_handle,
        &mut event_rx,
        &mut inbound_audio_rx,
        &mut state,
        opening_deadline,
        call_deadline,
    )
    .await;

    ctx.slot.cancel.cancel();
    settle_connected_call(&ctx, state.dialog.conversation.transcript().to_vec(), exit).await;
}

async fn connect_realtime_or_settle(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    dialog: &RealtimeDialogState,
) -> Option<RealtimeSession> {
    let instructions = dialog.build_instructions();
    match RealtimeSession::connect(
        ctx.voice_client.llm_base_url(),
        &instructions,
        build_realtime_tools(true),
        &ctx.slot.cancel,
    )
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
                    error: err.to_string(),
                },
            )
            .await;
            None
        }
    }
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::overly_long_function,
        reason = "tokio::select! event loop mirrors run_connected_call for lifecycle parity"
    )
)]
async fn run_realtime_select_loop(
    ctx: &mut ConnectedCallContext,
    sip_handle: &SipCallHandle,
    event_rx: &mut Option<mpsc::Receiver<SipCallEvent>>,
    inbound_audio_rx: &mut Option<mpsc::Receiver<InboundRtpAudioFrame>>,
    state: &mut RealtimeLoopState,
    opening_deadline: tokio::time::Instant,
    call_deadline: tokio::time::Instant,
) -> CallLoopExit {
    loop {
        let mut completed_utterance: Option<(Vec<i16>, bool)> = None;
        tokio::select! {
            biased;
            () = ctx.slot.cancel.cancelled() => {
                cancel_active_turn(state, sip_handle);
                let _ = sip_handle.hangup().await;
                let end_reason = match ctx.slot.end_trigger.get().copied() {
                    Some(EndTrigger::MobileHangup) => "mobile_hangup",
                    Some(EndTrigger::AgentHangup) => "agent_hangup",
                    Some(EndTrigger::ThreadRetired) => "thread_retired",
                    Some(EndTrigger::Shutdown) | None => "bridge_shutdown",
                };
                return CallLoopExit::Completed {
                    end_reason: end_reason.to_string(),
                    outcome_summary: None,
                };
            }
            () = tokio::time::sleep_until(call_deadline) => {
                cancel_active_turn(state, sip_handle);
                let _ = sip_handle.hangup().await;
                return CallLoopExit::Completed {
                    end_reason: "max_duration_reached".to_string(),
                    outcome_summary: Some("Maximum call duration reached.".to_string()),
                };
            }
            () = wait_for_pending_end(&state.pending_end),
                if state.pending_end.is_some()
                    && state.active_turn.is_none()
                    && state.pending_turn.is_none() => {
                let end = state.pending_end.take().expect("guarded by is_some");
                let _ = sip_handle.hangup().await;
                return CallLoopExit::Completed {
                    end_reason: end.reason,
                    outcome_summary: Some(end.summary),
                };
            }
            sip_ev = recv_optional_sip_event(event_rx), if event_rx.is_some() => {
                if sip_ev.is_none() {
                    *event_rx = None;
                } else if let Some(exit) = handle_realtime_sip_event(ctx, sip_handle, state, sip_ev).await {
                    return exit;
                }
            }
            Some(instruction) = ctx.steer_rx.recv() => {
                handle_realtime_steer(ctx, sip_handle, state, &instruction).await;
            }
            Some((bg_text, near_audio)) = state.audio.bg_asr_rx.recv() => {
                if !state.audio.echo_tracker.matches_self_echo(&bg_text, near_audio, None, Instant::now()) {
                    state.dialog.last_callee_text = Some(bg_text.clone());
                    state.dialog.conversation.push_callee_utterance(&bg_text);
                    sync_shared_transcript(&ctx.slot, state.dialog.conversation.transcript());
                    publish_in_call_card_update(ctx, state.dialog.conversation.transcript()).await;
                }
            }
            audio_opt = recv_optional_inbound_audio(inbound_audio_rx), if inbound_audio_rx.is_some() => {
                if let Some(frame) = audio_opt {
                    completed_utterance = process_inbound_frame(ctx, sip_handle, state, frame).await;
                } else {
                    *inbound_audio_rx = None;
                }
            }
            () = tokio::time::sleep_until(state.audio.speech_quiet_deadline.unwrap_or(call_deadline)),
                if state.audio.speech_quiet_deadline.is_some() => {
                state.audio.speech_quiet_deadline = None;
                if let Some(VadEvent::UtteranceComplete(samples)) = state.audio.vad.finish_after_media_quiet() {
                    let near = state.audio.take_utterance_near_outbound(Instant::now());
                    completed_utterance = Some((samples, near));
                }
            }
            () = tokio::time::sleep_until(state.audio.continuation_deadline.unwrap_or(call_deadline)),
                if state.audio.continuation_deadline.is_some() => {
                state.audio.continuation_deadline = None;
                flush_deferred_audio_turn(ctx, sip_handle, state).await;
            }
            check_res = poll_short_check(&mut state.audio.short_check), if state.audio.short_check.is_some() => {
                handle_short_check_result(ctx, sip_handle, state, check_res).await;
            }
            search_res = poll_active_search(&mut state.dialog.active_search), if state.dialog.active_search.is_some() => {
                handle_active_search_done(state, search_res);
            }
            turn_res = poll_active_realtime_turn(&mut state.active_turn), if state.active_turn.is_some() => {
                if let Some(exit) = handle_realtime_turn_done(ctx, sip_handle, state, turn_res).await {
                    return exit;
                }
            }
            () = tokio::time::sleep_until(opening_deadline),
                if state.opening_greeting_pending && !state.opening_window_elapsed && state.active_turn.is_none() => {
                state.opening_window_elapsed = true;
                queue_opening_greeting(state);
            }
        }

        if let Some((samples, near)) = completed_utterance {
            handle_completed_utterance(ctx, sip_handle, state, samples, near).await;
        }
        maybe_dispatch_pending_turn(ctx, sip_handle, state);
    }
}

fn cancel_active_turn(state: &mut RealtimeLoopState, sip_handle: &SipCallHandle) {
    if let Some(turn) = &state.active_turn {
        turn.cancel.cancel();
    }
    if let Some(search) = state.dialog.active_search.take() {
        search.cancel.cancel();
        search.handle.abort();
        state.dialog.cancelled_tool_call_id = Some(search.call_id);
    }
    sip_handle.clear_outbound_audio();
}

async fn handle_realtime_sip_event(
    ctx: &mut ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    sip_ev: Option<SipCallEvent>,
) -> Option<CallLoopExit> {
    match sip_ev {
        Some(SipCallEvent::Ended { reason }) => {
            cancel_active_turn(state, sip_handle);
            Some(CallLoopExit::Completed {
                end_reason: reason,
                outcome_summary: None,
            })
        }
        Some(SipCallEvent::HoldChanged {
            on_hold,
            negotiated_dtmf_pt,
        }) => {
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
        Some(SipCallEvent::Ringing | SipCallEvent::Connected { .. }) | None => None,
    }
}

async fn handle_realtime_steer(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    instruction: &str,
) {
    state.dialog.steers.push(instruction.to_string());
    state.dialog.conversation.inject_steer(instruction);
    sync_shared_transcript(&ctx.slot, state.dialog.conversation.transcript());
    publish_in_call_card_update(ctx, state.dialog.conversation.transcript()).await;
    if super::requests_immediate_speech_stop(instruction) {
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

async fn process_inbound_frame(
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

pub(super) fn should_precheck_utterance(net_speech_samples: usize, near_assistant: bool) -> bool {
    net_speech_samples < SHORT_SPEECH_CHECK_SAMPLES
        || (near_assistant && net_speech_samples < MAX_ECHO_PRECHECK_SAMPLES)
}

async fn handle_completed_utterance(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    samples_8k: Vec<i16>,
    near_assistant: bool,
) {
    let overhead_frames = VAD_PREROLL_FRAMES.saturating_add(state.audio.vad.hangover_frames());
    let net_speech_samples = samples_8k
        .len()
        .saturating_sub(overhead_frames.saturating_mul(RTP_FRAME_SAMPLES));

    if should_precheck_utterance(net_speech_samples, near_assistant) {
        if let Some(old) = state.audio.short_check.take() {
            old.handle.abort();
        }
        let wav = encode_wav_16k_mono(&upsample_8k_to_16k(&samples_8k));
        let http = ctx.voice_client.http_client().clone();
        let base = ctx.voice_client.llm_base_url().clone();
        let model = ctx.voice_client.llm_model().to_string();
        let cancel = ctx.slot.cancel.child_token();
        let handle = tokio::spawn(async move {
            transcribe_lfm3_chat_wav(&http, &base, &model, &wav, &cancel).await
        });
        state.audio.short_check = Some(PendingShortCheck {
            samples_8k,
            near_assistant_audio: near_assistant,
            is_short_clip: net_speech_samples < SHORT_SPEECH_CHECK_SAMPLES,
            handle,
        });
        return;
    }

    let combined = combine_with_deferred(&mut state.audio.deferred_audio_8k, samples_8k);
    state.audio.continuation_deadline = None;
    spawn_background_asr(
        ctx,
        &combined,
        near_assistant,
        state.audio.bg_asr_tx.clone(),
    );
    enqueue_realtime_audio_turn(ctx, sip_handle, state, combined);
}

async fn handle_short_check_result(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    result: Result<Result<Option<String>, VoiceError>, tokio::task::JoinError>,
) {
    let Some(check) = state.audio.short_check.take() else {
        return;
    };
    let text = match result {
        Ok(Ok(Some(text))) => text,
        _ => {
            if !check.is_short_clip {
                let combined =
                    combine_with_deferred(&mut state.audio.deferred_audio_8k, check.samples_8k);
                state.audio.continuation_deadline = None;
                enqueue_realtime_audio_turn(ctx, sip_handle, state, combined);
            }
            return;
        }
    };
    if state.audio.echo_tracker.matches_self_echo(
        &text,
        check.near_assistant_audio,
        None,
        Instant::now(),
    ) || is_side_conversation_utterance(&text)
    {
        return;
    }
    if state.pending_end.is_some() && !is_substantive_reply(&text) {
        state.dialog.conversation.push_callee_utterance(&text);
        sync_shared_transcript(&ctx.slot, state.dialog.conversation.transcript());
        publish_in_call_card_update(ctx, state.dialog.conversation.transcript()).await;
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
    state.dialog.conversation.push_callee_utterance(&text);
    sync_shared_transcript(&ctx.slot, state.dialog.conversation.transcript());
    publish_in_call_card_update(ctx, state.dialog.conversation.transcript()).await;
    let combined = combine_with_deferred(&mut state.audio.deferred_audio_8k, check.samples_8k);
    state.audio.continuation_deadline = None;
    enqueue_realtime_audio_turn(ctx, sip_handle, state, combined);
}

async fn flush_deferred_audio_turn(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
) {
    if state.audio.deferred_audio_8k.is_empty() || state.audio.vad.has_pending_speech() {
        return;
    }
    let audio = std::mem::take(&mut state.audio.deferred_audio_8k);
    spawn_background_asr(ctx, &audio, false, state.audio.bg_asr_tx.clone());
    enqueue_realtime_audio_turn(ctx, sip_handle, state, audio);
}

fn enqueue_realtime_audio_turn(
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
        pcm_16k: upsample_8k_to_16k(&samples_8k),
        cancelled_tool_call_id: state.dialog.cancelled_tool_call_id.take(),
    });
}

fn queue_opening_greeting(state: &mut RealtimeLoopState) {
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

fn maybe_dispatch_pending_turn(
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
    session: RealtimeSession,
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
    mut session: RealtimeSession,
    request: RealtimeTurnRequest,
    rtp: SipCallHandle,
    task_cancel: CancellationToken,
) -> (RealtimeSession, Result<RealtimeTurnOutput, VoiceError>) {
    let mut downsampler = Downsampler24kTo8k::new();
    let mut pcm_8k_buf: Vec<i16> = Vec::new();
    let result = dispatch_realtime_request(&mut session, request, &task_cancel, |samples_24k| {
        if !task_cancel.is_cancelled() {
            push_pcm24k_to_rtp(&mut downsampler, &mut pcm_8k_buf, samples_24k, &rtp);
        }
    })
    .await;

    if let Ok(ref out) = result {
        if !out.cancelled && !pcm_8k_buf.is_empty() {
            flush_tail_pcm8k(&mut pcm_8k_buf, &rtp);
        }
        if !out.cancelled && out.audio_samples_emitted > 0 {
            let _ = wait_for_outbound_media_drain(&rtp, &task_cancel).await;
        }
    }
    (session, result)
}

async fn dispatch_realtime_request<OnAudio: FnMut(&[i16])>(
    session: &mut RealtimeSession,
    request: RealtimeTurnRequest,
    cancel: &CancellationToken,
    mut on_audio_24k: OnAudio,
) -> Result<RealtimeTurnOutput, VoiceError> {
    match request {
        RealtimeTurnRequest::Audio {
            pcm_16k,
            cancelled_tool_call_id,
        } => {
            if let Some(call_id) = cancelled_tool_call_id {
                session
                    .submit_tool_output(&call_id, r#"{"cancelled":true}"#, false, cancel, |_| {})
                    .await?;
            }
            session
                .run_audio_turn(&pcm_16k, cancel, &mut on_audio_24k)
                .await
        }
        RealtimeTurnRequest::Text {
            prompt,
            force_audio,
        } => {
            session
                .run_text_turn(&prompt, force_audio, cancel, &mut on_audio_24k)
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
                    cancel,
                    &mut on_audio_24k,
                )
                .await
        }
    }
}

fn push_pcm24k_to_rtp(
    downsampler: &mut Downsampler24kTo8k,
    pcm_8k_buf: &mut Vec<i16>,
    samples_24k: &[i16],
    rtp: &SipCallHandle,
) {
    downsampler.push_pcm24k_samples(samples_24k, pcm_8k_buf);
    let full_frames = pcm_8k_buf.len() / RTP_FRAME_SAMPLES;
    if full_frames == 0 {
        return;
    }
    let drain_samples = full_frames.saturating_mul(RTP_FRAME_SAMPLES);
    let mut frames = Vec::with_capacity(full_frames);
    for chunk in pcm_8k_buf[..drain_samples].chunks_exact(RTP_FRAME_SAMPLES) {
        let mut frame = [0_i16; RTP_FRAME_SAMPLES];
        frame.copy_from_slice(chunk);
        frames.push(encode_realtime_mulaw_frame(&frame));
    }
    pcm_8k_buf.drain(..drain_samples);
    rtp.enqueue_pcmu_frames(frames);
}

fn flush_tail_pcm8k(pcm_8k_buf: &mut Vec<i16>, rtp: &SipCallHandle) {
    let mut tail = [0_i16; RTP_FRAME_SAMPLES];
    let count = pcm_8k_buf.len().min(RTP_FRAME_SAMPLES);
    tail[..count].copy_from_slice(&pcm_8k_buf[..count]);
    pcm_8k_buf.clear();
    rtp.enqueue_pcmu_frames(vec![encode_realtime_mulaw_frame(&tail)]);
}

/// Encodes a 20 ms 8 kHz LFM3 realtime frame with -6 dB headroom (`0.5x`) so speech sits around
/// -14 dBFS peak: loud and clear on speakers without overwhelming Mac speakerphone echo guards.
pub(super) fn encode_realtime_mulaw_frame(
    input: &[i16; RTP_FRAME_SAMPLES],
) -> [u8; RTP_FRAME_SAMPLES] {
    let mut out = [MULAW_SILENCE; RTP_FRAME_SAMPLES];
    for (dst, &src) in out.iter_mut().zip(input.iter()) {
        *dst = encode_mulaw(src / 2);
    }
    out
}

async fn handle_realtime_turn_done(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    join_res: Result<
        (RealtimeSession, Result<RealtimeTurnOutput, VoiceError>),
        tokio::task::JoinError,
    >,
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
        record_cancelled_realtime_speech(ctx, state, &out.spoken_text).await;
        return None;
    }

    let had_tools = !out.tool_calls.is_empty();
    record_completed_realtime_speech(ctx, state, &out.spoken_text).await;
    for tool in out.tool_calls {
        if let Some(exit) =
            apply_realtime_tool_call(ctx, sip_handle, state, tool, out.spoken_text.is_empty()).await
        {
            return Some(exit);
        }
    }
    if !had_tools
        && state.pending_end.is_none()
        && is_mutual_farewell(state.dialog.last_callee_text.as_deref(), &out.spoken_text)
    {
        state.pending_end = Some(PendingCallEnd {
            reason: "callee_goodbye".to_string(),
            summary: "Recipient said goodbye and the call wrapped up.".to_string(),
            deadline: tokio::time::Instant::now() + END_CALL_QUIET_GRACE,
        });
    }
    None
}

pub(super) fn is_mutual_farewell(callee_text: Option<&str>, assistant_text: &str) -> bool {
    let Some(callee) = callee_text else {
        return false;
    };
    !is_side_conversation_utterance(callee)
        && is_explicit_farewell(callee)
        && is_assistant_farewell(assistant_text)
}

/// Detects short room side-conversations addressed to family members (e.g. "I love you, daddy",
/// "Bye, daddy!") so Lily stays silent instead of chiming in on household chatter.
pub(super) fn is_side_conversation_utterance(text: &str) -> bool {
    let normalized = normalize_farewell_text(text);
    let words: Vec<&str> = normalized.split_whitespace().collect();
    if words.is_empty() || words.len() > 10 || words.contains(&"lily") {
        return false;
    }
    const FAMILY_VOCATIVES: &[&str] = &["daddy", "mommy", "dad", "mom", "mama", "papa"];
    const NON_VOCATIVE_PREV: &[&str] = &[
        "my", "your", "our", "his", "her", "their", "a", "the", "for", "about", "with", "from",
        "to", "of", "like", "tell", "ask", "call",
    ];
    words.iter().enumerate().any(|(idx, word)| {
        FAMILY_VOCATIVES.contains(word)
            && idx
                .checked_sub(1)
                .and_then(|prev| words.get(prev))
                .is_none_or(|prev| !NON_VOCATIVE_PREV.contains(prev))
    })
}

fn is_explicit_farewell(text: &str) -> bool {
    let normalized = normalize_farewell_text(text);
    let words: Vec<&str> = normalized.split_whitespace().collect();
    if words.is_empty() || words.len() > 8 {
        return false;
    }
    const PHRASES: &[&str] = &[
        "goodbye",
        "good bye",
        "bye",
        "bye bye",
        "see ya",
        "see you later",
        "hang up",
        "end the call",
        "end call",
        "gotta go",
    ];
    PHRASES.iter().any(|phrase| {
        normalized == *phrase
            || normalized.ends_with(&format!(" {phrase}"))
            || normalized.starts_with(&format!("{phrase} "))
    })
}

fn is_assistant_farewell(text: &str) -> bool {
    let normalized = normalize_farewell_text(text);
    const PHRASES: &[&str] = &[
        "goodbye",
        "good bye",
        "bye",
        "have a great day",
        "have a good day",
        "have a nice day",
        "talk to you later",
        "take care",
    ];
    PHRASES.iter().any(|phrase| normalized.contains(phrase))
}

fn normalize_farewell_text(text: &str) -> String {
    text.chars()
        .map(|ch| {
            if ch.is_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

async fn record_cancelled_realtime_speech(
    ctx: &ConnectedCallContext,
    state: &mut RealtimeLoopState,
    spoken_text: &str,
) {
    if spoken_text.is_empty() {
        return;
    }
    state
        .audio
        .echo_tracker
        .record_assistant_speech(spoken_text, Instant::now());
    state
        .dialog
        .conversation
        .record_active_assistant_interrupted(spoken_text);
    sync_shared_transcript(&ctx.slot, state.dialog.conversation.transcript());
    publish_in_call_card_update(ctx, state.dialog.conversation.transcript()).await;
}

async fn record_completed_realtime_speech(
    ctx: &ConnectedCallContext,
    state: &mut RealtimeLoopState,
    spoken_text: &str,
) {
    if spoken_text.is_empty() {
        return;
    }
    state
        .audio
        .echo_tracker
        .note_completed_speech(spoken_text, Instant::now());
    state
        .dialog
        .conversation
        .record_assistant_turn(&super::voice::AssistantTurnOutput {
            full_text: spoken_text.to_string(),
            clauses: vec![spoken_text.to_string()],
            tool_calls: Vec::new(),
            raw_tool_calls: Vec::new(),
        });
    sync_shared_transcript(&ctx.slot, state.dialog.conversation.transcript());
    publish_in_call_card_update(ctx, state.dialog.conversation.transcript()).await;
    if let Some(end) = &mut state.pending_end {
        end.deadline = tokio::time::Instant::now() + END_CALL_QUIET_GRACE;
    }
}

async fn apply_realtime_tool_call(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    tool: VoiceToolCall,
    needs_spoken_goodbye: bool,
) -> Option<CallLoopExit> {
    match tool {
        VoiceToolCall::SendDtmf { call_id, digits } => {
            if let Err(err) = transmit_dtmf(sip_handle, ctx.negotiated_dtmf_pt, &digits) {
                let _ = sip_handle.hangup().await;
                return Some(CallLoopExit::Failed { error: err });
            }
            state.audio.vad.set_ivr_mode(true);
            state.pending_turn = Some(RealtimeTurnRequest::ToolOutput {
                call_id,
                output: format!("Sent DTMF digits: {digits}"),
                request_spoken_reply: false,
            });
        }
        VoiceToolCall::WaitSilently {
            call_id,
            reason,
            on_hold: true,
        } => {
            set_call_hold(&ctx.slot, &mut state.dialog.conversation, true);
            state.audio.vad.set_ivr_mode(true);
            publish_in_call_card_update(ctx, state.dialog.conversation.transcript()).await;
            state.pending_turn = Some(RealtimeTurnRequest::ToolOutput {
                call_id,
                output: format!("Call placed on hold: {reason}"),
                request_spoken_reply: false,
            });
        }
        VoiceToolCall::EndCall {
            call_id,
            reason,
            outcome_summary,
        } => {
            handle_realtime_end_call_tool(
                state,
                call_id,
                reason,
                outcome_summary,
                needs_spoken_goodbye,
            );
        }
        VoiceToolCall::WebSearch { call_id, query } => {
            handle_realtime_web_search_tool(ctx, sip_handle, state, call_id, &query);
        }
        VoiceToolCall::WaitSilently { .. } | VoiceToolCall::ResumeCall { .. } => {}
    }
    None
}

fn handle_realtime_web_search_tool(
    ctx: &ConnectedCallContext,
    sip_handle: &SipCallHandle,
    state: &mut RealtimeLoopState,
    call_id: String,
    query: &str,
) {
    let normalized = sanitize_query(query).to_ascii_lowercase();
    if !normalized.is_empty()
        && state.dialog.last_search_query.as_deref() == Some(normalized.as_str())
    {
        state.pending_turn = Some(RealtimeTurnRequest::ToolOutput {
            call_id,
            output: r#"{"ok":true}"#.to_string(),
            request_spoken_reply: false,
        });
        return;
    }
    if !normalized.is_empty() {
        state.dialog.last_search_query = Some(normalized);
    }
    if let Some(clip) = state.dialog.search_fillers.next_clip() {
        state
            .audio
            .echo_tracker
            .record_assistant_speech(clip.text, Instant::now());
        state.audio.last_outbound_at = Some(Instant::now());
        sip_handle.enqueue_pcmu_frames(clip.frames);
    }
    let search_cancel = ctx.slot.cancel.child_token();
    let task_cancel = search_cancel.clone();
    let http = ctx.voice_client.http_client().clone();
    let query_owned = query.to_string();
    let handle =
        tokio::spawn(async move { execute_web_search(&http, &query_owned, &task_cancel).await });
    state.dialog.active_search = Some(ActiveWebSearch {
        cancel: search_cancel,
        call_id,
        handle,
    });
}

fn handle_active_search_done(
    state: &mut RealtimeLoopState,
    result: Result<String, tokio::task::JoinError>,
) {
    let Some(search) = state.dialog.active_search.take() else {
        return;
    };
    let Ok(output) = result else {
        state.dialog.cancelled_tool_call_id = Some(search.call_id);
        return;
    };
    state.pending_turn = Some(RealtimeTurnRequest::ToolOutput {
        call_id: search.call_id,
        output,
        request_spoken_reply: true,
    });
}

async fn poll_active_search(
    slot: &mut Option<ActiveWebSearch>,
) -> Result<String, tokio::task::JoinError> {
    match slot.as_mut() {
        Some(search) => (&mut search.handle).await,
        None => std::future::pending().await,
    }
}

fn handle_realtime_end_call_tool(
    state: &mut RealtimeLoopState,
    call_id: String,
    reason: String,
    outcome_summary: String,
    needs_spoken_goodbye: bool,
) {
    if !state.dialog.callee_has_spoken {
        state.pending_turn = Some(RealtimeTurnRequest::ToolOutput {
            call_id,
            output: "Cannot end the call before the recipient has spoken. Wait for their reply."
                .to_string(),
            request_spoken_reply: false,
        });
        return;
    }
    state.pending_end = Some(PendingCallEnd {
        reason,
        summary: outcome_summary,
        deadline: tokio::time::Instant::now() + END_CALL_QUIET_GRACE,
    });
    if needs_spoken_goodbye {
        state.pending_turn = Some(RealtimeTurnRequest::ToolOutput {
            call_id,
            output: r#"{"ok":true}"#.to_string(),
            request_spoken_reply: true,
        });
    }
}

fn spawn_background_asr(
    ctx: &ConnectedCallContext,
    samples_8k: &[i16],
    near_assistant: bool,
    tx: mpsc::UnboundedSender<(String, bool)>,
) {
    let wav = encode_wav_16k_mono(&upsample_8k_to_16k(samples_8k));
    let http = ctx.voice_client.http_client().clone();
    let base = ctx.voice_client.llm_base_url().clone();
    let model = ctx.voice_client.llm_model().to_string();
    let cancel = ctx.slot.cancel.child_token();
    tokio::spawn(async move {
        if let Ok(Some(text)) = transcribe_lfm3_chat_wav(&http, &base, &model, &wav, &cancel).await
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

async fn poll_short_check(
    slot: &mut Option<PendingShortCheck>,
) -> Result<Result<Option<String>, VoiceError>, tokio::task::JoinError> {
    match slot.as_mut() {
        Some(check) => (&mut check.handle).await,
        None => std::future::pending().await,
    }
}

async fn poll_active_realtime_turn(
    slot: &mut Option<ActiveRealtimeTurn>,
) -> Result<(RealtimeSession, Result<RealtimeTurnOutput, VoiceError>), tokio::task::JoinError> {
    match slot.as_mut() {
        Some(turn) => (&mut turn.handle).await,
        None => std::future::pending().await,
    }
}
