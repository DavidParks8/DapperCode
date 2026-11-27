#![forbid(unsafe_code)]
#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]

pub(crate) mod audio;
pub(crate) mod sip;
pub(crate) mod voice;

use crate::bridge_protocol::{
    BridgeQueueService, BridgeThreadQueueSendRequest, BridgeUiAction, BridgeUiActionStyle,
    BridgeUiBlock, BridgeUiKeyValueItem, BridgeUiPresentation, BridgeUiSurface, BridgeUiTone,
    ResolveBridgeUiSurfaceRequest,
};
use crate::client_hub::ClientHub;
use crate::config::{validate_e164_phone_number, PhoneCallRuntimeConfig};
use crate::interaction_validation::{now_iso, validate_bridge_ui_surface};
use crate::phone_call::audio::{
    build_rfc4733_digit_packets, encode_mulaw_frame_with_headroom, encode_wav_8k_mono,
    mulaw_frame_mean_abs, parse_dtmf_digit, synthesize_inband_dtmf_mulaw, Downsampler24kTo8k,
    TelephonyVad, VadEvent, RFC4733_DEFAULT_HOLD_PACKETS, RTP_FRAME_SAMPLES,
    VAD_MAX_UTTERANCE_SAMPLES,
};
use crate::phone_call::sip::{
    SipCallEvent, SipCallHandle, SipCallSession, SipCallState, SipDialConfig, SipError,
};
use crate::phone_call::voice::{
    is_substantive_reply, AssistantTurnOutput, TranscriptEntry, TranscriptSpeaker,
    VoiceCallPromptParams, VoiceConversation, VoiceError, VoicePipelineClient, VoiceToolCall,
    INTERRUPTED_MARKER,
};
use chrono::Utc;
use dappercode_bridge_core::resource_limits::{truncate_utf8_bytes, QUEUE_MAX_CONTENT_BYTES};
use dappercode_bridge_core::BridgeError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

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
const END_CALL_QUIET_GRACE: Duration = Duration::from_secs(2);

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
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
pub(crate) struct PhoneCallSnapshot {
    pub(crate) call_id: String,
    pub(crate) status: PhoneCallStatus,
    pub(crate) on_hold: bool,
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
            on_hold: false,
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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ApprovalEdits {
    objective: Option<String>,
    first_message: Option<Option<String>>,
    context: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ApprovalDecision {
    Approve(ApprovalEdits),
    Decline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallActivity {
    Dialing,
    Ringing,
    Listening,
    AgentSpeaking,
    RecipientSpeaking,
    OnHold,
}

impl CallActivity {
    fn label(self) -> &'static str {
        match self {
            Self::Dialing => "Dialing",
            Self::Ringing => "Ringing",
            Self::Listening => "Listening",
            Self::AgentSpeaking => "Agent speaking",
            Self::RecipientSpeaking => "Recipient speaking",
            Self::OnHold => "On hold",
        }
    }
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
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
struct SharedCallState {
    status: PhoneCallStatus,
    activity: CallActivity,
    on_hold: bool,
    validated: ValidatedStartRequest,
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

impl SharedCallState {
    fn elapsed_seconds(&self) -> Option<u64> {
        self.duration_seconds.or_else(|| {
            self.connected_instant
                .map(|started| Instant::now().saturating_duration_since(started).as_secs())
        })
    }
}

#[derive(Debug)]
struct ActiveCallSlot {
    call_id: String,
    owner_thread_id: String,
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
        PhoneCallSnapshot {
            call_id: self.call_id.clone(),
            status: guard.status,
            on_hold: guard.on_hold,
            phone_number: Some(guard.validated.phone_number.clone()),
            callee_name: guard.validated.callee_name.clone(),
            objective: Some(guard.validated.objective.clone()),
            started_at: Some(guard.started_at_iso.clone()),
            connected_at: guard.connected_at_iso.clone(),
            ended_at: guard.ended_at_iso.clone(),
            duration_seconds: guard.elapsed_seconds(),
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

    pub(crate) fn is_configured(&self) -> bool {
        self.config.is_some()
    }

    pub(crate) fn snapshot_surfaces(&self) -> Vec<BridgeUiSurface> {
        let Some(config) = self.config.as_ref() else {
            return Vec::new();
        };
        let Some(slot) = lock_unpoisoned(&self.registry).active.clone() else {
            return Vec::new();
        };
        if slot.skip_post_call_report.load(Ordering::Acquire) {
            return Vec::new();
        }
        snapshot_slot_surface(&slot, config).into_iter().collect()
    }

    pub(crate) fn start_phone_call<'a>(
        self: &'a Arc<Self>,
        caller_thread_id: &'a str,
        request: StartPhoneCallRequest,
    ) -> Pin<Box<dyn Future<Output = Result<StartPhoneCallResult, PhoneCallError>> + Send + 'a>>
    {
        Box::pin(self.start_phone_call_inner(caller_thread_id, request))
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
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

        let mut validated = validate_start_request(request)?;

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

        let admission = match self.queue.upgrade() {
            Some(queue) => Some(
                queue
                    .retirement_fence
                    .admit(owner_thread_id)
                    .await
                    .map_err(PhoneCallError::Invalid)?,
            ),
            None => None,
        };
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
            approval_tx: StdMutex::new(Some(approval_tx)),
            steer_tx,
            cancel: call_cancel.clone(),
            end_trigger: OnceLock::new(),
            skip_post_call_report: AtomicBool::new(false),
            settled_tx,
            settled_rx,
            shared: StdMutex::new(SharedCallState {
                status: PhoneCallStatus::AwaitingApproval,
                activity: CallActivity::Dialing,
                on_hold: false,
                validated: validated.clone(),
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
        drop(admission);

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
                Ok(ApprovalDecision::Approve(edits)) => Ok(edits),
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

        let approval_edits = match approval_outcome {
            Ok(edits) => edits,
            Err(reason_tag) => {
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
        };

        apply_approval_edits(&mut validated, approval_edits);
        {
            let mut shared = lock_unpoisoned(&slot.shared);
            shared.validated = validated.clone();
            shared.status = PhoneCallStatus::Dialing;
            shared.activity = CallActivity::Dialing;
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
                activity_label: Some("Dialing"),
                tone: BridgeUiTone::Info,
                in_call_actions: true,
                dismissible: false,
                duration_seconds: None,
                detail_label_value: None,
                technical_detail: None,
                transcript: &snapshot_transcript(&slot),
            },
        );
        let _ = self
            .publish_surface("bridge/ui.present", &initial_live_card)
            .await;
        abort_guard.live_card_presented = true;

        let pre_connect_card_ctx = PreConnectCardContext {
            live_surface_id: &live_surface_id,
            owner_thread_id,
            runtime_config: &runtime_config,
            validated: &validated,
            created_at: &created_at,
        };
        if let Err(error) = voice_client.preload_models(&call_cancel).await {
            let failure = if error.is_cancelled() {
                PreConnectFailure::Cancelled
            } else {
                PreConnectFailure::DialFailed {
                    detail: error.to_string(),
                    summary: "The local voice service could not get ready".to_string(),
                }
            };
            return Err(self
                .finish_pre_connect_failure(&mut abort_guard, &pre_connect_card_ctx, failure)
                .await);
        }

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
            res = SipCallSession::dial(dial_config) => res.map_err(|err| PreConnectFailure::dial_failed(&err)),
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
                ev = sip_session.next_event() => ev.ok_or_else(|| PreConnectFailure::DialFailed {
                    detail: "SIP session closed before connecting".to_string(),
                    summary: "Couldn't connect the call".to_string(),
                }),
            };

            match next_ev {
                Ok(SipCallEvent::Ringing) => {
                    {
                        let mut shared = lock_unpoisoned(&slot.shared);
                        shared.status = PhoneCallStatus::Ringing;
                        shared.activity = CallActivity::Ringing;
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
                            activity_label: Some("Ringing"),
                            tone: BridgeUiTone::Info,
                            in_call_actions: true,
                            dismissible: false,
                            duration_seconds: None,
                            detail_label_value: None,
                            technical_detail: None,
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
                Ok(SipCallEvent::HoldChanged { .. }) => {}
                Ok(SipCallEvent::Ended { reason }) => {
                    break Err(match sip_session.state() {
                        SipCallState::Ended {
                            failure: Some(fail),
                            ..
                        } => PreConnectFailure::dial_failed(&fail.into_sip_error()),
                        _ => PreConnectFailure::DialFailed {
                            summary: describe_call_end(&reason),
                            detail: reason,
                        },
                    });
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
            shared.activity = CallActivity::Listening;
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
                activity_label: Some("Listening"),
                tone: BridgeUiTone::Success,
                in_call_actions: true,
                dismissible: false,
                duration_seconds: Some(0),
                detail_label_value: None,
                technical_detail: None,
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

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::excessive_nesting,
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
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

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_nesting,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
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

    pub(crate) async fn resolve_ui_action(
        &self,
        request: &ResolveBridgeUiSurfaceRequest,
    ) -> Result<(), BridgeError> {
        let surface_id = request.id.trim();
        let thread_id = request.thread_id.trim();
        let action_id = request.action_id.trim();

        let is_approval = surface_id.starts_with("phone-call-approval:");
        let is_live = surface_id.starts_with("phone-call-live:");
        if !is_approval && !is_live {
            return Ok(());
        }

        let Some(slot) = self.active_slot_for_thread(thread_id) else {
            return missing_call_action_result(is_live, action_id);
        };
        if is_approval && surface_id == approval_surface_id(&slot.call_id) {
            return self.resolve_approval_surface_action(
                &slot,
                action_id,
                request.payload.as_ref(),
            );
        }
        if is_live && surface_id == live_surface_id(&slot.call_id) {
            return self
                .resolve_live_surface_action(&slot, action_id, request.payload.as_ref())
                .await;
        }
        Ok(())
    }

    fn active_slot_for_thread(&self, thread_id: &str) -> Option<Arc<ActiveCallSlot>> {
        let slot = lock_unpoisoned(&self.registry).active.clone()?;
        (slot.owner_thread_id == thread_id).then_some(slot)
    }

    fn resolve_approval_surface_action(
        &self,
        slot: &Arc<ActiveCallSlot>,
        action_id: &str,
        payload: Option<&Value>,
    ) -> Result<(), BridgeError> {
        let decision = match action_id {
            "approve" => Some(ApprovalDecision::Approve(parse_approval_edits(payload)?)),
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
        Ok(())
    }

    async fn resolve_live_surface_action(
        &self,
        slot: &Arc<ActiveCallSlot>,
        action_id: &str,
        payload: Option<&Value>,
    ) -> Result<(), BridgeError> {
        if action_id == "hangup" {
            slot.request_hangup(EndTrigger::MobileHangup);
            return Ok(());
        }
        if action_id != "steer" {
            return Ok(());
        }
        let instruction = parse_steer_instruction_payload(payload)?;
        let result = self
            .steer_phone_call(&slot.owner_thread_id, &slot.call_id, &instruction)
            .map_err(|err| err.to_string())
            .map_err(BridgeError::invalid_params)?;
        if result.status != SteerPhoneCallStatus::Steered {
            return Err(BridgeError::invalid_params(
                "This phone call has already ended.",
            ));
        }
        let pre_connect_update = {
            let shared = lock_unpoisoned(&slot.shared);
            matches!(
                shared.status,
                PhoneCallStatus::Dialing | PhoneCallStatus::Ringing,
            )
        };
        if pre_connect_update {
            for surface in self.snapshot_surfaces() {
                if surface.id == live_surface_id(&slot.call_id) {
                    let _ = self.publish_surface("bridge/ui.update", &surface).await;
                }
            }
        }
        Ok(())
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

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn finish_pre_connect_failure(
        &self,
        abort_guard: &mut PreConnectAbortGuard,
        card_ctx: &PreConnectCardContext<'_>,
        failure: PreConnectFailure,
    ) -> PhoneCallError {
        let (final_status, title, subtitle, status_val, tone, reason, card_reason, detail, err) =
            match failure {
                PreConnectFailure::Cancelled => (
                    PhoneCallStatus::Cancelled,
                    Some("Phone call ended"),
                    "Cancelled before answer",
                    "Cancelled",
                    BridgeUiTone::Neutral,
                    "cancelled_before_connect".to_string(),
                    describe_call_end("cancelled_before_connect"),
                    None,
                    PhoneCallError::Rejected(
                        "Phone call was hung up before connecting".to_string(),
                    ),
                ),
                PreConnectFailure::DialFailed { detail, summary } => (
                    PhoneCallStatus::Failed,
                    Some("Phone call failed"),
                    "Call could not connect",
                    "Failed",
                    BridgeUiTone::Error,
                    detail.clone(),
                    summary,
                    Some(detail.clone()),
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
                activity_label: None,
                tone,
                in_call_actions: false,
                dismissible: true,
                duration_seconds: None,
                detail_label_value: Some(("Reason", &card_reason)),
                technical_detail: detail.as_deref(),
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
            shared.on_hold = false;
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
    /// `detail` is the raw cause for the agent; `summary` is what the user reads on the card.
    DialFailed {
        detail: String,
        summary: String,
    },
}

impl PreConnectFailure {
    fn dial_failed(error: &SipError) -> Self {
        Self::DialFailed {
            detail: error.to_string(),
            summary: describe_dial_failure(error).to_string(),
        }
    }
}

/// The user's words for why a call ended; agents still receive the raw end reason.
fn describe_call_end(end_reason: &str) -> String {
    let described = match end_reason {
        "mobile_hangup" => "You hung up",
        "agent_hangup" => "The agent hung up",
        "remote_bye" => "They hung up",
        "local_hangup" => "Hung up",
        "max_duration_reached" => "Reached the time limit",
        "thread_retired" => "The chat session closed",
        "bridge_shutdown" => "The bridge stopped",
        "cancelled_before_connect" => "Cancelled before answer",
        "closed" | "cancelled" => "The call ended",
        reason if reason.starts_with("transport_error") => "The connection dropped",
        reason => return reason.to_string(),
    };
    described.to_string()
}

fn describe_dial_failure(error: &SipError) -> &'static str {
    match error {
        SipError::Rejected {
            status_code: 486 | 600,
            ..
        } => "Line busy",
        SipError::Rejected {
            status_code: 603 | 607 | 608,
            ..
        } => "Call declined",
        SipError::Rejected {
            status_code: 404 | 484 | 604,
            ..
        } => "Number not reachable",
        SipError::Rejected {
            status_code: 408 | 480 | 487,
            ..
        } => "No answer",
        SipError::Timeout(reason) if reason.contains("ring_timeout") => "No answer",
        SipError::AuthFailed { .. } => "The phone service rejected the SIP sign-in",
        _ => "Couldn't connect the call",
    }
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
        reason: impl Into<String>,
        outcome_summary: Option<String>,
    ) {
        self.armed = false;
        self.service.complete_slot(
            &self.slot,
            final_status,
            None,
            reason.into(),
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn validate_start_request(
    request: StartPhoneCallRequest,
) -> Result<ValidatedStartRequest, PhoneCallError> {
    let phone_number = validate_e164_phone_number("phoneNumber", &request.phone_number)
        .map_err(PhoneCallError::Invalid)?;

    if request.objective.len() > MAX_OBJECTIVE_BYTES || request.objective.contains('\0') {
        return Err(PhoneCallError::Invalid(format!(
            "objective must be at most {MAX_OBJECTIVE_BYTES} bytes and free of NUL characters",
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
                    "calleeName must be at most {MAX_CALLEE_NAME_BYTES} bytes and free of control characters",
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
                    "firstMessage must be at most {MAX_FIRST_MESSAGE_BYTES} bytes and free of NUL characters",
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
                    "context must be at most {MAX_CONTEXT_BYTES} bytes and free of NUL characters",
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
            "callId must be between 1 and {MAX_CALL_ID_BYTES} printable bytes",
        )));
    }
    Ok(trimmed.to_string())
}

fn validate_steer_instruction(raw: &str) -> Result<String, PhoneCallError> {
    if raw.len() > MAX_STEER_INSTRUCTION_BYTES || raw.contains('\0') {
        return Err(PhoneCallError::Invalid(format!(
            "instruction must be at most {MAX_STEER_INSTRUCTION_BYTES} bytes and free of NUL characters",
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

fn validate_optional_approval_text(
    raw: &str,
    field: &str,
    max_bytes: usize,
) -> Result<Option<String>, BridgeError> {
    if raw.len() > max_bytes || raw.contains('\0') {
        return Err(BridgeError::invalid_params(format!(
            "{field} must be at most {max_bytes} bytes and free of NUL characters",
        )));
    }
    let trimmed = raw.trim();
    Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
}

fn parse_approval_edits(payload: Option<&Value>) -> Result<ApprovalEdits, BridgeError> {
    let Some(map) = payload.and_then(Value::as_object) else {
        return Ok(ApprovalEdits::default());
    };
    let objective = match map.get("objective") {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) => {
            let Some(valid) =
                validate_optional_approval_text(raw, "objective", MAX_OBJECTIVE_BYTES)?
            else {
                return Err(BridgeError::invalid_params("objective must not be empty"));
            };
            Some(valid)
        }
        Some(_) => return Err(BridgeError::invalid_params("objective must be a string")),
    };
    let first_message = match map.get("firstMessage") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(raw)) => Some(validate_optional_approval_text(
            raw,
            "firstMessage",
            MAX_FIRST_MESSAGE_BYTES,
        )?),
        Some(_) => return Err(BridgeError::invalid_params("firstMessage must be a string")),
    };
    let context = match map.get("context") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(raw)) => Some(validate_optional_approval_text(
            raw,
            "context",
            MAX_CONTEXT_BYTES,
        )?),
        Some(_) => return Err(BridgeError::invalid_params("context must be a string")),
    };
    Ok(ApprovalEdits {
        objective,
        first_message,
        context,
    })
}

fn apply_approval_edits(validated: &mut ValidatedStartRequest, edits: ApprovalEdits) {
    if let Some(objective) = edits.objective {
        validated.objective = objective;
    }
    if let Some(first_message) = edits.first_message {
        validated.first_message = first_message;
    }
    if let Some(context) = edits.context {
        validated.context = context;
    }
}

fn parse_steer_instruction_payload(payload: Option<&Value>) -> Result<String, BridgeError> {
    let Some(raw) = payload
        .and_then(Value::as_object)
        .and_then(|map| map.get("instruction"))
        .and_then(Value::as_str)
    else {
        return Err(BridgeError::invalid_params(
            "instruction must be a non-empty string",
        ));
    };
    validate_steer_instruction(raw)
        .map_err(|err| err.to_string())
        .map_err(BridgeError::invalid_params)
}

fn missing_call_action_result(is_live: bool, action_id: &str) -> Result<(), BridgeError> {
    if is_live && action_id == "steer" {
        return Err(BridgeError::invalid_params(
            "This phone call has already ended.",
        ));
    }
    Ok(())
}

fn snapshot_slot_surface(
    slot: &ActiveCallSlot,
    config: &PhoneCallRuntimeConfig,
) -> Option<BridgeUiSurface> {
    let shared = lock_unpoisoned(&slot.shared);
    let (status, subtitle, tone) = match shared.status {
        PhoneCallStatus::AwaitingApproval => {
            if slot.cancel.is_cancelled() || lock_unpoisoned(&slot.approval_tx).is_none() {
                return None;
            }
            return Some(build_approval_modal_surface(
                approval_surface_id(&slot.call_id),
                &slot.owner_thread_id,
                config,
                &shared.validated,
            ));
        }
        PhoneCallStatus::Dialing => ("Dialing", "Dialing…", BridgeUiTone::Info),
        PhoneCallStatus::Ringing => ("Ringing", "Ringing…", BridgeUiTone::Info),
        PhoneCallStatus::InProgress => {
            let status = if shared.on_hold { "On hold" } else { "In call" };
            (status, status, BridgeUiTone::Success)
        }
        _ => return None,
    };
    let activity_label = shared.activity.label();
    Some(build_live_workflow_card(
        live_surface_id(&slot.call_id),
        &slot.owner_thread_id,
        config,
        &shared.validated,
        &shared.started_at_iso,
        LiveCardParams {
            title_override: None,
            subtitle,
            status_value: status,
            activity_label: Some(activity_label),
            tone,
            in_call_actions: true,
            dismissible: false,
            duration_seconds: shared.elapsed_seconds(),
            detail_label_value: None,
            technical_detail: None,
            transcript: &shared.transcript,
        },
    ))
}

// ============================================================================
// Connected Full-Duplex Voice Call Runner
// ============================================================================

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
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
    clauses_finished: Vec<usize>,
    total_frames_enqueued: usize,
    discarded_frames_at_start: usize,
    finish_after_clause: Option<usize>,
    synthesizing: Option<(usize, CancellationToken)>,
}

impl SpokenTurnProgress {
    fn spoken_text(&self, cleared_frames: usize) -> String {
        if self.clauses_started.is_empty() {
            return String::new();
        }
        let played_frames = self.total_frames_enqueued.saturating_sub(cleared_frames);
        let mut spoken: Vec<&str> = Vec::new();
        for (idx, (start_frame, clause)) in self.clauses_started.iter().enumerate() {
            if *start_frame < played_frames
                && self
                    .clauses_finished
                    .get(idx)
                    .is_some_and(|end| *end <= played_frames)
            {
                spoken.push(clause.as_str());
            } else if *start_frame < played_frames {
                spoken.push("[partially spoken sentence]");
                break;
            }
        }
        spoken.join(" ")
    }
}

struct ActiveAssistantTurn {
    steer_revision: usize,
    cancel: CancellationToken,
    progress: Arc<StdMutex<SpokenTurnProgress>>,
    handle: JoinHandle<Result<AssistantTurnOutput, VoiceError>>,
}

impl ActiveAssistantTurn {
    fn abort_and_extract_spoken(&self, sip_handle: &SipCallHandle) -> String {
        self.cancel.cancel();
        self.handle.abort();
        let guard = lock_unpoisoned(&self.progress);
        let cleared = sip_handle.clear_outbound_audio();
        guard.spoken_text(
            cleared
                .discarded_frames
                .saturating_sub(guard.discarded_frames_at_start),
        )
    }

    fn finish_current_sentence(&self, sip_handle: &SipCallHandle) -> bool {
        let mut progress = lock_unpoisoned(&self.progress);
        let playback = sip_handle.outbound_playback_state();
        let played = progress
            .total_frames_enqueued
            .saturating_sub(
                playback
                    .discarded_frames
                    .saturating_sub(progress.discarded_frames_at_start),
            )
            .saturating_sub(playback.cleared_frames);
        let Some(idx) =
            progress
                .clauses_started
                .iter()
                .enumerate()
                .find_map(|(idx, (start, _))| {
                    (*start < played
                        && progress.clauses_finished.get(idx).is_none_or(|end| {
                            *end > played || (*end == played && playback.outbound_playing)
                        }))
                    .then_some(idx)
                })
        else {
            return false;
        };
        progress.finish_after_clause = Some(idx);
        if let Some((synth_idx, cancel)) = &progress.synthesizing {
            if *synth_idx > idx {
                cancel.cancel();
            }
        }
        if let Some(end) = progress.clauses_finished.get(idx).copied() {
            sip_handle.trim_outbound_audio(
                progress.total_frames_enqueued,
                progress.discarded_frames_at_start,
                end,
            );
            progress.clauses_started.truncate(idx + 1);
            progress.clauses_finished.truncate(idx + 1);
        }
        true
    }
}

fn requests_immediate_speech_stop(instruction: &str) -> bool {
    let lowered = instruction.trim().to_ascii_lowercase();
    let command = ["please ", "could you ", "can you ", "would you "]
        .iter()
        .find_map(|prefix| lowered.strip_prefix(prefix))
        .unwrap_or(&lowered);
    command
        .strip_prefix("stop")
        .is_some_and(|rest| !rest.starts_with(char::is_alphanumeric))
        || command.starts_with("be quiet")
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

struct PendingCallEnd {
    reason: String,
    summary: String,
    deadline: tokio::time::Instant,
}

async fn wait_for_pending_end(pending: &Option<PendingCallEnd>) {
    match pending {
        Some(end) => tokio::time::sleep_until(end.deadline).await,
        None => std::future::pending().await,
    }
}

// Every assistant turn starts here so an accepted hang-up never outlives a newer turn.
async fn start_assistant_turn(
    ctx: &ConnectedCallContext,
    conversation: &VoiceConversation,
    sip_handle: &SipCallHandle,
    pending_end: &mut Option<PendingCallEnd>,
) -> ActiveAssistantTurn {
    *pending_end = None;
    let activity = if conversation.is_on_hold() {
        CallActivity::OnHold
    } else {
        CallActivity::AgentSpeaking
    };
    let turn = spawn_assistant_turn(
        &ctx.voice_client,
        conversation,
        sip_handle,
        &ctx.slot.cancel,
    );
    if set_call_activity(&ctx.slot, activity) {
        publish_in_call_card_update(ctx, conversation.transcript()).await;
    }
    turn
}

fn set_call_activity(slot: &ActiveCallSlot, activity: CallActivity) -> bool {
    let mut shared = lock_unpoisoned(&slot.shared);
    if shared.activity == activity {
        return false;
    }
    shared.activity = activity;
    true
}

fn set_call_hold(slot: &ActiveCallSlot, conversation: &mut VoiceConversation, on_hold: bool) {
    conversation.set_on_hold(on_hold);
    let mut shared = lock_unpoisoned(&slot.shared);
    shared.on_hold = on_hold;
    shared.activity = if on_hold {
        CallActivity::OnHold
    } else {
        CallActivity::Listening
    };
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        perfectionist::overly_long_function,
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
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
    let mut pending_utterances: VecDeque<Vec<i16>> = VecDeque::new();
    let mut speech_quiet_deadline = None;
    let mut active_turn: Option<ActiveAssistantTurn> = None;
    let mut pending_end: Option<PendingCallEnd> = None;
    let mut transport_on_hold = false;

    if steer_pending_turn {
        opening_greeting_pending = false;
        opening_window_elapsed = true;
        steer_pending_turn = false;
        active_turn =
            Some(start_assistant_turn(&ctx, &conversation, &sip_handle, &mut pending_end).await);
    }

    let exit = loop {
        let mut new_utterance = None;
        tokio::select! {
            biased;
            () = ctx.slot.cancel.cancelled() => {
                if let Some(stt) = active_stt.take() {
                    stt.abort();
                }
                if let Some(turn) = active_turn.take() {
                    let spoken = turn.abort_and_extract_spoken(&sip_handle);
                    if !spoken.is_empty() {
                        conversation.record_active_assistant_interrupted(&spoken);
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
                    let spoken = turn.abort_and_extract_spoken(&sip_handle);
                    if !spoken.is_empty() {
                        conversation.record_active_assistant_interrupted(&spoken);
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
                            let spoken = turn.abort_and_extract_spoken(&sip_handle);
                            if !spoken.is_empty() {
                                conversation.record_active_assistant_interrupted(&spoken);
                                sync_shared_transcript(&ctx.slot, conversation.transcript());
                            }
                        }
                        break CallLoopExit::Completed {
                            end_reason: reason,
                            outcome_summary: None,
                        };
                    }
                    Some(SipCallEvent::Ringing | SipCallEvent::Connected { .. }) => {}
                    Some(SipCallEvent::HoldChanged { on_hold, negotiated_dtmf_pt }) => {
                        ctx.negotiated_dtmf_pt = negotiated_dtmf_pt;
                        if transport_on_hold == on_hold {
                            continue;
                        }
                        transport_on_hold = on_hold;
                        pending_end = None;
                        if let Some(turn) = active_turn.take() {
                            steer_pending_turn = true;
                            let spoken = turn.abort_and_extract_spoken(&sip_handle);
                            if !spoken.is_empty() {
                                conversation.record_active_assistant_interrupted(&spoken);
                            }
                        }
                        opening_greeting_pending = false;
                        opening_window_elapsed = true;
                        steer_pending_turn |= conversation.has_pending_steers();
                        if let Some(VadEvent::UtteranceComplete(samples)) = vad.finish_after_media_quiet() {
                            new_utterance = Some(samples);
                        }
                        speech_quiet_deadline = None;
                        set_call_hold(&ctx.slot, &mut conversation, on_hold);
                        vad = TelephonyVad::new();
                        vad.set_ivr_mode(on_hold);
                        sync_shared_transcript(&ctx.slot, conversation.transcript());
                        publish_in_call_card_update(&ctx, conversation.transcript()).await;
                    }
                    None => {
                        event_rx = None;
                    }
                }
            }
            Some(instruction) = ctx.steer_rx.recv() => {
                pending_end = None;
                let finish_sentence = !requests_immediate_speech_stop(&instruction)
                    && active_turn.as_ref().is_some_and(|turn| turn.finish_current_sentence(&sip_handle));
                if !finish_sentence {
                    if let Some(turn) = active_turn.take() {
                        let spoken = turn.abort_and_extract_spoken(&sip_handle);
                        if !spoken.is_empty() {
                            conversation.record_active_assistant_interrupted(&spoken);
                        }
                    }
                }
                conversation.inject_steer(&instruction);
                sync_shared_transcript(&ctx.slot, conversation.transcript());
                publish_in_call_card_update(&ctx, conversation.transcript()).await;

                if !transport_on_hold && active_turn.is_none() && active_stt.is_none() && !vad.has_pending_speech() {
                    opening_greeting_pending = false;
                    opening_window_elapsed = true;
                    steer_pending_turn = false;
                    active_turn = Some(
                        start_assistant_turn(&ctx, &conversation, &sip_handle, &mut pending_end)
                            .await,
                    );
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
                if mulaw_frame_mean_abs(&frame.inbound_pcmu)
                    >= vad.speech_threshold(frame.outbound_playing, outbound_mean)
                {
                    let speech_started = speech_quiet_deadline.is_none();
                    let hangover = u32::try_from(vad.hangover_frames()).expect("VAD hangover is bounded");
                    speech_quiet_deadline = Some(tokio::time::Instant::now() + Duration::from_millis(20) * hangover);
                    if speech_started
                        && !conversation.is_on_hold()
                        && active_turn.is_none()
                        && set_call_activity(&ctx.slot, CallActivity::RecipientSpeaking)
                    {
                        publish_in_call_card_update(&ctx, conversation.transcript()).await;
                    }
                }
                match vad.process_mulaw_frame(
                    &frame.inbound_pcmu,
                    frame.outbound_playing,
                    outbound_mean,
                ) {
                    Some(VadEvent::BargeIn) => {
                        if !conversation.is_on_hold() {
                            set_call_activity(&ctx.slot, CallActivity::RecipientSpeaking);
                        }
                        match active_turn.take() {
                            Some(turn) => {
                                let spoken = turn.abort_and_extract_spoken(&sip_handle);
                                conversation.record_active_assistant_interrupted(&spoken);
                                sync_shared_transcript(&ctx.slot, conversation.transcript());
                                publish_in_call_card_update(&ctx, conversation.transcript()).await;
                            }
                            None => {
                                sip_handle.clear_outbound_audio();
                                publish_in_call_card_update(&ctx, conversation.transcript()).await;
                            }
                        }
                    }
                    Some(VadEvent::UtteranceComplete(samples)) => {
                        speech_quiet_deadline = None;
                        new_utterance = Some(samples);
                    }
                    None => {}
                }
            }
            () = tokio::time::sleep_until(speech_quiet_deadline.unwrap_or(call_deadline)),
                if speech_quiet_deadline.is_some() => {
                speech_quiet_deadline = None;
                if let Some(VadEvent::UtteranceComplete(samples)) = vad.finish_after_media_quiet() {
                    new_utterance = Some(samples);
                }
            }
            stt_join = poll_active_stt(&mut active_stt), if active_stt.is_some() => {
                active_stt = None;
                if let Some(samples) = pending_utterances.pop_front() {
                    active_stt = Some(spawn_stt_task(
                        &ctx.voice_client,
                        encode_wav_8k_mono(&samples),
                        &conversation,
                        &ctx.slot.cancel,
                    ));
                }
                match stt_join {
                    Ok(Ok(Some(callee_text))) => {
                        if pending_end.is_some() && !is_substantive_reply(&callee_text) {
                            // A short "Bye" or noise fragment after the spoken closing confirms it.
                            conversation.push_callee_utterance(&callee_text);
                            sync_shared_transcript(&ctx.slot, conversation.transcript());
                            publish_in_call_card_update(&ctx, conversation.transcript()).await;
                            if let Some(end) = &mut pending_end {
                                end.deadline = tokio::time::Instant::now() + END_CALL_QUIET_GRACE;
                            }
                            continue;
                        }
                        pending_end = None;
                        opening_greeting_pending = false;
                        opening_window_elapsed = true;
                        steer_pending_turn = true;
                        if let Some(turn) = active_turn.take() {
                            let spoken = turn.abort_and_extract_spoken(&sip_handle);
                            conversation.record_active_assistant_interrupted(&spoken);
                        }
                        conversation.push_callee_utterance(&callee_text);
                        sync_shared_transcript(&ctx.slot, conversation.transcript());
                        publish_in_call_card_update(&ctx, conversation.transcript()).await;
                        if !transport_on_hold && active_stt.is_none() && !vad.has_pending_speech() {
                            steer_pending_turn = false;
                            active_turn = Some(
                                start_assistant_turn(
                                    &ctx,
                                    &conversation,
                                    &sip_handle,
                                    &mut pending_end,
                                )
                                .await,
                            );
                        }
                    }
                    Ok(Ok(None)) => {
                        let should_speak_now =
                            !transport_on_hold
                                && ((opening_greeting_pending && opening_window_elapsed)
                                || steer_pending_turn)
                                && active_turn.is_none()
                                && active_stt.is_none()
                                && !vad.has_pending_speech();
                        if should_speak_now {
                            opening_greeting_pending = false;
                            opening_window_elapsed = true;
                            steer_pending_turn = false;
                            active_turn = Some(
                                start_assistant_turn(
                                    &ctx,
                                    &conversation,
                                    &sip_handle,
                                    &mut pending_end,
                                )
                                .await,
                            );
                        } else if set_call_activity(
                            &ctx.slot,
                            if conversation.is_on_hold() {
                                CallActivity::OnHold
                            } else {
                                CallActivity::Listening
                            },
                        ) {
                            publish_in_call_card_update(&ctx, conversation.transcript()).await;
                        }
                    }
                    Ok(Err(err)) if err.is_cancelled() => {}
                    Ok(Err(err)) => {
                        if let Some(turn) = active_turn.take() {
                            let spoken = turn.abort_and_extract_spoken(&sip_handle);
                            if !spoken.is_empty() {
                                conversation.record_active_assistant_interrupted(&spoken);
                            }
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
                let completed_turn = active_turn.take();
                match turn_join {
                    Ok(Ok(mut turn_output)) => {
                        if let Some(turn) = &completed_turn {
                            conversation.acknowledge_steers_through(turn.steer_revision);
                        }
                        let was_on_hold = conversation.is_on_hold();
                        if was_on_hold {
                            turn_output.full_text.clear();
                            turn_output.clauses.clear();
                        }
                        conversation.record_assistant_turn(&turn_output);
                        set_call_activity(
                            &ctx.slot,
                            if was_on_hold {
                                CallActivity::OnHold
                            } else {
                                CallActivity::Listening
                            },
                        );
                        sync_shared_transcript(&ctx.slot, conversation.transcript());
                        publish_in_call_card_update(&ctx, conversation.transcript()).await;

                        let mut dtmf_error: Option<String> = None;
                        let requested_hold = turn_output.tool_calls.iter().any(|tool| {
                            matches!(tool, VoiceToolCall::WaitSilently { on_hold: true, .. })
                        });

                        for tool_call in &turn_output.tool_calls {
                            match tool_call {
                                VoiceToolCall::SendDtmf {
                                    call_id: tc_id,
                                    digits,
                                } => {
                                    if was_on_hold {
                                        conversation.record_tool_result(tc_id, "Not sent: the call is on hold. Wait for the recipient to return.");
                                        continue;
                                    }
                                    if let Err(err) = transmit_dtmf(
                                        &sip_handle,
                                        ctx.negotiated_dtmf_pt,
                                        digits,
                                    ) {
                                        dtmf_error = Some(err);
                                        break;
                                    }
                                    conversation.record_event(&format!("Pressed {digits}"));
                                    conversation.record_tool_result(
                                        tc_id,
                                        &format!("Sent DTMF digits: {digits}"),
                                    );
                                    vad.set_ivr_mode(true);
                                }
                                VoiceToolCall::WaitSilently {
                                    call_id: tc_id,
                                    reason,
                                    on_hold,
                                } => {
                                    pending_end = None;
                                    if *on_hold {
                                        set_call_hold(&ctx.slot, &mut conversation, true);
                                    }
                                    vad.set_ivr_mode(true);
                                    conversation.record_tool_result(
                                        tc_id,
                                        &format!("Waiting silently: {reason}"),
                                    );
                                }
                                VoiceToolCall::ResumeCall { call_id: tc_id } => {
                                    if transport_on_hold {
                                        conversation.record_tool_result(tc_id, "Not resumed: the remote SIP endpoint still has this call on hold.");
                                        continue;
                                    }
                                    if was_on_hold && !requested_hold {
                                        set_call_hold(&ctx.slot, &mut conversation, false);
                                        vad.set_ivr_mode(false);
                                        steer_pending_turn = true;
                                    }
                                    conversation.record_tool_result(tc_id, "Conversation resumed; respond to the recipient now.");
                                }
                                VoiceToolCall::EndCall {
                                    call_id: tc_id,
                                    reason,
                                    outcome_summary,
                                } => {
                                    let rejection = if steer_pending_turn {
                                        Some("Not ended: the user sent a new instruction. Follow it before ending the call.")
                                    } else if was_on_hold || requested_hold || !conversation.can_end_call()
                                        || turn_output.full_text.trim().is_empty()
                                    {
                                        Some("Not ended: a single-word transcription is provisional, not a completed answer. A substantive recipient reply and a spoken closing are required. Keep listening.")
                                    } else {
                                        None
                                    };
                                    if let Some(result) = rejection {
                                        conversation.record_tool_result(tc_id, result);
                                    } else {
                                        conversation.record_tool_result(tc_id,
                                            "Ending the call after a short quiet period. If the recipient keeps talking, you will get another turn.");
                                        pending_end = Some(PendingCallEnd {
                                            reason: reason.clone(),
                                            summary: outcome_summary.clone(),
                                            deadline: tokio::time::Instant::now() + END_CALL_QUIET_GRACE,
                                        });
                                    }
                                }
                            }
                        }

                        if let Some(err) = dtmf_error {
                            let _ = sip_handle.hangup().await;
                            break CallLoopExit::Failed { error: err };
                        }

                        sync_shared_transcript(&ctx.slot, conversation.transcript());
                        publish_in_call_card_update(&ctx, conversation.transcript()).await;

                        if !transport_on_hold && steer_pending_turn && active_stt.is_none() && !vad.has_pending_speech() {
                            steer_pending_turn = false;
                            active_turn = Some(
                                start_assistant_turn(
                                    &ctx,
                                    &conversation,
                                    &sip_handle,
                                    &mut pending_end,
                                )
                                .await,
                            );
                        }
                    }
                    Ok(Err(err)) if err.is_cancelled() => {}
                    Ok(Err(err)) => {
                        if let Some(turn) = completed_turn {
                            let spoken = turn.abort_and_extract_spoken(&sip_handle);
                            if !spoken.is_empty() {
                                conversation.record_active_assistant_interrupted(&spoken);
                            }
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
                                error: format!("assistant voice turn failed: {join_err}"),
                            };
                        }
                    }
                }
            }
            () = wait_for_pending_end(&pending_end), if pending_end.is_some() => {
                if conversation.is_on_hold() {
                    pending_end = None;
                } else if vad.has_pending_speech() || active_stt.is_some()
                    || sip_handle.has_pending_outbound_media()
                {
                    // Speech defers the hang-up; its transcription decides whether the call continues.
                    if let Some(end) = &mut pending_end {
                        end.deadline = tokio::time::Instant::now() + PLAYBACK_POLL_INTERVAL;
                    }
                } else if let Some(end) = pending_end.take() {
                    let _ = sip_handle.hangup().await;
                    break CallLoopExit::Completed {
                        end_reason: end.reason,
                        outcome_summary: Some(end.summary),
                    };
                }
            }
            () = tokio::time::sleep_until(opening_deadline), if opening_greeting_pending && !opening_window_elapsed && active_turn.is_none() => {
                opening_window_elapsed = true;
                if !transport_on_hold && !vad.has_pending_speech() && active_stt.is_none() {
                    opening_greeting_pending = false;
                    steer_pending_turn = false;
                    active_turn = Some(
                        start_assistant_turn(&ctx, &conversation, &sip_handle, &mut pending_end)
                            .await,
                    );
                }
            }
        }
        if let Some(samples) = new_utterance {
            if !conversation.is_on_hold()
                && set_call_activity(&ctx.slot, CallActivity::RecipientSpeaking)
            {
                publish_in_call_card_update(&ctx, conversation.transcript()).await;
            }
            if active_stt.is_some() {
                let queued_samples: usize = pending_utterances.iter().map(Vec::len).sum();
                if queued_samples.saturating_add(samples.len()) > VAD_MAX_UTTERANCE_SAMPLES {
                    let _ = sip_handle.hangup().await;
                    break CallLoopExit::Failed {
                        error: "The transcription backlog exceeded the bounded audio limit."
                            .to_string(),
                    };
                }
                pending_utterances.push_back(samples);
            } else {
                active_stt = Some(spawn_stt_task(
                    &ctx.voice_client,
                    encode_wav_8k_mono(&samples),
                    &conversation,
                    &ctx.slot.cancel,
                ));
            }
        }
        let call_idle = !transport_on_hold
            && active_turn.is_none()
            && active_stt.is_none()
            && !vad.has_pending_speech();
        let ready_to_speak =
            steer_pending_turn || (opening_greeting_pending && opening_window_elapsed);
        if call_idle && ready_to_speak {
            steer_pending_turn = false;
            opening_greeting_pending = false;
            active_turn = Some(
                start_assistant_turn(&ctx, &conversation, &sip_handle, &mut pending_end).await,
            );
        }
    };

    // Stop any detached STT or turn task on every exit path.
    ctx.slot.cancel.cancel();
    settle_connected_call(&ctx, conversation.transcript().to_vec(), exit).await;
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
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

    // The card speaks plainly; the raw failure stays one row down and in the agent's report.
    let failed = final_status == PhoneCallStatus::Failed;
    let card_reason = if failed {
        "The voice assistant hit an error".to_string()
    } else {
        describe_call_end(&end_reason)
    };
    let detail_pair = match outcome_summary.as_deref() {
        Some(summary) if !failed => ("Summary", summary),
        _ => ("Reason", card_reason.as_str()),
    };

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
            activity_label: None,
            tone,
            in_call_actions: false,
            dismissible: true,
            duration_seconds: Some(duration_seconds),
            detail_label_value: Some(detail_pair),
            technical_detail: failed.then_some(end_reason.as_str()),
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
    let (on_hold, activity_label) = {
        let shared = lock_unpoisoned(&ctx.slot.shared);
        (shared.on_hold, shared.activity.label())
    };
    let status = if on_hold { "On hold" } else { "In call" };
    let card = build_live_workflow_card(
        &ctx.live_surface_id,
        &ctx.slot.owner_thread_id,
        &ctx.runtime_config,
        &ctx.validated,
        &ctx.card_created_at,
        LiveCardParams {
            title_override: None,
            subtitle: status,
            status_value: status,
            activity_label: Some(activity_label),
            tone: BridgeUiTone::Success,
            in_call_actions: true,
            dismissible: false,
            duration_seconds: Some(elapsed_secs),
            detail_label_value: None,
            technical_detail: None,
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        perfectionist::overly_long_function,
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn spawn_assistant_turn(
    voice_client: &VoicePipelineClient,
    conversation: &VoiceConversation,
    sip_handle: &SipCallHandle,
    parent_cancel: &CancellationToken,
) -> ActiveAssistantTurn {
    let turn_cancel = parent_cancel.child_token();
    let task_cancel = turn_cancel.clone();
    let progress = Arc::new(StdMutex::new(SpokenTurnProgress {
        discarded_frames_at_start: sip_handle.outbound_playback_state().discarded_frames,
        ..SpokenTurnProgress::default()
    }));
    let task_progress = Arc::clone(&progress);
    let client = voice_client.clone();
    let conv_snapshot = conversation.clone();
    let rtp_handle = sip_handle.clone();

    let handle = tokio::spawn(Box::pin(async move {
        if conv_snapshot.is_on_hold() {
            return client
                .stream_assistant_turn(&conv_snapshot, &task_cancel, |_| {})
                .await;
        }
        let (clause_tx, mut clause_rx) = mpsc::unbounded_channel::<String>();
        let tts_client = client.clone();
        let tts_cancel = task_cancel.clone();
        let tts_progress = Arc::clone(&task_progress);
        let tts_rtp = rtp_handle.clone();

        let tts_task: JoinHandle<Result<(), VoiceError>> = tokio::spawn(Box::pin(async move {
            let mut downsampler = Downsampler24kTo8k::new();
            let mut pcm_8k_buf: Vec<i16> = Vec::new();
            let mut clause_idx = 0;

            while let Some(clause) = clause_rx.recv().await {
                if tts_cancel.is_cancelled() {
                    return Err(VoiceError::Cancelled);
                }
                let synthesis_cancel = tts_cancel.child_token();
                let mut audible = false;
                {
                    let mut guard = lock_unpoisoned(&tts_progress);
                    if guard
                        .finish_after_clause
                        .is_some_and(|last| clause_idx > last)
                    {
                        break;
                    }
                    let start_idx = guard.total_frames_enqueued;
                    guard.clauses_started.push((start_idx, clause.clone()));
                    guard.synthesizing = Some((clause_idx, synthesis_cancel.clone()));
                }

                let synthesis = tts_client
                    .synthesize_speech_pcm24k(&clause, &synthesis_cancel, |samples_24k| {
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
                            audible |= mulaw_frames.iter().any(|frame| {
                                frame.iter().any(|byte| !matches!(*byte, 0xFF | 0x7F))
                            });
                            let mut guard = lock_unpoisoned(&tts_progress);
                            if synthesis_cancel.is_cancelled()
                                || guard
                                    .finish_after_clause
                                    .is_some_and(|last| clause_idx > last)
                            {
                                return;
                            }
                            guard.total_frames_enqueued = guard
                                .total_frames_enqueued
                                .saturating_add(mulaw_frames.len());
                            tts_rtp.enqueue_pcmu_frames(mulaw_frames);
                        }
                    })
                    .await;
                {
                    let mut guard = lock_unpoisoned(&tts_progress);
                    guard.synthesizing = None;
                    if guard
                        .finish_after_clause
                        .is_some_and(|last| clause_idx > last)
                    {
                        break;
                    }
                    synthesis?;
                    if tts_cancel.is_cancelled() {
                        return Err(VoiceError::Cancelled);
                    }
                    if !pcm_8k_buf.is_empty() {
                        let mut tail_frame = [0_i16; RTP_FRAME_SAMPLES];
                        let copy_len = pcm_8k_buf.len().min(RTP_FRAME_SAMPLES);
                        tail_frame[..copy_len].copy_from_slice(&pcm_8k_buf[..copy_len]);
                        pcm_8k_buf.clear();
                        guard.total_frames_enqueued = guard.total_frames_enqueued.saturating_add(1);
                        let frame = encode_mulaw_frame_with_headroom(&tail_frame);
                        audible |= frame.iter().any(|byte| !matches!(*byte, 0xFF | 0x7F));
                        tts_rtp.enqueue_pcmu_frames(vec![frame]);
                    }
                    if !audible {
                        return Err(VoiceError::InvalidResponse {
                            endpoint: "tts_worker".to_string(),
                            reason: "speech became silent after telephone encoding".to_string(),
                        });
                    }
                    let end = guard.total_frames_enqueued;
                    guard.clauses_finished.push(end);
                    if guard.finish_after_clause == Some(clause_idx) {
                        break;
                    }
                }
                clause_idx += 1;
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

        let progress = lock_unpoisoned(&task_progress);
        let mut turn_output = turn_output;
        if progress.finish_after_clause.is_some() {
            let discarded = rtp_handle
                .outbound_playback_state()
                .discarded_frames
                .saturating_sub(progress.discarded_frames_at_start);
            turn_output.full_text = progress.spoken_text(discarded);
            turn_output.clauses = progress
                .clauses_started
                .iter()
                .map(|(_, text)| text.clone())
                .collect();
            turn_output
                .tool_calls
                .retain(|tool| matches!(tool, VoiceToolCall::WaitSilently { on_hold: true, .. }));
            turn_output.raw_tool_calls.clear();
        }
        Ok(turn_output)
    }));

    ActiveAssistantTurn {
        steer_revision: conversation.steer_revision(),
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
    shared.transcript.clear();
    shared.transcript.extend_from_slice(entries);
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

fn lock_unpoisoned<State>(mutex: &StdMutex<State>) -> std::sync::MutexGuard<'_, State> {
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
    match callee_name.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => format!("{name} ({phone_number})"),
        None => phone_number.to_string(),
    }
}

fn non_empty_kv_value(raw: &str, fallback: &str) -> String {
    bounded_kv_value(raw, fallback, MAX_KV_VALUE_BYTES)
}

fn bounded_kv_value(raw: &str, fallback: &str, max_bytes: usize) -> String {
    let (truncated, was_truncated) = truncate_utf8_bytes(raw.trim(), max_bytes);
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn build_approval_modal_surface(
    surface_id: impl Into<String>,
    thread_id: impl Into<String>,
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
            // The user approves exactly what the calling agent receives, so nothing is cut short.
            BridgeUiKeyValueItem {
                label: "Objective".to_string(),
                value: bounded_kv_value(&validated.objective, "Phone call", MAX_OBJECTIVE_BYTES),
            },
        ],
    }];

    if let Some(first_msg) = validated
        .first_message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let (bounded, _) = truncate_utf8_bytes(first_msg, MAX_FIRST_MESSAGE_BYTES);
        if !bounded.trim().is_empty() {
            blocks.push(BridgeUiBlock::Markdown {
                markdown: format!("**Opening message**\n\n{bounded}"),
            });
        }
    }

    if let Some(context) = validated
        .context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let (bounded, _) = truncate_utf8_bytes(context, MAX_CONTEXT_BYTES);
        blocks.push(BridgeUiBlock::Markdown {
            markdown: format!("**Background for the calling agent**\n\n{bounded}"),
        });
    }

    let now = Utc::now().to_rfc3339();
    BridgeUiSurface {
        id: surface_id.into(),
        thread_id: thread_id.into(),
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing UI card builder parameter bundle predates perfectionist field cap"
    )
)]
struct LiveCardParams<'a> {
    title_override: Option<&'a str>,
    subtitle: &'a str,
    status_value: &'a str,
    activity_label: Option<&'a str>,
    tone: BridgeUiTone,
    in_call_actions: bool,
    dismissible: bool,
    duration_seconds: Option<u64>,
    detail_label_value: Option<(&'a str, &'a str)>,
    /// Raw cause shown after the plain-language reason, for troubleshooting.
    technical_detail: Option<&'a str>,
    transcript: &'a [TranscriptEntry],
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn build_live_workflow_card(
    surface_id: impl Into<String>,
    thread_id: impl Into<String>,
    runtime_config: &PhoneCallRuntimeConfig,
    validated: &ValidatedStartRequest,
    created_at: impl Into<String>,
    params: LiveCardParams<'_>,
) -> BridgeUiSurface {
    let to_display =
        format_callee_display(validated.callee_name.as_deref(), &validated.phone_number);
    let default_title = match validated
        .callee_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
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

    if let Some(activity) = params
        .activity_label
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        kv_items.push(BridgeUiKeyValueItem {
            label: "Activity".to_string(),
            value: non_empty_kv_value(activity, params.status_value),
        });
    }

    if let Some(secs) = params.duration_seconds {
        kv_items.push(BridgeUiKeyValueItem {
            label: "Duration".to_string(),
            value: format_duration_mm_ss(secs),
        });
    }

    kv_items.push(BridgeUiKeyValueItem {
        label: "Objective".to_string(),
        value: bounded_kv_value(&validated.objective, "Phone call", MAX_OBJECTIVE_BYTES),
    });

    if let Some((label, val)) = params.detail_label_value {
        if !val.trim().is_empty() {
            kv_items.push(BridgeUiKeyValueItem {
                label: label.to_string(),
                value: non_empty_kv_value(val, "-"),
            });
        }
    }
    if let Some(detail) = params
        .technical_detail
        .filter(|detail| !detail.trim().is_empty())
    {
        kv_items.push(BridgeUiKeyValueItem {
            label: "Details".to_string(),
            value: non_empty_kv_value(detail, "-"),
        });
    }

    let mut blocks = vec![BridgeUiBlock::KeyValue { items: kv_items }];
    if let Some(transcript_md) = format_rolling_transcript_markdown(
        params.transcript,
        MAX_LIVE_TRANSCRIPT_BYTES,
        &transcript_recipient_label(validated.callee_name.as_deref()),
    ) {
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
        id: surface_id.into(),
        thread_id: thread_id.into(),
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
        created_at: Some(created_at.into()),
        updated_at: Some(now_iso()),
    }
}

// Speaker labels name people the way the user thinks of them; a callee name that could break
// markdown emphasis or read as a field label falls back to "Recipient".
fn transcript_recipient_label(callee_name: Option<&str>) -> String {
    callee_name
        .map(str::trim)
        .filter(|name| {
            (1..=40).contains(&name.chars().count())
                && name.chars().all(|ch| {
                    ch.is_alphanumeric() || matches!(ch, ' ' | '\'' | '.' | ',' | '&' | '-')
                })
        })
        .unwrap_or("Recipient")
        .to_string()
}

fn format_transcript_line(entry: &TranscriptEntry, markdown: bool, recipient: &str) -> String {
    let clean_text = sanitize_reserved_envelope_markers(entry.text.trim());
    let text_with_marker = if entry.interrupted && !clean_text.ends_with(INTERRUPTED_MARKER) {
        format!("{clean_text} {INTERRUPTED_MARKER}")
    } else {
        clean_text
    };

    let label = match entry.speaker {
        TranscriptSpeaker::Assistant => "Agent",
        TranscriptSpeaker::Callee => recipient,
        TranscriptSpeaker::Steer => "Instruction (not spoken)",
        TranscriptSpeaker::Event => "Event",
    };
    if markdown {
        format!("**{label}:** {text_with_marker}")
    } else {
        format!("{label}: {text_with_marker}")
    }
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn format_rolling_transcript_markdown(
    transcript: &[TranscriptEntry],
    max_bytes: usize,
    recipient: &str,
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
        let mut line = format_transcript_line(entry, true, recipient);
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
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
    let recipient = transcript_recipient_label(validated.callee_name.as_deref());
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

    if let Some(summary) = outcome_summary
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
    {
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
        let mut line = format_transcript_line(entry, false, &recipient);
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
#[path = "mod_tests.rs"]
mod tests;
