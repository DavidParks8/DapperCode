#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::wildcard_imports,
        reason = "flat sibling modules split from main.rs share crate-root symbols"
    )
)]
use crate::*;
use sha2::{Digest, Sha256};

#[derive(Debug, Default)]
pub(super) struct DurableQueueSubmissions {
    pub(super) results: HashMap<String, BridgeQueueSubmissionReceipt>,
    pub(super) order: VecDeque<String>,
    pub(super) pending: HashMap<String, String>,
    pub(super) pending_order: VecDeque<String>,
}

fn turn_start_contains_agent_message_envelope(turn_start: &Value) -> bool {
    crate::runtime_backend::bridge_prompt(turn_start)
        .is_ok_and(|prompt| crate::agent_messaging::prompt_contains_agent_message_envelope(&prompt))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DurableQueueReceipt {
    thread_id: String,
    turn_id: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DurableQueueReceiptFile {
    #[serde(default)]
    receipts: HashMap<String, DurableQueueReceipt>,
    #[serde(default)]
    order: VecDeque<String>,
    #[serde(default)]
    pending: HashMap<String, String>,
    #[serde(default)]
    pending_order: VecDeque<String>,
}

const QUEUE_RECEIPT_STORE_MAX_BYTES: usize = 1024 * 1024;
const QUEUE_IDENTIFIER_MAX_BYTES: usize = 4096;
const QUEUE_DISPATCH_RETRY_MIN_MS: u64 = 250;
const QUEUE_DISPATCH_RETRY_MAX_MS: u64 = 30_000;
const DEFINITIVE_SETTLEMENT_INTERRUPTED_PREFIX: &str =
    "queue definitive-failure persistence settlement was interrupted by shutdown";
const AGENT_MESSAGE_JOURNAL_UPDATE_ATTEMPTS: usize = 3;
const AGENT_MESSAGE_JOURNAL_UPDATE_RETRY_MS: u64 = 10;
pub(crate) const SCHEDULED_PROMPT_SUBMISSION_PREFIX: &str = "scheduled-prompt:";
const SCHEDULED_PROMPT_PUBLIC_ACTION_ERROR: &str = "scheduled prompts are managed by the scheduler";

fn is_scheduled_prompt_entry(entry: &BridgeQueuedMessageEntry) -> bool {
    entry
        .submission_id
        .starts_with(SCHEDULED_PROMPT_SUBMISSION_PREFIX)
}

fn is_scheduled_prompt_item(runtime: &BridgeThreadQueueRuntime, item_id: &str) -> bool {
    runtime
        .items
        .iter()
        .chain(runtime.pending_steers.iter())
        .chain(
            runtime
                .steer_dispatch_in_flight
                .iter()
                .map(|dispatch| &dispatch.entry),
        )
        .any(|entry| entry.id == item_id && is_scheduled_prompt_entry(entry))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QueueSubmissionCancelOutcome {
    Cancelled,
    NotFound,
    Sent,
}

#[derive(Debug, Default)]
pub(crate) struct ThreadRetirementFence {
    gate: Arc<RwLock<()>>,
    state: std::sync::Mutex<ThreadRetirementFenceState>,
    #[cfg(test)]
    pub(crate) begin_attempted: std::sync::Mutex<Option<Arc<Notify>>>,
    #[cfg(test)]
    pub(crate) admission_acquired: std::sync::Mutex<Option<Arc<Notify>>>,
}

#[derive(Debug, Default)]
struct ThreadRetirementFenceState {
    retiring: HashMap<String, usize>,
    deleted: HashSet<String>,
}

pub(crate) struct ThreadRetirementLease {
    fence: Arc<ThreadRetirementFence>,
    thread_ids: Vec<String>,
    finished: bool,
}

pub(crate) type ThreadRetirementAdmission = tokio::sync::OwnedRwLockReadGuard<()>;
pub(crate) type ThreadRetirementAdmissionBarrier = tokio::sync::OwnedRwLockWriteGuard<()>;

impl ThreadRetirementFence {
    pub(crate) fn is_deleted(&self, thread_id: &str) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .deleted
            .contains(thread_id)
    }

    pub(crate) async fn admit(&self, thread_id: &str) -> Result<ThreadRetirementAdmission, String> {
        self.admit_threads(&[thread_id]).await
    }

    pub(crate) async fn admit_threads(
        &self,
        thread_ids: &[&str],
    ) -> Result<ThreadRetirementAdmission, String> {
        let admission = self.gate.clone().read_owned().await;
        #[cfg(test)]
        let acquired = self
            .admission_acquired
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        #[cfg(test)]
        if let Some(notify) = acquired {
            notify.notify_one();
        }
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if thread_ids.iter().any(|thread_id| {
            state.retiring.contains_key(*thread_id) || state.deleted.contains(*thread_id)
        }) {
            return Err("thread is being deleted".to_string());
        }
        drop(state);
        Ok(admission)
    }

    pub(crate) async fn block_admissions(self: &Arc<Self>) -> ThreadRetirementAdmissionBarrier {
        #[cfg(test)]
        let attempted = self
            .begin_attempted
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        #[cfg(test)]
        if let Some(notify) = attempted {
            notify.notify_one();
        }
        self.gate.clone().write_owned().await
    }

    pub(crate) fn begin_blocked(
        self: &Arc<Self>,
        thread_ids: &[String],
        _barrier: &ThreadRetirementAdmissionBarrier,
    ) -> ThreadRetirementLease {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        for thread_id in thread_ids {
            *state.retiring.entry(thread_id.clone()).or_default() += 1;
        }
        ThreadRetirementLease {
            fence: self.clone(),
            thread_ids: thread_ids.to_vec(),
            finished: false,
        }
    }

    fn mark_deleted_blocked(
        &self,
        thread_ids: &[String],
        _barrier: &ThreadRetirementAdmissionBarrier,
    ) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.deleted.extend(thread_ids.iter().cloned());
    }

    pub(crate) async fn begin(self: &Arc<Self>, thread_ids: &[String]) -> ThreadRetirementLease {
        let barrier = self.block_admissions().await;
        self.begin_blocked(thread_ids, &barrier)
    }
}

impl ThreadRetirementLease {
    fn complete(&self, deleted: bool) {
        let mut state = self
            .fence
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for thread_id in &self.thread_ids {
            if deleted {
                state.deleted.insert(thread_id.clone());
            }
            let remove = state.retiring.get_mut(thread_id).is_some_and(|count| {
                *count -= 1;
                *count == 0
            });
            if remove {
                state.retiring.remove(thread_id);
            }
        }
    }

    pub(crate) async fn finish(mut self) {
        self.complete(false);
        self.finished = true;
    }

    pub(crate) async fn finish_deleted(mut self) {
        self.complete(true);
        self.finished = true;
    }
}

impl Drop for ThreadRetirementLease {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.complete(false);
    }
}

pub(crate) struct QueueThreadRetirement {
    thread_ids: Vec<String>,
    _actor_guards: Vec<tokio::sync::OwnedMutexGuard<()>>,
}

fn dispatch_failure_is_indeterminate(error: &str) -> bool {
    error.starts_with(INDETERMINATE_OPERATION_PREFIX)
}

pub(crate) fn definitive_settlement_was_interrupted(error: &str) -> bool {
    error.starts_with(DEFINITIVE_SETTLEMENT_INTERRUPTED_PREFIX)
}

struct DefinitiveSettlementGuard<'a> {
    active: &'a std::sync::atomic::AtomicUsize,
    notify: &'a Notify,
}

impl Drop for DefinitiveSettlementGuard<'_> {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
        self.notify.notify_waiters();
    }
}

fn submission_source_turn_id(submission_id: &str) -> String {
    format!(
        "queue-{}",
        hex::encode(Sha256::digest(submission_id.as_bytes())),
    )
}

fn normalize_queue_pending(
    pending: &HashMap<String, String>,
    order: &mut VecDeque<String>,
) -> Result<(), String> {
    if pending.len() > SUBMISSION_DEDUPE_LIMIT {
        return Err(format!(
            "queue durable pending state exceeds the {SUBMISSION_DEDUPE_LIMIT}-entry limit",
        ));
    }
    let mut seen = HashSet::new();
    order.retain(|submission_id| {
        pending.contains_key(submission_id) && seen.insert(submission_id.clone())
    });
    let ordered = order.iter().cloned().collect::<HashSet<_>>();
    let mut missing = pending
        .keys()
        .filter(|submission_id| !ordered.contains(*submission_id))
        .cloned()
        .collect::<Vec<_>>();
    missing.sort();
    order.extend(missing);
    Ok(())
}

fn validate_queue_identifier(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    if value.len() > QUEUE_IDENTIFIER_MAX_BYTES {
        return Err(format!(
            "{name} must be at most {QUEUE_IDENTIFIER_MAX_BYTES} bytes",
        ));
    }
    Ok(())
}

fn normalize_retiring_thread_ids(thread_ids: &[String]) -> Result<Vec<String>, String> {
    let mut normalized = thread_ids
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .map(str::to_string)
        .collect::<Vec<_>>();
    for thread_id in &normalized {
        validate_queue_identifier("threadId", thread_id)?;
    }
    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

fn replace_turn_start_text(
    turn_start: &mut Value,
    content: impl Into<String>,
) -> Result<(), String> {
    let input = turn_start
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "queued turnStart input is unavailable".to_string())?;
    let text_input = input
        .iter_mut()
        .find(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "queued turnStart text input is unavailable".to_string())?;
    text_input.insert("text".to_string(), Value::String(content.into()));
    Ok(())
}

impl BridgeQueuedMessageEntry {
    pub(super) fn to_public(&self) -> BridgeQueuedMessage {
        BridgeQueuedMessage {
            id: self.id.clone(),
            created_at: self.created_at.clone(),
            content: self
                .agent_message
                .as_ref()
                .map(|message| message.body.clone())
                .unwrap_or_else(|| self.content.clone()),
            agent_message: self.agent_message.clone(),
        }
    }
}

impl BridgeQueueService {
    #[cfg(test)]
    pub(super) fn new<Backend>(backend: Arc<Backend>, hub: Arc<ClientHub>) -> Arc<Self>
    where
        Backend: QueueRuntimeDispatcher + 'static,
    {
        Self::with_submission_store(backend, hub, None, DurableQueueSubmissions::default())
    }

    pub(super) fn with_submission_store<Backend>(
        backend: Arc<Backend>,
        hub: Arc<ClientHub>,
        submission_store_path: Option<std::path::PathBuf>,
        submissions: DurableQueueSubmissions,
    ) -> Arc<Self>
    where
        Backend: QueueRuntimeDispatcher + 'static,
    {
        let service = Arc::new(Self {
            backend,
            hub,
            threads: Arc::new(RwLock::new(HashMap::new())),
            thread_actors: Arc::new(RwLock::new(HashMap::new())),
            completion_dispositions: Arc::new(Mutex::new(HashMap::new())),
            completion_disposition_notify: Arc::new(Notify::new()),
            submission_results: Arc::new(Mutex::new(submissions.results)),
            submission_order: Arc::new(Mutex::new(submissions.order)),
            submission_volatile_pending: Arc::new(Mutex::new(HashMap::new())),
            submission_pending: Arc::new(Mutex::new(submissions.pending)),
            submission_pending_order: Arc::new(Mutex::new(submissions.pending_order)),
            submission_store_path,
            submission_persist: Arc::new(Mutex::new(())),
            submission_dirty: AtomicBool::new(false),
            definitive_settlement_shutdown: tokio_util::sync::CancellationToken::new(),
            definitive_settlements_active: std::sync::atomic::AtomicUsize::new(0),
            definitive_settlement_notify: Notify::new(),
            interrupted_definitive_settlements: Arc::new(Mutex::new(HashMap::new())),
            retirement_fence: Arc::new(ThreadRetirementFence::default()),
            submission_completion_wake: std::sync::Mutex::new(std::sync::Weak::new()),
            next_queue_item_id: AtomicU64::new(1),
            #[cfg(test)]
            fail_next_submission_persist: AtomicBool::new(false),
            #[cfg(test)]
            fail_all_submission_persists: AtomicBool::new(false),
            #[cfg(test)]
            submission_persist_barrier: std::sync::Mutex::new(None),
            #[cfg(test)]
            retirement_retry_barrier: std::sync::Mutex::new(None),
        });
        service.spawn_notification_loop();
        service
    }

    pub(crate) fn attach_submission_completion_wake(&self, wake: &Arc<Notify>) {
        *self
            .submission_completion_wake
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Arc::downgrade(wake);
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_retirement_retry_barrier(&self) {
        let barrier = {
            self.retirement_retry_barrier
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
        };
        #[cfg(test)]
        if let Some((reached, release)) = barrier {
            let released = release.notified();
            tokio::pin!(released);
            reached.notify_one();
            released.await;
        }
    }

    pub(super) async fn load_submission_store(
        path: &std::path::Path,
    ) -> Result<DurableQueueSubmissions, String> {
        match tokio::fs::read(path).await {
            Ok(bytes) => {
                if bytes.len() > QUEUE_RECEIPT_STORE_MAX_BYTES {
                    return Err(format!(
                        "queue idempotency state exceeds {QUEUE_RECEIPT_STORE_MAX_BYTES} bytes",
                    ));
                }
                let mut state: DurableQueueReceiptFile = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("invalid queue idempotency state: {error}"))?;
                while state.order.len() > SUBMISSION_DEDUPE_LIMIT {
                    if let Some(oldest) = state.order.pop_front() {
                        state.receipts.remove(&oldest);
                    }
                }
                let retained = state.order.iter().cloned().collect::<HashSet<_>>();
                state.receipts.retain(|key, _| retained.contains(key));
                normalize_queue_pending(&state.pending, &mut state.pending_order)?;
                let results = state
                    .receipts
                    .into_iter()
                    .map(|(submission_id, receipt)| {
                        let response = BridgeQueueSubmissionReceipt {
                            submission_id: submission_id.clone(),
                            disposition: BridgeThreadQueueDisposition::Sent,
                            thread_id: receipt.thread_id,
                            turn_id: Some(receipt.turn_id),
                        };
                        (submission_id, response)
                    })
                    .collect();
                Ok(DurableQueueSubmissions {
                    results,
                    order: state.order,
                    pending: state.pending,
                    pending_order: state.pending_order,
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(DurableQueueSubmissions::default())
            }
            Err(error) => Err(format!("failed to read queue idempotency state: {error}")),
        }
    }

    pub(super) fn next_queued_message_id(&self) -> String {
        format!(
            "queue-{}",
            self.next_queue_item_id.fetch_add(1, Ordering::Relaxed),
        )
    }

    pub(super) async fn thread_actor(&self, thread_id: &str) -> Arc<Mutex<()>> {
        let actor = self.thread_actors.read().await.get(thread_id).cloned();
        if let Some(actor) = actor {
            return actor;
        }
        let mut actors = self.thread_actors.write().await;
        actors
            .entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub(super) fn spawn_notification_loop(self: &Arc<Self>) {
        let this = Arc::clone(self);
        let mut receiver = this.hub.subscribe_canonical_events();
        tokio::spawn(async move {
            while let Some(event) = receiver.recv().await {
                this.handle_canonical_event(event).await;
            }
        });
    }

    pub(super) async fn read_queue(&self, thread_id: &str) -> BridgeThreadQueueState {
        let normalized_thread_id = thread_id.trim();
        if normalized_thread_id.is_empty() {
            return BridgeThreadQueueState {
                thread_id: String::new(),
                items: Vec::new(),
                pending_steers: Vec::new(),
                pending_steer_count: 0,
                editing_item_id: None,
                waiting_for_tool_calls: false,
                steering_in_flight: false,
                last_error: None,
            };
        }

        let threads = self.threads.read().await;
        let runtime = threads.get(normalized_thread_id);
        Self::snapshot_for_thread(normalized_thread_id, runtime)
    }

    pub(super) async fn status(&self) -> QueueStatus {
        if self.submission_dirty.load(Ordering::Acquire) {
            let _ = self.persist_submission_store().await;
        }
        let durable_blockers = usize::from(self.submission_dirty.load(Ordering::Acquire))
            .saturating_add(self.definitive_settlements_active.load(Ordering::Acquire));
        let threads = self.threads.read().await;
        QueueStatus {
            tracked_threads: threads.len(),
            depth: threads.values().map(|runtime| runtime.items.len()).sum(),
            busy_threads: threads
                .values()
                .filter(|runtime| Self::runtime_is_blocked_or_occupied(runtime))
                .count(),
            active_runs: threads
                .values()
                .filter(|runtime| {
                    runtime.thread_running
                        || runtime.active_run_id.is_some()
                        || runtime.turn_start_in_flight
                })
                .count(),
            pending_steers: threads
                .values()
                .map(|runtime| {
                    runtime.pending_steers.len()
                        + usize::from(runtime.steer_dispatch_in_flight.is_some())
                })
                .sum(),
            pending_approvals: threads
                .values()
                .map(|runtime| runtime.pending_approval_ids.len())
                .sum(),
            pending_user_inputs: threads
                .values()
                .map(|runtime| runtime.pending_user_input_ids.len())
                .sum(),
            other_live_work: threads
                .values()
                .map(|runtime| {
                    usize::from(runtime.editing_item_id.is_some())
                        + usize::from(runtime.steer_prepare_in_flight)
                        + usize::from(runtime.action_in_flight_item_id.is_some())
                        + runtime.pending_completion_event_ids.len()
                })
                .sum::<usize>()
                .saturating_add(durable_blockers),
        }
    }

    pub(super) async fn record_completion_disposition(
        &self,
        event_id: u64,
        disposition: QueueCompletionDisposition,
    ) {
        let mut dispositions = self.completion_dispositions.lock().await;
        if dispositions.len() >= QUEUE_COMPLETION_DISPOSITION_LIMIT {
            if let Some(oldest_event_id) = dispositions.keys().min().copied() {
                dispositions.remove(&oldest_event_id);
            }
        }
        dispositions.insert(event_id, disposition);
        drop(dispositions);
        self.completion_disposition_notify.notify_waiters();
    }

    pub(super) async fn wait_for_completion_disposition(
        &self,
        event_id: u64,
    ) -> Option<QueueCompletionDisposition> {
        let deadline = Instant::now() + Duration::from_millis(QUEUE_COMPLETION_DISPOSITION_WAIT_MS);
        loop {
            let notified = self.completion_disposition_notify.notified();
            let disposition = self.completion_dispositions.lock().await.remove(&event_id);
            if let Some(disposition) = disposition {
                return Some(disposition);
            }

            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            if timeout(deadline.saturating_duration_since(now), notified)
                .await
                .is_err()
            {
                return None;
            }
        }
    }

    pub(super) async fn send_message(
        &self,
        request: BridgeThreadQueueSendRequest,
    ) -> Result<BridgeThreadQueueSendResponse, String> {
        if turn_start_contains_agent_message_envelope(&request.turn_start) {
            return Err("agent message envelopes are reserved for the bridge".to_string());
        }
        if request
            .submission_id
            .trim()
            .starts_with(SCHEDULED_PROMPT_SUBMISSION_PREFIX)
        {
            return Err("scheduled prompt submission IDs are reserved for the bridge".to_string());
        }
        self.send_message_with_origin(request, None, None).await
    }

    #[cfg(test)]
    pub(crate) async fn send_scheduled_prompt(
        &self,
        request: BridgeThreadQueueSendRequest,
    ) -> Result<BridgeThreadQueueSendResponse, String> {
        if turn_start_contains_agent_message_envelope(&request.turn_start) {
            return Err("agent message envelopes are reserved for the bridge".to_string());
        }
        if !request
            .submission_id
            .trim()
            .starts_with(SCHEDULED_PROMPT_SUBMISSION_PREFIX)
        {
            return Err("scheduled prompt submission ID must use the reserved prefix".to_string());
        }
        self.send_message_with_origin(request, None, None).await
    }

    pub(crate) async fn send_scheduled_prompt_admitted(
        &self,
        request: BridgeThreadQueueSendRequest,
        retirement_admission: &ThreadRetirementAdmission,
    ) -> Result<BridgeThreadQueueSendResponse, String> {
        if turn_start_contains_agent_message_envelope(&request.turn_start) {
            return Err("agent message envelopes are reserved for the bridge".to_string());
        }
        if !request
            .submission_id
            .trim()
            .starts_with(SCHEDULED_PROMPT_SUBMISSION_PREFIX)
        {
            return Err("scheduled prompt submission ID must use the reserved prefix".to_string());
        }
        self.send_message_with_origin(request, None, Some(retirement_admission))
            .await
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
    async fn send_message_with_origin(
        &self,
        request: BridgeThreadQueueSendRequest,
        agent_message: Option<crate::agent_messaging::AgentMessageOrigin>,
        retirement_admission: Option<&ThreadRetirementAdmission>,
    ) -> Result<BridgeThreadQueueSendResponse, String> {
        let normalized_thread_id = request.thread_id.trim().to_string();
        let submission_id = request.submission_id.trim().to_string();
        let content = request.content.trim().to_string();
        validate_queue_identifier("threadId", &normalized_thread_id)?;
        if content.is_empty() {
            return Err("content must not be empty".to_string());
        }
        if submission_id.is_empty() {
            return Err("submissionId must not be empty".to_string());
        }
        if submission_id.len() > PUSH_ID_MAX_BYTES {
            return Err(format!(
                "submissionId must be at most {PUSH_ID_MAX_BYTES} bytes",
            ));
        }
        if content.len() > QUEUE_MAX_CONTENT_BYTES {
            return Err(format!(
                "queue content exceeds {QUEUE_MAX_CONTENT_BYTES} bytes (actual {})",
                content.len(),
            ));
        }
        let item_bytes = serde_json::to_vec(&request.turn_start)
            .map(|value| value.len())
            .unwrap_or(usize::MAX)
            .saturating_add(content.len());
        if item_bytes > QUEUE_MAX_ITEM_BYTES {
            return Err(format!(
                "queue item exceeds {QUEUE_MAX_ITEM_BYTES} bytes (actual {item_bytes})",
            ));
        }

        let acquired_admission = if retirement_admission.is_none() {
            Some(self.retirement_fence.admit(&normalized_thread_id).await?)
        } else {
            None
        };
        let _retirement_admission = retirement_admission.or(acquired_admission.as_ref());
        self.ensure_thread_runtime(&normalized_thread_id).await?;
        let actor = self.thread_actor(&normalized_thread_id).await;
        let _actor_guard = actor.lock().await;
        if let Some(result) = self
            .lookup_submission(&submission_id, &normalized_thread_id)
            .await?
        {
            return Ok(result);
        }

        let queued_item_id = self.next_queued_message_id();
        let queued_item = BridgeQueuedMessageEntry {
            id: queued_item_id.clone(),
            submission_id: submission_id.clone(),
            created_at: now_iso(),
            content,
            turn_start: request.turn_start,
            agent_message,
        };

        let should_queue = {
            let threads = self.threads.read().await;
            let runtime = threads.get(&normalized_thread_id);
            runtime.is_some_and(Self::runtime_is_blocked_or_occupied)
        };

        if should_queue {
            let snapshot = {
                let mut threads = self.threads.write().await;
                let runtime = threads
                    .entry(normalized_thread_id.clone())
                    .or_insert_with(BridgeThreadQueueRuntime::default);
                if runtime.items.len() >= QUEUE_MAX_ITEMS_PER_THREAD {
                    return Err(format!(
                        "queue limit reached for thread (max {QUEUE_MAX_ITEMS_PER_THREAD})",
                    ));
                }
                let queued_bytes = runtime
                    .items
                    .iter()
                    .map(|item| {
                        item.content.len()
                            + serde_json::to_vec(&item.turn_start)
                                .map(|value| value.len())
                                .unwrap_or(usize::MAX)
                    })
                    .sum::<usize>();
                if queued_bytes.saturating_add(item_bytes) > QUEUE_MAX_BYTES_PER_THREAD {
                    return Err(format!(
                        "resource_limit:queue_thread_bytes:{QUEUE_MAX_BYTES_PER_THREAD}:{}",
                        queued_bytes.saturating_add(item_bytes),
                    ));
                }
                runtime.items.push_back(queued_item);
                runtime.last_error = None;
                Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
            };
            match self
                .reserve_submission(&submission_id, &normalized_thread_id, false)
                .await
            {
                Ok(Some(result)) => {
                    if let Some(runtime) = self.threads.write().await.get_mut(&normalized_thread_id)
                    {
                        runtime.items.retain(|item| item.id != queued_item_id);
                    }
                    return Ok(result);
                }
                Ok(None) => {}
                Err(error) => {
                    if let Some(runtime) = self.threads.write().await.get_mut(&normalized_thread_id)
                    {
                        runtime.items.retain(|item| item.id != queued_item_id);
                    }
                    return Err(error);
                }
            }
            self.broadcast_snapshot(&snapshot).await;
            let result = BridgeThreadQueueSendResponse {
                submission_id,
                disposition: BridgeThreadQueueDisposition::Queued,
                queue: snapshot,
                turn_id: None,
            };
            self.remember_submission_result(result.clone()).await?;
            return Ok(result);
        }

        if let Some(result) = self
            .reserve_submission(&submission_id, &normalized_thread_id, true)
            .await?
        {
            return Ok(result);
        }
        {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .entry(normalized_thread_id.clone())
                .or_insert_with(BridgeThreadQueueRuntime::default);
            runtime.turn_start_in_flight = true;
            runtime.last_error = None;
        }

        match self
            .dispatch_turn_start(
                &normalized_thread_id,
                &queued_item.turn_start,
                &submission_source_turn_id(&submission_id),
            )
            .await
        {
            Ok(turn_id) => {
                let snapshot = {
                    let mut threads = self.threads.write().await;
                    let runtime = threads
                        .entry(normalized_thread_id.clone())
                        .or_insert_with(BridgeThreadQueueRuntime::default);
                    runtime.turn_start_in_flight = false;
                    runtime.thread_running = true;
                    runtime.active_turn_id = Some(turn_id.clone());
                    runtime.last_error = None;
                    Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
                };
                let result = BridgeThreadQueueSendResponse {
                    submission_id,
                    disposition: BridgeThreadQueueDisposition::Sent,
                    queue: snapshot,
                    turn_id: Some(turn_id),
                };
                self.remember_submission_result(result.clone()).await?;
                Ok(result)
            }
            Err(error) => {
                {
                    let mut threads = self.threads.write().await;
                    if let Some(runtime) = threads.get_mut(&normalized_thread_id) {
                        runtime.turn_start_in_flight = false;
                        runtime.last_error = Some(BridgeThreadQueueError {
                            message: error.clone(),
                            operation: "dispatch".to_string(),
                            at: now_iso(),
                            item_id: Some(queued_item.id),
                        });
                        runtime.last_error_submission_id = Some(submission_id.clone());
                    }
                }
                if !dispatch_failure_is_indeterminate(&error) {
                    let _settlement = self.track_definitive_settlement();
                    self.settle_definitive_dispatch_failure(
                        &submission_id,
                        &normalized_thread_id,
                        &error,
                    )
                    .await?;
                }
                Err(error)
            }
        }
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(crate) async fn send_agent_message(
        self: &Arc<Self>,
        envelope: &crate::agent_messaging::AgentMessageEnvelope,
        recipient_origin: crate::agent_messaging::AgentMessageOrigin,
        sender_origin: crate::agent_messaging::AgentMessageOrigin,
    ) -> Result<crate::agent_messaging::AgentMessageDisposition, String> {
        let content = envelope
            .encode()
            .map_err(|error| format!("failed to encode agent message: {error}"))?;
        let submission_id = format!("agent-message:{}", envelope.message_id);
        let retirement_admission = self
            .retirement_fence
            .admit_threads(&[&envelope.sender_thread_id, &envelope.recipient_thread_id])
            .await?;
        self.backend
            .record_agent_messages(vec![
                (
                    envelope.recipient_thread_id.clone(),
                    recipient_origin.clone(),
                ),
                (envelope.sender_thread_id.clone(), sender_origin.clone()),
            ])
            .await?;
        let result = match self
            .send_message_with_origin(
                BridgeThreadQueueSendRequest {
                    thread_id: envelope.recipient_thread_id.clone(),
                    submission_id: submission_id.clone(),
                    content: content.clone(),
                    turn_start: serde_json::json!({
                        "input": [{
                            "type": "text",
                            "text": content,
                            "text_elements": [],
                        }],
                    }),
                },
                Some(recipient_origin),
                Some(&retirement_admission),
            )
            .await
        {
            Ok(result) => result,
            Err(error) => {
                if dispatch_failure_is_indeterminate(&error) {
                    if let Err(update_error) = self
                        .persist_agent_message_disposition(
                            &envelope.message_id,
                            crate::agent_messaging::AgentMessageDisposition::Cancelled,
                        )
                        .await
                    {
                        eprintln!(
                            "failed to settle indeterminate agent-message activity {}: {update_error}",
                            envelope.message_id,
                        );
                    }
                } else if let Err(remove_error) = self
                    .backend
                    .remove_agent_message(&envelope.message_id)
                    .await
                {
                    eprintln!(
                        "failed to remove rejected agent-message activity {}: {remove_error}",
                        envelope.message_id,
                    );
                }
                return Err(error);
            }
        };
        let disposition = if matches!(result.disposition, BridgeThreadQueueDisposition::Sent) {
            crate::agent_messaging::AgentMessageDisposition::Sent
        } else {
            let item_id = self
                .threads
                .read()
                .await
                .get(&envelope.recipient_thread_id)
                .and_then(|runtime| {
                    runtime
                        .items
                        .iter()
                        .find(|item| item.submission_id == submission_id)
                })
                .map(|item| item.id.clone());
            match item_id {
                Some(item_id)
                    if self
                        .backend
                        .supports_steer(&envelope.recipient_thread_id)
                        .unwrap_or(false) =>
                {
                    match self
                        .steer_message_inner(
                            BridgeThreadQueueSteerRequest {
                                thread_id: envelope.recipient_thread_id.clone(),
                                item_id,
                            },
                            true,
                        )
                        .await
                    {
                        Ok(_) => crate::agent_messaging::AgentMessageDisposition::Steering,
                        Err(_) => crate::agent_messaging::AgentMessageDisposition::Queued,
                    }
                }
                _ => crate::agent_messaging::AgentMessageDisposition::Queued,
            }
        };
        if disposition == crate::agent_messaging::AgentMessageDisposition::Queued {
            self.backend
                .publish_agent_message(&envelope.message_id)
                .await;
        } else if let Err(error) = self
            .persist_agent_message_disposition(&envelope.message_id, disposition)
            .await
        {
            eprintln!(
                "failed to persist accepted agent-message activity {}: {error}",
                envelope.message_id,
            );
            self.backend
                .publish_agent_message(&envelope.message_id)
                .await;
        }
        if disposition == crate::agent_messaging::AgentMessageDisposition::Steering {
            self.spawn_steer_dispatch(envelope.recipient_thread_id.clone());
        }
        Ok(disposition)
    }

    async fn persist_agent_message_disposition(
        &self,
        message_id: &str,
        disposition: crate::agent_messaging::AgentMessageDisposition,
    ) -> Result<(), String> {
        let mut last_error = None;
        for attempt in 0..AGENT_MESSAGE_JOURNAL_UPDATE_ATTEMPTS {
            match self
                .backend
                .update_agent_message_disposition(message_id, disposition)
                .await
            {
                Ok(()) => return Ok(()),
                Err(error) => last_error = Some(error),
            }
            if attempt + 1 < AGENT_MESSAGE_JOURNAL_UPDATE_ATTEMPTS {
                tokio::time::sleep(Duration::from_millis(AGENT_MESSAGE_JOURNAL_UPDATE_RETRY_MS))
                    .await;
            }
        }
        Err(last_error.unwrap_or_else(|| "agent-message journal update failed".to_string()))
    }

    async fn lookup_submission(
        &self,
        submission_id: &str,
        thread_id: &str,
    ) -> Result<Option<BridgeThreadQueueSendResponse>, String> {
        let persist_guard = self.submission_persist.lock().await;
        let pending_thread_id = self
            .submission_pending
            .lock()
            .await
            .get(submission_id)
            .cloned();
        if let Some(pending_thread_id) = pending_thread_id {
            if pending_thread_id != thread_id {
                return Err("submissionId is already bound to another thread".to_string());
            }
            return Err(
                "submission outcome is indeterminate after a worker interruption; refresh the thread before choosing a new submissionId"
                    .to_string(),
            );
        }
        let completed = {
            self.submission_results
                .lock()
                .await
                .get(submission_id)
                .cloned()
        };
        if let Some(result) = completed {
            if result.thread_id != thread_id {
                return Err("submissionId is already bound to another thread".to_string());
            }
            self.persist_submission_store_locked().await?;
            drop(persist_guard);
            return Ok(Some(self.submission_response(result).await));
        }
        let pending_thread_id = self
            .submission_volatile_pending
            .lock()
            .await
            .get(submission_id)
            .cloned();
        if let Some(pending_thread_id) = pending_thread_id {
            if pending_thread_id != thread_id {
                return Err("submissionId is already bound to another thread".to_string());
            }
            return Err("submissionId is already being queued".to_string());
        }
        Ok(None)
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn reserve_submission(
        &self,
        submission_id: &str,
        thread_id: &str,
        persist_pending: bool,
    ) -> Result<Option<BridgeThreadQueueSendResponse>, String> {
        let persist_guard = self.submission_persist.lock().await;
        {
            let pending = self.submission_pending.lock().await;
            if let Some(pending_thread_id) = pending.get(submission_id) {
                if pending_thread_id != thread_id {
                    return Err("submissionId is already bound to another thread".to_string());
                }
                return Err(
                    "submission outcome is indeterminate after a worker interruption; refresh the thread before choosing a new submissionId"
                        .to_string(),
                );
            }
        }
        let completed = {
            self.submission_results
                .lock()
                .await
                .get(submission_id)
                .cloned()
        };
        if let Some(result) = completed {
            if result.thread_id != thread_id {
                return Err("submissionId is already bound to another thread".to_string());
            }
            self.persist_submission_store_locked().await?;
            drop(persist_guard);
            return Ok(Some(self.submission_response(result).await));
        }
        {
            let volatile_pending = self.submission_volatile_pending.lock().await;
            if let Some(pending_thread_id) = volatile_pending.get(submission_id) {
                if pending_thread_id != thread_id {
                    return Err("submissionId is already bound to another thread".to_string());
                }
                return Err("submissionId is already being queued".to_string());
            }
        }
        if !persist_pending {
            self.submission_volatile_pending
                .lock()
                .await
                .insert(submission_id.to_string(), thread_id.to_string());
            return Ok(None);
        }

        let previous_pending = self.submission_pending.lock().await.clone();
        let previous_order = self.submission_pending_order.lock().await.clone();
        {
            let mut pending = self.submission_pending.lock().await;
            let mut pending_order = self.submission_pending_order.lock().await;
            if pending.len() >= SUBMISSION_DEDUPE_LIMIT {
                return Err(format!(
                    "queue durable pending admission limit reached (max {SUBMISSION_DEDUPE_LIMIT})",
                ));
            }
            pending.insert(submission_id.to_string(), thread_id.to_string());
            pending_order.push_back(submission_id.to_string());
        }
        if let Err(error) = self.persist_submission_store_locked().await {
            *self.submission_pending.lock().await = previous_pending;
            *self.submission_pending_order.lock().await = previous_order;
            let _ = self.persist_submission_store_locked().await;
            return Err(error);
        }
        Ok(None)
    }

    async fn release_submission(&self, submission_id: &str) -> Result<(), String> {
        let _persist = self.submission_persist.lock().await;
        let mut pending = self.submission_pending.lock().await.clone();
        if pending.remove(submission_id).is_none() {
            self.submission_volatile_pending
                .lock()
                .await
                .remove(submission_id);
            return Ok(());
        }
        let mut pending_order = self.submission_pending_order.lock().await.clone();
        pending_order.retain(|candidate| candidate != submission_id);
        let results = self.submission_results.lock().await.clone();
        let order = self.submission_order.lock().await.clone();
        self.persist_submission_snapshot_locked(&results, &order, &pending, &pending_order)
            .await?;
        *self.submission_pending.lock().await = pending;
        *self.submission_pending_order.lock().await = pending_order;
        self.submission_volatile_pending
            .lock()
            .await
            .remove(submission_id);
        Ok(())
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_nesting,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn settle_definitive_dispatch_failure(
        &self,
        submission_id: &str,
        thread_id: &str,
        dispatch_error: &str,
    ) -> Result<(), String> {
        let mut attempt = 0_u32;
        loop {
            attempt = attempt.saturating_add(1);
            match self.release_submission(submission_id).await {
                Ok(()) => return Ok(()),
                Err(persist_error) => {
                    eprintln!(
                        "failed to settle definitive queue dispatch failure for submission \
                         {submission_id} on attempt {attempt}: {persist_error}; retrying",
                    );
                    if self.definitive_settlement_shutdown.is_cancelled() {
                        let error = format!(
                            "{DEFINITIVE_SETTLEMENT_INTERRUPTED_PREFIX}; dispatch failed: \
                             {dispatch_error}; last persistence error: {persist_error}",
                        );
                        if submission_id.starts_with(SCHEDULED_PROMPT_SUBMISSION_PREFIX) {
                            self.interrupted_definitive_settlements.lock().await.insert(
                                submission_id.to_string(),
                                (thread_id.to_string(), error.clone()),
                            );
                        }
                        return Err(error);
                    }
                    let shift = attempt.saturating_sub(1).min(16);
                    let delay_ms = QUEUE_DISPATCH_RETRY_MIN_MS
                        .saturating_mul(1_u64 << shift)
                        .min(QUEUE_DISPATCH_RETRY_MAX_MS);
                    tokio::select! {
                        _ = self.definitive_settlement_shutdown.cancelled() => {
                            let error = format!(
                                "{DEFINITIVE_SETTLEMENT_INTERRUPTED_PREFIX}; dispatch failed: \
                                 {dispatch_error}; last persistence error: {persist_error}"
                            );
                            if submission_id.starts_with(SCHEDULED_PROMPT_SUBMISSION_PREFIX) {
                                self.interrupted_definitive_settlements
                                    .lock()
                                    .await
                                    .insert(
                                        submission_id.to_string(),
                                        (thread_id.to_string(), error.clone()),
                                    );
                            }
                            return Err(error);
                        }
                        _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                    }
                }
            }
        }
    }

    fn track_definitive_settlement(&self) -> DefinitiveSettlementGuard<'_> {
        self.definitive_settlements_active
            .fetch_add(1, Ordering::AcqRel);
        DefinitiveSettlementGuard {
            active: &self.definitive_settlements_active,
            notify: &self.definitive_settlement_notify,
        }
    }

    pub(crate) async fn settle_interrupted_definitive_failure(
        &self,
        thread_id: &str,
        submission_id: &str,
        dispatch_error: &str,
    ) -> Result<(), String> {
        let owner = self
            .submission_pending
            .lock()
            .await
            .get(submission_id)
            .cloned();
        if owner.as_deref().is_some_and(|owner| owner != thread_id) {
            return Err("submissionId is already bound to another thread".to_string());
        }
        let _settlement = self.track_definitive_settlement();
        self.settle_definitive_dispatch_failure(submission_id, thread_id, dispatch_error)
            .await
    }

    pub(crate) fn begin_definitive_settlement_shutdown(&self) {
        self.definitive_settlement_shutdown.cancel();
    }

    pub(crate) async fn wait_for_definitive_settlements(&self) {
        loop {
            let notified = self.definitive_settlement_notify.notified();
            if self.definitive_settlements_active.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }

    pub(crate) async fn interrupted_definitive_settlements(
        &self,
    ) -> HashMap<String, (String, String)> {
        self.interrupted_definitive_settlements.lock().await.clone()
    }

    pub(crate) async fn clear_interrupted_definitive_settlements(&self, submission_ids: &[String]) {
        let mut interrupted = self.interrupted_definitive_settlements.lock().await;
        for submission_id in submission_ids {
            interrupted.remove(submission_id);
        }
    }

    async fn mark_submission_dispatch_pending(
        &self,
        submission_id: &str,
        thread_id: &str,
    ) -> Result<(), String> {
        let _persist = self.submission_persist.lock().await;
        if self
            .submission_volatile_pending
            .lock()
            .await
            .get(submission_id)
            .is_some_and(|existing_thread_id| existing_thread_id != thread_id)
        {
            return Err("submissionId is already bound to another thread".to_string());
        }
        let previous_pending = self.submission_pending.lock().await.clone();
        let previous_order = self.submission_pending_order.lock().await.clone();
        {
            let mut pending = self.submission_pending.lock().await;
            let mut pending_order = self.submission_pending_order.lock().await;
            if let Some(existing_thread_id) = pending.get(submission_id) {
                if existing_thread_id != thread_id {
                    return Err("submissionId is already bound to another thread".to_string());
                }
            } else {
                if pending.len() >= SUBMISSION_DEDUPE_LIMIT {
                    return Err(format!(
                        "queue durable pending admission limit reached (max {SUBMISSION_DEDUPE_LIMIT})",
                    ));
                }
                pending.insert(submission_id.to_string(), thread_id.to_string());
                pending_order.push_back(submission_id.to_string());
            }
        }
        if let Err(error) = self.persist_submission_store_locked().await {
            *self.submission_pending.lock().await = previous_pending;
            *self.submission_pending_order.lock().await = previous_order;
            let _ = self.persist_submission_store_locked().await;
            return Err(error);
        }
        self.submission_volatile_pending
            .lock()
            .await
            .remove(submission_id);
        Ok(())
    }

    async fn forget_submission_result(&self, submission_id: &str) -> Result<(), String> {
        let _persist = self.submission_persist.lock().await;
        self.forget_submission_result_locked(submission_id).await
    }

    async fn forget_submission_result_locked(&self, submission_id: &str) -> Result<(), String> {
        self.submission_results.lock().await.remove(submission_id);
        self.submission_order
            .lock()
            .await
            .retain(|candidate| candidate != submission_id);
        self.submission_pending.lock().await.remove(submission_id);
        self.submission_pending_order
            .lock()
            .await
            .retain(|candidate| candidate != submission_id);
        self.submission_volatile_pending
            .lock()
            .await
            .remove(submission_id);
        self.persist_submission_store_locked().await
    }

    async fn submission_response(
        &self,
        receipt: BridgeQueueSubmissionReceipt,
    ) -> BridgeThreadQueueSendResponse {
        BridgeThreadQueueSendResponse {
            submission_id: receipt.submission_id,
            disposition: receipt.disposition,
            queue: self.read_queue(&receipt.thread_id).await,
            turn_id: receipt.turn_id,
        }
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(super) async fn remember_submission_result(
        &self,
        result: BridgeThreadQueueSendResponse,
    ) -> Result<(), String> {
        let _persist = self.submission_persist.lock().await;
        let was_sent = matches!(&result.disposition, BridgeThreadQueueDisposition::Sent);
        let submission_id = result.submission_id.clone();
        let receipt = BridgeQueueSubmissionReceipt {
            submission_id: submission_id.clone(),
            thread_id: result.queue.thread_id,
            disposition: result.disposition,
            turn_id: result.turn_id,
        };
        let receipt_thread_id = receipt.thread_id.clone();
        let mut results = self.submission_results.lock().await;
        let mut order = self.submission_order.lock().await;
        if results.insert(submission_id.clone(), receipt).is_none() {
            order.push_back(submission_id.clone());
        }
        while order.len() > SUBMISSION_DEDUPE_LIMIT {
            if let Some(oldest) = order.pop_front() {
                results.remove(&oldest);
            }
        }
        drop(order);
        drop(results);
        if was_sent {
            self.submission_volatile_pending
                .lock()
                .await
                .remove(&submission_id);
            self.submission_pending.lock().await.remove(&submission_id);
            self.submission_pending_order
                .lock()
                .await
                .retain(|candidate| candidate != &submission_id);
        } else {
            self.submission_pending.lock().await.remove(&submission_id);
            self.submission_pending_order
                .lock()
                .await
                .retain(|candidate| candidate != &submission_id);
            self.submission_volatile_pending
                .lock()
                .await
                .insert(submission_id.clone(), receipt_thread_id);
        }
        self.persist_submission_store_locked().await?;
        if was_sent {
            let wake = self
                .submission_completion_wake
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .upgrade();
            if let Some(wake) = wake {
                wake.notify_one();
            }
        }
        Ok(())
    }

    async fn remember_sent_submission_until_persisted(
        &self,
        result: BridgeThreadQueueSendResponse,
        operation: &str,
    ) {
        let submission_id = result.submission_id.clone();
        let mut attempt = 0_u32;
        loop {
            attempt = attempt.saturating_add(1);
            match self.remember_submission_result(result.clone()).await {
                Ok(()) => return,
                Err(error) => {
                    eprintln!(
                        "failed to persist {operation} queue submission {submission_id} on attempt {attempt}: {error}; retrying",
                    );
                    let shift = attempt.saturating_sub(1).min(16);
                    let delay_ms = QUEUE_DISPATCH_RETRY_MIN_MS
                        .saturating_mul(1_u64 << shift)
                        .min(QUEUE_DISPATCH_RETRY_MAX_MS);
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
            }
        }
    }

    async fn persist_submission_store(&self) -> Result<(), String> {
        let _persist = self.submission_persist.lock().await;
        self.persist_submission_store_locked().await
    }

    async fn persist_submission_store_locked(&self) -> Result<(), String> {
        let results = self.submission_results.lock().await.clone();
        let order = self.submission_order.lock().await.clone();
        let pending = self.submission_pending.lock().await.clone();
        let pending_order = self.submission_pending_order.lock().await.clone();
        self.persist_submission_snapshot_locked(&results, &order, &pending, &pending_order)
            .await
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    #[cfg_attr(
        all(test, dylint_lib = "perfectionist"),
        expect(
            perfectionist::excessive_cognitive_complexity,
            reason = "test barrier instrumentation pushes cognitive complexity above cap only under cfg(test)"
        )
    )]
    async fn persist_submission_snapshot_locked(
        &self,
        results: &HashMap<String, BridgeQueueSubmissionReceipt>,
        order: &VecDeque<String>,
        pending: &HashMap<String, String>,
        pending_order: &VecDeque<String>,
    ) -> Result<(), String> {
        #[cfg(test)]
        {
            let barrier = {
                self.submission_persist_barrier
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take()
            };
            if let Some((reached, release)) = barrier {
                let released = release.notified();
                tokio::pin!(released);
                reached.notify_one();
                released.await;
            }
        }
        #[cfg(test)]
        if self.fail_all_submission_persists.load(Ordering::Acquire)
            || self
                .fail_next_submission_persist
                .swap(false, Ordering::AcqRel)
        {
            self.submission_dirty.store(true, Ordering::Release);
            return Err("injected queue idempotency persistence failure".to_string());
        }
        let Some(path) = &self.submission_store_path else {
            self.submission_dirty.store(false, Ordering::Release);
            return Ok(());
        };
        let pending = pending.clone();
        let mut pending_order = pending_order.clone();
        normalize_queue_pending(&pending, &mut pending_order)?;
        let mut snapshot = DurableQueueReceiptFile {
            pending,
            pending_order,
            ..DurableQueueReceiptFile::default()
        };
        for submission_id in order.iter() {
            let Some(response) = results.get(submission_id) else {
                continue;
            };
            if !matches!(&response.disposition, BridgeThreadQueueDisposition::Sent) {
                continue;
            }
            let Some(turn_id) = response.turn_id.clone() else {
                continue;
            };
            snapshot.order.push_back(submission_id.clone());
            snapshot.receipts.insert(
                submission_id.clone(),
                DurableQueueReceipt {
                    thread_id: response.thread_id.clone(),
                    turn_id,
                },
            );
        }
        let bytes = loop {
            let bytes = serde_json::to_vec(&snapshot)
                .map_err(|error| format!("failed to serialize queue idempotency state: {error}"))?;
            if bytes.len() <= QUEUE_RECEIPT_STORE_MAX_BYTES {
                break bytes;
            }
            if snapshot.order.is_empty() {
                self.submission_dirty.store(true, Ordering::Release);
                return Err(
                    "queue durable pending state exceeds the idempotency byte budget".to_string(),
                );
            }
            let batch_size = snapshot
                .order
                .len()
                .saturating_mul(bytes.len() - QUEUE_RECEIPT_STORE_MAX_BYTES)
                .div_ceil(bytes.len())
                .max(1);
            for _ in 0..batch_size.min(snapshot.order.len()) {
                let oldest = snapshot
                    .order
                    .pop_front()
                    .expect("receipt order is non-empty");
                snapshot.receipts.remove(&oldest);
            }
        };
        match crate::storage::atomic_write_private(path, &bytes).await {
            Ok(()) => {
                self.submission_dirty.store(false, Ordering::Release);
                Ok(())
            }
            Err(error) => {
                self.submission_dirty.store(true, Ordering::Release);
                Err(format!(
                    "failed to persist queue idempotency state: {error}",
                ))
            }
        }
    }

    pub(super) async fn steer_message(
        self: &Arc<Self>,
        request: BridgeThreadQueueSteerRequest,
    ) -> Result<BridgeThreadQueueActionResponse, String> {
        self.steer_message_inner(request, false).await
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn steer_message_inner(
        self: &Arc<Self>,
        request: BridgeThreadQueueSteerRequest,
        automatic_agent_steer: bool,
    ) -> Result<BridgeThreadQueueActionResponse, String> {
        let normalized_thread_id = request.thread_id.trim().to_string();
        let normalized_item_id = request.item_id.trim().to_string();
        validate_queue_identifier("threadId", &normalized_thread_id)?;
        validate_queue_identifier("itemId", &normalized_item_id)?;

        let _retirement_admission = self.retirement_fence.admit(&normalized_thread_id).await?;
        self.ensure_thread_runtime(&normalized_thread_id).await?;
        {
            let threads = self.threads.read().await;
            let runtime = threads
                .get(&normalized_thread_id)
                .ok_or_else(|| "queue state unavailable".to_string())?;
            if !automatic_agent_steer
                && runtime
                    .items
                    .iter()
                    .find(|item| item.id == normalized_item_id)
                    .is_some_and(is_scheduled_prompt_entry)
            {
                return Err(SCHEDULED_PROMPT_PUBLIC_ACTION_ERROR.to_string());
            }
        }
        if !self.backend.supports_steer(&normalized_thread_id)? {
            return Err("ACP steering extension is not negotiated for this agent".to_string());
        }
        {
            let threads = self.threads.read().await;
            let runtime = threads
                .get(&normalized_thread_id)
                .ok_or_else(|| "queue state unavailable".to_string())?;
            let item = runtime
                .items
                .iter()
                .find(|item| item.id == normalized_item_id)
                .ok_or_else(|| "queued message not found".to_string())?;
            if !automatic_agent_steer && item.agent_message.is_some() {
                return Err("agent messages are steered automatically".to_string());
            }
        }
        let actor = self.thread_actor(&normalized_thread_id).await;
        let _actor_guard = actor.lock().await;

        let snapshot = {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .get_mut(&normalized_thread_id)
                .ok_or_else(|| "queue state unavailable".to_string())?;

            if !automatic_agent_steer && is_scheduled_prompt_item(runtime, &normalized_item_id) {
                return Err(SCHEDULED_PROMPT_PUBLIC_ACTION_ERROR.to_string());
            }
            if runtime.turn_start_in_flight || runtime.action_in_flight_item_id.is_some() {
                return Err("queue is busy processing another action".to_string());
            }
            if runtime.editing_item_id.is_some() {
                return Err("finish editing the queued message before steering".to_string());
            }
            let missing_active_run = !runtime.thread_running
                || runtime.active_turn_id.is_none()
                || runtime.active_run_id.is_none();
            if missing_active_run
                || runtime.active_prompt_generation.is_none()
                || !runtime.live_generation_known
            {
                return Err("no live ACP prompt generation available to steer".to_string());
            }
            let item_index = runtime
                .items
                .iter()
                .position(|item| item.id == normalized_item_id)
                .ok_or_else(|| "queued message not found".to_string())?;
            let mut removed_item = runtime
                .items
                .remove(item_index)
                .expect("index came from position");
            if let Some(agent_message) = removed_item.agent_message.as_mut() {
                agent_message.disposition =
                    crate::agent_messaging::AgentMessageDisposition::Steering;
            }
            runtime.pending_steers.push_back(removed_item);
            runtime.last_error = None;
            Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
        };

        self.broadcast_snapshot(&snapshot).await;
        drop(_actor_guard);
        if !automatic_agent_steer {
            self.spawn_steer_dispatch(normalized_thread_id);
        }
        Ok(BridgeThreadQueueActionResponse {
            ok: true,
            queue: snapshot,
        })
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
    pub(super) async fn cancel_message(
        self: &Arc<Self>,
        request: BridgeThreadQueueCancelRequest,
    ) -> Result<BridgeThreadQueueActionResponse, String> {
        let normalized_thread_id = request.thread_id.trim().to_string();
        let normalized_item_id = request.item_id.trim().to_string();
        validate_queue_identifier("threadId", &normalized_thread_id)?;
        validate_queue_identifier("itemId", &normalized_item_id)?;
        if !self
            .threads
            .read()
            .await
            .contains_key(&normalized_thread_id)
        {
            return Err("queued message not found".to_string());
        }

        let actor = self.thread_actor(&normalized_thread_id).await;
        let _actor_guard = actor.lock().await;

        let (mut snapshot, should_dispatch, removed_submission_id, agent_message_id) = {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .get_mut(&normalized_thread_id)
                .ok_or_else(|| "queued message not found".to_string())?;
            if is_scheduled_prompt_item(runtime, &normalized_item_id) {
                return Err(SCHEDULED_PROMPT_PUBLIC_ACTION_ERROR.to_string());
            }
            if runtime.action_in_flight_item_id.as_deref() == Some(normalized_item_id.as_str()) {
                return Err(
                    "cannot cancel a queued message while it is being processed".to_string()
                );
            }
            let (removed_submission_id, agent_message_id) = if let Some(item_index) = runtime
                .items
                .iter()
                .position(|item| item.id == normalized_item_id)
            {
                let removed = runtime
                    .items
                    .remove(item_index)
                    .expect("index came from position");
                if runtime.editing_item_id.as_deref() == Some(normalized_item_id.as_str()) {
                    runtime.editing_item_id = None;
                };
                (
                    removed.submission_id,
                    removed.agent_message.map(|message| message.message_id),
                )
            } else if let Some(item_index) = runtime
                .pending_steers
                .iter()
                .position(|item| item.id == normalized_item_id)
            {
                let removed = runtime
                    .pending_steers
                    .remove(item_index)
                    .expect("index came from position");
                (
                    removed.submission_id,
                    removed.agent_message.map(|message| message.message_id),
                )
            } else if runtime
                .steer_dispatch_in_flight
                .as_ref()
                .is_some_and(|pending| pending.entry.id == normalized_item_id)
            {
                return Err("cannot cancel a steer already dispatched to the agent".to_string());
            } else {
                return Err("queued message not found".to_string());
            };
            runtime.last_error = None;
            (
                Self::snapshot_for_thread(&normalized_thread_id, Some(runtime)),
                !Self::runtime_has_blockers(runtime),
                removed_submission_id,
                agent_message_id,
            )
        };

        drop(_actor_guard);
        if let Some(message_id) = agent_message_id {
            if let Err(error) = self
                .persist_agent_message_disposition(
                    &message_id,
                    crate::agent_messaging::AgentMessageDisposition::Cancelled,
                )
                .await
            {
                let mut threads = self.threads.write().await;
                if let Some(runtime) = threads.get_mut(&normalized_thread_id) {
                    runtime.last_error = Some(BridgeThreadQueueError {
                        message: error,
                        operation: "persist".to_string(),
                        at: now_iso(),
                        item_id: Some(normalized_item_id.clone()),
                    });
                    runtime.last_error_submission_id = None;
                    snapshot = Self::snapshot_for_thread(&normalized_thread_id, Some(runtime));
                }
            }
        }
        if let Err(error) = self.forget_submission_result(&removed_submission_id).await {
            let mut threads = self.threads.write().await;
            if let Some(runtime) = threads.get_mut(&normalized_thread_id) {
                runtime.last_error = Some(BridgeThreadQueueError {
                    message: error,
                    operation: "persist".to_string(),
                    at: now_iso(),
                    item_id: Some(normalized_item_id.clone()),
                });
                runtime.last_error_submission_id = None;
                snapshot = Self::snapshot_for_thread(&normalized_thread_id, Some(runtime));
            }
        }
        self.broadcast_snapshot(&snapshot).await;
        if should_dispatch {
            self.spawn_auto_dispatch(normalized_thread_id);
        }

        Ok(BridgeThreadQueueActionResponse {
            ok: true,
            queue: snapshot,
        })
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
    pub(crate) async fn cancel_submission(
        self: &Arc<Self>,
        thread_id: &str,
        submission_id: &str,
    ) -> Result<QueueSubmissionCancelOutcome, String> {
        let thread_id = thread_id.trim().to_string();
        let submission_id = submission_id.trim().to_string();
        validate_queue_identifier("threadId", &thread_id)?;
        validate_queue_identifier("submissionId", &submission_id)?;

        let actor = self.thread_actor(&thread_id).await;
        let actor_guard = actor.lock().await;
        let persist_guard = self.submission_persist.lock().await;
        let receipt = self
            .submission_results
            .lock()
            .await
            .get(&submission_id)
            .cloned();
        if let Some(receipt) = receipt {
            if receipt.thread_id != thread_id {
                return Err("submissionId is already bound to another thread".to_string());
            }
            if matches!(receipt.disposition, BridgeThreadQueueDisposition::Sent) {
                return Ok(QueueSubmissionCancelOutcome::Sent);
            }
        }

        let removed = {
            let mut threads = self.threads.write().await;
            threads.get_mut(&thread_id).and_then(|runtime| {
                let entry = if let Some(index) = runtime
                    .items
                    .iter()
                    .position(|entry| entry.submission_id == submission_id)
                {
                    runtime.items.remove(index)
                } else if let Some(index) = runtime
                    .pending_steers
                    .iter()
                    .position(|entry| entry.submission_id == submission_id)
                {
                    runtime.pending_steers.remove(index)
                } else {
                    None
                };
                entry.map(|entry| {
                    if runtime.editing_item_id.as_deref() == Some(entry.id.as_str()) {
                        runtime.editing_item_id = None;
                    }
                    runtime.last_error = None;
                    (
                        entry,
                        Self::snapshot_for_thread(&thread_id, Some(runtime)),
                        !Self::runtime_has_blockers(runtime),
                    )
                })
            })
        };
        let Some((entry, snapshot, should_dispatch)) = removed else {
            drop(actor_guard);
            let durable_owner = self
                .submission_pending
                .lock()
                .await
                .get(&submission_id)
                .cloned();
            let volatile_owner = self
                .submission_volatile_pending
                .lock()
                .await
                .get(&submission_id)
                .cloned();
            if durable_owner
                .iter()
                .chain(volatile_owner.iter())
                .any(|owner| owner != &thread_id)
            {
                return Err("submissionId is already bound to another thread".to_string());
            }
            let dispatch_was_indeterminate = durable_owner.is_some();
            self.forget_submission_result_locked(&submission_id).await?;
            return Ok(if dispatch_was_indeterminate {
                QueueSubmissionCancelOutcome::Sent
            } else {
                QueueSubmissionCancelOutcome::NotFound
            });
        };
        drop(actor_guard);

        self.forget_submission_result_locked(&entry.submission_id)
            .await?;
        drop(persist_guard);
        self.broadcast_snapshot(&snapshot).await;
        if should_dispatch {
            self.spawn_auto_dispatch(thread_id);
        }
        Ok(QueueSubmissionCancelOutcome::Cancelled)
    }

    pub(crate) async fn reconcile_indeterminate_submission(
        self: &Arc<Self>,
        thread_id: &str,
        submission_id: &str,
    ) -> Result<Option<BridgeThreadQueueSendResponse>, String> {
        let thread_id = thread_id.trim().to_string();
        let submission_id = submission_id.trim().to_string();
        validate_queue_identifier("threadId", &thread_id)?;
        validate_queue_identifier("submissionId", &submission_id)?;

        let actor = self.thread_actor(&thread_id).await;
        let _actor_guard = actor.lock().await;
        let persist_guard = self.submission_persist.lock().await;
        let receipt = self
            .submission_results
            .lock()
            .await
            .get(&submission_id)
            .cloned();
        if let Some(receipt) = receipt {
            if receipt.thread_id != thread_id {
                return Err("submissionId is already bound to another thread".to_string());
            }
            self.persist_submission_store_locked().await?;
            drop(persist_guard);
            return Ok(Some(self.submission_response(receipt).await));
        }
        let Some(pending_thread_id) = self
            .submission_pending
            .lock()
            .await
            .get(&submission_id)
            .cloned()
        else {
            return Ok(None);
        };
        if pending_thread_id != thread_id {
            return Err("submissionId is already bound to another thread".to_string());
        }

        let source_turn_id = submission_source_turn_id(&submission_id);
        let reconciled_turn_id = self
            .backend
            .reconcile_turn_start(&thread_id, &source_turn_id)
            .await?
            .unwrap_or(source_turn_id);
        drop(persist_guard);

        // A durable pending marker proves that admission may have crossed the ACP boundary. If the
        // bridge-local deterministic transcript marker survived, use it as positive confirmation.
        // After a full process crash that marker may be unrecoverable, so settle conservatively
        // rather than resubmitting a prompt that may already have performed side effects.
        let result = BridgeThreadQueueSendResponse {
            submission_id,
            disposition: BridgeThreadQueueDisposition::Sent,
            queue: self.read_queue(&thread_id).await,
            turn_id: Some(reconciled_turn_id),
        };
        self.remember_submission_result(result.clone()).await?;
        Ok(Some(result))
    }

    pub(crate) async fn submission_was_sent(
        &self,
        thread_id: &str,
        submission_id: &str,
    ) -> Result<bool, String> {
        let _persist = self.submission_persist.lock().await;
        let sent = self
            .submission_results
            .lock()
            .await
            .get(submission_id)
            .is_some_and(|receipt| {
                receipt.thread_id == thread_id
                    && matches!(receipt.disposition, BridgeThreadQueueDisposition::Sent)
            });
        if sent {
            self.persist_submission_store_locked().await?;
        }
        Ok(sent)
    }

    pub(crate) async fn begin_retirement_fence(
        &self,
        thread_ids: &[String],
    ) -> Result<ThreadRetirementLease, String> {
        let thread_ids = normalize_retiring_thread_ids(thread_ids)?;
        Ok(self.retirement_fence.begin(&thread_ids).await)
    }

    pub(crate) async fn block_retirement_admissions(&self) -> ThreadRetirementAdmissionBarrier {
        self.retirement_fence.block_admissions().await
    }

    pub(crate) async fn install_deleted_thread_tombstones(
        &self,
        thread_ids: &[String],
    ) -> Result<(), String> {
        let thread_ids = normalize_retiring_thread_ids(thread_ids)?;
        let barrier = self.block_retirement_admissions().await;
        self.retirement_fence
            .mark_deleted_blocked(&thread_ids, &barrier);
        Ok(())
    }

    pub(crate) fn begin_retirement_fence_blocked(
        &self,
        thread_ids: &[String],
        barrier: &ThreadRetirementAdmissionBarrier,
    ) -> Result<ThreadRetirementLease, String> {
        let thread_ids = normalize_retiring_thread_ids(thread_ids)?;
        Ok(self.retirement_fence.begin_blocked(&thread_ids, barrier))
    }

    pub(crate) async fn begin_thread_retirement(
        self: &Arc<Self>,
        thread_ids: &[String],
    ) -> Result<QueueThreadRetirement, String> {
        let thread_ids = normalize_retiring_thread_ids(thread_ids)?;

        let mut actors = Vec::with_capacity(thread_ids.len());
        for thread_id in &thread_ids {
            actors.push((thread_id.clone(), self.thread_actor(thread_id).await));
        }
        let mut actor_guards = Vec::with_capacity(actors.len());
        for (_, actor) in &actors {
            actor_guards.push(actor.clone().lock_owned().await);
        }

        Ok(QueueThreadRetirement {
            thread_ids,
            _actor_guards: actor_guards,
        })
    }

    pub(crate) async fn commit_thread_retirement(
        &self,
        retirement: &QueueThreadRetirement,
    ) -> Result<(), String> {
        let thread_ids = &retirement.thread_ids;
        let retired = thread_ids.iter().cloned().collect::<HashSet<_>>();
        let _persist_guard = self.submission_persist.lock().await;
        let mut results = self.submission_results.lock().await.clone();
        let mut order = self.submission_order.lock().await.clone();
        let mut volatile_pending = self.submission_volatile_pending.lock().await.clone();
        let mut pending = self.submission_pending.lock().await.clone();
        let mut pending_order = self.submission_pending_order.lock().await.clone();
        results.retain(|_, receipt| !retired.contains(&receipt.thread_id));
        order.retain(|submission_id| results.contains_key(submission_id));
        volatile_pending.retain(|_, thread_id| !retired.contains(thread_id));
        pending.retain(|_, thread_id| !retired.contains(thread_id));
        pending_order.retain(|submission_id| pending.contains_key(submission_id));
        self.persist_submission_snapshot_locked(&results, &order, &pending, &pending_order)
            .await?;

        *self.submission_results.lock().await = results;
        *self.submission_order.lock().await = order;
        *self.submission_volatile_pending.lock().await = volatile_pending;
        *self.submission_pending.lock().await = pending;
        *self.submission_pending_order.lock().await = pending_order;
        {
            let mut threads = self.threads.write().await;
            for thread_id in thread_ids {
                threads.remove(thread_id);
            }
        }
        {
            let mut thread_actors = self.thread_actors.write().await;
            for thread_id in thread_ids {
                thread_actors.remove(thread_id);
            }
        }
        Ok(())
    }

    pub(crate) async fn rollback_thread_retirement(&self, _retirement: QueueThreadRetirement) {}

    pub(crate) async fn publish_thread_retirement(&self, thread_ids: &[String]) {
        for thread_id in thread_ids {
            self.broadcast_snapshot(&Self::snapshot_for_thread(thread_id, None))
                .await;
        }
    }

    #[cfg(test)]
    pub(crate) async fn retire_threads(
        self: &Arc<Self>,
        thread_ids: &[String],
    ) -> Result<(), String> {
        let fence = self.begin_retirement_fence(thread_ids).await?;
        let retirement = match self.begin_thread_retirement(thread_ids).await {
            Ok(retirement) => retirement,
            Err(error) => {
                fence.finish().await;
                return Err(error);
            }
        };
        if let Err(error) = self.commit_thread_retirement(&retirement).await {
            fence.finish().await;
            return Err(error);
        }
        drop(retirement);
        self.publish_thread_retirement(thread_ids).await;
        fence.finish().await;
        Ok(())
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(super) async fn start_message_edit(
        &self,
        request: BridgeThreadQueueEditRequest,
    ) -> Result<BridgeThreadQueueActionResponse, String> {
        let normalized_thread_id = request.thread_id.trim().to_string();
        let normalized_item_id = request.item_id.trim().to_string();
        validate_queue_identifier("threadId", &normalized_thread_id)?;
        validate_queue_identifier("itemId", &normalized_item_id)?;
        if !self
            .threads
            .read()
            .await
            .contains_key(&normalized_thread_id)
        {
            return Err("queue state unavailable".to_string());
        }

        let actor = self.thread_actor(&normalized_thread_id).await;
        let _actor_guard = actor.lock().await;
        let snapshot = {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .get_mut(&normalized_thread_id)
                .ok_or_else(|| "queue state unavailable".to_string())?;
            if is_scheduled_prompt_item(runtime, &normalized_item_id) {
                return Err(SCHEDULED_PROMPT_PUBLIC_ACTION_ERROR.to_string());
            }
            if runtime.turn_start_in_flight || runtime.action_in_flight_item_id.is_some() {
                return Err("queue is busy processing another action".to_string());
            }
            if runtime
                .items
                .iter()
                .find(|item| item.id == normalized_item_id)
                .is_some_and(|item| item.agent_message.is_some())
            {
                return Err("agent messages are read-only".to_string());
            }
            if runtime.steer_prepare_in_flight
                || runtime.steer_dispatch_in_flight.is_some()
                || !runtime.pending_steers.is_empty()
            {
                return Err("finish steering queued messages before editing".to_string());
            }
            if let Some(editing_item_id) = runtime.editing_item_id.as_deref() {
                if editing_item_id != normalized_item_id {
                    return Err("another queued message is already being edited".to_string());
                }
                Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
            } else {
                let next_item_id = runtime.items.front().map(|item| item.id.as_str());
                if next_item_id != Some(normalized_item_id.as_str()) {
                    return Err("only the next queued message can be edited".to_string());
                }
                runtime.editing_item_id = Some(normalized_item_id);
                runtime.last_error = None;
                Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
            }
        };

        self.broadcast_snapshot(&snapshot).await;
        Ok(BridgeThreadQueueActionResponse {
            ok: true,
            queue: snapshot,
        })
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(super) async fn commit_message_edit(
        self: &Arc<Self>,
        request: BridgeThreadQueueEditCommitRequest,
    ) -> Result<BridgeThreadQueueActionResponse, String> {
        let normalized_thread_id = request.thread_id.trim().to_string();
        let normalized_item_id = request.item_id.trim().to_string();
        let content = request.content.trim().to_string();
        validate_queue_identifier("threadId", &normalized_thread_id)?;
        validate_queue_identifier("itemId", &normalized_item_id)?;
        if content.is_empty() {
            return Err("content must not be empty".to_string());
        }
        if content.len() > QUEUE_MAX_CONTENT_BYTES {
            return Err(format!(
                "queue content exceeds {QUEUE_MAX_CONTENT_BYTES} bytes (actual {})",
                content.len(),
            ));
        }

        if !self
            .threads
            .read()
            .await
            .contains_key(&normalized_thread_id)
        {
            return Err("queue state unavailable".to_string());
        }
        let actor = self.thread_actor(&normalized_thread_id).await;
        let _actor_guard = actor.lock().await;
        let (snapshot, should_dispatch) = {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .get_mut(&normalized_thread_id)
                .ok_or_else(|| "queue state unavailable".to_string())?;
            if is_scheduled_prompt_item(runtime, &normalized_item_id) {
                return Err(SCHEDULED_PROMPT_PUBLIC_ACTION_ERROR.to_string());
            }
            if runtime.editing_item_id.as_deref() != Some(normalized_item_id.as_str()) {
                return Err("queued message is not being edited".to_string());
            }
            let item_index = runtime
                .items
                .iter()
                .position(|item| item.id == normalized_item_id)
                .ok_or_else(|| "queued message not found".to_string())?;
            let mut turn_start = runtime.items[item_index].turn_start.clone();
            replace_turn_start_text(&mut turn_start, &content)?;
            if turn_start_contains_agent_message_envelope(&turn_start) {
                return Err("agent message envelopes are reserved for the bridge".to_string());
            }
            let item_bytes = serde_json::to_vec(&turn_start)
                .map(|value| value.len())
                .unwrap_or(usize::MAX)
                .saturating_add(content.len());
            if item_bytes > QUEUE_MAX_ITEM_BYTES {
                return Err(format!(
                    "queue item exceeds {QUEUE_MAX_ITEM_BYTES} bytes (actual {item_bytes})",
                ));
            }
            let other_queued_bytes = runtime
                .items
                .iter()
                .enumerate()
                .filter(|(index, _)| *index != item_index)
                .map(|(_, item)| {
                    item.content.len().saturating_add(
                        serde_json::to_vec(&item.turn_start)
                            .map(|value| value.len())
                            .unwrap_or(usize::MAX),
                    )
                })
                .fold(0usize, usize::saturating_add);
            if other_queued_bytes.saturating_add(item_bytes) > QUEUE_MAX_BYTES_PER_THREAD {
                return Err(format!(
                    "resource_limit:queue_thread_bytes:{QUEUE_MAX_BYTES_PER_THREAD}:{}",
                    other_queued_bytes.saturating_add(item_bytes),
                ));
            }
            let item = &mut runtime.items[item_index];
            item.content = content;
            item.turn_start = turn_start;
            runtime.editing_item_id = None;
            runtime.last_error = None;
            (
                Self::snapshot_for_thread(&normalized_thread_id, Some(runtime)),
                !Self::runtime_has_blockers(runtime),
            )
        };

        self.broadcast_snapshot(&snapshot).await;
        if should_dispatch {
            self.spawn_auto_dispatch(normalized_thread_id);
        }
        Ok(BridgeThreadQueueActionResponse {
            ok: true,
            queue: snapshot,
        })
    }

    pub(super) async fn cancel_message_edit(
        self: &Arc<Self>,
        request: BridgeThreadQueueEditRequest,
    ) -> Result<BridgeThreadQueueActionResponse, String> {
        let normalized_thread_id = request.thread_id.trim().to_string();
        let normalized_item_id = request.item_id.trim().to_string();
        validate_queue_identifier("threadId", &normalized_thread_id)?;
        validate_queue_identifier("itemId", &normalized_item_id)?;
        if !self
            .threads
            .read()
            .await
            .contains_key(&normalized_thread_id)
        {
            return Err("queue state unavailable".to_string());
        }

        let actor = self.thread_actor(&normalized_thread_id).await;
        let _actor_guard = actor.lock().await;
        let (snapshot, should_dispatch) = {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .get_mut(&normalized_thread_id)
                .ok_or_else(|| "queue state unavailable".to_string())?;
            if is_scheduled_prompt_item(runtime, &normalized_item_id) {
                return Err(SCHEDULED_PROMPT_PUBLIC_ACTION_ERROR.to_string());
            }
            if runtime.editing_item_id.as_deref() != Some(normalized_item_id.as_str()) {
                return Err("queued message is not being edited".to_string());
            }
            runtime.editing_item_id = None;
            runtime.last_error = None;
            (
                Self::snapshot_for_thread(&normalized_thread_id, Some(runtime)),
                !Self::runtime_has_blockers(runtime),
            )
        };

        self.broadcast_snapshot(&snapshot).await;
        if should_dispatch {
            self.spawn_auto_dispatch(normalized_thread_id);
        }
        Ok(BridgeThreadQueueActionResponse {
            ok: true,
            queue: snapshot,
        })
    }

    pub(super) async fn ensure_thread_runtime(&self, thread_id: &str) -> Result<(), String> {
        let normalized_thread_id = thread_id.trim();
        validate_queue_identifier("threadId", normalized_thread_id)?;

        {
            let threads = self.threads.read().await;
            if threads.contains_key(normalized_thread_id) {
                return Ok(());
            }
        }

        let hydrated = self.hydrate_thread_runtime(normalized_thread_id).await?;
        let mut threads = self.threads.write().await;
        threads
            .entry(normalized_thread_id.to_string())
            .or_insert(hydrated);
        Ok(())
    }

    pub(super) async fn hydrate_thread_runtime(
        &self,
        thread_id: &str,
    ) -> Result<BridgeThreadQueueRuntime, String> {
        let snapshot = self.backend.read_snapshot(thread_id).await?;
        let session = snapshot.session;
        let live_generation_known =
            session.active_generation.is_some() && !session.history_reconstruction;

        Ok(BridgeThreadQueueRuntime {
            active_turn_id: session.active_source_turn_id,
            active_run_id: session.active_run_id,
            active_prompt_generation: session.active_generation,
            active_tool_call_ids: session.active_tool_ids,
            live_generation_known,
            thread_running: live_generation_known,
            pending_approval_ids: snapshot.pending_approval_ids,
            pending_user_input_ids: snapshot.pending_user_input_ids,
            ..BridgeThreadQueueRuntime::default()
        })
    }

    #[cfg(test)]
    #[cfg_attr(coverage_nightly, coverage(off))]
    pub(super) async fn reconcile_all_threads(self: &Arc<Self>) {
        let thread_ids = self
            .threads
            .read()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for thread_id in thread_ids {
            let actor = self.thread_actor(&thread_id).await;
            let _actor_guard = actor.lock().await;
            let mut should_drain_steers = false;
            match self.hydrate_thread_runtime(&thread_id).await {
                Ok(hydrated) => {
                    if let Some(runtime) = self.threads.write().await.get_mut(&thread_id) {
                        runtime.active_turn_id = hydrated.active_turn_id;
                        runtime.active_run_id = hydrated.active_run_id;
                        runtime.active_prompt_generation = hydrated.active_prompt_generation;
                        runtime.active_tool_call_ids = hydrated.active_tool_call_ids;
                        runtime.live_generation_known = hydrated.live_generation_known;
                        runtime.thread_running = hydrated.thread_running;
                        runtime.pending_approval_ids = hydrated.pending_approval_ids;
                        runtime.pending_user_input_ids = hydrated.pending_user_input_ids;
                        should_drain_steers = !runtime.pending_steers.is_empty()
                            && runtime.active_tool_call_ids.is_empty()
                            && runtime.live_generation_known;
                    }
                }
                Err(error) => {
                    if let Some(runtime) = self.threads.write().await.get_mut(&thread_id) {
                        runtime.thread_running = true;
                        runtime.live_generation_known = false;
                        runtime.active_tool_call_ids.clear();
                        runtime.last_error = Some(BridgeThreadQueueError {
                            message: error,
                            operation: "reconcile".to_string(),
                            at: now_iso(),
                            item_id: None,
                        });
                        runtime.last_error_submission_id = None;
                    }
                }
            }
            drop(_actor_guard);
            if should_drain_steers {
                self.spawn_steer_dispatch(thread_id);
            }
        }
    }

    pub(super) async fn dispatch_turn_start(
        &self,
        thread_id: &str,
        turn_start: &Value,
        source_turn_id: &str,
    ) -> Result<String, String> {
        self.backend
            .turn_start(thread_id, turn_start, source_turn_id)
            .await
    }

    pub(super) fn spawn_steer_dispatch(self: &Arc<Self>, thread_id: String) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            this.drain_pending_steers(thread_id).await;
        });
    }

    fn pending_steer_can_bypass_tools(
        runtime: &BridgeThreadQueueRuntime,
        supports_live_agent_message: bool,
    ) -> bool {
        runtime
            .pending_steers
            .front()
            .is_some_and(|entry| entry.agent_message.is_some())
            && supports_live_agent_message
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
    pub(super) async fn drain_pending_steers(self: &Arc<Self>, thread_id: String) {
        let _retirement_admission = match self.retirement_fence.admit(&thread_id).await {
            Ok(admission) => admission,
            Err(_) => return,
        };
        loop {
            let supports_live_agent_message = self
                .backend
                .supports_live_agent_message(&thread_id)
                .unwrap_or(false);
            let actor = self.thread_actor(&thread_id).await;
            let actor_guard = actor.lock().await;
            let prepared_live_agent_message = {
                let mut threads = self.threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                let live_agent_message =
                    Self::pending_steer_can_bypass_tools(runtime, supports_live_agent_message);
                let dispatch_busy = runtime.steer_prepare_in_flight
                    || runtime.steer_dispatch_in_flight.is_some()
                    || runtime.turn_start_in_flight
                    || runtime.action_in_flight_item_id.is_some();
                let blocked_by_tools =
                    !runtime.active_tool_call_ids.is_empty() && !live_agent_message;
                let blocked_by_interactions = live_agent_message
                    && (!runtime.pending_approval_ids.is_empty()
                        || !runtime.pending_user_input_ids.is_empty());
                let not_ready_for_steer = runtime.pending_steers.is_empty()
                    || !runtime.live_generation_known
                    || !runtime.thread_running;
                if not_ready_for_steer
                    || dispatch_busy
                    || blocked_by_tools
                    || blocked_by_interactions
                {
                    return;
                }
                runtime.steer_prepare_in_flight = true;
                live_agent_message
            };

            let interaction_epoch = {
                drop(actor_guard);
                let result = if prepared_live_agent_message {
                    self.backend.current_steer_epoch(&thread_id).await
                } else {
                    self.backend.prepare_steer(&thread_id).await
                };
                let actor_guard = actor.lock().await;
                let (snapshot, should_auto_dispatch) = {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    runtime.steer_prepare_in_flight = false;
                    if let Err(error) = &result {
                        runtime.last_error_submission_id = runtime
                            .pending_steers
                            .front()
                            .map(|entry| entry.submission_id.clone());
                        runtime.last_error = Some(BridgeThreadQueueError {
                            message: error.clone(),
                            operation: "steer".to_string(),
                            at: now_iso(),
                            item_id: runtime.pending_steers.front().map(|entry| entry.id.clone()),
                        });
                    }
                    (
                        Self::snapshot_for_thread(&thread_id, Some(runtime)),
                        runtime.pending_steers.is_empty()
                            && !runtime.thread_running
                            && (!runtime.items.is_empty()
                                || !runtime.pending_completion_event_ids.is_empty()),
                    )
                };
                drop(actor_guard);
                if snapshot.last_error.is_some() {
                    self.broadcast_snapshot(&snapshot).await;
                }
                if should_auto_dispatch {
                    self.spawn_auto_dispatch(thread_id.clone());
                }
                if snapshot.last_error.is_some() || should_auto_dispatch {
                    return;
                }
                let epoch = result.expect("error returned above");
                match self.backend.verify_steer_epoch(&thread_id, epoch).await {
                    Ok(true) => epoch,
                    Ok(false) => continue,
                    Err(error) => {
                        self.fail_steer_dispatch(&thread_id, "prepare", error).await;
                        return;
                    }
                }
            };

            let actor_guard = actor.lock().await;
            let (dispatch, live_agent_message) = {
                let mut threads = self.threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                let live_agent_message =
                    Self::pending_steer_can_bypass_tools(runtime, supports_live_agent_message);
                if live_agent_message != prepared_live_agent_message {
                    continue;
                }
                let dispatch_busy = runtime.steer_dispatch_in_flight.is_some()
                    || runtime.turn_start_in_flight
                    || runtime.action_in_flight_item_id.is_some();
                let blocked_by_state = (!runtime.active_tool_call_ids.is_empty()
                    && !live_agent_message)
                    || !runtime.live_generation_known
                    || !runtime.thread_running;
                let has_pending_interactions = !runtime.pending_approval_ids.is_empty()
                    || !runtime.pending_user_input_ids.is_empty();
                if dispatch_busy || blocked_by_state || has_pending_interactions {
                    return;
                }
                let (Some(expected_turn_id), Some(expected_run_id), Some(prompt_generation)) = (
                    runtime.active_turn_id.clone(),
                    runtime.active_run_id.clone(),
                    runtime.active_prompt_generation,
                ) else {
                    return;
                };
                let Some(entry) = runtime.pending_steers.pop_front() else {
                    return;
                };
                let dispatch = PendingSteerDispatch {
                    entry,
                    expected_turn_id,
                    expected_run_id,
                    prompt_generation,
                    crossed_completion_boundary: false,
                };
                runtime.steer_dispatch_in_flight = Some(dispatch.clone());
                (dispatch, live_agent_message)
            };
            drop(actor_guard);

            let prompt = match crate::runtime_backend::bridge_prompt(&dispatch.entry.turn_start) {
                Ok(prompt) => prompt,
                Err(error) => {
                    self.fail_steer_dispatch(&thread_id, &dispatch.entry.id, error)
                        .await;
                    return;
                }
            };
            let result = if live_agent_message {
                self.backend
                    .deliver_live_agent_message(
                        &thread_id,
                        dispatch.expected_run_id.clone(),
                        dispatch.expected_turn_id.clone(),
                        dispatch.prompt_generation,
                        interaction_epoch,
                        prompt,
                    )
                    .await
            } else {
                self.backend
                    .steer(
                        &thread_id,
                        dispatch.expected_run_id.clone(),
                        dispatch.expected_turn_id.clone(),
                        dispatch.prompt_generation,
                        interaction_epoch,
                        prompt,
                    )
                    .await
                    .map(|_| crate::acp::harness::HarnessAgentMessageOutcome::Delivered)
            };
            let dispatch_failed = result.is_err();
            let delivery_deferred = matches!(
                &result,
                Ok(crate::acp::harness::HarnessAgentMessageOutcome::Deferred),
            );
            let actor_guard = actor.lock().await;
            let snapshot = {
                let mut threads = self.threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                let Some(mut owned) = runtime.steer_dispatch_in_flight.take() else {
                    return;
                };
                if owned.entry.id != dispatch.entry.id {
                    runtime.steer_dispatch_in_flight = Some(owned);
                    return;
                }
                let succeeded = matches!(
                    &result,
                    Ok(crate::acp::harness::HarnessAgentMessageOutcome::Delivered),
                );
                let indeterminate = result
                    .as_ref()
                    .err()
                    .is_some_and(|error| dispatch_failure_is_indeterminate(error));
                let submission_id = owned.entry.submission_id.clone();
                let item_id = owned.entry.id.clone();
                let agent_message_id = owned
                    .entry
                    .agent_message
                    .as_ref()
                    .map(|origin| origin.message_id.clone());
                let mut requeued_agent_message_id = None;
                let deferred_after_completion =
                    delivery_deferred && owned.crossed_completion_boundary;
                match result {
                    Ok(crate::acp::harness::HarnessAgentMessageOutcome::Delivered) => {
                        runtime.last_error = None;
                    }
                    Ok(crate::acp::harness::HarnessAgentMessageOutcome::Deferred) => {
                        if deferred_after_completion {
                            if let Some(agent_message) = owned.entry.agent_message.as_mut() {
                                agent_message.disposition =
                                    crate::agent_messaging::AgentMessageDisposition::Queued;
                                requeued_agent_message_id = Some(agent_message.message_id.clone());
                            }
                            runtime.items.push_front(owned.entry);
                        } else {
                            runtime.pending_steers.push_front(owned.entry);
                        }
                        runtime.last_error = None;
                    }
                    Err(error) => {
                        if !indeterminate {
                            if owned.crossed_completion_boundary {
                                if let Some(agent_message) = owned.entry.agent_message.as_mut() {
                                    agent_message.disposition =
                                        crate::agent_messaging::AgentMessageDisposition::Queued;
                                    requeued_agent_message_id =
                                        Some(agent_message.message_id.clone());
                                }
                                runtime.items.push_front(owned.entry);
                            } else {
                                runtime.pending_steers.push_front(owned.entry);
                            }
                        }
                        runtime.last_error = Some(BridgeThreadQueueError {
                            message: error,
                            operation: "steer".to_string(),
                            at: now_iso(),
                            item_id: Some(item_id),
                        });
                        runtime.last_error_submission_id = Some(submission_id.clone());
                    }
                }
                (
                    Self::snapshot_for_thread(&thread_id, Some(runtime)),
                    succeeded.then_some((
                        submission_id,
                        agent_message_id.clone(),
                        dispatch.expected_turn_id.clone(),
                    )),
                    indeterminate.then_some(agent_message_id).flatten(),
                    requeued_agent_message_id,
                    deferred_after_completion,
                )
            };
            drop(actor_guard);
            self.broadcast_snapshot(&snapshot.0).await;
            if let Some((submission_id, agent_message_id, turn_id)) = snapshot.1 {
                self.remember_sent_submission_until_persisted(
                    BridgeThreadQueueSendResponse {
                        submission_id,
                        disposition: BridgeThreadQueueDisposition::Sent,
                        queue: snapshot.0.clone(),
                        turn_id: Some(turn_id),
                    },
                    "successful steer",
                )
                .await;
                if let Some(message_id) = agent_message_id {
                    if let Err(error) = self
                        .persist_agent_message_disposition(
                            &message_id,
                            crate::agent_messaging::AgentMessageDisposition::Sent,
                        )
                        .await
                    {
                        eprintln!(
                            "failed to settle steered agent-message activity {message_id}: {error}",
                        );
                    }
                }
            } else if let Some(message_id) = snapshot.2 {
                if let Err(error) = self
                    .persist_agent_message_disposition(
                        &message_id,
                        crate::agent_messaging::AgentMessageDisposition::Cancelled,
                    )
                    .await
                {
                    eprintln!(
                        "failed to settle indeterminate steered agent-message activity {message_id}: {error}",
                    );
                }
            } else if let Some(message_id) = snapshot.3 {
                if let Err(error) = self
                    .persist_agent_message_disposition(
                        &message_id,
                        crate::agent_messaging::AgentMessageDisposition::Queued,
                    )
                    .await
                {
                    eprintln!(
                        "failed to persist requeued agent-message activity {message_id}: {error}",
                    );
                }
            }
            if dispatch_failed || delivery_deferred {
                if dispatch_failed || snapshot.4 {
                    self.spawn_auto_dispatch(thread_id.clone());
                }
                return;
            }
        }
    }

    async fn fail_steer_dispatch(&self, thread_id: &str, item_id: &str, error: String) {
        let snapshot = {
            let mut threads = self.threads.write().await;
            let Some(runtime) = threads.get_mut(thread_id) else {
                return;
            };
            let mut error_submission_id = None;
            if let Some(owned) = runtime.steer_dispatch_in_flight.take() {
                error_submission_id = Some(owned.entry.submission_id.clone());
                runtime.pending_steers.push_front(owned.entry);
            }
            runtime.last_error = Some(BridgeThreadQueueError {
                message: error,
                operation: "steer".to_string(),
                at: now_iso(),
                item_id: Some(item_id.to_string()),
            });
            runtime.last_error_submission_id = error_submission_id;
            Self::snapshot_for_thread(thread_id, Some(runtime))
        };
        self.broadcast_snapshot(&snapshot).await;
    }

    pub(super) async fn broadcast_snapshot(&self, snapshot: &BridgeThreadQueueState) {
        let value = serde_json::to_value(snapshot).expect("queue snapshot serializes");
        self.hub
            .broadcast_notification("bridge/thread/queue/updated", value)
            .await;
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(super) fn snapshot_for_thread(
        thread_id: impl Into<String>,
        runtime: Option<&BridgeThreadQueueRuntime>,
    ) -> BridgeThreadQueueState {
        let (
            items,
            pending_steers,
            editing_item_id,
            waiting_for_tool_calls,
            steering_in_flight,
            last_error,
        ) = runtime
            .map(|runtime| {
                (
                    runtime
                        .items
                        .iter()
                        .filter(|entry| !is_scheduled_prompt_entry(entry))
                        .map(BridgeQueuedMessageEntry::to_public)
                        .collect::<Vec<_>>(),
                    runtime
                        .steer_dispatch_in_flight
                        .iter()
                        .map(|dispatch| &dispatch.entry)
                        .chain(runtime.pending_steers.iter())
                        .filter(|entry| !is_scheduled_prompt_entry(entry))
                        .map(BridgeQueuedMessageEntry::to_public)
                        .collect::<Vec<_>>(),
                    runtime
                        .editing_item_id
                        .as_ref()
                        .filter(|item_id| !is_scheduled_prompt_item(runtime, item_id))
                        .cloned(),
                    !runtime.pending_steers.is_empty() && !runtime.active_tool_call_ids.is_empty(),
                    runtime.steer_dispatch_in_flight.is_some(),
                    runtime.last_error.clone().filter(|_| {
                        !runtime
                            .last_error_submission_id
                            .as_deref()
                            .is_some_and(|submission_id| {
                                submission_id.starts_with(SCHEDULED_PROMPT_SUBMISSION_PREFIX)
                            })
                    }),
                )
            })
            .unwrap_or_else(|| (Vec::new(), Vec::new(), None, false, false, None));
        let pending_steer_count = pending_steers.len();

        BridgeThreadQueueState {
            thread_id: thread_id.into(),
            items,
            pending_steers,
            pending_steer_count,
            editing_item_id,
            waiting_for_tool_calls,
            steering_in_flight,
            last_error,
        }
    }

    pub(super) fn runtime_has_blockers(runtime: &BridgeThreadQueueRuntime) -> bool {
        runtime.thread_running
            || runtime.turn_start_in_flight
            || runtime.action_in_flight_item_id.is_some()
            || runtime.editing_item_id.is_some()
            || runtime.steer_prepare_in_flight
            || runtime.steer_dispatch_in_flight.is_some()
            || !runtime.pending_steers.is_empty()
            || !runtime.pending_approval_ids.is_empty()
            || !runtime.pending_user_input_ids.is_empty()
    }

    pub(super) fn runtime_is_blocked_or_occupied(runtime: &BridgeThreadQueueRuntime) -> bool {
        Self::runtime_has_blockers(runtime) || !runtime.items.is_empty()
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
    pub(super) async fn handle_canonical_event(self: &Arc<Self>, received: CanonicalHubEvent) {
        let Some(thread_id) = received.event.thread_id().map(str::to_string) else {
            return;
        };
        let _retirement_admission = match self.retirement_fence.admit(&thread_id).await {
            Ok(admission) => admission,
            Err(_) => return,
        };
        let actor = self.thread_actor(&thread_id).await;
        let _actor_guard = actor.lock().await;
        match received.event {
            crate::acp::events::CanonicalEvent::RunStarted {
                thread_id,
                run_id,
                source_turn_id,
                generation,
                ..
            } => {
                let mut threads = self.threads.write().await;
                let runtime = threads.entry(thread_id).or_default();
                let completion_event_ids =
                    std::mem::take(&mut runtime.pending_completion_event_ids);
                runtime.thread_running = true;
                runtime.turn_start_in_flight = false;
                runtime.active_turn_id = Some(source_turn_id);
                runtime.active_run_id = Some(run_id);
                runtime.active_prompt_generation = Some(generation);
                runtime.active_tool_call_ids.clear();
                runtime.live_generation_known = true;
                runtime.last_error = None;
                drop(threads);
                for event_id in completion_event_ids {
                    self.record_completion_disposition(
                        event_id,
                        QueueCompletionDisposition::Continued,
                    )
                    .await;
                }
            }
            crate::acp::events::CanonicalEvent::RunFinished {
                thread_id,
                source_turn_id,
                generation,
                ..
            }
            | crate::acp::events::CanonicalEvent::RunFailed {
                thread_id,
                source_turn_id,
                generation,
                ..
            } => {
                let (
                    should_dispatch,
                    should_queue_completion,
                    should_wait_for_continuation,
                    should_finalize_for_edit,
                    requeued_agent_message_ids,
                ) = {
                    let mut threads = self.threads.write().await;
                    let runtime = threads.entry(thread_id.clone()).or_default();
                    if runtime.active_turn_id.as_deref() != Some(source_turn_id.as_str())
                        || runtime.active_prompt_generation != Some(generation)
                    {
                        return;
                    }
                    let continuation_already_in_flight = runtime.turn_start_in_flight;
                    let steer_prepare_in_flight = runtime.steer_prepare_in_flight;
                    runtime.thread_running = false;
                    if !continuation_already_in_flight {
                        runtime.active_turn_id = None;
                        runtime.active_run_id = None;
                        runtime.active_prompt_generation = None;
                    }
                    runtime.active_tool_call_ids.clear();
                    runtime.live_generation_known = false;
                    runtime.pending_approval_ids.clear();
                    runtime.pending_user_input_ids.clear();
                    let mut requeued_agent_message_ids = Vec::new();
                    while let Some(mut entry) = runtime.pending_steers.pop_back() {
                        if let Some(agent_message) = entry.agent_message.as_mut() {
                            agent_message.disposition =
                                crate::agent_messaging::AgentMessageDisposition::Queued;
                            requeued_agent_message_ids.push(agent_message.message_id.clone());
                        }
                        runtime.items.push_front(entry);
                    }
                    if let Some(in_flight) = runtime.steer_dispatch_in_flight.as_mut() {
                        in_flight.crossed_completion_boundary = true;
                    }
                    (
                        !continuation_already_in_flight
                            && !steer_prepare_in_flight
                            && runtime.steer_dispatch_in_flight.is_none()
                            && runtime.editing_item_id.is_none()
                            && !runtime.items.is_empty(),
                        continuation_already_in_flight || steer_prepare_in_flight,
                        continuation_already_in_flight
                            || steer_prepare_in_flight
                            || runtime.steer_dispatch_in_flight.is_some(),
                        runtime.editing_item_id.is_some(),
                        requeued_agent_message_ids,
                    )
                };
                let should_auto_dispatch = should_queue_completion || should_dispatch;
                let should_record_completion = !should_auto_dispatch
                    && (should_finalize_for_edit || !should_wait_for_continuation);
                if should_auto_dispatch {
                    let mut threads = self.threads.write().await;
                    if let Some(runtime) = threads.get_mut(&thread_id) {
                        runtime.pending_completion_event_ids.push(received.event_id);
                    }
                    drop(threads);
                }
                if !requeued_agent_message_ids.is_empty() {
                    let this = Arc::clone(self);
                    let event_id = received.event_id;
                    tokio::spawn(async move {
                        for message_id in requeued_agent_message_ids {
                            if let Err(error) = this
                                .persist_agent_message_disposition(
                                    &message_id,
                                    crate::agent_messaging::AgentMessageDisposition::Queued,
                                )
                                .await
                            {
                                eprintln!(
                                    "failed to persist requeued agent-message activity {message_id}: {error}",
                                );
                            }
                        }
                        if should_auto_dispatch {
                            this.spawn_auto_dispatch(thread_id);
                        } else if should_record_completion {
                            this.record_completion_disposition(
                                event_id,
                                QueueCompletionDisposition::Final,
                            )
                            .await;
                        }
                    });
                } else if should_auto_dispatch {
                    self.spawn_auto_dispatch(thread_id);
                } else if should_record_completion {
                    self.record_completion_disposition(
                        received.event_id,
                        QueueCompletionDisposition::Final,
                    )
                    .await;
                }
            }
            crate::acp::events::CanonicalEvent::Tool {
                thread_id,
                run_id,
                source_turn_id,
                generation,
                tool_call_id,
                status,
                ..
            } => {
                let should_drain = {
                    let mut threads = self.threads.write().await;
                    let runtime = threads.entry(thread_id.clone()).or_default();
                    if generation != runtime.active_prompt_generation
                        || run_id.as_deref() != runtime.active_run_id.as_deref()
                        || source_turn_id.as_deref() != runtime.active_turn_id.as_deref()
                    {
                        return;
                    }
                    match status {
                        agent_client_protocol::v1::schema::ToolCallStatus::Pending
                        | agent_client_protocol::v1::schema::ToolCallStatus::InProgress => {
                            runtime.active_tool_call_ids.insert(tool_call_id);
                        }
                        agent_client_protocol::v1::schema::ToolCallStatus::Completed
                        | agent_client_protocol::v1::schema::ToolCallStatus::Failed => {
                            runtime.active_tool_call_ids.remove(&tool_call_id);
                        }
                        _ => {
                            runtime.live_generation_known = false;
                            return;
                        }
                    }
                    runtime.active_tool_call_ids.is_empty()
                        && !runtime.pending_steers.is_empty()
                        && runtime.steer_dispatch_in_flight.is_none()
                };
                if should_drain {
                    self.spawn_steer_dispatch(thread_id);
                }
            }
            crate::acp::events::CanonicalEvent::PermissionRequested { approval } => {
                self.threads
                    .write()
                    .await
                    .entry(approval.thread_id)
                    .or_default()
                    .pending_approval_ids
                    .insert(approval.request_id);
            }
            crate::acp::events::CanonicalEvent::PermissionResolved {
                thread_id,
                request_id,
                ..
            } => {
                let supports_live_agent_message = self
                    .backend
                    .supports_live_agent_message(&thread_id)
                    .unwrap_or(false);
                let mut should_drain = false;
                if let Some(runtime) = self.threads.write().await.get_mut(&thread_id) {
                    runtime.pending_approval_ids.remove(&request_id);
                    should_drain = runtime.pending_approval_ids.is_empty()
                        && runtime.pending_user_input_ids.is_empty()
                        && (runtime.active_tool_call_ids.is_empty()
                            || Self::pending_steer_can_bypass_tools(
                                runtime,
                                supports_live_agent_message,
                            ))
                        && !runtime.pending_steers.is_empty();
                }
                if should_drain {
                    self.spawn_steer_dispatch(thread_id);
                }
            }
            crate::acp::events::CanonicalEvent::ElicitationRequested { request } => {
                self.threads
                    .write()
                    .await
                    .entry(request.thread_id)
                    .or_default()
                    .pending_user_input_ids
                    .insert(request.request_id);
            }
            crate::acp::events::CanonicalEvent::ElicitationResolved {
                thread_id,
                request_id,
                ..
            } => {
                let supports_live_agent_message = self
                    .backend
                    .supports_live_agent_message(&thread_id)
                    .unwrap_or(false);
                let mut should_drain = false;
                if let Some(runtime) = self.threads.write().await.get_mut(&thread_id) {
                    runtime.pending_user_input_ids.remove(&request_id);
                    should_drain = runtime.pending_approval_ids.is_empty()
                        && runtime.pending_user_input_ids.is_empty()
                        && (runtime.active_tool_call_ids.is_empty()
                            || Self::pending_steer_can_bypass_tools(
                                runtime,
                                supports_live_agent_message,
                            ))
                        && !runtime.pending_steers.is_empty();
                }
                if should_drain {
                    self.spawn_steer_dispatch(thread_id);
                }
            }
            _ => {}
        }
    }

    pub(super) fn spawn_auto_dispatch(self: &Arc<Self>, thread_id: String) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            this.drain_thread_queue(thread_id).await;
        });
    }

    fn schedule_auto_dispatch_retry(self: &Arc<Self>, thread_id: String, attempt: u32) {
        let shift = attempt.saturating_sub(1).min(16);
        let delay_ms = QUEUE_DISPATCH_RETRY_MIN_MS
            .saturating_mul(1_u64 << shift)
            .min(QUEUE_DISPATCH_RETRY_MAX_MS);
        let this = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            if let Some(runtime) = this.threads.write().await.get_mut(&thread_id) {
                runtime.dispatch_retry_scheduled = false;
            }
            this.drain_thread_queue(thread_id).await;
        });
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
    pub(super) async fn drain_thread_queue(self: &Arc<Self>, thread_id: String) {
        let _retirement_admission = match self.retirement_fence.admit(&thread_id).await {
            Ok(admission) => admission,
            Err(_) => return,
        };
        let actor = self.thread_actor(&thread_id).await;
        let actor_guard = actor.lock().await;
        let (queued_item, snapshot) = {
            let mut threads = self.threads.write().await;
            let Some(runtime) = threads.get_mut(&thread_id) else {
                return;
            };
            let runtime_busy = runtime.thread_running
                || runtime.turn_start_in_flight
                || runtime.action_in_flight_item_id.is_some()
                || runtime.editing_item_id.is_some();
            let steer_busy = runtime.steer_prepare_in_flight
                || runtime.steer_dispatch_in_flight.is_some()
                || !runtime.pending_steers.is_empty();
            let has_pending_interactions = !runtime.pending_approval_ids.is_empty()
                || !runtime.pending_user_input_ids.is_empty();
            if runtime_busy || steer_busy || has_pending_interactions {
                return;
            }
            let Some(queued_item) = runtime.items.pop_front() else {
                let completion_event_ids =
                    std::mem::take(&mut runtime.pending_completion_event_ids);
                drop(threads);
                drop(actor_guard);
                for event_id in completion_event_ids {
                    self.record_completion_disposition(event_id, QueueCompletionDisposition::Final)
                        .await;
                }
                return;
            };
            runtime.turn_start_in_flight = true;
            runtime.last_error = None;
            let snapshot = BridgeQueueService::snapshot_for_thread(&thread_id, Some(runtime));
            (queued_item, snapshot)
        };

        self.broadcast_snapshot(&snapshot).await;

        if let Err(error) = self
            .mark_submission_dispatch_pending(&queued_item.submission_id, &thread_id)
            .await
        {
            let failed_submission_id = queued_item.submission_id.clone();
            let (snapshot, retry_attempt, schedule_retry) = {
                let mut threads = self.threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                runtime.turn_start_in_flight = false;
                runtime.items.push_front(queued_item);
                runtime.dispatch_retry_attempt = runtime.dispatch_retry_attempt.saturating_add(1);
                let schedule_retry = !runtime.dispatch_retry_scheduled;
                runtime.dispatch_retry_scheduled = true;
                runtime.last_error = Some(BridgeThreadQueueError {
                    message: error,
                    operation: "persist".to_string(),
                    at: now_iso(),
                    item_id: runtime.items.front().map(|item| item.id.clone()),
                });
                runtime.last_error_submission_id = Some(failed_submission_id);
                (
                    Self::snapshot_for_thread(&thread_id, Some(runtime)),
                    runtime.dispatch_retry_attempt,
                    schedule_retry,
                )
            };
            drop(actor_guard);
            self.broadcast_snapshot(&snapshot).await;
            if schedule_retry {
                self.schedule_auto_dispatch_retry(thread_id, retry_attempt);
            }
            return;
        }

        if let Some(runtime) = self.threads.write().await.get_mut(&thread_id) {
            runtime.dispatch_retry_attempt = 0;
        }
        match self
            .backend
            .turn_start(
                &thread_id,
                &queued_item.turn_start,
                &submission_source_turn_id(&queued_item.submission_id),
            )
            .await
        {
            Ok(turn_id) => {
                let agent_message_id = queued_item
                    .agent_message
                    .as_ref()
                    .map(|message| message.message_id.clone());
                let (completion_event_ids, queue) = {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    runtime.turn_start_in_flight = false;
                    runtime.thread_running = true;
                    runtime.active_turn_id = Some(turn_id.clone());
                    runtime.last_error = None;
                    (
                        std::mem::take(&mut runtime.pending_completion_event_ids),
                        BridgeQueueService::snapshot_for_thread(&thread_id, Some(runtime)),
                    )
                };
                self.remember_sent_submission_until_persisted(
                    BridgeThreadQueueSendResponse {
                        submission_id: queued_item.submission_id,
                        disposition: BridgeThreadQueueDisposition::Sent,
                        queue,
                        turn_id: Some(turn_id),
                    },
                    "dispatched",
                )
                .await;
                drop(actor_guard);
                if let Some(message_id) = agent_message_id {
                    if let Err(error) = self
                        .persist_agent_message_disposition(
                            &message_id,
                            crate::agent_messaging::AgentMessageDisposition::Sent,
                        )
                        .await
                    {
                        eprintln!(
                            "failed to update dispatched agent-message activity {message_id}: {error}",
                        );
                    }
                }
                for event_id in completion_event_ids {
                    self.record_completion_disposition(
                        event_id,
                        QueueCompletionDisposition::Continued,
                    )
                    .await;
                }
            }
            Err(error) => {
                let indeterminate = dispatch_failure_is_indeterminate(&error);
                let failed_submission_id = queued_item.submission_id.clone();
                let failed_item_id = queued_item.id.clone();
                let failed_agent_message_id = queued_item
                    .agent_message
                    .as_ref()
                    .map(|message| message.message_id.clone());
                let _settlement = (!indeterminate).then(|| self.track_definitive_settlement());
                let settlement_error = if indeterminate {
                    None
                } else {
                    self.settle_definitive_dispatch_failure(
                        &failed_submission_id,
                        &thread_id,
                        &error,
                    )
                    .await
                    .err()
                };
                let settlement_converged = !indeterminate && settlement_error.is_none();
                let retry_after_settlement =
                    settlement_converged && !self.definitive_settlement_shutdown.is_cancelled();
                let visible_error = settlement_error.unwrap_or_else(|| error.clone());
                let (snapshot, completion_event_ids, retry) = {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    runtime.turn_start_in_flight = false;
                    if !indeterminate {
                        runtime.items.push_front(queued_item);
                    }
                    let retry = if retry_after_settlement {
                        runtime.dispatch_retry_attempt =
                            runtime.dispatch_retry_attempt.saturating_add(1);
                        let schedule_retry = !runtime.dispatch_retry_scheduled;
                        runtime.dispatch_retry_scheduled = true;
                        schedule_retry.then_some(runtime.dispatch_retry_attempt)
                    } else {
                        None
                    };
                    runtime.last_error = Some(BridgeThreadQueueError {
                        message: visible_error,
                        operation: "dispatch".to_string(),
                        at: now_iso(),
                        item_id: Some(failed_item_id),
                    });
                    runtime.last_error_submission_id = Some(failed_submission_id.clone());
                    (
                        BridgeQueueService::snapshot_for_thread(&thread_id, Some(runtime)),
                        std::mem::take(&mut runtime.pending_completion_event_ids),
                        retry,
                    )
                };
                drop(actor_guard);
                self.broadcast_snapshot(&snapshot).await;
                if let Some(attempt) = retry {
                    self.schedule_auto_dispatch_retry(thread_id.clone(), attempt);
                }
                if indeterminate {
                    if let Some(message_id) = failed_agent_message_id {
                        if let Err(update_error) = self
                            .persist_agent_message_disposition(
                                &message_id,
                                crate::agent_messaging::AgentMessageDisposition::Cancelled,
                            )
                            .await
                        {
                            eprintln!(
                                "failed to settle indeterminate queued agent-message activity {message_id}: {update_error}",
                            );
                        }
                    }
                }
                for event_id in completion_event_ids {
                    self.record_completion_disposition(event_id, QueueCompletionDisposition::Final)
                        .await;
                }
            }
        }
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "queue_service_tests.rs"]
mod tests;
