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
            RTP_FRAME_SAMPLES, VAD_MAX_UTTERANCE_SAMPLES,
        },
        sip::{SipCallEvent, SipCallHandle, SipCallSession, SipCallState, SipDialConfig, SipError},
        voice::{
            is_substantive_reply, AssistantTurnOutput, TranscriptEntry, TranscriptSpeaker,
            VoiceCallPromptParams, VoiceConversation, VoiceError, VoicePipelineClient,
            VoiceToolCall, INTERRUPTED_MARKER,
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
    on_hold: bool,
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
    validated: ValidatedStartRequest,
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
            phone_number: Some(self.validated.phone_number.clone()),
            callee_name: self.validated.callee_name.clone(),
            objective: Some(self.validated.objective.clone()),
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
        let active = lock_unpoisoned(&self.registry).active.clone();
        let Some(slot) = active else {
            return Vec::new();
        };
        if slot.skip_post_call_report.load(Ordering::Acquire) {
            return Vec::new();
        }
        let shared = lock_unpoisoned(&slot.shared);
        let (status, subtitle, tone) = match shared.status {
            PhoneCallStatus::AwaitingApproval => {
                if slot.cancel.is_cancelled() || lock_unpoisoned(&slot.approval_tx).is_none() {
                    return Vec::new();
                }
                return vec![build_approval_modal_surface(
                    &approval_surface_id(&slot.call_id),
                    &slot.owner_thread_id,
                    config,
                    &slot.validated,
                )];
            }
            PhoneCallStatus::Dialing => ("Dialing", "Dialing…", BridgeUiTone::Info),
            PhoneCallStatus::Ringing => ("Ringing", "Ringing…", BridgeUiTone::Info),
            PhoneCallStatus::InProgress => {
                let status = if shared.on_hold { "On hold" } else { "In call" };
                (status, status, BridgeUiTone::Success)
            }
            _ => return Vec::new(),
        };
        vec![build_live_workflow_card(
            &live_surface_id(&slot.call_id),
            &slot.owner_thread_id,
            config,
            &slot.validated,
            &shared.started_at_iso,
            LiveCardParams {
                title_override: None,
                subtitle,
                status_value: status,
                tone,
                in_call_actions: true,
                dismissible: false,
                duration_seconds: shared.elapsed_seconds(),
                detail_label_value: None,
                technical_detail: None,
                transcript: &shared.transcript,
            },
        )]
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
            validated: validated.clone(),
            approval_tx: StdMutex::new(Some(approval_tx)),
            steer_tx,
            cancel: call_cancel.clone(),
            end_trigger: OnceLock::new(),
            skip_post_call_report: AtomicBool::new(false),
            settled_tx,
            settled_rx,
            shared: StdMutex::new(SharedCallState {
                status: PhoneCallStatus::AwaitingApproval,
                on_hold: false,
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
        .is_some_and(|rest| rest.chars().next().is_none_or(|ch| !ch.is_alphanumeric()))
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
fn start_assistant_turn(
    ctx: &ConnectedCallContext,
    conversation: &VoiceConversation,
    sip_handle: &SipCallHandle,
    pending_end: &mut Option<PendingCallEnd>,
) -> ActiveAssistantTurn {
    *pending_end = None;
    spawn_assistant_turn(
        &ctx.voice_client,
        conversation,
        sip_handle,
        &ctx.slot.cancel,
    )
}

fn set_call_hold(slot: &ActiveCallSlot, conversation: &mut VoiceConversation, on_hold: bool) {
    conversation.set_on_hold(on_hold);
    lock_unpoisoned(&slot.shared).on_hold = on_hold;
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
    let mut pending_utterances: VecDeque<Vec<i16>> = VecDeque::new();
    let mut speech_quiet_deadline = None;
    let mut active_turn: Option<ActiveAssistantTurn> = None;
    let mut pending_end: Option<PendingCallEnd> = None;
    let mut transport_on_hold = false;

    if steer_pending_turn {
        opening_greeting_pending = false;
        opening_window_elapsed = true;
        steer_pending_turn = false;
        active_turn = Some(start_assistant_turn(
            &ctx,
            &conversation,
            &sip_handle,
            &mut pending_end,
        ));
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
                    active_turn = Some(start_assistant_turn(
                        &ctx,
                        &conversation,
                        &sip_handle,
                        &mut pending_end,
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
                if mulaw_frame_mean_abs(&frame.inbound_pcmu)
                    >= vad.speech_threshold(frame.outbound_playing, outbound_mean)
                {
                    let hangover = u32::try_from(vad.hangover_frames()).expect("VAD hangover is bounded");
                    speech_quiet_deadline = Some(tokio::time::Instant::now() + Duration::from_millis(20) * hangover);
                }
                match vad.process_mulaw_frame(
                    &frame.inbound_pcmu,
                    frame.outbound_playing,
                    outbound_mean,
                ) {
                    Some(VadEvent::BargeIn) => {
                        match active_turn.take() {
                            Some(turn) => {
                                let spoken = turn.abort_and_extract_spoken(&sip_handle);
                                conversation.record_active_assistant_interrupted(&spoken);
                                sync_shared_transcript(&ctx.slot, conversation.transcript());
                                publish_in_call_card_update(&ctx, conversation.transcript()).await;
                            }
                            None => {
                                sip_handle.clear_outbound_audio();
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
                            active_turn = Some(start_assistant_turn(
                                &ctx,
                                &conversation,
                                &sip_handle,
                                &mut pending_end,
                            ));
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
                            active_turn = Some(start_assistant_turn(
                                &ctx,
                                &conversation,
                                &sip_handle,
                                &mut pending_end,
                            ));
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

                        publish_in_call_card_update(&ctx, conversation.transcript()).await;

                        if !transport_on_hold && steer_pending_turn && active_stt.is_none() && !vad.has_pending_speech() {
                            steer_pending_turn = false;
                            active_turn = Some(start_assistant_turn(
                                &ctx,
                                &conversation,
                                &sip_handle,
                                &mut pending_end,
                            ));
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
                    active_turn = Some(start_assistant_turn(
                        &ctx,
                        &conversation,
                        &sip_handle,
                        &mut pending_end,
                    ));
                }
            }
        }
        if let Some(samples) = new_utterance {
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
        if !transport_on_hold
            && active_turn.is_none()
            && active_stt.is_none()
            && !vad.has_pending_speech()
            && (steer_pending_turn || (opening_greeting_pending && opening_window_elapsed))
        {
            steer_pending_turn = false;
            opening_greeting_pending = false;
            active_turn = Some(start_assistant_turn(
                &ctx,
                &conversation,
                &sip_handle,
                &mut pending_end,
            ));
        }
    };

    // Stop any detached STT or turn task on every exit path.
    ctx.slot.cancel.cancel();
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
    let on_hold = lock_unpoisoned(&ctx.slot.shared).on_hold;
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
        .filter(|s| !s.is_empty())
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
        .filter(|s| !s.is_empty())
    {
        let (bounded, _) = truncate_utf8_bytes(context, MAX_CONTEXT_BYTES);
        blocks.push(BridgeUiBlock::Markdown {
            markdown: format!("**Background for the calling agent**\n\n{bounded}"),
        });
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
    /// Raw cause shown after the plain-language reason, for troubleshooting.
    technical_detail: Option<&'a str>,
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

// Speaker labels name people the way the user thinks of them; a callee name that could break
// markdown emphasis or read as a field label falls back to "Recipient".
fn transcript_recipient_label(callee_name: Option<&str>) -> String {
    callee_name
        .map(str::trim)
        .filter(|name| {
            (1..=40).contains(&name.chars().count())
                && name
                    .chars()
                    .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '\'' | '.' | ',' | '&' | '-'))
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
    };
    if markdown {
        format!("**{label}:** {text_with_marker}")
    } else {
        format!("{label}: {text_with_marker}")
    }
}

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
mod tests {
    use super::*;
    use std::{
        collections::HashSet,
        net::{IpAddr, Ipv4Addr, SocketAddr},
    };

    use agent_client_protocol::v1::schema::ContentBlock;
    use axum::{
        body::Body,
        extract::{ws::Message, Multipart, State},
        http::{header::CONTENT_TYPE, StatusCode},
        response::{IntoResponse, Response},
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

    const STT_FAILURE_REPLY: &str = "<mock-stt-failure>";

    struct MockVoiceState {
        preload_delay_ms: AtomicUsize,
        preload_requests: AtomicUsize,
        preload_status: Mutex<StatusCode>,
        chat_turns: Mutex<VecDeque<Vec<Vec<u8>>>>,
        stt_replies: Mutex<VecDeque<String>>,
        stt_delay_ms: AtomicUsize,
        stt_requests: AtomicUsize,
        stt_request_fields: Mutex<Vec<std::collections::BTreeMap<String, Vec<u8>>>>,
        tts_pcm_bytes: Mutex<Vec<u8>>,
        tts_chunk_delay_ms: AtomicUsize,
        chat_requests: Mutex<Vec<Value>>,
        chat_status: Mutex<StatusCode>,
        tts_requests: Mutex<Vec<Value>>,
        tts_fail_after: AtomicUsize,
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
                preload_delay_ms: AtomicUsize::new(0),
                preload_requests: AtomicUsize::new(0),
                preload_status: Mutex::new(StatusCode::OK),
                chat_turns: Mutex::new(chat_turns.into()),
                stt_replies: Mutex::new(stt_replies.into_iter().map(ToOwned::to_owned).collect()),
                stt_delay_ms: AtomicUsize::new(0),
                stt_requests: AtomicUsize::new(0),
                stt_request_fields: Mutex::new(Vec::new()),
                tts_pcm_bytes: Mutex::new(pcm),
                tts_chunk_delay_ms: AtomicUsize::new(0),
                chat_requests: Mutex::new(Vec::new()),
                chat_status: Mutex::new(StatusCode::OK),
                tts_requests: Mutex::new(Vec::new()),
                tts_fail_after: AtomicUsize::new(usize::MAX),
            })
        }
    }

    async fn spawn_mock_voice_http(state: Arc<MockVoiceState>) -> String {
        let app = Router::new()
            .route(
                "/api/chat",
                post(|State(st): State<Arc<MockVoiceState>>| async move {
                    let delay = st.preload_delay_ms.load(Ordering::SeqCst);
                    st.preload_requests.fetch_add(1, Ordering::SeqCst);
                    let status = *st.preload_status.lock().await;
                    let body = futures_util::stream::once(async move {
                        if delay > 0 {
                            tokio::time::sleep(Duration::from_millis(
                                u64::try_from(delay).unwrap(),
                            ))
                            .await;
                        }
                        Ok::<_, std::convert::Infallible>(br#"{"done":true}"#.to_vec())
                    });
                    Response::builder()
                        .status(status)
                        .header(CONTENT_TYPE, "application/json")
                        .body(Body::from_stream(body))
                        .unwrap()
                }),
            )
            .route(
                "/v1/audio/transcriptions",
                post(
                    |State(st): State<Arc<MockVoiceState>>, mut mp: Multipart| async move {
                        let mut fields = std::collections::BTreeMap::new();
                        while let Ok(Some(field)) = mp.next_field().await {
                            let name = field.name().expect("named transcription field").to_string();
                            fields.insert(
                                name,
                                field
                                    .bytes()
                                    .await
                                    .expect("complete transcription field")
                                    .to_vec(),
                            );
                        }
                        st.stt_request_fields.lock().await.push(fields);
                        // Replies and delays are bound before the arrival is counted, so tests can
                        // change the delay for the next request once they observe this one.
                        let delay_ms = st.stt_delay_ms.load(Ordering::SeqCst);
                        let text = st.stt_replies.lock().await.pop_front().unwrap_or_default();
                        st.stt_requests.fetch_add(1, Ordering::SeqCst);
                        if delay_ms > 0 {
                            tokio::time::sleep(Duration::from_millis(
                                u64::try_from(delay_ms).unwrap_or(0),
                            ))
                            .await;
                        }
                        if text == STT_FAILURE_REPLY {
                            return (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                Json(json!({ "error": "transcriber crashed" })),
                            );
                        }
                        (StatusCode::OK, Json(json!({ "text": text })))
                    },
                ),
            )
            .route(
                "/v1/chat/completions",
                post(
                    |State(st): State<Arc<MockVoiceState>>, Json(body): Json<Value>| async move {
                        st.chat_requests.lock().await.push(body);
                        let status = *st.chat_status.lock().await;
                        if !status.is_success() {
                            return (status, Json(json!({"error":"model not found"})))
                                .into_response();
                        }
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
                post(
                    |State(st): State<Arc<MockVoiceState>>, Json(body): Json<Value>| async move {
                        st.tts_requests.lock().await.push(body);
                        if st.tts_requests.lock().await.len()
                            > st.tts_fail_after.load(Ordering::SeqCst)
                        {
                            tokio::time::sleep(Duration::from_millis(200)).await;
                            return (StatusCode::INTERNAL_SERVER_ERROR, "synthesis failed")
                                .into_response();
                        }
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
                    },
                ),
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
            user_display_name: "Alex Example".to_string(),
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

    #[derive(Debug, Clone)]
    struct MockSipDialog {
        client_sip_addr: SocketAddr,
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
                client_sip_addr,
                client_rtp_addr,
                from,
                to,
                call_id,
            }
        }

        async fn renegotiate(
            &self,
            sip: &UdpSocket,
            cseq: u32,
            method: &str,
            direction: &str,
            rtp_port: u16,
        ) -> String {
            let local = sip.local_addr().unwrap();
            let sdp = format!(
                "v=0\r\no=- 1 {cseq} IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio {rtp_port} RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\na={direction}\r\n"
            );
            let request = format!(
                "{method} sip:caller@{} SIP/2.0\r\nVia: SIP/2.0/UDP {local};branch=z9hG4bKhold{cseq}\r\nFrom: {};tag=uas1\r\nTo: {}\r\nCall-ID: {}\r\nCSeq: {cseq} {method}\r\nContact: <sip:uas@{local}>\r\nContent-Type: application/sdp\r\nContent-Length: {}\r\n\r\n{sdp}",
                self.client_sip_addr, self.to, self.from, self.call_id, sdp.len()
            );
            sip.send_to(request.as_bytes(), self.client_sip_addr)
                .await
                .unwrap();
            let mut response = [0; 4096];
            let (len, _) = timeout(TEST_TIMEOUT, sip.recv_from(&mut response))
                .await
                .unwrap()
                .unwrap();
            let response = String::from_utf8(response[..len].to_vec()).unwrap();
            assert!(response.starts_with("SIP/2.0 200 OK"), "{response}");
            if method == "INVITE" {
                let ack = request.replacen("INVITE ", "ACK ", 1).replace(
                    &format!("CSeq: {cseq} INVITE"),
                    &format!("CSeq: {cseq} ACK"),
                );
                sip.send_to(ack.as_bytes(), self.client_sip_addr)
                    .await
                    .unwrap();
            }
            response
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

        async fn send_remote_bye(&self, sip: &UdpSocket, cseq: u32) {
            let local = sip.local_addr().unwrap();
            let request = format!(
                "BYE sip:caller@{} SIP/2.0\r\nVia: SIP/2.0/UDP {local};branch=z9hG4bKbye{cseq}\r\nFrom: {};tag=uas1\r\nTo: {}\r\nCall-ID: {}\r\nCSeq: {cseq} BYE\r\nContent-Length: 0\r\n\r\n",
                self.client_sip_addr, self.to, self.from, self.call_id
            );
            sip.send_to(request.as_bytes(), self.client_sip_addr)
                .await
                .unwrap();
            let mut response = [0; 4096];
            let (len, _) = timeout(TEST_TIMEOUT, sip.recv_from(&mut response))
                .await
                .unwrap()
                .unwrap();
            let response = String::from_utf8_lossy(&response[..len]);
            assert!(response.starts_with("SIP/2.0 200 OK"), "{response}");
            assert!(
                response.contains(&format!("CSeq: {cseq} BYE")),
                "{response}"
            );
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
                Some(agent_client_protocol::v1::schema::McpServer::Http(desc)) => {
                    desc.headers[0].value.clone()
                }
                _ => String::new(),
            };
            assert!(authorization.starts_with("Bearer dcm_"));
            config
                .activate_credential(pending, thread_id)
                .expect("activate MCP credential");

            let client = crate::tls::http_client_builder()
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

    fn voice_reply(text: &str, tools: Value) -> Vec<Vec<u8>> {
        let tools = if tools.as_array().is_some_and(Vec::is_empty) && !text.trim().is_empty() {
            voice_tool(
                "wait_silently",
                json!({"reason": "Listening", "on_hold": false}),
            )
        } else {
            tools
        };
        vec![
            format!(
                "data: {}\n\n",
                json!({"choices": [{"delta": {"content": text, "tool_calls": tools}}]})
            )
            .into_bytes(),
            b"data: [DONE]\n\n".to_vec(),
        ]
    }

    fn voice_tool(name: &str, arguments: Value) -> Value {
        json!([{
            "index": 0,
            "id": format!("call_{name}"),
            "type": "function",
            "function": {"name": name, "arguments": arguments.to_string()}
        }])
    }

    #[tokio::test]
    async fn mcp_e2e_partial_reply_hold_music_resume_and_interrupted_hangup() {
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut notifications) = client_outbox(256);
        hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let (report_tx, mut reports) = mpsc::unbounded_channel();
        let queue = BridgeQueueService::with_submission_store(
            Arc::new(MockQueueDispatcher {
                captured: report_tx,
            }),
            Arc::clone(&hub),
            None,
            crate::queue_service::DurableQueueSubmissions::default(),
        );
        let end = || {
            voice_tool(
                "end_call",
                json!({
                    "reason": "Information was not provided by the recipient.",
                    "outcome_summary": "No answer"
                }),
            )
        };
        let voice = MockVoiceState::new(
            vec![
                voice_reply("", end()),
                voice_reply("Thank you, I have the address. Goodbye.", end()),
                voice_reply(
                    "Of course, I can wait.",
                    voice_tool(
                        "wait_silently",
                        json!({"reason": "Checking the address", "on_hold": true}),
                    ),
                ),
                voice_reply("Goodbye, your call is important to us.", end()),
                voice_reply(
                    "",
                    voice_tool(
                        "wait_silently",
                        json!({"reason": "Still waiting for the person", "on_hold": true}),
                    ),
                ),
                voice_reply("", voice_tool("resume_call", json!({}))),
                voice_reply("Thank you for the address. Goodbye.", end()),
                voice_reply("Go ahead, I'm listening.", json!([])),
                voice_reply("Thanks again. Goodbye.", end()),
            ],
            vec![
                "I",
                "I ...",
                "Could you please hold while I check?",
                "Your call is important to us.",
                "Thanks for holding. The address is twelve Main Street.",
                "Actually, one more thing.",
                "That is all. Goodbye.",
            ],
            2_400,
        );
        let voice_url = spawn_mock_voice_http(Arc::clone(&voice)).await;
        let sip = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let rtp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let (connected_tx, connected_rx) = oneshot::channel();
        let (bye_tx, mut bye_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let rtp_port = rtp.local_addr().unwrap().port();
        let sip_port = sip.local_addr().unwrap().port();
        let trunk_sip = Arc::clone(&sip);
        tokio::spawn(async move {
            let dialog = MockSipDialog::accept_invite(&trunk_sip, rtp_port, false, true).await;
            connected_tx.send(dialog.clone()).unwrap();
            let _ = finish_rx.await;
            dialog.expect_bye_and_reply_ok(&trunk_sip).await;
            let _ = bye_tx.send(());
        });
        let service = PhoneCallService::with_options(
            Some(sample_runtime_config(sip_port, &voice_url)),
            hub,
            Arc::downgrade(&queue),
            PhoneCallTimeouts {
                approval_timeout: Duration::from_secs(5),
                max_call_duration: Duration::from_secs(60),
                opening_greeting_wait: Duration::from_secs(20),
            },
            None,
        );
        let mcp_server = crate::agent_messaging::AgentMessagingService::start(
            Weak::new(),
            Arc::downgrade(&queue),
            crate::scheduled_prompts::ScheduledPromptService::inert_for_test(),
            Arc::clone(&service),
        )
        .await
        .unwrap();
        let owner = crate::acp::identity::AgentSessionId::new("agent", "hold-regression")
            .unwrap()
            .encode();
        let mcp = McpHttpTestClient::connect(&mcp_server.config(), "agent", &owner).await;
        let start_mcp = mcp.clone();
        let start = tokio::spawn(async move {
            start_mcp
                .call_tool_json(
                    10,
                    "start_phone_call",
                    json!({
                        "phoneNumber": "+15559876543", "objective": "Ask for the address"
                    }),
                )
                .await
        });
        let modal = recv_matching_notification(&mut notifications, |method, p| {
            method == "bridge/ui.present" && p["presentation"] == "modal"
        })
        .await;
        service
            .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                id: modal["id"].as_str().unwrap().to_string(),
                thread_id: owner.clone(),
                turn_id: None,
                action_id: "approve".to_string(),
            })
            .await;
        let started = timeout(TEST_TIMEOUT, start).await.unwrap().unwrap();
        let call_id = started["callId"].as_str().unwrap();
        let dialog = connected_rx.await.unwrap();
        let dest = dialog.client_rtp_addr;
        let mut seq = 1;
        let mut ts = 160;
        send_rtp_utterance(
            &rtp,
            dest,
            &mut seq,
            &mut ts,
            10,
            VAD_DEFAULT_HANGOVER_FRAMES + 2,
        )
        .await;
        timeout(TEST_TIMEOUT, async {
            while voice.chat_requests.lock().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let snapshot = mcp
            .call_tool_json(11, "get_phone_call", json!({"callId": call_id}))
            .await;
        assert_eq!(
            snapshot["status"], "in_progress",
            "a partial 'I' cannot end the call"
        );
        assert!(
            bye_rx.try_recv().is_err(),
            "no BYE for a tool-only end_call"
        );
        assert!(voice.tts_requests.lock().await.is_empty());
        assert!(reports.try_recv().is_err());

        send_rtp_utterance(
            &rtp,
            dest,
            &mut seq,
            &mut ts,
            10,
            VAD_DEFAULT_HANGOVER_FRAMES + 2,
        )
        .await;
        recv_matching_notification(&mut notifications, |method, p| {
            method == "bridge/ui.update" && p["blocks"].to_string().contains("I have the address")
        })
        .await;
        tokio::time::sleep(Duration::from_millis(2_200)).await;
        let snapshot = mcp
            .call_tool_json(17, "get_phone_call", json!({"callId": call_id}))
            .await;
        assert_eq!(snapshot["status"], "in_progress",
            "a model-invented goodbye cannot turn a provisional one-word reply into permission to hang up");
        assert!(bye_rx.try_recv().is_err());
        assert!(reports.try_recv().is_err());

        send_rtp_utterance(
            &rtp,
            dest,
            &mut seq,
            &mut ts,
            10,
            VAD_DEFAULT_HANGOVER_FRAMES + 2,
        )
        .await;
        let held = recv_matching_notification(&mut notifications, |method, p| {
            method == "bridge/ui.update" && p["subtitle"] == "On hold"
        })
        .await;
        assert_eq!(held["dismissible"], false);
        assert_eq!(held["actions"][0]["id"], "hangup");
        let snapshot = mcp
            .call_tool_json(12, "get_phone_call", json!({"callId": call_id}))
            .await;
        assert_eq!(snapshot["onHold"], true);
        assert_eq!(snapshot["status"], "in_progress");
        assert!(!can_retire_for_service(&service));
        let spoken_before_music = voice.tts_requests.lock().await.len();
        send_rtp_utterance(&rtp, dest, &mut seq, &mut ts, 10, 65).await;
        timeout(TEST_TIMEOUT, async {
            while voice.chat_requests.lock().await.len() < 3 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(2_200)).await;
        assert_eq!(
            voice.tts_requests.lock().await.len(),
            spoken_before_music,
            "hold announcements must not provoke speech"
        );
        assert!(
            bye_rx.try_recv().is_err(),
            "hold music cannot trigger autonomous hangup"
        );
        assert!(reports.try_recv().is_err());
        let steered = mcp.call_tool_json(16, "steer_phone_call", json!({
            "callId": call_id, "instruction": "Also ask for their opening hours when they return. Keep waiting."
        })).await;
        assert_eq!(steered["status"], "steered");
        timeout(TEST_TIMEOUT, async {
            while voice.chat_requests.lock().await.len() < 4 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(voice.tts_requests.lock().await.len(), spoken_before_music);
        let mut packet = [0; 2048];
        let (len, _) = timeout(TEST_TIMEOUT, rtp.recv_from(&mut packet))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            parse_rtp_packet(&packet[..len]).unwrap().payload_type,
            PCMU_PAYLOAD_TYPE
        );

        send_rtp_utterance(&rtp, dest, &mut seq, &mut ts, 10, 65).await;
        recv_matching_notification(&mut notifications, |method, p| {
            method == "bridge/ui.update"
                && p["subtitle"] == "In call"
                && p["blocks"]
                    .to_string()
                    .contains("Thank you for the address")
        })
        .await;
        let snapshot = mcp
            .call_tool_json(13, "get_phone_call", json!({"callId": call_id}))
            .await;
        assert_eq!(snapshot["onHold"], false);
        send_rtp_utterance(
            &rtp,
            dest,
            &mut seq,
            &mut ts,
            10,
            VAD_DEFAULT_HANGOVER_FRAMES + 2,
        )
        .await;
        recv_matching_notification(&mut notifications, |method, p| {
            method == "bridge/ui.update"
                && p["blocks"].to_string().contains("Go ahead, I'm listening")
        })
        .await;
        tokio::time::sleep(Duration::from_millis(2_200)).await;
        assert!(
            bye_rx.try_recv().is_err(),
            "resumed speech cancels the hangup grace period"
        );

        let response = dialog
            .renegotiate(&sip, 2, "INVITE", "sendonly", rtp_port)
            .await;
        assert!(response.contains("a=recvonly"));
        recv_matching_notification(&mut notifications, |method, p| {
            method == "bridge/ui.update" && p["subtitle"] == "On hold"
        })
        .await;
        let snapshot = mcp
            .call_tool_json(14, "get_phone_call", json!({"callId": call_id}))
            .await;
        assert_eq!(snapshot["onHold"], true);
        assert_eq!(snapshot["status"], "in_progress");
        assert!(!can_retire_for_service(&service));
        let response = dialog
            .renegotiate(&sip, 3, "UPDATE", "inactive", rtp_port)
            .await;
        assert!(response.contains("a=inactive"));
        let resumed_rtp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let new_port = resumed_rtp.local_addr().unwrap().port();
        let response = dialog
            .renegotiate(&sip, 4, "INVITE", "sendrecv", new_port)
            .await;
        assert!(response.contains("a=sendrecv"));
        recv_matching_notification(&mut notifications, |method, p| {
            method == "bridge/ui.update" && p["subtitle"] == "In call"
        })
        .await;
        let snapshot = mcp
            .call_tool_json(15, "get_phone_call", json!({"callId": call_id}))
            .await;
        assert_eq!(snapshot["onHold"], false);
        finish_tx.send(()).unwrap();
        send_rtp_utterance(
            &resumed_rtp,
            dest,
            &mut seq,
            &mut ts,
            10,
            VAD_DEFAULT_HANGOVER_FRAMES + 2,
        )
        .await;
        timeout(TEST_TIMEOUT, async {
            let mut packet = [0; 2048];
            loop {
                let (len, _) = resumed_rtp.recv_from(&mut packet).await.unwrap();
                if parse_rtp_packet(&packet[..len])
                    .unwrap()
                    .payload
                    .iter()
                    .any(|b| *b != 0xff)
                {
                    break;
                }
            }
        })
        .await
        .expect("resumed voice must use renegotiated RTP port");
        timeout(TEST_TIMEOUT, &mut bye_rx).await.unwrap().unwrap();
        let settled = recv_matching_notification(&mut notifications, |method, p| {
            method == "bridge/ui.update" && p["title"] == "Phone call ended"
        })
        .await;
        assert_eq!(settled["actions"], json!([]));
        assert_eq!(settled["dismissible"], true);
        timeout(TEST_TIMEOUT, reports.recv())
            .await
            .unwrap()
            .unwrap();
        timeout(TEST_TIMEOUT, async {
            while service.live_work_count() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(can_retire_for_service(&service));
        mcp_server.shutdown().await;
    }

    const CLOSING_OWNER: &str = "closing-owner";

    struct ClosingTestCall {
        service: Arc<PhoneCallService>,
        notifications: ClientOutboxReceiver,
        reports: mpsc::UnboundedReceiver<TurnStartCapture>,
        rtp: UdpSocket,
        dest: SocketAddr,
        seq: u16,
        ts: u32,
        call_id: String,
        bye_rx: oneshot::Receiver<()>,
        _queue: Arc<BridgeQueueService>,
    }

    impl ClosingTestCall {
        async fn connect(voice: &Arc<MockVoiceState>) -> Self {
            let hub = Arc::new(ClientHub::new());
            let (outbox, mut notifications) = client_outbox(256);
            hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
                .await;
            let (report_tx, reports) = mpsc::unbounded_channel();
            let queue = BridgeQueueService::with_submission_store(
                Arc::new(MockQueueDispatcher {
                    captured: report_tx,
                }),
                Arc::clone(&hub),
                None,
                crate::queue_service::DurableQueueSubmissions::default(),
            );
            let voice_url = spawn_mock_voice_http(Arc::clone(voice)).await;
            let sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let rtp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let sip_port = sip.local_addr().unwrap().port();
            let rtp_port = rtp.local_addr().unwrap().port();
            let (connected_tx, connected_rx) = oneshot::channel();
            let (bye_tx, bye_rx) = oneshot::channel();
            tokio::spawn(async move {
                let dialog = MockSipDialog::accept_invite(&sip, rtp_port, false, true).await;
                connected_tx.send(dialog.client_rtp_addr).unwrap();
                dialog.expect_bye_and_reply_ok(&sip).await;
                let _ = bye_tx.send(());
            });
            let service = PhoneCallService::with_options(
                Some(sample_runtime_config(sip_port, &voice_url)),
                hub,
                Arc::downgrade(&queue),
                PhoneCallTimeouts {
                    approval_timeout: Duration::from_secs(5),
                    max_call_duration: Duration::from_secs(60),
                    opening_greeting_wait: Duration::from_secs(20),
                },
                None,
            );
            let start_service = Arc::clone(&service);
            let start = tokio::spawn(async move {
                start_service
                    .start_phone_call(
                        CLOSING_OWNER,
                        StartPhoneCallRequest {
                            phone_number: "+15559876543".to_string(),
                            objective: "Ask for the opening hours".to_string(),
                            callee_name: None,
                            first_message: None,
                            context: None,
                        },
                    )
                    .await
            });
            let modal = recv_matching_notification(&mut notifications, |method, p| {
                method == "bridge/ui.present" && p["presentation"] == "modal"
            })
            .await;
            service
                .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                    id: modal["id"].as_str().unwrap().to_string(),
                    thread_id: CLOSING_OWNER.to_string(),
                    turn_id: None,
                    action_id: "approve".to_string(),
                })
                .await;
            let started = timeout(TEST_TIMEOUT, start)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let dest = connected_rx.await.unwrap();
            Self {
                service,
                notifications,
                reports,
                rtp,
                dest,
                seq: 1,
                ts: 160,
                call_id: started.call_id,
                bye_rx,
                _queue: queue,
            }
        }

        async fn callee_speaks(&mut self) {
            send_rtp_utterance(
                &self.rtp,
                self.dest,
                &mut self.seq,
                &mut self.ts,
                10,
                VAD_DEFAULT_HANGOVER_FRAMES + 2,
            )
            .await;
        }

        async fn card_shows(&mut self, text: &str) {
            recv_matching_notification(&mut self.notifications, |method, p| {
                method == "bridge/ui.update" && p["blocks"].to_string().contains(text)
            })
            .await;
        }

        async fn expect_settled_report(&mut self, expected: &[&str]) {
            timeout(TEST_TIMEOUT, &mut self.bye_rx)
                .await
                .expect("the accepted closing sends BYE")
                .unwrap();
            let report = timeout(TEST_TIMEOUT, self.reports.recv())
                .await
                .unwrap()
                .unwrap()
                .turn_start
                .to_string();
            for text in expected {
                assert!(report.contains(text), "{text:?} missing from {report}");
            }
            timeout(TEST_TIMEOUT, async {
                while self.service.live_work_count() != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }

    fn closing_end_call(reason: &str) -> Value {
        voice_tool(
            "end_call",
            json!({"reason": reason, "outcome_summary": "Open until nine"}),
        )
    }

    #[tokio::test]
    async fn steer_during_closing_turn_cancels_its_hangup_and_plays_the_steered_turn() {
        let voice = MockVoiceState::new(
            vec![
                voice_reply(
                    "Great, thank you. Goodbye.",
                    closing_end_call("Got the opening hours"),
                ),
                voice_reply("One more question: do you take reservations?", json!([])),
                voice_reply(
                    "Perfect, thanks. Goodbye.",
                    closing_end_call("Got hours and reservations"),
                ),
            ],
            vec![
                "We are open until nine tonight.",
                "Yes, we take reservations.",
            ],
            4_800,
        );
        let mut call = ClosingTestCall::connect(&voice).await;
        call.callee_speaks().await;
        timeout(TEST_TIMEOUT, async {
            while voice.tts_requests.lock().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        call.service
            .steer_phone_call(
                CLOSING_OWNER,
                &call.call_id,
                "Also ask whether they take reservations.",
            )
            .unwrap();
        call.card_shows("do you take reservations").await;
        tokio::time::sleep(END_CALL_QUIET_GRACE + Duration::from_millis(500)).await;
        assert!(
            call.bye_rx.try_recv().is_err(),
            "a steer during the closing turn cancels its hang-up"
        );
        let snapshot = call
            .service
            .get_phone_call(CLOSING_OWNER, &call.call_id)
            .unwrap();
        assert_eq!(snapshot.status, PhoneCallStatus::InProgress);
        let steered_request = voice.chat_requests.lock().await[1]["messages"].to_string();
        assert!(
            !steered_request.contains("\"name\":\"end_call\"")
                && steered_request.contains("Also ask whether they take reservations."),
            "{steered_request}"
        );

        call.callee_speaks().await;
        call.expect_settled_report(&["End reason: Got hours and reservations"])
            .await;
    }

    #[tokio::test]
    async fn short_goodbye_or_noise_after_spoken_closing_still_hangs_up() {
        for confirmation in ["Bye.", ""] {
            let voice = MockVoiceState::new(
                vec![
                    voice_reply(
                        "Great, thank you. Goodbye.",
                        closing_end_call("Got the opening hours"),
                    ),
                    voice_reply("Are you still there?", json!([])),
                ],
                vec!["We are open until nine tonight.", confirmation],
                4_800,
            );
            let mut call = ClosingTestCall::connect(&voice).await;
            call.callee_speaks().await;
            call.card_shows("Great, thank you. Goodbye.").await;
            call.callee_speaks().await;
            let transcript = format!("Recipient: {confirmation}");
            let mut expected = vec!["End reason: Got the opening hours"];
            if !confirmation.is_empty() {
                expected.push(&transcript);
            }
            call.expect_settled_report(&expected).await;
            assert_eq!(
                voice.chat_requests.lock().await.len(),
                1,
                "{confirmation:?} confirms the closing instead of reopening the conversation"
            );
        }
    }

    #[tokio::test]
    async fn held_call_preserves_mobile_hangup_and_maximum_duration() {
        for manual_hangup in [true, false] {
            let hub = Arc::new(ClientHub::new());
            let (outbox, mut notifications) = client_outbox(64);
            hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
                .await;
            let (report_tx, mut reports) = mpsc::unbounded_channel();
            let queue = BridgeQueueService::with_submission_store(
                Arc::new(MockQueueDispatcher {
                    captured: report_tx,
                }),
                Arc::clone(&hub),
                None,
                crate::queue_service::DurableQueueSubmissions::default(),
            );
            let voice = MockVoiceState::new(
                vec![voice_reply(
                    "",
                    voice_tool(
                        "wait_silently",
                        json!({"reason": "Waiting on hold", "on_hold": true}),
                    ),
                )],
                vec![],
                480,
            );
            let voice_url = spawn_mock_voice_http(voice).await;
            let sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let rtp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let sip_port = sip.local_addr().unwrap().port();
            let rtp_port = rtp.local_addr().unwrap().port();
            let trunk = tokio::spawn(async move {
                let dialog = MockSipDialog::accept_invite(&sip, rtp_port, false, false).await;
                dialog.expect_bye_and_reply_ok(&sip).await;
            });
            let service = PhoneCallService::with_options(
                Some(sample_runtime_config(sip_port, &voice_url)),
                hub,
                Arc::downgrade(&queue),
                PhoneCallTimeouts {
                    approval_timeout: Duration::from_secs(5),
                    max_call_duration: Duration::from_secs(1),
                    opening_greeting_wait: Duration::from_millis(20),
                },
                None,
            );
            let start_service = Arc::clone(&service);
            let start = tokio::spawn(async move {
                start_service
                    .start_phone_call(
                        "held-owner",
                        StartPhoneCallRequest {
                            phone_number: "+15559876543".to_string(),
                            objective: "Check opening hours".to_string(),
                            callee_name: None,
                            first_message: None,
                            context: None,
                        },
                    )
                    .await
            });
            let modal = recv_matching_notification(&mut notifications, |method, p| {
                method == "bridge/ui.present" && p["presentation"] == "modal"
            })
            .await;
            service
                .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                    id: modal["id"].as_str().unwrap().to_string(),
                    thread_id: "held-owner".to_string(),
                    turn_id: None,
                    action_id: "approve".to_string(),
                })
                .await;
            let started = timeout(TEST_TIMEOUT, start)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let held = recv_matching_notification(&mut notifications, |method, p| {
                method == "bridge/ui.update" && p["subtitle"] == "On hold"
            })
            .await;
            assert_eq!(held["dismissible"], false);
            assert_eq!(held["actions"][0]["id"], "hangup");
            let snapshot = service
                .get_phone_call("held-owner", &started.call_id)
                .unwrap();
            assert!(snapshot.on_hold);
            assert_eq!(snapshot.status, PhoneCallStatus::InProgress);
            assert!(!can_retire_for_service(&service));
            assert!(reports.try_recv().is_err());
            if manual_hangup {
                service
                    .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                        id: held["id"].as_str().unwrap().to_string(),
                        thread_id: "held-owner".to_string(),
                        turn_id: None,
                        action_id: "hangup".to_string(),
                    })
                    .await;
            }
            timeout(TEST_TIMEOUT, trunk).await.unwrap().unwrap();
            let settled = recv_matching_notification(&mut notifications, |method, p| {
                method == "bridge/ui.update" && p["title"] == "Phone call ended"
            })
            .await;
            assert_eq!(settled["actions"], json!([]));
            assert_eq!(settled["dismissible"], true);
            let report = timeout(TEST_TIMEOUT, reports.recv())
                .await
                .unwrap()
                .unwrap();
            let reason = if manual_hangup {
                "mobile_hangup"
            } else {
                "max_duration_reached"
            };
            assert!(report.turn_start.to_string().contains(reason));
            timeout(TEST_TIMEOUT, async {
                while service.live_work_count() != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            let snapshot = service
                .get_phone_call("held-owner", &started.call_id)
                .unwrap();
            assert!(!snapshot.on_hold);
            assert_eq!(snapshot.status, PhoneCallStatus::Completed);
            assert!(can_retire_for_service(&service));
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
            b"data: {\"choices\":[{\"delta\":{\"content\":\"Hi, I am an AI assistant calling for Alex Example.\"}}]}\n\n".to_vec(),
            b"data: {\"choices\":[{\"delta\":{\"content\":\" I would like to reserve a table for four tonight.\"}}]}\n\n".to_vec(),
            format!("data: {}\n\n", json!({"choices":[{"delta":{"tool_calls":voice_tool("wait_silently",json!({"on_hold":false}))}}]})).into_bytes(),
            b"data: [DONE]\n\n".to_vec(),
        ];
        let turn2_sse = vec![
            b"data: {\"choices\":[{\"delta\":{\"content\":\"Pressing one now.\"}}]}\n\n".to_vec(),
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"tc_dtmf\",\"type\":\"function\",\"function\":{\"name\":\"send_dtmf\",\"arguments\":\"{\\\"digits\\\":\\\"1\\\"}\"}},{\"index\":1,\"id\":\"tc_wait\",\"type\":\"function\",\"function\":{\"name\":\"wait_silently\",\"arguments\":\"{\\\"reason\\\":\\\"IVR menu\\\"}\"}}]}}]}\n\n".to_vec(),
            b"data: [DONE]\n\n".to_vec(),
        ];
        let turn3_sse = vec![
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"tc_end\",\"type\":\"function\",\"function\":{\"name\":\"phone_turn\",\"arguments\":\"{\\\"decision\\\":\\\"end_call\\\",\\\"reason\\\":\\\"reservation_confirmed\\\",\\\"outcome_summary\\\":\\\"Booked patio table for four at 7:45 PM\\\",\\\"speech\\\":\\\"Confirmed for seven forty-five p m on the patio, thank you!\\\",\\\"digits\\\":\\\"\\\",\\\"on_hold\\\":false}\"}}]}}]}\n\n".to_vec(),
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
        assert!(report_text.contains("Instruction (not spoken): Ask for the heated patio."));

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
                technical_detail: None,
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
            b"data: {\"choices\":[{\"delta\":{\"content\":\"Hi, I am an AI assistant calling for Alex Example to book dinner for four.\"}}]}\n\n".to_vec(),
            format!("data: {}\n\n", json!({"choices":[{"delta":{"tool_calls":voice_tool("wait_silently",json!({"on_hold":false}))}}]})).into_bytes(),
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
                                "**Osteria Bella:** Hello, Osteria Bella, press 2 for the patio host.",
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
                        b["markdown"]
                            .as_str()
                            .is_some_and(|md| md.contains("**Agent:** Hi, I am an AI assistant"))
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
                            md.contains("**Instruction (not spoken):** Press 2 now and confirm 7:45 PM for four.")
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
        assert!(report_text
            .contains("Instruction (not spoken): Press 2 now and confirm 7:45 PM for four."));

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

    fn parking_request() -> StartPhoneCallRequest {
        StartPhoneCallRequest {
            phone_number: "+15559876543".to_string(),
            objective: "Ask about parking".to_string(),
            callee_name: None,
            first_message: None,
            context: None,
        }
    }

    fn ui_action(id: &str, thread_id: &str, action_id: &str) -> ResolveBridgeUiSurfaceRequest {
        ResolveBridgeUiSurfaceRequest {
            id: id.to_string(),
            thread_id: thread_id.to_string(),
            turn_id: None,
            action_id: action_id.to_string(),
        }
    }

    fn approval_timeouts(approval_timeout: Duration) -> PhoneCallTimeouts {
        PhoneCallTimeouts {
            approval_timeout,
            max_call_duration: Duration::from_secs(30),
            opening_greeting_wait: Duration::from_secs(5),
        }
    }

    async fn await_approval_call_id(rx: &mut ClientOutboxReceiver) -> String {
        let modal = recv_matching_notification(rx, |method, params| {
            method == "bridge/ui.present" && params["presentation"] == "modal"
        })
        .await;
        modal["id"]
            .as_str()
            .and_then(|id| id.strip_prefix("phone-call-approval:"))
            .expect("approval surface id")
            .to_string()
    }

    async fn stt_requests_reach(voice: &MockVoiceState, count: usize) {
        timeout(TEST_TIMEOUT, async {
            while voice.stt_requests.load(Ordering::SeqCst) < count {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("transcription request reaches the mock");
    }

    async fn chat_requests_reach(voice: &MockVoiceState, count: usize) {
        timeout(TEST_TIMEOUT, async {
            while voice.chat_requests.lock().await.len() < count {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("assistant turn request reaches the mock");
    }

    fn voice_tools(calls: &[(&str, Value)]) -> Value {
        Value::Array(
            calls
                .iter()
                .enumerate()
                .map(|(index, (name, arguments))| {
                    json!({
                        "index": index,
                        "id": format!("call_{name}_{index}"),
                        "type": "function",
                        "function": {"name": name, "arguments": arguments.to_string()}
                    })
                })
                .collect(),
        )
    }

    const TRUNK_OWNER: &str = "trunk-owner";
    const SLOW_GREETING: &str = "Hello, I am calling about your opening hours today.";

    struct TrunkCallOptions {
        timeouts: PhoneCallTimeouts,
        include_dtmf: bool,
        report_queue: bool,
        pre_connect_steer: Option<&'static str>,
        sip_username: Option<&'static str>,
        custom_tls: Option<Arc<rustls::ClientConfig>>,
        voice_config: Option<VoicePipelineConfig>,
        objective: Option<&'static str>,
        connect_timeout: Duration,
    }

    impl TrunkCallOptions {
        fn new(opening_greeting_wait: Duration, max_call_duration: Duration) -> Self {
            Self {
                timeouts: PhoneCallTimeouts {
                    approval_timeout: Duration::from_secs(5),
                    max_call_duration,
                    opening_greeting_wait,
                },
                include_dtmf: true,
                report_queue: true,
                pre_connect_steer: None,
                sip_username: None,
                custom_tls: None,
                voice_config: None,
                objective: None,
                connect_timeout: TEST_TIMEOUT,
            }
        }
    }

    // A connected call whose trunk side is driven step by step by the test.
    struct TrunkCall {
        service: Arc<PhoneCallService>,
        notifications: ClientOutboxReceiver,
        reports: mpsc::UnboundedReceiver<TurnStartCapture>,
        sip: Arc<UdpSocket>,
        rtp: UdpSocket,
        rtp_port: u16,
        dialog: MockSipDialog,
        seq: u16,
        ts: u32,
        call_id: String,
        _queue: Arc<BridgeQueueService>,
    }

    impl TrunkCall {
        async fn connect(voice: &Arc<MockVoiceState>, options: TrunkCallOptions) -> Self {
            let connect_timeout = options.connect_timeout;
            let hub = Arc::new(ClientHub::new());
            let (outbox, mut notifications) = client_outbox(256);
            hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
                .await;
            let (report_tx, reports) = mpsc::unbounded_channel();
            let queue = BridgeQueueService::with_submission_store(
                Arc::new(MockQueueDispatcher {
                    captured: report_tx,
                }),
                Arc::clone(&hub),
                None,
                crate::queue_service::DurableQueueSubmissions::default(),
            );
            let voice_url = spawn_mock_voice_http(Arc::clone(voice)).await;
            let sip = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
            let rtp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let sip_port = sip.local_addr().unwrap().port();
            let rtp_port = rtp.local_addr().unwrap().port();
            let mut config = sample_runtime_config(sip_port, &voice_url);
            if let Some(voice_config) = options.voice_config {
                config.voice = voice_config;
            }
            if let Some(username) = options.sip_username {
                config.sip_username = username.to_string();
            }
            let report_queue = if options.report_queue {
                Arc::downgrade(&queue)
            } else {
                Weak::new()
            };
            let service = PhoneCallService::with_options(
                Some(config),
                hub,
                report_queue,
                options.timeouts,
                options.custom_tls,
            );
            let trunk_sip = Arc::clone(&sip);
            let include_dtmf = options.include_dtmf;
            let accept = tokio::spawn(async move {
                MockSipDialog::accept_invite(&trunk_sip, rtp_port, false, include_dtmf).await
            });
            let start_service = Arc::clone(&service);
            let objective = options
                .objective
                .unwrap_or("Ask for the opening hours")
                .to_string();
            let start = tokio::spawn(async move {
                start_service
                    .start_phone_call(
                        TRUNK_OWNER,
                        StartPhoneCallRequest {
                            phone_number: "+15559876543".to_string(),
                            objective,
                            callee_name: Some("Corner Bistro".to_string()),
                            first_message: None,
                            context: None,
                        },
                    )
                    .await
            });
            let call_id = await_approval_call_id(&mut notifications).await;
            if let Some(instruction) = options.pre_connect_steer {
                assert_eq!(
                    service
                        .steer_phone_call(TRUNK_OWNER, &call_id, instruction)
                        .unwrap()
                        .status,
                    SteerPhoneCallStatus::Steered
                );
            }
            service
                .resolve_ui_action(&ui_action(
                    &approval_surface_id(&call_id),
                    TRUNK_OWNER,
                    "approve",
                ))
                .await;
            let started = timeout(connect_timeout, start)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(started.call_id, call_id);
            let dialog = timeout(connect_timeout, accept).await.unwrap().unwrap();
            Self {
                service,
                notifications,
                reports,
                sip,
                rtp,
                rtp_port,
                dialog,
                seq: 1,
                ts: 160,
                call_id,
                _queue: queue,
            }
        }

        async fn callee_speaks(&mut self, silence_frames: usize) {
            send_rtp_utterance(
                &self.rtp,
                self.dialog.client_rtp_addr,
                &mut self.seq,
                &mut self.ts,
                10,
                silence_frames,
            )
            .await;
        }

        async fn update_matching<F>(&mut self, mut predicate: F) -> Value
        where
            F: FnMut(&Value) -> bool,
        {
            recv_matching_notification(&mut self.notifications, |method, params| {
                method == "bridge/ui.update" && predicate(params)
            })
            .await
        }

        async fn card_shows(&mut self, text: &str) {
            self.update_matching(|params| params["blocks"].to_string().contains(text))
                .await;
        }

        async fn assistant_audio_reaches_trunk(&self) {
            timeout(TEST_TIMEOUT, async {
                let mut packet = [0_u8; 2048];
                loop {
                    let (len, _) = self.rtp.recv_from(&mut packet).await.unwrap();
                    if parse_rtp_packet(&packet[..len]).is_some_and(|pkt| {
                        pkt.payload_type == PCMU_PAYLOAD_TYPE
                            && pkt.payload.iter().any(|byte| *byte != 0xFF)
                    }) {
                        return;
                    }
                }
            })
            .await
            .expect("assistant speech reaches the trunk");
        }

        // Returns the payload type of every non-silent packet until outbound audio stays quiet.
        async fn outbound_audio_goes_quiet(&self) -> Vec<u8> {
            timeout(TEST_TIMEOUT, async {
                let mut packet = [0_u8; 2048];
                let mut voiced_payload_types = Vec::new();
                let mut quiet_run = 0_usize;
                loop {
                    let (len, _) = self.rtp.recv_from(&mut packet).await.unwrap();
                    let Some(pkt) = parse_rtp_packet(&packet[..len]) else {
                        continue;
                    };
                    if pkt.payload_type != PCMU_PAYLOAD_TYPE
                        || pkt.payload.iter().any(|byte| *byte != 0xFF)
                    {
                        voiced_payload_types.push(pkt.payload_type);
                        quiet_run = 0;
                    } else if !voiced_payload_types.is_empty() {
                        quiet_run = quiet_run.saturating_add(1);
                        if quiet_run >= 15 {
                            return voiced_payload_types;
                        }
                    }
                }
            })
            .await
            .expect("outbound audio drains")
        }

        async fn agent_hangup(&self) -> HangupPhoneCallResult {
            let (result, ()) = timeout(TEST_TIMEOUT, async {
                tokio::join!(
                    self.service.hangup_phone_call(TRUNK_OWNER, &self.call_id),
                    self.dialog.expect_bye_and_reply_ok(&self.sip)
                )
            })
            .await
            .expect("agent hang-up completes");
            result.unwrap()
        }

        fn snapshot(&self) -> PhoneCallSnapshot {
            self.service
                .get_phone_call(TRUNK_OWNER, &self.call_id)
                .unwrap()
        }

        async fn settled(&self) -> PhoneCallSnapshot {
            timeout(TEST_TIMEOUT, async {
                while self.service.live_work_count() != 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("call settles");
            self.snapshot()
        }

        async fn report(&mut self) -> String {
            let report = timeout(TEST_TIMEOUT, self.reports.recv())
                .await
                .expect("post-call report")
                .expect("report channel open");
            report.turn_start["input"][0]["text"]
                .as_str()
                .expect("report text")
                .to_string()
        }
    }

    #[cfg(feature = "e2e-agent")]
    include!("full_audio_tests.rs");

    #[test]
    fn spoken_text_reports_only_clauses_that_reached_the_wire() {
        let progress =
            |clauses: &[(usize, &str)], total_frames_enqueued: usize| SpokenTurnProgress {
                clauses_started: clauses
                    .iter()
                    .map(|(start, clause)| (*start, (*clause).to_string()))
                    .collect(),
                clauses_finished: clauses
                    .iter()
                    .enumerate()
                    .map(|(idx, _)| {
                        clauses
                            .get(idx + 1)
                            .map_or(total_frames_enqueued, |(start, _)| *start)
                    })
                    .collect(),
                total_frames_enqueued,
                ..SpokenTurnProgress::default()
            };
        let two_clauses = [(0, "Hello there."), (10, "How are you?")];
        for (turn, cleared_frames, expected) in [
            (progress(&[], 25), 0, ""),
            (progress(&two_clauses, 20), 0, "Hello there. How are you?"),
            (progress(&two_clauses, 20), 10, "Hello there."),
            (
                progress(&two_clauses, 20),
                15,
                "[partially spoken sentence]",
            ),
            (progress(&two_clauses, 20), 20, ""),
            (progress(&two_clauses[..1], 0), 0, ""),
        ] {
            assert_eq!(
                turn.spoken_text(cleared_frames),
                expected,
                "{turn:?} with {cleared_frames} cleared frames"
            );
        }
    }

    #[test]
    fn request_validators_reject_malformed_fields_and_drop_blank_optionals() {
        let request = |objective: &str,
                       callee_name: Option<&str>,
                       first_message: Option<&str>,
                       context: Option<&str>| StartPhoneCallRequest {
            phone_number: "+15559876543".to_string(),
            objective: objective.to_string(),
            callee_name: callee_name.map(ToOwned::to_owned),
            first_message: first_message.map(ToOwned::to_owned),
            context: context.map(ToOwned::to_owned),
        };
        for (invalid, field) in [
            (request("Ask\0hours", None, None, None), "objective"),
            (
                request("Ask", Some("Front\ndesk"), None, None),
                "calleeName",
            ),
            (request("Ask", None, Some("Hi\0"), None), "firstMessage"),
            (request("Ask", None, None, Some("Notes\0")), "context"),
        ] {
            match validate_start_request(invalid) {
                Err(PhoneCallError::Invalid(message)) => {
                    assert!(message.starts_with(field), "{message}");
                }
                other => panic!("{field} must be rejected, got {other:?}"),
            }
        }
        let normalized = validate_start_request(request(
            "  Ask about parking  ",
            Some("   "),
            Some(" \n "),
            Some("\t"),
        ))
        .unwrap();
        assert_eq!(normalized.objective, "Ask about parking");
        assert_eq!(normalized.callee_name, None);
        assert_eq!(normalized.first_message, None);
        assert_eq!(normalized.context, None);

        let long_call_id = "c".repeat(MAX_CALL_ID_BYTES + 1);
        for invalid in ["", "   ", long_call_id.as_str(), "call\u{7}id"] {
            assert!(
                matches!(validate_call_id(invalid), Err(PhoneCallError::Invalid(_))),
                "{invalid:?}"
            );
        }
        assert_eq!(validate_call_id("  call-123  ").unwrap(), "call-123");

        let long_instruction = "s".repeat(MAX_STEER_INSTRUCTION_BYTES + 1);
        for invalid in [long_instruction.as_str(), "Say\0this", " \n\t "] {
            assert!(
                matches!(
                    validate_steer_instruction(invalid),
                    Err(PhoneCallError::Invalid(_))
                ),
                "{invalid:?}"
            );
        }
        assert_eq!(
            validate_steer_instruction("  Ask about parking. ").unwrap(),
            "Ask about parking."
        );
    }

    #[test]
    fn cards_transcripts_and_reports_bound_blank_oversized_and_interrupted_content() {
        let entry = |speaker, text: &str, interrupted| TranscriptEntry {
            speaker,
            text: text.to_string(),
            interrupted,
        };

        let bounded = non_empty_kv_value(&"é".repeat(MAX_KV_VALUE_BYTES), "-");
        assert!(bounded.ends_with('…'), "{bounded}");
        assert!(bounded.len() <= MAX_KV_VALUE_BYTES + '…'.len_utf8());
        assert_eq!(non_empty_kv_value(" \t ", "fallback"), "fallback");

        let mut cfg = sample_runtime_config(5060, "http://127.0.0.1:9/v1");
        cfg.user_display_name = "  ".to_string();
        let validated = ValidatedStartRequest {
            phone_number: "+15559876543".to_string(),
            objective: "Ask about parking".to_string(),
            callee_name: Some("  ".to_string()),
            first_message: Some("Hi, this is a quick question.".to_string()),
            context: None,
        };
        let modal =
            build_approval_modal_surface("phone-call-approval:x", "thread-1", &cfg, &validated);
        validate_bridge_ui_surface(&modal).unwrap();
        assert_eq!(modal.subtitle.as_deref(), Some("+15559876543"));
        let BridgeUiBlock::KeyValue { items } = &modal.blocks[0] else {
            panic!("approval modal starts with key-value details");
        };
        assert!(items
            .iter()
            .any(|item| item.label == "On behalf of" && item.value == "User"));
        assert!(matches!(
            &modal.blocks[1],
            BridgeUiBlock::Markdown { markdown }
                if markdown == "**Opening message**\n\nHi, this is a quick question."
        ));

        let full_scope = ValidatedStartRequest {
            objective: "o".repeat(MAX_OBJECTIVE_BYTES),
            context: Some(
                "  Account reference EXAMPLE-001; contact Example Support.  ".to_string(),
            ),
            ..validated.clone()
        };
        let modal =
            build_approval_modal_surface("phone-call-approval:y", "thread-1", &cfg, &full_scope);
        validate_bridge_ui_surface(&modal).unwrap();
        let BridgeUiBlock::KeyValue { items } = &modal.blocks[0] else {
            panic!("approval modal starts with key-value details");
        };
        assert!(
            items
                .iter()
                .any(|item| item.label == "Objective" && item.value == full_scope.objective),
            "the user approves the whole objective the calling agent receives"
        );
        assert!(matches!(
            modal.blocks.last(),
            Some(BridgeUiBlock::Markdown { markdown })
                if markdown == "**Background for the calling agent**\n\nAccount reference EXAMPLE-001; contact Example Support."
        ));

        let card = build_live_workflow_card(
            "phone-call-live:x",
            "thread-1",
            &cfg,
            &validated,
            "2026-11-12T00:00:00Z",
            LiveCardParams {
                title_override: None,
                subtitle: "Dialing…",
                status_value: "  ",
                tone: BridgeUiTone::Info,
                in_call_actions: true,
                dismissible: false,
                duration_seconds: None,
                detail_label_value: Some(("Reason", "   ")),
                technical_detail: None,
                transcript: &[],
            },
        );
        validate_bridge_ui_surface(&card).unwrap();
        assert_eq!(card.title, "Phone call · +15559876543");
        assert_eq!(card.blocks.len(), 1, "an empty transcript adds no block");
        let BridgeUiBlock::KeyValue { items } = &card.blocks[0] else {
            panic!("live card starts with key-value details");
        };
        let labels: Vec<&str> = items.iter().map(|item| item.label.as_str()).collect();
        assert_eq!(labels, ["Status", "To", "From", "Objective"]);
        assert_eq!(items[0].value, "Active");
        assert_eq!(card.actions[0].id, "hangup");

        let interrupted = entry(TranscriptSpeaker::Assistant, "Hello there", true);
        assert_eq!(
            format_transcript_line(&interrupted, true, "Recipient"),
            "**Agent:** Hello there [interrupted]"
        );
        assert_eq!(
            format_transcript_line(&interrupted, false, "Recipient"),
            "Agent: Hello there [interrupted]"
        );
        let already_marked = entry(
            TranscriptSpeaker::Assistant,
            "Hello there [interrupted]",
            true,
        );
        assert_eq!(
            format_transcript_line(&already_marked, false, "Recipient"),
            "Agent: Hello there [interrupted]"
        );
        let steer = entry(TranscriptSpeaker::Steer, "Ask about parking.", false);
        assert_eq!(
            format_transcript_line(&steer, true, "Recipient"),
            "**Instruction (not spoken):** Ask about parking."
        );
        for (callee_name, label) in [
            (Some("  Osteria Bella "), "Osteria Bella"),
            (Some("Dr. O'Neil & Co."), "Dr. O'Neil & Co."),
            (Some("**Bold**"), "Recipient"),
            (Some("Status: urgent"), "Recipient"),
            (
                Some("A very long business name that keeps going on"),
                "Recipient",
            ),
            (None, "Recipient"),
        ] {
            assert_eq!(transcript_recipient_label(callee_name), label);
        }

        let short = entry(TranscriptSpeaker::Callee, "We open at nine.", false);
        let huge = entry(
            TranscriptSpeaker::Assistant,
            &format!("start {}end", "€".repeat(200)),
            false,
        );
        assert_eq!(
            format_rolling_transcript_markdown(&[], 4_096, "Recipient"),
            None
        );
        assert_eq!(
            format_rolling_transcript_markdown(std::slice::from_ref(&short), 63, "Recipient"),
            None
        );
        let only_huge =
            format_rolling_transcript_markdown(std::slice::from_ref(&huge), 200, "Recipient")
                .unwrap();
        assert!(
            only_huge.starts_with("**Live transcript**\n\n…") && only_huge.ends_with("€end"),
            "{only_huge}"
        );
        assert!(!only_huge.contains("omitted") && only_huge.len() <= 200);
        let newest_huge =
            format_rolling_transcript_markdown(&[short.clone(), huge.clone()], 200, "Recipient")
                .unwrap();
        assert!(newest_huge.contains("_Earlier turns omitted…_\n\n…"));
        assert!(!newest_huge.contains("We open at nine."));
        assert_eq!(
            format_rolling_transcript_markdown(&[huge.clone(), short.clone()], 200, "Recipient")
                .unwrap(),
            "**Live transcript**\n\n_Earlier turns omitted…_\n\n**Recipient:** We open at nine."
        );

        assert_eq!(truncate_utf8_tail("abc", 3), "abc");
        assert_eq!(truncate_utf8_tail("aé€", 4), "€");
        assert_eq!(truncate_utf8_tail("aé€", 2), "");

        let report = |end_reason: &str, transcript: &[TranscriptEntry]| {
            build_post_call_report_content(
                "call-1",
                PhoneCallStatus::Completed,
                &validated,
                65,
                end_reason,
                Some("  "),
                transcript,
            )
        };
        let empty = report("remote_bye", &[]);
        assert!(empty.contains("Duration: 1:05 (65s)"));
        assert!(!empty.contains("Outcome summary"));
        assert!(empty.ends_with("Transcript:\n(no spoken transcript recorded)"));
        let oversized_reason = "r".repeat(MAX_REPORT_BODY_BYTES);
        let no_budget = report(&oversized_reason, std::slice::from_ref(&short));
        assert!(no_budget.ends_with("Transcript:\n(no spoken transcript recorded)"));

        let giant = entry(
            TranscriptSpeaker::Callee,
            &"word ".repeat(MAX_REPORT_BODY_BYTES / 4),
            false,
        );
        let giant_only = report("remote_bye", std::slice::from_ref(&giant));
        assert!(giant_only.contains("Transcript:\n…") && giant_only.ends_with("word word"));
        assert!(!giant_only.contains("[earlier transcript omitted]"));
        assert!(giant_only.len() <= MAX_REPORT_BODY_BYTES);
        let newest_giant = report("remote_bye", &[short.clone(), giant.clone()]);
        assert!(newest_giant.contains("Transcript:\n[earlier transcript omitted]\n…"));
        assert!(!newest_giant.contains("We open at nine."));
        assert!(report("remote_bye", &[giant, short])
            .ends_with("Transcript:\n[earlier transcript omitted]\nRecipient: We open at nine."));
    }

    #[tokio::test]
    async fn snapshot_surfaces_restores_pending_approval_without_republishing_it() {
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut notifications) = client_outbox(128);
        hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let service = PhoneCallService::with_options(
            Some(sample_runtime_config(
                sip.local_addr().unwrap().port(),
                "http://127.0.0.1:9/v1",
            )),
            hub,
            Weak::new(),
            approval_timeouts(Duration::from_secs(5)),
            None,
        );
        let starting = Arc::clone(&service);
        let start = tokio::spawn(async move {
            starting
                .start_phone_call(
                    "snapshot-owner",
                    StartPhoneCallRequest {
                        context: Some("Ask about weekend hours too.".to_string()),
                        first_message: Some("Hello, I am calling about your hours.".to_string()),
                        ..parking_request()
                    },
                )
                .await
        });
        let call_id = await_approval_call_id(&mut notifications).await;
        let surfaces = service.snapshot_surfaces();
        assert_eq!(surfaces.len(), 1);
        validate_bridge_ui_surface(&surfaces[0]).unwrap();
        assert_eq!(surfaces[0].id, approval_surface_id(&call_id));
        assert_eq!(surfaces[0].thread_id, "snapshot-owner");
        assert!(surfaces[0]
            .actions
            .iter()
            .any(|action| action.id == "approve"));
        assert!(surfaces[0].blocks.iter().any(|block| matches!(
            block, BridgeUiBlock::Markdown { markdown } if markdown.contains("Ask about weekend hours too.")
        )));
        assert!(
            notifications.try_recv().is_err(),
            "snapshot reads must not publish new events"
        );
        service
            .resolve_ui_action(&ui_action(&surfaces[0].id, "snapshot-owner", "cancel"))
            .await;
        timeout(TEST_TIMEOUT, start)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(service.snapshot_surfaces().is_empty());
        assert_eq!(service.live_work_count(), 0);
        let mut packet = [0; 1024];
        assert!(
            timeout(Duration::from_millis(50), sip.recv_from(&mut packet))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn snapshot_surfaces_restores_quiet_held_call_controls_with_fresh_duration() {
        let voice = MockVoiceState::new(Vec::new(), Vec::new(), 0);
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_secs(30), Duration::from_secs(120)),
        )
        .await;
        call.dialog
            .renegotiate(&call.sip, 1, "UPDATE", "inactive", call.rtp_port)
            .await;
        call.card_shows("On hold").await;
        let slot = lock_unpoisoned(&call.service.registry)
            .active
            .clone()
            .unwrap();
        lock_unpoisoned(&slot.shared).connected_instant =
            Instant::now().checked_sub(Duration::from_secs(65));
        let recovered = call.service.snapshot_surfaces();
        assert_eq!(recovered.len(), 1);
        validate_bridge_ui_surface(&recovered[0]).unwrap();
        assert_eq!(recovered[0].id, live_surface_id(&call.call_id));
        assert!(recovered[0]
            .actions
            .iter()
            .any(|action| action.id == "hangup"));
        assert_eq!(recovered[0].dismissible, Some(false));
        let BridgeUiBlock::KeyValue { items } = &recovered[0].blocks[0] else {
            panic!("live call details");
        };
        assert!(items
            .iter()
            .any(|item| item.label == "Status" && item.value == "On hold"));
        let duration = items.iter().find(|item| item.label == "Duration").unwrap();
        let (minutes, seconds) = duration.value.split_once(':').unwrap();
        let elapsed = minutes.parse::<u64>().unwrap() * 60 + seconds.parse::<u64>().unwrap();
        assert!(
            (65..70).contains(&elapsed),
            "recovery must read current duration, not the last card"
        );
        call.agent_hangup().await;
        call.settled().await;
        assert!(call.service.snapshot_surfaces().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_thread_retirement_waits_for_call_slot_registration_then_cancels_start() {
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut notifications) = client_outbox(128);
        hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let (report_tx, mut reports) = mpsc::unbounded_channel();
        let queue = BridgeQueueService::with_submission_store(
            Arc::new(MockQueueDispatcher {
                captured: report_tx,
            }),
            Arc::clone(&hub),
            None,
            crate::queue_service::DurableQueueSubmissions::default(),
        );
        let sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let service = PhoneCallService::with_options(
            Some(sample_runtime_config(
                sip.local_addr().unwrap().port(),
                "http://127.0.0.1:9/v1",
            )),
            hub,
            Arc::downgrade(&queue),
            approval_timeouts(Duration::from_secs(1)),
            None,
        );

        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let registry = Arc::clone(&service.registry);
        let holder = std::thread::spawn(move || {
            let lock = lock_unpoisoned(&registry);
            locked_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            drop(lock);
        });
        locked_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let admitted = Arc::new(tokio::sync::Notify::new());
        *lock_unpoisoned(&queue.retirement_fence.admission_acquired) = Some(Arc::clone(&admitted));
        let starting = Arc::clone(&service);
        let start = tokio::spawn(async move {
            starting
                .start_phone_call("retiring-owner", parking_request())
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), admitted.notified())
            .await
            .unwrap();

        let (retiring_tx, mut retiring_rx) = oneshot::channel();
        let retiring_queue = Arc::clone(&queue);
        let retiring_service = Arc::clone(&service);
        let deletion = tokio::spawn(async move {
            let ids = vec!["retiring-owner".to_string()];
            let barrier = retiring_queue.block_retirement_admissions().await;
            let lease = retiring_queue
                .retirement_fence
                .begin_blocked(&ids, &barrier);
            retiring_tx.send(()).unwrap();
            drop(barrier);
            retiring_service.cancel_for_retiring_threads(&ids).await;
            lease.finish_deleted().await;
        });
        let blocked = tokio::time::timeout(Duration::from_millis(100), &mut retiring_rx)
            .await
            .is_err();
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        tokio::time::timeout(Duration::from_secs(2), deletion)
            .await
            .unwrap()
            .unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), start)
            .await
            .unwrap()
            .unwrap();
        assert!(
            blocked,
            "deletion must not scan calls before an admitted start is registered"
        );
        assert!(matches!(result, Err(PhoneCallError::Rejected(_))));
        assert_eq!(service.live_work_count(), 0);
        assert!(lock_unpoisoned(&service.registry).active.is_none());
        assert!(reports.try_recv().is_err());
        let mut packet = [0_u8; 1024];
        assert!(
            tokio::time::timeout(Duration::from_millis(50), sip.recv_from(&mut packet))
                .await
                .is_err()
        );
        assert!(matches!(
            service
                .start_phone_call("retiring-owner", parking_request())
                .await,
            Err(PhoneCallError::Invalid(_))
        ));
        let mut dismissed = false;
        while let Ok(message) = notifications.try_recv() {
            if let axum::extract::ws::Message::Text(text) = message {
                dismissed |= text.contains("bridge/ui.dismiss");
            }
        }
        assert!(dismissed, "the cancelled approval must be dismissed");
    }

    #[tokio::test]
    async fn ownership_ui_actions_and_retirement_only_affect_the_owning_active_call() {
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut rx) = client_outbox(128);
        hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let service = PhoneCallService::with_options(
            Some(sample_runtime_config(9, "http://127.0.0.1:9/v1")),
            Arc::clone(&hub),
            Weak::new(),
            approval_timeouts(Duration::from_secs(5)),
            None,
        );
        let oversized_owner = "t".repeat(MAX_OBJECTIVE_BYTES + 1);
        for owner in ["   ", oversized_owner.as_str()] {
            assert!(matches!(
                service.start_phone_call(owner, parking_request()).await,
                Err(PhoneCallError::Invalid(_))
            ));
        }

        // Without an active call, UI actions and retirements are no-ops.
        service
            .resolve_ui_action(&ui_action("phone-call-live:ghost", "owner-a", "hangup"))
            .await;
        service
            .cancel_for_retiring_threads(&["owner-a".to_string()])
            .await;
        assert_eq!(service.live_work_count(), 0);

        let spawn_start = || {
            let svc = Arc::clone(&service);
            tokio::spawn(async move { svc.start_phone_call("owner-a", parking_request()).await })
        };
        let declined = spawn_start();
        let call_id = await_approval_call_id(&mut rx).await;
        let approval_id = approval_surface_id(&call_id);
        let live_id = live_surface_id(&call_id);

        assert_eq!(
            service
                .steer_phone_call("owner-a", "other-call", "Hi")
                .unwrap()
                .status,
            SteerPhoneCallStatus::NotFound
        );
        assert_eq!(
            service
                .get_phone_call("owner-a", "other-call")
                .unwrap()
                .status,
            PhoneCallStatus::NotFound
        );
        assert_eq!(
            service
                .hangup_phone_call("owner-a", "other-call")
                .await
                .unwrap()
                .status,
            HangupPhoneCallStatus::NotFound
        );
        assert_eq!(
            service
                .steer_phone_call("owner-a", &call_id, " Mention the patio. ")
                .unwrap()
                .status,
            SteerPhoneCallStatus::Steered
        );
        let queued_steer = vec![TranscriptEntry {
            speaker: TranscriptSpeaker::Steer,
            text: "Mention the patio.".to_string(),
            interrupted: false,
        }];
        let awaiting = service.get_phone_call("owner-a", &call_id).unwrap();
        assert_eq!(awaiting.status, PhoneCallStatus::AwaitingApproval);
        assert_eq!(awaiting.transcript, queued_steer);

        for (surface_id, thread_id, action_id) in [
            ("unrelated-surface", "owner-a", "approve"),
            (approval_id.as_str(), "owner-b", "approve"),
            ("phone-call-approval:other-call", "owner-a", "approve"),
            ("phone-call-live:other-call", "owner-a", "hangup"),
            (live_id.as_str(), "owner-a", "mute"),
            (approval_id.as_str(), "owner-a", "maybe"),
        ] {
            service
                .resolve_ui_action(&ui_action(surface_id, thread_id, action_id))
                .await;
        }
        service
            .cancel_for_retiring_threads(&["owner-b".to_string()])
            .await;
        let slot = lock_unpoisoned(&service.registry)
            .active
            .clone()
            .expect("call still awaits approval");
        assert!(
            lock_unpoisoned(&slot.approval_tx).is_some(),
            "ignored actions must not resolve the approval"
        );
        assert!(
            !slot.cancel.is_cancelled(),
            "ignored actions must not hang up"
        );
        assert_eq!(service.live_work_count(), 1);

        service
            .resolve_ui_action(&ui_action(&approval_id, "owner-a", "cancel"))
            .await;
        service
            .resolve_ui_action(&ui_action(&approval_id, "owner-a", "approve"))
            .await;
        assert_eq!(
            declined.await.unwrap().unwrap_err().to_string(),
            "Phone call was declined by the user"
        );

        assert_eq!(
            service
                .steer_phone_call("owner-a", &call_id, "Hi")
                .unwrap()
                .status,
            SteerPhoneCallStatus::AlreadyEnded
        );
        for (owner, id) in [("owner-b", call_id.as_str()), ("owner-a", "other-call")] {
            assert_eq!(
                service.steer_phone_call(owner, id, "Hi").unwrap().status,
                SteerPhoneCallStatus::NotFound
            );
            assert_eq!(
                service.get_phone_call(owner, id).unwrap().status,
                PhoneCallStatus::NotFound
            );
            assert_eq!(
                service.hangup_phone_call(owner, id).await.unwrap().status,
                HangupPhoneCallStatus::NotFound
            );
        }
        let ended = service.get_phone_call("owner-a", &call_id).unwrap();
        assert_eq!(ended.status, PhoneCallStatus::Cancelled);
        assert_eq!(ended.end_reason.as_deref(), Some("declined_by_user"));
        assert_eq!(ended.transcript, queued_steer);
        assert_eq!(
            service
                .hangup_phone_call("owner-a", &call_id)
                .await
                .unwrap()
                .status,
            HangupPhoneCallStatus::AlreadyEnded
        );

        // The owner can hang up a call that is still awaiting approval.
        let hung_up = spawn_start();
        let hung_up_id = await_approval_call_id(&mut rx).await;
        assert_eq!(
            service
                .hangup_phone_call(" owner-a ", &hung_up_id)
                .await
                .unwrap()
                .status,
            HangupPhoneCallStatus::HungUp
        );
        let cancelled = service.get_phone_call("owner-a", &hung_up_id).unwrap();
        assert_eq!(cancelled.status, PhoneCallStatus::Cancelled);
        assert_eq!(
            cancelled.end_reason.as_deref(),
            Some("cancelled_before_dial")
        );
        assert_eq!(
            hung_up.await.unwrap().unwrap_err().to_string(),
            "Phone call was cancelled before dialing"
        );

        // Shutdown cancels the pending call and refuses new ones.
        let shut_down = spawn_start();
        let shut_down_id = await_approval_call_id(&mut rx).await;
        service.shutdown().await;
        assert_eq!(
            service
                .get_phone_call("owner-a", &shut_down_id)
                .unwrap()
                .end_reason
                .as_deref(),
            Some("cancelled_before_dial")
        );
        assert_eq!(
            shut_down.await.unwrap().unwrap_err().to_string(),
            "Phone call was cancelled before dialing"
        );
        match service.start_phone_call("owner-a", parking_request()).await {
            Err(PhoneCallError::Internal(message)) => {
                assert_eq!(message, "bridge is shutting down");
            }
            other => panic!("calls after shutdown must be refused, got {other:?}"),
        }
        assert_eq!(service.live_work_count(), 0);
    }

    #[tokio::test]
    async fn completed_call_history_keeps_only_the_most_recent_records() {
        let service = PhoneCallService::with_options(
            Some(sample_runtime_config(9, "http://127.0.0.1:9/v1")),
            Arc::new(ClientHub::new()),
            Weak::new(),
            approval_timeouts(Duration::from_millis(1)),
            None,
        );
        let mut call_ids = Vec::new();
        for _ in 0..=COMPLETED_CALL_HISTORY_LIMIT {
            let err = service
                .start_phone_call("history-owner", parking_request())
                .await
                .unwrap_err();
            assert_eq!(err.to_string(), "Timed out waiting for phone call approval");
            let newest = lock_unpoisoned(&service.registry)
                .completed
                .back()
                .map(|record| record.call_id.clone())
                .expect("timed-out call is recorded");
            call_ids.push(newest);
        }
        assert_eq!(
            lock_unpoisoned(&service.registry).completed.len(),
            COMPLETED_CALL_HISTORY_LIMIT
        );
        assert_eq!(
            service
                .get_phone_call("history-owner", &call_ids[0])
                .unwrap()
                .status,
            PhoneCallStatus::NotFound
        );
        assert_eq!(
            service
                .steer_phone_call("history-owner", &call_ids[0], "Hi")
                .unwrap()
                .status,
            SteerPhoneCallStatus::NotFound
        );
        for call_id in &call_ids[1..] {
            let snapshot = service.get_phone_call("history-owner", call_id).unwrap();
            assert_eq!(snapshot.status, PhoneCallStatus::Cancelled);
            assert_eq!(snapshot.end_reason.as_deref(), Some("approval_timeout"));
        }
    }

    #[tokio::test]
    async fn dropping_a_pending_start_cancels_the_call_and_dismisses_its_surfaces() {
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut rx) = client_outbox(128);
        hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let voice_url =
            spawn_mock_voice_http(MockVoiceState::new(Vec::new(), Vec::new(), 480)).await;
        let ringing_sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let sip_port = ringing_sip.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut buf = vec![0_u8; 65535];
            let (n_inv, peer) = ringing_sip.recv_from(&mut buf).await.unwrap();
            let invite = String::from_utf8_lossy(&buf[..n_inv]).into_owned();
            let ringing = format!(
                "SIP/2.0 180 Ringing\r\nVia: {}\r\nFrom: {}\r\nTo: {};tag=drop1\r\nCall-ID: {}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n",
                extract_sip_header(&invite, "Via:"),
                extract_sip_header(&invite, "From:"),
                extract_sip_header(&invite, "To:"),
                extract_sip_header(&invite, "Call-ID:"),
            );
            ringing_sip.send_to(ringing.as_bytes(), peer).await.unwrap();
            while ringing_sip.recv_from(&mut buf).await.is_ok() {}
        });
        let service = PhoneCallService::with_options(
            Some(sample_runtime_config(sip_port, &voice_url)),
            hub,
            Weak::new(),
            approval_timeouts(Duration::from_secs(5)),
            None,
        );

        for ringing in [false, true] {
            let svc = Arc::clone(&service);
            let pending =
                tokio::spawn(
                    async move { svc.start_phone_call("drop-owner", parking_request()).await },
                );
            let call_id = await_approval_call_id(&mut rx).await;
            let presented_surface = if ringing {
                service
                    .resolve_ui_action(&ui_action(
                        &approval_surface_id(&call_id),
                        "drop-owner",
                        "approve",
                    ))
                    .await;
                let live_id = live_surface_id(&call_id);
                recv_matching_notification(&mut rx, |method, params| {
                    method == "bridge/ui.update"
                        && params["id"] == live_id
                        && params["subtitle"] == "Ringing…"
                })
                .await;
                live_id
            } else {
                approval_surface_id(&call_id)
            };
            assert_eq!(service.live_work_count(), 1);
            pending.abort();
            assert!(pending.await.unwrap_err().is_cancelled());

            let dismissed =
                recv_matching_notification(&mut rx, |method, _| method == "bridge/ui.dismiss")
                    .await;
            assert_eq!(dismissed["id"], presented_surface.as_str());
            assert_eq!(dismissed["threadId"], "drop-owner");
            let snapshot = service.get_phone_call("drop-owner", &call_id).unwrap();
            assert_eq!(snapshot.status, PhoneCallStatus::Cancelled);
            assert_eq!(snapshot.end_reason.as_deref(), Some("caller_dropped"));
            timeout(TEST_TIMEOUT, async {
                while service.live_work_count() != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }

    #[test]
    fn dropping_a_pending_start_outside_a_runtime_settles_synchronously() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let service = PhoneCallService::with_options(
            Some(sample_runtime_config(9, "http://127.0.0.1:9/v1")),
            Arc::new(ClientHub::new()),
            Weak::new(),
            approval_timeouts(Duration::from_secs(5)),
            None,
        );
        let mut pending = service.start_phone_call("detached-owner", parking_request());
        runtime.block_on(async {
            assert!(
                timeout(Duration::from_millis(300), &mut pending)
                    .await
                    .is_err(),
                "the call waits for approval"
            );
        });
        assert_eq!(service.live_work_count(), 1);
        drop(pending);
        assert_eq!(service.live_work_count(), 0);
        let registry = lock_unpoisoned(&service.registry);
        assert!(registry.active.is_none());
        let record = registry.completed.back().expect("dropped call is recorded");
        assert_eq!(record.snapshot.status, PhoneCallStatus::Cancelled);
        assert_eq!(
            record.snapshot.end_reason.as_deref(),
            Some("caller_dropped")
        );
    }

    #[tokio::test]
    async fn agent_hangup_mid_greeting_reports_pre_connect_steer_and_interrupted_speech() {
        let voice =
            MockVoiceState::new(vec![voice_reply(SLOW_GREETING, json!([]))], vec![], 48_000);
        voice.tts_chunk_delay_ms.store(100, Ordering::SeqCst);
        let mut options = TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60));
        options.pre_connect_steer = Some("Mention that the party is four people.");
        options.sip_username = Some("trunk-user");
        options.custom_tls = Some(crate::phone_call::sip::default_rustls_client_config().unwrap());
        let mut call = TrunkCall::connect(&voice, options).await;

        // The queued steer starts speaking at connect instead of after the 20 s greeting window.
        call.assistant_audio_reaches_trunk().await;
        assert!(voice.chat_requests.lock().await[0]["messages"]
            .to_string()
            .contains("Mention that the party is four people."));
        assert_eq!(
            call.agent_hangup().await.status,
            HangupPhoneCallStatus::HungUp
        );

        let snapshot = call.settled().await;
        assert_eq!(snapshot.status, PhoneCallStatus::Completed);
        assert_eq!(snapshot.end_reason.as_deref(), Some("agent_hangup"));
        assert_eq!(snapshot.transcript[0].speaker, TranscriptSpeaker::Steer);
        let greeting = snapshot.transcript.last().unwrap();
        assert_eq!(greeting.speaker, TranscriptSpeaker::Assistant);
        assert!(greeting.interrupted, "{greeting:?}");
        assert!(
            greeting.text == "[partially spoken sentence] [interrupted]",
            "{greeting:?}"
        );
        let report = call.report().await;
        assert!(report.contains("End reason: agent_hangup"), "{report}");
        assert!(report.contains("Instruction (not spoken): Mention that the party is four people."));
        assert!(report.contains(INTERRUPTED_MARKER), "{report}");
        assert_eq!(
            call.service
                .hangup_phone_call(TRUNK_OWNER, &call.call_id)
                .await
                .unwrap()
                .status,
            HangupPhoneCallStatus::AlreadyEnded
        );
    }

    #[tokio::test]
    async fn remote_bye_and_maximum_duration_settle_calls_with_or_without_active_speech() {
        for (speaking, max_duration) in [
            (true, None),
            (false, None),
            (true, Some(Duration::from_secs(1))),
        ] {
            let voice =
                MockVoiceState::new(vec![voice_reply(SLOW_GREETING, json!([]))], vec![], 48_000);
            voice.tts_chunk_delay_ms.store(100, Ordering::SeqCst);
            let opening = if speaking {
                Duration::from_millis(20)
            } else {
                Duration::from_secs(20)
            };
            let mut options =
                TrunkCallOptions::new(opening, max_duration.unwrap_or(Duration::from_secs(60)));
            let report_queue = !speaking || max_duration.is_some();
            options.report_queue = report_queue;
            let mut call = TrunkCall::connect(&voice, options).await;
            if speaking {
                call.assistant_audio_reaches_trunk().await;
            }
            let (end_reason, card_detail) = if max_duration.is_some() {
                timeout(TEST_TIMEOUT, call.dialog.expect_bye_and_reply_ok(&call.sip))
                    .await
                    .expect("BYE at the maximum duration");
                ("max_duration_reached", "Maximum call duration reached.")
            } else {
                call.dialog.send_remote_bye(&call.sip, 2).await;
                ("remote_bye", "They hung up")
            };
            let settled_card = call
                .update_matching(|params| params["title"] == "Phone call ended")
                .await;
            assert!(
                settled_card["blocks"].to_string().contains(card_detail),
                "{settled_card}"
            );
            let snapshot = call.settled().await;
            assert_eq!(snapshot.status, PhoneCallStatus::Completed);
            assert_eq!(snapshot.end_reason.as_deref(), Some(end_reason));
            let spoken = snapshot
                .transcript
                .iter()
                .find(|entry| entry.speaker == TranscriptSpeaker::Assistant);
            if speaking {
                let spoken = spoken.expect("interrupted greeting");
                assert!(
                    spoken.interrupted
                        && spoken.text == "[partially spoken sentence] [interrupted]",
                    "{spoken:?}"
                );
            } else {
                assert!(spoken.is_none(), "{spoken:?}");
                assert!(voice.chat_requests.lock().await.is_empty());
            }
            if report_queue {
                let report = call.report().await;
                assert!(
                    report.contains(&format!("End reason: {end_reason}")),
                    "{report}"
                );
                assert_eq!(
                    report.contains("(no spoken transcript recorded)"),
                    !speaking,
                    "{report}"
                );
            } else {
                assert!(call.reports.try_recv().is_err());
            }
        }
    }

    #[tokio::test]
    async fn remote_hold_aborts_speech_preserves_transcription_and_blocks_model_resume() {
        let voice = MockVoiceState::new(
            vec![
                voice_reply(SLOW_GREETING, json!([])),
                voice_reply("", voice_tool("resume_call", json!({}))),
            ],
            vec![
                "Thanks for holding, I am back now.",
                "Sorry, one more moment.",
            ],
            48_000,
        );
        voice.tts_chunk_delay_ms.store(100, Ordering::SeqCst);
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
        )
        .await;
        call.assistant_audio_reaches_trunk().await;

        let response = call
            .dialog
            .renegotiate(&call.sip, 2, "INVITE", "sendonly", call.rtp_port)
            .await;
        assert!(response.contains("a=recvonly"), "{response}");
        call.update_matching(|params| params["subtitle"] == "On hold")
            .await;
        let held = call.snapshot();
        assert!(held.on_hold);
        let greeting = held.transcript.last().unwrap();
        assert!(
            greeting.interrupted && greeting.text == "[partially spoken sentence] [interrupted]",
            "{greeting:?}"
        );

        // The model cannot resume while the remote endpoint still holds the call.
        let ivr_silence = crate::phone_call::audio::VAD_IVR_HANGOVER_FRAMES + 10;
        call.callee_speaks(ivr_silence).await;
        call.card_shows("Thanks for holding, I am back now.").await;
        assert!(call.snapshot().on_hold);
        assert_eq!(voice.chat_requests.lock().await.len(), 1);

        // A remote resume preserves a transcription that is still pending.
        voice.stt_delay_ms.store(1_000, Ordering::SeqCst);
        call.callee_speaks(ivr_silence).await;
        stt_requests_reach(&voice, 2).await;
        let response = call
            .dialog
            .renegotiate(&call.sip, 3, "INVITE", "sendrecv", call.rtp_port)
            .await;
        assert!(response.contains("a=sendrecv"), "{response}");
        call.update_matching(|params| params["subtitle"] == "In call")
            .await;
        call.card_shows("Sorry, one more moment.").await;
        chat_requests_reach(&voice, 2).await;
        let resumed = call.snapshot();
        assert!(!resumed.on_hold);
        assert!(
            resumed
                .transcript
                .iter()
                .any(|entry| entry.text.contains("one more moment")),
            "{:?}",
            resumed.transcript
        );
        assert_eq!(voice.chat_requests.lock().await.len(), 2);

        call.dialog.send_remote_bye(&call.sip, 4).await;
        let snapshot = call.settled().await;
        assert_eq!(snapshot.end_reason.as_deref(), Some("remote_bye"));
        let report = call.report().await;
        assert!(report.contains("End reason: remote_bye"), "{report}");
        assert!(report.contains(INTERRUPTED_MARKER), "{report}");
        assert!(report.contains("Sorry, one more moment."), "{report}");
    }

    #[tokio::test]
    async fn remote_hold_preserves_inflight_details_and_queued_correction_until_resume() {
        let voice = MockVoiceState::new(
            vec![voice_reply("Thursday, got it.", json!([]))],
            vec!["Book for two on Tuesday.", "Actually use Thursday instead."],
            2_400,
        );
        voice.stt_delay_ms.store(1_500, Ordering::SeqCst);
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
        )
        .await;
        call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        stt_requests_reach(&voice, 1).await;
        voice.stt_delay_ms.store(0, Ordering::SeqCst);
        call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        call.dialog
            .renegotiate(&call.sip, 2, "INVITE", "sendonly", call.rtp_port)
            .await;
        call.update_matching(|params| params["subtitle"] == "On hold")
            .await;
        let held_card = call
            .update_matching(|params| {
                params["subtitle"] == "On hold"
                    && params["blocks"]
                        .to_string()
                        .contains("Actually use Thursday instead.")
            })
            .await;
        assert!(held_card.to_string().contains("hangup"), "{held_card}");
        assert!(call.snapshot().on_hold);
        assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
        assert!(voice.chat_requests.lock().await.is_empty());
        assert!(voice.tts_requests.lock().await.is_empty());

        call.dialog
            .renegotiate(&call.sip, 3, "INVITE", "sendrecv", call.rtp_port)
            .await;
        call.card_shows("Thursday, got it.").await;
        assert!(!call.snapshot().on_hold);
        assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
        let requests = voice.chat_requests.lock().await;
        assert_eq!(requests.len(), 1);
        let recipient: Vec<_> = requests[0]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "user")
            .map(|message| message["content"].as_str().unwrap())
            .collect();
        assert_eq!(
            recipient,
            [
                "Recipient: Book for two on Tuesday.",
                "Recipient: Actually use Thursday instead."
            ]
        );
        drop(requests);
        call.agent_hangup().await;
        assert_eq!(call.settled().await.status, PhoneCallStatus::Completed);
        let report = call.report().await;
        assert!(report.contains("Book for two on Tuesday."), "{report}");
        assert!(
            report.contains("Actually use Thursday instead."),
            "{report}"
        );
    }

    #[tokio::test]
    async fn remote_hold_retries_the_captured_reply_when_its_assistant_turn_was_aborted() {
        let reply = "Four for Thursday, got it.";
        let voice = MockVoiceState::new(
            vec![voice_reply(reply, json!([])), voice_reply(reply, json!([]))],
            vec!["Please book four for Thursday."],
            2_400,
        );
        voice.tts_chunk_delay_ms.store(2_000, Ordering::SeqCst);
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
        )
        .await;
        call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        chat_requests_reach(&voice, 1).await;
        call.dialog
            .renegotiate(&call.sip, 2, "INVITE", "sendonly", call.rtp_port)
            .await;
        call.update_matching(|params| params["subtitle"] == "On hold")
            .await;
        assert!(call.snapshot().on_hold);
        assert_eq!(voice.chat_requests.lock().await.len(), 1);
        assert!(call
            .snapshot()
            .transcript
            .iter()
            .any(|entry| entry.text == "Please book four for Thursday."));
        voice.tts_chunk_delay_ms.store(0, Ordering::SeqCst);
        call.dialog
            .renegotiate(&call.sip, 3, "INVITE", "sendrecv", call.rtp_port)
            .await;
        call.card_shows(reply).await;
        assert!(!call.snapshot().on_hold);
        assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
        assert_eq!(voice.chat_requests.lock().await.len(), 2);
        call.agent_hangup().await;
        assert_eq!(call.settled().await.status, PhoneCallStatus::Completed);
        let report = call.report().await;
        assert!(
            report.contains("Please book four for Thursday."),
            "{report}"
        );
        assert!(report.contains(reply), "{report}");
    }

    #[tokio::test]
    async fn barge_in_clears_queued_inband_dtmf_without_an_assistant_task() {
        let voice = MockVoiceState::new(
            vec![voice_reply(
                "",
                voice_tool("send_dtmf", json!({"digits":"01234567890123456789"})),
            )],
            vec![],
            2_400,
        );
        let mut options = TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60));
        options.include_dtmf = false;
        let mut call = TrunkCall::connect(&voice, options).await;
        call.assistant_audio_reaches_trunk().await;
        assert_eq!(voice.chat_requests.lock().await.len(), 1);
        assert!(voice.tts_requests.lock().await.is_empty());
        send_rtp_utterance(
            &call.rtp,
            call.dialog.client_rtp_addr,
            &mut call.seq,
            &mut call.ts,
            14,
            0,
        )
        .await;
        timeout(Duration::from_secs(1), async {
            let mut quiet = 0;
            let mut packet = [0; 2048];
            while quiet < 15 {
                let (len, _) = call.rtp.recv_from(&mut packet).await.unwrap();
                let rtp = parse_rtp_packet(&packet[..len]).unwrap();
                assert_eq!(rtp.payload_type, PCMU_PAYLOAD_TYPE);
                if rtp.payload.iter().all(|byte| matches!(*byte, 0xFF | 0x7F)) {
                    quiet += 1;
                } else {
                    quiet = 0;
                }
            }
        })
        .await
        .expect("barge-in discards remaining in-band tones immediately");
        assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
        assert!(!call.snapshot().on_hold);
        call.agent_hangup().await;
        assert_eq!(
            call.settled().await.end_reason.as_deref(),
            Some("agent_hangup")
        );
    }

    #[tokio::test]
    async fn queued_substantive_correction_then_fragment_cancels_the_old_hangup_without_more_rtp() {
        let voice = MockVoiceState::new(
            vec![
                voice_reply(
                    "Thanks, goodbye.",
                    voice_tool(
                        "end_call",
                        json!({
                            "reason":"Got the hours", "outcome_summary":"Closes at nine"
                        }),
                    ),
                ),
                voice_reply("Ten, got it. Thanks.", json!([])),
            ],
            vec!["We close at nine.", "Actually we close at ten.", "Bye"],
            2_400,
        );
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
        )
        .await;
        call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        call.card_shows("Thanks, goodbye.").await;
        voice.stt_delay_ms.store(1_000, Ordering::SeqCst);
        call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        stt_requests_reach(&voice, 2).await;
        voice.stt_delay_ms.store(0, Ordering::SeqCst);
        call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        call.card_shows("Ten, got it. Thanks.").await;
        let snapshot = call.snapshot();
        assert_eq!(snapshot.status, PhoneCallStatus::InProgress);
        assert!(snapshot.end_reason.is_none());
        assert!(snapshot.outcome_summary.is_none());
        assert!(snapshot
            .transcript
            .iter()
            .any(|entry| entry.text == "Actually we close at ten."));
        assert!(snapshot.transcript.iter().any(|entry| entry.text == "Bye"));
        let requests = voice.chat_requests.lock().await;
        assert_eq!(requests.len(), 2);
        assert!(requests[1]["messages"]
            .to_string()
            .contains("Actually we close at ten."));
        assert!(requests[1]["messages"].to_string().contains("Bye"));
        drop(requests);
        call.agent_hangup().await;
        assert_eq!(
            call.settled().await.end_reason.as_deref(),
            Some("agent_hangup")
        );
    }

    #[tokio::test]
    async fn ordinary_steering_preserves_hold_then_late_transcription_keeps_explicit_resume() {
        let voice = MockVoiceState::new(
            vec![
                voice_reply(
                    "Of course, I'll hold. I'll wait for you here.",
                    voice_tool(
                        "wait_silently",
                        json!({"reason":"Recipient requested hold", "on_hold":true}),
                    ),
                ),
                voice_reply(
                    "",
                    voice_tool(
                        "wait_silently",
                        json!({"reason":"Still holding", "on_hold":true}),
                    ),
                ),
                voice_reply("", voice_tool("resume_call", json!({}))),
                voice_reply("Is there parking?", json!([])),
            ],
            vec![
                "Please hold while I check.",
                "Your call is important to us. Please continue to hold.",
            ],
            24_000,
        );
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
        )
        .await;
        call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        call.assistant_audio_reaches_trunk().await;
        call.service
            .steer_phone_call(
                TRUNK_OWNER,
                &call.call_id,
                "Use a concise reply when they return.",
            )
            .unwrap();
        call.update_matching(|params| params["subtitle"] == "On hold")
            .await;
        chat_requests_reach(&voice, 2).await;
        call.update_matching(|params| params["subtitle"] == "On hold")
            .await;
        {
            let requests = voice.chat_requests.lock().await;
            assert_eq!(
                requests[1]["response_format"]["json_schema"]["name"],
                "hold_decision"
            );
            assert!(requests[1]["messages"][1]["content"]
                .as_str()
                .unwrap()
                .contains("Use a concise reply when they return."));
        }
        assert!(call.snapshot().on_hold);
        assert!(call
            .snapshot()
            .transcript
            .iter()
            .any(|entry| entry.text == "Of course, I'll hold."));
        assert!(!call
            .snapshot()
            .transcript
            .iter()
            .any(|entry| entry.text.contains("I'll wait for you here.")));
        voice.stt_delay_ms.store(500, Ordering::SeqCst);
        call.callee_speaks(crate::phone_call::audio::VAD_IVR_HANGOVER_FRAMES + 2)
            .await;
        stt_requests_reach(&voice, 2).await;
        call.service
            .steer_phone_call(
                TRUNK_OWNER,
                &call.call_id,
                "Resume speaking and ask about parking now.",
            )
            .unwrap();
        call.card_shows("Is there parking?").await;
        let requests = voice.chat_requests.lock().await;
        assert_eq!(requests.len(), 4);
        let held_input = requests[2]["messages"][1]["content"].as_str().unwrap();
        assert!(
            held_input.contains("Resume speaking and ask about parking now."),
            "{held_input}"
        );
        assert!(
            held_input.contains("Your call is important to us."),
            "{held_input}"
        );
        assert!(
            !held_input.contains("Use a concise reply when they return."),
            "{held_input}"
        );
        drop(requests);
        assert!(!call.snapshot().on_hold);
        assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
        call.agent_hangup().await;
        assert_eq!(call.settled().await.status, PhoneCallStatus::Completed);
    }

    #[tokio::test]
    async fn voice_tool_guards_keep_premature_and_held_actions_from_taking_effect() {
        let end_call = || {
            (
                "end_call",
                json!({"reason": "Got the hours", "outcome_summary": "Open until nine"}),
            )
        };
        let hold = || {
            (
                "wait_silently",
                json!({"reason": "Checking the patio", "on_hold": true}),
            )
        };
        let voice = MockVoiceState::new(
            vec![
                voice_reply(
                    "Hello, I am calling about your opening hours.",
                    voice_tools(&[
                        ("send_dtmf", json!({"digits": "1"})),
                        ("resume_call", json!({})),
                    ]),
                ),
                voice_reply("", voice_tools(&[end_call()])),
                voice_reply("", voice_tools(&[hold(), end_call()])),
                voice_reply(
                    "",
                    voice_tools(&[
                        ("send_dtmf", json!({"digits": "2"})),
                        hold(),
                        ("resume_call", json!({})),
                    ]),
                ),
                voice_reply("", voice_tools(&[hold()])),
                voice_reply("", voice_tools(&[("resume_call", json!({}))])),
                voice_reply(
                    "Is the patio heated?",
                    voice_tools(&[(
                        "wait_silently",
                        json!({"reason": "Awaiting the answer", "on_hold": false}),
                    )]),
                ),
            ],
            vec![
                "We are open until nine tonight.",
                "Please hold while I check the patio.",
                "Still checking, one moment please.",
                "I'm back. How can I help?",
            ],
            2_450,
        );
        let mut options = TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60));
        options.include_dtmf = false;
        let mut call = TrunkCall::connect(&voice, options).await;

        // Without a negotiated telephone-event payload type, DTMF plays in-band.
        let voiced = call.outbound_audio_goes_quiet().await;
        assert!(
            voiced.iter().all(|pt| *pt == PCMU_PAYLOAD_TYPE),
            "{voiced:?}"
        );
        call.card_shows("Hello, I am calling about your opening hours.")
            .await;

        let ivr_silence = crate::phone_call::audio::VAD_IVR_HANGOVER_FRAMES + 10;
        call.callee_speaks(ivr_silence).await;
        call.card_shows("We are open until nine tonight.").await;
        call.update_matching(|_| true).await;
        call.callee_speaks(ivr_silence).await;
        call.card_shows("Please hold while I check the patio.")
            .await;
        call.update_matching(|params| params["subtitle"] == "On hold")
            .await;
        let held = call.snapshot();
        assert_eq!(held.status, PhoneCallStatus::InProgress);
        assert!(held.on_hold);

        call.callee_speaks(ivr_silence).await;
        call.card_shows("Still checking, one moment please.").await;
        call.update_matching(|_| true).await;
        assert!(
            call.snapshot().on_hold,
            "resume_call beside a hold request keeps holding"
        );

        call.service
            .steer_phone_call(
                TRUNK_OWNER,
                &call.call_id,
                "Ask whether the patio is heated.",
            )
            .unwrap();
        chat_requests_reach(&voice, 5).await;
        call.callee_speaks(ivr_silence).await;
        call.card_shows("Is the patio heated?").await;
        chat_requests_reach(&voice, 7).await;
        assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
        assert!(!call.snapshot().on_hold);
        let requests: Vec<String> = voice
            .chat_requests
            .lock()
            .await
            .iter()
            .map(|request| request["messages"].to_string())
            .collect();
        let rejected_end = "Not ended: a single-word transcription is provisional";
        assert!(
            requests[1].contains("Sent DTMF digits: 1"),
            "{}",
            requests[1]
        );
        assert!(requests[1].contains("Conversation resumed; respond to the recipient now."));
        assert!(requests[2].contains(rejected_end), "{}", requests[2]);
        assert_eq!(
            requests[6].matches(rejected_end).count(),
            2,
            "{}",
            requests[6]
        );
        assert!(
            requests[6].contains("Not sent: the call is on hold."),
            "{}",
            requests[6]
        );
        assert!(!requests[6].contains("Sent DTMF digits: 2"));
        assert!(requests[3].contains("Still checking, one moment please."));
        assert!(requests[4].contains("Ask whether the patio is heated."));
        assert!(!requests[4].contains(rejected_end));

        assert_eq!(
            call.agent_hangup().await.status,
            HangupPhoneCallStatus::HungUp
        );
        assert_eq!(
            call.settled().await.end_reason.as_deref(),
            Some("agent_hangup")
        );
        assert!(call.report().await.contains("End reason: agent_hangup"));
    }

    #[tokio::test]
    async fn opening_greeting_and_steers_wait_for_pending_transcriptions() {
        let voice = MockVoiceState::new(
            vec![
                voice_reply("Hello, I am calling about your opening hours.", json!([])),
                voice_reply("Do you also have parking nearby?", json!([])),
            ],
            vec![
                "",
                "",
                "",
                "We have a lot behind the building.",
                "Sorry, could you repeat that?",
            ],
            2_400,
        );
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_millis(800), Duration::from_secs(60)),
        )
        .await;
        let connected = Instant::now();
        let silence = VAD_DEFAULT_HANGOVER_FRAMES + 2;

        // An empty transcription inside the opening window keeps waiting for the deadline.
        call.callee_speaks(silence).await;
        stt_requests_reach(&voice, 1).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        // A transcription still pending at the deadline defers the greeting until it resolves.
        voice.stt_delay_ms.store(1_500, Ordering::SeqCst);
        call.callee_speaks(silence).await;
        stt_requests_reach(&voice, 2).await;
        call.card_shows("Hello, I am calling about your opening hours.")
            .await;
        assert!(
            connected.elapsed() >= Duration::from_millis(1_400),
            "the greeting started {:?} after connect",
            connected.elapsed()
        );

        // A steer that arrives during a pending transcription waits for that result.
        voice.stt_delay_ms.store(800, Ordering::SeqCst);
        call.callee_speaks(silence).await;
        stt_requests_reach(&voice, 3).await;
        let transcribing = Instant::now();
        call.service
            .steer_phone_call(TRUNK_OWNER, &call.call_id, "Ask about parking.")
            .unwrap();
        call.card_shows("Do you also have parking nearby?").await;
        assert!(
            transcribing.elapsed() >= Duration::from_millis(700),
            "the steered turn started {:?} into the transcription",
            transcribing.elapsed()
        );
        assert_eq!(voice.chat_requests.lock().await.len(), 2);

        // A newer utterance stays queued, and hang-up cancels the transcription and its backlog.
        voice.stt_delay_ms.store(3_000, Ordering::SeqCst);
        call.callee_speaks(silence).await;
        stt_requests_reach(&voice, 4).await;
        call.callee_speaks(silence).await;
        assert_eq!(voice.stt_requests.load(Ordering::SeqCst), 4);
        assert_eq!(
            call.agent_hangup().await.status,
            HangupPhoneCallStatus::HungUp
        );
        let snapshot = call.settled().await;
        assert_eq!(snapshot.end_reason.as_deref(), Some("agent_hangup"));
        assert!(
            !snapshot
                .transcript
                .iter()
                .any(|entry| entry.speaker == TranscriptSpeaker::Callee),
            "{:?}",
            snapshot.transcript
        );
        assert_eq!(voice.chat_requests.lock().await.len(), 2);
    }

    #[tokio::test]
    async fn accepted_end_call_waits_for_queued_dtmf_before_hanging_up() {
        // 22 in-band digits take 22 * 8 frames * 20 ms = 3.52 s, longer than the quiet grace.
        let digits = "0123456789*#0123456789";
        let voice = MockVoiceState::new(
            vec![voice_reply(
                "Thanks, goodbye.",
                voice_tools(&[
                    ("send_dtmf", json!({"digits": digits})),
                    (
                        "end_call",
                        json!({"reason": "Got the hours", "outcome_summary": "Open until nine"}),
                    ),
                ]),
            )],
            vec!["We are open until nine tonight."],
            2_400,
        );
        let mut options = TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60));
        options.include_dtmf = false;
        let mut call = TrunkCall::connect(&voice, options).await;
        call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        call.card_shows("Thanks, goodbye.").await;
        let closing = Instant::now();
        timeout(TEST_TIMEOUT, call.dialog.expect_bye_and_reply_ok(&call.sip))
            .await
            .expect("the accepted closing hangs up");
        assert!(
            closing.elapsed() >= END_CALL_QUIET_GRACE + Duration::from_secs(1),
            "BYE was sent {:?} after the closing, before the queued DTMF finished",
            closing.elapsed()
        );
        let snapshot = call.settled().await;
        assert_eq!(snapshot.end_reason.as_deref(), Some("Got the hours"));
        assert_eq!(snapshot.outcome_summary.as_deref(), Some("Open until nine"));
        assert!(call
            .report()
            .await
            .contains("Outcome summary: Open until nine"));
    }

    #[tokio::test]
    async fn busy_line_settles_the_card_in_plain_words_with_the_sip_detail_secondary() {
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut notifications) = client_outbox(64);
        hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let (report_tx, _reports) = mpsc::unbounded_channel();
        let queue = BridgeQueueService::with_submission_store(
            Arc::new(MockQueueDispatcher {
                captured: report_tx,
            }),
            Arc::clone(&hub),
            None,
            crate::queue_service::DurableQueueSubmissions::default(),
        );
        let sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let sip_port = sip.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut buf = vec![0_u8; 65535];
            let (n, client) = sip.recv_from(&mut buf).await.expect("INVITE");
            let invite = std::str::from_utf8(&buf[..n]).expect("utf8 INVITE");
            let busy = format!(
                "SIP/2.0 486 Busy Here\r\nVia: {}\r\nFrom: {}\r\nTo: {};tag=busy\r\nCall-ID: {}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n",
                extract_sip_header(invite, "Via:"),
                extract_sip_header(invite, "From:"),
                extract_sip_header(invite, "To:"),
                extract_sip_header(invite, "Call-ID:"),
            );
            sip.send_to(busy.as_bytes(), client).await.expect("486");
            let _ = sip.recv_from(&mut buf).await;
        });
        let voice = MockVoiceState::new(vec![], vec![], 0);
        let voice_url = spawn_mock_voice_http(voice).await;
        let service = PhoneCallService::with_options(
            Some(sample_runtime_config(sip_port, &voice_url)),
            hub,
            Arc::downgrade(&queue),
            PhoneCallTimeouts {
                approval_timeout: Duration::from_secs(5),
                max_call_duration: Duration::from_secs(60),
                opening_greeting_wait: Duration::from_secs(20),
            },
            None,
        );
        let start_service = Arc::clone(&service);
        let start = tokio::spawn(async move {
            start_service
                .start_phone_call(
                    "busy-owner",
                    StartPhoneCallRequest {
                        phone_number: "+15559876543".to_string(),
                        objective: "Ask about parking".to_string(),
                        callee_name: None,
                        first_message: None,
                        context: None,
                    },
                )
                .await
        });
        let modal = recv_matching_notification(&mut notifications, |method, p| {
            method == "bridge/ui.present" && p["presentation"] == "modal"
        })
        .await;
        service
            .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                id: modal["id"].as_str().unwrap().to_string(),
                thread_id: "busy-owner".to_string(),
                turn_id: None,
                action_id: "approve".to_string(),
            })
            .await;
        let failed = recv_matching_notification(&mut notifications, |method, p| {
            method == "bridge/ui.update" && p["title"] == "Phone call failed"
        })
        .await;
        let rows = failed["blocks"][0]["items"].to_string();
        assert!(
            rows.contains(r#"{"label":"Reason","value":"Line busy"}"#),
            "{rows}"
        );
        assert!(
            rows.contains(r#"{"label":"Details","value":"SIP call rejected (486 Busy Here)"}"#),
            "{rows}"
        );
        let error = timeout(TEST_TIMEOUT, start)
            .await
            .unwrap()
            .unwrap()
            .expect_err("a busy line fails the call");
        assert!(error.to_string().contains("486 Busy Here"), "{error}");
    }

    #[tokio::test]
    async fn steering_during_synthesis_underrun_preserves_the_started_sentence() {
        let voice = MockVoiceState::new(
            vec![
                voice_reply(
                    "Hello, I am checking the hours.",
                    voice_tools(&[("wait_silently", json!({"on_hold": false}))]),
                ),
                voice_reply(
                    "Is there parking?",
                    voice_tools(&[("wait_silently", json!({"on_hold": false}))]),
                ),
            ],
            vec![],
            2_400,
        );
        voice.tts_chunk_delay_ms.store(100, Ordering::SeqCst);
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
        )
        .await;
        call.assistant_audio_reaches_trunk().await;
        timeout(TEST_TIMEOUT, async {
            let mut buffer = [0; 2048];
            loop {
                let (len, _) = call.rtp.recv_from(&mut buffer).await.unwrap();
                if parse_rtp_packet(&buffer[..len])
                    .is_some_and(|packet| packet.payload.iter().all(|byte| *byte == 0xFF))
                {
                    break;
                }
            }
        })
        .await
        .unwrap();
        voice.tts_chunk_delay_ms.store(0, Ordering::SeqCst);
        let steered_at = Instant::now();
        call.service
            .steer_phone_call(TRUNK_OWNER, &call.call_id, "Ask about parking.")
            .unwrap();
        call.card_shows("Is there parking?").await;
        assert!(steered_at.elapsed() >= Duration::from_millis(300));
        let messages = voice.chat_requests.lock().await[1]["messages"].to_string();
        assert!(messages.contains("Hello, I am checking the hours."));
        assert!(!messages.contains("[partially spoken sentence]"));
        call.agent_hangup().await;
    }

    #[tokio::test]
    async fn remote_hold_preserves_discarded_audio_accounting() {
        let voice = MockVoiceState::new(
            vec![voice_reply(
                "The first sentence. The unplayed second sentence.",
                json!([]),
            )],
            vec![],
            48_000,
        );
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
        )
        .await;
        call.assistant_audio_reaches_trunk().await;
        call.dialog
            .renegotiate(&call.sip, 2, "INVITE", "sendonly", call.rtp_port)
            .await;
        call.update_matching(|params| params["subtitle"] == "On hold")
            .await;
        let snapshot = call.snapshot();
        assert!(snapshot.on_hold);
        let assistant: Vec<_> = snapshot
            .transcript
            .iter()
            .filter(|entry| entry.speaker == TranscriptSpeaker::Assistant)
            .collect();
        assert_eq!(assistant.len(), 1);
        assert_eq!(
            assistant[0].text,
            "[partially spoken sentence] [interrupted]"
        );
        call.agent_hangup().await;
    }

    #[tokio::test]
    async fn interrupting_a_steered_turn_preserves_the_previous_completed_answer() {
        let voice = MockVoiceState::new(
            vec![
                voice_reply("The first answer.", json!([])),
                voice_reply("The second answer is still being spoken.", json!([])),
            ],
            vec![],
            2_400,
        );
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
        )
        .await;
        call.card_shows("The first answer.").await;
        call.outbound_audio_goes_quiet().await;
        *voice.tts_pcm_bytes.lock().await = vec![1; 96_000];
        call.service
            .steer_phone_call(TRUNK_OWNER, &call.call_id, "Ask about the patio.")
            .unwrap();
        call.assistant_audio_reaches_trunk().await;
        call.agent_hangup().await;
        let snapshot = call.settled().await;
        let assistant: Vec<_> = snapshot
            .transcript
            .iter()
            .filter(|entry| entry.speaker == TranscriptSpeaker::Assistant)
            .collect();
        assert_eq!(assistant.len(), 2);
        assert_eq!(assistant[0].text, "The first answer.");
        assert!(!assistant[0].interrupted);
        assert_eq!(
            assistant[1].text,
            "[partially spoken sentence] [interrupted]"
        );
        let report = call.report().await;
        assert!(report.contains("The first answer."));
    }

    #[tokio::test]
    async fn synthesis_failure_preserves_an_already_played_sentence() {
        let voice = MockVoiceState::new(
            vec![voice_reply(
                "The first answer. The second answer.",
                json!([]),
            )],
            vec![],
            2_400,
        );
        voice.tts_fail_after.store(1, Ordering::SeqCst);
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
        )
        .await;
        call.assistant_audio_reaches_trunk().await;
        call.dialog.expect_bye_and_reply_ok(&call.sip).await;
        let snapshot = call.settled().await;
        assert_eq!(snapshot.status, PhoneCallStatus::Failed);
        assert!(snapshot
            .transcript
            .iter()
            .any(|entry| entry.text.starts_with("The first answer.")));
        assert!(!snapshot
            .transcript
            .iter()
            .any(|entry| entry.text.contains("The second answer.")));
        let report = call.report().await;
        assert!(report.starts_with("[Outbound phone call failed]"));
        assert!(report.contains("The first answer."));
    }

    #[tokio::test]
    async fn steering_waits_for_pending_recipient_speech_onset() {
        let voice = MockVoiceState::new(
            vec![voice_reply("Is the patio open?", json!([]))],
            vec!["What would you like to know?"],
            2_400,
        );
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
        )
        .await;
        send_rtp_utterance(
            &call.rtp,
            call.dialog.client_rtp_addr,
            &mut call.seq,
            &mut call.ts,
            6,
            0,
        )
        .await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        call.service
            .steer_phone_call(TRUNK_OWNER, &call.call_id, "Ask about the patio.")
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(voice.chat_requests.lock().await.is_empty());
        call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        call.card_shows("Is the patio open?").await;
        assert_eq!(voice.chat_requests.lock().await.len(), 1);
        call.agent_hangup().await;
    }

    #[tokio::test]
    async fn overlapping_transcriptions_preserve_both_inputs_before_replying() {
        let voice = MockVoiceState::new(
            vec![voice_reply("Thursday, got it.", json!([]))],
            vec![
                "Book for two on Tuesday.",
                "Actually, use Thursday instead.",
            ],
            2_400,
        );
        voice.stt_delay_ms.store(3_000, Ordering::SeqCst);
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
        )
        .await;
        call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        stt_requests_reach(&voice, 1).await;
        call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        call.card_shows("Book for two on Tuesday.").await;
        assert!(voice.chat_requests.lock().await.is_empty());
        call.card_shows("Thursday, got it.").await;
        let snapshot = call.snapshot();
        let recipient: Vec<_> = snapshot
            .transcript
            .iter()
            .filter(|entry| entry.speaker == TranscriptSpeaker::Callee)
            .map(|entry| entry.text.as_str())
            .collect();
        assert_eq!(
            recipient,
            [
                "Book for two on Tuesday.",
                "Actually, use Thursday instead."
            ]
        );
        let requests = voice.chat_requests.lock().await;
        assert_eq!(requests.len(), 1);
        let users: Vec<_> = requests[0]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "user")
            .map(|message| {
                message["content"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("Recipient: ")
                    .unwrap()
            })
            .collect();
        assert_eq!(users, recipient);
        drop(requests);
        call.agent_hangup().await;
        assert_eq!(
            call.settled().await.end_reason.as_deref(),
            Some("agent_hangup")
        );
    }

    #[tokio::test]
    async fn speech_with_missing_packets_or_sparse_comfort_noise_completes_once() {
        for comfort_noise in [false, true] {
            let voice = MockVoiceState::new(
                vec![voice_reply("Thank you for the hours.", json!([]))],
                vec!["We open at nine tomorrow."],
                2_400,
            );
            let mut call = TrunkCall::connect(
                &voice,
                TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
            )
            .await;
            call.callee_speaks(0).await;
            let quiet_started = Instant::now();
            timeout(Duration::from_millis(1_200), async {
                let emit_noise = async {
                    if comfort_noise {
                        for _ in 0..5 {
                            tokio::time::sleep(Duration::from_millis(200)).await;
                            let packet = build_rtp_packet(false, 13, call.seq, call.ts, 1, &[30]);
                            call.rtp
                                .send_to(&packet, call.dialog.client_rtp_addr)
                                .await
                                .unwrap();
                            call.seq = call.seq.wrapping_add(1);
                            call.ts = call.ts.wrapping_add(1_600);
                        }
                    }
                };
                tokio::join!(emit_noise, stt_requests_reach(&voice, 1));
            })
            .await
            .expect("quiet media completes the utterance within twelve hundred milliseconds");
            assert!(quiet_started.elapsed() <= Duration::from_millis(1_200));
            call.card_shows("Thank you for the hours.").await;
            assert_eq!(voice.stt_requests.load(Ordering::SeqCst), 1);
            assert_eq!(voice.chat_requests.lock().await.len(), 1);
            assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
            call.agent_hangup().await;
            assert_eq!(call.settled().await.status, PhoneCallStatus::Completed);
        }
    }

    #[tokio::test]
    async fn steering_during_speech_finishes_only_the_current_sentence_and_fences_actions() {
        for (instruction, should_finish) in [
            ("Do not press one. Ask about parking instead.", true),
            ("Please stop speaking. Ask about parking instead.", false),
            ("Stop! Ask about parking instead.", false),
            (
                "Please stop reading that. Ask about parking instead.",
                false,
            ),
        ] {
            let voice = MockVoiceState::new(
                vec![
                    voice_reply(
                        "Hello, I am calling about hours. I will press one now.",
                        voice_tools(&[("send_dtmf", json!({"digits": "1"}))]),
                    ),
                    voice_reply(
                        "Is there parking?",
                        voice_tools(&[(
                            "wait_silently",
                            json!({"reason": "Awaiting parking", "on_hold": false}),
                        )]),
                    ),
                ],
                vec![],
                24_000,
            );
            let mut call = TrunkCall::connect(
                &voice,
                TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
            )
            .await;
            call.assistant_audio_reaches_trunk().await;
            let steered_at = Instant::now();
            call.service
                .steer_phone_call(TRUNK_OWNER, &call.call_id, instruction)
                .unwrap();
            call.card_shows("Is there parking?").await;
            let snapshot = call.snapshot();
            assert_eq!(snapshot.status, PhoneCallStatus::InProgress);
            assert!(!snapshot.on_hold);
            assert!(!snapshot
                .transcript
                .iter()
                .any(|entry| entry.text.contains("I will press one")));
            let first_turn = &voice.chat_requests.lock().await[1]["messages"].to_string();
            assert!(!first_turn.contains("Sent DTMF digits: 1"));
            assert!(!first_turn.contains("I will press one"));
            if should_finish {
                assert!(first_turn.contains("Hello, I am calling about hours."));
                assert!(steered_at.elapsed() >= Duration::from_millis(700));
            } else {
                assert!(!first_turn.contains("Hello, I am calling about hours."));
                assert!(steered_at.elapsed() < Duration::from_millis(1_500));
            }
            call.agent_hangup().await;
            assert_eq!(call.settled().await.status, PhoneCallStatus::Completed);
        }
    }

    #[tokio::test]
    async fn voice_preparation_finishes_before_sip_and_preserves_cancel_and_failure_controls() {
        for outcome in [
            "ready",
            "cancel",
            "fail",
            "unsupported-stt-ready",
            "unsupported-stt-cancel",
            "unsupported-tts-ready",
            "unsupported-tts-cancel",
            "unsupported-tts-fail",
            "missing-dialogue",
        ] {
            let voice = MockVoiceState::new(
                vec![voice_reply(
                    "",
                    voice_tool(
                        "wait_silently",
                        json!({
                            "reason":"prepared", "on_hold":false
                        }),
                    ),
                )],
                vec![],
                2_400,
            );
            voice.preload_delay_ms.store(1_000, Ordering::SeqCst);
            if outcome == "fail" {
                *voice.preload_status.lock().await = StatusCode::SERVICE_UNAVAILABLE;
            } else if outcome.starts_with("unsupported") || outcome == "missing-dialogue" {
                *voice.preload_status.lock().await = StatusCode::NOT_FOUND;
                if outcome == "missing-dialogue" {
                    voice.stt_delay_ms.store(1_000, Ordering::SeqCst);
                    *voice.chat_status.lock().await = StatusCode::NOT_FOUND;
                } else if outcome.starts_with("unsupported-stt") {
                    voice.stt_delay_ms.store(1_000, Ordering::SeqCst);
                } else if outcome.ends_with("fail") {
                    voice.tts_fail_after.store(0, Ordering::SeqCst);
                } else {
                    voice.tts_chunk_delay_ms.store(1_000, Ordering::SeqCst);
                    *voice.tts_pcm_bytes.lock().await = [0x40_u8, 0x1F].repeat(480);
                }
            }
            let voice_url = spawn_mock_voice_http(Arc::clone(&voice)).await;
            let sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let rtp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let hub = Arc::new(ClientHub::new());
            let (outbox, mut notifications) = client_outbox(256);
            hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
                .await;
            let service = PhoneCallService::with_options(
                Some(sample_runtime_config(
                    sip.local_addr().unwrap().port(),
                    &voice_url,
                )),
                hub,
                Weak::new(),
                PhoneCallTimeouts {
                    approval_timeout: Duration::from_secs(5),
                    max_call_duration: Duration::from_secs(60),
                    opening_greeting_wait: Duration::from_secs(20),
                },
                None,
            );
            let start_service = Arc::clone(&service);
            let start = tokio::spawn(async move {
                start_service
                    .start_phone_call(TRUNK_OWNER, parking_request())
                    .await
            });
            let call_id = await_approval_call_id(&mut notifications).await;
            service
                .resolve_ui_action(&ui_action(
                    &approval_surface_id(&call_id),
                    TRUNK_OWNER,
                    "approve",
                ))
                .await;
            timeout(TEST_TIMEOUT, async {
                while voice.preload_requests.load(Ordering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            if outcome.starts_with("unsupported-stt") {
                stt_requests_reach(&voice, 1).await;
            }
            voice.preload_delay_ms.store(0, Ordering::SeqCst);
            let preparing = service.get_phone_call(TRUNK_OWNER, &call_id).unwrap();
            assert_eq!(preparing.status, PhoneCallStatus::Dialing);
            assert!(preparing.connected_at.is_none());
            assert_eq!(service.snapshot_surfaces().len(), 1);
            let mut packet = [0; 2048];
            assert!(
                timeout(Duration::from_millis(200), sip.recv_from(&mut packet))
                    .await
                    .is_err(),
                "SIP started while voice was still loading: {outcome}"
            );
            match outcome {
                "ready" | "unsupported-stt-ready" | "unsupported-tts-ready" => {
                    let dialog = timeout(
                        TEST_TIMEOUT,
                        MockSipDialog::accept_invite(
                            &sip,
                            rtp.local_addr().unwrap().port(),
                            false,
                            true,
                        ),
                    )
                    .await
                    .unwrap();
                    assert!(timeout(TEST_TIMEOUT, start).await.unwrap().unwrap().is_ok());
                    assert_eq!(
                        service
                            .get_phone_call(TRUNK_OWNER, &call_id)
                            .unwrap()
                            .status,
                        PhoneCallStatus::InProgress
                    );
                    let (hangup, ()) = tokio::join!(
                        service.hangup_phone_call(TRUNK_OWNER, &call_id),
                        dialog.expect_bye_and_reply_ok(&sip)
                    );
                    assert_eq!(hangup.unwrap().status, HangupPhoneCallStatus::HungUp);
                }
                "cancel" | "unsupported-stt-cancel" | "unsupported-tts-cancel" => {
                    assert_eq!(
                        service
                            .hangup_phone_call(TRUNK_OWNER, &call_id)
                            .await
                            .unwrap()
                            .status,
                        HangupPhoneCallStatus::HungUp
                    );
                    assert!(timeout(TEST_TIMEOUT, start)
                        .await
                        .unwrap()
                        .unwrap()
                        .is_err());
                    assert_eq!(
                        service
                            .get_phone_call(TRUNK_OWNER, &call_id)
                            .unwrap()
                            .status,
                        PhoneCallStatus::Cancelled
                    );
                    assert!(
                        timeout(Duration::from_millis(50), sip.recv_from(&mut packet))
                            .await
                            .is_err()
                    );
                }
                "fail" | "unsupported-tts-fail" | "missing-dialogue" => {
                    assert!(timeout(TEST_TIMEOUT, start)
                        .await
                        .unwrap()
                        .unwrap()
                        .is_err());
                    let failed = service.get_phone_call(TRUNK_OWNER, &call_id).unwrap();
                    assert_eq!(failed.status, PhoneCallStatus::Failed);
                    assert!(failed.end_reason.unwrap().contains(if outcome == "fail" {
                        "503"
                    } else if outcome == "missing-dialogue" {
                        "404"
                    } else {
                        "500"
                    }));
                    assert!(
                        timeout(Duration::from_millis(50), sip.recv_from(&mut packet))
                            .await
                            .is_err()
                    );
                }
                _ => unreachable!(),
            }
            timeout(TEST_TIMEOUT, async {
                while service.live_work_count() != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(service.snapshot_surfaces().is_empty());
        }
    }

    #[tokio::test]
    async fn punctuation_only_closing_is_not_a_successful_spoken_goodbye() {
        for native in [true, false] {
            let reply = if native {
                let delta = json!({"choices":[{"delta":{"content":json!({
                    "decision":"end_call","speech":"...","digits":"","on_hold":false,"outcome_summary":"The restaurant closes at nine."
                }).to_string()}}]});
                vec![format!("data: {delta}\n\ndata: [DONE]\n\n").into_bytes()]
            } else {
                voice_reply(
                    "...",
                    voice_tools(&[(
                        "end_call",
                        json!({
                            "reason":"hours_confirmed","outcome_summary":"Closes at nine."
                        }),
                    )]),
                )
            };
            let voice = MockVoiceState::new(vec![reply], vec!["We close at nine tonight."], 2_400);
            let mut call = TrunkCall::connect(
                &voice,
                TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
            )
            .await;
            call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
            timeout(TEST_TIMEOUT, call.dialog.expect_bye_and_reply_ok(&call.sip))
                .await
                .unwrap();
            let card = call
                .update_matching(|params| params["title"] == "Phone call failed")
                .await;
            assert_eq!(card["tone"], "error");
            let snapshot = call.settled().await;
            assert_eq!(snapshot.status, PhoneCallStatus::Failed);
            assert!(voice.tts_requests.lock().await.is_empty());
        }
    }

    #[tokio::test]
    async fn failed_closing_synthesis_settles_as_failed_not_completed() {
        for pcm in [vec![], vec![0x01], [1_u8, 0].repeat(2_400)] {
            let voice = MockVoiceState::new(
                vec![
                    voice_reply("Hello, what time do you close?", json!([])),
                    voice_reply(
                        "Thank you. Goodbye.",
                        voice_tools(&[(
                            "end_call",
                            json!({"reason": "hours_confirmed", "outcome_summary": "Open until nine"}),
                        )]),
                    ),
                ],
                vec!["We close at nine tonight."],
                2_400,
            );
            let mut call = TrunkCall::connect(
                &voice,
                TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
            )
            .await;
            call.card_shows("Hello, what time do you close?").await;
            *voice.tts_pcm_bytes.lock().await = pcm;
            call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
            timeout(TEST_TIMEOUT, call.dialog.expect_bye_and_reply_ok(&call.sip))
                .await
                .unwrap();
            let card = call
                .update_matching(|params| params["title"] == "Phone call failed")
                .await;
            assert_eq!(card["tone"], "error");
            let snapshot = call.settled().await;
            assert_eq!(snapshot.status, PhoneCallStatus::Failed);
            let failure = snapshot.outcome_summary.as_deref().unwrap();
            assert!(
                failure.contains("PCM") || failure.contains("silent after telephone encoding"),
                "{failure}"
            );
            assert!(!snapshot
                .transcript
                .iter()
                .any(|entry| entry.text == "Thank you. Goodbye."));
            let report = call.report().await;
            assert!(report.starts_with("[Outbound phone call failed]"));
            assert!(!report.contains("End reason: hours_confirmed"));
        }
    }

    #[tokio::test]
    async fn transcription_and_assistant_turn_failures_fail_the_call() {
        for transcription_fails in [true, false] {
            let voice = if transcription_fails {
                MockVoiceState::new(Vec::new(), vec![STT_FAILURE_REPLY], 2_400)
            } else {
                MockVoiceState::new(
                    vec![voice_reply(
                        "",
                        voice_tool("send_dtmf", json!({"digits": "9Z"})),
                    )],
                    Vec::new(),
                    2_400,
                )
            };
            let opening = if transcription_fails {
                Duration::from_secs(20)
            } else {
                Duration::from_millis(20)
            };
            let mut call = TrunkCall::connect(
                &voice,
                TrunkCallOptions::new(opening, Duration::from_secs(60)),
            )
            .await;
            if transcription_fails {
                call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
            }
            timeout(TEST_TIMEOUT, call.dialog.expect_bye_and_reply_ok(&call.sip))
                .await
                .expect("a failed call hangs up");
            let failed_card = call
                .update_matching(|params| params["title"] == "Phone call failed")
                .await;
            assert_eq!(failed_card["tone"], "error");
            let snapshot = call.settled().await;
            assert_eq!(snapshot.status, PhoneCallStatus::Failed);
            let expected_error = if transcription_fails {
                "HTTP 500"
            } else {
                "invalid voice tool call 'send_dtmf'"
            };
            let end_reason = snapshot.end_reason.unwrap_or_default();
            assert!(end_reason.contains(expected_error), "{end_reason}");
            let card_rows = failed_card["blocks"][0]["items"].to_string();
            assert!(
                card_rows
                    .contains(r#"{"label":"Reason","value":"The voice assistant hit an error"}"#),
                "{card_rows}"
            );
            assert!(
                card_rows.contains(r#""label":"Details""#) && card_rows.contains(expected_error)
            );
            let report = call.report().await;
            assert!(
                report.starts_with("[Outbound phone call failed]"),
                "{report}"
            );
            assert!(report.contains("Status: failed"), "{report}");
        }
    }
}
