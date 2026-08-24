use crate::*;

#[derive(Default)]
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
const AGENT_MESSAGE_JOURNAL_UPDATE_ATTEMPTS: usize = 3;
const AGENT_MESSAGE_JOURNAL_UPDATE_RETRY_MS: u64 = 10;

fn dispatch_failure_is_indeterminate(error: &str) -> bool {
    error.starts_with(INDETERMINATE_OPERATION_PREFIX)
}

fn trim_queue_pending(pending: &mut HashMap<String, String>, order: &mut VecDeque<String>) {
    order.retain(|submission_id| pending.contains_key(submission_id));
    let ordered = order.iter().cloned().collect::<HashSet<_>>();
    let mut missing = pending
        .keys()
        .filter(|submission_id| !ordered.contains(*submission_id))
        .cloned()
        .collect::<Vec<_>>();
    missing.sort();
    order.extend(missing);
    while order.len() > SUBMISSION_DEDUPE_LIMIT {
        if let Some(oldest) = order.pop_front() {
            pending.remove(&oldest);
        }
    }
}

fn validate_queue_identifier(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    if value.len() > QUEUE_IDENTIFIER_MAX_BYTES {
        return Err(format!(
            "{name} must be at most {QUEUE_IDENTIFIER_MAX_BYTES} bytes"
        ));
    }
    Ok(())
}

fn replace_turn_start_text(turn_start: &mut Value, content: &str) -> Result<(), String> {
    let input = turn_start
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "queued turnStart input is unavailable".to_string())?;
    let text_input = input
        .iter_mut()
        .find(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "queued turnStart text input is unavailable".to_string())?;
    text_input.insert("text".to_string(), Value::String(content.to_string()));
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
    pub(super) fn new<B>(backend: Arc<B>, hub: Arc<ClientHub>) -> Arc<Self>
    where
        B: QueueRuntimeDispatcher + 'static,
    {
        Self::with_submission_store(backend, hub, None, DurableQueueSubmissions::default())
    }

    pub(super) fn with_submission_store<B>(
        backend: Arc<B>,
        hub: Arc<ClientHub>,
        submission_store_path: Option<std::path::PathBuf>,
        submissions: DurableQueueSubmissions,
    ) -> Arc<Self>
    where
        B: QueueRuntimeDispatcher + 'static,
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
            submission_pending: Arc::new(Mutex::new(submissions.pending)),
            submission_pending_order: Arc::new(Mutex::new(submissions.pending_order)),
            submission_store_path,
            submission_persist: Arc::new(Mutex::new(())),
            submission_dirty: AtomicBool::new(false),
            next_queue_item_id: AtomicU64::new(1),
        });
        service.spawn_notification_loop();
        service
    }

    pub(super) async fn load_submission_store(
        path: &std::path::Path,
    ) -> Result<DurableQueueSubmissions, String> {
        match tokio::fs::read(path).await {
            Ok(bytes) => {
                if bytes.len() > QUEUE_RECEIPT_STORE_MAX_BYTES {
                    return Err(format!(
                        "queue idempotency state exceeds {QUEUE_RECEIPT_STORE_MAX_BYTES} bytes"
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
                trim_queue_pending(&mut state.pending, &mut state.pending_order);
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
            self.next_queue_item_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    pub(super) async fn thread_actor(&self, thread_id: &str) -> Arc<Mutex<()>> {
        if let Some(actor) = self.thread_actors.read().await.get(thread_id).cloned() {
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
        let durable_blockers = usize::from(self.submission_dirty.load(Ordering::Acquire));
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
            if let Some(disposition) = self.completion_dispositions.lock().await.remove(&event_id) {
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
        self.send_message_with_origin(request, None).await
    }

    async fn send_message_with_origin(
        &self,
        request: BridgeThreadQueueSendRequest,
        agent_message: Option<crate::agent_messaging::AgentMessageOrigin>,
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
                "submissionId must be at most {PUSH_ID_MAX_BYTES} bytes"
            ));
        }
        if content.len() > QUEUE_MAX_CONTENT_BYTES {
            return Err(format!(
                "queue content exceeds {QUEUE_MAX_CONTENT_BYTES} bytes (actual {})",
                content.len()
            ));
        }
        let item_bytes = serde_json::to_vec(&request.turn_start)
            .map(|value| value.len())
            .unwrap_or(usize::MAX)
            .saturating_add(content.len());
        if item_bytes > QUEUE_MAX_ITEM_BYTES {
            return Err(format!(
                "queue item exceeds {QUEUE_MAX_ITEM_BYTES} bytes (actual {item_bytes})"
            ));
        }

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
                        "queue limit reached for thread (max {QUEUE_MAX_ITEMS_PER_THREAD})"
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
                        queued_bytes.saturating_add(item_bytes)
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
            .dispatch_turn_start(&normalized_thread_id, &queued_item.turn_start)
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
                    }
                }
                if !dispatch_failure_is_indeterminate(&error) {
                    if let Err(persist_error) = self.release_submission(&submission_id).await {
                        eprintln!(
                            "failed to release queue submission after definitive dispatch error: {persist_error}"
                        );
                    }
                }
                Err(error)
            }
        }
    }

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
                            envelope.message_id
                        );
                    }
                } else if let Err(remove_error) = self
                    .backend
                    .remove_agent_message(&envelope.message_id)
                    .await
                {
                    eprintln!(
                        "failed to remove rejected agent-message activity {}: {remove_error}",
                        envelope.message_id
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
                envelope.message_id
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
        if let Some(pending_thread_id) = self
            .submission_pending
            .lock()
            .await
            .get(submission_id)
            .cloned()
        {
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
        Ok(None)
    }

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
        let previous_pending = if persist_pending {
            Some((
                self.submission_pending.lock().await.clone(),
                self.submission_pending_order.lock().await.clone(),
            ))
        } else {
            None
        };
        {
            let mut pending = self.submission_pending.lock().await;
            let mut pending_order = self.submission_pending_order.lock().await;
            let inserted = pending
                .insert(submission_id.to_string(), thread_id.to_string())
                .is_none();
            if persist_pending && inserted {
                pending_order.push_back(submission_id.to_string());
                trim_queue_pending(&mut pending, &mut pending_order);
            }
        }
        if persist_pending {
            if let Err(error) = self.persist_submission_store_locked().await {
                let (pending, order) = previous_pending.expect("persistent reservation snapshot");
                *self.submission_pending.lock().await = pending;
                *self.submission_pending_order.lock().await = order;
                let _ = self.persist_submission_store_locked().await;
                return Err(error);
            }
        }
        Ok(None)
    }

    async fn release_submission(&self, submission_id: &str) -> Result<(), String> {
        let _persist = self.submission_persist.lock().await;
        if self
            .submission_pending
            .lock()
            .await
            .remove(submission_id)
            .is_none()
        {
            return Ok(());
        }
        self.submission_pending_order
            .lock()
            .await
            .retain(|candidate| candidate != submission_id);
        self.persist_submission_store_locked().await?;
        Ok(())
    }

    async fn mark_submission_dispatch_pending(
        &self,
        submission_id: &str,
        thread_id: &str,
    ) -> Result<(), String> {
        let _persist = self.submission_persist.lock().await;
        let previous_pending = self.submission_pending.lock().await.clone();
        let previous_order = self.submission_pending_order.lock().await.clone();
        {
            let mut pending = self.submission_pending.lock().await;
            let mut pending_order = self.submission_pending_order.lock().await;
            if pending
                .insert(submission_id.to_string(), thread_id.to_string())
                .is_none()
            {
                pending_order.push_back(submission_id.to_string());
            }
            trim_queue_pending(&mut pending, &mut pending_order);
        }
        if let Err(error) = self.persist_submission_store_locked().await {
            *self.submission_pending.lock().await = previous_pending;
            *self.submission_pending_order.lock().await = previous_order;
            let _ = self.persist_submission_store_locked().await;
            return Err(error);
        }
        Ok(())
    }

    async fn forget_submission_result(&self, submission_id: &str) -> Result<(), String> {
        let _persist = self.submission_persist.lock().await;
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

    pub(super) async fn remember_submission_result(
        &self,
        result: BridgeThreadQueueSendResponse,
    ) -> Result<(), String> {
        let _persist = self.submission_persist.lock().await;
        let submission_id = result.submission_id.clone();
        let receipt = BridgeQueueSubmissionReceipt {
            submission_id: submission_id.clone(),
            thread_id: result.queue.thread_id,
            disposition: result.disposition,
            turn_id: result.turn_id,
        };
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
        self.submission_pending.lock().await.remove(&submission_id);
        self.submission_pending_order
            .lock()
            .await
            .retain(|candidate| candidate != &submission_id);
        self.persist_submission_store_locked().await
    }

    async fn persist_submission_store(&self) -> Result<(), String> {
        let _persist = self.submission_persist.lock().await;
        self.persist_submission_store_locked().await
    }

    async fn persist_submission_store_locked(&self) -> Result<(), String> {
        let Some(path) = &self.submission_store_path else {
            self.submission_dirty.store(false, Ordering::Release);
            return Ok(());
        };
        let results = self.submission_results.lock().await;
        let order = self.submission_order.lock().await;
        let mut pending = self.submission_pending.lock().await.clone();
        let mut pending_order = self.submission_pending_order.lock().await.clone();
        trim_queue_pending(&mut pending, &mut pending_order);
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
        drop(order);
        drop(results);
        let bytes = loop {
            let bytes = serde_json::to_vec(&snapshot)
                .map_err(|error| format!("failed to serialize queue idempotency state: {error}"))?;
            if bytes.len() <= QUEUE_RECEIPT_STORE_MAX_BYTES {
                break bytes;
            }
            let entry_count = snapshot.order.len() + snapshot.pending_order.len();
            if entry_count == 0 {
                self.submission_dirty.store(true, Ordering::Release);
                return Err("queue idempotency state exceeds its byte budget".to_string());
            }
            let batch_size = entry_count
                .saturating_mul(bytes.len() - QUEUE_RECEIPT_STORE_MAX_BYTES)
                .div_ceil(bytes.len())
                .max(1);
            if !snapshot.order.is_empty() {
                for _ in 0..batch_size.min(snapshot.order.len()) {
                    let oldest = snapshot
                        .order
                        .pop_front()
                        .expect("receipt order is non-empty");
                    snapshot.receipts.remove(&oldest);
                }
                continue;
            }
            for _ in 0..batch_size.min(snapshot.pending_order.len()) {
                let oldest = snapshot
                    .pending_order
                    .pop_front()
                    .expect("pending order is non-empty");
                snapshot.pending.remove(&oldest);
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
                    "failed to persist queue idempotency state: {error}"
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

    async fn steer_message_inner(
        self: &Arc<Self>,
        request: BridgeThreadQueueSteerRequest,
        automatic_agent_steer: bool,
    ) -> Result<BridgeThreadQueueActionResponse, String> {
        let normalized_thread_id = request.thread_id.trim().to_string();
        let normalized_item_id = request.item_id.trim().to_string();
        validate_queue_identifier("threadId", &normalized_thread_id)?;
        validate_queue_identifier("itemId", &normalized_item_id)?;

        self.ensure_thread_runtime(&normalized_thread_id).await?;
        if !self.backend.supports_steer(&normalized_thread_id)? {
            return Err("ACP steering extension is not negotiated for this agent".to_string());
        }
        if !self
            .threads
            .read()
            .await
            .get(&normalized_thread_id)
            .is_some_and(|runtime| {
                runtime
                    .items
                    .iter()
                    .any(|item| item.id == normalized_item_id)
            })
        {
            return Err("queued message not found".to_string());
        }
        if !automatic_agent_steer
            && self
                .threads
                .read()
                .await
                .get(&normalized_thread_id)
                .and_then(|runtime| {
                    runtime
                        .items
                        .iter()
                        .find(|item| item.id == normalized_item_id)
                })
                .is_some_and(|item| item.agent_message.is_some())
        {
            return Err("agent messages are steered automatically".to_string());
        }
        let actor = self.thread_actor(&normalized_thread_id).await;
        let _actor_guard = actor.lock().await;

        let snapshot = {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .get_mut(&normalized_thread_id)
                .ok_or_else(|| "queue state unavailable".to_string())?;

            if runtime.turn_start_in_flight || runtime.action_in_flight_item_id.is_some() {
                return Err("queue is busy processing another action".to_string());
            }
            if runtime.editing_item_id.is_some() {
                return Err("finish editing the queued message before steering".to_string());
            }
            if !runtime.thread_running
                || runtime.active_turn_id.is_none()
                || runtime.active_run_id.is_none()
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
                content.len()
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
                    "queue item exceeds {QUEUE_MAX_ITEM_BYTES} bytes (actual {item_bytes})"
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
                    other_queued_bytes.saturating_add(item_bytes)
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
    ) -> Result<String, String> {
        self.backend.turn_start(thread_id, turn_start).await
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

    pub(super) async fn drain_pending_steers(self: &Arc<Self>, thread_id: String) {
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
                if runtime.pending_steers.is_empty()
                    || runtime.steer_prepare_in_flight
                    || runtime.steer_dispatch_in_flight.is_some()
                    || runtime.turn_start_in_flight
                    || runtime.action_in_flight_item_id.is_some()
                    || (!runtime.active_tool_call_ids.is_empty() && !live_agent_message)
                    || (live_agent_message
                        && (!runtime.pending_approval_ids.is_empty()
                            || !runtime.pending_user_input_ids.is_empty()))
                    || !runtime.live_generation_known
                    || !runtime.thread_running
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
                if runtime.steer_dispatch_in_flight.is_some()
                    || runtime.turn_start_in_flight
                    || runtime.action_in_flight_item_id.is_some()
                    || (!runtime.active_tool_call_ids.is_empty() && !live_agent_message)
                    || !runtime.live_generation_known
                    || !runtime.thread_running
                    || !runtime.pending_approval_ids.is_empty()
                    || !runtime.pending_user_input_ids.is_empty()
                {
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
                Ok(crate::acp::harness::HarnessAgentMessageOutcome::Deferred)
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
                    Ok(crate::acp::harness::HarnessAgentMessageOutcome::Delivered)
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
                if let Err(error) = self
                    .remember_submission_result(BridgeThreadQueueSendResponse {
                        submission_id,
                        disposition: BridgeThreadQueueDisposition::Sent,
                        queue: snapshot.0.clone(),
                        turn_id: Some(turn_id),
                    })
                    .await
                {
                    eprintln!("failed to persist successful steer receipt: {error}");
                }
                if let Some(message_id) = agent_message_id {
                    if let Err(error) = self
                        .persist_agent_message_disposition(
                            &message_id,
                            crate::agent_messaging::AgentMessageDisposition::Sent,
                        )
                        .await
                    {
                        eprintln!(
                            "failed to settle steered agent-message activity {message_id}: {error}"
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
                        "failed to settle indeterminate steered agent-message activity {message_id}: {error}"
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
                        "failed to persist requeued agent-message activity {message_id}: {error}"
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
            if let Some(owned) = runtime.steer_dispatch_in_flight.take() {
                runtime.pending_steers.push_front(owned.entry);
            }
            runtime.last_error = Some(BridgeThreadQueueError {
                message: error,
                operation: "steer".to_string(),
                at: now_iso(),
                item_id: Some(item_id.to_string()),
            });
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

    pub(super) fn snapshot_for_thread(
        thread_id: &str,
        runtime: Option<&BridgeThreadQueueRuntime>,
    ) -> BridgeThreadQueueState {
        let (
            items,
            pending_steers,
            editing_item_id,
            waiting_for_tool_calls,
            steering_in_flight,
            last_error,
        ) = runtime.map_or(
            (Vec::new(), Vec::new(), None, false, false, None),
            |runtime| {
                (
                    runtime
                        .items
                        .iter()
                        .map(BridgeQueuedMessageEntry::to_public)
                        .collect::<Vec<_>>(),
                    runtime
                        .steer_dispatch_in_flight
                        .iter()
                        .map(|dispatch| &dispatch.entry)
                        .chain(runtime.pending_steers.iter())
                        .map(BridgeQueuedMessageEntry::to_public)
                        .collect::<Vec<_>>(),
                    runtime.editing_item_id.clone(),
                    !runtime.pending_steers.is_empty() && !runtime.active_tool_call_ids.is_empty(),
                    runtime.steer_dispatch_in_flight.is_some(),
                    runtime.last_error.clone(),
                )
            },
        );
        let pending_steer_count = pending_steers.len();

        BridgeThreadQueueState {
            thread_id: thread_id.to_string(),
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

    pub(super) async fn handle_canonical_event(self: &Arc<Self>, received: CanonicalHubEvent) {
        let Some(thread_id) = received.event.thread_id().map(str::to_string) else {
            return;
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
                                    "failed to persist requeued agent-message activity {message_id}: {error}"
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
                        agent_client_protocol::schema::v1::ToolCallStatus::Pending
                        | agent_client_protocol::schema::v1::ToolCallStatus::InProgress => {
                            runtime.active_tool_call_ids.insert(tool_call_id);
                        }
                        agent_client_protocol::schema::v1::ToolCallStatus::Completed
                        | agent_client_protocol::schema::v1::ToolCallStatus::Failed => {
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

    pub(super) async fn drain_thread_queue(self: &Arc<Self>, thread_id: String) {
        let actor = self.thread_actor(&thread_id).await;
        let actor_guard = actor.lock().await;
        let (queued_item, snapshot) = {
            let mut threads = self.threads.write().await;
            let Some(runtime) = threads.get_mut(&thread_id) else {
                return;
            };
            if runtime.thread_running
                || runtime.turn_start_in_flight
                || runtime.action_in_flight_item_id.is_some()
                || runtime.editing_item_id.is_some()
                || runtime.steer_prepare_in_flight
                || runtime.steer_dispatch_in_flight.is_some()
                || !runtime.pending_steers.is_empty()
                || !runtime.pending_approval_ids.is_empty()
                || !runtime.pending_user_input_ids.is_empty()
            {
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
            .turn_start(&thread_id, &queued_item.turn_start)
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
                drop(actor_guard);
                if let Err(error) = self
                    .remember_submission_result(BridgeThreadQueueSendResponse {
                        submission_id: queued_item.submission_id,
                        disposition: BridgeThreadQueueDisposition::Sent,
                        queue,
                        turn_id: Some(turn_id),
                    })
                    .await
                {
                    eprintln!("failed to persist dispatched queue submission: {error}");
                }
                if let Some(message_id) = agent_message_id {
                    if let Err(error) = self
                        .persist_agent_message_disposition(
                            &message_id,
                            crate::agent_messaging::AgentMessageDisposition::Sent,
                        )
                        .await
                    {
                        eprintln!(
                            "failed to update dispatched agent-message activity {message_id}: {error}"
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
                let (snapshot, completion_event_ids) = {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    runtime.turn_start_in_flight = false;
                    if !indeterminate {
                        runtime.items.push_front(queued_item);
                    }
                    runtime.last_error = Some(BridgeThreadQueueError {
                        message: error.clone(),
                        operation: "dispatch".to_string(),
                        at: now_iso(),
                        item_id: Some(failed_item_id),
                    });
                    (
                        BridgeQueueService::snapshot_for_thread(&thread_id, Some(runtime)),
                        std::mem::take(&mut runtime.pending_completion_event_ids),
                    )
                };
                drop(actor_guard);
                if !indeterminate {
                    if let Err(persist_error) = self
                        .remember_submission_result(BridgeThreadQueueSendResponse {
                            submission_id: failed_submission_id,
                            disposition: BridgeThreadQueueDisposition::Queued,
                            queue: snapshot.clone(),
                            turn_id: None,
                        })
                        .await
                    {
                        eprintln!(
                            "failed to clear queue dispatch reservation after error: {persist_error}"
                        );
                    }
                }
                self.broadcast_snapshot(&snapshot).await;
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
                                "failed to settle indeterminate queued agent-message activity {message_id}: {update_error}"
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
mod tests {
    use std::sync::Mutex as StdMutex;

    use agent_client_protocol::schema::v1::{ContentBlock, StopReason, ToolCallStatus, ToolKind};
    use futures_util::future::BoxFuture;

    use crate::acp::events::CanonicalEvent;

    use super::*;

    struct SteerCall {
        thread_id: String,
        expected_run_id: String,
        expected_source_turn_id: String,
        prompt_generation: u64,
        prompt: Vec<ContentBlock>,
        response: oneshot::Sender<Result<(), String>>,
    }

    struct LiveAgentMessageCall {
        thread_id: String,
        expected_run_id: String,
        expected_source_turn_id: String,
        prompt_generation: u64,
        prompt: Vec<ContentBlock>,
        response: oneshot::Sender<Result<crate::acp::harness::HarnessAgentMessageOutcome, String>>,
    }

    struct PrepareCall {
        thread_id: String,
        response: oneshot::Sender<Result<u64, String>>,
    }

    struct VerifyEpochCall {
        thread_id: String,
        epoch: u64,
        response: oneshot::Sender<Result<bool, String>>,
    }

    struct TurnStartCall {
        thread_id: String,
        turn_start: Value,
        response: oneshot::Sender<Result<String, String>>,
    }

    struct DispositionUpdateCall {
        message_id: String,
        disposition: crate::agent_messaging::AgentMessageDisposition,
        response: oneshot::Sender<Result<(), String>>,
    }

    struct FakeQueueDispatcher {
        snapshot: StdMutex<QueueRuntimeSnapshot>,
        snapshot_error: StdMutex<Option<String>>,
        supports_steer: AtomicBool,
        supports_live_agent_message: AtomicBool,
        manual_epoch: Arc<AtomicBool>,
        supports_steer_error: StdMutex<Option<String>>,
        steer_tx: mpsc::UnboundedSender<SteerCall>,
        live_agent_message_tx: mpsc::UnboundedSender<LiveAgentMessageCall>,
        prepare_tx: mpsc::UnboundedSender<PrepareCall>,
        verify_epoch_tx: mpsc::UnboundedSender<VerifyEpochCall>,
        turn_start_tx: mpsc::UnboundedSender<TurnStartCall>,
        disposition_update_tx: mpsc::UnboundedSender<DispositionUpdateCall>,
        manual_disposition_update: Arc<AtomicBool>,
        record_agent_messages_error: StdMutex<Option<String>>,
        update_agent_message_failures: AtomicU64,
        recorded_agent_messages:
            Arc<StdMutex<Vec<(String, crate::agent_messaging::AgentMessageOrigin)>>>,
        published_agent_message_ids: Arc<StdMutex<Vec<String>>>,
        removed_agent_message_ids: Arc<StdMutex<Vec<String>>>,
        updated_agent_message_dispositions:
            Arc<StdMutex<Vec<(String, crate::agent_messaging::AgentMessageDisposition)>>>,
    }

    struct FakeReceivers {
        steer: mpsc::UnboundedReceiver<SteerCall>,
        live_agent_message: mpsc::UnboundedReceiver<LiveAgentMessageCall>,
        prepare: mpsc::UnboundedReceiver<PrepareCall>,
        verify_epoch: mpsc::UnboundedReceiver<VerifyEpochCall>,
        turn_start: mpsc::UnboundedReceiver<TurnStartCall>,
        disposition_update: mpsc::UnboundedReceiver<DispositionUpdateCall>,
        manual_disposition_update: Arc<AtomicBool>,
        manual_epoch: Arc<AtomicBool>,
        recorded_agent_messages:
            Arc<StdMutex<Vec<(String, crate::agent_messaging::AgentMessageOrigin)>>>,
        published_agent_message_ids: Arc<StdMutex<Vec<String>>>,
        removed_agent_message_ids: Arc<StdMutex<Vec<String>>>,
        updated_agent_message_dispositions:
            Arc<StdMutex<Vec<(String, crate::agent_messaging::AgentMessageDisposition)>>>,
    }

    impl QueueRuntimeDispatcher for FakeQueueDispatcher {
        fn read_snapshot<'a>(
            &'a self,
            _thread_id: &'a str,
        ) -> BoxFuture<'a, Result<QueueRuntimeSnapshot, String>> {
            if let Some(error) = self
                .snapshot_error
                .lock()
                .expect("snapshot error lock")
                .clone()
            {
                return Box::pin(async move { Err(error) });
            }
            let snapshot = self.snapshot.lock().expect("snapshot lock").clone();
            Box::pin(async move { Ok(snapshot) })
        }

        fn supports_steer(&self, _thread_id: &str) -> Result<bool, String> {
            if let Some(error) = self
                .supports_steer_error
                .lock()
                .expect("supports steer error lock")
                .clone()
            {
                return Err(error);
            }
            Ok(self.supports_steer.load(Ordering::SeqCst))
        }

        fn supports_live_agent_message(&self, _thread_id: &str) -> Result<bool, String> {
            Ok(self.supports_live_agent_message.load(Ordering::SeqCst))
        }

        fn prepare_steer<'a>(&'a self, thread_id: &'a str) -> BoxFuture<'a, Result<u64, String>> {
            if !self.manual_epoch.load(Ordering::SeqCst) {
                return Box::pin(async { Ok(1) });
            }
            Box::pin(async move {
                let (response, received) = oneshot::channel();
                self.prepare_tx
                    .send(PrepareCall {
                        thread_id: thread_id.to_string(),
                        response,
                    })
                    .map_err(|_| "prepare receiver closed".to_string())?;
                received
                    .await
                    .map_err(|_| "prepare response dropped".to_string())?
            })
        }

        fn current_steer_epoch<'a>(
            &'a self,
            _thread_id: &'a str,
        ) -> BoxFuture<'a, Result<u64, String>> {
            Box::pin(async { Ok(1) })
        }

        fn verify_steer_epoch<'a>(
            &'a self,
            thread_id: &'a str,
            epoch: u64,
        ) -> BoxFuture<'a, Result<bool, String>> {
            if !self.manual_epoch.load(Ordering::SeqCst) {
                return Box::pin(async { Ok(true) });
            }
            Box::pin(async move {
                let (response, received) = oneshot::channel();
                self.verify_epoch_tx
                    .send(VerifyEpochCall {
                        thread_id: thread_id.to_string(),
                        epoch,
                        response,
                    })
                    .map_err(|_| "verify epoch receiver closed".to_string())?;
                received
                    .await
                    .map_err(|_| "verify epoch response dropped".to_string())?
            })
        }

        fn steer<'a>(
            &'a self,
            thread_id: &'a str,
            expected_run_id: String,
            expected_source_turn_id: String,
            prompt_generation: u64,
            _interaction_epoch: u64,
            prompt: Vec<ContentBlock>,
        ) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                let (response, received) = oneshot::channel();
                self.steer_tx
                    .send(SteerCall {
                        thread_id: thread_id.to_string(),
                        expected_run_id,
                        expected_source_turn_id,
                        prompt_generation,
                        prompt,
                        response,
                    })
                    .map_err(|_| "steer receiver closed".to_string())?;
                received
                    .await
                    .map_err(|_| "steer response dropped".to_string())?
            })
        }

        fn deliver_live_agent_message<'a>(
            &'a self,
            thread_id: &'a str,
            expected_run_id: String,
            expected_source_turn_id: String,
            prompt_generation: u64,
            _interaction_epoch: u64,
            prompt: Vec<ContentBlock>,
        ) -> BoxFuture<'a, Result<crate::acp::harness::HarnessAgentMessageOutcome, String>>
        {
            Box::pin(async move {
                let (response, received) = oneshot::channel();
                self.live_agent_message_tx
                    .send(LiveAgentMessageCall {
                        thread_id: thread_id.to_string(),
                        expected_run_id,
                        expected_source_turn_id,
                        prompt_generation,
                        prompt,
                        response,
                    })
                    .map_err(|_| "live agent message receiver closed".to_string())?;
                received
                    .await
                    .map_err(|_| "live agent message response dropped".to_string())?
            })
        }

        fn turn_start<'a>(
            &'a self,
            thread_id: &'a str,
            turn_start: &'a Value,
        ) -> BoxFuture<'a, Result<String, String>> {
            let turn_start = turn_start.clone();
            Box::pin(async move {
                let (response, received) = oneshot::channel();
                self.turn_start_tx
                    .send(TurnStartCall {
                        thread_id: thread_id.to_string(),
                        turn_start,
                        response,
                    })
                    .map_err(|_| "turn start receiver closed".to_string())?;
                received
                    .await
                    .map_err(|_| "turn start response dropped".to_string())?
            })
        }

        fn record_agent_messages<'a>(
            &'a self,
            messages: Vec<(String, crate::agent_messaging::AgentMessageOrigin)>,
        ) -> BoxFuture<'a, Result<(), String>> {
            if let Some(error) = self
                .record_agent_messages_error
                .lock()
                .expect("record agent messages error lock")
                .clone()
            {
                return Box::pin(async move { Err(error) });
            }
            self.recorded_agent_messages
                .lock()
                .expect("recorded agent messages lock")
                .extend(messages);
            Box::pin(async { Ok(()) })
        }

        fn update_agent_message_disposition<'a>(
            &'a self,
            message_id: &'a str,
            disposition: crate::agent_messaging::AgentMessageDisposition,
        ) -> BoxFuture<'a, Result<(), String>> {
            if self.manual_disposition_update.load(Ordering::SeqCst) {
                return Box::pin(async move {
                    let (response, received) = oneshot::channel();
                    self.disposition_update_tx
                        .send(DispositionUpdateCall {
                            message_id: message_id.to_string(),
                            disposition,
                            response,
                        })
                        .map_err(|_| "disposition update receiver closed".to_string())?;
                    received
                        .await
                        .map_err(|_| "disposition update response dropped".to_string())?
                });
            }
            self.updated_agent_message_dispositions
                .lock()
                .expect("updated agent message dispositions lock")
                .push((message_id.to_string(), disposition));
            if self
                .update_agent_message_failures
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Box::pin(async { Err("journal update unavailable".to_string()) });
            }
            Box::pin(async { Ok(()) })
        }

        fn publish_agent_message<'a>(&'a self, message_id: &'a str) -> BoxFuture<'a, ()> {
            self.published_agent_message_ids
                .lock()
                .expect("published agent message ids lock")
                .push(message_id.to_string());
            Box::pin(async {})
        }

        fn remove_agent_message<'a>(
            &'a self,
            message_id: &'a str,
        ) -> BoxFuture<'a, Result<(), String>> {
            self.removed_agent_message_ids
                .lock()
                .expect("removed agent message ids lock")
                .push(message_id.to_string());
            self.recorded_agent_messages
                .lock()
                .expect("recorded agent messages lock")
                .retain(|(_, message)| message.message_id != message_id);
            Box::pin(async { Ok(()) })
        }
    }

    fn fake_dispatcher() -> (Arc<FakeQueueDispatcher>, FakeReceivers) {
        let (steer_tx, steer) = mpsc::unbounded_channel();
        let (live_agent_message_tx, live_agent_message) = mpsc::unbounded_channel();
        let (prepare_tx, prepare) = mpsc::unbounded_channel();
        let (verify_epoch_tx, verify_epoch) = mpsc::unbounded_channel();
        let (turn_start_tx, turn_start) = mpsc::unbounded_channel();
        let (disposition_update_tx, disposition_update) = mpsc::unbounded_channel();
        let manual_epoch = Arc::new(AtomicBool::new(false));
        let manual_disposition_update = Arc::new(AtomicBool::new(false));
        let recorded_agent_messages = Arc::new(StdMutex::new(Vec::new()));
        let published_agent_message_ids = Arc::new(StdMutex::new(Vec::new()));
        let removed_agent_message_ids = Arc::new(StdMutex::new(Vec::new()));
        let updated_agent_message_dispositions = Arc::new(StdMutex::new(Vec::new()));
        let mut session =
            crate::acp::snapshot::SessionSnapshot::new("agent".to_string(), "thread".to_string());
        session.active_run_id = Some("run".to_string());
        session.active_source_turn_id = Some("turn".to_string());
        session.active_generation = Some(7);
        (
            Arc::new(FakeQueueDispatcher {
                snapshot: StdMutex::new(QueueRuntimeSnapshot {
                    session,
                    pending_approval_ids: HashSet::new(),
                    pending_user_input_ids: HashSet::new(),
                }),
                snapshot_error: StdMutex::new(None),
                supports_steer: AtomicBool::new(true),
                supports_live_agent_message: AtomicBool::new(false),
                manual_epoch: manual_epoch.clone(),
                supports_steer_error: StdMutex::new(None),
                steer_tx,
                live_agent_message_tx,
                prepare_tx,
                verify_epoch_tx,
                turn_start_tx,
                disposition_update_tx,
                manual_disposition_update: manual_disposition_update.clone(),
                record_agent_messages_error: StdMutex::new(None),
                update_agent_message_failures: AtomicU64::new(0),
                recorded_agent_messages: recorded_agent_messages.clone(),
                published_agent_message_ids: published_agent_message_ids.clone(),
                removed_agent_message_ids: removed_agent_message_ids.clone(),
                updated_agent_message_dispositions: updated_agent_message_dispositions.clone(),
            }),
            FakeReceivers {
                steer,
                live_agent_message,
                prepare,
                verify_epoch,
                turn_start,
                disposition_update,
                manual_disposition_update,
                manual_epoch,
                recorded_agent_messages,
                published_agent_message_ids,
                removed_agent_message_ids,
                updated_agent_message_dispositions,
            },
        )
    }

    fn queued(id: &str) -> BridgeQueuedMessageEntry {
        BridgeQueuedMessageEntry {
            id: id.to_string(),
            submission_id: format!("submission-{id}"),
            created_at: format!("created-{id}"),
            content: format!("content-{id}"),
            turn_start: json!({
                "input": [
                    {"type": "text", "text": format!("text-{id}"), "text_elements": []},
                    {"type": "mention", "name": "source.rs", "path": "/repo/source.rs"},
                    {"type": "localImage", "path": "/repo/screen.png"}
                ]
            }),
            agent_message: None,
        }
    }

    fn active_runtime(item_ids: &[&str], tool_ids: &[&str]) -> BridgeThreadQueueRuntime {
        BridgeThreadQueueRuntime {
            items: item_ids.iter().map(|id| queued(id)).collect(),
            active_turn_id: Some("turn".to_string()),
            active_run_id: Some("run".to_string()),
            active_prompt_generation: Some(7),
            active_tool_call_ids: tool_ids.iter().map(|id| id.to_string()).collect(),
            live_generation_known: true,
            thread_running: true,
            ..BridgeThreadQueueRuntime::default()
        }
    }

    async fn service_with_runtime(
        item_ids: &[&str],
        tool_ids: &[&str],
    ) -> (Arc<BridgeQueueService>, FakeReceivers) {
        let (backend, receivers) = fake_dispatcher();
        let service = BridgeQueueService::new(backend.clone(), Arc::new(ClientHub::new()));
        service
            .threads
            .write()
            .await
            .insert("thread".to_string(), active_runtime(item_ids, tool_ids));
        (service, receivers)
    }

    async fn assert_late_dispatch_blocker<F>(
        service: &Arc<BridgeQueueService>,
        calls: &mut FakeReceivers,
        configure: F,
    ) where
        F: FnOnce(&mut BridgeThreadQueueRuntime),
    {
        calls.manual_epoch.store(true, Ordering::SeqCst);
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            *runtime = active_runtime(&[], &[]);
            runtime.pending_steers.push_back(queued("steer"));
        }

        let dispatch_service = Arc::clone(service);
        let dispatch = tokio::spawn(async move {
            dispatch_service
                .drain_pending_steers("thread".to_string())
                .await;
        });
        let prepare = tokio::time::timeout(Duration::from_secs(1), calls.prepare.recv())
            .await
            .expect("steer preparation timeout")
            .expect("steer preparation");
        prepare.response.send(Ok(1)).unwrap();
        let verify = tokio::time::timeout(Duration::from_secs(1), calls.verify_epoch.recv())
            .await
            .expect("steer epoch verification timeout")
            .expect("steer epoch verification");
        {
            let mut threads = service.threads.write().await;
            configure(threads.get_mut("thread").unwrap());
        }
        verify.response.send(Ok(true)).unwrap();
        tokio::time::timeout(Duration::from_secs(1), dispatch)
            .await
            .expect("blocked steer dispatch timeout")
            .expect("blocked steer dispatch task");

        assert!(service
            .read_queue("thread")
            .await
            .pending_steers
            .iter()
            .any(|entry| entry.id == "steer"));
        assert!(calls.steer.try_recv().is_err());
    }

    #[test]
    fn runtime_blockers_report_each_busy_state() {
        let mut runtime = BridgeThreadQueueRuntime::default();
        assert!(!BridgeQueueService::runtime_has_blockers(&runtime));

        runtime.thread_running = true;
        assert!(BridgeQueueService::runtime_has_blockers(&runtime));
        runtime.thread_running = false;

        runtime.turn_start_in_flight = true;
        assert!(BridgeQueueService::runtime_has_blockers(&runtime));
        runtime.turn_start_in_flight = false;

        runtime.action_in_flight_item_id = Some("item".to_string());
        assert!(BridgeQueueService::runtime_has_blockers(&runtime));
        runtime.action_in_flight_item_id = None;

        runtime.steer_prepare_in_flight = true;
        assert!(BridgeQueueService::runtime_has_blockers(&runtime));
        runtime.steer_prepare_in_flight = false;

        runtime.steer_dispatch_in_flight = Some(PendingSteerDispatch {
            entry: queued("steer"),
            expected_turn_id: "turn".to_string(),
            expected_run_id: "run".to_string(),
            prompt_generation: 1,
            crossed_completion_boundary: false,
        });
        assert!(BridgeQueueService::runtime_has_blockers(&runtime));
        runtime.steer_dispatch_in_flight = None;

        runtime.pending_steers.push_back(queued("pending"));
        assert!(BridgeQueueService::runtime_has_blockers(&runtime));
        runtime.pending_steers.clear();

        runtime.pending_approval_ids.insert("approval".to_string());
        assert!(BridgeQueueService::runtime_has_blockers(&runtime));
        runtime.pending_approval_ids.clear();

        runtime.pending_user_input_ids.insert("input".to_string());
        assert!(BridgeQueueService::runtime_has_blockers(&runtime));
    }

    #[tokio::test]
    async fn pending_steer_drain_honors_each_preparation_blocker() {
        let (service, mut calls) = service_with_runtime(&["steer"], &[]).await;
        calls.manual_epoch.store(true, Ordering::SeqCst);
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime
                .pending_steers
                .push_back(runtime.items.pop_front().unwrap());
            runtime.steer_prepare_in_flight = true;
        }
        tokio::time::timeout(
            Duration::from_secs(1),
            service.drain_pending_steers("thread".to_string()),
        )
        .await
        .expect("prepare blocker returns without dispatch");

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.steer_prepare_in_flight = false;
            runtime.turn_start_in_flight = true;
        }
        tokio::time::timeout(
            Duration::from_secs(1),
            service.drain_pending_steers("thread".to_string()),
        )
        .await
        .expect("turn start blocker returns without dispatch");

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.turn_start_in_flight = false;
            runtime.action_in_flight_item_id = Some("item".to_string());
        }
        tokio::time::timeout(
            Duration::from_secs(1),
            service.drain_pending_steers("thread".to_string()),
        )
        .await
        .expect("action blocker returns without dispatch");

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.action_in_flight_item_id = None;
            runtime.thread_running = false;
        }
        tokio::time::timeout(
            Duration::from_secs(1),
            service.drain_pending_steers("thread".to_string()),
        )
        .await
        .expect("stopped thread blocker returns without dispatch");

        assert!(calls.prepare.try_recv().is_err());
    }

    #[tokio::test]
    async fn turn_completion_during_steer_preparation_resumes_auto_dispatch() {
        let (service, mut calls) = service_with_runtime(&["steer"], &[]).await;
        calls.manual_epoch.store(true, Ordering::SeqCst);
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("runtime");
            runtime
                .pending_steers
                .push_back(runtime.items.pop_front().expect("queued steer"));
        }
        let drain = tokio::spawn({
            let service = service.clone();
            async move { service.drain_pending_steers("thread".to_string()).await }
        });
        let prepare = calls.prepare.recv().await.expect("steer preparation");

        service
            .handle_canonical_event(finish_event("turn", 7, 2))
            .await;
        prepare.response.send(Ok(1)).expect("prepare completes");
        drain.await.expect("steer drain completes");

        let turn_start = tokio::time::timeout(Duration::from_secs(1), calls.turn_start.recv())
            .await
            .expect("requeued message dispatches")
            .expect("turn start");
        assert_eq!(turn_start.turn_start["input"][0]["text"], "text-steer");
        turn_start
            .response
            .send(Ok("resumed-turn".to_string()))
            .expect("turn starts");
    }

    #[tokio::test]
    async fn cancelling_requeued_work_during_steer_preparation_settles_completion() {
        let (service, mut calls) = service_with_runtime(&["steer"], &[]).await;
        calls.manual_epoch.store(true, Ordering::SeqCst);
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("runtime");
            runtime
                .pending_steers
                .push_back(runtime.items.pop_front().expect("queued steer"));
        }
        let drain = tokio::spawn({
            let service = service.clone();
            async move { service.drain_pending_steers("thread".to_string()).await }
        });
        let prepare = calls.prepare.recv().await.expect("steer preparation");

        service
            .handle_canonical_event(finish_event("turn", 7, 3))
            .await;
        service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: "steer".to_string(),
            })
            .await
            .expect("requeued work cancels");
        prepare.response.send(Ok(1)).expect("prepare completes");
        drain.await.expect("steer drain completes");

        assert_eq!(
            service.wait_for_completion_disposition(3).await,
            Some(QueueCompletionDisposition::Final)
        );
        assert!(service
            .threads
            .read()
            .await
            .get("thread")
            .expect("runtime")
            .pending_completion_event_ids
            .is_empty());
    }

    #[tokio::test]
    async fn a_new_run_settles_stranded_completion_as_continued() {
        let (service, _) = service_with_runtime(&[], &[]).await;
        service
            .threads
            .write()
            .await
            .get_mut("thread")
            .expect("runtime")
            .pending_completion_event_ids
            .push(4);

        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 5,
                foreground_mobile_present: false,
                event: CanonicalEvent::RunStarted {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    run_id: "next-run".to_string(),
                    source_turn_id: "next-turn".to_string(),
                    generation: 8,
                },
            })
            .await;

        assert_eq!(
            service.wait_for_completion_disposition(4).await,
            Some(QueueCompletionDisposition::Continued)
        );
    }

    async fn accept_steer(service: &Arc<BridgeQueueService>, item_id: &str) {
        let response = service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: item_id.to_string(),
            })
            .await
            .expect("steer accepted");
        assert!(response.ok);
    }

    fn tool_event(id: &str, generation: u64, status: ToolCallStatus) -> CanonicalHubEvent {
        CanonicalHubEvent {
            event_id: 1,
            foreground_mobile_present: false,
            event: CanonicalEvent::Tool {
                agent_id: "agent".to_string(),
                thread_id: "thread".to_string(),
                run_id: Some("run".to_string()),
                source_turn_id: Some("turn".to_string()),
                generation: Some(generation),
                tool_call_id: id.to_string(),
                kind: ToolKind::Edit,
                status,
                title: id.to_string(),
                content: crate::acp::events::FieldUpdate::Set(String::new()),
                structured_content: crate::acp::events::FieldUpdate::Set(Vec::new()),
                locations: crate::acp::events::FieldUpdate::Set(Vec::new()),
            },
        }
    }

    fn finish_event(source_turn_id: &str, generation: u64, event_id: u64) -> CanonicalHubEvent {
        CanonicalHubEvent {
            event_id,
            foreground_mobile_present: false,
            event: CanonicalEvent::RunFinished {
                agent_id: "agent".to_string(),
                thread_id: "thread".to_string(),
                run_id: "run".to_string(),
                source_turn_id: source_turn_id.to_string(),
                generation,
                stop_reason: StopReason::EndTurn,
            },
        }
    }

    #[tokio::test]
    async fn queue_steer_waits_for_exact_active_tools_and_drains_fifo() {
        let (service, mut calls) = service_with_runtime(&["a", "b"], &["tool-1", "tool-2"]).await;
        accept_steer(&service, "a").await;
        accept_steer(&service, "b").await;
        let snapshot = service.read_queue("thread").await;
        assert_eq!(snapshot.pending_steer_count, 2);
        assert!(snapshot.waiting_for_tool_calls);

        service
            .handle_canonical_event(tool_event("tool-1", 7, ToolCallStatus::InProgress))
            .await;
        service
            .handle_canonical_event(tool_event("unknown", 7, ToolCallStatus::Completed))
            .await;
        service
            .handle_canonical_event(tool_event("tool-1", 7, ToolCallStatus::Completed))
            .await;
        service.drain_pending_steers("thread".to_string()).await;
        assert!(calls.steer.try_recv().is_err());

        service
            .handle_canonical_event(tool_event("tool-1", 7, ToolCallStatus::Completed))
            .await;
        service
            .handle_canonical_event(tool_event("tool-2", 6, ToolCallStatus::Completed))
            .await;
        service.drain_pending_steers("thread".to_string()).await;
        assert!(calls.steer.try_recv().is_err());

        service
            .handle_canonical_event(tool_event("tool-2", 7, ToolCallStatus::Failed))
            .await;
        let first = calls.steer.recv().await.expect("first steer dispatched");
        assert_eq!(first.thread_id, "thread");
        assert_eq!(first.expected_run_id, "run");
        assert_eq!(first.expected_source_turn_id, "turn");
        assert_eq!(first.prompt_generation, 7);
        assert_eq!(first.prompt.len(), 3);
        assert!(matches!(&first.prompt[0], ContentBlock::Text(text) if text.text == "text-a"));
        assert!(
            matches!(&first.prompt[1], ContentBlock::ResourceLink(link) if link.name == "source.rs" && link.uri == "/repo/source.rs")
        );
        assert!(
            matches!(&first.prompt[2], ContentBlock::ResourceLink(link) if link.mime_type.as_deref() == Some("image/png"))
        );
        first.response.send(Ok(())).expect("ack first steer");
        let second = calls.steer.recv().await.expect("second steer dispatched");
        assert!(matches!(&second.prompt[0], ContentBlock::Text(text) if text.text == "text-b"));
        second.response.send(Ok(())).expect("ack second steer");

        let (service, mut calls) = service_with_runtime(&["reasoning"], &[]).await;
        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 4,
                foreground_mobile_present: false,
                event: CanonicalEvent::MessageChunk {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    run_id: Some("run".to_string()),
                    source_turn_id: Some("turn".to_string()),
                    generation: Some(7),
                    role: crate::acp::events::MessageRole::Thought,
                    message_id: "thought".to_string(),
                    content: "considering".to_string(),
                    content_block: None,
                },
            })
            .await;
        accept_steer(&service, "reasoning").await;
        let steer = calls.steer.recv().await.expect("thought does not block");
        steer.response.send(Ok(())).expect("reasoning steer ack");
    }

    #[tokio::test]
    async fn queue_steer_prepares_human_input_then_rechecks_tool_barrier() {
        let (service, mut calls) = service_with_runtime(&["a"], &[]).await;
        calls.manual_epoch.store(true, Ordering::SeqCst);
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("runtime");
            runtime.pending_approval_ids.insert("approval".to_string());
            runtime
                .pending_user_input_ids
                .insert("elicitation".to_string());
        }
        accept_steer(&service, "a").await;
        let prepare = calls.prepare.recv().await.expect("prepare requested");
        assert_eq!(prepare.thread_id, "thread");
        assert!(calls.steer.try_recv().is_err());

        service
            .handle_canonical_event(tool_event("late-tool", 7, ToolCallStatus::Pending))
            .await;
        prepare.response.send(Ok(1)).expect("prepare acknowledged");
        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 2,
                foreground_mobile_present: false,
                event: CanonicalEvent::PermissionResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    request_id: "approval".to_string(),
                    outcome: "rejected".to_string(),
                },
            })
            .await;
        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 3,
                foreground_mobile_present: false,
                event: CanonicalEvent::ElicitationResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    request_id: "elicitation".to_string(),
                    action: "cancelled".to_string(),
                },
            })
            .await;
        let verify = calls.verify_epoch.recv().await.expect("epoch verified");
        assert_eq!(verify.thread_id, "thread");
        assert_eq!(verify.epoch, 1);
        verify.response.send(Ok(true)).expect("epoch accepted");
        calls.manual_epoch.store(false, Ordering::SeqCst);
        service.drain_pending_steers("thread".to_string()).await;
        assert!(calls.steer.try_recv().is_err());
        service
            .handle_canonical_event(tool_event("late-tool", 7, ToolCallStatus::Completed))
            .await;
        let steer = calls.steer.recv().await.expect("steer after tool terminal");
        steer.response.send(Ok(())).expect("steer ack");

        let (service, mut calls) = service_with_runtime(&["b"], &[]).await;
        calls.manual_epoch.store(true, Ordering::SeqCst);
        service
            .threads
            .write()
            .await
            .get_mut("thread")
            .expect("runtime")
            .pending_approval_ids
            .insert("no-reject".to_string());
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("runtime");
            let entry = runtime.items.pop_front().expect("queued entry");
            runtime.pending_steers.push_back(entry);
        }
        let drain = tokio::spawn({
            let service = service.clone();
            async move { service.drain_pending_steers("thread".to_string()).await }
        });
        let prepare = calls.prepare.recv().await.expect("prepare requested");
        prepare
            .response
            .send(Err("permission has no reject option".to_string()))
            .expect("prepare error");
        drain.await.expect("drain task");
        let updated = service.read_queue("thread").await;
        assert_eq!(updated.pending_steers[0].id, "b");
        assert_eq!(updated.pending_steer_count, 1);
        let error = updated.last_error.expect("structured error");
        assert_eq!(error.operation, "steer");
        assert_eq!(error.item_id.as_deref(), Some("b"));
        assert!(calls.steer.try_recv().is_err());
    }

    #[tokio::test]
    async fn late_permission_and_elicitation_force_repreparation_before_steer() {
        for interaction in ["permission", "elicitation"] {
            let (service, mut calls) = service_with_runtime(&[interaction], &[]).await;
            calls.manual_epoch.store(true, Ordering::SeqCst);
            accept_steer(&service, interaction).await;

            let first_prepare = calls.prepare.recv().await.expect("first prepare");
            first_prepare.response.send(Ok(10)).expect("first epoch");
            let first_verify = calls.verify_epoch.recv().await.expect("first verify");
            assert_eq!(first_verify.epoch, 10);
            first_verify
                .response
                .send(Ok(false))
                .expect("late interaction");
            assert!(calls.steer.try_recv().is_err());

            let second_prepare = calls.prepare.recv().await.expect("second prepare");
            second_prepare.response.send(Ok(12)).expect("second epoch");
            let second_verify = calls.verify_epoch.recv().await.expect("second verify");
            assert_eq!(second_verify.epoch, 12);
            second_verify.response.send(Ok(true)).expect("stable epoch");

            let steer = calls.steer.recv().await.expect("steer after repreparation");
            steer.response.send(Ok(())).expect("steer accepted");
        }
    }

    #[tokio::test]
    async fn queue_completion_promotes_pending_and_preserves_in_flight_ownership() {
        let (service, mut calls) = service_with_runtime(&["a", "b"], &["tool"]).await;
        accept_steer(&service, "a").await;
        accept_steer(&service, "b").await;
        service
            .handle_canonical_event(finish_event("other-turn", 7, 10))
            .await;
        assert_eq!(service.read_queue("thread").await.pending_steer_count, 2);
        assert!(calls.turn_start.try_recv().is_err());

        service
            .handle_canonical_event(finish_event("turn", 7, 11))
            .await;
        let first_start = calls.turn_start.recv().await.expect("promoted turn starts");
        assert_eq!(first_start.thread_id, "thread");
        assert_eq!(first_start.turn_start["input"][0]["text"], "text-a");
        first_start
            .response
            .send(Ok("next-turn".to_string()))
            .expect("turn start ack");
        assert_eq!(service.read_queue("thread").await.items[0].id, "b");

        let (service, mut calls) = service_with_runtime(&["c", "d"], &[]).await;
        accept_steer(&service, "c").await;
        let in_flight = calls.steer.recv().await.expect("steer in flight");
        accept_steer(&service, "d").await;
        assert!(service.read_queue("thread").await.steering_in_flight);
        service
            .handle_canonical_event(finish_event("turn", 7, 12))
            .await;
        in_flight
            .response
            .send(Err("turn completed".to_string()))
            .expect("steer failure ack");
        let fallback = calls
            .turn_start
            .recv()
            .await
            .expect("in-flight steer promoted");
        assert_eq!(fallback.turn_start["input"][0]["text"], "text-c");
        assert!(calls.turn_start.try_recv().is_err());
        fallback
            .response
            .send(Ok("fallback-turn".to_string()))
            .expect("fallback ack");
        assert_eq!(service.read_queue("thread").await.items[0].id, "d");
    }

    #[tokio::test]
    async fn queue_cancel_lane_priority_and_unknown_reconcile_are_conservative() {
        let (service, mut calls) = service_with_runtime(&["a", "b"], &["tool"]).await;
        accept_steer(&service, "a").await;
        service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: "a".to_string(),
            })
            .await
            .expect("pending steer cancels");
        assert_eq!(service.read_queue("thread").await.pending_steer_count, 0);

        accept_steer(&service, "b").await;
        service
            .handle_canonical_event(tool_event("tool", 7, ToolCallStatus::Completed))
            .await;
        let in_flight = calls.steer.recv().await.expect("steer in flight");
        let error = service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: "b".to_string(),
            })
            .await
            .expect_err("in-flight steer cannot cancel");
        assert!(error.contains("already dispatched"));
        in_flight.response.send(Ok(())).expect("steer ack");

        let (service, mut calls) = service_with_runtime(&[], &[]).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("runtime");
            runtime.thread_running = false;
            runtime.active_turn_id = None;
            runtime.active_run_id = None;
            runtime.active_prompt_generation = None;
            runtime.live_generation_known = false;
            runtime.pending_steers.push_back(queued("pending"));
            runtime.items.push_back(queued("normal"));
        }
        service.drain_thread_queue("thread".to_string()).await;
        assert!(calls.turn_start.try_recv().is_err());
        let snapshot = service.read_queue("thread").await;
        assert_eq!(snapshot.pending_steers[0].id, "pending");
        assert_eq!(snapshot.items[0].id, "normal");
        assert_eq!(snapshot.pending_steer_count, 1);
        let serialized = serde_json::to_value(snapshot).expect("snapshot serializes");
        assert!(serialized["pendingSteers"][0].get("turnStart").is_none());

        let (backend, mut calls) = fake_dispatcher();
        backend
            .snapshot
            .lock()
            .expect("snapshot lock")
            .session
            .history_reconstruction = true;
        let service = BridgeQueueService::new(backend.clone(), Arc::new(ClientHub::new()));
        service
            .ensure_thread_runtime("thread")
            .await
            .expect("hydrate");
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("runtime");
            assert!(!runtime.live_generation_known);
            runtime.pending_steers.push_back(queued("replay"));
        }
        service.drain_pending_steers("thread".to_string()).await;
        assert!(calls.steer.try_recv().is_err());
    }

    #[test]
    fn bridge_prompt_preserves_official_content_blocks_and_rejects_unknown_blocks() {
        let image = ContentBlock::Image(agent_client_protocol::schema::v1::ImageContent::new(
            "aGVsbG8=",
            "image/png",
        ));
        let image_value = serde_json::to_value(&image).expect("image serializes");
        let prompt = crate::runtime_backend::bridge_prompt(&json!({
            "input": [
                "raw text",
                {"type": "text", "text": "one", "text_elements": []},
                image_value,
                {"type": "mention", "name": "lib.rs", "path": "/repo/lib.rs"},
                {"type": "mention", "path": "/repo/fallback.rs"},
                {"type": "localImage", "path": "/repo/view.webp"},
                {"type": "localImage", "path": "/repo/photo.jpg"},
                {"type": "localImage", "path": "/repo/animation.gif"},
                {"type": "localImage", "path": "/repo/file.unknown"}
            ]
        }))
        .expect("prompt maps");
        assert_eq!(prompt.len(), 9);
        assert!(matches!(&prompt[0], ContentBlock::Text(text) if text.text == "raw text"));
        assert!(matches!(&prompt[1], ContentBlock::Text(text) if text.text == "one"));
        assert_eq!(prompt[2], image);
        assert!(matches!(&prompt[3], ContentBlock::ResourceLink(link) if link.name == "lib.rs"));
        assert!(
            matches!(&prompt[4], ContentBlock::ResourceLink(link) if link.name == "/repo/fallback.rs")
        );
        assert!(
            matches!(&prompt[5], ContentBlock::ResourceLink(link) if link.mime_type.as_deref() == Some("image/webp"))
        );
        assert!(
            matches!(&prompt[6], ContentBlock::ResourceLink(link) if link.mime_type.as_deref() == Some("image/jpeg"))
        );
        assert!(
            matches!(&prompt[7], ContentBlock::ResourceLink(link) if link.mime_type.as_deref() == Some("image/gif"))
        );
        assert!(matches!(&prompt[8], ContentBlock::ResourceLink(link) if link.mime_type.is_none()));
        assert!(crate::runtime_backend::bridge_prompt(&json!({
            "input": [{"type": "futureBlock", "value": true}]
        }))
        .is_err());
        assert!(crate::runtime_backend::bridge_prompt(&json!({})).is_err());
        assert!(crate::runtime_backend::bridge_prompt(&json!({"input": []})).is_err());
        assert!(crate::runtime_backend::bridge_prompt(&json!({"input": [{}]})).is_err());
        assert!(
            crate::runtime_backend::bridge_prompt(&json!({"input": [{"type": "text"}]})).is_err()
        );
        assert!(crate::runtime_backend::bridge_prompt(
            &json!({"input": [{"type": "mention", "path": " "}]})
        )
        .is_err());
        assert!(crate::runtime_backend::bridge_prompt(
            &json!({"input": [{"type": "localImage", "path": " "}]})
        )
        .is_err());
    }

    fn send_request(
        thread_id: &str,
        submission_id: &str,
        content: &str,
    ) -> BridgeThreadQueueSendRequest {
        BridgeThreadQueueSendRequest {
            thread_id: thread_id.to_string(),
            submission_id: submission_id.to_string(),
            content: content.to_string(),
            turn_start: json!({"input": [{"type": "text", "text": content, "text_elements": []}]}),
        }
    }

    fn agent_message_fixture(
        message_id: &str,
    ) -> (
        crate::agent_messaging::AgentMessageEnvelope,
        crate::agent_messaging::AgentMessageOrigin,
        crate::agent_messaging::AgentMessageOrigin,
    ) {
        let body = "Inspect the queue lifecycle.".to_string();
        (
            crate::agent_messaging::AgentMessageEnvelope::new(
                message_id.to_string(),
                "parent".to_string(),
                "thread".to_string(),
                crate::agent_messaging::AgentRelationKind::SubAgent,
                Some("Parent agent".to_string()),
                body.clone(),
            ),
            crate::agent_messaging::AgentMessageOrigin {
                message_id: message_id.to_string(),
                direction: crate::agent_messaging::AgentMessageDirection::Received,
                related_thread_id: "parent".to_string(),
                related_title: Some("Parent agent".to_string()),
                relation: crate::agent_messaging::AgentRelationKind::Parent,
                disposition: crate::agent_messaging::AgentMessageDisposition::Queued,
                body: body.clone(),
            },
            crate::agent_messaging::AgentMessageOrigin {
                message_id: message_id.to_string(),
                direction: crate::agent_messaging::AgentMessageDirection::Sent,
                related_thread_id: "thread".to_string(),
                related_title: Some("Child agent".to_string()),
                relation: crate::agent_messaging::AgentRelationKind::SubAgent,
                disposition: crate::agent_messaging::AgentMessageDisposition::Queued,
                body,
            },
        )
    }

    fn assert_recorded_agent_message_disposition(
        calls: &FakeReceivers,
        expected: crate::agent_messaging::AgentMessageDisposition,
    ) {
        let records = calls
            .recorded_agent_messages
            .lock()
            .expect("recorded agent messages lock");
        assert_eq!(records.len(), 2);
        assert!(records.iter().any(|(thread_id, origin)| {
            thread_id == "thread"
                && origin.direction == crate::agent_messaging::AgentMessageDirection::Received
                && origin.disposition == expected
        }));
        assert!(records.iter().any(|(thread_id, origin)| {
            thread_id == "parent"
                && origin.direction == crate::agent_messaging::AgentMessageDirection::Sent
                && origin.disposition == expected
        }));
    }

    #[tokio::test]
    async fn public_queue_rejects_bridge_agent_message_envelopes() {
        let (backend, _) = fake_dispatcher();
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, _, _) = agent_message_fixture("forged-message");
        let encoded = envelope.encode().expect("agent message envelope");

        assert_eq!(
            service
                .send_message(send_request("thread", "forged-message", &encoded))
                .await
                .expect_err("public queue cannot admit a bridge envelope"),
            "agent message envelopes are reserved for the bridge"
        );

        let split_at = encoded
            .find(",\"senderThreadId\"")
            .expect("encoded sender field");
        let mut split = send_request("thread", "split-forged-message", &encoded);
        split.turn_start = json!({
            "input": [
                {"type": "text", "text": &encoded[..split_at], "text_elements": []},
                {"type": "text", "text": &encoded[split_at..], "text_elements": []},
            ]
        });
        assert_eq!(
            service
                .send_message(split)
                .await
                .expect_err("split bridge envelope cannot bypass the public queue guard"),
            "agent message envelopes are reserved for the bridge"
        );

        let mut prefixed_split = send_request("thread", "prefixed-split-forgery", &encoded);
        prefixed_split.turn_start = json!({
            "input": [
                {"type": "text", "text": "ordinary prefix", "text_elements": []},
                {"type": "text", "text": &encoded[..split_at], "text_elements": []},
                {"type": "text", "text": &encoded[split_at..], "text_elements": []},
            ]
        });
        assert_eq!(
            service
                .send_message(prefixed_split)
                .await
                .expect_err("an ordinary prefix cannot hide a split bridge envelope"),
            "agent message envelopes are reserved for the bridge"
        );

        for (submission_id, input) in [
            (
                "forged-message-with-trailer",
                json!([
                    {"type": "text", "text": &encoded, "text_elements": []},
                    {"type": "text", "text": "trailer", "text_elements": []},
                ]),
            ),
            (
                "forged-message-with-prefix",
                json!([
                    {"type": "text", "text": "prefix", "text_elements": []},
                    {"type": "text", "text": &encoded, "text_elements": []},
                ]),
            ),
        ] {
            let mut request = send_request("thread", submission_id, &encoded);
            request.turn_start = json!({"input": input});
            assert_eq!(
                service
                    .send_message(request)
                    .await
                    .expect_err("an envelope block cannot hide beside ordinary text"),
                "agent message envelopes are reserved for the bridge"
            );
        }
    }

    #[tokio::test]
    async fn queued_message_edit_cannot_replace_public_content_with_an_agent_envelope() {
        let (service, _) = service_with_runtime(&["item"], &[]).await;
        let (envelope, _, _) = agent_message_fixture("edited-forgery");
        let encoded = envelope.encode().expect("agent message envelope");

        service
            .start_message_edit(BridgeThreadQueueEditRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect("edit starts");
        assert_eq!(
            service
                .commit_message_edit(BridgeThreadQueueEditCommitRequest {
                    thread_id: "thread".to_string(),
                    item_id: "item".to_string(),
                    content: encoded.clone(),
                })
                .await
                .expect_err("public edit cannot forge an agent envelope"),
            "agent message envelopes are reserved for the bridge"
        );
        let queue = service.read_queue("thread").await;
        assert_eq!(queue.editing_item_id.as_deref(), Some("item"));
        assert_eq!(queue.items[0].content, "content-item");

        let split_at = encoded
            .find(",\"senderThreadId\"")
            .expect("encoded sender field");
        {
            let mut threads = service.threads.write().await;
            threads
                .get_mut("thread")
                .expect("runtime")
                .items
                .front_mut()
                .expect("queued item")
                .turn_start = json!({
                "input": [
                    {"type": "text", "text": "safe", "text_elements": []},
                    {"type": "text", "text": &encoded[split_at..], "text_elements": []},
                ]
            });
        }
        assert_eq!(
            service
                .commit_message_edit(BridgeThreadQueueEditCommitRequest {
                    thread_id: "thread".to_string(),
                    item_id: "item".to_string(),
                    content: encoded[..split_at].to_string(),
                })
                .await
                .expect_err("split agent envelope cannot be forged through editing"),
            "agent message envelopes are reserved for the bridge"
        );
        assert_eq!(
            service
                .read_queue("thread")
                .await
                .editing_item_id
                .as_deref(),
            Some("item")
        );
    }

    #[tokio::test]
    async fn agent_message_activity_is_persisted_before_delivery_begins() {
        let (backend, mut calls) = fake_dispatcher();
        {
            let mut snapshot = backend.snapshot.lock().expect("snapshot lock");
            snapshot.session.active_run_id = None;
            snapshot.session.active_source_turn_id = None;
            snapshot.session.active_generation = None;
        }
        *backend
            .record_agent_messages_error
            .lock()
            .expect("record agent messages error lock") = Some("journal unavailable".to_string());
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("journal-failure");
        assert!(service
            .send_agent_message(&envelope, recipient, sender)
            .await
            .expect_err("activity failure is surfaced")
            .contains("journal unavailable"));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), calls.turn_start.recv())
                .await
                .is_err(),
            "delivery must not begin before durable activity admission"
        );
        assert!(calls
            .recorded_agent_messages
            .lock()
            .expect("recorded agent messages lock")
            .is_empty());
    }

    #[tokio::test]
    async fn live_agent_message_reaches_a_parent_before_its_task_tool_finishes() {
        let (backend, mut calls) = fake_dispatcher();
        backend
            .supports_live_agent_message
            .store(true, Ordering::SeqCst);
        backend
            .snapshot
            .lock()
            .expect("snapshot lock")
            .session
            .active_tool_ids
            .insert("task-child".to_string());
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("child-question");

        assert_eq!(
            service
                .send_agent_message(&envelope, recipient, sender)
                .await
                .expect("busy parent begins live delivery"),
            crate::agent_messaging::AgentMessageDisposition::Steering
        );
        let delivery =
            tokio::time::timeout(Duration::from_secs(1), calls.live_agent_message.recv())
                .await
                .expect("live delivery timeout")
                .expect("live delivery");
        assert_eq!(delivery.thread_id, "thread");
        assert_eq!(delivery.expected_run_id, "run");
        assert_eq!(delivery.expected_source_turn_id, "turn");
        assert_eq!(delivery.prompt_generation, 7);
        let ContentBlock::Text(prompt) = &delivery.prompt[0] else {
            panic!("expected text agent-message envelope");
        };
        assert_eq!(
            crate::agent_messaging::AgentMessageEnvelope::decode(&prompt.text)
                .expect("exact envelope")
                .message_id,
            "child-question"
        );
        assert!(
            service
                .threads
                .read()
                .await
                .get("thread")
                .expect("recipient runtime")
                .active_tool_call_ids
                .contains("task-child"),
            "delivery must not wait for the parent task to finish"
        );
        assert!(calls.steer.try_recv().is_err());

        delivery
            .response
            .send(Ok(
                crate::acp::harness::HarnessAgentMessageOutcome::Delivered,
            ))
            .expect("live delivery response");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if service.read_queue("thread").await.pending_steers.is_empty()
                    && calls
                        .updated_agent_message_dispositions
                        .lock()
                        .expect("updated dispositions lock")
                        .last()
                        .is_some_and(|(message_id, disposition)| {
                            message_id == "child-question"
                                && *disposition
                                    == crate::agent_messaging::AgentMessageDisposition::Sent
                        })
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("live delivery settles before task completion");
    }

    #[tokio::test]
    async fn live_agent_message_defers_without_resolving_the_parent_permission() {
        let (backend, mut calls) = fake_dispatcher();
        backend
            .supports_live_agent_message
            .store(true, Ordering::SeqCst);
        {
            let mut snapshot = backend.snapshot.lock().expect("snapshot lock");
            snapshot
                .session
                .active_tool_ids
                .insert("task-child".to_string());
            snapshot
                .pending_approval_ids
                .insert("approval-parent".to_string());
        }
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("child-question");

        assert_eq!(
            service
                .send_agent_message(&envelope, recipient, sender)
                .await
                .expect("busy parent accepts message"),
            crate::agent_messaging::AgentMessageDisposition::Steering
        );
        tokio::task::yield_now().await;
        assert!(calls.prepare.try_recv().is_err());
        assert!(calls.live_agent_message.try_recv().is_err());
        assert!(service
            .threads
            .read()
            .await
            .get("thread")
            .expect("recipient runtime")
            .pending_approval_ids
            .contains("approval-parent"));

        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 91,
                foreground_mobile_present: false,
                event: CanonicalEvent::PermissionResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    request_id: "approval-parent".to_string(),
                    outcome: "approved".to_string(),
                },
            })
            .await;
        let delivery =
            tokio::time::timeout(Duration::from_secs(1), calls.live_agent_message.recv())
                .await
                .expect("live delivery timeout")
                .expect("live delivery");
        assert!(calls.prepare.try_recv().is_err());
        delivery
            .response
            .send(Ok(
                crate::acp::harness::HarnessAgentMessageOutcome::Delivered,
            ))
            .expect("live delivery response");
    }

    #[tokio::test]
    async fn live_agent_message_defers_without_resolving_the_parent_elicitation() {
        let (backend, mut calls) = fake_dispatcher();
        backend
            .supports_live_agent_message
            .store(true, Ordering::SeqCst);
        {
            let mut snapshot = backend.snapshot.lock().expect("snapshot lock");
            snapshot
                .session
                .active_tool_ids
                .insert("task-child".to_string());
            snapshot
                .pending_user_input_ids
                .insert("elicitation-parent".to_string());
        }
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("child-question");

        service
            .send_agent_message(&envelope, recipient, sender)
            .await
            .expect("busy parent accepts message");
        tokio::task::yield_now().await;
        assert!(calls.prepare.try_recv().is_err());
        assert!(calls.live_agent_message.try_recv().is_err());
        assert!(service
            .threads
            .read()
            .await
            .get("thread")
            .expect("recipient runtime")
            .pending_user_input_ids
            .contains("elicitation-parent"));

        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 93,
                foreground_mobile_present: false,
                event: CanonicalEvent::ElicitationResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    request_id: "elicitation-parent".to_string(),
                    action: "submitted".to_string(),
                },
            })
            .await;
        let delivery =
            tokio::time::timeout(Duration::from_secs(1), calls.live_agent_message.recv())
                .await
                .expect("live delivery timeout")
                .expect("live delivery");
        assert!(calls.prepare.try_recv().is_err());
        delivery
            .response
            .send(Ok(
                crate::acp::harness::HarnessAgentMessageOutcome::Delivered,
            ))
            .expect("live delivery response");
    }

    #[tokio::test]
    async fn live_agent_message_deferral_stays_pending_without_a_queue_error() {
        let (backend, mut calls) = fake_dispatcher();
        backend
            .supports_live_agent_message
            .store(true, Ordering::SeqCst);
        backend
            .snapshot
            .lock()
            .expect("snapshot lock")
            .session
            .active_tool_ids
            .insert("task-child".to_string());
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("child-question");

        service
            .send_agent_message(&envelope, recipient, sender)
            .await
            .expect("busy parent accepts message");
        let delivery =
            tokio::time::timeout(Duration::from_secs(1), calls.live_agent_message.recv())
                .await
                .expect("live delivery timeout")
                .expect("live delivery");
        delivery
            .response
            .send(Ok(
                crate::acp::harness::HarnessAgentMessageOutcome::Deferred,
            ))
            .expect("deferred delivery response");

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let queue = service.read_queue("thread").await;
                if queue.pending_steer_count == 1 && !queue.steering_in_flight {
                    assert!(queue.last_error.is_none());
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("deferred delivery returns to pending state");
        assert!(
            tokio::time::timeout(Duration::from_millis(20), calls.live_agent_message.recv())
                .await
                .is_err(),
            "deferred delivery must not spin"
        );
    }

    #[tokio::test]
    async fn live_agent_message_deferral_after_completion_rejoins_turn_queue() {
        let (backend, mut calls) = fake_dispatcher();
        backend
            .supports_live_agent_message
            .store(true, Ordering::SeqCst);
        backend
            .snapshot
            .lock()
            .expect("snapshot lock")
            .session
            .active_tool_ids
            .insert("task-child".to_string());
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("child-question");

        service
            .send_agent_message(&envelope, recipient, sender)
            .await
            .expect("busy parent accepts message");
        let delivery =
            tokio::time::timeout(Duration::from_secs(1), calls.live_agent_message.recv())
                .await
                .expect("live delivery timeout")
                .expect("live delivery");
        service
            .handle_canonical_event(finish_event("turn", 7, 92))
            .await;
        delivery
            .response
            .send(Ok(
                crate::acp::harness::HarnessAgentMessageOutcome::Deferred,
            ))
            .expect("deferred delivery response");

        let turn_start = tokio::time::timeout(Duration::from_secs(1), calls.turn_start.recv())
            .await
            .expect("deferred message dispatch timeout")
            .expect("deferred message starts a new turn");
        let prompt = crate::runtime_backend::bridge_prompt(&turn_start.turn_start)
            .expect("agent-message prompt");
        let ContentBlock::Text(prompt) = &prompt[0] else {
            panic!("expected text agent-message envelope");
        };
        assert_eq!(
            crate::agent_messaging::AgentMessageEnvelope::decode(&prompt.text)
                .expect("exact envelope")
                .message_id,
            "child-question"
        );
        turn_start
            .response
            .send(Ok("turn-after-task".to_string()))
            .expect("turn response");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if calls
                    .updated_agent_message_dispositions
                    .lock()
                    .expect("updated dispositions lock")
                    .last()
                    .is_some_and(|(message_id, disposition)| {
                        message_id == "child-question"
                            && *disposition == crate::agent_messaging::AgentMessageDisposition::Sent
                    })
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("deferred message settles after queued dispatch");
        let queue = service.read_queue("thread").await;
        assert!(queue.items.is_empty());
        assert!(queue.pending_steers.is_empty());
        assert!(queue.last_error.is_none());
    }

    #[tokio::test]
    async fn indeterminate_live_agent_message_is_cancelled_without_retry() {
        let (backend, mut calls) = fake_dispatcher();
        backend
            .supports_live_agent_message
            .store(true, Ordering::SeqCst);
        backend
            .snapshot
            .lock()
            .expect("snapshot lock")
            .session
            .active_tool_ids
            .insert("task-child".to_string());
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("ambiguous-question");

        service
            .send_agent_message(&envelope, recipient, sender)
            .await
            .expect("busy parent accepts message");
        let delivery =
            tokio::time::timeout(Duration::from_secs(1), calls.live_agent_message.recv())
                .await
                .expect("live delivery timeout")
                .expect("live delivery");
        delivery
            .response
            .send(Err(format!(
                "{INDETERMINATE_OPERATION_PREFIX}prompt response timed out"
            )))
            .expect("indeterminate delivery response");

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if calls
                    .updated_agent_message_dispositions
                    .lock()
                    .expect("updated dispositions lock")
                    .last()
                    .is_some_and(|(message_id, disposition)| {
                        message_id == "ambiguous-question"
                            && *disposition
                                == crate::agent_messaging::AgentMessageDisposition::Cancelled
                    })
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("indeterminate delivery settles as cancelled");
        let queue = service.read_queue("thread").await;
        assert!(queue.items.is_empty());
        assert!(queue.pending_steers.is_empty());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), calls.live_agent_message.recv())
                .await
                .is_err(),
            "ambiguous prompt must not be retried"
        );
    }

    #[tokio::test]
    async fn definitive_live_agent_message_failure_retries_after_parent_turn() {
        let (backend, mut calls) = fake_dispatcher();
        backend
            .supports_live_agent_message
            .store(true, Ordering::SeqCst);
        backend
            .snapshot
            .lock()
            .expect("snapshot lock")
            .session
            .active_tool_ids
            .insert("task-child".to_string());
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("retry-question");

        service
            .send_agent_message(&envelope, recipient, sender)
            .await
            .expect("busy parent accepts message");
        let delivery =
            tokio::time::timeout(Duration::from_secs(1), calls.live_agent_message.recv())
                .await
                .expect("live delivery timeout")
                .expect("live delivery");
        delivery
            .response
            .send(Err("OpenCode promotion returned HTTP 500".to_string()))
            .expect("definitive delivery response");

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let queue = service.read_queue("thread").await;
                if queue.pending_steer_count == 1 && !queue.steering_in_flight {
                    assert_eq!(
                        queue
                            .last_error
                            .as_ref()
                            .map(|error| error.operation.as_str()),
                        Some("steer")
                    );
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("definitive failure returns to pending");

        service
            .handle_canonical_event(finish_event("turn", 7, 94))
            .await;
        let turn_start = tokio::time::timeout(Duration::from_secs(1), calls.turn_start.recv())
            .await
            .expect("queued retry timeout")
            .expect("queued retry");
        turn_start
            .response
            .send(Ok("turn-after-retry".to_string()))
            .expect("turn response");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if calls
                    .updated_agent_message_dispositions
                    .lock()
                    .expect("updated dispositions lock")
                    .last()
                    .is_some_and(|(message_id, disposition)| {
                        message_id == "retry-question"
                            && *disposition == crate::agent_messaging::AgentMessageDisposition::Sent
                    })
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("definitive failure retries after the turn");
        assert!(
            tokio::time::timeout(Duration::from_millis(20), calls.live_agent_message.recv())
                .await
                .is_err(),
            "failed live submission must retry through the normal turn queue"
        );
    }

    #[tokio::test]
    async fn agent_message_delivery_reports_and_records_sent_steering_and_queued_dispositions() {
        let (backend, mut calls) = fake_dispatcher();
        {
            let mut snapshot = backend.snapshot.lock().expect("snapshot lock");
            snapshot.session.active_run_id = None;
            snapshot.session.active_source_turn_id = None;
            snapshot.session.active_generation = None;
        }
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("sent-message");
        let send = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .send_agent_message(&envelope, recipient, sender)
                    .await
            }
        });
        let turn_start = calls.turn_start.recv().await.expect("agent turn start");
        let prompt = crate::runtime_backend::bridge_prompt(&turn_start.turn_start)
            .expect("agent-message prompt");
        let ContentBlock::Text(prompt) = &prompt[0] else {
            panic!("expected text agent-message envelope");
        };
        assert_eq!(
            crate::agent_messaging::AgentMessageEnvelope::decode(&prompt.text)
                .expect("exact envelope")
                .message_id,
            "sent-message"
        );
        turn_start
            .response
            .send(Ok("turn-agent-message".to_string()))
            .expect("turn response");
        assert_eq!(
            send.await
                .expect("send task")
                .expect("idle agent message succeeds"),
            crate::agent_messaging::AgentMessageDisposition::Sent
        );
        assert_recorded_agent_message_disposition(
            &calls,
            crate::agent_messaging::AgentMessageDisposition::Queued,
        );
        assert_eq!(
            calls
                .updated_agent_message_dispositions
                .lock()
                .expect("updated agent message dispositions lock")
                .as_slice(),
            [(
                "sent-message".to_string(),
                crate::agent_messaging::AgentMessageDisposition::Sent,
            )]
        );

        let (backend, mut calls) = fake_dispatcher();
        backend.supports_steer.store(false, Ordering::SeqCst);
        let service = BridgeQueueService::new(backend.clone(), Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("queued-message");
        assert_eq!(
            service
                .send_agent_message(&envelope, recipient, sender)
                .await
                .expect("busy unsupported agent queues"),
            crate::agent_messaging::AgentMessageDisposition::Queued
        );
        let queue = service.read_queue("thread").await;
        assert_eq!(queue.items.len(), 1);
        assert_eq!(
            queue.items[0]
                .agent_message
                .as_ref()
                .expect("typed queued agent message")
                .disposition,
            crate::agent_messaging::AgentMessageDisposition::Queued
        );
        assert_recorded_agent_message_disposition(
            &calls,
            crate::agent_messaging::AgentMessageDisposition::Queued,
        );
        assert_eq!(
            calls
                .published_agent_message_ids
                .lock()
                .expect("published agent message ids lock")
                .as_slice(),
            ["queued-message"]
        );
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("recipient runtime");
            runtime.thread_running = false;
            runtime.active_turn_id = None;
            runtime.active_run_id = None;
            runtime.active_prompt_generation = None;
        }
        backend
            .update_agent_message_failures
            .store(1, Ordering::SeqCst);
        let dispatch = tokio::spawn({
            let service = service.clone();
            async move {
                service.drain_thread_queue("thread".to_string()).await;
            }
        });
        calls
            .turn_start
            .recv()
            .await
            .expect("queued agent message dispatch")
            .response
            .send(Ok("dispatched-agent-message".to_string()))
            .expect("dispatch response");
        dispatch.await.expect("dispatch task");
        assert_eq!(
            calls
                .updated_agent_message_dispositions
                .lock()
                .expect("updated agent message dispositions lock")
                .as_slice(),
            [
                (
                    "queued-message".to_string(),
                    crate::agent_messaging::AgentMessageDisposition::Sent,
                ),
                (
                    "queued-message".to_string(),
                    crate::agent_messaging::AgentMessageDisposition::Sent,
                ),
            ]
        );

        let (backend, mut calls) = fake_dispatcher();
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("steering-message");
        let send = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .send_agent_message(&envelope, recipient, sender)
                    .await
            }
        });
        let steer = tokio::time::timeout(Duration::from_secs(1), calls.steer.recv())
            .await
            .expect("agent steer timeout")
            .expect("agent steer");
        assert_eq!(steer.thread_id, "thread");
        assert_recorded_agent_message_disposition(
            &calls,
            crate::agent_messaging::AgentMessageDisposition::Queued,
        );
        assert_eq!(
            calls
                .updated_agent_message_dispositions
                .lock()
                .expect("updated agent message dispositions lock")
                .as_slice(),
            [(
                "steering-message".to_string(),
                crate::agent_messaging::AgentMessageDisposition::Steering,
            )]
        );
        steer.response.send(Ok(())).expect("steer response");
        assert_eq!(
            send.await
                .expect("send task")
                .expect("busy steer-capable agent steers"),
            crate::agent_messaging::AgentMessageDisposition::Steering
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if calls
                    .updated_agent_message_dispositions
                    .lock()
                    .expect("updated agent message dispositions lock")
                    .last()
                    .is_some_and(|(_, disposition)| {
                        *disposition == crate::agent_messaging::AgentMessageDisposition::Sent
                    })
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("successful steer settles the durable activity");
        assert_eq!(
            calls
                .updated_agent_message_dispositions
                .lock()
                .expect("updated agent message dispositions lock")
                .as_slice(),
            [
                (
                    "steering-message".to_string(),
                    crate::agent_messaging::AgentMessageDisposition::Steering,
                ),
                (
                    "steering-message".to_string(),
                    crate::agent_messaging::AgentMessageDisposition::Sent,
                ),
            ]
        );
        assert!(matches!(
            service
                .submission_results
                .lock()
                .await
                .get("agent-message:steering-message")
                .map(|response| response.disposition.clone()),
            Some(BridgeThreadQueueDisposition::Sent)
        ));
    }

    #[tokio::test]
    async fn run_completion_requeues_pending_agent_steers_with_queued_journal_state() {
        let (service, calls) = service_with_runtime(&[], &[]).await;
        let mut entry = queued("agent-steer");
        entry.agent_message = Some(crate::agent_messaging::AgentMessageOrigin {
            message_id: "agent-steer-message".to_string(),
            direction: crate::agent_messaging::AgentMessageDirection::Received,
            related_thread_id: "parent".to_string(),
            related_title: Some("Parent".to_string()),
            relation: crate::agent_messaging::AgentRelationKind::Parent,
            disposition: crate::agent_messaging::AgentMessageDisposition::Steering,
            body: "Wait for the next turn.".to_string(),
        });
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("runtime");
            runtime.pending_steers.push_back(entry);
            runtime.editing_item_id = Some("paused-edit".to_string());
        }

        service
            .handle_canonical_event(finish_event("turn", 7, 43))
            .await;

        let queue = service.read_queue("thread").await;
        assert!(queue.pending_steers.is_empty());
        assert_eq!(queue.items.len(), 1);
        assert_eq!(
            queue.items[0]
                .agent_message
                .as_ref()
                .expect("agent message")
                .disposition,
            crate::agent_messaging::AgentMessageDisposition::Queued
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if calls
                    .updated_agent_message_dispositions
                    .lock()
                    .expect("updated agent message dispositions lock")
                    .as_slice()
                    == [(
                        "agent-steer-message".to_string(),
                        crate::agent_messaging::AgentMessageDisposition::Queued,
                    )]
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("queued disposition is persisted off the event-consumer loop");
    }

    #[tokio::test]
    async fn auto_dispatch_releases_the_actor_before_agent_message_journal_updates() {
        let (backend, mut calls) = fake_dispatcher();
        calls
            .manual_disposition_update
            .store(true, Ordering::SeqCst);
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let mut entry = queued("agent-dispatch");
        entry.agent_message = Some(crate::agent_messaging::AgentMessageOrigin {
            message_id: "journal-lock-order".to_string(),
            direction: crate::agent_messaging::AgentMessageDirection::Received,
            related_thread_id: "parent".to_string(),
            related_title: Some("Parent".to_string()),
            relation: crate::agent_messaging::AgentRelationKind::Parent,
            disposition: crate::agent_messaging::AgentMessageDisposition::Queued,
            body: "Dispatch without holding the actor.".to_string(),
        });
        service.threads.write().await.insert(
            "thread".to_string(),
            BridgeThreadQueueRuntime {
                items: VecDeque::from([entry]),
                ..BridgeThreadQueueRuntime::default()
            },
        );
        let drain = tokio::spawn({
            let service = service.clone();
            async move { service.drain_thread_queue("thread".to_string()).await }
        });
        let turn_start = calls.turn_start.recv().await.expect("turn start");
        turn_start
            .response
            .send(Ok("agent-turn".to_string()))
            .expect("turn starts");
        let update = calls
            .disposition_update
            .recv()
            .await
            .expect("journal update");
        assert_eq!(update.message_id, "journal-lock-order");
        assert_eq!(
            update.disposition,
            crate::agent_messaging::AgentMessageDisposition::Sent
        );

        let actor = service.thread_actor("thread").await;
        let actor_guard = tokio::time::timeout(Duration::from_secs(1), actor.lock())
            .await
            .expect("actor is released before the journal update");
        drop(actor_guard);
        update
            .response
            .send(Ok(()))
            .expect("journal update settles");
        drain.await.expect("auto dispatch completes");
    }

    #[tokio::test]
    async fn determinate_steer_failure_after_completion_requeues_with_queued_state() {
        let (service, mut calls) = service_with_runtime(&["agent-steer"], &[]).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("runtime");
            let mut entry = runtime.items.pop_front().expect("queued steer");
            entry.agent_message = Some(crate::agent_messaging::AgentMessageOrigin {
                message_id: "crossed-boundary".to_string(),
                direction: crate::agent_messaging::AgentMessageDirection::Received,
                related_thread_id: "parent".to_string(),
                related_title: Some("Parent".to_string()),
                relation: crate::agent_messaging::AgentRelationKind::Parent,
                disposition: crate::agent_messaging::AgentMessageDisposition::Steering,
                body: "Retry this after the active turn.".to_string(),
            });
            runtime.pending_steers.push_back(entry);
        }
        service.spawn_steer_dispatch("thread".to_string());
        let steer = calls.steer.recv().await.expect("steer dispatch");

        service
            .handle_canonical_event(finish_event("turn", 7, 44))
            .await;
        service
            .threads
            .write()
            .await
            .get_mut("thread")
            .expect("runtime")
            .editing_item_id = Some("paused-edit".to_string());
        steer
            .response
            .send(Err("active turn already ended".to_string()))
            .expect("steer failure");

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let queue = service.read_queue("thread").await;
                let queued = queue
                    .items
                    .first()
                    .and_then(|item| item.agent_message.as_ref());
                let persisted = calls
                    .updated_agent_message_dispositions
                    .lock()
                    .expect("updated agent message dispositions lock")
                    .contains(&(
                        "crossed-boundary".to_string(),
                        crate::agent_messaging::AgentMessageDisposition::Queued,
                    ));
                if queued.is_some_and(|message| {
                    message.disposition == crate::agent_messaging::AgentMessageDisposition::Queued
                }) && persisted
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("determinate failure returns the activity to queued");
    }

    #[tokio::test]
    async fn rejected_agent_message_delivery_removes_its_provisional_journal_entries() {
        let (backend, mut calls) = fake_dispatcher();
        {
            let mut snapshot = backend.snapshot.lock().expect("snapshot lock");
            snapshot.session.active_run_id = None;
            snapshot.session.active_source_turn_id = None;
            snapshot.session.active_generation = None;
        }
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("rejected-message");
        let send = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .send_agent_message(&envelope, recipient, sender)
                    .await
            }
        });
        calls
            .turn_start
            .recv()
            .await
            .expect("agent turn start")
            .response
            .send(Err("recipient rejected the turn".to_string()))
            .expect("turn response");

        assert_eq!(
            send.await.expect("send task"),
            Err("recipient rejected the turn".to_string())
        );
        assert!(calls
            .recorded_agent_messages
            .lock()
            .expect("recorded agent messages lock")
            .is_empty());
        assert_eq!(
            calls
                .removed_agent_message_ids
                .lock()
                .expect("removed agent message ids lock")
                .as_slice(),
            ["rejected-message"]
        );
        assert!(calls
            .published_agent_message_ids
            .lock()
            .expect("published agent message ids lock")
            .is_empty());
    }

    #[tokio::test]
    async fn indeterminate_immediate_agent_message_keeps_terminal_journal_evidence() {
        let (backend, mut calls) = fake_dispatcher();
        {
            let mut snapshot = backend.snapshot.lock().expect("snapshot lock");
            snapshot.session.active_run_id = None;
            snapshot.session.active_source_turn_id = None;
            snapshot.session.active_generation = None;
        }
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("indeterminate-immediate");
        let send = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .send_agent_message(&envelope, recipient, sender)
                    .await
            }
        });
        calls
            .turn_start
            .recv()
            .await
            .expect("agent turn start")
            .response
            .send(Err(format!(
                "{INDETERMINATE_OPERATION_PREFIX}connection closed"
            )))
            .expect("turn response");

        assert!(send
            .await
            .expect("send task")
            .expect_err("indeterminate delivery fails")
            .starts_with(INDETERMINATE_OPERATION_PREFIX));
        assert_eq!(
            calls
                .recorded_agent_messages
                .lock()
                .expect("recorded agent messages lock")
                .len(),
            2
        );
        assert!(calls
            .removed_agent_message_ids
            .lock()
            .expect("removed agent message ids lock")
            .is_empty());
        assert_eq!(
            calls
                .updated_agent_message_dispositions
                .lock()
                .expect("updated agent message dispositions lock")
                .as_slice(),
            [(
                "indeterminate-immediate".to_string(),
                crate::agent_messaging::AgentMessageDisposition::Cancelled,
            )]
        );
    }

    #[tokio::test]
    async fn indeterminate_agent_message_auto_dispatch_settles_after_dropping_the_item() {
        let (backend, mut calls) = fake_dispatcher();
        backend.supports_steer.store(false, Ordering::SeqCst);
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("indeterminate-dispatch");
        assert_eq!(
            service
                .send_agent_message(&envelope, recipient, sender)
                .await
                .expect("busy agent message queues"),
            crate::agent_messaging::AgentMessageDisposition::Queued
        );
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("recipient runtime");
            runtime.thread_running = false;
            runtime.active_turn_id = None;
            runtime.active_run_id = None;
            runtime.active_prompt_generation = None;
        }
        let dispatch = tokio::spawn({
            let service = service.clone();
            async move {
                service.drain_thread_queue("thread".to_string()).await;
            }
        });
        calls
            .turn_start
            .recv()
            .await
            .expect("queued agent message dispatch")
            .response
            .send(Err(format!(
                "{INDETERMINATE_OPERATION_PREFIX}response dropped"
            )))
            .expect("dispatch response");
        dispatch.await.expect("dispatch task");

        assert!(service.read_queue("thread").await.items.is_empty());
        assert_eq!(
            calls
                .updated_agent_message_dispositions
                .lock()
                .expect("updated agent message dispositions lock")
                .as_slice(),
            [(
                "indeterminate-dispatch".to_string(),
                crate::agent_messaging::AgentMessageDisposition::Cancelled,
            )]
        );
    }

    #[tokio::test]
    async fn indeterminate_agent_message_steer_is_not_replayed() {
        let (backend, mut calls) = fake_dispatcher();
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("indeterminate-steer");
        assert_eq!(
            service
                .send_agent_message(&envelope, recipient, sender)
                .await
                .expect("busy steer-capable agent begins steering"),
            crate::agent_messaging::AgentMessageDisposition::Steering
        );
        calls
            .steer
            .recv()
            .await
            .expect("agent steer")
            .response
            .send(Err(format!(
                "{INDETERMINATE_OPERATION_PREFIX}connection closed"
            )))
            .expect("steer response");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if calls
                    .updated_agent_message_dispositions
                    .lock()
                    .expect("updated agent message dispositions lock")
                    .last()
                    .is_some_and(|(_, disposition)| {
                        *disposition == crate::agent_messaging::AgentMessageDisposition::Cancelled
                    })
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("indeterminate steer settles the durable activity");

        let queue = service.read_queue("thread").await;
        assert!(queue.items.is_empty());
        assert!(queue.pending_steers.is_empty());
        assert!(calls.steer.try_recv().is_err());
        assert_eq!(
            calls
                .updated_agent_message_dispositions
                .lock()
                .expect("updated agent message dispositions lock")
                .as_slice(),
            [
                (
                    "indeterminate-steer".to_string(),
                    crate::agent_messaging::AgentMessageDisposition::Steering,
                ),
                (
                    "indeterminate-steer".to_string(),
                    crate::agent_messaging::AgentMessageDisposition::Cancelled,
                ),
            ]
        );
    }

    #[tokio::test]
    async fn cancelling_an_agent_message_persists_a_terminal_disposition() {
        let (backend, calls) = fake_dispatcher();
        backend.supports_steer.store(false, Ordering::SeqCst);
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let (envelope, recipient, sender) = agent_message_fixture("cancelled-message");
        service
            .send_agent_message(&envelope, recipient, sender)
            .await
            .expect("busy agent message queues");
        let item_id = service.read_queue("thread").await.items[0].id.clone();

        service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id,
            })
            .await
            .expect("agent message cancellation succeeds");

        assert_eq!(
            calls
                .updated_agent_message_dispositions
                .lock()
                .expect("updated agent message dispositions lock")
                .as_slice(),
            [(
                "cancelled-message".to_string(),
                crate::agent_messaging::AgentMessageDisposition::Cancelled,
            )]
        );
        assert!(service.read_queue("thread").await.items.is_empty());
    }

    #[tokio::test]
    async fn queue_send_validates_limits_idempotency_and_dispatch_outcomes() {
        let (backend, mut calls) = fake_dispatcher();
        {
            let mut snapshot = backend.snapshot.lock().unwrap();
            snapshot.session.active_run_id = None;
            snapshot.session.active_source_turn_id = None;
            snapshot.session.active_generation = None;
        }
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        for (thread_id, submission_id, content, expected) in [
            (" ", "submission", "content", "threadId"),
            ("thread", "submission", " ", "content"),
            ("thread", " ", "content", "submissionId"),
        ] {
            let error = service
                .send_message(send_request(thread_id, submission_id, content))
                .await
                .expect_err("invalid request");
            assert!(error.contains(expected));
        }
        let error = service
            .send_message(send_request(
                "thread",
                "large-content",
                &"x".repeat(QUEUE_MAX_CONTENT_BYTES + 1),
            ))
            .await
            .expect_err("content limit");
        assert!(error.contains("queue content exceeds"));
        let mut oversized = send_request("thread", "large-item", "content");
        oversized.turn_start = json!({"payload": "x".repeat(QUEUE_MAX_ITEM_BYTES)});
        assert!(service
            .send_message(oversized)
            .await
            .expect_err("item limit")
            .contains("queue item exceeds"));

        let sent = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .send_message(send_request("thread", "sent", "first"))
                    .await
            }
        });
        let call = calls.turn_start.recv().await.expect("initial turn start");
        call.response
            .send(Ok("turn-1".to_string()))
            .expect("turn response");
        let sent = sent.await.expect("send task").expect("send succeeds");
        assert!(matches!(
            sent.disposition,
            BridgeThreadQueueDisposition::Sent
        ));
        assert_eq!(sent.turn_id.as_deref(), Some("turn-1"));
        let duplicate = service
            .send_message(send_request("thread", "sent", "ignored"))
            .await
            .expect("idempotent result");
        assert_eq!(duplicate.turn_id.as_deref(), Some("turn-1"));
        assert!(service
            .send_message(send_request("other-thread", "sent", "conflict"))
            .await
            .expect_err("submission conflict")
            .contains("another thread"));

        let queued = service
            .send_message(send_request("thread", "queued", "second"))
            .await
            .expect("busy thread queues");
        assert!(matches!(
            queued.disposition,
            BridgeThreadQueueDisposition::Queued
        ));
        let queued_item_id = queued.queue.items[0].id.clone();
        service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: queued_item_id,
            })
            .await
            .expect("queued item cancels");
        let retried_queue = service
            .send_message(send_request("thread", "queued", "replacement"))
            .await
            .expect("cancelled submission id can be reused");
        assert!(matches!(
            retried_queue.disposition,
            BridgeThreadQueueDisposition::Queued
        ));
        assert_eq!(retried_queue.queue.items.len(), 1);
        assert_eq!(retried_queue.queue.items[0].content, "replacement");

        let (backend, mut calls) = fake_dispatcher();
        {
            let mut snapshot = backend.snapshot.lock().unwrap();
            snapshot.session.active_run_id = None;
            snapshot.session.active_source_turn_id = None;
            snapshot.session.active_generation = None;
        }
        let failed_service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let failed = tokio::spawn({
            let service = failed_service.clone();
            async move {
                service
                    .send_message(send_request("failure", "failed", "content"))
                    .await
            }
        });
        calls
            .turn_start
            .recv()
            .await
            .expect("failed turn call")
            .response
            .send(Err("dispatch failed".to_string()))
            .expect("failure response");
        assert_eq!(
            failed
                .await
                .expect("failed task")
                .expect_err("dispatch fails"),
            "dispatch failed"
        );
        assert!(
            !failed_service
                .threads
                .read()
                .await
                .get("failure")
                .unwrap()
                .turn_start_in_flight
        );
        assert!(!failed_service
            .submission_pending
            .lock()
            .await
            .contains_key("failed"));
        let retried = tokio::spawn({
            let service = failed_service.clone();
            async move {
                service
                    .send_message(send_request("failure", "failed", "retry"))
                    .await
            }
        });
        calls
            .turn_start
            .recv()
            .await
            .expect("retried turn call")
            .response
            .send(Ok("turn-retry".to_string()))
            .expect("retry response");
        assert_eq!(
            retried
                .await
                .expect("retry task")
                .expect("same submission retries after definitive failure")
                .turn_id
                .as_deref(),
            Some("turn-retry")
        );
    }

    #[tokio::test]
    async fn queue_enforces_thread_item_and_byte_limits_and_submission_eviction() {
        let (service, _) = service_with_runtime(&[], &[]).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.items = (0..QUEUE_MAX_ITEMS_PER_THREAD)
                .map(|index| queued(&format!("item-{index}")))
                .collect();
        }
        assert!(service
            .send_message(send_request("thread", "item-limit", "content"))
            .await
            .expect_err("item limit")
            .contains("queue limit"));

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.items.clear();
            runtime.items.push_back(BridgeQueuedMessageEntry {
                id: "large".to_string(),
                submission_id: "submission-large".to_string(),
                created_at: "now".to_string(),
                content: "x".repeat(QUEUE_MAX_BYTES_PER_THREAD),
                turn_start: json!({}),
                agent_message: None,
            });
        }
        assert!(service
            .send_message(send_request("thread", "byte-limit", "content"))
            .await
            .expect_err("byte limit")
            .contains("resource_limit"));

        for index in 0..=SUBMISSION_DEDUPE_LIMIT {
            service
                .remember_submission_result(BridgeThreadQueueSendResponse {
                    submission_id: format!("submission-{index}"),
                    disposition: BridgeThreadQueueDisposition::Queued,
                    queue: BridgeQueueService::snapshot_for_thread("thread", None),
                    turn_id: None,
                })
                .await
                .unwrap();
        }
        let results = service.submission_results.lock().await;
        assert_eq!(results.len(), SUBMISSION_DEDUPE_LIMIT);
        assert!(!results.contains_key("submission-0"));
    }

    #[tokio::test]
    async fn queue_hydration_reconcile_and_action_guards_cover_failures() {
        let (backend, _) = fake_dispatcher();
        *backend.snapshot_error.lock().unwrap() = Some("snapshot unavailable".to_string());
        let service = BridgeQueueService::new(backend.clone(), Arc::new(ClientHub::new()));
        assert_eq!(
            service.ensure_thread_runtime(" ").await,
            Err("threadId must not be empty".to_string())
        );
        assert_eq!(
            service.ensure_thread_runtime("thread").await,
            Err("snapshot unavailable".to_string())
        );

        *backend.snapshot_error.lock().unwrap() = None;
        service.ensure_thread_runtime("thread").await.unwrap();
        service.ensure_thread_runtime("thread").await.unwrap();
        *backend.snapshot_error.lock().unwrap() = Some("reconcile failed".to_string());
        service.reconcile_all_threads().await;
        {
            let threads = service.threads.read().await;
            let runtime = threads.get("thread").unwrap();
            assert!(runtime.thread_running);
            assert!(!runtime.live_generation_known);
            assert_eq!(runtime.last_error.as_ref().unwrap().operation, "reconcile");
        }

        backend.supports_steer.store(false, Ordering::SeqCst);
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect_err("unsupported steer")
            .contains("not negotiated"));
        backend.supports_steer.store(true, Ordering::SeqCst);
        *backend.supports_steer_error.lock().unwrap() = Some("capability failed".to_string());
        assert_eq!(
            service
                .steer_message(BridgeThreadQueueSteerRequest {
                    thread_id: "thread".to_string(),
                    item_id: "item".to_string(),
                })
                .await
                .expect_err("capability read fails"),
            "capability failed"
        );

        for request in [
            BridgeThreadQueueCancelRequest {
                thread_id: " ".to_string(),
                item_id: "item".to_string(),
            },
            BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: " ".to_string(),
            },
        ] {
            assert!(service.cancel_message(request).await.is_err());
        }
        assert!(service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: "missing".to_string(),
            })
            .await
            .expect_err("missing item")
            .contains("not found"));
        let actors_before = service.thread_actors.read().await.len();
        let threads_before = service.threads.read().await.len();
        assert!(service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "x".repeat(QUEUE_IDENTIFIER_MAX_BYTES + 1),
                item_id: "missing".to_string(),
            })
            .await
            .expect_err("oversized thread id")
            .contains("at most"));
        assert!(service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "unknown-thread".to_string(),
                item_id: "missing".to_string(),
            })
            .await
            .expect_err("unknown thread")
            .contains("not found"));
        assert_eq!(service.thread_actors.read().await.len(), actors_before);
        assert_eq!(service.threads.read().await.len(), threads_before);

        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: " ".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .is_err());
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: " ".to_string(),
            })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn queue_canonical_interactions_update_runtime() {
        let (service, _) = service_with_runtime(&["item"], &[]).await;
        for event in [
            CanonicalEvent::PermissionRequested {
                approval: PendingApproval {
                    request_id: "permission".to_string(),
                    agent_id: "agent".to_string(),
                    kind: "fileChange".to_string(),
                    thread_id: "thread".to_string(),
                    turn_id: "turn".to_string(),
                    item_id: "tool".to_string(),
                    title: "Permission".to_string(),
                    message: "Permission".to_string(),
                    requested_at: "2026-07-20T00:00:00Z".to_string(),
                    reason: None,
                    command: None,
                    cwd: None,
                    grant_root: None,
                    proposed_execpolicy_amendment: None,
                    options: vec![],
                },
            },
            CanonicalEvent::ElicitationRequested {
                request: PendingUserInputRequest {
                    request_id: "elicitation".to_string(),
                    agent_id: Some("agent".to_string()),
                    thread_id: "thread".to_string(),
                    turn_id: "turn".to_string(),
                    item_id: "elicitation".to_string(),
                    message: "Input".to_string(),
                    requested_at: "2026-07-20T00:00:01Z".to_string(),
                    questions: vec![],
                },
            },
        ] {
            service
                .handle_canonical_event(CanonicalHubEvent {
                    event_id: 20,
                    foreground_mobile_present: false,
                    event,
                })
                .await;
        }
        {
            let threads = service.threads.read().await;
            let runtime = threads.get("thread").unwrap();
            assert!(runtime.pending_approval_ids.contains("permission"));
            assert!(runtime.pending_user_input_ids.contains("elicitation"));
        }
        for event in [
            CanonicalEvent::PermissionResolved {
                agent_id: "agent".to_string(),
                thread_id: "thread".to_string(),
                request_id: "permission".to_string(),
                outcome: "rejected".to_string(),
            },
            CanonicalEvent::ElicitationResolved {
                agent_id: "agent".to_string(),
                thread_id: "thread".to_string(),
                request_id: "elicitation".to_string(),
                action: "cancelled".to_string(),
            },
        ] {
            service
                .handle_canonical_event(CanonicalHubEvent {
                    event_id: 21,
                    foreground_mobile_present: false,
                    event,
                })
                .await;
        }
        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 22,
                foreground_mobile_present: false,
                event: CanonicalEvent::Ignored {
                    agent_id: "agent".to_string(),
                    thread_id: None,
                    kind: "global".to_string(),
                },
            })
            .await;
    }

    #[tokio::test]
    async fn saturated_hub_delivers_resolution_then_terminal_and_queue_converges() {
        let hub = Arc::new(ClientHub::new());
        let mut observer = hub.subscribe_canonical_events();
        let (backend, _) = fake_dispatcher();
        let service = BridgeQueueService::new(backend, hub.clone());
        {
            let mut runtime = active_runtime(&[], &[]);
            runtime
                .pending_approval_ids
                .insert("permission".to_string());
            service
                .threads
                .write()
                .await
                .insert("thread".to_string(), runtime);
        }
        for index in 0..INTERNAL_NOTIFICATION_CHANNEL_CAPACITY {
            hub.broadcast_canonical_event(&CanonicalEvent::Ignored {
                agent_id: "agent".to_string(),
                thread_id: Some("thread".to_string()),
                kind: format!("filler-{index}"),
            })
            .await;
        }
        let producer = {
            let hub = hub.clone();
            tokio::spawn(async move {
                hub.broadcast_canonical_event(&CanonicalEvent::PermissionResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    request_id: "permission".to_string(),
                    outcome: "cancelled".to_string(),
                })
                .await;
                hub.broadcast_canonical_event(&CanonicalEvent::RunFinished {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    run_id: "run".to_string(),
                    source_turn_id: "turn".to_string(),
                    generation: 7,
                    stop_reason: StopReason::EndTurn,
                })
                .await;
            })
        };
        tokio::task::yield_now().await;
        assert!(!producer.is_finished());
        for _ in 0..INTERNAL_NOTIFICATION_CHANNEL_CAPACITY {
            observer.recv().await.expect("filler event");
        }
        producer.await.expect("canonical producer");
        let resolved = observer.recv().await.expect("resolution event");
        let finished = observer.recv().await.expect("terminal event");
        assert!(resolved.event_id < finished.event_id);
        assert!(matches!(
            resolved.event,
            CanonicalEvent::PermissionResolved { .. }
        ));
        assert!(matches!(finished.event, CanonicalEvent::RunFinished { .. }));

        loop {
            let queue = service.read_queue("thread").await;
            if !queue.waiting_for_tool_calls && queue.pending_steer_count == 0 {
                let threads = service.threads.read().await;
                let runtime = threads.get("thread").expect("tracked runtime");
                if runtime.pending_approval_ids.is_empty() && !runtime.thread_running {
                    break;
                }
            }
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn queue_auto_dispatch_records_continued_and_final_dispositions() {
        let (service, mut calls) = service_with_runtime(&[], &[]).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.thread_running = false;
            runtime.live_generation_known = false;
            runtime.items.push_back(queued("success"));
            runtime.pending_completion_event_ids.push(30);
        }
        let dispatch = tokio::spawn({
            let service = service.clone();
            async move { service.drain_thread_queue("thread".to_string()).await }
        });
        calls
            .turn_start
            .recv()
            .await
            .expect("continued dispatch")
            .response
            .send(Ok("next".to_string()))
            .unwrap();
        dispatch.await.unwrap();
        assert_eq!(
            service.wait_for_completion_disposition(30).await,
            Some(QueueCompletionDisposition::Continued)
        );
        let result = service.submission_results.lock().await["submission-success"].clone();
        assert!(matches!(
            result.disposition,
            BridgeThreadQueueDisposition::Sent
        ));
        assert_eq!(result.turn_id.as_deref(), Some("next"));

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.thread_running = false;
            runtime.items.push_back(queued("failure"));
            runtime.pending_completion_event_ids.push(31);
        }
        let dispatch = tokio::spawn({
            let service = service.clone();
            async move { service.drain_thread_queue("thread".to_string()).await }
        });
        calls
            .turn_start
            .recv()
            .await
            .expect("final dispatch")
            .response
            .send(Err("failed".to_string()))
            .unwrap();
        dispatch.await.unwrap();
        assert_eq!(
            service.wait_for_completion_disposition(31).await,
            Some(QueueCompletionDisposition::Final)
        );
        assert_eq!(
            service
                .read_queue("thread")
                .await
                .last_error
                .unwrap()
                .operation,
            "dispatch"
        );

        service
            .record_completion_disposition(32, QueueCompletionDisposition::Final)
            .await;
        assert_eq!(
            service.wait_for_completion_disposition(32).await,
            Some(QueueCompletionDisposition::Final)
        );

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.thread_running = false;
            runtime.items.clear();
            runtime.pending_completion_event_ids.push(33);
        }
        service.drain_thread_queue("thread".to_string()).await;
        assert_eq!(
            service.wait_for_completion_disposition(33).await,
            Some(QueueCompletionDisposition::Final)
        );
        assert_eq!(service.wait_for_completion_disposition(999).await, None);
        service.drain_thread_queue("missing".to_string()).await;
    }

    #[tokio::test]
    async fn queued_message_edit_pauses_completion_and_preserves_turn_metadata() {
        let (service, mut calls) = service_with_runtime(&["item"], &[]).await;
        let started = service
            .start_message_edit(BridgeThreadQueueEditRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect("edit starts");
        assert_eq!(started.queue.editing_item_id.as_deref(), Some("item"));

        service
            .handle_canonical_event(finish_event("turn", 7, 40))
            .await;
        assert!(
            tokio::time::timeout(Duration::from_millis(20), calls.turn_start.recv())
                .await
                .is_err()
        );
        assert_eq!(
            service
                .read_queue("thread")
                .await
                .editing_item_id
                .as_deref(),
            Some("item")
        );

        let committed = service
            .commit_message_edit(BridgeThreadQueueEditCommitRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
                content: "edited content".to_string(),
            })
            .await
            .expect("edit commits");
        assert!(committed.queue.editing_item_id.is_none());
        assert_eq!(committed.queue.items[0].content, "edited content");

        let turn_start = calls.turn_start.recv().await.expect("edited queue resumes");
        assert_eq!(turn_start.turn_start["input"][0]["text"], "edited content");
        assert_eq!(turn_start.turn_start["input"][1]["type"], "mention");
        assert_eq!(turn_start.turn_start["input"][1]["path"], "/repo/source.rs");
        assert_eq!(turn_start.turn_start["input"][2]["type"], "localImage");
        turn_start
            .response
            .send(Ok("edited-turn".to_string()))
            .expect("turn starts");
        assert_eq!(
            service.wait_for_completion_disposition(40).await,
            Some(QueueCompletionDisposition::Final)
        );
    }

    #[tokio::test]
    async fn canceling_queued_message_edit_resumes_original_content() {
        let (service, mut calls) = service_with_runtime(&["item"], &[]).await;
        service
            .start_message_edit(BridgeThreadQueueEditRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect("edit starts");
        service
            .handle_canonical_event(finish_event("turn", 7, 41))
            .await;
        assert!(
            tokio::time::timeout(Duration::from_millis(20), calls.turn_start.recv())
                .await
                .is_err()
        );

        service
            .cancel_message_edit(BridgeThreadQueueEditRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect("edit cancels");
        let turn_start = calls
            .turn_start
            .recv()
            .await
            .expect("original queue resumes");
        assert_eq!(turn_start.turn_start["input"][0]["text"], "text-item");
        turn_start
            .response
            .send(Ok("original-turn".to_string()))
            .expect("turn starts");
    }

    #[tokio::test]
    async fn queued_message_edit_rejects_dispatch_and_steer_races() {
        let (service, mut calls) = service_with_runtime(&["item"], &[]).await;
        service
            .handle_canonical_event(finish_event("turn", 7, 42))
            .await;
        let turn_start = calls
            .turn_start
            .recv()
            .await
            .expect("queue dispatch starts first");
        let edit = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .start_message_edit(BridgeThreadQueueEditRequest {
                        thread_id: "thread".to_string(),
                        item_id: "item".to_string(),
                    })
                    .await
            }
        });
        tokio::task::yield_now().await;
        assert!(!edit.is_finished());
        turn_start
            .response
            .send(Ok("dispatched-turn".to_string()))
            .expect("turn starts");
        assert!(edit.await.expect("edit task completes").is_err());

        let (service, _) = service_with_runtime(&["item"], &[]).await;
        {
            let mut threads = service.threads.write().await;
            threads
                .get_mut("thread")
                .expect("runtime")
                .pending_steers
                .push_back(queued("steer"));
        }
        assert!(service
            .start_message_edit(BridgeThreadQueueEditRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn queued_message_edit_enforces_thread_byte_budget() {
        let (service, _) = service_with_runtime(&["item", "other"], &[]).await;
        {
            let mut threads = service.threads.write().await;
            threads
                .get_mut("thread")
                .expect("runtime")
                .items
                .get_mut(1)
                .expect("other item")
                .content = "x".repeat(QUEUE_MAX_BYTES_PER_THREAD - (32 * 1024));
        }
        service
            .start_message_edit(BridgeThreadQueueEditRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect("edit starts");
        let error = service
            .commit_message_edit(BridgeThreadQueueEditCommitRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
                content: "y".repeat(QUEUE_MAX_CONTENT_BYTES),
            })
            .await
            .expect_err("thread byte budget rejects edit");
        assert!(error.contains("resource_limit:queue_thread_bytes"));
        assert_eq!(
            service
                .read_queue("thread")
                .await
                .editing_item_id
                .as_deref(),
            Some("item")
        );
    }

    #[tokio::test]
    async fn canceling_edited_item_resolves_a_previously_parked_completion() {
        let (service, _) = service_with_runtime(&["item"], &[]).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("runtime");
            runtime.thread_running = false;
            runtime.active_turn_id = None;
            runtime.active_run_id = None;
            runtime.active_prompt_generation = None;
            runtime.live_generation_known = false;
            runtime.editing_item_id = Some("item".to_string());
            runtime.pending_completion_event_ids.push(43);
        }

        service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect("edited item cancels");
        assert_eq!(
            service.wait_for_completion_disposition(43).await,
            Some(QueueCompletionDisposition::Final)
        );
    }

    #[tokio::test]
    async fn queue_completion_waits_for_in_flight_turn_start_continuation() {
        let (service, _) = service_with_runtime(&[], &[]).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.turn_start_in_flight = true;
            runtime.items.clear();
        }

        let completion_event = CanonicalHubEvent {
            event_id: 34,
            foreground_mobile_present: false,
            event: CanonicalEvent::RunFinished {
                agent_id: "agent".to_string(),
                thread_id: "thread".to_string(),
                run_id: "run".to_string(),
                source_turn_id: "turn".to_string(),
                generation: 7,
                stop_reason: StopReason::EndTurn,
            },
        };
        service.handle_canonical_event(completion_event).await;

        assert!(!service
            .completion_dispositions
            .lock()
            .await
            .contains_key(&34));
        {
            let threads = service.threads.read().await;
            let runtime = threads.get("thread").expect("runtime remains");
            assert!(runtime.turn_start_in_flight);
            assert_eq!(runtime.pending_completion_event_ids, vec![34]);
            assert_eq!(runtime.active_turn_id.as_deref(), Some("turn"));
            assert_eq!(runtime.active_run_id.as_deref(), Some("run"));
            assert_eq!(runtime.active_prompt_generation, Some(7));
        }

        service
            .record_completion_disposition(34, QueueCompletionDisposition::Continued)
            .await;
        assert_eq!(
            service.wait_for_completion_disposition(34).await,
            Some(QueueCompletionDisposition::Continued)
        );
    }

    #[tokio::test]
    async fn queue_reconcile_resumes_pending_steer_and_malformed_prompt_restores_it() {
        let (backend, mut calls) = fake_dispatcher();
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let mut runtime = active_runtime(&[], &[]);
        runtime.pending_steers.push_back(queued("reconciled"));
        service
            .threads
            .write()
            .await
            .insert("thread".to_string(), runtime);
        service.reconcile_all_threads().await;
        let steer = calls.steer.recv().await.expect("reconcile resumes steer");
        assert_eq!(steer.prompt_generation, 7);
        steer.response.send(Ok(())).unwrap();

        let mut runtime = active_runtime(&[], &[]);
        runtime.pending_steers.push_back(BridgeQueuedMessageEntry {
            id: "malformed".to_string(),
            submission_id: "submission-malformed".to_string(),
            created_at: "now".to_string(),
            content: "malformed".to_string(),
            turn_start: json!({"input": []}),
            agent_message: None,
        });
        service
            .threads
            .write()
            .await
            .insert("malformed-thread".to_string(), runtime);
        service
            .drain_pending_steers("malformed-thread".to_string())
            .await;
        let snapshot = service.read_queue("malformed-thread").await;
        assert_eq!(snapshot.pending_steer_count, 1);
        assert_eq!(snapshot.pending_steers[0].id, "malformed");
        assert_eq!(snapshot.last_error.unwrap().operation, "steer");
        assert!(calls.steer.try_recv().is_err());
    }

    #[tokio::test]
    async fn queue_action_guards_and_normal_cancellation_preserve_state() {
        let (service, _) = service_with_runtime(&["item"], &[]).await;
        {
            let mut threads = service.threads.write().await;
            threads.get_mut("thread").unwrap().turn_start_in_flight = true;
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect_err("busy action")
            .contains("busy"));
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.turn_start_in_flight = false;
            runtime.live_generation_known = false;
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect_err("no live generation")
            .contains("no live"));
        {
            service
                .threads
                .write()
                .await
                .get_mut("thread")
                .unwrap()
                .live_generation_known = true;
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "missing".to_string(),
            })
            .await
            .expect_err("missing queued item")
            .contains("not found"));

        {
            service
                .threads
                .write()
                .await
                .get_mut("thread")
                .unwrap()
                .action_in_flight_item_id = Some("item".to_string());
        }
        assert!(service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect_err("in-flight action")
            .contains("being processed"));
        {
            service
                .threads
                .write()
                .await
                .get_mut("thread")
                .unwrap()
                .action_in_flight_item_id = None;
        }
        let cancelled = service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect("normal item cancels");
        assert!(cancelled.queue.items.is_empty());
    }

    #[tokio::test]
    async fn queue_run_start_and_correlation_guards_are_conservative() {
        let (service, mut calls) = service_with_runtime(&["item"], &[]).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.turn_start_in_flight = true;
            runtime.last_error = Some(BridgeThreadQueueError {
                message: "old".to_string(),
                operation: "dispatch".to_string(),
                at: "now".to_string(),
                item_id: None,
            });
        }
        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 40,
                foreground_mobile_present: false,
                event: CanonicalEvent::RunStarted {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    run_id: "new-run".to_string(),
                    source_turn_id: "new-turn".to_string(),
                    generation: 8,
                },
            })
            .await;
        {
            let threads = service.threads.read().await;
            let runtime = threads.get("thread").unwrap();
            assert_eq!(runtime.active_run_id.as_deref(), Some("new-run"));
            assert_eq!(runtime.active_turn_id.as_deref(), Some("new-turn"));
            assert_eq!(runtime.active_prompt_generation, Some(8));
            assert!(runtime.last_error.is_none());
        }

        let mut wrong_run = tool_event("tool", 8, ToolCallStatus::Pending);
        if let CanonicalEvent::Tool { run_id, .. } = &mut wrong_run.event {
            *run_id = Some("wrong".to_string());
        }
        service.handle_canonical_event(wrong_run).await;
        let mut wrong_turn = tool_event("tool", 8, ToolCallStatus::Pending);
        if let CanonicalEvent::Tool {
            run_id,
            source_turn_id,
            ..
        } = &mut wrong_turn.event
        {
            *run_id = Some("new-run".to_string());
            *source_turn_id = Some("wrong".to_string());
        }
        service.handle_canonical_event(wrong_turn).await;
        assert!(service
            .threads
            .read()
            .await
            .get("thread")
            .unwrap()
            .active_tool_call_ids
            .is_empty());

        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 41,
                foreground_mobile_present: false,
                event: CanonicalEvent::PermissionResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "missing".to_string(),
                    request_id: "permission".to_string(),
                    outcome: "cancelled".to_string(),
                },
            })
            .await;
        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 42,
                foreground_mobile_present: false,
                event: CanonicalEvent::ElicitationResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "missing".to_string(),
                    request_id: "elicitation".to_string(),
                    action: "cancelled".to_string(),
                },
            })
            .await;
        assert!(calls.steer.try_recv().is_err());
    }

    #[tokio::test]
    async fn queue_capacity_status_and_dispatch_blocker_matrix_is_stable() {
        let (service, mut calls) = service_with_runtime(&["item"], &[]).await;
        assert!(Arc::ptr_eq(
            &service.thread_actor("thread").await,
            &service.thread_actor("thread").await
        ));
        assert_eq!(service.read_queue(" ").await.thread_id, "");
        service
            .threads
            .write()
            .await
            .insert("idle".to_string(), BridgeThreadQueueRuntime::default());
        let status = service.status().await;
        assert_eq!(status.tracked_threads, 2);
        assert_eq!(status.depth, 1);
        assert_eq!(status.busy_threads, 1);

        *service.completion_dispositions.lock().await = (0..QUEUE_COMPLETION_DISPOSITION_LIMIT
            as u64)
            .map(|event_id| (event_id, QueueCompletionDisposition::Final))
            .collect();
        service
            .record_completion_disposition(
                QUEUE_COMPLETION_DISPOSITION_LIMIT as u64,
                QueueCompletionDisposition::Continued,
            )
            .await;
        let dispositions = service.completion_dispositions.lock().await;
        assert_eq!(dispositions.len(), QUEUE_COMPLETION_DISPOSITION_LIMIT);
        assert!(!dispositions.contains_key(&0));
        drop(dispositions);

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.action_in_flight_item_id = Some("other".to_string());
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .is_err());

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.action_in_flight_item_id = None;
            runtime.active_turn_id = None;
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .is_err());
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.active_turn_id = Some("turn".to_string());
            runtime.active_run_id = None;
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .is_err());
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.active_run_id = Some("run".to_string());
            runtime.active_prompt_generation = None;
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .is_err());

        let reset = |runtime: &mut BridgeThreadQueueRuntime| {
            *runtime = active_runtime(&["item"], &[]);
            runtime.thread_running = false;
        };
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.turn_start_in_flight = true;
        }
        service.drain_thread_queue("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.action_in_flight_item_id = Some("item".to_string());
        }
        service.drain_thread_queue("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.steer_prepare_in_flight = true;
        }
        service.drain_thread_queue("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.steer_dispatch_in_flight = Some(PendingSteerDispatch {
                entry: queued("steer"),
                expected_turn_id: "turn".to_string(),
                expected_run_id: "run".to_string(),
                prompt_generation: 7,
                crossed_completion_boundary: false,
            });
        }
        service.drain_thread_queue("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.pending_steers.push_back(queued("steer"));
        }
        service.drain_thread_queue("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.pending_approval_ids.insert("approval".to_string());
        }
        service.drain_thread_queue("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.pending_user_input_ids.insert("input".to_string());
        }
        service.drain_thread_queue("thread".to_string()).await;
        assert!(calls.turn_start.try_recv().is_err());

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.thread_running = true;
            runtime
                .pending_steers
                .push_back(runtime.items.pop_front().unwrap());
            runtime.active_turn_id = None;
        }
        service.drain_pending_steers("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.active_turn_id = Some("turn".to_string());
            runtime.active_run_id = None;
        }
        service.drain_pending_steers("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.active_run_id = Some("run".to_string());
            runtime.active_prompt_generation = None;
        }
        service.drain_pending_steers("thread".to_string()).await;
        assert!(calls.steer.try_recv().is_err());
    }

    #[tokio::test]
    async fn completion_waiters_and_submission_dedupe_preserve_bounded_state() {
        let (backend, _calls) = fake_dispatcher();
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));

        let waiting_service = Arc::clone(&service);
        let waiter =
            tokio::spawn(async move { waiting_service.wait_for_completion_disposition(77).await });
        tokio::task::yield_now().await;
        service
            .record_completion_disposition(77, QueueCompletionDisposition::Continued)
            .await;
        assert_eq!(
            waiter.await.expect("completion waiter task"),
            Some(QueueCompletionDisposition::Continued)
        );

        let queue = service.read_queue("thread").await;
        for index in 0..=SUBMISSION_DEDUPE_LIMIT {
            service
                .remember_submission_result(BridgeThreadQueueSendResponse {
                    submission_id: format!("submission-{index}"),
                    disposition: BridgeThreadQueueDisposition::Queued,
                    queue: queue.clone(),
                    turn_id: None,
                })
                .await
                .unwrap();
        }
        let results = service.submission_results.lock().await;
        assert_eq!(results.len(), SUBMISSION_DEDUPE_LIMIT);
        assert!(!results.contains_key("submission-0"));
        drop(results);

        let retained_submission_id = format!("submission-{SUBMISSION_DEDUPE_LIMIT}");
        service
            .remember_submission_result(BridgeThreadQueueSendResponse {
                submission_id: retained_submission_id.clone(),
                disposition: BridgeThreadQueueDisposition::Sent,
                queue,
                turn_id: Some("turn".to_string()),
            })
            .await
            .unwrap();
        let order = service.submission_order.lock().await;
        assert_eq!(
            order
                .iter()
                .filter(|submission_id| *submission_id == &retained_submission_id)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn queue_noops_and_terminal_correlation_preserve_existing_runtime() {
        let (service, _calls) = service_with_runtime(&["item"], &[]).await;

        service.drain_pending_steers("missing".to_string()).await;
        service.drain_thread_queue("missing".to_string()).await;
        service
            .fail_steer_dispatch("missing", "item", "missing runtime".to_string())
            .await;

        for (source_turn_id, generation) in [("other-turn", 7), ("turn", 8)] {
            service
                .handle_canonical_event(CanonicalHubEvent {
                    event_id: 88,
                    foreground_mobile_present: false,
                    event: CanonicalEvent::RunFinished {
                        agent_id: "agent".to_string(),
                        thread_id: "thread".to_string(),
                        run_id: "run".to_string(),
                        source_turn_id: source_turn_id.to_string(),
                        generation,
                        stop_reason: StopReason::EndTurn,
                    },
                })
                .await;
        }
        {
            let threads = service.threads.read().await;
            let runtime = threads.get("thread").unwrap();
            assert!(runtime.thread_running);
            assert_eq!(runtime.active_turn_id.as_deref(), Some("turn"));
            assert_eq!(runtime.active_prompt_generation, Some(7));
        }

        {
            let mut threads = service.threads.write().await;
            threads.insert(
                "idle".to_string(),
                BridgeThreadQueueRuntime {
                    pending_completion_event_ids: vec![89],
                    ..BridgeThreadQueueRuntime::default()
                },
            );
        }
        service.drain_thread_queue("idle".to_string()).await;
        assert_eq!(
            service.wait_for_completion_disposition(89).await,
            Some(QueueCompletionDisposition::Final)
        );
    }

    #[tokio::test]
    async fn resolved_interactions_resume_pending_steers() {
        let (service, mut calls) = service_with_runtime(&[], &[]).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.pending_steers.push_back(queued("approval-steer"));
            runtime.pending_approval_ids.insert("approval".to_string());
        }

        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 90,
                foreground_mobile_present: false,
                event: CanonicalEvent::PermissionResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    request_id: "approval".to_string(),
                    outcome: "approved".to_string(),
                },
            })
            .await;
        let approval_call = tokio::time::timeout(Duration::from_secs(1), calls.steer.recv())
            .await
            .expect("approval steer dispatch timeout")
            .expect("approval steer dispatch");
        approval_call.response.send(Ok(())).unwrap();

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime
                .pending_steers
                .push_back(queued("elicitation-steer"));
            runtime
                .pending_user_input_ids
                .insert("elicitation".to_string());
        }
        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 91,
                foreground_mobile_present: false,
                event: CanonicalEvent::ElicitationResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    request_id: "elicitation".to_string(),
                    action: "accepted".to_string(),
                },
            })
            .await;
        let elicitation_call = tokio::time::timeout(Duration::from_secs(1), calls.steer.recv())
            .await
            .expect("elicitation steer dispatch timeout")
            .expect("elicitation steer dispatch");
        elicitation_call.response.send(Ok(())).unwrap();
    }

    #[tokio::test]
    async fn queue_submission_idempotency_survives_a_worker_restart() {
        let directory =
            std::env::temp_dir().join(format!("dappercode-queue-dedupe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("queue.json");
        let (backend, _) = fake_dispatcher();
        let service = BridgeQueueService::with_submission_store(
            backend,
            Arc::new(ClientHub::new()),
            Some(path.clone()),
            DurableQueueSubmissions::default(),
        );
        service.release_submission("missing").await.unwrap();
        service.submission_dirty.store(true, Ordering::Release);
        let _ = service.status().await;
        assert!(!service.submission_dirty.load(Ordering::Acquire));
        service
            .submission_pending
            .lock()
            .await
            .insert("submission-indeterminate".to_string(), "thread".to_string());
        service.persist_submission_store().await.unwrap();
        let queued = service
            .send_message(send_request(
                "thread",
                "submission-queued",
                "queued content",
            ))
            .await
            .unwrap();
        assert!(matches!(
            queued.disposition,
            BridgeThreadQueueDisposition::Queued
        ));
        service
            .remember_submission_result(BridgeThreadQueueSendResponse {
                submission_id: "submission-1".to_string(),
                disposition: BridgeThreadQueueDisposition::Sent,
                queue: BridgeQueueService::snapshot_for_thread("thread", None),
                turn_id: Some("turn-1".to_string()),
            })
            .await
            .unwrap();

        let restored = BridgeQueueService::load_submission_store(&path)
            .await
            .unwrap();
        assert_eq!(
            restored.results["submission-1"].turn_id.as_deref(),
            Some("turn-1")
        );
        assert!(!restored.results.contains_key("submission-queued"));
        assert_eq!(restored.pending["submission-indeterminate"], "thread");
        assert!(!restored.pending.contains_key("submission-queued"));
        assert_eq!(restored.order, VecDeque::from(["submission-1".to_string()]));
        let (backend, _) = fake_dispatcher();
        let restarted = BridgeQueueService::with_submission_store(
            backend,
            Arc::new(ClientHub::new()),
            Some(path.clone()),
            restored,
        );
        assert_eq!(restarted.status().await.other_live_work, 0);
        let cached = tokio::time::timeout(
            Duration::from_secs(1),
            restarted.send_message(send_request("thread", "submission-1", "ignored duplicate")),
        )
        .await
        .expect("cached durable receipt must not deadlock")
        .expect("cached durable receipt");
        assert_eq!(cached.turn_id.as_deref(), Some("turn-1"));
        assert!(tokio::time::timeout(
            Duration::from_secs(1),
            restarted.reserve_submission("submission-1", "thread", true),
        )
        .await
        .expect("cached reservation lookup must not deadlock")
        .unwrap()
        .is_some());
        let retried = restarted
            .send_message(send_request(
                "thread",
                "submission-queued",
                "queued content",
            ))
            .await
            .expect("lost in-memory queue item is safely retryable after restart");
        assert!(matches!(
            retried.disposition,
            BridgeThreadQueueDisposition::Queued
        ));
        let queue = restarted.read_queue("thread").await;
        assert_eq!(queue.items.len(), 1);
        assert_eq!(queue.items[0].content, "queued content");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn queue_submission_store_rejects_invalid_files_and_bounds_pending_state() {
        let directory =
            std::env::temp_dir().join(format!("dappercode-queue-bounds-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("queue.json");

        assert!(BridgeQueueService::load_submission_store(&path)
            .await
            .unwrap()
            .pending
            .is_empty());
        std::fs::write(&path, b"{").unwrap();
        let error = match BridgeQueueService::load_submission_store(&path).await {
            Ok(_) => panic!("malformed store should fail"),
            Err(error) => error,
        };
        assert!(error.contains("invalid"));
        std::fs::write(&path, vec![b'x'; QUEUE_RECEIPT_STORE_MAX_BYTES + 1]).unwrap();
        let error = match BridgeQueueService::load_submission_store(&path).await {
            Ok(_) => panic!("oversized store should fail"),
            Err(error) => error,
        };
        assert!(error.contains("exceeds"));

        let mut pending = HashMap::new();
        for index in 0..=SUBMISSION_DEDUPE_LIMIT {
            pending.insert(format!("submission-{index:05}"), "thread".to_string());
        }
        std::fs::write(
            &path,
            serde_json::to_vec(&DurableQueueReceiptFile {
                pending,
                ..DurableQueueReceiptFile::default()
            })
            .unwrap(),
        )
        .unwrap();
        let bounded = BridgeQueueService::load_submission_store(&path)
            .await
            .unwrap();
        assert_eq!(bounded.pending.len(), SUBMISSION_DEDUPE_LIMIT);

        let receipts = (0..=SUBMISSION_DEDUPE_LIMIT)
            .map(|index| {
                (
                    format!("receipt-{index:05}"),
                    DurableQueueReceipt {
                        thread_id: "thread".to_string(),
                        turn_id: format!("turn-{index}"),
                    },
                )
            })
            .collect();
        let order = (0..=SUBMISSION_DEDUPE_LIMIT)
            .map(|index| format!("receipt-{index:05}"))
            .collect();
        std::fs::write(
            &path,
            serde_json::to_vec(&DurableQueueReceiptFile {
                receipts,
                order,
                pending: HashMap::new(),
                pending_order: VecDeque::new(),
            })
            .unwrap(),
        )
        .unwrap();
        let bounded = BridgeQueueService::load_submission_store(&path)
            .await
            .unwrap();
        assert_eq!(bounded.results.len(), SUBMISSION_DEDUPE_LIMIT);
        assert!(!bounded.results.contains_key("receipt-00000"));

        let (backend, _) = fake_dispatcher();
        let service = BridgeQueueService::with_submission_store(
            backend,
            Arc::new(ClientHub::new()),
            Some(path.clone()),
            DurableQueueSubmissions::default(),
        );
        {
            let mut results = service.submission_results.lock().await;
            let mut order = service.submission_order.lock().await;
            for index in 0..300 {
                let id = format!("large-{index:03}");
                results.insert(
                    id.clone(),
                    BridgeQueueSubmissionReceipt {
                        submission_id: id.clone(),
                        thread_id: "x".repeat(QUEUE_IDENTIFIER_MAX_BYTES),
                        disposition: BridgeThreadQueueDisposition::Sent,
                        turn_id: Some(format!("turn-{index}")),
                    },
                );
                order.push_back(id);
            }
        }
        service.persist_submission_store().await.unwrap();
        assert!(
            BridgeQueueService::load_submission_store(&path)
                .await
                .unwrap()
                .results
                .len()
                < 300
        );

        service.submission_results.lock().await.clear();
        service.submission_order.lock().await.clear();
        service.submission_pending.lock().await.insert(
            "oversized".to_string(),
            "x".repeat(QUEUE_RECEIPT_STORE_MAX_BYTES),
        );
        service.persist_submission_store().await.unwrap();
        assert!(BridgeQueueService::load_submission_store(&path)
            .await
            .unwrap()
            .pending
            .is_empty());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn receipt_compaction_rechecks_budget_before_evicting_pending_reservations() {
        let pending_fixture = |value_len: usize| {
            let pending = (0..SUBMISSION_DEDUPE_LIMIT)
                .map(|index| (format!("pending-{index:05}"), "x".repeat(value_len)))
                .collect::<HashMap<_, _>>();
            let pending_order = (0..SUBMISSION_DEDUPE_LIMIT)
                .map(|index| format!("pending-{index:05}"))
                .collect::<VecDeque<_>>();
            (pending, pending_order)
        };
        let (empty_pending, empty_order) = pending_fixture(0);
        let base_size = serde_json::to_vec(&DurableQueueReceiptFile {
            pending: empty_pending,
            pending_order: empty_order,
            ..DurableQueueReceiptFile::default()
        })
        .unwrap()
        .len();
        let target_size = QUEUE_RECEIPT_STORE_MAX_BYTES - 2_000;
        let value_len = target_size.saturating_sub(base_size) / SUBMISSION_DEDUPE_LIMIT;
        let (pending, pending_order) = pending_fixture(value_len);
        let receipt_id = "large-receipt".to_string();
        let receipt = DurableQueueReceipt {
            thread_id: "r".repeat(QUEUE_IDENTIFIER_MAX_BYTES),
            turn_id: "turn".to_string(),
        };
        let fixture = DurableQueueReceiptFile {
            receipts: HashMap::from([(receipt_id.clone(), receipt)]),
            order: VecDeque::from([receipt_id.clone()]),
            pending: pending.clone(),
            pending_order: pending_order.clone(),
        };
        let fixture_size = serde_json::to_vec(&fixture).unwrap().len();
        assert!(fixture_size > QUEUE_RECEIPT_STORE_MAX_BYTES);
        assert!(
            (SUBMISSION_DEDUPE_LIMIT + 1)
                .saturating_mul(fixture_size - QUEUE_RECEIPT_STORE_MAX_BYTES)
                .div_ceil(fixture_size)
                > 1
        );

        let directory = std::env::temp_dir().join(format!(
            "dappercode-queue-compaction-boundary-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("queue.json");
        let (backend, _) = fake_dispatcher();
        let service = BridgeQueueService::with_submission_store(
            backend,
            Arc::new(ClientHub::new()),
            Some(path.clone()),
            DurableQueueSubmissions {
                results: HashMap::from([(
                    receipt_id.clone(),
                    BridgeQueueSubmissionReceipt {
                        submission_id: receipt_id.clone(),
                        thread_id: "r".repeat(QUEUE_IDENTIFIER_MAX_BYTES),
                        disposition: BridgeThreadQueueDisposition::Sent,
                        turn_id: Some("turn".to_string()),
                    },
                )]),
                order: VecDeque::from([receipt_id]),
                pending,
                pending_order,
            },
        );

        service.persist_submission_store().await.unwrap();
        let restored = BridgeQueueService::load_submission_store(&path)
            .await
            .unwrap();
        assert!(restored.results.is_empty());
        assert_eq!(restored.pending.len(), SUBMISSION_DEDUPE_LIMIT);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn automatic_queue_dispatch_persists_indeterminate_then_sent_receipts() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-queue-dispatch-dedupe-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("queue.json");
        let (backend, mut calls) = fake_dispatcher();
        let service = BridgeQueueService::with_submission_store(
            backend,
            Arc::new(ClientHub::new()),
            Some(path.clone()),
            DurableQueueSubmissions::default(),
        );
        let queued = service
            .send_message(send_request("thread", "dispatch-submission", "queued"))
            .await
            .unwrap();
        assert!(matches!(
            queued.disposition,
            BridgeThreadQueueDisposition::Queued
        ));
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.thread_running = false;
            runtime.active_turn_id = None;
        }

        let drain = tokio::spawn({
            let service = service.clone();
            async move { service.drain_thread_queue("thread".to_string()).await }
        });
        let call = calls
            .turn_start
            .recv()
            .await
            .expect("queued turn dispatched");
        let pending = BridgeQueueService::load_submission_store(&path)
            .await
            .unwrap();
        assert_eq!(
            pending
                .pending
                .get("dispatch-submission")
                .map(String::as_str),
            Some("thread")
        );
        call.response
            .send(Ok("turn-dispatched".to_string()))
            .unwrap();
        drain.await.unwrap();

        let completed = BridgeQueueService::load_submission_store(&path)
            .await
            .unwrap();
        assert!(!completed.pending.contains_key("dispatch-submission"));
        assert_eq!(
            completed.results["dispatch-submission"].turn_id.as_deref(),
            Some("turn-dispatched")
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn failed_dispatch_reservation_persistence_rolls_back_before_requeue() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-queue-dispatch-persist-failure-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("queue.json");
        std::fs::create_dir(&path).unwrap();
        let (backend, _) = fake_dispatcher();
        let service = BridgeQueueService::with_submission_store(
            backend,
            Arc::new(ClientHub::new()),
            Some(path),
            DurableQueueSubmissions::default(),
        );

        assert!(service
            .mark_submission_dispatch_pending("submission", "thread")
            .await
            .expect_err("directory destination rejects persistence")
            .contains("failed to persist"));
        assert!(!service
            .submission_pending
            .lock()
            .await
            .contains_key("submission"));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn pending_dispatch_reservations_evict_oldest_without_blocking_new_work() {
        let (backend, _) = fake_dispatcher();
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));

        for index in 0..=SUBMISSION_DEDUPE_LIMIT {
            service
                .reserve_submission(&format!("pending-{index:05}"), "thread", true)
                .await
                .unwrap();
        }

        let pending = service.submission_pending.lock().await;
        assert_eq!(pending.len(), SUBMISSION_DEDUPE_LIMIT);
        assert!(!pending.contains_key("pending-00000"));
        assert!(pending.contains_key(&format!("pending-{SUBMISSION_DEDUPE_LIMIT:05}")));
        drop(pending);
        assert_eq!(
            service
                .submission_pending_order
                .lock()
                .await
                .front()
                .map(String::as_str),
            Some("pending-00001")
        );
    }

    #[tokio::test]
    async fn submission_reservation_guards_cover_conflicts_duplicates_and_store_errors() {
        let (backend, _) = fake_dispatcher();
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        assert!(service
            .send_message(send_request(
                "thread",
                &"x".repeat(PUSH_ID_MAX_BYTES + 1),
                "content",
            ))
            .await
            .expect_err("oversized submission id")
            .contains("at most"));

        service
            .submission_pending
            .lock()
            .await
            .insert("pending".to_string(), "thread".to_string());
        assert!(service
            .lookup_submission("pending", "other")
            .await
            .expect_err("lookup conflict")
            .contains("another thread"));
        assert!(service
            .reserve_submission("pending", "thread", true)
            .await
            .expect_err("same-thread pending reservation")
            .contains("indeterminate"));
        assert!(service
            .reserve_submission("pending", "other", true)
            .await
            .expect_err("cross-thread pending reservation")
            .contains("another thread"));
        service.submission_pending.lock().await.clear();

        service.submission_results.lock().await.insert(
            "completed".to_string(),
            BridgeQueueSubmissionReceipt {
                submission_id: "completed".to_string(),
                thread_id: "thread".to_string(),
                disposition: BridgeThreadQueueDisposition::Sent,
                turn_id: Some("turn".to_string()),
            },
        );
        assert!(service
            .reserve_submission("completed", "other", true)
            .await
            .expect_err("cross-thread completed reservation")
            .contains("another thread"));

        service
            .mark_submission_dispatch_pending("dispatch", "thread")
            .await
            .unwrap();
        service
            .mark_submission_dispatch_pending("dispatch", "thread")
            .await
            .unwrap();

        let directory = std::env::temp_dir().join(format!(
            "dappercode-queue-read-directory-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let error = match BridgeQueueService::load_submission_store(&directory).await {
            Ok(_) => panic!("directory is not a receipt file"),
            Err(error) => error,
        };
        assert!(error.contains("failed to read"));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn transient_dispatch_reservation_failure_retries_with_durable_admission() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-queue-dispatch-persist-retry-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("queue.json");
        let (backend, mut calls) = fake_dispatcher();
        let service = BridgeQueueService::with_submission_store(
            backend,
            Arc::new(ClientHub::new()),
            Some(path.clone()),
            DurableQueueSubmissions::default(),
        );
        service
            .send_message(send_request("thread", "retry-persist", "queued"))
            .await
            .unwrap();
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.thread_running = false;
            runtime.active_turn_id = None;
        }
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();

        service.drain_thread_queue("thread".to_string()).await;
        assert_eq!(
            service
                .threads
                .read()
                .await
                .get("thread")
                .unwrap()
                .items
                .len(),
            1
        );
        assert!(!service
            .submission_pending
            .lock()
            .await
            .contains_key("retry-persist"));

        std::fs::remove_dir(&path).unwrap();
        let call = tokio::time::timeout(std::time::Duration::from_secs(2), calls.turn_start.recv())
            .await
            .expect("retry backoff elapsed")
            .expect("queued turn retried");
        let durable = BridgeQueueService::load_submission_store(&path)
            .await
            .unwrap();
        assert_eq!(
            durable.pending.get("retry-persist").map(String::as_str),
            Some("thread")
        );
        call.response.send(Ok("turn-retried".to_string())).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if service
                    .submission_results
                    .lock()
                    .await
                    .get("retry-persist")
                    .is_some_and(|receipt| {
                        matches!(receipt.disposition, BridgeThreadQueueDisposition::Sent)
                    })
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("retried dispatch settles");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn indeterminate_immediate_and_queued_dispatches_remain_reserved_without_replay() {
        let (backend, mut calls) = fake_dispatcher();
        {
            let mut snapshot = backend.snapshot.lock().unwrap();
            snapshot.session.active_run_id = None;
            snapshot.session.active_source_turn_id = None;
            snapshot.session.active_generation = None;
        }
        let service = BridgeQueueService::new(backend.clone(), Arc::new(ClientHub::new()));
        let immediate = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .send_message(send_request("immediate", "ambiguous-now", "content"))
                    .await
            }
        });
        calls
            .turn_start
            .recv()
            .await
            .expect("immediate dispatch")
            .response
            .send(Err(format!(
                "{INDETERMINATE_OPERATION_PREFIX}connection closed"
            )))
            .unwrap();
        assert!(immediate
            .await
            .unwrap()
            .expect_err("ambiguous dispatch fails")
            .starts_with(INDETERMINATE_OPERATION_PREFIX));
        assert!(service
            .send_message(send_request("immediate", "ambiguous-now", "retry"))
            .await
            .expect_err("same submission remains reserved")
            .contains("outcome is indeterminate"));
        assert!(calls.turn_start.try_recv().is_err());

        {
            let mut snapshot = backend.snapshot.lock().unwrap();
            snapshot.session.active_run_id = Some("run".to_string());
            snapshot.session.active_source_turn_id = Some("turn".to_string());
            snapshot.session.active_generation = Some(1);
        }
        let queued = service
            .send_message(send_request("queued", "ambiguous-later", "queued"))
            .await
            .unwrap();
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("queued").unwrap();
            runtime.thread_running = false;
            runtime.active_turn_id = None;
        }
        let drain = tokio::spawn({
            let service = service.clone();
            async move { service.drain_thread_queue("queued".to_string()).await }
        });
        calls
            .turn_start
            .recv()
            .await
            .expect("queued dispatch")
            .response
            .send(Err(format!(
                "{INDETERMINATE_OPERATION_PREFIX}response dropped"
            )))
            .unwrap();
        drain.await.unwrap();

        assert!(service
            .threads
            .read()
            .await
            .get("queued")
            .unwrap()
            .items
            .is_empty());
        assert!(service
            .send_message(send_request("queued", "ambiguous-later", "retry"))
            .await
            .expect_err("queued submission remains reserved")
            .contains("outcome is indeterminate"));
        assert!(calls.turn_start.try_recv().is_err());
        assert!(matches!(
            queued.disposition,
            BridgeThreadQueueDisposition::Queued
        ));
    }

    #[tokio::test]
    async fn cancellation_persistence_failure_still_broadcasts_and_resumes_dispatch() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-queue-cancel-persist-failure-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("queue.json");
        let (backend, mut calls) = fake_dispatcher();
        let service = BridgeQueueService::with_submission_store(
            backend,
            Arc::new(ClientHub::new()),
            Some(path.clone()),
            DurableQueueSubmissions::default(),
        );
        let first = service
            .send_message(send_request("thread", "cancel-first", "first"))
            .await
            .unwrap();
        service
            .send_message(send_request("thread", "dispatch-second", "second"))
            .await
            .unwrap();
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.thread_running = false;
            runtime.active_turn_id = None;
        }
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();

        let cancelled = service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: first.queue.items[0].id.clone(),
            })
            .await
            .expect("runtime cancellation succeeds despite receipt persistence failure");
        assert_eq!(
            cancelled
                .queue
                .last_error
                .as_ref()
                .map(|error| error.operation.as_str()),
            Some("persist")
        );
        assert_eq!(cancelled.queue.items.len(), 1);

        std::fs::remove_dir(&path).unwrap();
        let call = calls
            .turn_start
            .recv()
            .await
            .expect("remaining item dispatches after cancellation");
        call.response.send(Ok("turn-second".to_string())).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if service
                    .submission_results
                    .lock()
                    .await
                    .get("dispatch-second")
                    .is_some_and(|receipt| {
                        matches!(receipt.disposition, BridgeThreadQueueDisposition::Sent)
                    })
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dispatch settles");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn late_dispatch_blockers_keep_the_pending_steer_queued() {
        let (service, mut calls) = service_with_runtime(&[], &[]).await;

        assert_late_dispatch_blocker(&service, &mut calls, |runtime| {
            runtime.steer_dispatch_in_flight = Some(PendingSteerDispatch {
                entry: queued("other"),
                expected_turn_id: "turn".to_string(),
                expected_run_id: "run".to_string(),
                prompt_generation: 7,
                crossed_completion_boundary: false,
            });
        })
        .await;
        assert_late_dispatch_blocker(&service, &mut calls, |runtime| {
            runtime.turn_start_in_flight = true;
        })
        .await;
        assert_late_dispatch_blocker(&service, &mut calls, |runtime| {
            runtime.action_in_flight_item_id = Some("action".to_string());
        })
        .await;
        assert_late_dispatch_blocker(&service, &mut calls, |runtime| {
            runtime.active_tool_call_ids.insert("tool".to_string());
        })
        .await;
        assert_late_dispatch_blocker(&service, &mut calls, |runtime| {
            runtime.live_generation_known = false;
        })
        .await;
        assert_late_dispatch_blocker(&service, &mut calls, |runtime| {
            runtime.thread_running = false;
        })
        .await;
        assert_late_dispatch_blocker(&service, &mut calls, |runtime| {
            runtime.pending_approval_ids.insert("approval".to_string());
        })
        .await;
        assert_late_dispatch_blocker(&service, &mut calls, |runtime| {
            runtime
                .pending_user_input_ids
                .insert("elicitation".to_string());
        })
        .await;
    }
}
