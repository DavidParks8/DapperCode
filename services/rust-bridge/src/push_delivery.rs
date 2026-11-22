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
use dappercode_bridge_core::resource_limits::truncate_utf8_bytes;

// ---- Push notifications ----------------------------------------------------
//
// The mobile app explicitly reports whether it is foregrounded over its
// WebSocket. The socket can remain connected after the app is backgrounded, so
// connection state alone cannot decide whether the user will observe an event.
// The bridge is the component reliably alive in the background, so it is the sender:
// devices register an Expo push token, and the bridge POSTs a bounded
// notification payload to the Expo push service when a turn completes or an
// approval is requested. After the live event is queued, a foreground mobile
// client can acknowledge its push candidate. Delivery is suppressed for every
// device only with that observation proof; missing or stale presence fails open.
// Expo relays remaining pushes to APNs/FCM, which wakes the app.

pub(super) const EXPO_PUSH_SEND_ENDPOINT: &str = "https://exp.host/--/api/v2/push/send";
pub(super) const EXPO_PUSH_RECEIPTS_ENDPOINT: &str = "https://exp.host/--/api/v2/push/getReceipts";
pub(super) const EXPO_PUSH_BATCH_SIZE: usize = 100;
// Reply-preview tuning: cap how much streamed text we buffer per thread, and how
// many characters of the first line we surface in the notification body.
pub(super) const PUSH_PREVIEW_ACCUMULATE_CAP: usize = PUSH_PREVIEW_MAX_BYTES;
pub(super) const PUSH_PREVIEW_MAX_CHARS: usize = 140;
pub(super) const EXPO_RECEIPT_BATCH_SIZE: usize = 1000;
// Expo asks senders to wait at least ~15 minutes before fetching delivery receipts.
pub(super) const RECEIPT_CHECK_DELAY_SECS: u64 = 900;
pub(super) const PUSH_SEND_MAX_ATTEMPTS: u32 = 4;
pub(super) const QUEUE_COMPLETION_DISPOSITION_WAIT_MS: u64 = 2_000;
// The candidate follows the live event on the same socket. Keep this bounded so
// an unresponsive foreground lease delays, rather than drops, a needed push.
pub(super) const PUSH_OBSERVATION_WAIT_MS: u64 = 750;
pub(super) const QUEUE_COMPLETION_DISPOSITION_LIMIT: usize = 1_024;
pub(super) const SUBMISSION_DEDUPE_LIMIT: usize = 1_024;
pub(super) const APPROVAL_RESOLUTION_DEDUPE_LIMIT: usize = 1_024;

pub(super) struct PushService {
    pub(super) registry: PushRegistryStore,
    pub(super) project_label: String,
    pub(super) http: reqwest::Client,
    pub(super) access_token: Option<String>,
    // Accumulates the in-flight agent reply text per thread (keyed by threadId),
    // so a turn/completed push can include a short preview of what the agent said.
    pub(super) recent_replies: RwLock<HashMap<String, String>>,
    pub(super) metrics: Arc<OperationalMetrics>,
    pub(super) active_deliveries: AtomicU64,
    pub(super) pending_receipt_checks: AtomicU64,
}

impl PushService {
    pub(super) async fn load(
        workdir: &Path,
        project_label: String,
        metrics: Arc<OperationalMetrics>,
    ) -> Arc<Self> {
        let registry = PushRegistryStore::load(workdir).await;
        let access_token = env::var("EXPO_ACCESS_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Arc::new(Self {
            registry,
            project_label,
            http: crate::tls::http_client(),
            access_token,
            recent_replies: RwLock::new(HashMap::new()),
            metrics,
            active_deliveries: AtomicU64::new(0),
            pending_receipt_checks: AtomicU64::new(0),
        })
    }

    pub(super) fn spawn_event_loop_with_queue(
        self: &Arc<Self>,
        hub: &Arc<ClientHub>,
        queue: Option<Arc<BridgeQueueService>>,
    ) -> tokio::task::JoinHandle<()> {
        let this = Arc::clone(self);
        let mut receiver = hub.subscribe_canonical_events();
        let hub = Arc::downgrade(hub);
        tokio::spawn(async move {
            while let Some(event) = receiver.recv().await {
                let Some(hub) = hub.upgrade() else {
                    break;
                };
                this.handle_canonical_event(event, queue.as_deref(), &hub)
                    .await;
            }
        })
    }

    pub(super) async fn handle_canonical_event(
        self: &Arc<Self>,
        received: CanonicalHubEvent,
        queue: Option<&BridgeQueueService>,
        hub: &ClientHub,
    ) {
        self.handle_canonical_event_to_endpoint(EXPO_PUSH_SEND_ENDPOINT, received, queue, hub)
            .await;
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn handle_canonical_event_to_endpoint(
        self: &Arc<Self>,
        endpoint: &str,
        received: CanonicalHubEvent,
        queue: Option<&BridgeQueueService>,
        hub: &ClientHub,
    ) {
        let foreground_mobile_present = received.foreground_mobile_present;
        let candidate_id = received.event_id;
        match received.event {
            crate::acp::events::CanonicalEvent::MessageChunk {
                thread_id,
                role: crate::acp::events::MessageRole::Agent,
                content,
                ..
            } => self.accumulate_canonical_reply(&thread_id, &content).await,
            crate::acp::events::CanonicalEvent::RunFinished { thread_id, .. }
            | crate::acp::events::CanonicalEvent::RunFailed { thread_id, .. } => {
                let reply_preview = self.take_reply_preview(&thread_id).await;
                let Some(queue) = queue else {
                    hub.discard_push_observation(candidate_id).await;
                    return;
                };
                if queue
                    .wait_for_completion_disposition(received.event_id)
                    .await
                    .is_none_or(|disposition| !completion_is_final(disposition))
                {
                    hub.discard_push_observation(candidate_id).await;
                    return;
                }
                let observed = if foreground_mobile_present {
                    hub.take_push_observation(
                        candidate_id,
                        Duration::from_millis(PUSH_OBSERVATION_WAIT_MS),
                    )
                    .await
                } else {
                    hub.discard_push_observation(candidate_id).await;
                    false
                };
                self.send_canonical_push_to_endpoint(
                    endpoint,
                    PushEvent::TurnCompleted,
                    Some(thread_id),
                    None,
                    reply_preview,
                    observed,
                )
                .await;
            }
            crate::acp::events::CanonicalEvent::PermissionRequested { approval } => {
                let observed = if foreground_mobile_present {
                    hub.take_push_observation(
                        candidate_id,
                        Duration::from_millis(PUSH_OBSERVATION_WAIT_MS),
                    )
                    .await
                } else {
                    hub.discard_push_observation(candidate_id).await;
                    false
                };
                self.send_canonical_push_to_endpoint(
                    endpoint,
                    PushEvent::ApprovalRequested,
                    Some(approval.thread_id),
                    Some(approval.request_id),
                    None,
                    observed,
                )
                .await;
            }
            _ => {}
        }
    }

    async fn accumulate_canonical_reply(&self, thread_id: &str, content: &str) {
        if content.is_empty() {
            return;
        }
        let mut replies = self.recent_replies.write().await;
        if !replies.contains_key(thread_id) && replies.len() >= PUSH_PREVIEW_MAX_THREADS {
            let oldest_key = replies
                .keys()
                .next()
                .cloned()
                .expect("a full preview cache has an entry");
            replies.remove(&oldest_key);
        }
        let entry = replies.entry(thread_id.to_string()).or_default();
        if entry.len() < PUSH_PREVIEW_ACCUMULATE_CAP {
            let remaining = PUSH_PREVIEW_ACCUMULATE_CAP - entry.len();
            let (bounded, _) = truncate_utf8_bytes(content, remaining);
            entry.push_str(&bounded);
        }
    }

    async fn send_canonical_push_to_endpoint(
        self: &Arc<Self>,
        endpoint: &str,
        event: PushEvent,
        thread_id: Option<String>,
        approval_id: Option<String>,
        reply_preview: Option<String>,
        observed_by_foreground_mobile: bool,
    ) {
        let targets = {
            let registry = self.registry.snapshot().await;
            registry
                .devices
                .iter()
                .filter(|device| match event {
                    PushEvent::TurnCompleted => device.events.turn_completed,
                    PushEvent::ApprovalRequested => device.events.approval_requested,
                })
                .map(|device| {
                    (
                        device.token.clone(),
                        device.profile_id.clone(),
                        device.registration_id.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        if targets.is_empty() {
            return;
        }
        if observed_by_foreground_mobile {
            return;
        }
        let (title, body) = match event {
            PushEvent::TurnCompleted => (
                "Turn finished".to_string(),
                reply_preview.unwrap_or_else(|| {
                    format!("The agent finished working in {}", self.project_label)
                }),
            ),
            PushEvent::ApprovalRequested => (
                "Approval needed".to_string(),
                format!(
                    "The agent is waiting for your approval in {}",
                    self.project_label,
                ),
            ),
        };
        let data = json!({
            "type": event.as_str(),
            "notificationId": Uuid::new_v4().to_string(),
            "threadId": thread_id,
            "approvalId": approval_id,
        });
        let category_id = matches!(event, PushEvent::ApprovalRequested).then_some("approval");
        self.send_to_endpoint(endpoint, &title, &body, &data, category_id, targets)
            .await;
    }

    pub(super) async fn register(
        &self,
        profile_id: String,
        registration_id: String,
        token: String,
        platform: String,
        device_name: String,
        events: PushEventPreferences,
    ) -> Result<usize, BridgeError> {
        self.registry
            .register(
                profile_id,
                registration_id,
                token,
                platform,
                device_name,
                events,
            )
            .await
    }

    pub(super) async fn unregister(
        &self,
        profile_id: &str,
        registration_id: &str,
    ) -> Result<bool, BridgeError> {
        self.registry.unregister(profile_id, registration_id).await
    }

    pub(super) async fn unregister_stale_token(&self, token: &str) -> bool {
        match self.registry.unregister_token(token).await {
            Ok(removed) => removed,
            Err(error) => {
                eprintln!("failed to unregister push device: {}", error.message);
                false
            }
        }
    }

    /// Remove and format the accumulated reply for a thread into a one-line
    /// preview: last non-empty line (agents usually end with the conclusion),
    /// whitespace-collapsed, length-capped.
    pub(super) async fn take_reply_preview(&self, thread_id: &str) -> Option<String> {
        let raw = {
            let mut replies = self.recent_replies.write().await;
            replies.remove(thread_id)?
        };
        let last_line = raw.lines().map(str::trim).rfind(|line| !line.is_empty())?;
        let collapsed = last_line.split_whitespace().collect::<Vec<_>>().join(" ");
        if collapsed.is_empty() {
            return None;
        }
        Some(truncate_chars(&collapsed, PUSH_PREVIEW_MAX_CHARS))
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
    async fn send_to_endpoint(
        self: &Arc<Self>,
        endpoint: &str,
        title: &str,
        body: &str,
        data: &Value,
        category_id: Option<&str>,
        targets: Vec<(String, String, String)>,
    ) {
        self.active_deliveries.fetch_add(1, Ordering::AcqRel);
        let _delivery = PushDeliveryGuard(&self.active_deliveries);
        for chunk in targets.chunks(EXPO_PUSH_BATCH_SIZE) {
            self.metrics.push_attempted(chunk.len());
            let messages: Vec<Value> = chunk
                .iter()
                .map(|(token, profile_id, registration_id)| {
                    let mut target_data = data.clone();
                    target_data["profileId"] = json!(profile_id);
                    target_data["registrationId"] = json!(registration_id);
                    let mut message = json!({
                        "to": token,
                        "title": title,
                        "body": body,
                        "data": target_data,
                        "sound": "default",
                        "priority": "high",
                    });
                    // iOS action buttons are driven by a registered category; the
                    // app maps this id to its Approve/Deny actions.
                    if let Some(category) = category_id {
                        message["categoryId"] = json!(category);
                    }
                    message
                })
                .collect();

            let Some(payload) = self
                .post_with_retry(endpoint, &Value::Array(messages))
                .await
            else {
                self.metrics.push_transport_failure(chunk.len());
                continue;
            };

            // Expo returns one ticket per message, in request order. status="error"
            // is an immediate failure; status="ok" carries a receipt id that we
            // re-check later, because DeviceNotRegistered (and APNs/FCM delivery
            // failures) frequently only surface in the receipt, not the ticket.
            let Some(tickets) = payload.get("data").and_then(Value::as_array) else {
                self.metrics.push_transport_failure(chunk.len());
                continue;
            };
            let mut stale: Vec<String> = Vec::new();
            let mut pending_receipts: Vec<(String, String)> = Vec::new();
            let mut accepted = 0usize;
            let mut failed = chunk.len().saturating_sub(tickets.len());
            for (index, ticket) in tickets.iter().enumerate() {
                let Some((token, _, _)) = chunk.get(index).cloned() else {
                    continue;
                };
                match read_string(ticket.get("status")).as_deref() {
                    Some("ok") => {
                        accepted += 1;
                        if let Some(receipt_id) = read_string(ticket.get("id")) {
                            pending_receipts.push((receipt_id, token));
                        }
                    }
                    Some("error") => {
                        failed += 1;
                        let error_kind = ticket
                            .get("details")
                            .map(|details| details.get("error"))
                            .and_then(read_string);
                        if error_kind.as_deref() == Some("DeviceNotRegistered") {
                            stale.push(token);
                        }
                    }
                    _ => failed += 1,
                }
            }
            self.metrics.push_outcome(accepted, failed);
            for token in stale {
                self.unregister_stale_token(&token).await;
            }
            if !pending_receipts.is_empty() {
                self.spawn_receipt_check(pending_receipts);
            }
        }
    }

    /// POST JSON to Expo, retrying on 429 / 5xx / transport errors with
    /// exponential backoff (honoring Retry-After). Returns the parsed body, or
    /// None once attempts are exhausted.
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::excessive_nesting,
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(super) async fn post_with_retry(&self, url: &str, body: &Value) -> Option<Value> {
        let mut delay_ms: u64 = 500;
        for attempt in 1..=PUSH_SEND_MAX_ATTEMPTS {
            let mut request = self
                .http
                .post(url)
                .timeout(std::time::Duration::from_secs(15))
                .json(body);
            if let Some(token) = &self.access_token {
                request = request.bearer_auth(token);
            }
            match request.send().await {
                Ok(response) => {
                    let status = response.status();
                    if status.as_u16() == 429 || status.is_server_error() {
                        if attempt >= PUSH_SEND_MAX_ATTEMPTS {
                            eprintln!(
                                "push request to {url} gave up after {attempt} attempts (status {status})",
                            );
                            return None;
                        }
                        let wait_ms = response
                            .headers()
                            .get("retry-after")
                            .map(HeaderValue::to_str)
                            .and_then(Result::ok)
                            .map(str::parse::<u64>)
                            .and_then(Result::ok)
                            .map(|secs| secs.saturating_mul(1000))
                            .map(|milliseconds| milliseconds.min(8000))
                            .unwrap_or(delay_ms);
                        tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
                        delay_ms = (delay_ms * 2).min(8000);
                        continue;
                    }
                    match response.json::<Value>().await {
                        Ok(value) => return Some(value),
                        Err(error) => {
                            eprintln!("push response parse failed: {error}");
                            return None;
                        }
                    }
                }
                Err(error) => {
                    if attempt >= PUSH_SEND_MAX_ATTEMPTS {
                        eprintln!("push request to {url} failed after {attempt} attempts: {error}");
                        return None;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    delay_ms = (delay_ms * 2).min(8000);
                }
            }
        }
        None
    }

    /// After Expo's recommended delay, fetch delivery receipts for the given
    /// (receiptId, token) pairs and prune tokens reported DeviceNotRegistered.
    pub(super) fn spawn_receipt_check(self: &Arc<Self>, receipts: Vec<(String, String)>) {
        if receipts.is_empty() {
            return;
        }
        self.pending_receipt_checks.fetch_add(1, Ordering::AcqRel);
        let this = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(RECEIPT_CHECK_DELAY_SECS)).await;
            this.check_receipts(receipts).await;
            this.pending_receipt_checks.fetch_sub(1, Ordering::AcqRel);
        });
    }

    pub(super) fn pending_receipt_check_count(&self) -> usize {
        usize::try_from(self.pending_receipt_checks.load(Ordering::Acquire)).unwrap_or(usize::MAX)
    }

    pub(super) fn pending_delivery_count(&self) -> usize {
        let active =
            usize::try_from(self.active_deliveries.load(Ordering::Acquire)).unwrap_or(usize::MAX);
        active.saturating_add(self.pending_receipt_check_count())
    }

    pub(super) async fn check_receipts(&self, receipts: Vec<(String, String)>) {
        self.check_receipts_from_endpoint(EXPO_PUSH_RECEIPTS_ENDPOINT, receipts)
            .await;
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::excessive_nesting,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn check_receipts_from_endpoint(&self, endpoint: &str, receipts: Vec<(String, String)>) {
        for chunk in receipts.chunks(EXPO_RECEIPT_BATCH_SIZE) {
            let ids: Vec<&str> = chunk.iter().map(|(id, _)| id.as_str()).collect();
            let Some(payload) = self.post_with_retry(endpoint, &json!({ "ids": ids })).await else {
                continue;
            };
            let Some(map) = payload.get("data").and_then(Value::as_object) else {
                continue;
            };
            let mut stale: Vec<String> = Vec::new();
            for (receipt_id, receipt) in map {
                if read_string(receipt.get("status")).as_deref() != Some("error") {
                    continue;
                }
                self.metrics.push_receipt_error();
                let error_kind = receipt
                    .get("details")
                    .map(|details| details.get("error"))
                    .and_then(read_string);
                if error_kind.as_deref() == Some("DeviceNotRegistered") {
                    if let Some((_, token)) = chunk.iter().find(|(id, _)| id == receipt_id) {
                        stale.push(token.clone());
                    }
                }
            }
            for token in stale {
                self.unregister_stale_token(&token).await;
            }
        }
    }
}

struct PushDeliveryGuard<'a>(&'a AtomicU64);

impl Drop for PushDeliveryGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn completion_is_final(disposition: QueueCompletionDisposition) -> bool {
    disposition == QueueCompletionDisposition::Final
}

#[derive(Clone, Copy)]
pub(super) enum PushEvent {
    TurnCompleted,
    ApprovalRequested,
}

impl PushEvent {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            PushEvent::TurnCompleted => "turn_completed",
            PushEvent::ApprovalRequested => "approval_requested",
        }
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "push_delivery_tests.rs"]
mod tests;
