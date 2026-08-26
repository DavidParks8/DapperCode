use crate::acp::events::CanonicalEvent;
use crate::*;

pub(super) const CLIENT_TYPE_HEADER: &str = "x-dappercode-client-type";
pub(super) const CLIENT_NAME_HEADER: &str = "x-dappercode-client-name";
pub(super) const CLIENT_FOREGROUND_HEADER: &str = "x-dappercode-client-foreground";
pub(super) const MOBILE_CLIENT_TYPE: &str = "mobile";
pub(super) const MOBILE_FOREGROUND_LEASE_TIMEOUT: Duration = Duration::from_secs(30);
const PUSH_OBSERVATION_LIMIT: usize = 1_024;
const PUSH_CANDIDATE_METHOD: &str = "bridge/push/candidate";

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
    headers.get(name).and_then(|value| value.to_str().ok())
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
mod canonical_mailbox_tests {
    use super::*;

    #[test]
    fn client_metadata_accepts_query_values_and_prefers_forwarded_headers() {
        let query = RpcQuery {
            token: None,
            client_type: Some("mobile".to_string()),
            client_name: Some("Query phone".to_string()),
            client_foreground: Some(true),
        };
        let query_metadata = ClientConnectionMetadata::from_request(&query, &HeaderMap::new());
        assert_eq!(query_metadata.client_type, "mobile");
        assert_eq!(query_metadata.client_name, "Query phone");
        assert!(query_metadata.foreground);

        let mut headers = HeaderMap::new();
        headers.insert(
            CLIENT_TYPE_HEADER,
            HeaderValue::from_static("desktop-monitor"),
        );
        headers.insert(
            CLIENT_NAME_HEADER,
            HeaderValue::from_static("Broker client"),
        );
        headers.insert(CLIENT_FOREGROUND_HEADER, HeaderValue::from_static("true"));
        let forwarded_metadata = ClientConnectionMetadata::from_request(&query, &headers);
        assert_eq!(forwarded_metadata.client_type, "desktop-monitor");
        assert_eq!(forwarded_metadata.client_name, "Broker client");
        assert!(!forwarded_metadata.foreground);
    }

    #[tokio::test]
    async fn foreground_mobile_presence_is_explicit_and_removed_with_the_connection() {
        let hub = ClientHub::new();
        let (sender, _receiver) = client_outbox(1);
        let client_id = hub
            .add_client_with_metadata(
                sender,
                ClientConnectionMetadata {
                    client_type: "mobile".to_string(),
                    client_name: "Phone".to_string(),
                    foreground: false,
                },
            )
            .await;
        assert!(!hub.has_foreground_mobile_client().await);
        assert_eq!(
            hub.set_mobile_client_foreground(client_id, true, 1).await,
            MobilePresenceUpdate::Applied
        );
        assert!(hub.has_foreground_mobile_client().await);
        assert_eq!(
            hub.set_mobile_client_foreground(client_id, false, 1).await,
            MobilePresenceUpdate::Stale
        );
        assert!(hub.has_foreground_mobile_client().await);
        assert_eq!(
            hub.set_mobile_client_foreground(client_id, false, 2).await,
            MobilePresenceUpdate::Applied
        );
        assert!(!hub.has_foreground_mobile_client().await);

        hub.remove_client(client_id).await;
        assert_eq!(
            hub.set_mobile_client_foreground(client_id, true, 3).await,
            MobilePresenceUpdate::NotMobile
        );
        assert!(!hub.has_foreground_mobile_client().await);

        let (desktop_sender, _desktop_receiver) = client_outbox(1);
        let desktop_id = hub
            .add_client_with_metadata(
                desktop_sender,
                ClientConnectionMetadata {
                    client_type: "desktop-monitor".to_string(),
                    client_name: "Desktop".to_string(),
                    foreground: false,
                },
            )
            .await;
        assert_eq!(
            hub.set_mobile_client_foreground(desktop_id, true, 1).await,
            MobilePresenceUpdate::NotMobile
        );
        assert!(!hub.has_foreground_mobile_client().await);
    }

    #[tokio::test]
    async fn canonical_events_snapshot_leased_foreground_presence_at_emit_time() {
        let hub = ClientHub::new();
        let mut events = hub.subscribe_canonical_events();
        let (sender, _receiver) = client_outbox(1);
        let client_id = hub
            .add_client_with_metadata(
                sender,
                ClientConnectionMetadata {
                    client_type: MOBILE_CLIENT_TYPE.to_string(),
                    client_name: "Phone".to_string(),
                    foreground: true,
                },
            )
            .await;

        hub.broadcast_canonical_event(&CanonicalEvent::Ignored {
            agent_id: "agent".into(),
            thread_id: None,
            kind: "foreground".into(),
        })
        .await;
        assert!(events.recv().await.unwrap().foreground_mobile_present);

        assert_eq!(
            hub.set_mobile_client_foreground(client_id, false, 1).await,
            MobilePresenceUpdate::Applied
        );
        hub.broadcast_canonical_event(&CanonicalEvent::Ignored {
            agent_id: "agent".into(),
            thread_id: None,
            kind: "background".into(),
        })
        .await;
        assert!(!events.recv().await.unwrap().foreground_mobile_present);

        {
            let mut clients = hub.client_infos.write().await;
            let client = clients.get_mut(&client_id).unwrap();
            client.foreground = true;
            client.foreground_updated_at = Instant::now() - MOBILE_FOREGROUND_LEASE_TIMEOUT;
        }
        assert!(!hub.has_foreground_mobile_client().await);
    }

    #[tokio::test]
    async fn push_candidate_requires_a_live_projection_to_observe() {
        let hub = ClientHub::new();
        let mut canonical_events = hub.subscribe_canonical_events();
        let (sender, mut client_messages) = client_outbox(16);
        hub.add_client_with_metadata(
            sender,
            ClientConnectionMetadata {
                client_type: MOBILE_CLIENT_TYPE.to_string(),
                client_name: "Phone".to_string(),
                foreground: true,
            },
        )
        .await;

        hub.broadcast_canonical_event(&CanonicalEvent::RunFinished {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            run_id: "run".into(),
            source_turn_id: "turn".into(),
            generation: 1,
            stop_reason: agent_client_protocol::schema::v1::StopReason::EndTurn,
        })
        .await;
        let event = canonical_events.recv().await.unwrap();

        while let Ok(Message::Text(text)) = client_messages.try_recv() {
            let payload: Value = serde_json::from_str(&text).unwrap();
            assert_ne!(payload["method"], PUSH_CANDIDATE_METHOD);
        }
        assert!(
            !hub.take_push_observation(event.event_id, Duration::ZERO)
                .await
        );
    }

    #[tokio::test]
    async fn push_observation_requires_matching_leased_foreground_presence() {
        let hub = ClientHub::new();
        let mut canonical_events = hub.subscribe_canonical_events();
        let (sender, mut client_messages) = client_outbox(16);
        let client_id = hub
            .add_client_with_metadata(
                sender,
                ClientConnectionMetadata {
                    client_type: MOBILE_CLIENT_TYPE.to_string(),
                    client_name: "Phone".to_string(),
                    foreground: true,
                },
            )
            .await;

        hub.broadcast_canonical_event(&CanonicalEvent::RunStarted {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            run_id: "run".into(),
            source_turn_id: "turn".into(),
            generation: 1,
        })
        .await;
        canonical_events.recv().await.unwrap();
        while client_messages.try_recv().is_ok() {}

        hub.broadcast_canonical_event(&CanonicalEvent::RunFinished {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            run_id: "run".into(),
            source_turn_id: "turn".into(),
            generation: 1,
            stop_reason: agent_client_protocol::schema::v1::StopReason::EndTurn,
        })
        .await;
        let event = canonical_events.recv().await.unwrap();
        let candidate_id = event.event_id;
        let (candidate, latest_numbered_event_id) =
            tokio::time::timeout(Duration::from_secs(1), async {
                let mut latest_numbered_event_id = 0;
                loop {
                    let message = client_messages.recv().await.unwrap();
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let payload: Value = serde_json::from_str(&text).unwrap();
                    if payload["method"] == PUSH_CANDIDATE_METHOD {
                        break (payload, latest_numbered_event_id);
                    }
                    if let Some(event_id) = payload["eventId"].as_u64() {
                        latest_numbered_event_id = latest_numbered_event_id.max(event_id);
                    }
                }
            })
            .await
            .unwrap();
        assert_eq!(candidate["params"]["candidateId"], candidate_id.to_string());
        assert!(latest_numbered_event_id > 0);
        assert_eq!(
            candidate["params"]["afterEventId"],
            latest_numbered_event_id
        );
        assert_eq!(
            hub.observe_push_candidate(client_id, candidate_id, 0).await,
            PushObservationUpdate::Observed
        );
        assert!(
            hub.take_push_observation(candidate_id, Duration::ZERO)
                .await
        );
        assert_eq!(
            hub.observe_push_candidate(client_id, candidate_id, 0).await,
            PushObservationUpdate::UnknownCandidate
        );

        hub.prepare_push_observation(98).await;
        assert_eq!(
            hub.set_mobile_client_foreground(client_id, true, 1).await,
            MobilePresenceUpdate::Applied
        );
        assert_eq!(
            hub.observe_push_candidate(client_id, 98, 0).await,
            PushObservationUpdate::NotForeground
        );
        assert_eq!(
            hub.observe_push_candidate(client_id, 98, 1).await,
            PushObservationUpdate::Observed
        );
        hub.discard_push_observation(98).await;

        hub.prepare_push_observation(99).await;
        assert_eq!(
            hub.set_mobile_client_foreground(client_id, false, 2).await,
            MobilePresenceUpdate::Applied
        );
        assert_eq!(
            hub.observe_push_candidate(client_id, 99, 2).await,
            PushObservationUpdate::NotForeground
        );
        assert!(!hub.take_push_observation(99, Duration::ZERO).await);
    }

    #[tokio::test]
    async fn hub_mailbox_backpressures_and_preserves_run_finished_order() {
        let hub = Arc::new(ClientHub::new());
        let mut events = hub.subscribe_canonical_events();
        for index in 0..INTERNAL_NOTIFICATION_CHANNEL_CAPACITY {
            hub.broadcast_canonical_event(&CanonicalEvent::Ignored {
                agent_id: "agent".into(),
                thread_id: Some("thread".into()),
                kind: format!("filler-{index}"),
            })
            .await;
        }
        let producer = {
            let hub = Arc::clone(&hub);
            tokio::spawn(async move {
                hub.broadcast_canonical_event(&CanonicalEvent::RunFinished {
                    agent_id: "agent".into(),
                    thread_id: "thread".into(),
                    run_id: "run".into(),
                    source_turn_id: "turn".into(),
                    generation: 1,
                    stop_reason: agent_client_protocol::schema::v1::StopReason::EndTurn,
                })
                .await;
            })
        };
        tokio::task::yield_now().await;
        assert!(!producer.is_finished());
        for index in 0..INTERNAL_NOTIFICATION_CHANNEL_CAPACITY {
            let event = events.recv().await.expect("canonical event");
            assert_eq!(event.event_id, index as u64 + 1);
            assert!(matches!(
                event.event,
                CanonicalEvent::Ignored { kind, .. } if kind == format!("filler-{index}")
            ));
        }
        producer.await.expect("terminal producer");
        let terminal = events.recv().await.expect("terminal event");
        assert_eq!(
            terminal.event_id,
            INTERNAL_NOTIFICATION_CHANNEL_CAPACITY as u64 + 1
        );
        assert!(matches!(terminal.event, CanonicalEvent::RunFinished { .. }));
    }

    #[tokio::test]
    async fn hub_removes_closed_canonical_subscriber() {
        let hub = ClientHub::new();
        let receiver = hub.subscribe_canonical_events();
        drop(receiver);
        hub.broadcast_canonical_event(&CanonicalEvent::Ignored {
            agent_id: "agent".into(),
            thread_id: None,
            kind: "closed".into(),
        })
        .await;
        assert!(hub
            .canonical_subscribers
            .lock()
            .expect("subscriber lock")
            .is_empty());
    }

    #[tokio::test]
    async fn canonical_backpressure_does_not_block_notifications_or_replay() {
        let hub = Arc::new(ClientHub::new());
        let mut events = hub.subscribe_canonical_events();
        for index in 0..INTERNAL_NOTIFICATION_CHANNEL_CAPACITY {
            hub.broadcast_canonical_event(&CanonicalEvent::Ignored {
                agent_id: "agent".into(),
                thread_id: Some("thread".into()),
                kind: format!("filler-{index}"),
            })
            .await;
        }
        let blocked = {
            let hub = Arc::clone(&hub);
            tokio::spawn(async move {
                hub.broadcast_canonical_event(&CanonicalEvent::RunFinished {
                    agent_id: "agent".into(),
                    thread_id: "thread".into(),
                    run_id: "run".into(),
                    source_turn_id: "turn".into(),
                    generation: 1,
                    stop_reason: agent_client_protocol::schema::v1::StopReason::EndTurn,
                })
                .await;
            })
        };
        tokio::task::yield_now().await;
        assert!(!blocked.is_finished());

        timeout(
            Duration::from_millis(100),
            hub.broadcast_notification("bridge/test", json!({"ready": true})),
        )
        .await
        .expect("canonical mailbox backpressure must not block client notifications");
        let replay = timeout(Duration::from_millis(100), hub.replay_snapshot(None, 8))
            .await
            .expect("canonical mailbox backpressure must not block replay reads");
        assert_eq!(replay.events[0]["method"], "bridge/test");

        for _ in 0..INTERNAL_NOTIFICATION_CHANNEL_CAPACITY {
            events.recv().await.expect("queued canonical event");
        }
        blocked.await.expect("blocked canonical producer");
    }

    #[tokio::test]
    async fn notification_is_serialized_once_for_replay_and_all_clients() {
        let hub = ClientHub::new();
        let (first_sender, mut first_receiver) = client_outbox(1);
        let (second_sender, mut second_receiver) = client_outbox(1);
        hub.add_client_with_metadata(first_sender, ClientConnectionMetadata::default())
            .await;
        hub.add_client_with_metadata(second_sender, ClientConnectionMetadata::default())
            .await;

        hub.broadcast_notification("bridge/test", json!({"value": 7}))
            .await;

        assert_eq!(hub.notification_serializations.load(Ordering::Relaxed), 1);
        let first = first_receiver.recv().await.expect("first client message");
        let second = second_receiver.recv().await.expect("second client message");
        assert_eq!(first, second);
        let replay = hub.replay_snapshot(None, 8).await;
        assert_eq!(replay.events[0]["params"]["value"], 7);
    }

    #[tokio::test]
    async fn saturated_client_is_evicted_without_affecting_healthy_delivery_or_replay() {
        let hub = ClientHub::new();
        let (stalled_sender, _stalled_receiver) = client_outbox(WS_CLIENT_QUEUE_CAPACITY);
        let stalled_signal = stalled_sender.clone();
        let stalled_id = hub
            .add_client_with_metadata(stalled_sender, ClientConnectionMetadata::default())
            .await;
        let (healthy_sender, mut healthy_receiver) = client_outbox(WS_CLIENT_QUEUE_CAPACITY);
        let healthy_signal = healthy_sender.clone();
        let healthy_id = hub
            .add_client_with_metadata(healthy_sender, ClientConnectionMetadata::default())
            .await;
        let mut healthy_event_ids = Vec::new();

        for index in 0..=WS_CLIENT_QUEUE_CAPACITY {
            let terminal = index == WS_CLIENT_QUEUE_CAPACITY;
            hub.broadcast_notification(
                "bridge/test",
                json!({
                    "index": index,
                    "terminal": terminal,
                }),
            )
            .await;
            let message = timeout(Duration::from_millis(100), healthy_receiver.recv())
                .await
                .expect("healthy client receives promptly")
                .expect("healthy client remains connected");
            let Message::Text(text) = message else {
                panic!("test notification must be text");
            };
            let payload: Value = serde_json::from_str(&text).expect("notification JSON");
            healthy_event_ids.push(payload["eventId"].as_u64().expect("numbered event"));
        }

        assert!(!hub.clients.read().await.contains_key(&stalled_id));
        assert!(!hub.client_infos.read().await.contains_key(&stalled_id));
        assert!(stalled_signal.is_disconnected());
        assert!(hub.clients.read().await.contains_key(&healthy_id));
        assert!(!healthy_signal.is_disconnected());
        assert_eq!(
            hub.client_queue_drops.load(Ordering::Relaxed),
            1,
            "one saturated live delivery should force one reconnect"
        );

        let (replacement_sender, _replacement_receiver) = client_outbox(WS_CLIENT_QUEUE_CAPACITY);
        hub.add_client_with_metadata(replacement_sender, ClientConnectionMetadata::default())
            .await;
        let replay = hub
            .replay_snapshot(None, WS_CLIENT_QUEUE_CAPACITY + 1)
            .await;
        let replay_event_ids = replay
            .events
            .iter()
            .map(|event| event["eventId"].as_u64().expect("replay event id"))
            .collect::<Vec<_>>();

        assert_eq!(healthy_event_ids, replay_event_ids);
        assert_eq!(replay.events.last().unwrap()["params"]["terminal"], true);
        assert!(!replay.has_more);
    }

    #[tokio::test]
    async fn timed_out_direct_send_disconnects_the_client_and_wakes_its_outbox() {
        let hub = ClientHub::new();
        let (outbox, _receiver) = client_outbox(1);
        let disconnect_signal = outbox.clone();
        let client_id = hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        hub.send_json(client_id, json!({"first": true})).await;

        hub.send_json(client_id, json!({"blocked": true})).await;

        assert!(!hub.clients.read().await.contains_key(&client_id));
        assert!(!hub.client_infos.read().await.contains_key(&client_id));
        assert!(disconnect_signal.is_disconnected());
        assert_eq!(hub.client_queue_drops.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn replay_snapshot_waits_for_an_in_flight_publication() {
        let hub = Arc::new(ClientHub::new());
        let publish_guard = hub.notification_publish_lock.lock().await;
        let replay = {
            let hub = Arc::clone(&hub);
            tokio::spawn(async move { hub.replay_snapshot(None, 8).await })
        };
        tokio::task::yield_now().await;
        assert!(!replay.is_finished());

        drop(publish_guard);
        timeout(Duration::from_millis(100), replay)
            .await
            .expect("replay should resume after publication")
            .expect("replay task");
    }

    #[tokio::test]
    async fn hub_client_and_replay_paths_cover_presence_close_and_truncation() {
        let hub = ClientHub::with_replay_capacity(4);
        let (sender, mut receiver) = client_outbox(1);
        let client_id = hub
            .add_client_with_metadata(sender, ClientConnectionMetadata::default())
            .await;
        hub.mark_client_seen(client_id).await;
        hub.mark_client_seen(client_id + 1).await;
        assert_eq!(hub.client_connections().await.len(), 1);

        hub.send_json(client_id, json!({"ok": true})).await;
        assert!(receiver.recv().await.is_some());
        drop(receiver);
        hub.send_json(client_id, json!({"closed": true})).await;
        assert!(hub.client_connections().await.is_empty());
        hub.send_json(client_id, json!({"missing": true})).await;
        hub.remove_client(client_id + 1).await;

        let (full_sender, _full_receiver) = client_outbox(1);
        let full_id = hub
            .add_client_with_metadata(full_sender, ClientConnectionMetadata::default())
            .await;
        hub.send_json(full_id, json!({"first": true})).await;
        hub.broadcast_json(json!({"dropped": true})).await;
        assert_eq!(hub.client_queue_drops.load(Ordering::Relaxed), 1);

        hub.send_json(full_id, json!({"timeout": true})).await;
        assert!(!hub.clients.read().await.contains_key(&full_id));

        let (closed_sender, closed_receiver) = client_outbox(1);
        let closed_id = hub
            .add_client_with_metadata(closed_sender, ClientConnectionMetadata::default())
            .await;
        drop(closed_receiver);
        hub.broadcast_json(json!({"closed": true})).await;
        assert!(!hub.clients.read().await.contains_key(&closed_id));
        assert!(!hub.client_infos.read().await.contains_key(&closed_id));

        hub.broadcast_notification(
            "bridge/test",
            json!({"large": "x".repeat(NOTIFICATION_MAX_BYTES)}),
        )
        .await;
        let (events, _, _) = hub.replay_since(None, 4).await;
        assert_eq!(events[0]["method"], "bridge/notification.truncated");
        let status = hub.replay_status().await;
        assert_eq!(status.latest_event_id, Some(1));
    }
}
