use crate::*;

// ---- Push notifications ----------------------------------------------------
//
// The mobile app can only run JavaScript (and therefore keep its WebSocket
// open) while it is foregrounded. The moment it is backgrounded or killed the
// socket closes, so the *phone* can never observe a turn completing. The bridge
// is the only component reliably alive at that moment, so it is the sender:
// devices register an Expo push token, and the bridge POSTs a minimal,
// content-free payload to the Expo push service when a turn completes or an
// approval is requested. Expo relays to APNs/FCM, which wakes the app.

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
            http: reqwest::Client::new(),
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
        tokio::spawn(async move {
            while let Some(event) = receiver.recv().await {
                this.handle_canonical_event(event, queue.as_deref()).await;
            }
        })
    }

    pub(super) async fn handle_canonical_event(
        self: &Arc<Self>,
        received: CanonicalHubEvent,
        queue: Option<&BridgeQueueService>,
    ) {
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
                    return;
                };
                if queue
                    .wait_for_completion_disposition(received.event_id)
                    .await
                    .is_none_or(|disposition| !completion_is_final(disposition))
                {
                    return;
                }
                self.send_canonical_push(
                    PushEvent::TurnCompleted,
                    Some(thread_id),
                    None,
                    reply_preview,
                )
                .await;
            }
            crate::acp::events::CanonicalEvent::PermissionRequested { approval } => {
                self.send_canonical_push(
                    PushEvent::ApprovalRequested,
                    Some(approval.thread_id),
                    Some(approval.request_id),
                    None,
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
            let (bounded, _) = resource_limits::truncate_utf8_bytes(content, remaining);
            entry.push_str(&bounded);
        }
    }

    async fn send_canonical_push(
        self: &Arc<Self>,
        event: PushEvent,
        thread_id: Option<String>,
        approval_id: Option<String>,
        reply_preview: Option<String>,
    ) {
        self.send_canonical_push_to_endpoint(
            EXPO_PUSH_SEND_ENDPOINT,
            event,
            thread_id,
            approval_id,
            reply_preview,
        )
        .await;
    }

    async fn send_canonical_push_to_endpoint(
        self: &Arc<Self>,
        endpoint: &str,
        event: PushEvent,
        thread_id: Option<String>,
        approval_id: Option<String>,
        reply_preview: Option<String>,
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
                    self.project_label
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
                            .and_then(|details| read_string(details.get("error")));
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
                                "push request to {url} gave up after {attempt} attempts (status {status})"
                            );
                            return None;
                        }
                        let wait_ms = response
                            .headers()
                            .get("retry-after")
                            .and_then(|value| value.to_str().ok())
                            .and_then(|value| value.parse::<u64>().ok())
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
                    .and_then(|details| read_string(details.get("error")));
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
mod tests {
    use super::*;
    use crate::acp::events::{CanonicalEvent, MessageRole};
    use agent_client_protocol::schema::v1::{ContentBlock, StopReason};
    use axum::{
        extract::State,
        http::StatusCode,
        response::{IntoResponse, Response},
        routing::post,
        Json, Router,
    };
    use futures_util::future::BoxFuture;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct UnusedQueueDispatcher;

    impl QueueRuntimeDispatcher for UnusedQueueDispatcher {
        fn read_snapshot<'a>(
            &'a self,
            _thread_id: &'a str,
        ) -> BoxFuture<'a, Result<QueueRuntimeSnapshot, String>> {
            Box::pin(async { Err("unused".to_string()) })
        }

        fn supports_steer(&self, _thread_id: &str) -> Result<bool, String> {
            Ok(false)
        }

        fn prepare_steer<'a>(&'a self, _thread_id: &'a str) -> BoxFuture<'a, Result<u64, String>> {
            Box::pin(async { Err("unused".to_string()) })
        }

        fn verify_steer_epoch<'a>(
            &'a self,
            _thread_id: &'a str,
            _epoch: u64,
        ) -> BoxFuture<'a, Result<bool, String>> {
            Box::pin(async { Err("unused".to_string()) })
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
            Box::pin(async { Err("unused".to_string()) })
        }

        fn turn_start<'a>(
            &'a self,
            _thread_id: &'a str,
            _turn_start: &'a Value,
        ) -> BoxFuture<'a, Result<String, String>> {
            Box::pin(async { Err("unused".to_string()) })
        }
    }

    async fn retrying_push_fixture(State(attempts): State<Arc<AtomicUsize>>) -> Response {
        if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                [("retry-after", "0")],
                Json(json!({"error": "retry"})),
            )
                .into_response();
        }
        Json(json!({"data": [{"status": "ok"}]})).into_response()
    }

    async fn rate_limited_push_fixture(State(attempts): State<Arc<AtomicUsize>>) -> Response {
        attempts.fetch_add(1, Ordering::SeqCst);
        (
            StatusCode::TOO_MANY_REQUESTS,
            [("retry-after", "0")],
            Json(json!({"error": "limited"})),
        )
            .into_response()
    }

    #[tokio::test]
    async fn delayed_receipt_checks_keep_the_worker_non_retireable() {
        let directory =
            std::env::temp_dir().join(format!("dappercode-push-receipt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let service = PushService::load(
            &directory,
            "project".to_string(),
            Arc::new(OperationalMetrics::new()),
        )
        .await;
        assert_eq!(service.pending_receipt_check_count(), 0);
        service.spawn_receipt_check(Vec::new());
        assert_eq!(service.pending_receipt_check_count(), 0);
        service.spawn_receipt_check(vec![("receipt".to_string(), "token".to_string())]);
        assert_eq!(service.pending_receipt_check_count(), 1);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn completion_pushes_only_follow_the_final_queue_disposition() {
        assert!(completion_is_final(QueueCompletionDisposition::Final));
        assert!(!completion_is_final(QueueCompletionDisposition::Continued));
    }

    #[tokio::test]
    async fn canonical_reply_previews_are_bounded_and_terminal_events_consume_them() {
        let directory =
            std::env::temp_dir().join(format!("dappercode-push-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let service = PushService::load(
            &directory,
            "project".to_string(),
            Arc::new(OperationalMetrics::new()),
        )
        .await;

        service.accumulate_canonical_reply("empty", "").await;
        assert!(!service.recent_replies.read().await.contains_key("empty"));
        {
            let mut replies = service.recent_replies.write().await;
            for index in 0..PUSH_PREVIEW_MAX_THREADS.saturating_sub(1) {
                replies.insert(format!("old-{index}"), "old".to_string());
            }
            replies.insert("full".to_string(), "x".repeat(PUSH_PREVIEW_ACCUMULATE_CAP));
        }
        service
            .accumulate_canonical_reply("new", "first\n final   answer ")
            .await;
        service.accumulate_canonical_reply("full", "ignored").await;
        assert_eq!(
            service.recent_replies.read().await["full"].len(),
            PUSH_PREVIEW_ACCUMULATE_CAP
        );
        assert_eq!(
            service.take_reply_preview("new").await.as_deref(),
            Some("final answer")
        );
        assert!(service.take_reply_preview("missing").await.is_none());
        service.accumulate_canonical_reply("blank", " \n\t ").await;
        assert!(service.take_reply_preview("blank").await.is_none());
        service
            .send_canonical_push_to_endpoint(
                "http://127.0.0.1:1/not-used",
                PushEvent::TurnCompleted,
                None,
                None,
                None,
            )
            .await;

        let hub = Arc::new(ClientHub::new());
        let event_loop = service.spawn_event_loop_with_queue(&hub, None);
        hub.broadcast_canonical_event(&CanonicalEvent::MessageChunk {
            agent_id: "agent".to_string(),
            thread_id: "loop-thread".to_string(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role: MessageRole::Agent,
            message_id: "loop-message".to_string(),
            content: "loop reply".to_string(),
            content_block: None,
        })
        .await;
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if service
                    .recent_replies
                    .read()
                    .await
                    .contains_key("loop-thread")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(hub);
        tokio::time::timeout(std::time::Duration::from_secs(1), event_loop)
            .await
            .expect("push event loop should close with the hub")
            .unwrap();

        service
            .handle_canonical_event(
                CanonicalHubEvent {
                    event_id: 1,
                    event: CanonicalEvent::MessageChunk {
                        agent_id: "agent".to_string(),
                        thread_id: "thread".to_string(),
                        run_id: Some("run".to_string()),
                        source_turn_id: Some("turn".to_string()),
                        generation: Some(1),
                        role: MessageRole::Agent,
                        message_id: "message".to_string(),
                        content: "completed".to_string(),
                        content_block: None,
                    },
                },
                None,
            )
            .await;
        assert!(service.recent_replies.read().await.contains_key("thread"));
        service
            .handle_canonical_event(
                CanonicalHubEvent {
                    event_id: 2,
                    event: CanonicalEvent::RunFinished {
                        agent_id: "agent".to_string(),
                        thread_id: "thread".to_string(),
                        run_id: "run".to_string(),
                        source_turn_id: "turn".to_string(),
                        generation: 1,
                        stop_reason: StopReason::EndTurn,
                    },
                },
                None,
            )
            .await;
        assert!(!service.recent_replies.read().await.contains_key("thread"));

        let queue =
            BridgeQueueService::new(Arc::new(UnusedQueueDispatcher), Arc::new(ClientHub::new()));
        for (event_id, disposition) in [
            (3, QueueCompletionDisposition::Continued),
            (4, QueueCompletionDisposition::Final),
        ] {
            service
                .accumulate_canonical_reply("settled", "answer")
                .await;
            queue
                .record_completion_disposition(event_id, disposition)
                .await;
            service
                .handle_canonical_event(
                    CanonicalHubEvent {
                        event_id,
                        event: CanonicalEvent::RunFinished {
                            agent_id: "agent".to_string(),
                            thread_id: "settled".to_string(),
                            run_id: "run".to_string(),
                            source_turn_id: "turn".to_string(),
                            generation: 1,
                            stop_reason: StopReason::EndTurn,
                        },
                    },
                    Some(&queue),
                )
                .await;
        }

        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn push_transport_handles_ticket_outcomes_retries_and_malformed_responses() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let blocked_entered = Arc::new(tokio::sync::Notify::new());
        let blocked_release = Arc::new(tokio::sync::Notify::new());
        let entered_handler = blocked_entered.clone();
        let release_handler = blocked_release.clone();
        let app = Router::new()
            .route(
                "/blocked",
                post(move || {
                    let entered = entered_handler.clone();
                    let release = release_handler.clone();
                    async move {
                        entered.notify_one();
                        release.notified().await;
                        Json(json!({"data": [{"status": "ok"}]}))
                    }
                }),
            )
            .route(
                "/tickets",
                post(|| async {
                    Json(json!({
                        "data": [
                            {"status": "ok", "id": "receipt"},
                            {
                                "status": "error",
                                "details": {"error": "DeviceNotRegistered"}
                            },
                            {"status": "error", "details": {"error": "Other"}},
                            {"status": "unknown"}
                        ]
                    }))
                }),
            )
            .route(
                "/partial",
                post(|| async { Json(json!({"data": [{"status": "ok"}]})) }),
            )
            .route("/nodata", post(|| async { Json(json!({"ok": true})) }))
            .route(
                "/extra",
                post(|| async {
                    Json(json!({
                        "data": [{"status": "ok"}, {"status": "ok"}]
                    }))
                }),
            )
            .route(
                "/receipts",
                post(|| async {
                    Json(json!({
                        "data": {
                            "receipt-ok": {"status": "ok"},
                            "receipt-stale": {
                                "status": "error",
                                "details": {"error": "DeviceNotRegistered"}
                            },
                            "receipt-other": {
                                "status": "error",
                                "details": {"error": "Other"}
                            },
                            "receipt-missing": {
                                "status": "error",
                                "details": {"error": "DeviceNotRegistered"}
                            }
                        }
                    }))
                }),
            )
            .route(
                "/receipt-nodata",
                post(|| async { Json(json!({"data": []})) }),
            )
            .route("/invalid", post(|| async { "not json" }))
            .route("/retry", post(retrying_push_fixture))
            .route("/limited", post(rate_limited_push_fixture))
            .with_state(attempts.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let directory =
            std::env::temp_dir().join(format!("dappercode-push-http-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let service = PushService::load(
            &directory,
            "project".to_string(),
            Arc::new(OperationalMetrics::new()),
        )
        .await;
        service
            .register(
                "profile".to_string(),
                "turn-registration".to_string(),
                "turn-token".to_string(),
                "ios".to_string(),
                "Phone".to_string(),
                PushEventPreferences {
                    turn_completed: true,
                    approval_requested: false,
                },
            )
            .await
            .unwrap();
        service
            .register(
                "profile".to_string(),
                "approval-registration".to_string(),
                "approval-token".to_string(),
                "ios".to_string(),
                "Phone".to_string(),
                PushEventPreferences {
                    turn_completed: false,
                    approval_requested: true,
                },
            )
            .await
            .unwrap();
        let blocked_send = tokio::spawn({
            let service = service.clone();
            let endpoint = format!("{base}/blocked");
            async move {
                service
                    .send_to_endpoint(
                        &endpoint,
                        "title",
                        "body",
                        &json!({}),
                        None,
                        vec![(
                            "blocked".to_string(),
                            "profile".to_string(),
                            "blocked".to_string(),
                        )],
                    )
                    .await;
            }
        });
        blocked_entered.notified().await;
        assert_eq!(service.pending_delivery_count(), 1);
        blocked_release.notify_one();
        blocked_send.await.unwrap();
        assert_eq!(service.pending_delivery_count(), 0);
        let targets = (0..4)
            .map(|index| {
                (
                    format!("token-{index}"),
                    "profile".to_string(),
                    format!("registration-{index}"),
                )
            })
            .collect();
        service
            .send_to_endpoint(
                &format!("{base}/tickets"),
                "title",
                "body",
                &json!({"kind": "test"}),
                Some("approval"),
                targets,
            )
            .await;
        service
            .send_canonical_push_to_endpoint(
                &format!("{base}/partial"),
                PushEvent::TurnCompleted,
                Some("thread".to_string()),
                None,
                Some("reply".to_string()),
            )
            .await;
        service
            .send_canonical_push_to_endpoint(
                &format!("{base}/partial"),
                PushEvent::TurnCompleted,
                Some("thread".to_string()),
                None,
                None,
            )
            .await;
        service
            .send_canonical_push_to_endpoint(
                &format!("{base}/partial"),
                PushEvent::ApprovalRequested,
                Some("thread".to_string()),
                Some("approval".to_string()),
                None,
            )
            .await;
        service
            .send_to_endpoint(
                &format!("{base}/nodata"),
                "title",
                "body",
                &json!({}),
                None,
                vec![(
                    "nodata".to_string(),
                    "profile".to_string(),
                    "nodata".to_string(),
                )],
            )
            .await;
        service
            .send_to_endpoint(
                &format!("{base}/extra"),
                "title",
                "body",
                &json!({}),
                None,
                vec![(
                    "extra".to_string(),
                    "profile".to_string(),
                    "extra".to_string(),
                )],
            )
            .await;
        assert_eq!(service.pending_receipt_check_count(), 1);

        service
            .send_to_endpoint(
                &format!("{base}/partial"),
                "title",
                "body",
                &json!({}),
                None,
                vec![
                    ("one".to_string(), "profile".to_string(), "one".to_string()),
                    ("two".to_string(), "profile".to_string(), "two".to_string()),
                ],
            )
            .await;
        service
            .send_to_endpoint(
                &format!("{base}/invalid"),
                "title",
                "body",
                &json!({}),
                None,
                vec![(
                    "invalid".to_string(),
                    "profile".to_string(),
                    "invalid".to_string(),
                )],
            )
            .await;

        attempts.store(0, Ordering::SeqCst);
        assert!(service
            .post_with_retry(&format!("{base}/retry"), &json!({}))
            .await
            .is_some());
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        attempts.store(0, Ordering::SeqCst);
        assert!(service
            .post_with_retry(&format!("{base}/limited"), &json!({}))
            .await
            .is_none());
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            PUSH_SEND_MAX_ATTEMPTS as usize
        );
        assert!(service
            .post_with_retry("http://127.0.0.1:1/unreachable", &json!({}))
            .await
            .is_none());
        service
            .check_receipts_from_endpoint(
                &format!("{base}/receipts"),
                vec![
                    ("receipt-ok".to_string(), "ok".to_string()),
                    ("receipt-stale".to_string(), "stale".to_string()),
                    ("receipt-other".to_string(), "other".to_string()),
                ],
            )
            .await;
        service
            .check_receipts_from_endpoint(
                &format!("{base}/receipt-nodata"),
                vec![("receipt".to_string(), "token".to_string())],
            )
            .await;
        service
            .check_receipts_from_endpoint(
                "http://127.0.0.1:1/unreachable",
                vec![("receipt".to_string(), "token".to_string())],
            )
            .await;

        let authenticated = Arc::new(PushService {
            registry: PushRegistryStore::load(&directory).await,
            project_label: "project".to_string(),
            http: reqwest::Client::new(),
            access_token: Some("access".to_string()),
            recent_replies: RwLock::new(HashMap::new()),
            metrics: Arc::new(OperationalMetrics::new()),
            active_deliveries: AtomicU64::new(0),
            pending_receipt_checks: AtomicU64::new(0),
        });
        assert!(authenticated
            .post_with_retry(&format!("{base}/partial"), &json!({}))
            .await
            .is_some());

        server.abort();
        let _ = server.await;
        let _ = std::fs::remove_dir_all(directory);
    }
}
