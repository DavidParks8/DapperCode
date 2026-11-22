#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
use crate::acp::events::CanonicalEvent;
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::wildcard_imports,
        reason = "flat sibling modules split from main.rs share crate-root symbols"
    )
)]
use crate::*;

pub(super) const CLIENT_TYPE_HEADER: &str = "x-dappercode-client-type";
pub(super) const CLIENT_NAME_HEADER: &str = "x-dappercode-client-name";
pub(super) const CLIENT_FOREGROUND_HEADER: &str = "x-dappercode-client-foreground";
pub(super) const MOBILE_CLIENT_TYPE: &str = "mobile";
pub(super) const MOBILE_FOREGROUND_LEASE_TIMEOUT: Duration = Duration::from_secs(30);
const PUSH_OBSERVATION_LIMIT: usize = 1_024;
const PUSH_CANDIDATE_METHOD: &str = "bridge/push/candidate";

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
pub(super) struct ClientHub {
    pub(super) next_client_id: AtomicU64,
    pub(super) next_event_id: AtomicU64,
    pub(super) next_canonical_event_id: AtomicU64,
    pub(super) stream_id: String,
    pub(super) clients: RwLock<HashMap<u64, ClientOutbox>>,
    pub(super) client_infos: RwLock<HashMap<u64, BridgeDeviceConnection>>,
    pub(super) notification_replay: NotificationReplay,
    pub(super) canonical_subscribers: std::sync::Mutex<Vec<mpsc::Sender<CanonicalHubEvent>>>,
    pub(super) client_queue_drops: AtomicU64,
    pub(super) canonical_emit_lock: Mutex<()>,
    pub(super) notification_publish_lock: Mutex<()>,
    pub(super) latest_published_event_id: AtomicU64,
    pub(super) ag_ui_projector: Mutex<AgUiProjector>,
    push_observations: Mutex<PushObservationTracker>,
    #[cfg(test)]
    notification_serializations: AtomicU64,
}

#[derive(Debug, Clone)]
pub(super) struct ClientConnectionMetadata {
    pub(super) client_type: String,
    pub(super) client_name: String,
    pub(super) foreground: bool,
}

impl Default for ClientConnectionMetadata {
    fn default() -> Self {
        Self {
            client_type: "unknown".to_string(),
            client_name: "Unknown device".to_string(),
            foreground: false,
        }
    }
}

impl ClientConnectionMetadata {
    pub(super) fn from_request(query: &RpcQuery, headers: &HeaderMap) -> Self {
        let client_type =
            client_metadata_header(headers, CLIENT_TYPE_HEADER).or(query.client_type.as_deref());
        let client_name =
            client_metadata_header(headers, CLIENT_NAME_HEADER).or(query.client_name.as_deref());
        let client_type = sanitize_client_metadata(client_type, "unknown", 32);
        let foreground = client_metadata_header(headers, CLIENT_FOREGROUND_HEADER)
            .and_then(parse_client_foreground)
            .or(query.client_foreground)
            .unwrap_or(false);
        Self {
            foreground: client_type == MOBILE_CLIENT_TYPE && foreground,
            client_type,
            client_name: sanitize_client_metadata(client_name, "Unknown device", 64),
        }
    }
}

fn parse_client_foreground(value: &str) -> Option<bool> {
    match value.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn push_candidate_event_type(event: &CanonicalEvent) -> Option<&'static str> {
    match event {
        CanonicalEvent::RunFinished { .. } | CanonicalEvent::RunFailed { .. } => {
            Some("turn_completed")
        }
        CanonicalEvent::PermissionRequested { .. } => Some("approval_requested"),
        _ => None,
    }
}

fn client_metadata_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .map(HeaderValue::to_str)
        .and_then(Result::ok)
}

#[derive(Debug, Clone)]
pub(super) struct CanonicalHubEvent {
    pub(super) event_id: u64,
    pub(super) event: CanonicalEvent,
    pub(super) foreground_mobile_present: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MobilePresenceUpdate {
    Applied,
    Stale,
    NotMobile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PushObservationUpdate {
    Observed,
    UnknownCandidate,
    NotForeground,
    NotMobile,
}

struct PushObservation {
    observed: watch::Sender<bool>,
}

#[derive(Default)]
struct PushObservationTracker {
    entries: HashMap<u64, Arc<PushObservation>>,
    order: VecDeque<u64>,
}

pub(super) struct HubReplaySnapshot {
    pub(super) events: Vec<Value>,
    pub(super) has_more: bool,
    pub(super) returned_bytes: usize,
    pub(super) earliest_event_id: Option<u64>,
    pub(super) latest_event_id: u64,
}

impl ClientHub {
    pub(super) fn new() -> Self {
        Self::with_replay_capacity(NOTIFICATION_REPLAY_BUFFER_SIZE)
    }

    pub(super) fn with_replay_capacity(replay_capacity: usize) -> Self {
        Self {
            next_client_id: AtomicU64::new(1),
            next_event_id: AtomicU64::new(1),
            next_canonical_event_id: AtomicU64::new(1),
            stream_id: Uuid::new_v4().to_string(),
            clients: RwLock::new(HashMap::new()),
            client_infos: RwLock::new(HashMap::new()),
            notification_replay: NotificationReplay::new(replay_capacity, REPLAY_MAX_BYTES),
            canonical_subscribers: std::sync::Mutex::new(Vec::new()),
            client_queue_drops: AtomicU64::new(0),
            canonical_emit_lock: Mutex::new(()),
            notification_publish_lock: Mutex::new(()),
            latest_published_event_id: AtomicU64::new(0),
            ag_ui_projector: Mutex::new(AgUiProjector::default()),
            push_observations: Mutex::new(PushObservationTracker::default()),
            #[cfg(test)]
            notification_serializations: AtomicU64::new(0),
        }
    }

    pub(super) fn subscribe_canonical_events(&self) -> mpsc::Receiver<CanonicalHubEvent> {
        let (sender, receiver) = mpsc::channel(INTERNAL_NOTIFICATION_CHANNEL_CAPACITY);
        self.canonical_subscribers
            .lock()
            .expect("canonical subscriber lock")
            .push(sender);
        receiver
    }

    pub(super) fn stream_id(&self) -> &str {
        &self.stream_id
    }

    pub(super) fn connection_state_payload(&self) -> Value {
        json!({
            "method": "bridge/connection/state",
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "streamId": self.stream_id,
            "params": {
                "status": "connected",
                "at": now_iso(),
            }
        })
    }

    pub(super) async fn add_client_with_metadata(
        &self,
        outbox: ClientOutbox,
        metadata: ClientConnectionMetadata,
    ) -> u64 {
        let id = self.next_client_id.fetch_add(1, Ordering::Relaxed);
        let now = now_iso();
        let foreground_updated_at = Instant::now();
        self.clients.write().await.insert(id, outbox);
        self.client_infos.write().await.insert(
            id,
            BridgeDeviceConnection {
                client_id: id,
                foreground: metadata.client_type == MOBILE_CLIENT_TYPE && metadata.foreground,
                client_type: metadata.client_type,
                client_name: metadata.client_name,
                connected_at: now.clone(),
                last_seen_at: now,
                foreground_sequence: 0,
                foreground_updated_at,
            },
        );
        id
    }

    pub(super) async fn remove_client(&self, client_id: u64) {
        self.disconnect_client(client_id, false).await;
    }

    pub(super) async fn disconnect_saturated_client(&self, client_id: u64) {
        self.disconnect_client(client_id, true).await;
    }

    async fn disconnect_client(&self, client_id: u64, queue_drop: bool) {
        let outbox = self.clients.write().await.remove(&client_id);
        if let Some(outbox) = outbox {
            if queue_drop {
                self.client_queue_drops.fetch_add(1, Ordering::Relaxed);
            }
            outbox.disconnect();
        }
        self.client_infos.write().await.remove(&client_id);
    }

    pub(super) async fn mark_client_seen(&self, client_id: u64) {
        let mut clients = self.client_infos.write().await;
        if let Some(client) = clients.get_mut(&client_id) {
            client.last_seen_at = now_iso();
        }
    }

    pub(super) async fn client_connections(&self) -> Vec<BridgeDeviceConnection> {
        let mut clients = self
            .client_infos
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        clients.sort_by_key(|client| client.client_id);
        clients
    }

    pub(super) async fn set_mobile_client_foreground(
        &self,
        client_id: u64,
        foreground: bool,
        sequence: u64,
    ) -> MobilePresenceUpdate {
        let mut clients = self.client_infos.write().await;
        let Some(client) = clients
            .get_mut(&client_id)
            .filter(|client| client.client_type == MOBILE_CLIENT_TYPE)
        else {
            return MobilePresenceUpdate::NotMobile;
        };
        if sequence <= client.foreground_sequence {
            return MobilePresenceUpdate::Stale;
        }
        client.foreground = foreground;
        client.foreground_sequence = sequence;
        client.foreground_updated_at = Instant::now();
        MobilePresenceUpdate::Applied
    }

    pub(super) async fn has_foreground_mobile_client(&self) -> bool {
        let now = Instant::now();
        self.client_infos.read().await.values().any(|client| {
            client.client_type == MOBILE_CLIENT_TYPE
                && client.foreground
                && now.duration_since(client.foreground_updated_at)
                    < MOBILE_FOREGROUND_LEASE_TIMEOUT
        })
    }

    async fn prepare_push_observation(&self, candidate_id: u64) {
        let mut tracker = self.push_observations.lock().await;
        if tracker.entries.contains_key(&candidate_id) {
            return;
        }
        while tracker.entries.len() >= PUSH_OBSERVATION_LIMIT {
            let Some(oldest) = tracker.order.pop_front() else {
                break;
            };
            tracker.entries.remove(&oldest);
        }
        tracker.order.push_back(candidate_id);
        tracker.entries.insert(
            candidate_id,
            Arc::new(PushObservation {
                observed: watch::channel(false).0,
            }),
        );
    }

    pub(super) async fn observe_push_candidate(
        &self,
        client_id: u64,
        candidate_id: u64,
        presence_sequence: u64,
    ) -> PushObservationUpdate {
        {
            let clients = self.client_infos.read().await;
            let Some(client) = clients.get(&client_id) else {
                return PushObservationUpdate::NotMobile;
            };
            if client.client_type != MOBILE_CLIENT_TYPE {
                return PushObservationUpdate::NotMobile;
            }
            if !client.foreground
                || client.foreground_sequence != presence_sequence
                || client.foreground_updated_at.elapsed() >= MOBILE_FOREGROUND_LEASE_TIMEOUT
            {
                return PushObservationUpdate::NotForeground;
            }
        }
        let observation = {
            let tracker = self.push_observations.lock().await;
            tracker.entries.get(&candidate_id).cloned()
        };
        let Some(observation) = observation else {
            return PushObservationUpdate::UnknownCandidate;
        };
        observation.observed.send_replace(true);
        PushObservationUpdate::Observed
    }

    pub(super) async fn take_push_observation(&self, candidate_id: u64, wait: Duration) -> bool {
        let observation = {
            let tracker = self.push_observations.lock().await;
            tracker.entries.get(&candidate_id).cloned()
        };
        let Some(observation) = observation else {
            return false;
        };
        let mut observed = observation.observed.subscribe();
        if !*observed.borrow() && !wait.is_zero() {
            let _ = timeout(wait, observed.changed()).await;
        }
        let observed = *observed.borrow_and_update();
        let mut tracker = self.push_observations.lock().await;
        tracker.entries.remove(&candidate_id);
        tracker.order.retain(|queued| *queued != candidate_id);
        observed
    }

    pub(super) async fn discard_push_observation(&self, candidate_id: u64) {
        let mut tracker = self.push_observations.lock().await;
        tracker.entries.remove(&candidate_id);
        tracker.order.retain(|queued| *queued != candidate_id);
    }

    pub(super) async fn send_json(&self, client_id: u64, value: Value) {
        let text = serde_json::to_string(&value).expect("JSON Value is serializable");

        let outbox = {
            let clients = self.clients.read().await;
            clients.get(&client_id).cloned()
        };
        let Some(outbox) = outbox else {
            return;
        };

        let message = Message::Text(text.into());
        let removal = match outbox.try_send(message) {
            Ok(()) => None,
            Err(mpsc::error::TrySendError::Closed(_)) => Some(false),
            Err(mpsc::error::TrySendError::Full(message)) => {
                match timeout(Duration::from_millis(250), outbox.send(message)).await {
                    Ok(Ok(())) => None,
                    Ok(Err(())) => Some(false),
                    Err(_) => Some(true),
                }
            }
        };

        if let Some(queue_drop) = removal {
            self.disconnect_client(client_id, queue_drop).await;
        }
    }

    #[cfg(test)]
    pub(super) async fn broadcast_json(&self, value: Value) {
        let message = Message::Text(self.serialize_notification(&value).into());
        self.broadcast_message(message).await;
    }

    async fn broadcast_message(&self, message: Message) {
        let mut stale_clients = Vec::new();
        {
            let clients = self.clients.read().await;
            for (client_id, outbox) in clients.iter() {
                match outbox.try_send(message.clone()) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        stale_clients.push((*client_id, false));
                    }
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        stale_clients.push((*client_id, true));
                    }
                }
            }
        }

        for (client_id, queue_drop) in stale_clients {
            self.disconnect_client(client_id, queue_drop).await;
        }
    }

    pub(super) async fn broadcast_notification(&self, method: &str, params: Value) {
        self.broadcast_external_notification(method, params).await;
    }

    pub(super) async fn broadcast_canonical_event(&self, event: &CanonicalEvent) {
        let _emit_guard = self.canonical_emit_lock.lock().await;
        let event_id = self.next_canonical_event_id.fetch_add(1, Ordering::Relaxed);
        let foreground_mobile_present = self.has_foreground_mobile_client().await;
        let canonical = CanonicalHubEvent {
            event_id,
            event: event.clone(),
            foreground_mobile_present,
        };
        let projection = self.ag_ui_projector.lock().await.project_canonical(event);
        let has_live_projection = !projection.events.is_empty() || !projection.controls.is_empty();
        for envelope in projection.events {
            let params = serde_json::to_value(envelope).unwrap_or(Value::Null);
            self.broadcast_external_notification(AG_UI_EVENT_METHOD, params)
                .await;
        }
        for (method, params) in projection.controls {
            self.broadcast_external_notification(method, params).await;
        }
        if let Some(event_type) = push_candidate_event_type(event) {
            if has_live_projection {
                self.prepare_push_observation(event_id).await;
                let after_event_id = self.latest_event_id();
                self.broadcast_ephemeral_notification(
                    PUSH_CANDIDATE_METHOD,
                    json!({
                        "candidateId": event_id.to_string(),
                        "event": event_type,
                        "afterEventId": after_event_id,
                    }),
                )
                .await;
            }
        }
        let subscribers = self
            .canonical_subscribers
            .lock()
            .expect("canonical subscriber lock")
            .clone();
        for subscriber in subscribers {
            let _ = subscriber.send(canonical.clone()).await;
        }
        self.canonical_subscribers
            .lock()
            .expect("canonical subscriber lock")
            .retain(|subscriber| !subscriber.is_closed());
    }

    pub(super) async fn broadcast_ag_ui_envelope(&self, envelope: AgUiEventEnvelope) {
        let params = serde_json::to_value(envelope).unwrap_or(Value::Null);
        self.broadcast_external_notification(AG_UI_EVENT_METHOD, params)
            .await;
    }

    /// Tells the projector which tool call a sub-agent belongs to, so its card can follow along.
    pub(super) async fn link_subagent(
        &self,
        parent_thread_id: &str,
        parent_run_id: &str,
        parent_source_turn_id: Option<String>,
        tool_call_id: &str,
        child_thread_id: &str,
    ) -> bool {
        let linked = self.ag_ui_projector.lock().await.link_subagent(
            parent_thread_id,
            parent_run_id,
            parent_source_turn_id.clone(),
            tool_call_id,
            child_thread_id,
        );
        if linked {
            self.broadcast_ag_ui_envelope(crate::agui::linked_subagent_activity_envelope(
                parent_thread_id,
                parent_run_id,
                parent_source_turn_id,
                tool_call_id,
                child_thread_id,
            ))
            .await;
        }
        linked
    }

    async fn broadcast_external_notification(&self, method: &str, params: Value) -> u64 {
        let publish_guard = self.notification_publish_lock.lock().await;
        let event_id = self.next_event_id.fetch_add(1, Ordering::Relaxed);
        let mut payload = json!({
            "method": method,
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "streamId": self.stream_id,
            "eventId": event_id,
            "params": params
        });
        let mut serialized = self.serialize_notification(&payload);
        let mut payload_bytes = serialized.len();
        if payload_bytes > NOTIFICATION_MAX_BYTES {
            payload = json!({
                "method": "bridge/notification.truncated",
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                "streamId": self.stream_id,
                "eventId": event_id,
                "params": {
                    "originalMethod": method,
                    "truncated": true,
                    "originalBytes": payload_bytes,
                    "maxBytes": NOTIFICATION_MAX_BYTES,
                }
            });
            serialized = self.serialize_notification(&payload);
            payload_bytes = serialized.len();
        }
        let message = Message::Text(serialized.into());
        self.notification_replay
            .push(event_id, message.clone(), payload_bytes)
            .await;
        self.latest_published_event_id
            .store(event_id, Ordering::Release);
        drop(publish_guard);
        self.broadcast_message(message).await;
        event_id
    }

    async fn broadcast_ephemeral_notification(&self, method: &str, params: Value) {
        let payload = json!({
            "method": method,
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "streamId": self.stream_id,
            "params": params,
        });
        let message = Message::Text(self.serialize_notification(&payload).into());
        self.broadcast_message(message).await;
    }

    fn serialize_notification(&self, payload: &Value) -> String {
        #[cfg(test)]
        self.notification_serializations
            .fetch_add(1, Ordering::Relaxed);
        serde_json::to_string(payload).expect("JSON Value is serializable")
    }

    pub(super) async fn replay_snapshot(
        &self,
        after_event_id: Option<u64>,
        limit: usize,
    ) -> HubReplaySnapshot {
        let _publish_guard = self.notification_publish_lock.lock().await;
        let (events, has_more, returned_bytes) = self
            .notification_replay
            .since(after_event_id, limit, REPLAY_RESPONSE_MAX_BYTES)
            .await;
        HubReplaySnapshot {
            events,
            has_more,
            returned_bytes,
            earliest_event_id: self.notification_replay.earliest_event_id().await,
            latest_event_id: self.latest_event_id(),
        }
    }

    #[cfg(test)]
    pub(super) async fn replay_since(
        &self,
        after_event_id: Option<u64>,
        limit: usize,
    ) -> (Vec<Value>, bool, usize) {
        self.notification_replay
            .since(after_event_id, limit, REPLAY_RESPONSE_MAX_BYTES)
            .await
    }

    pub(super) fn latest_event_id(&self) -> u64 {
        self.latest_published_event_id.load(Ordering::Acquire)
    }

    pub(super) async fn replay_status(&self) -> replay::ReplayStatus {
        self.notification_replay
            .status(self.client_queue_drops.load(Ordering::Relaxed))
            .await
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "client_hub_tests.rs"]
mod canonical_mailbox_tests;
