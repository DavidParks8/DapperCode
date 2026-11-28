#![forbid(unsafe_code)]

use super::strategy::{RealtimeModelSession, RealtimeModelStrategy, RealtimeTurnOutput};
use super::tools::{ActiveToolTask, RealtimeToolRegistry};
use crate::phone_call::audio::TelephonyVad;
use crate::phone_call::room_attention::{RoomAttentionTracker, UtteranceAcoustics};
use crate::phone_call::voice::{VoiceCallPromptParams, VoiceConversation, VoiceError};
use crate::phone_call::{
    sync_shared_transcript, AssistantEchoTracker, ConnectedCallContext, PendingCallEnd,
};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const REALTIME_ECHO_WINDOW: Duration = Duration::from_millis(1_000);

pub(super) enum RealtimeTurnRequest {
    Audio {
        pcm_8k: Vec<i16>,
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

pub(super) struct ActiveRealtimeTurn {
    pub cancel: CancellationToken,
    pub handle: JoinHandle<(
        Box<dyn RealtimeModelSession>,
        Result<RealtimeTurnOutput, VoiceError>,
    )>,
}

pub(super) struct PendingShortCheck {
    pub samples_8k: Vec<i16>,
    pub acoustics: UtteranceAcoustics,
    pub captured_at: Instant,
    pub near_assistant_audio: bool,
    pub is_short_clip: bool,
    pub handle: JoinHandle<Result<Option<String>, VoiceError>>,
}

pub(super) struct RealtimeDialogState {
    pub strategy: Arc<dyn RealtimeModelStrategy>,
    pub tools: RealtimeToolRegistry,
    pub conversation: VoiceConversation,
    pub prompt_params: VoiceCallPromptParams,
    pub callee_has_spoken: bool,
    pub last_callee_text: Option<String>,
    pub active_tool: Option<ActiveToolTask>,
    pub cancelled_tool_call_id: Option<String>,
    pub attention: RoomAttentionTracker,
}

impl RealtimeDialogState {
    pub(super) fn new(
        ctx: &ConnectedCallContext,
        strategy: Arc<dyn RealtimeModelStrategy>,
        tools: RealtimeToolRegistry,
    ) -> Self {
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
        let attention = RoomAttentionTracker::new(&prompt_params.user_display_name);
        Self {
            strategy,
            tools,
            conversation,
            prompt_params,
            callee_has_spoken: false,
            last_callee_text: None,
            active_tool: None,
            cancelled_tool_call_id: None,
            attention,
        }
    }
}

pub(super) struct RealtimeAudioState {
    pub vad: TelephonyVad,
    pub echo_tracker: AssistantEchoTracker,
    pub last_outbound_at: Option<Instant>,
    pub utterance_near_outbound: bool,
    pub deferred_audio_8k: Vec<i16>,
    pub continuation_deadline: Option<tokio::time::Instant>,
    pub speech_quiet_deadline: Option<tokio::time::Instant>,
    pub short_check: Option<PendingShortCheck>,
    pub bg_asr_tx: mpsc::UnboundedSender<(String, bool)>,
    pub bg_asr_rx: mpsc::UnboundedReceiver<(String, bool)>,
}

impl RealtimeAudioState {
    pub(super) fn new() -> Self {
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

    pub(super) fn within_realtime_echo_window(&self, now: Instant) -> bool {
        self.last_outbound_at
            .is_some_and(|at| now.saturating_duration_since(at) <= REALTIME_ECHO_WINDOW)
    }

    pub(super) fn note_pending_speech(&mut self, pending: bool, now: Instant) {
        self.echo_tracker.note_vad_pending(pending, now);
        if pending && self.within_realtime_echo_window(now) {
            self.utterance_near_outbound = true;
        } else if !pending {
            self.utterance_near_outbound = false;
        }
    }

    pub(super) fn take_utterance_near_outbound(&mut self, now: Instant) -> bool {
        let _ = self.echo_tracker.take_utterance_near_audio(now);
        let near = self.utterance_near_outbound || self.within_realtime_echo_window(now);
        self.utterance_near_outbound = false;
        near
    }
}

pub(super) struct RealtimeLoopState {
    pub dialog: RealtimeDialogState,
    pub audio: RealtimeAudioState,
    pub transport_on_hold: bool,
    pub opening_greeting_pending: bool,
    pub opening_window_elapsed: bool,
    pub pending_turn: Option<RealtimeTurnRequest>,
    pub pending_end: Option<PendingCallEnd>,
    pub session: Option<Box<dyn RealtimeModelSession>>,
    pub active_turn: Option<ActiveRealtimeTurn>,
}
