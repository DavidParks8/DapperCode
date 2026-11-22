use super::{
    client_outbox, json, timeout, Arc, CanonicalEvent, ClientConnectionMetadata, ClientHub,
    Duration, HeaderMap, HeaderValue, Instant, Message, MobilePresenceUpdate, Ordering,
    PushObservationUpdate, RpcQuery, Value, CLIENT_FOREGROUND_HEADER, CLIENT_NAME_HEADER,
    CLIENT_TYPE_HEADER, INTERNAL_NOTIFICATION_CHANNEL_CAPACITY, MOBILE_CLIENT_TYPE,
    MOBILE_FOREGROUND_LEASE_TIMEOUT, NOTIFICATION_MAX_BYTES, PUSH_CANDIDATE_METHOD,
    WS_CLIENT_QUEUE_CAPACITY,
};

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
        MobilePresenceUpdate::Applied,
    );
    assert!(hub.has_foreground_mobile_client().await);
    assert_eq!(
        hub.set_mobile_client_foreground(client_id, false, 1).await,
        MobilePresenceUpdate::Stale,
    );
    assert!(hub.has_foreground_mobile_client().await);
    assert_eq!(
        hub.set_mobile_client_foreground(client_id, false, 2).await,
        MobilePresenceUpdate::Applied,
    );
    assert!(!hub.has_foreground_mobile_client().await);

    hub.remove_client(client_id).await;
    assert_eq!(
        hub.set_mobile_client_foreground(client_id, true, 3).await,
        MobilePresenceUpdate::NotMobile,
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
        MobilePresenceUpdate::NotMobile,
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
        MobilePresenceUpdate::Applied,
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
        client.foreground_updated_at = Instant::now()
            .checked_sub(MOBILE_FOREGROUND_LEASE_TIMEOUT)
            .expect("test clock must accommodate the foreground lease");
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
        stop_reason: agent_client_protocol::v1::schema::StopReason::EndTurn,
    })
    .await;
    let event = canonical_events.recv().await.unwrap();

    while let Ok(Message::Text(text)) = client_messages.try_recv() {
        let payload: Value = serde_json::from_str(&text).unwrap();
        assert_ne!(payload["method"], PUSH_CANDIDATE_METHOD);
    }
    assert!(
        !hub.take_push_observation(event.event_id, Duration::ZERO)
            .await,
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
        stop_reason: agent_client_protocol::v1::schema::StopReason::EndTurn,
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
        latest_numbered_event_id,
    );
    assert_eq!(
        hub.observe_push_candidate(client_id, candidate_id, 0).await,
        PushObservationUpdate::Observed,
    );
    assert!(
        hub.take_push_observation(candidate_id, Duration::ZERO)
            .await,
    );
    assert_eq!(
        hub.observe_push_candidate(client_id, candidate_id, 0).await,
        PushObservationUpdate::UnknownCandidate,
    );

    hub.prepare_push_observation(98).await;
    assert_eq!(
        hub.set_mobile_client_foreground(client_id, true, 1).await,
        MobilePresenceUpdate::Applied,
    );
    assert_eq!(
        hub.observe_push_candidate(client_id, 98, 0).await,
        PushObservationUpdate::NotForeground,
    );
    assert_eq!(
        hub.observe_push_candidate(client_id, 98, 1).await,
        PushObservationUpdate::Observed,
    );
    hub.discard_push_observation(98).await;

    hub.prepare_push_observation(99).await;
    assert_eq!(
        hub.set_mobile_client_foreground(client_id, false, 2).await,
        MobilePresenceUpdate::Applied,
    );
    assert_eq!(
        hub.observe_push_candidate(client_id, 99, 2).await,
        PushObservationUpdate::NotForeground,
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
                stop_reason: agent_client_protocol::v1::schema::StopReason::EndTurn,
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
        INTERNAL_NOTIFICATION_CHANNEL_CAPACITY as u64 + 1,
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
                stop_reason: agent_client_protocol::v1::schema::StopReason::EndTurn,
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
        "one saturated live delivery should force one reconnect",
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
