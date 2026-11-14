#![forbid(unsafe_code)]

pub(crate) mod audio;
pub(crate) mod sip;
pub(crate) mod voice;

use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex as StdMutex, OnceLock, Weak,
    },
    time::{Duration, Instant},
};

use chrono::Utc;
use dappercode_bridge_core::resource_limits::{truncate_utf8_bytes, QUEUE_MAX_CONTENT_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    bridge_protocol::{
        BridgeQueueService, BridgeThreadQueueSendRequest, BridgeUiAction, BridgeUiActionStyle,
        BridgeUiBlock, BridgeUiKeyValueItem, BridgeUiPresentation, BridgeUiSurface, BridgeUiTone,
        ResolveBridgeUiSurfaceRequest,
    },
    client_hub::ClientHub,
    config::{validate_e164_phone_number, PhoneCallRuntimeConfig},
    interaction_validation::{now_iso, validate_bridge_ui_surface},
    phone_call::{
        audio::{
            build_rfc4733_digit_packets, encode_mulaw_frame_with_headroom, encode_wav_8k_mono,
            mulaw_frame_mean_abs, parse_dtmf_digit, synthesize_inband_dtmf_mulaw,
            Downsampler24kTo8k, TelephonyVad, VadEvent, RFC4733_DEFAULT_HOLD_PACKETS,
            RTP_FRAME_SAMPLES,
        },
        sip::{SipCallEvent, SipCallHandle, SipCallSession, SipCallState, SipDialConfig},
        voice::{
            AssistantTurnOutput, TranscriptEntry, TranscriptSpeaker, VoiceCallPromptParams,
            VoiceConversation, VoiceError, VoicePipelineClient, VoiceToolCall, INTERRUPTED_MARKER,
        },
    },
};

pub(crate) const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const DEFAULT_MAX_CALL_DURATION: Duration = Duration::from_secs(15 * 60);
pub(crate) const DEFAULT_OPENING_GREETING_WAIT: Duration = Duration::from_millis(1_200);
pub(crate) const COMPLETED_CALL_HISTORY_LIMIT: usize = 32;

const MAX_CALL_ID_BYTES: usize = 128;
const MAX_CALLEE_NAME_BYTES: usize = 128;
const MAX_FIRST_MESSAGE_BYTES: usize = 1_024;
const MAX_OBJECTIVE_BYTES: usize = 4_096;
const MAX_STEER_INSTRUCTION_BYTES: usize = 4_096;
const MAX_CONTEXT_BYTES: usize = 8_192;
const MAX_LIVE_TRANSCRIPT_BYTES: usize = 24 * 1024;
const MAX_REPORT_BODY_BYTES: usize = 32 * 1024;
const MAX_KV_VALUE_BYTES: usize = 1_024;
const HANGUP_SETTLE_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_SETTLE_WAIT_TIMEOUT: Duration = Duration::from_secs(3);
const PLAYBACK_POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, Copy)]
pub(crate) struct PhoneCallTimeouts {
    pub(crate) approval_timeout: Duration,
    pub(crate) max_call_duration: Duration,
    pub(crate) opening_greeting_wait: Duration,
}

impl Default for PhoneCallTimeouts {
    fn default() -> Self {
        Self {
            approval_timeout: DEFAULT_APPROVAL_TIMEOUT,
            max_call_duration: DEFAULT_MAX_CALL_DURATION,
            opening_greeting_wait: DEFAULT_OPENING_GREETING_WAIT,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum PhoneCallError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Rejected(String),
    #[error("{0}")]
    Internal(String),
}

#[derive(Debug, Clone)]
pub(crate) struct StartPhoneCallRequest {
    pub(crate) phone_number: String,
    pub(crate) objective: String,
    pub(crate) callee_name: Option<String>,
    pub(crate) first_message: Option<String>,
    pub(crate) context: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PhoneCallStatus {
    AwaitingApproval,
    Dialing,
    Ringing,
    InProgress,
    Completed,
    Cancelled,
    Failed,
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartPhoneCallResult {
    pub(crate) call_id: String,
    pub(crate) status: PhoneCallStatus,
    pub(crate) phone_number: String,
    pub(crate) callee_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SteerPhoneCallStatus {
    Steered,
    AlreadyEnded,
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SteerPhoneCallResult {
    pub(crate) call_id: String,
    pub(crate) status: SteerPhoneCallStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HangupPhoneCallStatus {
    HungUp,
    AlreadyEnded,
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HangupPhoneCallResult {
    pub(crate) call_id: String,
    pub(crate) status: HangupPhoneCallStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhoneCallSnapshot {
    pub(crate) call_id: String,
    pub(crate) status: PhoneCallStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) phone_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) callee_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) objective: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) connected_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) duration_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) end_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) outcome_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) transcript: Vec<TranscriptEntry>,
}

impl PhoneCallSnapshot {
    fn not_found(call_id: String) -> Self {
        Self {
            call_id,
            status: PhoneCallStatus::NotFound,
            phone_number: None,
            callee_name: None,
            objective: None,
            started_at: None,
            connected_at: None,
            ended_at: None,
            duration_seconds: None,
            end_reason: None,
            outcome_summary: None,
            transcript: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApprovalDecision {
    Approve,
    Decline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EndTrigger {
    MobileHangup,
    AgentHangup,
    ThreadRetired,
    Shutdown,
}

#[derive(Debug)]
struct LiveWorkGuard {
    counter: Arc<AtomicUsize>,
}

impl LiveWorkGuard {
    fn acquire(counter: &Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::AcqRel);
        Self {
            counter: Arc::clone(counter),
        }
    }
}

impl Drop for LiveWorkGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Debug)]
struct SharedCallState {
    status: PhoneCallStatus,
    started_at_iso: String,
    connected_at_iso: Option<String>,
    connected_instant: Option<Instant>,
    ended_at_iso: Option<String>,
    duration_seconds: Option<u64>,
    end_reason: Option<String>,
    outcome_summary: Option<String>,
    transcript: Vec<TranscriptEntry>,
    pre_connect_steers: Vec<String>,
}

#[derive(Debug)]
struct ActiveCallSlot {
    call_id: String,
    owner_thread_id: String,
    phone_number: String,
    callee_name: Option<String>,
    objective: String,
    approval_tx: StdMutex<Option<oneshot::Sender<ApprovalDecision>>>,
    steer_tx: mpsc::UnboundedSender<String>,
    cancel: CancellationToken,
    end_trigger: OnceLock<EndTrigger>,
    skip_post_call_report: AtomicBool,
    settled_tx: watch::Sender<bool>,
    settled_rx: watch::Receiver<bool>,
    shared: StdMutex<SharedCallState>,
}

impl ActiveCallSlot {
    fn request_hangup(&self, trigger: EndTrigger) {
        if matches!(trigger, EndTrigger::ThreadRetired | EndTrigger::Shutdown) {
            self.skip_post_call_report.store(true, Ordering::Release);
        }
        let _ = self.end_trigger.set(trigger);
        self.cancel.cancel();
    }

    fn snapshot(&self) -> PhoneCallSnapshot {
        let guard = lock_unpoisoned(&self.shared);
        let live_duration = guard.duration_seconds.or_else(|| {
            guard
                .connected_instant
                .map(|started| Instant::now().saturating_duration_since(started).as_secs())
        });
        PhoneCallSnapshot {
            call_id: self.call_id.clone(),
            status: guard.status,
            phone_number: Some(self.phone_number.clone()),
            callee_name: self.callee_name.clone(),
            objective: Some(self.objective.clone()),
            started_at: Some(guard.started_at_iso.clone()),
            connected_at: guard.connected_at_iso.clone(),
            ended_at: guard.ended_at_iso.clone(),
            duration_seconds: live_duration,
            end_reason: guard.end_reason.clone(),
            outcome_summary: guard.outcome_summary.clone(),
            transcript: guard.transcript.clone(),
        }
    }
}

#[derive(Debug, Clone)]
struct CompletedCallRecord {
    call_id: String,
    owner_thread_id: String,
    snapshot: PhoneCallSnapshot,
}

#[derive(Debug, Default)]
struct PhoneCallRegistry {
    active: Option<Arc<ActiveCallSlot>>,
    completed: VecDeque<CompletedCallRecord>,
}

pub(crate) struct PhoneCallService {
    config: Option<PhoneCallRuntimeConfig>,
    hub: Arc<ClientHub>,
    queue: Weak<BridgeQueueService>,
    live_work_count: Arc<AtomicUsize>,
    registry: Arc<StdMutex<PhoneCallRegistry>>,
    timeouts: PhoneCallTimeouts,
    custom_tls_config: Option<Arc<rustls::ClientConfig>>,
    shutdown: CancellationToken,
}

impl std::fmt::Debug for PhoneCallService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PhoneCallService")
            .field("config", &self.config)
            .field("hub_stream_id", &self.hub.stream_id())
            .field("queue_present", &self.queue.strong_count())
            .field(
                "live_work_count",
                &self.live_work_count.load(Ordering::Acquire),
            )
            .field("registry", &self.registry)
            .field("timeouts", &self.timeouts)
            .field("custom_tls_config", &self.custom_tls_config.is_some())
            .field("shutdown", &self.shutdown.is_cancelled())
            .finish()
    }
}

impl PhoneCallService {
    pub(crate) fn new(
        config: Option<PhoneCallRuntimeConfig>,
        hub: Arc<ClientHub>,
        queue: Weak<BridgeQueueService>,
    ) -> Arc<Self> {
        Self::with_options(config, hub, queue, PhoneCallTimeouts::default(), None)
    }

    pub(crate) fn with_options(
        config: Option<PhoneCallRuntimeConfig>,
        hub: Arc<ClientHub>,
        queue: Weak<BridgeQueueService>,
        timeouts: PhoneCallTimeouts,
        custom_tls_config: Option<Arc<rustls::ClientConfig>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            config,
            hub,
            queue,
            live_work_count: Arc::new(AtomicUsize::new(0)),
            registry: Arc::new(StdMutex::new(PhoneCallRegistry::default())),
            timeouts,
            custom_tls_config,
            shutdown: CancellationToken::new(),
        })
    }

    #[cfg(test)]
    pub(crate) fn inert_for_test() -> Arc<Self> {
        Self::new(None, Arc::new(ClientHub::new()), Weak::new())
    }

    pub(crate) fn live_work_count(&self) -> usize {
        self.live_work_count.load(Ordering::Acquire)
    }

    pub(crate) fn start_phone_call<'a>(
        self: &'a Arc<Self>,
        caller_thread_id: &'a str,
        request: StartPhoneCallRequest,
    ) -> Pin<Box<dyn Future<Output = Result<StartPhoneCallResult, PhoneCallError>> + Send + 'a>>
    {
        Box::pin(self.start_phone_call_inner(caller_thread_id, request))
    }

    async fn start_phone_call_inner(
        self: &Arc<Self>,
        caller_thread_id: &str,
        request: StartPhoneCallRequest,
    ) -> Result<StartPhoneCallResult, PhoneCallError> {
        let owner_thread_id = caller_thread_id.trim();
        if owner_thread_id.is_empty() || owner_thread_id.len() > MAX_OBJECTIVE_BYTES {
            return Err(PhoneCallError::Invalid(
                "caller threadId must not be empty".to_string(),
            ));
        }

        let validated = validate_start_request(request)?;

        let runtime_config = self.config.clone().ok_or_else(|| {
            PhoneCallError::Invalid(
                "Outbound phone calls are not configured on this bridge; run 'dappercode voice configure' on desktop"
                    .to_string(),
            )
        })?;

        if self.shutdown.is_cancelled() {
            return Err(PhoneCallError::Internal(
                "bridge is shutting down".to_string(),
            ));
        }

        if let Some(queue) = self.queue.upgrade() {
            let _admission = queue
                .retirement_fence
                .admit(owner_thread_id)
                .await
                .map_err(PhoneCallError::Invalid)?;
        }

        let voice_client =
            VoicePipelineClient::new(runtime_config.voice.clone()).map_err(|err| {
                PhoneCallError::Internal(format!("invalid voice configuration: {err}"))
            })?;

        let live_guard = LiveWorkGuard::acquire(&self.live_work_count);
        let call_id = Uuid::new_v4().to_string();
        let (approval_tx, approval_rx) = oneshot::channel();
        let (steer_tx, steer_rx) = mpsc::unbounded_channel();
        let (settled_tx, settled_rx) = watch::channel(false);
        let call_cancel = self.shutdown.child_token();

        let slot = Arc::new(ActiveCallSlot {
            call_id: call_id.clone(),
            owner_thread_id: owner_thread_id.to_string(),
            phone_number: validated.phone_number.clone(),
            callee_name: validated.callee_name.clone(),
            objective: validated.objective.clone(),
            approval_tx: StdMutex::new(Some(approval_tx)),
            steer_tx,
            cancel: call_cancel.clone(),
            end_trigger: OnceLock::new(),
            skip_post_call_report: AtomicBool::new(false),
            settled_tx,
            settled_rx,
            shared: StdMutex::new(SharedCallState {
                status: PhoneCallStatus::AwaitingApproval,
                started_at_iso: now_iso(),
                connected_at_iso: None,
                connected_instant: None,
                ended_at_iso: None,
                duration_seconds: None,
                end_reason: None,
                outcome_summary: None,
                transcript: Vec::new(),
                pre_connect_steers: Vec::new(),
            }),
        });

        {
            let mut registry = lock_unpoisoned(&self.registry);
            if registry.active.is_some() {
                return Err(PhoneCallError::Rejected(
                    "Another phone call is already active or awaiting approval on this workspace"
                        .to_string(),
                ));
            }
            registry.active = Some(Arc::clone(&slot));
        }

        let approval_surface_id = approval_surface_id(&call_id);
        let live_surface_id = live_surface_id(&call_id);
        let mut abort_guard = PreConnectAbortGuard {
            service: Arc::clone(self),
            slot: Arc::clone(&slot),
            live_guard: Some(live_guard),
            approval_dismissed: false,
            live_card_presented: false,
            armed: true,
        };

        let approval_surface = build_approval_modal_surface(
            &approval_surface_id,
            owner_thread_id,
            &runtime_config,
            &validated,
        );
        if let Err(err) = self
            .publish_surface("bridge/ui.present", &approval_surface)
            .await
        {
            abort_guard.approval_dismissed = true;
            abort_guard.disarm_and_finish_cancelled(
                PhoneCallStatus::Failed,
                "ui_surface_error",
                Some(err.clone()),
            );
            return Err(PhoneCallError::Internal(err));
        }

        let approval_outcome = tokio::select! {
            biased;
            () = call_cancel.cancelled() => Err("cancelled"),
            res = approval_rx => match res {
                Ok(ApprovalDecision::Approve) => Ok(()),
                Ok(ApprovalDecision::Decline) | Err(_) => Err("declined"),
            },
            () = tokio::time::sleep(self.timeouts.approval_timeout) => Err("timeout"),
        };

        {
            let mut tx_guard = lock_unpoisoned(&slot.approval_tx);
            let _ = tx_guard.take();
        }
        self.dismiss_surface(&approval_surface_id, owner_thread_id)
            .await;
        abort_guard.approval_dismissed = true;

        if let Err(reason_tag) = approval_outcome {
            let (final_status, reason_str, err_msg) = match reason_tag {
                "declined" => (
                    PhoneCallStatus::Cancelled,
                    "declined_by_user",
                    "Phone call was declined by the user",
                ),
                "timeout" => (
                    PhoneCallStatus::Cancelled,
                    "approval_timeout",
                    "Timed out waiting for phone call approval",
                ),
                _ => (
                    PhoneCallStatus::Cancelled,
                    "cancelled_before_dial",
                    "Phone call was cancelled before dialing",
                ),
            };
            abort_guard.disarm_and_finish_cancelled(final_status, reason_str, None);
            return Err(PhoneCallError::Rejected(err_msg.to_string()));
        }

        {
            let mut shared = lock_unpoisoned(&slot.shared);
            shared.status = PhoneCallStatus::Dialing;
        }

        let created_at = now_iso();
        let initial_live_card = build_live_workflow_card(
            &live_surface_id,
            owner_thread_id,
            &runtime_config,
            &validated,
            &created_at,
            LiveCardParams {
                title_override: None,
                subtitle: "Dialing…",
                status_value: "Dialing",
                tone: BridgeUiTone::Info,
                in_call_actions: true,
                dismissible: false,
                duration_seconds: None,
                detail_label_value: None,
                transcript: &snapshot_transcript(&slot),
            },
        );
        let _ = self
            .publish_surface("bridge/ui.present", &initial_live_card)
            .await;
        abort_guard.live_card_presented = true;

        // Warm local STT/LLM/TTS models concurrently while SIP INVITE/ringing proceeds.
        let preload_client = voice_client.clone();
        let preload_cancel = call_cancel.child_token();
        tokio::spawn(async move {
            let _ = preload_client.preload_models(&preload_cancel).await;
        });

        let mut dial_config = SipDialConfig::new(
            runtime_config.server_host.clone(),
            runtime_config.server_port,
            runtime_config.transport,
            runtime_config.caller_id.clone(),
            validated.phone_number.clone(),
        )
        .with_display_name(runtime_config.user_display_name.clone());
        if !runtime_config.sip_username.is_empty() {
            dial_config = dial_config.with_credentials(
                runtime_config.sip_username.clone(),
                runtime_config.sip_password.clone(),
            );
        }
        if let Some(custom_tls) = &self.custom_tls_config {
            dial_config = dial_config.with_custom_tls_config(Arc::clone(custom_tls));
        }

        let dial_res = tokio::select! {
            biased;
            () = call_cancel.cancelled() => Err(PreConnectFailure::Cancelled),
            res = SipCallSession::dial(dial_config) => res.map_err(|err| PreConnectFailure::DialFailed(err.to_string())),
        };

        let pre_connect_card_ctx = PreConnectCardContext {
            live_surface_id: &live_surface_id,
            owner_thread_id,
            runtime_config: &runtime_config,
            validated: &validated,
            created_at: &created_at,
        };

        let mut sip_session = match dial_res {
            Ok(session) => session,
            Err(fail) => {
                return Err(self
                    .finish_pre_connect_failure(&mut abort_guard, &pre_connect_card_ctx, fail)
                    .await);
            }
        };

        let negotiated_dtmf_pt = loop {
            let next_ev = tokio::select! {
                biased;
                () = call_cancel.cancelled() => break Err(PreConnectFailure::Cancelled),
                ev = sip_session.next_event() => ev.ok_or_else(|| PreConnectFailure::DialFailed("SIP session closed before connecting".to_string())),
            };

            match next_ev {
                Ok(SipCallEvent::Ringing) => {
                    {
                        let mut shared = lock_unpoisoned(&slot.shared);
                        shared.status = PhoneCallStatus::Ringing;
                    }
                    let ringing_card = build_live_workflow_card(
                        &live_surface_id,
                        owner_thread_id,
                        &runtime_config,
                        &validated,
                        &created_at,
                        LiveCardParams {
                            title_override: None,
                            subtitle: "Ringing…",
                            status_value: "Ringing",
                            tone: BridgeUiTone::Info,
                            in_call_actions: true,
                            dismissible: false,
                            duration_seconds: None,
                            detail_label_value: None,
                            transcript: &snapshot_transcript(&slot),
                        },
                    );
                    let _ = self
                        .publish_surface("bridge/ui.update", &ringing_card)
                        .await;
                }
                Ok(SipCallEvent::Connected { negotiated_dtmf_pt }) => {
                    break Ok(negotiated_dtmf_pt);
                }
                Ok(SipCallEvent::Ended { reason }) => {
                    let detail = match sip_session.state() {
                        SipCallState::Ended {
                            failure: Some(fail),
                            ..
                        } => fail.into_sip_error().to_string(),
                        _ => reason,
                    };
                    break Err(PreConnectFailure::DialFailed(detail));
                }
                Err(fail) => break Err(fail),
            }
        };

        let negotiated_dtmf_pt = match negotiated_dtmf_pt {
            Ok(pt) => pt,
            Err(fail) => {
                let _ = sip_session.hangup().await;
                return Err(self
                    .finish_pre_connect_failure(&mut abort_guard, &pre_connect_card_ctx, fail)
                    .await);
            }
        };

        let connected_instant = Instant::now();
        let connected_iso = now_iso();
        let initial_steers = {
            let mut shared = lock_unpoisoned(&slot.shared);
            shared.status = PhoneCallStatus::InProgress;
            shared.connected_instant = Some(connected_instant);
            shared.connected_at_iso = Some(connected_iso);
            std::mem::take(&mut shared.pre_connect_steers)
        };

        let in_call_card = build_live_workflow_card(
            &live_surface_id,
            owner_thread_id,
            &runtime_config,
            &validated,
            &created_at,
            LiveCardParams {
                title_override: None,
                subtitle: "In call",
                status_value: "In call",
                tone: BridgeUiTone::Success,
                in_call_actions: true,
                dismissible: false,
                duration_seconds: Some(0),
                detail_label_value: None,
                transcript: &snapshot_transcript(&slot),
            },
        );
        let _ = self
            .publish_surface("bridge/ui.update", &in_call_card)
            .await;

        let runner_guard = abort_guard.disarm_take_live_guard();
        let runner_ctx = ConnectedCallContext {
            service: Arc::clone(self),
            slot: Arc::clone(&slot),
            runtime_config,
            validated: validated.clone(),
            live_surface_id,
            card_created_at: created_at,
            connected_instant,
            negotiated_dtmf_pt,
            voice_client,
            sip_session,
            steer_rx,
            initial_steers,
            _live_guard: runner_guard,
        };

        tokio::spawn(Box::pin(async move {
            run_connected_call(runner_ctx).await;
        }));

        Ok(StartPhoneCallResult {
            call_id,
            status: PhoneCallStatus::InProgress,
            phone_number: validated.phone_number,
            callee_name: validated.callee_name,
        })
    }

    pub(crate) fn steer_phone_call(
        &self,
        caller_thread_id: &str,
        call_id: &str,
        instruction: &str,
    ) -> Result<SteerPhoneCallResult, PhoneCallError> {
        let normalized_call_id = validate_call_id(call_id)?;
        let normalized_instruction = validate_steer_instruction(instruction)?;
        let caller = caller_thread_id.trim();

        let active_slot = {
            let registry = lock_unpoisoned(&self.registry);
            if let Some(active) = &registry.active {
                if active.call_id == normalized_call_id {
                    if active.owner_thread_id != caller {
                        return Ok(SteerPhoneCallResult {
                            call_id: normalized_call_id,
                            status: SteerPhoneCallStatus::NotFound,
                        });
                    }
                    Some(Arc::clone(active))
                } else {
                    None
                }
            } else {
                None
            }
        };

        if let Some(slot) = active_slot {
            let send_to_channel = {
                let mut shared = lock_unpoisoned(&slot.shared);
                match shared.status {
                    PhoneCallStatus::AwaitingApproval
                    | PhoneCallStatus::Dialing
                    | PhoneCallStatus::Ringing => {
                        shared
                            .pre_connect_steers
                            .push(normalized_instruction.clone());
                        shared.transcript.push(TranscriptEntry {
                            speaker: TranscriptSpeaker::Steer,
                            text: normalized_instruction.clone(),
                            interrupted: false,
                        });
                        false
                    }
                    PhoneCallStatus::InProgress => true,
                    PhoneCallStatus::Completed
                    | PhoneCallStatus::Cancelled
                    | PhoneCallStatus::Failed
                    | PhoneCallStatus::NotFound => {
                        return Ok(SteerPhoneCallResult {
                            call_id: normalized_call_id,
                            status: SteerPhoneCallStatus::AlreadyEnded,
                        });
                    }
                }
            };

            if send_to_channel && slot.steer_tx.send(normalized_instruction).is_err() {
                return Ok(SteerPhoneCallResult {
                    call_id: normalized_call_id,
                    status: SteerPhoneCallStatus::AlreadyEnded,
                });
            }

            return Ok(SteerPhoneCallResult {
                call_id: normalized_call_id,
                status: SteerPhoneCallStatus::Steered,
            });
        }

        let in_completed_for_caller = {
            let registry = lock_unpoisoned(&self.registry);
            registry
                .completed
                .iter()
                .any(|entry| entry.call_id == normalized_call_id && entry.owner_thread_id == caller)
        };
        if in_completed_for_caller {
            return Ok(SteerPhoneCallResult {
                call_id: normalized_call_id,
                status: SteerPhoneCallStatus::AlreadyEnded,
            });
        }

        Ok(SteerPhoneCallResult {
            call_id: normalized_call_id,
            status: SteerPhoneCallStatus::NotFound,
        })
    }

    pub(crate) fn get_phone_call(
        &self,
        caller_thread_id: &str,
        call_id: &str,
    ) -> Result<PhoneCallSnapshot, PhoneCallError> {
        let normalized_call_id = validate_call_id(call_id)?;
        let caller = caller_thread_id.trim();

        let active_match = {
            let registry = lock_unpoisoned(&self.registry);
            registry
                .active
                .as_ref()
                .filter(|active| {
                    active.call_id == normalized_call_id && active.owner_thread_id == caller
                })
                .cloned()
        };
        if let Some(slot) = active_match {
            return Ok(slot.snapshot());
        }

        let completed_match = {
            let registry = lock_unpoisoned(&self.registry);
            registry
                .completed
                .iter()
                .find(|entry| {
                    entry.call_id == normalized_call_id && entry.owner_thread_id == caller
                })
                .map(|entry| entry.snapshot.clone())
        };
        if let Some(snapshot) = completed_match {
            return Ok(snapshot);
        }

        Ok(PhoneCallSnapshot::not_found(normalized_call_id))
    }

    pub(crate) fn hangup_phone_call<'a>(
        &'a self,
        caller_thread_id: &'a str,
        call_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<HangupPhoneCallResult, PhoneCallError>> + Send + 'a>>
    {
        Box::pin(async move {
            let normalized_call_id = validate_call_id(call_id)?;
            let caller = caller_thread_id.trim();

            let maybe_settled_rx = {
                let registry = lock_unpoisoned(&self.registry);
                if let Some(active) = &registry.active {
                    if active.call_id == normalized_call_id {
                        if active.owner_thread_id != caller {
                            return Ok(HangupPhoneCallResult {
                                call_id: normalized_call_id,
                                status: HangupPhoneCallStatus::NotFound,
                            });
                        }
                        active.request_hangup(EndTrigger::AgentHangup);
                        Some(active.settled_rx.clone())
                    } else {
                        None
                    }
                } else {
                    None
                }
            };

            if let Some(mut settled_rx) = maybe_settled_rx {
                wait_for_settled(&mut settled_rx, HANGUP_SETTLE_WAIT_TIMEOUT).await;
                return Ok(HangupPhoneCallResult {
                    call_id: normalized_call_id,
                    status: HangupPhoneCallStatus::HungUp,
                });
            }

            let in_completed_for_caller = {
                let registry = lock_unpoisoned(&self.registry);
                registry.completed.iter().any(|entry| {
                    entry.call_id == normalized_call_id && entry.owner_thread_id == caller
                })
            };
            if in_completed_for_caller {
                return Ok(HangupPhoneCallResult {
                    call_id: normalized_call_id,
                    status: HangupPhoneCallStatus::AlreadyEnded,
                });
            }

            Ok(HangupPhoneCallResult {
                call_id: normalized_call_id,
                status: HangupPhoneCallStatus::NotFound,
            })
        })
    }

    pub(crate) async fn resolve_ui_action(&self, request: &ResolveBridgeUiSurfaceRequest) {
        let surface_id = request.id.trim();
        let thread_id = request.thread_id.trim();
        let action_id = request.action_id.trim();

        let is_approval = surface_id.starts_with("phone-call-approval:");
        let is_live = surface_id.starts_with("phone-call-live:");
        if !is_approval && !is_live {
            return;
        }

        let active_slot = {
            let registry = lock_unpoisoned(&self.registry);
            registry.active.clone()
        };
        let Some(slot) = active_slot else {
            return;
        };
        if slot.owner_thread_id != thread_id {
            return;
        }

        if is_approval && surface_id == approval_surface_id(&slot.call_id) {
            let decision = match action_id {
                "approve" => Some(ApprovalDecision::Approve),
                "cancel" => Some(ApprovalDecision::Decline),
                _ => None,
            };
            if let Some(decision) = decision {
                let sender = {
                    let mut tx_guard = lock_unpoisoned(&slot.approval_tx);
                    tx_guard.take()
                };
                if let Some(tx) = sender {
                    let _ = tx.send(decision);
                }
            }
        } else if is_live && surface_id == live_surface_id(&slot.call_id) && action_id == "hangup" {
            slot.request_hangup(EndTrigger::MobileHangup);
        }
    }

    pub(crate) async fn cancel_for_retiring_threads(&self, thread_ids: &[String]) {
        let maybe_settled_rx = {
            let registry = lock_unpoisoned(&self.registry);
            if let Some(active) = &registry.active {
                if thread_ids
                    .iter()
                    .any(|id| id.trim() == active.owner_thread_id)
                {
                    active.request_hangup(EndTrigger::ThreadRetired);
                    Some(active.settled_rx.clone())
                } else {
                    None
                }
            } else {
                None
            }
        };
        if let Some(mut settled_rx) = maybe_settled_rx {
            wait_for_settled(&mut settled_rx, SHUTDOWN_SETTLE_WAIT_TIMEOUT).await;
        }
    }

    pub(crate) async fn shutdown(&self) {
        self.shutdown.cancel();
        let maybe_settled_rx = {
            let registry = lock_unpoisoned(&self.registry);
            if let Some(active) = &registry.active {
                active.request_hangup(EndTrigger::Shutdown);
                Some(active.settled_rx.clone())
            } else {
                None
            }
        };
        if let Some(mut settled_rx) = maybe_settled_rx {
            wait_for_settled(&mut settled_rx, SHUTDOWN_SETTLE_WAIT_TIMEOUT).await;
        }
    }

    async fn publish_surface(&self, method: &str, surface: &BridgeUiSurface) -> Result<(), String> {
        validate_bridge_ui_surface(surface).map_err(|err| err.message)?;
        let value = serde_json::to_value(surface)
            .map_err(|err| format!("failed serializing UI surface: {err}"))?;
        self.hub.broadcast_notification(method, value).await;
        Ok(())
    }

    async fn dismiss_surface(&self, surface_id: &str, thread_id: &str) {
        self.hub
            .broadcast_notification(
                "bridge/ui.dismiss",
                json!({
                    "id": surface_id,
                    "threadId": thread_id,
                }),
            )
            .await;
    }

    async fn finish_pre_connect_failure(
        &self,
        abort_guard: &mut PreConnectAbortGuard,
        card_ctx: &PreConnectCardContext<'_>,
        failure: PreConnectFailure,
    ) -> PhoneCallError {
        let (final_status, title, subtitle, status_val, tone, reason, err) = match failure {
            PreConnectFailure::Cancelled => (
                PhoneCallStatus::Cancelled,
                Some("Phone call ended"),
                "Cancelled before answer",
                "Cancelled",
                BridgeUiTone::Neutral,
                "cancelled_before_connect".to_string(),
                PhoneCallError::Rejected("Phone call was hung up before connecting".to_string()),
            ),
            PreConnectFailure::DialFailed(detail) => (
                PhoneCallStatus::Failed,
                Some("Phone call failed"),
                "Call could not connect",
                "Failed",
                BridgeUiTone::Error,
                detail.clone(),
                PhoneCallError::Internal(format!("Outbound phone call failed: {detail}")),
            ),
        };

        let settled_card = build_live_workflow_card(
            card_ctx.live_surface_id,
            card_ctx.owner_thread_id,
            card_ctx.runtime_config,
            card_ctx.validated,
            card_ctx.created_at,
            LiveCardParams {
                title_override: title,
                subtitle,
                status_value: status_val,
                tone,
                in_call_actions: false,
                dismissible: true,
                duration_seconds: None,
                detail_label_value: Some(("Reason", &reason)),
                transcript: &snapshot_transcript(&abort_guard.slot),
            },
        );
        let _ = self
            .publish_surface("bridge/ui.update", &settled_card)
            .await;
        abort_guard.live_card_presented = false;
        abort_guard.disarm_and_finish_cancelled(final_status, &reason, None);
        err
    }

    fn complete_slot(
        &self,
        slot: &Arc<ActiveCallSlot>,
        final_status: PhoneCallStatus,
        duration_seconds: Option<u64>,
        end_reason: String,
        outcome_summary: Option<String>,
        final_transcript: Option<Vec<TranscriptEntry>>,
    ) {
        {
            let mut shared = lock_unpoisoned(&slot.shared);
            shared.status = final_status;
            shared.ended_at_iso = Some(now_iso());
            shared.duration_seconds = duration_seconds;
            shared.end_reason = Some(end_reason);
            shared.outcome_summary = outcome_summary;
            if let Some(entries) = final_transcript {
                shared.transcript = entries;
            }
        }
        let snapshot = slot.snapshot();
        {
            let mut registry = lock_unpoisoned(&self.registry);
            if registry
                .active
                .as_ref()
                .is_some_and(|active| active.call_id == slot.call_id)
            {
                registry.active = None;
            }
            if registry.completed.len() >= COMPLETED_CALL_HISTORY_LIMIT {
                let _ = registry.completed.pop_front();
            }
            registry.completed.push_back(CompletedCallRecord {
                call_id: slot.call_id.clone(),
                owner_thread_id: slot.owner_thread_id.clone(),
                snapshot,
            });
        }
        let _ = slot.settled_tx.send(true);
    }
}

struct PreConnectCardContext<'a> {
    live_surface_id: &'a str,
    owner_thread_id: &'a str,
    runtime_config: &'a PhoneCallRuntimeConfig,
    validated: &'a ValidatedStartRequest,
    created_at: &'a str,
}

enum PreConnectFailure {
    Cancelled,
    DialFailed(String),
}

struct PreConnectAbortGuard {
    service: Arc<PhoneCallService>,
    slot: Arc<ActiveCallSlot>,
    live_guard: Option<LiveWorkGuard>,
    approval_dismissed: bool,
    live_card_presented: bool,
    armed: bool,
}

impl PreConnectAbortGuard {
    fn disarm_and_finish_cancelled(
        &mut self,
        final_status: PhoneCallStatus,
        reason: &str,
        outcome_summary: Option<String>,
    ) {
        self.armed = false;
        self.service.complete_slot(
            &self.slot,
            final_status,
            None,
            reason.to_string(),
            outcome_summary,
            None,
        );
        let _ = self.live_guard.take();
    }

    fn disarm_take_live_guard(&mut self) -> LiveWorkGuard {
        self.armed = false;
        self.live_guard
            .take()
            .unwrap_or_else(|| LiveWorkGuard::acquire(&self.service.live_work_count))
    }
}

impl Drop for PreConnectAbortGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.slot.cancel.cancel();
        self.service.complete_slot(
            &self.slot,
            PhoneCallStatus::Cancelled,
            None,
            "caller_dropped".to_string(),
            None,
            None,
        );
        let guard = self.live_guard.take();
        let need_dismiss_approval = !self.approval_dismissed;
        let need_dismiss_live = self.live_card_presented;
        if (need_dismiss_approval || need_dismiss_live)
            && tokio::runtime::Handle::try_current().is_ok()
        {
            let service = Arc::clone(&self.service);
            let call_id = self.slot.call_id.clone();
            let thread_id = self.slot.owner_thread_id.clone();
            tokio::spawn(async move {
                let _keep_alive = guard;
                if need_dismiss_approval {
                    service
                        .dismiss_surface(&approval_surface_id(&call_id), &thread_id)
                        .await;
                }
                if need_dismiss_live {
                    service
                        .dismiss_surface(&live_surface_id(&call_id), &thread_id)
                        .await;
                }
            });
        }
    }
}

#[derive(Debug, Clone)]
struct ValidatedStartRequest {
    phone_number: String,
    objective: String,
    callee_name: Option<String>,
    first_message: Option<String>,
    context: Option<String>,
}

fn validate_start_request(
    request: StartPhoneCallRequest,
) -> Result<ValidatedStartRequest, PhoneCallError> {
    let phone_number = validate_e164_phone_number("phoneNumber", &request.phone_number)
        .map_err(PhoneCallError::Invalid)?;

    if request.objective.len() > MAX_OBJECTIVE_BYTES || request.objective.contains('\0') {
        return Err(PhoneCallError::Invalid(format!(
            "objective must be at most {MAX_OBJECTIVE_BYTES} bytes and free of NUL characters"
        )));
    }
    let objective = request.objective.trim().to_string();
    if objective.is_empty() {
        return Err(PhoneCallError::Invalid(
            "objective must not be empty".to_string(),
        ));
    }

    let callee_name = match request.callee_name {
        Some(raw) => {
            if raw.len() > MAX_CALLEE_NAME_BYTES || raw.chars().any(char::is_control) {
                return Err(PhoneCallError::Invalid(format!(
                    "calleeName must be at most {MAX_CALLEE_NAME_BYTES} bytes and free of control characters"
                )));
            }
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        None => None,
    };

    let first_message = match request.first_message {
        Some(raw) => {
            if raw.len() > MAX_FIRST_MESSAGE_BYTES || raw.contains('\0') {
                return Err(PhoneCallError::Invalid(format!(
                    "firstMessage must be at most {MAX_FIRST_MESSAGE_BYTES} bytes and free of NUL characters"
                )));
            }
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        None => None,
    };

    let context = match request.context {
        Some(raw) => {
            if raw.len() > MAX_CONTEXT_BYTES || raw.contains('\0') {
                return Err(PhoneCallError::Invalid(format!(
                    "context must be at most {MAX_CONTEXT_BYTES} bytes and free of NUL characters"
                )));
            }
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        None => None,
    };

    Ok(ValidatedStartRequest {
        phone_number,
        objective,
        callee_name,
        first_message,
        context,
    })
}

fn validate_call_id(raw: &str) -> Result<String, PhoneCallError> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_CALL_ID_BYTES
        || trimmed.chars().any(char::is_control)
    {
        return Err(PhoneCallError::Invalid(format!(
            "callId must be between 1 and {MAX_CALL_ID_BYTES} printable bytes"
        )));
    }
    Ok(trimmed.to_string())
}

fn validate_steer_instruction(raw: &str) -> Result<String, PhoneCallError> {
    if raw.len() > MAX_STEER_INSTRUCTION_BYTES || raw.contains('\0') {
        return Err(PhoneCallError::Invalid(format!(
            "instruction must be at most {MAX_STEER_INSTRUCTION_BYTES} bytes and free of NUL characters"
        )));
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(PhoneCallError::Invalid(
            "instruction must not be empty".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

// ============================================================================
// Connected Full-Duplex Voice Call Runner
// ============================================================================

struct ConnectedCallContext {
    service: Arc<PhoneCallService>,
    slot: Arc<ActiveCallSlot>,
    runtime_config: PhoneCallRuntimeConfig,
    validated: ValidatedStartRequest,
    live_surface_id: String,
    card_created_at: String,
    connected_instant: Instant,
    negotiated_dtmf_pt: Option<u8>,
    voice_client: VoicePipelineClient,
    sip_session: SipCallSession,
    steer_rx: mpsc::UnboundedReceiver<String>,
    initial_steers: Vec<String>,
    _live_guard: LiveWorkGuard,
}

#[derive(Debug, Default)]
struct SpokenTurnProgress {
    clauses_started: Vec<(usize, String)>,
    total_frames_enqueued: usize,
}

impl SpokenTurnProgress {
    fn spoken_text(&self, cleared_frames: usize) -> String {
        if self.clauses_started.is_empty() {
            return String::new();
        }
        let played_frames = self.total_frames_enqueued.saturating_sub(cleared_frames);
        let mut spoken: Vec<&str> = Vec::new();
        for (idx, (start_frame, clause)) in self.clauses_started.iter().enumerate() {
            if *start_frame < played_frames || (idx == 0 && self.total_frames_enqueued > 0) {
                spoken.push(clause.as_str());
            }
        }
        spoken.join(" ")
    }
}

struct ActiveAssistantTurn {
    cancel: CancellationToken,
    progress: Arc<StdMutex<SpokenTurnProgress>>,
    handle: JoinHandle<Result<AssistantTurnOutput, VoiceError>>,
}

impl ActiveAssistantTurn {
    fn abort_and_extract_spoken(&self, cleared_frames: usize) -> String {
        self.cancel.cancel();
        self.handle.abort();
        let guard = lock_unpoisoned(&self.progress);
        guard.spoken_text(cleared_frames)
    }
}

struct ActiveSttTask {
    cancel: CancellationToken,
    handle: JoinHandle<Result<Option<String>, VoiceError>>,
}

impl ActiveSttTask {
    fn abort(&self) {
        self.cancel.cancel();
        self.handle.abort();
    }
}

enum CallLoopExit {
    Completed {
        end_reason: String,
        outcome_summary: Option<String>,
    },
    Failed {
        error: String,
    },
}

async fn run_connected_call(mut ctx: ConnectedCallContext) {
    let sip_handle = ctx.sip_session.control_handle();
    let mut event_rx = ctx.sip_session.take_event_receiver();
    let mut inbound_audio_rx = ctx.sip_session.take_inbound_audio_receiver();

    let mut conversation = VoiceConversation::new(VoiceCallPromptParams {
        user_display_name: ctx.runtime_config.user_display_name.clone(),
        callee_name: ctx.validated.callee_name.clone(),
        objective: ctx.validated.objective.clone(),
        first_message: ctx.validated.first_message.clone(),
        context: ctx.validated.context.clone(),
    });
    for steer in &ctx.initial_steers {
        conversation.inject_steer(steer);
    }
    sync_shared_transcript(&ctx.slot, conversation.transcript());

    let mut vad = TelephonyVad::new();
    let call_deadline = tokio::time::Instant::from_std(
        ctx.connected_instant + ctx.service.timeouts.max_call_duration,
    );
    let opening_deadline = tokio::time::Instant::from_std(
        ctx.connected_instant + ctx.service.timeouts.opening_greeting_wait,
    );
    let mut opening_greeting_pending = true;
    let mut opening_window_elapsed = false;
    let mut steer_pending_turn = !ctx.initial_steers.is_empty();
    let mut active_stt: Option<ActiveSttTask> = None;
    let mut active_turn: Option<ActiveAssistantTurn> = None;

    if steer_pending_turn {
        opening_greeting_pending = false;
        opening_window_elapsed = true;
        steer_pending_turn = false;
        active_turn = Some(spawn_assistant_turn(
            &ctx.voice_client,
            &conversation,
            &sip_handle,
            &ctx.slot.cancel,
        ));
    }

    let exit = loop {
        tokio::select! {
            biased;
            () = ctx.slot.cancel.cancelled() => {
                if let Some(stt) = active_stt.take() {
                    stt.abort();
                }
                if let Some(turn) = active_turn.take() {
                    let cleared = sip_handle.clear_outbound_audio();
                    let spoken = turn.abort_and_extract_spoken(cleared.cleared_frames);
                    if !spoken.is_empty() {
                        conversation.mark_last_assistant_interrupted(&spoken);
                        sync_shared_transcript(&ctx.slot, conversation.transcript());
                    }
                }
                let _ = sip_handle.hangup().await;
                let end_reason = match ctx.slot.end_trigger.get().copied() {
                    Some(EndTrigger::MobileHangup) => "mobile_hangup",
                    Some(EndTrigger::AgentHangup) => "agent_hangup",
                    Some(EndTrigger::ThreadRetired) => "thread_retired",
                    Some(EndTrigger::Shutdown) | None => "bridge_shutdown",
                };
                break CallLoopExit::Completed {
                    end_reason: end_reason.to_string(),
                    outcome_summary: None,
                };
            }
            () = tokio::time::sleep_until(call_deadline) => {
                if let Some(stt) = active_stt.take() {
                    stt.abort();
                }
                if let Some(turn) = active_turn.take() {
                    let cleared = sip_handle.clear_outbound_audio();
                    let spoken = turn.abort_and_extract_spoken(cleared.cleared_frames);
                    if !spoken.is_empty() {
                        conversation.mark_last_assistant_interrupted(&spoken);
                        sync_shared_transcript(&ctx.slot, conversation.transcript());
                    }
                }
                let _ = sip_handle.hangup().await;
                break CallLoopExit::Completed {
                    end_reason: "max_duration_reached".to_string(),
                    outcome_summary: Some("Maximum call duration reached.".to_string()),
                };
            }
            ev_opt = recv_optional_sip_event(&mut event_rx), if event_rx.is_some() => {
                match ev_opt {
                    Some(SipCallEvent::Ended { reason }) => {
                        if let Some(stt) = active_stt.take() {
                            stt.abort();
                        }
                        if let Some(turn) = active_turn.take() {
                            let cleared = sip_handle.clear_outbound_audio();
                            let spoken = turn.abort_and_extract_spoken(cleared.cleared_frames);
                            if !spoken.is_empty() {
                                conversation.mark_last_assistant_interrupted(&spoken);
                                sync_shared_transcript(&ctx.slot, conversation.transcript());
                            }
                        }
                        break CallLoopExit::Completed {
                            end_reason: reason,
                            outcome_summary: None,
                        };
                    }
                    Some(SipCallEvent::Ringing | SipCallEvent::Connected { .. }) => {}
                    None => {
                        event_rx = None;
                    }
                }
            }
            Some(instruction) = ctx.steer_rx.recv() => {
                conversation.inject_steer(&instruction);
                sync_shared_transcript(&ctx.slot, conversation.transcript());
                publish_in_call_card_update(&ctx, conversation.transcript()).await;

                if active_turn.is_none() && active_stt.is_none() && !vad.is_in_speech() {
                    opening_greeting_pending = false;
                    opening_window_elapsed = true;
                    steer_pending_turn = false;
                    active_turn = Some(spawn_assistant_turn(
                        &ctx.voice_client,
                        &conversation,
                        &sip_handle,
                        &ctx.slot.cancel,
                    ));
                } else {
                    steer_pending_turn = true;
                }
            }
            audio_opt = recv_optional_inbound_audio(&mut inbound_audio_rx), if inbound_audio_rx.is_some() => {
                let Some(frame) = audio_opt else {
                    inbound_audio_rx = None;
                    continue;
                };
                let outbound_mean = mulaw_frame_mean_abs(&frame.outbound_pcmu);
                match vad.process_mulaw_frame(
                    &frame.inbound_pcmu,
                    frame.outbound_playing,
                    outbound_mean,
                ) {
                    Some(VadEvent::BargeIn) => {
                        let cleared = sip_handle.clear_outbound_audio();
                        if let Some(turn) = active_turn.take() {
                            let spoken = turn.abort_and_extract_spoken(cleared.cleared_frames);
                            conversation.mark_last_assistant_interrupted(&spoken);
                            sync_shared_transcript(&ctx.slot, conversation.transcript());
                            publish_in_call_card_update(&ctx, conversation.transcript()).await;
                        }
                    }
                    Some(VadEvent::UtteranceComplete(samples)) => {
                        if let Some(prev_stt) = active_stt.take() {
                            prev_stt.abort();
                        }
                        let wav = encode_wav_8k_mono(&samples);
                        active_stt = Some(spawn_stt_task(
                            &ctx.voice_client,
                            wav,
                            &conversation,
                            &ctx.slot.cancel,
                        ));
                    }
                    None => {}
                }
            }
            stt_join = poll_active_stt(&mut active_stt), if active_stt.is_some() => {
                active_stt = None;
                match stt_join {
                    Ok(Ok(Some(callee_text))) => {
                        opening_greeting_pending = false;
                        opening_window_elapsed = true;
                        steer_pending_turn = false;
                        if let Some(turn) = active_turn.take() {
                            let cleared = sip_handle.clear_outbound_audio();
                            let spoken = turn.abort_and_extract_spoken(cleared.cleared_frames);
                            conversation.mark_last_assistant_interrupted(&spoken);
                        }
                        conversation.push_callee_utterance(&callee_text);
                        sync_shared_transcript(&ctx.slot, conversation.transcript());
                        publish_in_call_card_update(&ctx, conversation.transcript()).await;
                        active_turn = Some(spawn_assistant_turn(
                            &ctx.voice_client,
                            &conversation,
                            &sip_handle,
                            &ctx.slot.cancel,
                        ));
                    }
                    Ok(Ok(None)) => {
                        let should_speak_now =
                            ((opening_greeting_pending && opening_window_elapsed)
                                || steer_pending_turn)
                                && active_turn.is_none()
                                && !vad.is_in_speech();
                        if should_speak_now {
                            opening_greeting_pending = false;
                            opening_window_elapsed = true;
                            steer_pending_turn = false;
                            active_turn = Some(spawn_assistant_turn(
                                &ctx.voice_client,
                                &conversation,
                                &sip_handle,
                                &ctx.slot.cancel,
                            ));
                        }
                    }
                    Ok(Err(err)) if err.is_cancelled() => {}
                    Ok(Err(err)) => {
                        if let Some(turn) = active_turn.take() {
                            let _ = turn.abort_and_extract_spoken(0);
                        }
                        let _ = sip_handle.hangup().await;
                        break CallLoopExit::Failed {
                            error: err.to_string(),
                        };
                    }
                    Err(join_err) => {
                        if !join_err.is_cancelled() {
                            let _ = sip_handle.hangup().await;
                            break CallLoopExit::Failed {
                                error: format!("transcription task failed: {join_err}"),
                            };
                        }
                    }
                }
            }
            turn_join = poll_active_turn(&mut active_turn), if active_turn.is_some() => {
                active_turn = None;
                match turn_join {
                    Ok(Ok(turn_output)) => {
                        conversation.record_assistant_turn(&turn_output);
                        sync_shared_transcript(&ctx.slot, conversation.transcript());
                        publish_in_call_card_update(&ctx, conversation.transcript()).await;

                        let mut end_call_requested: Option<(String, String)> = None;
                        let mut dtmf_error: Option<String> = None;

                        for tool_call in &turn_output.tool_calls {
                            match tool_call {
                                VoiceToolCall::SendDtmf {
                                    call_id: tc_id,
                                    digits,
                                } => {
                                    if let Err(err) = transmit_dtmf(
                                        &sip_handle,
                                        ctx.negotiated_dtmf_pt,
                                        digits,
                                    ) {
                                        dtmf_error = Some(err);
                                        break;
                                    }
                                    conversation.record_tool_result(
                                        tc_id,
                                        &format!("Sent DTMF digits: {digits}"),
                                    );
                                    vad.set_ivr_mode(true);
                                }
                                VoiceToolCall::WaitSilently {
                                    call_id: tc_id,
                                    reason,
                                } => {
                                    vad.set_ivr_mode(true);
                                    conversation.record_tool_result(
                                        tc_id,
                                        &format!("Waiting silently: {reason}"),
                                    );
                                }
                                VoiceToolCall::EndCall {
                                    call_id: tc_id,
                                    reason,
                                    outcome_summary,
                                } => {
                                    conversation.record_tool_result(tc_id, "Ending call");
                                    end_call_requested =
                                        Some((reason.clone(), outcome_summary.clone()));
                                    break;
                                }
                            }
                        }

                        if let Some(err) = dtmf_error {
                            let _ = sip_handle.hangup().await;
                            break CallLoopExit::Failed { error: err };
                        }

                        if let Some((reason, summary)) = end_call_requested {
                            let _ =
                                wait_for_outbound_media_drain(&sip_handle, &ctx.slot.cancel).await;
                            let _ = sip_handle.hangup().await;
                            break CallLoopExit::Completed {
                                end_reason: reason,
                                outcome_summary: Some(summary),
                            };
                        }

                        if steer_pending_turn && active_stt.is_none() && !vad.is_in_speech() {
                            steer_pending_turn = false;
                            active_turn = Some(spawn_assistant_turn(
                                &ctx.voice_client,
                                &conversation,
                                &sip_handle,
                                &ctx.slot.cancel,
                            ));
                        }
                    }
                    Ok(Err(err)) if err.is_cancelled() => {}
                    Ok(Err(err)) => {
                        let _ = sip_handle.hangup().await;
                        break CallLoopExit::Failed {
                            error: err.to_string(),
                        };
                    }
                    Err(join_err) => {
                        if !join_err.is_cancelled() {
                            let _ = sip_handle.hangup().await;
                            break CallLoopExit::Failed {
                                error: format!("assistant voice turn failed: {join_err}"),
                            };
                        }
                    }
                }
            }
            () = tokio::time::sleep_until(opening_deadline), if opening_greeting_pending && !opening_window_elapsed && active_turn.is_none() => {
                opening_window_elapsed = true;
                if !vad.is_in_speech() && active_stt.is_none() {
                    opening_greeting_pending = false;
                    steer_pending_turn = false;
                    active_turn = Some(spawn_assistant_turn(
                        &ctx.voice_client,
                        &conversation,
                        &sip_handle,
                        &ctx.slot.cancel,
                    ));
                }
            }
        }
    };

    settle_connected_call(&ctx, conversation.transcript().to_vec(), exit).await;
}

async fn settle_connected_call(
    ctx: &ConnectedCallContext,
    final_transcript: Vec<TranscriptEntry>,
    exit: CallLoopExit,
) {
    let duration_seconds = Instant::now()
        .saturating_duration_since(ctx.connected_instant)
        .as_secs();

    let (final_status, card_title, card_subtitle, status_label, tone, end_reason, outcome_summary) =
        match exit {
            CallLoopExit::Completed {
                end_reason,
                outcome_summary,
            } => (
                PhoneCallStatus::Completed,
                "Phone call ended",
                format!("Duration {}", format_duration_mm_ss(duration_seconds)),
                "Ended",
                BridgeUiTone::Neutral,
                end_reason,
                outcome_summary,
            ),
            CallLoopExit::Failed { error } => (
                PhoneCallStatus::Failed,
                "Phone call failed",
                format!("Failed after {}", format_duration_mm_ss(duration_seconds)),
                "Failed",
                BridgeUiTone::Error,
                error.clone(),
                Some(error),
            ),
        };

    let detail_pair = outcome_summary
        .as_deref()
        .map(|summary| ("Summary", summary))
        .or(Some(("Reason", end_reason.as_str())));

    let final_card = build_live_workflow_card(
        &ctx.live_surface_id,
        &ctx.slot.owner_thread_id,
        &ctx.runtime_config,
        &ctx.validated,
        &ctx.card_created_at,
        LiveCardParams {
            title_override: Some(card_title),
            subtitle: &card_subtitle,
            status_value: status_label,
            tone,
            in_call_actions: false,
            dismissible: true,
            duration_seconds: Some(duration_seconds),
            detail_label_value: detail_pair,
            transcript: &final_transcript,
        },
    );
    let _ = ctx
        .service
        .publish_surface("bridge/ui.update", &final_card)
        .await;

    // Move call to completed history before enqueuing the post-call ACP report so the agent can
    // immediately query get_phone_call or place another call when the report arrives.
    ctx.service.complete_slot(
        &ctx.slot,
        final_status,
        Some(duration_seconds),
        end_reason.clone(),
        outcome_summary.clone(),
        Some(final_transcript.clone()),
    );

    let skip_report = ctx.slot.skip_post_call_report.load(Ordering::Acquire)
        || ctx.service.shutdown.is_cancelled();
    if skip_report {
        return;
    }

    if let Some(queue) = ctx.service.queue.upgrade() {
        let content = build_post_call_report_content(
            &ctx.slot.call_id,
            final_status,
            &ctx.validated,
            duration_seconds,
            &end_reason,
            outcome_summary.as_deref(),
            &final_transcript,
        );
        let request = BridgeThreadQueueSendRequest {
            thread_id: ctx.slot.owner_thread_id.clone(),
            submission_id: format!("phone-call-report:{}", ctx.slot.call_id),
            content: content.clone(),
            turn_start: json!({
                "input": [{
                    "type": "text",
                    "text": content,
                    "text_elements": [],
                }],
            }),
        };
        let _ = queue.send_message(request).await;
    }
}

async fn publish_in_call_card_update(ctx: &ConnectedCallContext, transcript: &[TranscriptEntry]) {
    let elapsed_secs = Instant::now()
        .saturating_duration_since(ctx.connected_instant)
        .as_secs();
    let card = build_live_workflow_card(
        &ctx.live_surface_id,
        &ctx.slot.owner_thread_id,
        &ctx.runtime_config,
        &ctx.validated,
        &ctx.card_created_at,
        LiveCardParams {
            title_override: None,
            subtitle: "In call",
            status_value: "In call",
            tone: BridgeUiTone::Success,
            in_call_actions: true,
            dismissible: false,
            duration_seconds: Some(elapsed_secs),
            detail_label_value: None,
            transcript,
        },
    );
    let _ = ctx.service.publish_surface("bridge/ui.update", &card).await;
}

fn spawn_stt_task(
    voice_client: &VoicePipelineClient,
    wav_bytes: Vec<u8>,
    conversation: &VoiceConversation,
    parent_cancel: &CancellationToken,
) -> ActiveSttTask {
    let stt_cancel = parent_cancel.child_token();
    let task_cancel = stt_cancel.clone();
    let client = voice_client.clone();
    let conv_snapshot = conversation.clone();
    let handle = tokio::spawn(Box::pin(async move {
        client
            .transcribe_utterance(&wav_bytes, &conv_snapshot, &task_cancel)
            .await
    }));
    ActiveSttTask {
        cancel: stt_cancel,
        handle,
    }
}

fn spawn_assistant_turn(
    voice_client: &VoicePipelineClient,
    conversation: &VoiceConversation,
    sip_handle: &SipCallHandle,
    parent_cancel: &CancellationToken,
) -> ActiveAssistantTurn {
    let turn_cancel = parent_cancel.child_token();
    let task_cancel = turn_cancel.clone();
    let progress = Arc::new(StdMutex::new(SpokenTurnProgress::default()));
    let task_progress = Arc::clone(&progress);
    let client = voice_client.clone();
    let conv_snapshot = conversation.clone();
    let rtp_handle = sip_handle.clone();

    let handle = tokio::spawn(Box::pin(async move {
        let (clause_tx, mut clause_rx) = mpsc::unbounded_channel::<String>();
        let tts_client = client.clone();
        let tts_cancel = task_cancel.clone();
        let tts_progress = Arc::clone(&task_progress);
        let tts_rtp = rtp_handle.clone();

        let tts_task: JoinHandle<Result<(), VoiceError>> = tokio::spawn(Box::pin(async move {
            let mut downsampler = Downsampler24kTo8k::new();
            let mut pcm_8k_buf: Vec<i16> = Vec::new();

            while let Some(clause) = clause_rx.recv().await {
                if tts_cancel.is_cancelled() {
                    return Err(VoiceError::Cancelled);
                }
                {
                    let mut guard = lock_unpoisoned(&tts_progress);
                    let start_idx = guard.total_frames_enqueued;
                    guard.clauses_started.push((start_idx, clause.clone()));
                }

                tts_client
                    .synthesize_speech_pcm24k(&clause, &tts_cancel, |samples_24k| {
                        downsampler.push_pcm24k_samples(samples_24k, &mut pcm_8k_buf);
                        let full_frames = pcm_8k_buf.len() / RTP_FRAME_SAMPLES;
                        if full_frames > 0 {
                            let drain_samples = full_frames.saturating_mul(RTP_FRAME_SAMPLES);
                            let mut mulaw_frames = Vec::with_capacity(full_frames);
                            for chunk in pcm_8k_buf[..drain_samples].chunks_exact(RTP_FRAME_SAMPLES)
                            {
                                let mut frame_8k = [0_i16; RTP_FRAME_SAMPLES];
                                frame_8k.copy_from_slice(chunk);
                                mulaw_frames.push(encode_mulaw_frame_with_headroom(&frame_8k));
                            }
                            pcm_8k_buf.drain(..drain_samples);
                            {
                                let mut guard = lock_unpoisoned(&tts_progress);
                                guard.total_frames_enqueued = guard
                                    .total_frames_enqueued
                                    .saturating_add(mulaw_frames.len());
                            }
                            tts_rtp.enqueue_pcmu_frames(mulaw_frames);
                        }
                    })
                    .await?;
            }

            if !pcm_8k_buf.is_empty() && !tts_cancel.is_cancelled() {
                let mut tail_frame = [0_i16; RTP_FRAME_SAMPLES];
                let copy_len = pcm_8k_buf.len().min(RTP_FRAME_SAMPLES);
                tail_frame[..copy_len].copy_from_slice(&pcm_8k_buf[..copy_len]);
                pcm_8k_buf.clear();
                let encoded = encode_mulaw_frame_with_headroom(&tail_frame);
                {
                    let mut guard = lock_unpoisoned(&tts_progress);
                    guard.total_frames_enqueued = guard.total_frames_enqueued.saturating_add(1);
                }
                tts_rtp.enqueue_pcmu_frames(vec![encoded]);
            }

            Ok(())
        }));

        let llm_res = client
            .stream_assistant_turn(&conv_snapshot, &task_cancel, move |clause| {
                let _ = clause_tx.send(clause);
            })
            .await;

        let turn_output = match llm_res {
            Ok(out) => out,
            Err(err) => {
                task_cancel.cancel();
                tts_task.abort();
                return Err(err);
            }
        };

        match tts_task.await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => return Err(err),
            Err(join_err) => {
                if join_err.is_cancelled() {
                    return Err(VoiceError::Cancelled);
                }
                return Err(VoiceError::InvalidResponse {
                    endpoint: "tts_worker".to_string(),
                    reason: format!("TTS worker task failed: {join_err}"),
                });
            }
        }

        // Wait for queued RTP audio and DTMF frames to finish playing on the wire before
        // completing the turn (and before executing any local voice tool such as send_dtmf or
        // end_call).
        wait_for_outbound_media_drain(&rtp_handle, &task_cancel).await?;

        Ok(turn_output)
    }));

    ActiveAssistantTurn {
        cancel: turn_cancel,
        progress,
        handle,
    }
}

async fn wait_for_outbound_media_drain(
    sip_handle: &SipCallHandle,
    cancel: &CancellationToken,
) -> Result<(), VoiceError> {
    loop {
        if cancel.is_cancelled() {
            return Err(VoiceError::Cancelled);
        }
        if !sip_handle.has_pending_outbound_media() {
            return Ok(());
        }
        tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(VoiceError::Cancelled),
            () = tokio::time::sleep(PLAYBACK_POLL_INTERVAL) => {}
        }
    }
}

fn transmit_dtmf(
    sip_handle: &SipCallHandle,
    negotiated_dtmf_pt: Option<u8>,
    digits: &str,
) -> Result<(), String> {
    if let Some(pt) = negotiated_dtmf_pt {
        let mut all_packets = Vec::new();
        for ch in digits.chars() {
            let code = parse_dtmf_digit(ch).ok_or_else(|| format!("invalid DTMF digit '{ch}'"))?;
            let step_samples = u16::try_from(RTP_FRAME_SAMPLES).unwrap_or(160);
            all_packets.extend(build_rfc4733_digit_packets(
                code,
                step_samples,
                RFC4733_DEFAULT_HOLD_PACKETS,
            ));
        }
        sip_handle.enqueue_rfc4733_dtmf(pt, all_packets);
        Ok(())
    } else {
        let frames = synthesize_inband_dtmf_mulaw(digits)?;
        sip_handle.enqueue_pcmu_frames(frames);
        Ok(())
    }
}

async fn recv_optional_sip_event(
    rx: &mut Option<mpsc::Receiver<SipCallEvent>>,
) -> Option<SipCallEvent> {
    let receiver = rx.as_mut()?;
    receiver.recv().await
}

async fn recv_optional_inbound_audio(
    rx: &mut Option<mpsc::Receiver<crate::phone_call::sip::InboundRtpAudioFrame>>,
) -> Option<crate::phone_call::sip::InboundRtpAudioFrame> {
    let receiver = rx.as_mut()?;
    receiver.recv().await
}

async fn poll_active_stt(
    slot: &mut Option<ActiveSttTask>,
) -> Result<Result<Option<String>, VoiceError>, tokio::task::JoinError> {
    let Some(active) = slot.as_mut() else {
        return std::future::pending().await;
    };
    (&mut active.handle).await
}

async fn poll_active_turn(
    slot: &mut Option<ActiveAssistantTurn>,
) -> Result<Result<AssistantTurnOutput, VoiceError>, tokio::task::JoinError> {
    let Some(active) = slot.as_mut() else {
        return std::future::pending().await;
    };
    (&mut active.handle).await
}

fn sync_shared_transcript(slot: &Arc<ActiveCallSlot>, entries: &[TranscriptEntry]) {
    let mut shared = lock_unpoisoned(&slot.shared);
    shared.transcript = entries.to_vec();
}

fn snapshot_transcript(slot: &Arc<ActiveCallSlot>) -> Vec<TranscriptEntry> {
    let shared = lock_unpoisoned(&slot.shared);
    shared.transcript.clone()
}

async fn wait_for_settled(settled_rx: &mut watch::Receiver<bool>, max_wait: Duration) {
    if *settled_rx.borrow() {
        return;
    }
    let _ = tokio::time::timeout(max_wait, async {
        while !*settled_rx.borrow_and_update() {
            if settled_rx.changed().await.is_err() {
                break;
            }
        }
    })
    .await;
}

fn lock_unpoisoned<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

// ============================================================================
// UI Surface & Post-Call Report Builders
// ============================================================================

fn approval_surface_id(call_id: &str) -> String {
    format!("phone-call-approval:{call_id}")
}

fn live_surface_id(call_id: &str) -> String {
    format!("phone-call-live:{call_id}")
}

fn format_callee_display(callee_name: Option<&str>, phone_number: &str) -> String {
    match callee_name.map(str::trim).filter(|s| !s.is_empty()) {
        Some(name) => format!("{name} ({phone_number})"),
        None => phone_number.to_string(),
    }
}

fn non_empty_kv_value(raw: &str, fallback: &str) -> String {
    let (truncated, was_truncated) = truncate_utf8_bytes(raw.trim(), MAX_KV_VALUE_BYTES);
    let candidate = if was_truncated {
        format!("{}…", truncated.trim_end())
    } else {
        truncated
    };
    if candidate.trim().is_empty() {
        fallback.to_string()
    } else {
        candidate
    }
}

fn format_duration_mm_ss(seconds: u64) -> String {
    let mins = seconds / 60;
    let rem = seconds % 60;
    format!("{mins}:{rem:02}")
}

fn build_approval_modal_surface(
    surface_id: &str,
    thread_id: &str,
    runtime_config: &PhoneCallRuntimeConfig,
    validated: &ValidatedStartRequest,
) -> BridgeUiSurface {
    let to_display =
        format_callee_display(validated.callee_name.as_deref(), &validated.phone_number);
    let on_behalf_of = if runtime_config.user_display_name.trim().is_empty() {
        "User"
    } else {
        runtime_config.user_display_name.trim()
    };

    let mut blocks = vec![BridgeUiBlock::KeyValue {
        items: vec![
            BridgeUiKeyValueItem {
                label: "To".to_string(),
                value: non_empty_kv_value(&to_display, &validated.phone_number),
            },
            BridgeUiKeyValueItem {
                label: "From".to_string(),
                value: non_empty_kv_value(&runtime_config.caller_id, "+unknown"),
            },
            BridgeUiKeyValueItem {
                label: "On behalf of".to_string(),
                value: non_empty_kv_value(on_behalf_of, "User"),
            },
            BridgeUiKeyValueItem {
                label: "Objective".to_string(),
                value: non_empty_kv_value(&validated.objective, "Phone call"),
            },
        ],
    }];

    if let Some(first_msg) = validated
        .first_message
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let (bounded, _) = truncate_utf8_bytes(first_msg, MAX_FIRST_MESSAGE_BYTES);
        if !bounded.trim().is_empty() {
            blocks.push(BridgeUiBlock::Markdown {
                markdown: format!("**Opening message**\n\n{bounded}"),
            });
        }
    }

    let now = Utc::now().to_rfc3339();
    BridgeUiSurface {
        id: surface_id.to_string(),
        thread_id: thread_id.to_string(),
        turn_id: None,
        kind: Some("phone-call".to_string()),
        presentation: BridgeUiPresentation::Modal,
        tone: Some(BridgeUiTone::Warning),
        title: "Approve outbound phone call".to_string(),
        subtitle: Some(to_display),
        body_markdown: None,
        blocks,
        actions: vec![
            BridgeUiAction {
                id: "approve".to_string(),
                label: "Approve & Call".to_string(),
                style: Some(BridgeUiActionStyle::Primary),
                dismisses_surface: Some(true),
            },
            BridgeUiAction {
                id: "cancel".to_string(),
                label: "Cancel".to_string(),
                style: Some(BridgeUiActionStyle::Destructive),
                dismisses_surface: Some(true),
            },
        ],
        dismissible: Some(false),
        created_at: Some(now.clone()),
        updated_at: Some(now),
    }
}

struct LiveCardParams<'a> {
    title_override: Option<&'a str>,
    subtitle: &'a str,
    status_value: &'a str,
    tone: BridgeUiTone,
    in_call_actions: bool,
    dismissible: bool,
    duration_seconds: Option<u64>,
    detail_label_value: Option<(&'a str, &'a str)>,
    transcript: &'a [TranscriptEntry],
}

fn build_live_workflow_card(
    surface_id: &str,
    thread_id: &str,
    runtime_config: &PhoneCallRuntimeConfig,
    validated: &ValidatedStartRequest,
    created_at: &str,
    params: LiveCardParams<'_>,
) -> BridgeUiSurface {
    let to_display =
        format_callee_display(validated.callee_name.as_deref(), &validated.phone_number);
    let default_title = match validated
        .callee_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(name) => format!("Phone call · {name}"),
        None => format!("Phone call · {}", validated.phone_number),
    };
    let title = params
        .title_override
        .map(ToOwned::to_owned)
        .unwrap_or(default_title);

    let mut kv_items = vec![
        BridgeUiKeyValueItem {
            label: "Status".to_string(),
            value: non_empty_kv_value(params.status_value, "Active"),
        },
        BridgeUiKeyValueItem {
            label: "To".to_string(),
            value: non_empty_kv_value(&to_display, &validated.phone_number),
        },
        BridgeUiKeyValueItem {
            label: "From".to_string(),
            value: non_empty_kv_value(&runtime_config.caller_id, "+unknown"),
        },
    ];

    if let Some(secs) = params.duration_seconds {
        kv_items.push(BridgeUiKeyValueItem {
            label: "Duration".to_string(),
            value: format_duration_mm_ss(secs),
        });
    }

    kv_items.push(BridgeUiKeyValueItem {
        label: "Objective".to_string(),
        value: non_empty_kv_value(&validated.objective, "Phone call"),
    });

    if let Some((label, val)) = params.detail_label_value {
        if !val.trim().is_empty() {
            kv_items.push(BridgeUiKeyValueItem {
                label: label.to_string(),
                value: non_empty_kv_value(val, "-"),
            });
        }
    }

    let mut blocks = vec![BridgeUiBlock::KeyValue { items: kv_items }];
    if let Some(transcript_md) =
        format_rolling_transcript_markdown(params.transcript, MAX_LIVE_TRANSCRIPT_BYTES)
    {
        blocks.push(BridgeUiBlock::Markdown {
            markdown: transcript_md,
        });
    }

    let actions = if params.in_call_actions {
        vec![BridgeUiAction {
            id: "hangup".to_string(),
            label: "Hang Up".to_string(),
            style: Some(BridgeUiActionStyle::Destructive),
            dismisses_surface: Some(false),
        }]
    } else {
        Vec::new()
    };

    BridgeUiSurface {
        id: surface_id.to_string(),
        thread_id: thread_id.to_string(),
        turn_id: None,
        kind: Some("phone-call".to_string()),
        presentation: BridgeUiPresentation::WorkflowCard,
        tone: Some(params.tone),
        title,
        subtitle: Some(params.subtitle.to_string()),
        body_markdown: None,
        blocks,
        actions,
        dismissible: Some(params.dismissible),
        created_at: Some(created_at.to_string()),
        updated_at: Some(now_iso()),
    }
}

fn format_transcript_line(entry: &TranscriptEntry, markdown: bool) -> String {
    let clean_text = sanitize_reserved_envelope_markers(entry.text.trim());
    let text_with_marker = if entry.interrupted && !clean_text.ends_with(INTERRUPTED_MARKER) {
        format!("{clean_text} {INTERRUPTED_MARKER}")
    } else {
        clean_text
    };

    match (entry.speaker, markdown) {
        (TranscriptSpeaker::Assistant, true) => format!("**Assistant:** {text_with_marker}"),
        (TranscriptSpeaker::Callee, true) => format!("**Callee:** {text_with_marker}"),
        (TranscriptSpeaker::Steer, true) => format!("**[Steer]** {text_with_marker}"),
        (TranscriptSpeaker::Assistant, false) => format!("Assistant: {text_with_marker}"),
        (TranscriptSpeaker::Callee, false) => format!("Callee: {text_with_marker}"),
        (TranscriptSpeaker::Steer, false) => format!("[Steer] {text_with_marker}"),
    }
}

fn format_rolling_transcript_markdown(
    transcript: &[TranscriptEntry],
    max_bytes: usize,
) -> Option<String> {
    if transcript.is_empty() || max_bytes < 64 {
        return None;
    }
    const HEADER: &str = "**Live transcript**\n\n";
    const OMITTED_NOTICE: &str = "_Earlier turns omitted…_\n\n";

    let body_budget = max_bytes.saturating_sub(HEADER.len() + OMITTED_NOTICE.len() + 8);
    if body_budget == 0 {
        return None;
    }

    let mut kept_reversed: Vec<String> = Vec::new();
    let mut used_bytes: usize = 0;
    let mut omitted = false;

    for entry in transcript.iter().rev() {
        let mut line = format_transcript_line(entry, true);
        if line.len() > body_budget {
            if kept_reversed.is_empty() {
                let tail = truncate_utf8_tail(&line, body_budget.saturating_sub(4));
                line = format!("…{tail}");
                kept_reversed.push(line);
                omitted = transcript.len() > 1;
            } else {
                omitted = true;
            }
            break;
        }

        let separator = if kept_reversed.is_empty() { 0 } else { 2 };
        if used_bytes
            .saturating_add(separator)
            .saturating_add(line.len())
            > body_budget
        {
            omitted = true;
            break;
        }
        used_bytes = used_bytes
            .saturating_add(separator)
            .saturating_add(line.len());
        kept_reversed.push(line);
    }

    if kept_reversed.is_empty() {
        return None;
    }

    kept_reversed.reverse();
    let mut out = String::from(HEADER);
    if omitted {
        out.push_str(OMITTED_NOTICE);
    }
    out.push_str(&kept_reversed.join("\n\n"));
    Some(out)
}

fn truncate_utf8_tail(input: &str, max_bytes: usize) -> &str {
    if input.len() <= max_bytes {
        return input;
    }
    let mut start = input.len().saturating_sub(max_bytes);
    while start < input.len() && !input.is_char_boundary(start) {
        start = start.saturating_add(1);
    }
    &input[start..]
}

fn sanitize_reserved_envelope_markers(text: &str) -> String {
    if crate::agent_messaging::text_contains_reserved_agent_message_marker(text) {
        text.replace(
            "<<<dappercode.dev/agent-message:",
            "[redacted-agent-message-marker:",
        )
    } else {
        text.to_string()
    }
}

fn build_post_call_report_content(
    call_id: &str,
    status: PhoneCallStatus,
    validated: &ValidatedStartRequest,
    duration_seconds: u64,
    end_reason: &str,
    outcome_summary: Option<&str>,
    transcript: &[TranscriptEntry],
) -> String {
    let to_display =
        format_callee_display(validated.callee_name.as_deref(), &validated.phone_number);
    let status_heading = match status {
        PhoneCallStatus::Failed => "[Outbound phone call failed]",
        _ => "[Outbound phone call ended]",
    };
    let status_token = match status {
        PhoneCallStatus::Completed => "completed",
        PhoneCallStatus::Failed => "failed",
        PhoneCallStatus::Cancelled => "cancelled",
        _ => "ended",
    };

    let mut header = format!(
        "{status_heading}\n\
         Call ID: {call_id}\n\
         To: {}\n\
         Status: {status_token}\n\
         Duration: {} ({duration_seconds}s)\n\
         End reason: {}\n",
        sanitize_reserved_envelope_markers(&to_display),
        format_duration_mm_ss(duration_seconds),
        sanitize_reserved_envelope_markers(end_reason),
    );

    if let Some(summary) = outcome_summary.map(str::trim).filter(|s| !s.is_empty()) {
        let (bounded_summary, _) =
            truncate_utf8_bytes(&sanitize_reserved_envelope_markers(summary), 1_024);
        header.push_str(&format!("Outcome summary: {bounded_summary}\n"));
    }

    let (bounded_obj, _) = truncate_utf8_bytes(
        &sanitize_reserved_envelope_markers(&validated.objective),
        1_024,
    );
    header.push_str(&format!("Objective: {bounded_obj}\n\nTranscript:\n"));

    let max_total = MAX_REPORT_BODY_BYTES.min(QUEUE_MAX_CONTENT_BYTES.saturating_sub(1_024));
    let transcript_budget = max_total.saturating_sub(header.len().saturating_add(64));

    if transcript.is_empty() || transcript_budget == 0 {
        header.push_str("(no spoken transcript recorded)");
        return header;
    }

    let mut kept_reversed: Vec<String> = Vec::new();
    let mut used = 0_usize;
    let mut omitted = false;
    for entry in transcript.iter().rev() {
        let mut line = format_transcript_line(entry, false);
        if line.len() > transcript_budget {
            if kept_reversed.is_empty() {
                let tail = truncate_utf8_tail(&line, transcript_budget.saturating_sub(4));
                line = format!("…{tail}");
                kept_reversed.push(line);
                omitted = transcript.len() > 1;
            } else {
                omitted = true;
            }
            break;
        }
        let sep = usize::from(!kept_reversed.is_empty());
        if used.saturating_add(sep).saturating_add(line.len()) > transcript_budget {
            omitted = true;
            break;
        }
        used = used.saturating_add(sep).saturating_add(line.len());
        kept_reversed.push(line);
    }
    kept_reversed.reverse();

    if omitted {
        header.push_str("[earlier transcript omitted]\n");
    }
    header.push_str(&kept_reversed.join("\n"));
    header
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use std::{
        collections::HashSet,
        net::{IpAddr, Ipv4Addr, SocketAddr},
    };

    use agent_client_protocol::schema::v1::ContentBlock;
    use axum::{
        body::Body,
        extract::{ws::Message, Multipart, State},
        http::{header::CONTENT_TYPE, StatusCode},
        response::Response,
        routing::post,
        Json, Router,
    };
    use futures_util::future::BoxFuture;
    use serde_json::Value;
    use tokio::{
        net::{TcpListener, UdpSocket},
        sync::Mutex,
        time::timeout,
    };

    use crate::{
        client_hub::ClientConnectionMetadata,
        client_outbox::{client_outbox, ClientOutboxReceiver},
        phone_call::{
            audio::{encode_mulaw_frame, VAD_BARGE_IN_ONSET_FRAMES, VAD_DEFAULT_HANGOVER_FRAMES},
            sip::{
                build_rtp_packet, parse_rtp_packet, SipTransportKind, DEFAULT_TELEPHONE_EVENT_PT,
                PCMU_FRAME_BYTES, PCMU_PAYLOAD_TYPE,
            },
            voice::VoicePipelineConfig,
        },
        runtime_backend::{bridge_prompt, QueueRuntimeDispatcher, QueueRuntimeSnapshot},
    };

    const TEST_TIMEOUT: Duration = Duration::from_secs(6);

    struct TurnStartCapture {
        thread_id: String,
        turn_start: Value,
    }

    struct MockQueueDispatcher {
        captured: mpsc::UnboundedSender<TurnStartCapture>,
    }

    impl QueueRuntimeDispatcher for MockQueueDispatcher {
        fn read_snapshot<'a>(
            &'a self,
            thread_id: &'a str,
        ) -> BoxFuture<'a, Result<QueueRuntimeSnapshot, String>> {
            let session =
                crate::acp::snapshot::SessionSnapshot::new("agent".to_string(), thread_id.into());
            Box::pin(async move {
                Ok(QueueRuntimeSnapshot {
                    session,
                    pending_approval_ids: HashSet::new(),
                    pending_user_input_ids: HashSet::new(),
                })
            })
        }

        fn supports_steer(&self, _thread_id: &str) -> Result<bool, String> {
            Ok(false)
        }

        fn prepare_steer<'a>(&'a self, _thread_id: &'a str) -> BoxFuture<'a, Result<u64, String>> {
            Box::pin(async { Ok(1) })
        }

        fn verify_steer_epoch<'a>(
            &'a self,
            _thread_id: &'a str,
            _epoch: u64,
        ) -> BoxFuture<'a, Result<bool, String>> {
            Box::pin(async { Ok(true) })
        }

        fn steer<'a>(
            &'a self,
            _thread_id: &'a str,
            _expected_run_id: String,
            _expected_source_turn_id: String,
            _prompt_generation: u64,
            _interaction_epoch: u64,
            _prompt: Vec<ContentBlock>,
        ) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async { Err("steer unsupported".to_string()) })
        }

        fn turn_start<'a>(
            &'a self,
            thread_id: &'a str,
            turn_start: &'a Value,
            source_turn_id: &'a str,
        ) -> BoxFuture<'a, Result<String, String>> {
            let parsed_prompt = bridge_prompt(turn_start);
            let tid = thread_id.to_string();
            let payload = turn_start.clone();
            let src = source_turn_id.to_string();
            let tx = self.captured.clone();
            Box::pin(async move {
                let _ = parsed_prompt?;
                let _ = tx.send(TurnStartCapture {
                    thread_id: tid,
                    turn_start: payload,
                });
                Ok(src)
            })
        }
    }

    struct MockVoiceState {
        chat_turns: Mutex<VecDeque<Vec<Vec<u8>>>>,
        stt_replies: Mutex<VecDeque<String>>,
        tts_pcm_bytes: Mutex<Vec<u8>>,
        tts_chunk_delay_ms: AtomicUsize,
        chat_requests: Mutex<Vec<Value>>,
    }

    impl MockVoiceState {
        fn new(
            chat_turns: Vec<Vec<Vec<u8>>>,
            stt_replies: Vec<&str>,
            tts_samples_24k: usize,
        ) -> Arc<Self> {
            let mut pcm = Vec::with_capacity(tts_samples_24k * 2);
            for _ in 0..tts_samples_24k {
                pcm.extend_from_slice(&8_000_i16.to_le_bytes());
            }
            Arc::new(Self {
                chat_turns: Mutex::new(chat_turns.into()),
                stt_replies: Mutex::new(stt_replies.into_iter().map(ToOwned::to_owned).collect()),
                tts_pcm_bytes: Mutex::new(pcm),
                tts_chunk_delay_ms: AtomicUsize::new(0),
                chat_requests: Mutex::new(Vec::new()),
            })
        }
    }

    async fn spawn_mock_voice_http(state: Arc<MockVoiceState>) -> String {
        let app = Router::new()
            .route(
                "/api/chat",
                post(|| async { (StatusCode::OK, Json(json!({ "done": true }))) }),
            )
            .route(
                "/v1/audio/transcriptions",
                post(
                    |State(st): State<Arc<MockVoiceState>>, mut mp: Multipart| async move {
                        while let Ok(Some(field)) = mp.next_field().await {
                            let _ = field.bytes().await;
                        }
                        let text = st.stt_replies.lock().await.pop_front().unwrap_or_default();
                        (StatusCode::OK, Json(json!({ "text": text })))
                    },
                ),
            )
            .route(
                "/v1/chat/completions",
                post(
                    |State(st): State<Arc<MockVoiceState>>, Json(body): Json<Value>| async move {
                        st.chat_requests.lock().await.push(body);
                        let chunks = st
                            .chat_turns
                            .lock()
                            .await
                            .pop_front()
                            .unwrap_or_else(|| vec![b"data: [DONE]\n\n".to_vec()]);
                        let stream = futures_util::stream::iter(
                            chunks
                                .into_iter()
                                .map(Ok::<Vec<u8>, std::convert::Infallible>),
                        );
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(CONTENT_TYPE, "text/event-stream")
                            .body(Body::from_stream(stream))
                            .expect("SSE response")
                    },
                ),
            )
            .route(
                "/v1/audio/speech",
                post(|State(st): State<Arc<MockVoiceState>>| async move {
                    let pcm = st.tts_pcm_bytes.lock().await.clone();
                    let delay_ms = st.tts_chunk_delay_ms.load(Ordering::SeqCst);
                    let chunks: Vec<Vec<u8>> =
                        pcm.chunks(960).map(|slice| slice.to_vec()).collect();
                    let stream = futures_util::stream::unfold(
                        (chunks.into_iter(), delay_ms),
                        |(mut iter, wait_ms)| async move {
                            let next = iter.next()?;
                            if wait_ms > 0 {
                                tokio::time::sleep(Duration::from_millis(
                                    u64::try_from(wait_ms).unwrap_or(10),
                                ))
                                .await;
                            }
                            Some((
                                Ok::<Vec<u8>, std::convert::Infallible>(next),
                                (iter, wait_ms),
                            ))
                        },
                    );
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(CONTENT_TYPE, "application/octet-stream")
                        .body(Body::from_stream(stream))
                        .expect("PCM response")
                }),
            )
            .with_state(state);

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock voice");
        let addr = listener.local_addr().expect("voice addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}/v1")
    }

    async fn recv_matching_notification<F>(rx: &mut ClientOutboxReceiver, mut predicate: F) -> Value
    where
        F: FnMut(&str, &Value) -> bool,
    {
        timeout(TEST_TIMEOUT, async {
            loop {
                let msg = rx.recv().await.expect("outbox open");
                if let Message::Text(text) = msg {
                    let parsed: Value = serde_json::from_str(text.as_str()).expect("json frame");
                    if let Some(method) = parsed.get("method").and_then(Value::as_str) {
                        let params = parsed.get("params").cloned().unwrap_or(Value::Null);
                        if predicate(method, &params) {
                            return params;
                        }
                    }
                }
            }
        })
        .await
        .expect("timed out waiting for hub notification")
    }

    fn extract_sip_header(msg: &str, prefix: &str) -> String {
        msg.lines()
            .find_map(|line| {
                let trimmed = line.trim_end_matches('\r');
                let head = trimmed.get(..prefix.len())?;
                if head.eq_ignore_ascii_case(prefix) {
                    Some(trimmed[prefix.len()..].trim().to_owned())
                } else {
                    None
                }
            })
            .expect("SIP header present")
    }

    fn extract_sdp_port(msg: &str) -> u16 {
        msg.lines()
            .find_map(|line| {
                let rest = line.trim().strip_prefix("m=audio ")?;
                rest.split_whitespace().next()?.parse::<u16>().ok()
            })
            .expect("SDP m=audio port")
    }

    fn sample_runtime_config(sip_port: u16, voice_url: &str) -> PhoneCallRuntimeConfig {
        PhoneCallRuntimeConfig {
            server_host: "127.0.0.1".to_string(),
            server_port: sip_port,
            transport: SipTransportKind::Udp,
            sip_username: String::new(),
            sip_password: String::new(),
            caller_id: "+15551112222".to_string(),
            user_display_name: "David Parks".to_string(),
            voice: VoicePipelineConfig {
                stt_base_url: voice_url.to_string(),
                llm_base_url: voice_url.to_string(),
                tts_base_url: voice_url.to_string(),
                ..VoicePipelineConfig::default()
            },
        }
    }

    fn can_retire_for_service(service: &PhoneCallService) -> bool {
        let empty_queue = crate::health::QueueStatus {
            tracked_threads: 0,
            depth: 0,
            busy_threads: 0,
            active_runs: 0,
            pending_steers: 0,
            pending_approvals: 0,
            pending_user_inputs: 0,
            other_live_work: 0,
        };
        crate::health::runtime_activity(0, &empty_queue, 0, 0, 0, service.live_work_count(), 0)
            .can_retire
    }

    struct MockSipDialog {
        client_rtp_addr: SocketAddr,
        from: String,
        to: String,
        call_id: String,
    }

    impl MockSipDialog {
        async fn accept_invite(
            sip: &UdpSocket,
            rtp_port: u16,
            send_ringing: bool,
            include_dtmf: bool,
        ) -> Self {
            let local_sip_addr = sip.local_addr().expect("local SIP addr");
            let mut buf = vec![0_u8; 65535];
            let (n_inv, client_sip_addr) = sip.recv_from(&mut buf).await.expect("INVITE");
            let inv = std::str::from_utf8(&buf[..n_inv]).expect("utf8 INVITE");
            let via = extract_sip_header(inv, "Via:");
            let from = extract_sip_header(inv, "From:");
            let to = extract_sip_header(inv, "To:");
            let call_id = extract_sip_header(inv, "Call-ID:");
            let client_rtp_port = extract_sdp_port(inv);
            let client_rtp_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), client_rtp_port);

            if send_ringing {
                let ringing = format!(
                    "SIP/2.0 180 Ringing\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=uas1\r\nCall-ID: {call_id}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n"
                );
                sip.send_to(ringing.as_bytes(), client_sip_addr)
                    .await
                    .expect("180 Ringing");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }

            let sdp = if include_dtmf {
                format!(
                    "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio {rtp_port} RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\n"
                )
            } else {
                format!(
                    "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio {rtp_port} RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n"
                )
            };
            let ok_200 = format!(
                "SIP/2.0 200 OK\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=uas1\r\nCall-ID: {call_id}\r\nCSeq: 1 INVITE\r\nContact: <sip:uas@{local_sip_addr}>\r\nContent-Type: application/sdp\r\nContent-Length: {}\r\n\r\n{sdp}",
                sdp.len()
            );
            sip.send_to(ok_200.as_bytes(), client_sip_addr)
                .await
                .expect("200 OK");
            let _ = sip.recv_from(&mut buf).await.expect("ACK");

            Self {
                client_rtp_addr,
                from,
                to,
                call_id,
            }
        }

        async fn expect_bye_and_reply_ok(&self, sip: &UdpSocket) {
            let mut buf = vec![0_u8; 65535];
            loop {
                let (n_msg, peer) = sip.recv_from(&mut buf).await.expect("BYE");
                let text = std::str::from_utf8(&buf[..n_msg]).unwrap_or("");
                if text.starts_with("BYE ") {
                    let bye_via = extract_sip_header(text, "Via:");
                    let bye_cseq = extract_sip_header(text, "CSeq:");
                    let bye_ok = format!(
                        "SIP/2.0 200 OK\r\nVia: {bye_via}\r\nFrom: {}\r\nTo: {};tag=uas1\r\nCall-ID: {}\r\nCSeq: {bye_cseq}\r\nContent-Length: 0\r\n\r\n",
                        self.from, self.to, self.call_id
                    );
                    let _ = sip.send_to(bye_ok.as_bytes(), peer).await;
                    break;
                }
            }
        }
    }

    #[derive(Clone)]
    struct McpHttpTestClient {
        client: reqwest::Client,
        http_url: String,
        authorization: String,
        session_id: String,
    }

    impl McpHttpTestClient {
        async fn connect(
            config: &crate::agent_messaging::AgentMessagingMcpConfig,
            agent_id: &str,
            thread_id: &str,
        ) -> Self {
            let pending = config
                .stage_credential(agent_id)
                .expect("stage MCP credential");
            let authorization = match config
                .descriptor(crate::acp::runtime::McpTransportPreference::Http, &pending)
            {
                Some(agent_client_protocol::schema::v1::McpServer::Http(desc)) => {
                    desc.headers[0].value.clone()
                }
                _ => String::new(),
            };
            assert!(authorization.starts_with("Bearer dcm_"));
            config
                .activate_credential(pending, thread_id)
                .expect("activate MCP credential");

            let client = reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("reqwest MCP client");
            let init_resp = client
                .post(&config.http_url)
                .header(reqwest::header::AUTHORIZATION, &authorization)
                .header("accept", "application/json, text/event-stream")
                .json(&json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "clientInfo": { "name": "phone-call-e2e", "version": "1.0.0" }
                    }
                }))
                .send()
                .await
                .expect("MCP initialize");
            assert_eq!(init_resp.status(), StatusCode::OK);
            let session_id = init_resp
                .headers()
                .get("mcp-session-id")
                .and_then(|v| v.to_str().ok())
                .expect("mcp-session-id header")
                .to_string();
            let _ = init_resp.text().await.expect("init body");

            let initialized_resp = client
                .post(&config.http_url)
                .header(reqwest::header::AUTHORIZATION, &authorization)
                .header("mcp-session-id", &session_id)
                .header("mcp-protocol-version", "2025-03-26")
                .header("accept", "application/json, text/event-stream")
                .json(&json!({
                    "jsonrpc": "2.0",
                    "method": "notifications/initialized"
                }))
                .send()
                .await
                .expect("MCP initialized notification");
            assert!(initialized_resp.status().is_success());

            Self {
                client,
                http_url: config.http_url.clone(),
                authorization,
                session_id,
            }
        }

        async fn call_tool(&self, id: u64, name: &str, arguments: Value) -> Value {
            let resp = self
                .client
                .post(&self.http_url)
                .header(reqwest::header::AUTHORIZATION, &self.authorization)
                .header("mcp-session-id", &self.session_id)
                .header("mcp-protocol-version", "2025-03-26")
                .header("accept", "application/json, text/event-stream")
                .json(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": "tools/call",
                    "params": {
                        "name": name,
                        "arguments": arguments,
                    }
                }))
                .send()
                .await
                .expect("MCP tools/call HTTP response");
            assert_eq!(resp.status(), StatusCode::OK);
            let body = resp.text().await.expect("MCP tools/call body");
            if body.trim_start().starts_with('{') {
                return serde_json::from_str(&body).expect("JSON-RPC object");
            }
            body.lines()
                .filter_map(|line| line.trim().strip_prefix("data:"))
                .map(str::trim)
                .filter(|data| !data.is_empty())
                .find_map(|data| {
                    let val: Value = serde_json::from_str(data).ok()?;
                    (val.get("id") == Some(&json!(id))).then_some(val)
                })
                .expect("SSE JSON-RPC response matching request id")
        }

        async fn call_tool_json(&self, id: u64, name: &str, arguments: Value) -> Value {
            let rpc = self.call_tool(id, name, arguments).await;
            assert!(
                rpc.get("error").is_none(),
                "expected MCP tool success, got error: {rpc}"
            );
            assert_ne!(rpc["result"]["isError"], json!(true), "tool error: {rpc}");
            let text = rpc["result"]["content"][0]["text"]
                .as_str()
                .expect("MCP tool JSON text content");
            serde_json::from_str(text).expect("parse MCP tool JSON payload")
        }
    }

    async fn send_rtp_utterance(
        rtp_sock: &UdpSocket,
        dest: SocketAddr,
        seq: &mut u16,
        ts: &mut u32,
        loud_frames: usize,
        silence_frames: usize,
    ) {
        let loud_frame = encode_mulaw_frame(&[8_000_i16; RTP_FRAME_SAMPLES]);
        let silence_frame = [0xFF_u8; PCMU_FRAME_BYTES];
        for _ in 0..loud_frames {
            let pkt = build_rtp_packet(
                false,
                PCMU_PAYLOAD_TYPE,
                *seq,
                *ts,
                0x1122_3344,
                &loud_frame,
            );
            rtp_sock
                .send_to(&pkt, dest)
                .await
                .expect("send loud RTP frame");
            *seq = seq.wrapping_add(1);
            *ts = ts.wrapping_add(160);
        }
        for _ in 0..silence_frames {
            let pkt = build_rtp_packet(
                false,
                PCMU_PAYLOAD_TYPE,
                *seq,
                *ts,
                0x1122_3344,
                &silence_frame,
            );
            rtp_sock
                .send_to(&pkt, dest)
                .await
                .expect("send silence RTP frame");
            *seq = seq.wrapping_add(1);
            *ts = ts.wrapping_add(160);
        }
    }

    #[tokio::test]
    async fn validation_decline_timeout_and_concurrent_call_slot_guard_behave_deterministically() {
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut rx) = client_outbox(64);
        let _client_id = hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;

        let unconfigured = PhoneCallService::new(None, Arc::clone(&hub), Weak::new());
        assert!(unconfigured
            .start_phone_call(
                "thread-a",
                StartPhoneCallRequest {
                    phone_number: "+15559876543".to_string(),
                    objective: "Check hours".to_string(),
                    callee_name: None,
                    first_message: None,
                    context: None,
                },
            )
            .await
            .is_err());

        let cfg = sample_runtime_config(5060, "http://127.0.0.1:11434/v1");
        let service = PhoneCallService::with_options(
            Some(cfg),
            Arc::clone(&hub),
            Weak::new(),
            PhoneCallTimeouts {
                approval_timeout: Duration::from_millis(80),
                max_call_duration: Duration::from_secs(30),
                opening_greeting_wait: Duration::from_millis(50),
            },
            None,
        );

        // Input validation checks.
        for bad_req in [
            StartPhoneCallRequest {
                phone_number: "5559876543".to_string(),
                objective: "Valid".to_string(),
                callee_name: None,
                first_message: None,
                context: None,
            },
            StartPhoneCallRequest {
                phone_number: "+15559876543".to_string(),
                objective: "   ".to_string(),
                callee_name: None,
                first_message: None,
                context: None,
            },
            StartPhoneCallRequest {
                phone_number: "+15559876543".to_string(),
                objective: "x".repeat(MAX_OBJECTIVE_BYTES + 1),
                callee_name: None,
                first_message: None,
                context: None,
            },
            StartPhoneCallRequest {
                phone_number: "+15559876543".to_string(),
                objective: "Valid".to_string(),
                callee_name: Some("n".repeat(MAX_CALLEE_NAME_BYTES + 1)),
                first_message: None,
                context: None,
            },
            StartPhoneCallRequest {
                phone_number: "+15559876543".to_string(),
                objective: "Valid".to_string(),
                callee_name: None,
                first_message: Some("f".repeat(MAX_FIRST_MESSAGE_BYTES + 1)),
                context: None,
            },
            StartPhoneCallRequest {
                phone_number: "+15559876543".to_string(),
                objective: "Valid".to_string(),
                callee_name: None,
                first_message: None,
                context: Some("c".repeat(MAX_CONTEXT_BYTES + 1)),
            },
        ] {
            assert!(matches!(
                service.start_phone_call("thread-a", bad_req).await,
                Err(PhoneCallError::Invalid(_))
            ));
        }

        // Start call 1 and verify approval modal + live_work_count + concurrent slot rejection + user decline!
        let svc_decline = PhoneCallService::with_options(
            service.config.clone(),
            Arc::clone(&hub),
            Weak::new(),
            PhoneCallTimeouts {
                approval_timeout: Duration::from_secs(5),
                max_call_duration: Duration::from_secs(30),
                opening_greeting_wait: Duration::from_millis(50),
            },
            None,
        );
        let svc_spawn = Arc::clone(&svc_decline);
        let call_task = tokio::spawn(async move {
            svc_spawn
                .start_phone_call(
                    "thread-a",
                    StartPhoneCallRequest {
                        phone_number: "+15559876543".to_string(),
                        objective: "Ask if dinner reservations are open".to_string(),
                        callee_name: Some("Osteria Bella".to_string()),
                        first_message: Some("Say hello".to_string()),
                        context: None,
                    },
                )
                .await
        });

        let modal = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.present"
                && params["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("phone-call-approval:"))
        })
        .await;
        let approval_id = modal["id"].as_str().expect("modal id").to_string();
        assert_eq!(modal["presentation"], "modal");
        assert_eq!(modal["kind"], "phone-call");
        assert_eq!(modal["tone"], "warning");
        assert_eq!(modal["dismissible"], false);
        assert_eq!(svc_decline.live_work_count(), 1);

        // Concurrent call attempt while first is awaiting approval must be rejected.
        let concurrent_err = svc_decline
            .start_phone_call(
                "thread-b",
                StartPhoneCallRequest {
                    phone_number: "+15550001111".to_string(),
                    objective: "Second call".to_string(),
                    callee_name: None,
                    first_message: None,
                    context: None,
                },
            )
            .await
            .expect_err("second concurrent call rejected");
        assert!(concurrent_err.to_string().contains("already active"));

        svc_decline
            .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                id: approval_id.clone(),
                thread_id: "thread-a".to_string(),
                turn_id: None,
                action_id: "cancel".to_string(),
            })
            .await;

        let dismiss = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.dismiss" && params["id"] == approval_id
        })
        .await;
        assert_eq!(dismiss["threadId"], "thread-a");

        let decline_err = call_task
            .await
            .expect("join call task")
            .expect_err("declined call returns error");
        assert_eq!(
            decline_err.to_string(),
            "Phone call was declined by the user"
        );
        assert_eq!(svc_decline.live_work_count(), 0);

        // Approval timeout dismisses modal and releases slot.
        let timeout_err = service
            .start_phone_call(
                "thread-a",
                StartPhoneCallRequest {
                    phone_number: "+15559876543".to_string(),
                    objective: "Check table".to_string(),
                    callee_name: None,
                    first_message: None,
                    context: None,
                },
            )
            .await
            .expect_err("approval timeout");
        assert_eq!(
            timeout_err.to_string(),
            "Timed out waiting for phone call approval"
        );
        let _ =
            recv_matching_notification(&mut rx, |method, _| method == "bridge/ui.dismiss").await;
        assert_eq!(service.live_work_count(), 0);
    }

    #[tokio::test]
    async fn full_duplex_call_lifecycle_covers_barge_in_steer_dtmf_end_call_isolation_and_queue_report(
    ) {
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut rx) = client_outbox(256);
        let _client_id = hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;

        let (report_tx, mut report_rx) = mpsc::unbounded_channel();
        let dispatcher = Arc::new(MockQueueDispatcher {
            captured: report_tx,
        });
        let queue = BridgeQueueService::with_submission_store(
            dispatcher,
            Arc::clone(&hub),
            None,
            crate::queue_service::DurableQueueSubmissions::default(),
        );

        // Turn 1 (opening silent-pickup turn): long speech that gets interrupted by callee barge-in.
        // Turn 2 (after callee utterance + live steer): sends DTMF "1" + wait_silently.
        // Turn 3 (after second callee utterance): speaks closing + calls end_call.
        let turn1_sse = vec![
            b"data: {\"choices\":[{\"delta\":{\"content\":\"Hi, I am an AI assistant calling for David Parks.\"}}]}\n\n".to_vec(),
            b"data: {\"choices\":[{\"delta\":{\"content\":\" I would like to reserve a table for four tonight.\"}}]}\n\n".to_vec(),
            b"data: [DONE]\n\n".to_vec(),
        ];
        let turn2_sse = vec![
            b"data: {\"choices\":[{\"delta\":{\"content\":\"Pressing one now.\"}}]}\n\n".to_vec(),
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"tc_dtmf\",\"type\":\"function\",\"function\":{\"name\":\"send_dtmf\",\"arguments\":\"{\\\"digits\\\":\\\"1\\\"}\"}},{\"index\":1,\"id\":\"tc_wait\",\"type\":\"function\",\"function\":{\"name\":\"wait_silently\",\"arguments\":\"{\\\"reason\\\":\\\"IVR menu\\\"}\"}}]}}]}\n\n".to_vec(),
            b"data: [DONE]\n\n".to_vec(),
        ];
        let turn3_sse = vec![
            b"data: {\"choices\":[{\"delta\":{\"content\":\"Confirmed for seven forty-five p m on the patio, thank you!\"}}]}\n\n".to_vec(),
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"tc_end\",\"type\":\"function\",\"function\":{\"name\":\"end_call\",\"arguments\":\"{\\\"reason\\\":\\\"reservation_confirmed\\\",\\\"outcome_summary\\\":\\\"Booked patio table for four at 7:45 PM\\\"}\"}}]}}]}\n\n".to_vec(),
            b"data: [DONE]\n\n".to_vec(),
        ];

        let voice_state = MockVoiceState::new(
            vec![turn1_sse, turn2_sse, turn3_sse],
            vec![
                "Welcome to Osteria Bella. Press 1 for reservations.",
                "Patio table for four is booked for seven forty-five!",
            ],
            24_000, // 1,000 ms @ 24 kHz -> 50 RTP frames per clause (100 across 2 clauses) so barge-in truncates active playback
        );
        voice_state.tts_chunk_delay_ms.store(10, Ordering::SeqCst);
        let voice_url = spawn_mock_voice_http(Arc::clone(&voice_state)).await;

        let trunk_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind SIP UDP");
        let trunk_sip_addr = trunk_sip.local_addr().expect("sip addr");
        let trunk_rtp = Arc::new(
            UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
                .await
                .expect("bind RTP UDP"),
        );
        let trunk_rtp_addr = trunk_rtp.local_addr().expect("rtp addr");

        let trunk_rtp_task = Arc::clone(&trunk_rtp);
        let (barge_ready_tx, barge_ready_rx) = oneshot::channel::<SocketAddr>();
        let (turn1_truncated_tx, turn1_truncated_rx) = oneshot::channel::<usize>();
        let (dtmf_seen_tx, dtmf_seen_rx) = oneshot::channel::<()>();
        let (bye_seen_tx, bye_seen_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            let dialog =
                MockSipDialog::accept_invite(&trunk_sip, trunk_rtp_addr.port(), true, true).await;

            // Wait until assistant voice RTP frames (non-0xFF) start arriving, then signal barge_ready!
            let mut rtp_buf = vec![0_u8; 2048];
            loop {
                let (n_pkt, _) = trunk_rtp_task.recv_from(&mut rtp_buf).await.expect("RTP");
                if let Some(pkt) = parse_rtp_packet(&rtp_buf[..n_pkt]) {
                    if pkt.payload_type == PCMU_PAYLOAD_TYPE
                        && pkt.payload.iter().any(|&b| b != 0xFF)
                    {
                        let _ = barge_ready_tx.send(dialog.client_rtp_addr);
                        break;
                    }
                }
            }

            // Observe Turn 1 truncation (returns to 0xFF silence well before 100 frames) and RFC 4733 DTMF '1'!
            let mut turn1_voice_frames = 1_usize;
            let mut silence_run = 0_usize;
            let mut truncated_tx = Some(turn1_truncated_tx);
            loop {
                let (n_pkt, _) = trunk_rtp_task.recv_from(&mut rtp_buf).await.expect("RTP");
                if let Some(pkt) = parse_rtp_packet(&rtp_buf[..n_pkt]) {
                    if truncated_tx.is_some() && pkt.payload_type == PCMU_PAYLOAD_TYPE {
                        if pkt.payload.iter().any(|&b| b != 0xFF) {
                            turn1_voice_frames = turn1_voice_frames.saturating_add(1);
                            silence_run = 0;
                        } else {
                            silence_run = silence_run.saturating_add(1);
                            if silence_run >= 2 {
                                if let Some(tx) = truncated_tx.take() {
                                    let _ = tx.send(turn1_voice_frames);
                                }
                            }
                        }
                    }
                    if pkt.payload_type == DEFAULT_TELEPHONE_EVENT_PT
                        && pkt.payload.first() == Some(&1)
                    {
                        if let Some(tx) = truncated_tx.take() {
                            let _ = tx.send(turn1_voice_frames);
                        }
                        let _ = dtmf_seen_tx.send(());
                        break;
                    }
                }
            }

            dialog.expect_bye_and_reply_ok(&trunk_sip).await;
            let _ = bye_seen_tx.send(());
        });

        let service = PhoneCallService::with_options(
            Some(sample_runtime_config(trunk_sip_addr.port(), &voice_url)),
            Arc::clone(&hub),
            Arc::downgrade(&queue),
            PhoneCallTimeouts {
                approval_timeout: Duration::from_secs(5),
                max_call_duration: Duration::from_secs(60),
                opening_greeting_wait: Duration::from_millis(40),
            },
            None,
        );

        let svc_for_start = Arc::clone(&service);
        let start_handle = tokio::spawn(async move {
            svc_for_start
                .start_phone_call(
                    "owner-thread",
                    StartPhoneCallRequest {
                        phone_number: "+15559876543".to_string(),
                        objective: "Book dinner for four at 7:45 PM".to_string(),
                        callee_name: Some("Osteria Bella".to_string()),
                        first_message: None,
                        context: Some("Quiet table preferred".to_string()),
                    },
                )
                .await
        });

        let modal = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.present"
                && params["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("phone-call-approval:"))
        })
        .await;
        service
            .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                id: modal["id"].as_str().expect("id").to_string(),
                thread_id: "owner-thread".to_string(),
                turn_id: None,
                action_id: "approve".to_string(),
            })
            .await;

        let started = timeout(TEST_TIMEOUT, start_handle)
            .await
            .expect("start_phone_call timeout")
            .expect("join start")
            .expect("start_phone_call succeeded on 200 OK");
        assert_eq!(started.status, PhoneCallStatus::InProgress);
        assert_eq!(started.phone_number, "+15559876543");
        assert_eq!(started.callee_name.as_deref(), Some("Osteria Bella"));
        assert_eq!(service.live_work_count(), 1);

        // Cross-thread isolation: another thread cannot read, steer, or hang up this call!
        assert_eq!(
            service
                .steer_phone_call("intruder-thread", &started.call_id, "Cancel everything")
                .expect("steer isolation")
                .status,
            SteerPhoneCallStatus::NotFound
        );
        assert_eq!(
            service
                .get_phone_call("intruder-thread", &started.call_id)
                .expect("get isolation")
                .status,
            PhoneCallStatus::NotFound
        );
        assert_eq!(
            service
                .hangup_phone_call("intruder-thread", &started.call_id)
                .await
                .expect("hangup isolation")
                .status,
            HangupPhoneCallStatus::NotFound
        );

        // Wait until Turn 1 audio is actively playing on RTP, then inject live steer + callee barge-in!
        let client_rtp_addr = timeout(TEST_TIMEOUT, barge_ready_rx)
            .await
            .expect("barge ready timeout")
            .expect("client rtp addr");

        let steer_res = service
            .steer_phone_call(
                "owner-thread",
                &started.call_id,
                "Ask for the heated patio.",
            )
            .expect("owner steer");
        assert_eq!(steer_res.status, SteerPhoneCallStatus::Steered);

        // Send loud inbound RTP frames to trigger barge-in followed by hangover silence to complete Utterance 1!
        let mut seq: u16 = 1;
        let mut ts: u32 = 160;
        send_rtp_utterance(
            &trunk_rtp,
            client_rtp_addr,
            &mut seq,
            &mut ts,
            VAD_BARGE_IN_ONSET_FRAMES + 4,
            VAD_DEFAULT_HANGOVER_FRAMES + 2,
        )
        .await;

        let turn1_voice_frames = timeout(TEST_TIMEOUT, turn1_truncated_rx)
            .await
            .expect("barge-in truncation timeout")
            .expect("turn1 voice frame count");
        assert!(
            turn1_voice_frames < 80,
            "barge-in must truncate queued 100-frame outbound TTS early (saw {turn1_voice_frames})"
        );

        let interrupted_card = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.update"
                && params["blocks"].as_array().is_some_and(|blocks| {
                    blocks.iter().any(|b| {
                        b["markdown"]
                            .as_str()
                            .is_some_and(|md| md.contains("[interrupted]"))
                    })
                })
        })
        .await;
        assert_eq!(interrupted_card["kind"], "phone-call");

        // Turn 2 sends RFC 4733 DTMF '1' and sets IVR hangover mode (55 frames)!
        timeout(TEST_TIMEOUT, dtmf_seen_rx)
            .await
            .expect("RFC 4733 DTMF '1' timeout")
            .expect("DTMF seen");

        // Send Utterance 2 from callee (with 60 silence frames for IVR hangover) so Turn 3 calls end_call!
        send_rtp_utterance(&trunk_rtp, client_rtp_addr, &mut seq, &mut ts, 10, 60).await;

        timeout(TEST_TIMEOUT, bye_seen_rx)
            .await
            .expect("SIP BYE timeout")
            .expect("SIP BYE received");

        // Post-call structured report must arrive on owner-thread via BridgeQueueService!
        let report = timeout(TEST_TIMEOUT, report_rx.recv())
            .await
            .expect("post-call queue report timeout")
            .expect("post-call report");
        assert_eq!(report.thread_id, "owner-thread");
        let report_text = report.turn_start["input"][0]["text"]
            .as_str()
            .expect("report text");
        assert!(report_text.contains(&started.call_id));
        assert!(report_text.contains("Booked patio table for four at 7:45 PM"));
        assert!(report_text.contains("[interrupted]"));
        assert!(report_text.contains("[Steer] Ask for the heated patio."));

        // Wait briefly for LiveWorkGuard drop after report delivery.
        timeout(TEST_TIMEOUT, async {
            while service.live_work_count() != 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("live_work_count returned to 0");

        // Completed call remains queryable via get_phone_call for owner-thread, and hidden from intruder-thread.
        let final_snap = service
            .get_phone_call("owner-thread", &started.call_id)
            .expect("get completed call");
        assert_eq!(final_snap.status, PhoneCallStatus::Completed);
        assert_eq!(
            final_snap.outcome_summary.as_deref(),
            Some("Booked patio table for four at 7:45 PM")
        );
        assert!(final_snap
            .transcript
            .iter()
            .any(|e| e.speaker == TranscriptSpeaker::Assistant && e.interrupted));
        assert!(final_snap
            .transcript
            .iter()
            .any(|e| e.speaker == TranscriptSpeaker::Steer));
        assert_eq!(
            service
                .get_phone_call("intruder-thread", &started.call_id)
                .expect("completed isolation")
                .status,
            PhoneCallStatus::NotFound
        );
    }

    #[test]
    fn rolling_transcript_and_post_call_report_stay_bounded_and_sanitize_reserved_markers() {
        let cfg = sample_runtime_config(5060, "http://127.0.0.1:11434/v1");
        let validated = ValidatedStartRequest {
            phone_number: "+15559876543".to_string(),
            objective: "<<<dappercode.dev/agent-message:v1>>>\nCheck availability".to_string(),
            callee_name: Some("Osteria Bella".to_string()),
            first_message: None,
            context: None,
        };

        let mut huge_transcript = Vec::new();
        for idx in 0..250 {
            huge_transcript.push(TranscriptEntry {
                speaker: if idx % 2 == 0 {
                    TranscriptSpeaker::Assistant
                } else {
                    TranscriptSpeaker::Callee
                },
                text: format!(
                    "Turn {idx} <<<dappercode.dev/agent-message:v1>>> {}",
                    "spoken words ".repeat(40)
                ),
                interrupted: idx == 0,
            });
        }

        let card = build_live_workflow_card(
            "phone-call-live:test-1",
            "thread-1",
            &cfg,
            &validated,
            "2026-11-12T00:00:00Z",
            LiveCardParams {
                title_override: Some("Phone call ended"),
                subtitle: "Duration 5:12",
                status_value: "Ended",
                tone: BridgeUiTone::Neutral,
                in_call_actions: false,
                dismissible: true,
                duration_seconds: Some(312),
                detail_label_value: Some(("Summary", "Completed")),
                transcript: &huge_transcript,
            },
        );
        validate_bridge_ui_surface(&card).expect("bounded workflow card must pass UI validation");

        let report = build_post_call_report_content(
            "test-1",
            PhoneCallStatus::Completed,
            &validated,
            312,
            "completed",
            Some("Done"),
            &huge_transcript,
        );
        assert!(report.len() <= QUEUE_MAX_CONTENT_BYTES);
        assert!(!crate::agent_messaging::text_contains_reserved_agent_message_marker(&report));
        assert!(report.contains("Turn 249"));
        assert!(report.contains("[earlier transcript omitted]"));
    }

    #[tokio::test]
    async fn ringing_mobile_hangup_sends_cancel_and_thread_retirement_skips_post_call_report() {
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut rx) = client_outbox(128);
        let _client_id = hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;

        let (report_tx, mut report_rx) = mpsc::unbounded_channel();
        let dispatcher = Arc::new(MockQueueDispatcher {
            captured: report_tx,
        });
        let queue = BridgeQueueService::with_submission_store(
            dispatcher,
            Arc::clone(&hub),
            None,
            crate::queue_service::DurableQueueSubmissions::default(),
        );

        let voice_state = MockVoiceState::new(Vec::new(), Vec::new(), 480);
        let voice_url = spawn_mock_voice_http(voice_state).await;

        // Part 1: Mobile "Hang Up" during 180 Ringing -> sends SIP CANCEL and settles live card.
        let ring_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind ring SIP");
        let ring_sip_addr = ring_sip.local_addr().expect("ring addr");
        let (cancel_seen_tx, cancel_seen_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            let mut buf = vec![0_u8; 65535];
            let (n_inv, peer) = ring_sip.recv_from(&mut buf).await.expect("INVITE");
            let inv = std::str::from_utf8(&buf[..n_inv]).expect("utf8");
            let via = extract_sip_header(inv, "Via:");
            let from = extract_sip_header(inv, "From:");
            let to = extract_sip_header(inv, "To:");
            let call_id = extract_sip_header(inv, "Call-ID:");
            let r180 = format!(
                "SIP/2.0 180 Ringing\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=r1\r\nCall-ID: {call_id}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n"
            );
            ring_sip.send_to(r180.as_bytes(), peer).await.expect("180");

            let (n_can, _) = ring_sip.recv_from(&mut buf).await.expect("CANCEL");
            let can = std::str::from_utf8(&buf[..n_can]).expect("utf8");
            assert!(can.starts_with("CANCEL "));
            let ok_can = format!(
                "SIP/2.0 200 OK\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=r1\r\nCall-ID: {call_id}\r\nCSeq: 1 CANCEL\r\nContent-Length: 0\r\n\r\n"
            );
            let t487 = format!(
                "SIP/2.0 487 Request Terminated\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=r1\r\nCall-ID: {call_id}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n"
            );
            let _ = ring_sip.send_to(ok_can.as_bytes(), peer).await;
            let _ = ring_sip.send_to(t487.as_bytes(), peer).await;
            let _ = cancel_seen_tx.send(());
        });

        let ring_service = PhoneCallService::with_options(
            Some(sample_runtime_config(ring_sip_addr.port(), &voice_url)),
            Arc::clone(&hub),
            Arc::downgrade(&queue),
            PhoneCallTimeouts {
                approval_timeout: Duration::from_secs(5),
                max_call_duration: Duration::from_secs(60),
                opening_greeting_wait: Duration::from_secs(5),
            },
            None,
        );

        let svc_ring = Arc::clone(&ring_service);
        let ring_task = tokio::spawn(async move {
            svc_ring
                .start_phone_call(
                    "thread-ring",
                    StartPhoneCallRequest {
                        phone_number: "+15559876543".to_string(),
                        objective: "Test ringing hangup".to_string(),
                        callee_name: None,
                        first_message: None,
                        context: None,
                    },
                )
                .await
        });

        let modal = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.present"
                && params["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("phone-call-approval:"))
        })
        .await;
        ring_service
            .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                id: modal["id"].as_str().expect("id").to_string(),
                thread_id: "thread-ring".to_string(),
                turn_id: None,
                action_id: "approve".to_string(),
            })
            .await;

        let ringing_card = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.update" && params["subtitle"] == "Ringing…"
        })
        .await;
        let live_id = ringing_card["id"].as_str().expect("live id").to_string();

        ring_service
            .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                id: live_id.clone(),
                thread_id: "thread-ring".to_string(),
                turn_id: None,
                action_id: "hangup".to_string(),
            })
            .await;

        timeout(TEST_TIMEOUT, cancel_seen_rx)
            .await
            .expect("SIP CANCEL timeout")
            .expect("CANCEL seen");

        let ring_err = ring_task
            .await
            .expect("join")
            .expect_err("ring hangup rejects");
        assert!(ring_err.to_string().contains("hung up before connecting"));

        let settled_ring_card = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.update"
                && params["id"] == live_id
                && params["title"] == "Phone call ended"
        })
        .await;
        assert_eq!(settled_ring_card["dismissible"], true);
        assert_eq!(
            settled_ring_card["actions"].as_array().map(Vec::len),
            Some(0)
        );
        assert!(report_rx.try_recv().is_err());

        // Part 2: Active connected call cancelled by thread retirement skips post-call queue report!
        let ret_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind ret SIP");
        let ret_sip_addr = ret_sip.local_addr().expect("ret addr");
        let ret_rtp = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind ret RTP");
        let ret_rtp_port = ret_rtp.local_addr().expect("rtp port").port();

        tokio::spawn(async move {
            let dialog = MockSipDialog::accept_invite(&ret_sip, ret_rtp_port, false, false).await;
            dialog.expect_bye_and_reply_ok(&ret_sip).await;
        });

        let ret_service = PhoneCallService::with_options(
            Some(sample_runtime_config(ret_sip_addr.port(), &voice_url)),
            Arc::clone(&hub),
            Arc::downgrade(&queue),
            PhoneCallTimeouts {
                approval_timeout: Duration::from_secs(5),
                max_call_duration: Duration::from_secs(60),
                opening_greeting_wait: Duration::from_secs(10),
            },
            None,
        );

        let svc_ret = Arc::clone(&ret_service);
        let ret_start = tokio::spawn(async move {
            svc_ret
                .start_phone_call(
                    "retiring-thread",
                    StartPhoneCallRequest {
                        phone_number: "+15559876543".to_string(),
                        objective: "Test retirement".to_string(),
                        callee_name: None,
                        first_message: None,
                        context: None,
                    },
                )
                .await
        });

        let modal2 = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.present"
                && params["threadId"] == "retiring-thread"
                && params["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("phone-call-approval:"))
        })
        .await;
        ret_service
            .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                id: modal2["id"].as_str().expect("id").to_string(),
                thread_id: "retiring-thread".to_string(),
                turn_id: None,
                action_id: "approve".to_string(),
            })
            .await;

        let started_ret = ret_start.await.expect("join").expect("connected");
        assert_eq!(started_ret.status, PhoneCallStatus::InProgress);

        ret_service
            .cancel_for_retiring_threads(&["retiring-thread".to_string()])
            .await;
        assert_eq!(ret_service.live_work_count(), 0);
        assert!(
            report_rx.try_recv().is_err(),
            "thread retirement must skip post-call report delivery"
        );
    }

    #[tokio::test]
    async fn mcp_e2e_happy_path_covers_approval_ringing_callee_speech_tts_rtp_steer_dtmf_and_autonomous_hangup(
    ) {
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut rx) = client_outbox(256);
        let _client_id = hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;

        let (report_tx, mut report_rx) = mpsc::unbounded_channel();
        let queue = BridgeQueueService::with_submission_store(
            Arc::new(MockQueueDispatcher {
                captured: report_tx,
            }),
            Arc::clone(&hub),
            None,
            crate::queue_service::DurableQueueSubmissions::default(),
        );

        let turn1_sse = vec![
            b"data: {\"choices\":[{\"delta\":{\"content\":\"Hi, I am an AI assistant calling for David Parks to book dinner for four.\"}}]}\n\n".to_vec(),
            b"data: [DONE]\n\n".to_vec(),
        ];
        let turn2_sse = vec![
            b"data: {\"choices\":[{\"delta\":{\"content\":\"Dialing extension two and confirming seven forty-five p m.\"}}]}\n\n".to_vec(),
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"tc_dtmf_2\",\"type\":\"function\",\"function\":{\"name\":\"send_dtmf\",\"arguments\":\"{\\\"digits\\\":\\\"2\\\"}\"}},{\"index\":1,\"id\":\"tc_end_2\",\"type\":\"function\",\"function\":{\"name\":\"end_call\",\"arguments\":\"{\\\"reason\\\":\\\"reservation_confirmed\\\",\\\"outcome_summary\\\":\\\"Booked patio table for four at 7:45 PM\\\"}\"}}]}}]}\n\n".to_vec(),
            b"data: [DONE]\n\n".to_vec(),
        ];
        let voice_state = MockVoiceState::new(
            vec![turn1_sse, turn2_sse],
            vec!["Hello, Osteria Bella, press 2 for the patio host."],
            2_400, // 100 ms @ 24 kHz -> 5 PCMU RTP frames
        );
        let voice_url = spawn_mock_voice_http(Arc::clone(&voice_state)).await;

        let trunk_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind SIP UDP");
        let trunk_sip_port = trunk_sip.local_addr().expect("sip addr").port();
        let trunk_rtp = Arc::new(
            UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
                .await
                .expect("bind RTP UDP"),
        );
        let trunk_rtp_port = trunk_rtp.local_addr().expect("rtp addr").port();

        let (connected_rtp_tx, connected_rtp_rx) = oneshot::channel::<SocketAddr>();
        let (pcmu_voice_tx, pcmu_voice_rx) = oneshot::channel::<usize>();
        let (dtmf_end_tx, dtmf_end_rx) = oneshot::channel::<()>();
        let (bye_tx, bye_rx) = oneshot::channel::<()>();
        let trunk_rtp_task = Arc::clone(&trunk_rtp);

        tokio::spawn(async move {
            let dialog = MockSipDialog::accept_invite(&trunk_sip, trunk_rtp_port, true, true).await;
            let _ = connected_rtp_tx.send(dialog.client_rtp_addr);

            let mut rtp_buf = vec![0_u8; 2048];
            let mut voice_frames = 0_usize;
            loop {
                let (n_pkt, _) = trunk_rtp_task.recv_from(&mut rtp_buf).await.expect("RTP");
                if let Some(pkt) = parse_rtp_packet(&rtp_buf[..n_pkt]) {
                    if pkt.payload_type == PCMU_PAYLOAD_TYPE
                        && pkt.payload.len() == PCMU_FRAME_BYTES
                        && pkt.payload.iter().any(|&b| b != 0xFF)
                    {
                        voice_frames = voice_frames.saturating_add(1);
                        if voice_frames >= 3 {
                            let _ = pcmu_voice_tx.send(voice_frames);
                            break;
                        }
                    }
                }
            }

            // Observe RFC 4733 DTMF digit '2' including end-of-event marker bit (0x80).
            loop {
                let (n_pkt, _) = trunk_rtp_task.recv_from(&mut rtp_buf).await.expect("RTP");
                if let Some(pkt) = parse_rtp_packet(&rtp_buf[..n_pkt]) {
                    if pkt.payload_type == DEFAULT_TELEPHONE_EVENT_PT
                        && pkt.payload.first() == Some(&2)
                        && pkt.payload.get(1).is_some_and(|flags| flags & 0x80 != 0)
                    {
                        let _ = dtmf_end_tx.send(());
                        break;
                    }
                }
            }

            dialog.expect_bye_and_reply_ok(&trunk_sip).await;
            let _ = bye_tx.send(());
        });

        let service = PhoneCallService::with_options(
            Some(sample_runtime_config(trunk_sip_port, &voice_url)),
            Arc::clone(&hub),
            Arc::downgrade(&queue),
            PhoneCallTimeouts {
                approval_timeout: Duration::from_secs(5),
                max_call_duration: Duration::from_secs(60),
                opening_greeting_wait: Duration::from_secs(5),
            },
            None,
        );
        assert!(can_retire_for_service(&service));

        let mcp_service = crate::agent_messaging::AgentMessagingService::start(
            Weak::<crate::runtime_backend::RuntimeBackend>::new(),
            Arc::downgrade(&queue),
            crate::scheduled_prompts::ScheduledPromptService::inert_for_test(),
            Arc::clone(&service),
        )
        .await
        .expect("start HTTP MCP server");
        let owner_thread = crate::acp::identity::AgentSessionId::new("agent", "mcp-owner")
            .expect("owner session id")
            .encode();
        let owner_mcp =
            McpHttpTestClient::connect(&mcp_service.config(), "agent", &owner_thread).await;

        let owner_mcp_start = owner_mcp.clone();
        let start_task = tokio::spawn(async move {
            owner_mcp_start
                .call_tool_json(
                    10,
                    "start_phone_call",
                    json!({
                        "phoneNumber": "+15559876543",
                        "calleeName": "Osteria Bella",
                        "objective": "Book dinner for four at 7:45 PM",
                        "firstMessage": "Introduce yourself politely",
                        "context": "Patio preferred"
                    }),
                )
                .await
        });

        let modal = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.present"
                && params["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("phone-call-approval:"))
        })
        .await;
        let approval_id = modal["id"].as_str().expect("modal id").to_string();
        assert_eq!(modal["presentation"], "modal");
        assert_eq!(modal["kind"], "phone-call");
        assert_eq!(modal["dismissible"], false);
        assert_eq!(service.live_work_count(), 1);
        assert!(!can_retire_for_service(&service));

        service
            .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                id: approval_id.clone(),
                thread_id: owner_thread.clone(),
                turn_id: None,
                action_id: "approve".to_string(),
            })
            .await;

        let _ = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.dismiss" && params["id"] == approval_id
        })
        .await;
        let presented_card = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.present"
                && params["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("phone-call-live:"))
        })
        .await;
        let live_id = presented_card["id"].as_str().expect("live id").to_string();
        assert_eq!(presented_card["presentation"], "workflowCard");
        assert_eq!(presented_card["kind"], "phone-call");
        assert_eq!(presented_card["dismissible"], false);
        assert_eq!(presented_card["actions"][0]["id"], "hangup");
        assert_eq!(presented_card["actions"][0]["dismissesSurface"], false);

        let _ = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.update"
                && params["id"] == live_id
                && params["subtitle"] == "Ringing…"
        })
        .await;

        let started_json = timeout(TEST_TIMEOUT, start_task)
            .await
            .expect("MCP start_phone_call timeout")
            .expect("join MCP start_phone_call");
        let call_id = started_json["callId"].as_str().expect("callId").to_string();
        assert_eq!(started_json["status"], "in_progress");
        assert_eq!(started_json["phoneNumber"], "+15559876543");
        assert_eq!(started_json["calleeName"], "Osteria Bella");
        assert_eq!(service.live_work_count(), 1);
        assert!(!can_retire_for_service(&service));

        let client_rtp_addr = timeout(TEST_TIMEOUT, connected_rtp_rx)
            .await
            .expect("connected RTP addr timeout")
            .expect("client RTP addr");

        // Callee speaks -> VAD segments -> STT transcribes -> live card shows callee transcript -> LLM + TTS -> 8kHz PCMU RTP!
        let mut seq: u16 = 1;
        let mut ts: u32 = 160;
        send_rtp_utterance(
            &trunk_rtp,
            client_rtp_addr,
            &mut seq,
            &mut ts,
            10,
            VAD_DEFAULT_HANGOVER_FRAMES + 2,
        )
        .await;

        let callee_card = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.update"
                && params["id"] == live_id
                && params["blocks"].as_array().is_some_and(|blocks| {
                    blocks.iter().any(|b| {
                        b["markdown"].as_str().is_some_and(|md| {
                            md.contains(
                                "**Callee:** Hello, Osteria Bella, press 2 for the patio host.",
                            )
                        })
                    })
                })
        })
        .await;
        assert_eq!(callee_card["subtitle"], "In call");

        let downsampled_frames = timeout(TEST_TIMEOUT, pcmu_voice_rx)
            .await
            .expect("outbound 8kHz PCMU RTP timeout")
            .expect("voice frames");
        assert!(downsampled_frames >= 3);

        // Wait for Turn 1 assistant transcript update so Turn 1 has finished playing out before steering.
        let _ = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.update"
                && params["id"] == live_id
                && params["blocks"].as_array().is_some_and(|blocks| {
                    blocks.iter().any(|b| {
                        b["markdown"].as_str().is_some_and(|md| {
                            md.contains("**Assistant:** Hi, I am an AI assistant")
                        })
                    })
                })
        })
        .await;

        // Live steer_phone_call mid-call via HTTP MCP!
        let steer_json = owner_mcp
            .call_tool_json(
                11,
                "steer_phone_call",
                json!({
                    "callId": call_id,
                    "instruction": "Press 2 now and confirm 7:45 PM for four."
                }),
            )
            .await;
        assert_eq!(steer_json["status"], "steered");

        let steer_card = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.update"
                && params["id"] == live_id
                && params["blocks"].as_array().is_some_and(|blocks| {
                    blocks.iter().any(|b| {
                        b["markdown"].as_str().is_some_and(|md| {
                            md.contains("**[Steer]** Press 2 now and confirm 7:45 PM for four.")
                        })
                    })
                })
        })
        .await;
        assert_eq!(steer_card["kind"], "phone-call");

        timeout(TEST_TIMEOUT, dtmf_end_rx)
            .await
            .expect("RFC 4733 DTMF '2' timeout")
            .expect("DTMF '2' observed");
        timeout(TEST_TIMEOUT, bye_rx)
            .await
            .expect("SIP BYE timeout")
            .expect("SIP BYE observed");

        let settled_card = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.update"
                && params["id"] == live_id
                && params["title"] == "Phone call ended"
        })
        .await;
        assert_eq!(settled_card["dismissible"], true);
        assert_eq!(settled_card["actions"].as_array().map(Vec::len), Some(0));

        // Verify KV-cache-safe steer preserved message[0] system prompt while appending steer message.
        {
            let requests = voice_state.chat_requests.lock().await;
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0]["messages"][0]["role"], "system");
            assert_eq!(requests[0]["messages"][0], requests[1]["messages"][0]);
            let turn2_msgs = requests[1]["messages"].as_array().expect("turn2 messages");
            assert!(turn2_msgs.iter().any(|m| {
                m["role"] == "system"
                    && m["content"]
                        .as_str()
                        .is_some_and(|c| c.contains("Press 2 now and confirm 7:45 PM for four."))
            }));
        }

        let report = timeout(TEST_TIMEOUT, report_rx.recv())
            .await
            .expect("post-call queue report timeout")
            .expect("post-call report");
        assert_eq!(report.thread_id, owner_thread);
        let report_text = report.turn_start["input"][0]["text"]
            .as_str()
            .expect("report text");
        assert!(report_text.contains(&call_id));
        assert!(report_text.contains("Status: completed"));
        assert!(report_text.contains("Booked patio table for four at 7:45 PM"));
        assert!(report_text.contains("[Steer] Press 2 now and confirm 7:45 PM for four."));

        timeout(TEST_TIMEOUT, async {
            while service.live_work_count() != 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("live_work_count returned to 0");
        assert!(can_retire_for_service(&service));

        mcp_service.shutdown().await;
    }

    #[tokio::test]
    async fn mcp_e2e_decline_zero_sip_packets_mobile_mid_call_hangup_and_cross_session_isolation() {
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut rx) = client_outbox(256);
        let _client_id = hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;

        let (report_tx, mut report_rx) = mpsc::unbounded_channel();
        let queue = BridgeQueueService::with_submission_store(
            Arc::new(MockQueueDispatcher {
                captured: report_tx,
            }),
            Arc::clone(&hub),
            None,
            crate::queue_service::DurableQueueSubmissions::default(),
        );
        let voice_url =
            spawn_mock_voice_http(MockVoiceState::new(Vec::new(), Vec::new(), 480)).await;

        // 1. Pre-call decline: zero SIP packets ever reach the mock SIP UDP socket!
        let decline_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind decline SIP UDP");
        let decline_sip_port = decline_sip.local_addr().expect("decline addr").port();

        let decline_service = PhoneCallService::with_options(
            Some(sample_runtime_config(decline_sip_port, &voice_url)),
            Arc::clone(&hub),
            Arc::downgrade(&queue),
            PhoneCallTimeouts {
                approval_timeout: Duration::from_secs(5),
                max_call_duration: Duration::from_secs(60),
                opening_greeting_wait: Duration::from_secs(10),
            },
            None,
        );
        let decline_mcp_server = crate::agent_messaging::AgentMessagingService::start(
            Weak::<crate::runtime_backend::RuntimeBackend>::new(),
            Arc::downgrade(&queue),
            crate::scheduled_prompts::ScheduledPromptService::inert_for_test(),
            Arc::clone(&decline_service),
        )
        .await
        .expect("start decline MCP");
        let owner_thread = crate::acp::identity::AgentSessionId::new("agent", "owner-sess")
            .expect("owner id")
            .encode();
        let intruder_thread = crate::acp::identity::AgentSessionId::new("agent", "intruder-sess")
            .expect("intruder id")
            .encode();
        let decline_owner =
            McpHttpTestClient::connect(&decline_mcp_server.config(), "agent", &owner_thread).await;

        let decline_call_task = tokio::spawn(async move {
            decline_owner
                .call_tool(
                    20,
                    "start_phone_call",
                    json!({
                        "phoneNumber": "+15559876543",
                        "objective": "Verify decline never dials"
                    }),
                )
                .await
        });

        let decline_modal = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.present"
                && params["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("phone-call-approval:"))
        })
        .await;
        assert_eq!(decline_service.live_work_count(), 1);
        assert!(!can_retire_for_service(&decline_service));

        decline_service
            .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                id: decline_modal["id"].as_str().expect("modal id").to_string(),
                thread_id: owner_thread.clone(),
                turn_id: None,
                action_id: "cancel".to_string(),
            })
            .await;

        let decline_rpc = timeout(TEST_TIMEOUT, decline_call_task)
            .await
            .expect("decline MCP timeout")
            .expect("join decline MCP");
        let decline_err_msg = decline_rpc["error"]["message"].as_str().unwrap_or_else(|| {
            decline_rpc["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or("")
        });
        assert!(
            decline_err_msg.contains("declined by the user"),
            "unexpected decline MCP response: {decline_rpc}"
        );
        assert_eq!(decline_service.live_work_count(), 0);
        assert!(can_retire_for_service(&decline_service));

        let mut probe_buf = [0_u8; 64];
        assert!(
            matches!(
                decline_sip.try_recv_from(&mut probe_buf),
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock
            ),
            "declined phone call must transmit zero SIP packets"
        );
        decline_mcp_server.shutdown().await;

        // 2. Connected mid-call mobile Hang Up + cross-thread MCP credential isolation!
        let live_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind live SIP");
        let live_sip_port = live_sip.local_addr().expect("live sip addr").port();
        let live_rtp = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind live RTP");
        let live_rtp_port = live_rtp.local_addr().expect("live rtp addr").port();
        let (bye_seen_tx, bye_seen_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            let dialog = MockSipDialog::accept_invite(&live_sip, live_rtp_port, true, true).await;
            dialog.expect_bye_and_reply_ok(&live_sip).await;
            let _ = bye_seen_tx.send(());
        });

        let live_service = PhoneCallService::with_options(
            Some(sample_runtime_config(live_sip_port, &voice_url)),
            Arc::clone(&hub),
            Arc::downgrade(&queue),
            PhoneCallTimeouts {
                approval_timeout: Duration::from_secs(5),
                max_call_duration: Duration::from_secs(60),
                opening_greeting_wait: Duration::from_secs(10),
            },
            None,
        );
        let live_mcp_server = crate::agent_messaging::AgentMessagingService::start(
            Weak::<crate::runtime_backend::RuntimeBackend>::new(),
            Arc::downgrade(&queue),
            crate::scheduled_prompts::ScheduledPromptService::inert_for_test(),
            Arc::clone(&live_service),
        )
        .await
        .expect("start live MCP");

        let owner_mcp =
            McpHttpTestClient::connect(&live_mcp_server.config(), "agent", &owner_thread).await;
        let intruder_mcp =
            McpHttpTestClient::connect(&live_mcp_server.config(), "agent", &intruder_thread).await;

        let owner_mcp_start = owner_mcp.clone();
        let start_task = tokio::spawn(async move {
            owner_mcp_start
                .call_tool_json(
                    30,
                    "start_phone_call",
                    json!({
                        "phoneNumber": "+15559876543",
                        "calleeName": "City Clinic",
                        "objective": "Check walk-in hours"
                    }),
                )
                .await
        });

        let approve_modal = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.present"
                && params["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("phone-call-approval:"))
        })
        .await;
        live_service
            .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                id: approve_modal["id"].as_str().expect("id").to_string(),
                thread_id: owner_thread.clone(),
                turn_id: None,
                action_id: "approve".to_string(),
            })
            .await;

        let live_card = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.present"
                && params["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("phone-call-live:"))
        })
        .await;
        let live_card_id = live_card["id"].as_str().expect("live card id").to_string();

        let started = timeout(TEST_TIMEOUT, start_task)
            .await
            .expect("MCP start timeout")
            .expect("join start");
        let call_id = started["callId"].as_str().expect("callId").to_string();
        assert_eq!(started["status"], "in_progress");

        // Another ACP session's MCP credential gets not_found on get / steer / hangup!
        assert_eq!(
            intruder_mcp
                .call_tool_json(31, "get_phone_call", json!({ "callId": call_id }))
                .await["status"],
            "not_found"
        );
        assert_eq!(
            intruder_mcp
                .call_tool_json(
                    32,
                    "steer_phone_call",
                    json!({ "callId": call_id, "instruction": "Hijack call" }),
                )
                .await["status"],
            "not_found"
        );
        assert_eq!(
            intruder_mcp
                .call_tool_json(33, "hangup_phone_call", json!({ "callId": call_id }))
                .await["status"],
            "not_found"
        );

        // User taps Hang Up on the live workflowCard mid-call -> sends SIP BYE, settles card, enqueues report!
        live_service
            .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                id: live_card_id.clone(),
                thread_id: owner_thread.clone(),
                turn_id: None,
                action_id: "hangup".to_string(),
            })
            .await;

        timeout(TEST_TIMEOUT, bye_seen_rx)
            .await
            .expect("mid-call mobile hangup SIP BYE timeout")
            .expect("SIP BYE received");

        let settled = recv_matching_notification(&mut rx, |method, params| {
            method == "bridge/ui.update"
                && params["id"] == live_card_id
                && params["title"] == "Phone call ended"
        })
        .await;
        assert_eq!(settled["dismissible"], true);
        assert_eq!(settled["actions"].as_array().map(Vec::len), Some(0));

        let report = timeout(TEST_TIMEOUT, report_rx.recv())
            .await
            .expect("mobile hangup post-call report timeout")
            .expect("post-call report");
        assert_eq!(report.thread_id, owner_thread);
        let report_text = report.turn_start["input"][0]["text"]
            .as_str()
            .expect("report text");
        assert!(report_text.contains(&call_id));
        assert!(report_text.contains("End reason: mobile_hangup"));

        timeout(TEST_TIMEOUT, async {
            while live_service.live_work_count() != 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("live_work_count returned to 0");
        assert!(can_retire_for_service(&live_service));

        let owner_snap = owner_mcp
            .call_tool_json(34, "get_phone_call", json!({ "callId": call_id }))
            .await;
        assert_eq!(owner_snap["status"], "completed");
        assert_eq!(owner_snap["endReason"], "mobile_hangup");
        assert_eq!(
            intruder_mcp
                .call_tool_json(35, "get_phone_call", json!({ "callId": call_id }))
                .await["status"],
            "not_found"
        );

        let _ = live_rtp;
        live_mcp_server.shutdown().await;
    }
}
