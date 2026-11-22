use super::{
    AcpSession, AgentMessageChunkMatch, Arc, AtomicUsize, CanonicalEvent, GenerationState,
    MessageRole, ReconstructionError, RegistryEntry, SessionId, SessionNotification,
    SessionRegistry, SessionRouteError, PENDING_NOTIFICATION_CAPACITY,
};

#[derive(Clone)]
pub(crate) struct RegistrationBarrier {
    pub(super) reached: Arc<tokio::sync::Notify>,
    pub(super) release: Arc<tokio::sync::Notify>,
}

impl RegistrationBarrier {
    pub(crate) async fn wait_until_reached(&self) {
        self.reached.notified().await;
    }

    pub(crate) fn release(&self) {
        self.release.notify_one();
    }
}

fn notification(session_id: &str, message_id: &str) -> SessionNotification {
    SessionNotification::new(
        session_id.to_string(),
        serde_json::from_value(serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": "content"},
            "messageId": message_id
        }))
        .expect("valid notification"),
    )
}

#[tokio::test]
async fn session_lifecycle_rejects_invalid_transitions_and_exercises_idle_edges() {
    let session = AcpSession::new("agent".to_string(), "thread".to_string());
    assert_eq!(session.operation().await, None);
    assert_eq!(session.active_interaction_generation().await, None);
    assert_eq!(session.mark_cancelling().await, None);
    assert!(session.is_evictable().await);
    assert!(session
        .reserve_handoff("missing", "missing", 1)
        .await
        .is_err());
    assert!(session
        .admit_handoff("run".into(), "turn".into())
        .await
        .is_err());
    session.release_handoff().await;
    session.fail_active("nothing active".into()).await;

    let (generation, _) = session
        .admit_prompt("run".into(), "turn".into())
        .await
        .unwrap();
    assert_eq!(
        session.operation().await,
        Some(("run".into(), "turn".into(), generation)),
    );
    assert_eq!(
        session.active_interaction_generation().await,
        Some(generation),
    );
    assert!(!session.is_evictable().await);
    assert_eq!(session.mark_cancelling().await, Some(generation));
    assert_eq!(session.mark_cancelling().await, None);
    session.fail_active("cancelled".into()).await;
    assert_eq!(session.operation().await, None);
    assert!(session.is_evictable().await);

    assert_eq!(
        session
            .message_id_for_generation(MessageRole::User, Some("id".into()), None)
            .await,
        "id",
    );
    assert_eq!(
        session
            .message_id_for_generation(MessageRole::Agent, Some("id".into()), None)
            .await,
        "id::agent",
    );
    assert_eq!(
        session
            .message_id_for_generation(MessageRole::Thought, Some("id".into()), None)
            .await,
        "id::thought",
    );
    let first = session
        .message_id_for_generation(MessageRole::User, None, None)
        .await;
    assert_eq!(
        session
            .message_id_for_generation(MessageRole::User, None, None)
            .await,
        first,
    );
    assert_ne!(
        session
            .message_id_for_generation(MessageRole::Agent, None, None)
            .await,
        first,
    );

    assert!(matches!(
        session
            .classify_agent_message_chunk("ordinary", "ordinary text".into(), "thread")
            .await,
        AgentMessageChunkMatch::Ordinary(_)
    ));
    assert!(matches!(
        session
            .classify_agent_message_chunk("partial", "<".into(), "thread")
            .await,
        AgentMessageChunkMatch::Pending
    ));
    assert!(matches!(
        session
            .classify_agent_message_chunk("partial", "ordinary".into(), "thread")
            .await,
        AgentMessageChunkMatch::Ordinary(_)
    ));
    assert!(matches!(
        session
            .classify_agent_message_chunk("oversized", "x".repeat(64 * 1024 + 1), "thread")
            .await,
        AgentMessageChunkMatch::Ordinary(_)
    ));

    let envelope = crate::agent_messaging::AgentMessageEnvelope::new(
        "message".into(),
        "parent".into(),
        "other-thread".into(),
        crate::agent_messaging::AgentRelationKind::SubAgent,
        None,
        "body".into(),
    )
    .encode()
    .unwrap();
    assert!(matches!(
        session
            .classify_agent_message_chunk("wrong-recipient", envelope, "thread")
            .await,
        AgentMessageChunkMatch::Ordinary(_)
    ));

    let reconstruction = session.begin_reconstruction().await.unwrap();
    assert!(!session.is_evictable().await);
    reconstruction.finish(false).await;
    assert!(session.is_evictable().await);
}

#[tokio::test]
async fn reconstruction_and_history_seeding_cover_non_live_and_mailbox_edges() {
    let session = AcpSession::new("agent".to_string(), "thread".to_string());
    assert!(!session.seed_history(vec![]).await);

    let message = || CanonicalEvent::MessageChunk {
        agent_id: "agent".into(),
        thread_id: "thread".into(),
        run_id: None,
        source_turn_id: None,
        generation: None,
        role: MessageRole::User,
        message_id: "history-message".into(),
        content: "history".into(),
        content_block: None,
    };
    let reconstruction = session.begin_reconstruction().await.unwrap();
    assert!(session.seed_history(vec![message()]).await);
    reconstruction.finish(true).await;
    assert!(!session.seed_history(vec![message()]).await);

    {
        let mut state = session.inner.lock().await;
        state.notification_draining = true;
    }
    assert!(!session.is_evictable().await);
    {
        let mut state = session.inner.lock().await;
        state.notification_draining = false;
        state.snapshot.history_reconstruction = true;
        state.generation_state = GenerationState::Active(7);
    }
    assert_eq!(session.active_interaction_generation().await, None);
    assert!(!session.is_evictable().await);
    {
        let mut state = session.inner.lock().await;
        state.snapshot.history_reconstruction = false;
        state.generation_state = GenerationState::Terminal;
    }

    let malformed = format!(
        "{}{{not-json}}{}",
        "<<<dappercode.dev/agent-message:v1>>>\n", "\n<<<dappercode.dev/agent-message:end>>>",
    );
    assert!(matches!(
        session
            .classify_agent_message_chunk("complete-invalid", malformed, "thread")
            .await,
        AgentMessageChunkMatch::Ordinary(_)
    ));

    let session = AcpSession::new("agent".to_string(), "thread".to_string());
    drop(session.take_events().await);
    assert!(session.seed_history(vec![message()]).await);
}

#[tokio::test]
async fn prompt_transcript_preserves_an_existing_agent_message_disposition() {
    let session = AcpSession::new("agent".to_string(), "thread".to_string());
    let envelope = crate::agent_messaging::AgentMessageEnvelope::new(
        "message".to_string(),
        "parent".to_string(),
        "thread".to_string(),
        crate::agent_messaging::AgentRelationKind::SubAgent,
        Some("Parent".to_string()),
        "Please inspect the lifecycle.".to_string(),
    );
    session
        .emit(CanonicalEvent::AgentMessage {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            message: crate::agent_messaging::AgentMessageOrigin {
                message_id: "message".to_string(),
                direction: crate::agent_messaging::AgentMessageDirection::Received,
                related_thread_id: "parent".to_string(),
                related_title: Some("Parent".to_string()),
                relation: crate::agent_messaging::AgentRelationKind::Parent,
                disposition: crate::agent_messaging::AgentMessageDisposition::Steering,
                body: "Please inspect the lifecycle.".to_string(),
            },
        })
        .await;
    let prompt = vec![serde_json::from_value(serde_json::json!({
        "type": "text",
        "text": envelope.encode().expect("agent message envelope"),
    }))
    .expect("text content block")];

    session
        .emit_prompt_transcript(
            &prompt,
            Some("run".to_string()),
            Some("turn".to_string()),
            Some(1),
            "prompt-message".to_string(),
        )
        .await;

    let snapshot = session.snapshot().await;
    let activity = snapshot
        .messages
        .iter()
        .find(|message| message.id == "agent-message:message")
        .and_then(|message| message.agent_message.as_ref())
        .expect("agent message activity");
    assert_eq!(
        activity.disposition,
        crate::agent_messaging::AgentMessageDisposition::Steering,
    );
}

#[tokio::test]
async fn prompt_transcript_does_not_project_an_envelope_for_another_thread() {
    let session = AcpSession::new("agent".to_string(), "fork".to_string());
    let envelope = crate::agent_messaging::AgentMessageEnvelope::new(
        "message".to_string(),
        "parent".to_string(),
        "original-child".to_string(),
        crate::agent_messaging::AgentRelationKind::SubAgent,
        Some("Parent".to_string()),
        "Keep this bound to the original recipient.".to_string(),
    );
    let prompt = vec![serde_json::from_value(serde_json::json!({
        "type": "text",
        "text": envelope.encode().expect("agent message envelope"),
    }))
    .expect("text content block")];

    session
        .emit_prompt_transcript(
            &prompt,
            Some("run".to_string()),
            Some("turn".to_string()),
            Some(1),
            "prompt-message".to_string(),
        )
        .await;

    let snapshot = session.snapshot().await;
    assert_eq!(snapshot.messages.len(), 1);
    assert_eq!(snapshot.messages[0].id, "prompt-message");
    assert!(snapshot.messages[0].agent_message.is_none());
    assert!(snapshot.messages[0].parts[0]["text"]
        .as_str()
        .expect("ordinary prompt text")
        .contains("original-child"));
}

#[tokio::test]
async fn incomplete_reconstructed_envelope_prefix_keeps_its_original_message_order() {
    let session = AcpSession::new("agent".to_string(), "thread".to_string());
    let reconstruction = session.begin_reconstruction().await.unwrap();
    {
        let mut state = session.inner.lock().await;
        state.snapshot.append_message(
            "before".to_string(),
            MessageRole::User,
            "Before".to_string(),
            None,
        );
    }
    assert!(matches!(
        session
            .classify_agent_message_chunk("partial-prefix", "<<<".to_string(), "thread")
            .await,
        AgentMessageChunkMatch::Pending
    ));
    assert!(matches!(
        session
            .classify_agent_message_chunk("second-prefix", "<<".to_string(), "thread")
            .await,
        AgentMessageChunkMatch::Pending
    ));
    {
        let mut state = session.inner.lock().await;
        state.snapshot.append_message(
            "after".to_string(),
            MessageRole::Agent,
            "After".to_string(),
            None,
        );
    }
    reconstruction.finish(true).await;

    assert_eq!(
        session
            .snapshot()
            .await
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        ["before", "partial-prefix", "second-prefix", "after"],
    );
}

#[tokio::test]
async fn incomplete_reconstructed_prefixes_precede_later_content_on_an_empty_timeline() {
    let session = AcpSession::new("agent".to_string(), "thread".to_string());
    let reconstruction = session.begin_reconstruction().await.unwrap();
    for (message_id, content) in [("first-prefix", "<"), ("second-prefix", "<<")] {
        assert!(matches!(
            session
                .classify_agent_message_chunk(message_id, content.to_string(), "thread")
                .await,
            AgentMessageChunkMatch::Pending
        ));
    }
    {
        let mut state = session.inner.lock().await;
        state.snapshot.append_message(
            "after".to_string(),
            MessageRole::Agent,
            "After".to_string(),
            None,
        );
    }
    reconstruction.finish(true).await;

    assert_eq!(
        session
            .snapshot()
            .await
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        ["first-prefix", "second-prefix", "after"],
    );
}

#[tokio::test]
async fn empty_reconstruction_discards_pending_fragments_when_restoring_the_transcript() {
    let session = AcpSession::new("agent".to_string(), "thread".to_string());
    {
        let mut state = session.inner.lock().await;
        state.snapshot.append_message(
            "existing".to_string(),
            MessageRole::Agent,
            "Existing".to_string(),
            None,
        );
    }
    let reconstruction = session.begin_reconstruction().await.unwrap();
    assert!(matches!(
        session
            .classify_agent_message_chunk("partial-prefix", "<<<".to_string(), "thread")
            .await,
        AgentMessageChunkMatch::Pending
    ));
    reconstruction.finish(true).await;

    let snapshot = session.snapshot().await;
    assert_eq!(snapshot.messages.len(), 1);
    assert_eq!(snapshot.messages[0].id, "existing");
}

#[tokio::test]
async fn steer_handoff_blocks_admission_and_ignores_the_old_terminal_after_successor_start() {
    let session = AcpSession::new("agent".to_string(), "thread".to_string());
    let (old_generation, _) = session
        .admit_prompt("run".to_string(), "turn".to_string())
        .await
        .expect("old prompt admission");
    session
        .reserve_handoff("run", "turn", old_generation)
        .await
        .expect("handoff reservation");
    assert!(session
        .admit_prompt("other".to_string(), "other-turn".to_string())
        .await
        .is_err());

    session
        .emit(CanonicalEvent::RunFinished {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: "run".to_string(),
            source_turn_id: "turn".to_string(),
            generation: old_generation,
            stop_reason: agent_client_protocol::v1::schema::StopReason::Cancelled,
        })
        .await;
    let (successor_generation, _) = session
        .admit_handoff("run".to_string(), "turn".to_string())
        .await
        .expect("successor admission");
    assert_eq!(
        session.operation().await,
        Some(("run".to_string(), "turn".to_string(), successor_generation)),
    );

    session
        .emit(CanonicalEvent::RunFailed {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: "run".to_string(),
            source_turn_id: "turn".to_string(),
            generation: old_generation,
            message: "late old failure".to_string(),
        })
        .await;
    assert_eq!(
        session.operation().await,
        Some(("run".to_string(), "turn".to_string(), successor_generation)),
    );
}

#[tokio::test]
async fn steer_handoff_rejects_stale_targets_and_releases_each_reservation_state() {
    let session = AcpSession::new("agent".to_string(), "thread".to_string());
    assert!(session.reserve_handoff("run", "turn", 1).await.is_err());
    assert!(session
        .admit_handoff("run".to_string(), "turn".to_string())
        .await
        .is_err());
    session.release_handoff().await;

    let (generation, _) = session
        .admit_prompt("run".to_string(), "turn".to_string())
        .await
        .expect("prompt admission");
    assert!(session
        .reserve_handoff("other", "turn", generation)
        .await
        .is_err());
    assert!(session
        .reserve_handoff("run", "other", generation)
        .await
        .is_err());
    assert!(session
        .reserve_handoff("run", "turn", generation + 1)
        .await
        .is_err());

    session
        .reserve_handoff("run", "turn", generation)
        .await
        .expect("handoff reservation");
    assert!(session
        .reserve_handoff("run", "turn", generation)
        .await
        .is_err());
    session.release_handoff().await;
    assert_eq!(
        session.operation().await,
        Some(("run".to_string(), "turn".to_string(), generation)),
    );

    session
        .reserve_handoff("run", "turn", generation)
        .await
        .expect("second handoff reservation");
    session
        .emit(CanonicalEvent::RunFinished {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: "run".to_string(),
            source_turn_id: "turn".to_string(),
            generation,
            stop_reason: agent_client_protocol::v1::schema::StopReason::Cancelled,
        })
        .await;
    session.release_handoff().await;
    assert!(session
        .admit_prompt("replacement".to_string(), "replacement-turn".to_string())
        .await
        .is_ok());

    let closed = AcpSession::new("agent".to_string(), "closed".to_string());
    let generation = closed
        .admit_prompt("run".to_string(), "turn".to_string())
        .await
        .expect("closed prompt admission")
        .0;
    closed
        .reserve_handoff("run", "turn", generation)
        .await
        .expect("closed reservation");
    drop(closed.take_events().await.expect("event receiver"));
    assert!(closed
        .admit_handoff("run".to_string(), "turn".to_string())
        .await
        .is_ok());
}

#[tokio::test]
async fn session_tracks_prompt_reconstruction_messages_and_failure() {
    let session = AcpSession::new("agent".to_string(), "thread".to_string());
    assert_eq!(session.operation().await, None);
    session.fail_active("ignored".to_string()).await;

    let mut events = session.take_events().await.expect("event receiver");
    let reconstruction = session.begin_reconstruction().await.unwrap();
    session
        .emit(CanonicalEvent::Ignored {
            agent_id: "agent".to_string(),
            thread_id: Some("thread".to_string()),
            kind: "history".to_string(),
        })
        .await;
    assert!(events.try_recv().is_err());
    assert_eq!(
        session.message_id(MessageRole::Agent, None).await,
        "thread:history-1:Agent",
    );
    reconstruction.finish(true).await;

    let (generation, _) = session
        .admit_prompt("run".to_string(), "turn".to_string())
        .await
        .expect("prompt admitted");
    assert_eq!(generation, 1);
    assert!(session
        .admit_prompt("other-run".to_string(), "other-turn".to_string())
        .await
        .is_err());
    assert_eq!(
        session.operation().await,
        Some(("run".to_string(), "turn".to_string(), 1)),
    );
    assert_eq!(
        session
            .message_id(MessageRole::Agent, Some("supplied".to_string()))
            .await,
        "supplied::agent",
    );
    assert_eq!(
        session
            .message_id(MessageRole::Thought, Some("supplied".to_string()))
            .await,
        "supplied::thought",
    );
    let generated = session.message_id(MessageRole::Thought, None).await;
    assert_eq!(generated, "thread:1:1:Thought");
    assert_eq!(
        session.message_id(MessageRole::Thought, None).await,
        generated,
    );
    // Switching speaker mid-turn opens a new message so the answer renders after
    // the reasoning instead of being folded into a bubble that already streamed.
    let answer = session.message_id(MessageRole::Agent, None).await;
    assert_eq!(answer, "thread:1:2:Agent");
    assert_eq!(
        session.message_id(MessageRole::Thought, None).await,
        "thread:1:3:Thought",
        "reasoning that resumes after the answer must not reopen the first block",
    );

    session.fail_active("failed".to_string()).await;
    assert_eq!(session.operation().await, None);
    assert!(matches!(
        events.recv().await.unwrap(),
        CanonicalEvent::RunStarted { .. }
    ));
    assert!(matches!(
        events.recv().await.unwrap(),
        CanonicalEvent::RunFailed { .. }
    ));
}

#[tokio::test]
async fn bounded_event_mailbox_backpressures_and_preserves_terminal_order() {
    let session = AcpSession::with_event_capacity("agent".into(), "thread".into(), 1);
    let mut events = session.take_events().await.expect("event receiver");
    session
        .admit_prompt("run".into(), "turn".into())
        .await
        .expect("prompt admitted");

    let producer = {
        let session = session.clone();
        tokio::spawn(async move {
            session
                .emit(CanonicalEvent::RunFinished {
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
    assert!(matches!(
        events.recv().await,
        Some(CanonicalEvent::RunStarted { .. })
    ));
    producer.await.expect("producer completes after drain");
    assert!(matches!(
        events.recv().await,
        Some(CanonicalEvent::RunFinished { .. })
    ));
    assert_eq!(session.snapshot().await.active_run_id, None);

    let closed = AcpSession::with_event_capacity("agent".into(), "closed".into(), 1);
    drop(closed.take_events().await.expect("closed receiver"));
    closed
        .admit_prompt("closed-run".into(), "closed-turn".into())
        .await
        .expect("snapshot still admits after receiver closure");
    closed
        .emit(CanonicalEvent::Ignored {
            agent_id: "agent".into(),
            thread_id: Some("closed".into()),
            kind: "closed".into(),
        })
        .await;
}

#[tokio::test]
async fn registry_routes_all_accepted_notifications_and_fails_overflow_explicitly() {
    let registry = SessionRegistry::default();
    registry
        .route("agent", notification("late", "late-message"))
        .await
        .unwrap();
    let late = registry
        .register("agent", SessionId::new("late"))
        .await
        .expect("session capacity");
    assert_eq!(late.snapshot().await.messages[0].id, "late-message::agent");
    let same = registry
        .register("agent", SessionId::new("late"))
        .await
        .expect("session capacity");
    assert_eq!(
        same.snapshot().await.thread_id,
        late.snapshot().await.thread_id,
    );
    registry
        .route("agent", notification("late", "live-message"))
        .await
        .unwrap();
    assert_eq!(late.snapshot().await.messages.len(), 2);
    assert_eq!(registry.all().await.len(), 1);
    assert!(registry.get(&SessionId::new("missing")).await.is_none());

    for index in 0..PENDING_NOTIFICATION_CAPACITY {
        registry
            .route(
                "agent",
                notification("pressure", &format!("message-{index}")),
            )
            .await
            .unwrap();
    }

    assert_eq!(
        registry
            .route("agent", notification("pressure", "overflow"))
            .await,
        Err(SessionRouteError::JournalOverflow(
            PENDING_NOTIFICATION_CAPACITY
        )),
    );
    let register = {
        let registry = registry.clone();
        tokio::spawn(async move {
            registry
                .register("agent", SessionId::new("pressure"))
                .await
                .expect("session capacity")
        })
    };
    let pressure = register.await.expect("registration completes");
    let mut events = pressure.take_events().await.expect("pressure receiver");
    assert!(events.try_recv().is_err());
    let snapshot = pressure.snapshot().await;
    assert_eq!(snapshot.messages.len(), 128);
    for (index, message) in snapshot.messages.iter().enumerate() {
        assert_eq!(
            message.id,
            format!(
                "message-{}::agent",
                PENDING_NOTIFICATION_CAPACITY - snapshot.messages.len() + index
            ),
        );
    }
}

#[tokio::test]
async fn cancelled_removal_still_blocks_same_id_replacement_until_cleanup_finishes() {
    let registry = SessionRegistry::default();
    let mut removals = registry.subscribe_removals();
    let session_id = SessionId::new("replacement-safe");
    let original = registry
        .register("agent", session_id.clone())
        .await
        .expect("original session");

    let removal = {
        let registry = registry.clone();
        let session_id = session_id.clone();
        tokio::spawn(async move { registry.remove(&session_id).await })
    };
    let (removed_id, acknowledge) = removals.recv().await.expect("removal notice");
    assert_eq!(removed_id, session_id);
    removal.abort();
    assert!(removal
        .await
        .expect_err("outer removal is cancelled")
        .is_cancelled());

    let replacement = {
        let registry = registry.clone();
        let session_id = session_id.clone();
        tokio::spawn(async move { registry.register_with_freshness("agent", session_id).await })
    };
    tokio::task::yield_now().await;
    assert!(!replacement.is_finished());
    acknowledge.send(()).expect("cleanup acknowledged");
    let (replacement, fresh) = replacement
        .await
        .expect("replacement task")
        .expect("replacement registered");
    assert!(fresh);
    assert!(!Arc::ptr_eq(&original.inner, &replacement.inner));
}

#[tokio::test]
async fn notifications_during_removal_are_discarded_before_same_id_replacement() {
    let registry = SessionRegistry::default();
    let mut removals = registry.subscribe_removals();
    let session_id = SessionId::new("removal-notifications");
    registry
        .register("agent", session_id.clone())
        .await
        .expect("original session");

    let removal = {
        let registry = registry.clone();
        let session_id = session_id.clone();
        tokio::spawn(async move { registry.remove(&session_id).await })
    };
    let (removed_id, acknowledge) = removals.recv().await.expect("removal notice");
    assert_eq!(removed_id, session_id);

    registry
        .route(
            "agent",
            notification("removal-notifications", "late-message"),
        )
        .await
        .expect("late notification is discarded");
    {
        let state = registry.inner.lock().await;
        assert_eq!(state.pending_notification_count, 0);
        assert!(!state.pending_notifications.contains_key(&session_id));
    }

    acknowledge.send(()).expect("cleanup acknowledged");
    removal.await.expect("removal task");
    let (replacement, fresh) = registry
        .register_with_freshness("agent", session_id)
        .await
        .expect("replacement registered");
    assert!(fresh);
    assert!(replacement.snapshot().await.messages.is_empty());
}

#[tokio::test]
async fn registry_evicts_oldest_idle_and_can_reload_it() {
    let registry = SessionRegistry::with_capacity(2);
    let first_id = SessionId::new("first");
    let second_id = SessionId::new("second");
    let third_id = SessionId::new("third");
    registry
        .register("agent", first_id.clone())
        .await
        .expect("first session");
    registry
        .register("agent", second_id.clone())
        .await
        .expect("second session");
    registry
        .route("agent", notification("pending-eviction", "queued"))
        .await
        .unwrap();
    assert!(registry.get(&second_id).await.is_some());
    let second_again = registry
        .register("agent", second_id.clone())
        .await
        .expect("existing live session");
    assert_eq!(
        second_again.snapshot().await.thread_id,
        registry
            .get(&second_id)
            .await
            .unwrap()
            .snapshot()
            .await
            .thread_id,
    );

    registry
        .register("agent", third_id.clone())
        .await
        .expect("oldest idle is evicted");
    assert!(registry.get(&first_id).await.is_none());
    assert!(registry.get(&second_id).await.is_some());
    assert!(registry.get(&third_id).await.is_some());
    assert_eq!(registry.all().await.len(), 2);

    registry
        .register("agent", first_id.clone())
        .await
        .expect("evicted durable identity can be reconstructed later");
    assert!(registry.get(&first_id).await.is_some());
    assert_eq!(registry.all().await.len(), 2);
}

#[tokio::test]
async fn registry_protects_active_cancelling_reconstructing_and_interaction_sessions() {
    let active_registry = SessionRegistry::with_capacity(1);
    let active_id = SessionId::new("active");
    let active = active_registry
        .register("agent", active_id.clone())
        .await
        .unwrap();
    active
        .admit_prompt("run".into(), "turn".into())
        .await
        .unwrap();
    assert!(matches!(
        active_registry
            .register("agent", SessionId::new("other"))
            .await,
        Err(SessionRouteError::Capacity(1))
    ));
    active.mark_cancelling().await;
    assert!(matches!(
        active_registry
            .register("agent", SessionId::new("other"))
            .await,
        Err(SessionRouteError::Capacity(1))
    ));

    let reconstructing_registry = SessionRegistry::with_capacity(1);
    let reconstructing = reconstructing_registry
        .register("agent", SessionId::new("reconstructing"))
        .await
        .unwrap();
    let reconstruction = reconstructing.begin_reconstruction().await.unwrap();
    assert!(matches!(
        reconstructing_registry
            .register("agent", SessionId::new("other"))
            .await,
        Err(SessionRouteError::Capacity(1))
    ));
    reconstruction.finish(true).await;

    let interaction_registry = SessionRegistry::with_capacity(1);
    let interaction_id = SessionId::new("interaction");
    interaction_registry
        .register("agent", interaction_id.clone())
        .await
        .unwrap();
    let first_lease = interaction_registry.lease(&interaction_id).await.unwrap();
    let second_lease = interaction_registry.lease(&interaction_id).await.unwrap();
    assert!(matches!(
        interaction_registry
            .register("agent", SessionId::new("other"))
            .await,
        Err(SessionRouteError::Capacity(1))
    ));
    drop(first_lease);
    assert!(matches!(
        interaction_registry
            .register("agent", SessionId::new("other"))
            .await,
        Err(SessionRouteError::Capacity(1))
    ));
    drop(second_lease);
    interaction_registry
        .register("agent", SessionId::new("other"))
        .await
        .expect("released interaction permits eviction");
}

#[tokio::test]
async fn duplicate_registration_cancels_in_progress_eviction_without_replacing_session() {
    let registry = SessionRegistry::with_capacity(1);
    let session_id = SessionId::new("owned");
    let original = registry
        .register("agent", session_id.clone())
        .await
        .unwrap();
    let barrier = registry.pause_next_eviction().await;
    let eviction = {
        let registry = registry.clone();
        tokio::spawn(async move {
            registry
                .register("agent", SessionId::new("replacement"))
                .await
        })
    };
    barrier.reached.notified().await;

    assert!(registry.get(&session_id).await.is_none());
    assert!(registry.lease(&session_id).await.is_none());
    let duplicate = registry
        .register("agent", session_id.clone())
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&original.inner, &duplicate.inner));
    let restored_lease = registry
        .lease(&session_id)
        .await
        .expect("duplicate registration restores the evicting session to live");
    assert!(Arc::ptr_eq(
        &original.inner,
        &restored_lease.session().inner
    ));
    barrier.release.notify_one();
    assert!(matches!(
        eviction.await.unwrap(),
        Err(SessionRouteError::Capacity(1))
    ));
    assert!(matches!(
        registry
            .register("agent", SessionId::new("still-protected"))
            .await,
        Err(SessionRouteError::Capacity(1))
    ));
    drop(restored_lease);
    assert!(Arc::ptr_eq(
        &original.inner,
        &registry.get(&session_id).await.unwrap().inner
    ));
}

#[tokio::test]
async fn eviction_restores_session_when_notification_arrives_during_guard_setup() {
    let registry = SessionRegistry::with_capacity(1);
    let session_id = SessionId::new("notified");
    let original = registry
        .register("agent", session_id.clone())
        .await
        .unwrap();
    let barrier = registry.pause_next_eviction().await;
    let eviction = {
        let registry = registry.clone();
        tokio::spawn(async move {
            registry
                .register("agent", SessionId::new("replacement"))
                .await
        })
    };
    barrier.reached.notified().await;

    registry
        .route("agent", notification("notified", "during-eviction"))
        .await
        .unwrap();
    registry
        .route("agent", notification("notified", "during-eviction-2"))
        .await
        .unwrap();
    barrier.release.notify_one();
    assert!(matches!(
        eviction.await.unwrap(),
        Err(SessionRouteError::Capacity(1))
    ));
    let restored = registry.get(&session_id).await.unwrap();
    assert!(Arc::ptr_eq(&original.inner, &restored.inner));
    assert_eq!(
        restored
            .snapshot()
            .await
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        ["during-eviction::agent", "during-eviction-2::agent"],
    );
    assert_eq!(registry.inner.lock().await.pending_notification_count, 0);

    for index in 0..PENDING_NOTIFICATION_CAPACITY {
        registry
            .route(
                "agent",
                notification("pressure-after-restore", &format!("message-{index}")),
            )
            .await
            .unwrap();
    }
    assert_eq!(
        registry
            .route("agent", notification("pressure-after-restore", "overflow"))
            .await,
        Err(SessionRouteError::JournalOverflow(
            PENDING_NOTIFICATION_CAPACITY
        )),
    );
}

#[tokio::test]
async fn stale_eviction_rollback_does_not_replace_current_session() {
    let registry = SessionRegistry::with_capacity(1);
    let session_id = SessionId::new("replaced");
    let stale = AcpSession::new("agent".to_string(), "replaced".to_string());
    let current = AcpSession::new("agent".to_string(), "replaced".to_string());
    registry.inner.lock().await.sessions.insert(
        session_id.clone(),
        RegistryEntry::Live {
            session: current.clone(),
            last_access: 2,
            leases: Arc::new(AtomicUsize::new(0)),
        },
    );

    registry
        .restore_eviction(&session_id, stale, 1, Arc::new(AtomicUsize::new(0)))
        .await;

    let retained = registry
        .get(&session_id)
        .await
        .expect("current session retained");
    assert!(Arc::ptr_eq(&current.inner, &retained.inner));

    registry.inner.lock().await.sessions.insert(
        session_id.clone(),
        RegistryEntry::Evicting {
            session: current.clone(),
            last_access: 3,
            leases: Arc::new(AtomicUsize::new(0)),
        },
    );
    registry
        .restore_eviction(
            &session_id,
            AcpSession::new("agent".to_string(), "replaced".to_string()),
            1,
            Arc::new(AtomicUsize::new(0)),
        )
        .await;

    let state = registry.inner.lock().await;
    let RegistryEntry::Evicting { session, .. } = state
        .sessions
        .get(&session_id)
        .expect("current evicting session retained")
    else {
        panic!("rollback changed the current evicting entry");
    };
    assert!(Arc::ptr_eq(&current.inner, &session.inner));
    drop(state);

    registry.inner.lock().await.pending_notification_count = PENDING_NOTIFICATION_CAPACITY;
    assert_eq!(
        registry
            .route("agent", notification("replaced", "overflow"))
            .await,
        Err(SessionRouteError::JournalOverflow(
            PENDING_NOTIFICATION_CAPACITY
        )),
    );
}

#[tokio::test]
async fn eviction_restores_session_when_operation_starts_before_guard_acquisition() {
    let registry = SessionRegistry::with_capacity(1);
    let session_id = SessionId::new("active-during-eviction");
    let original = registry
        .register("agent", session_id.clone())
        .await
        .unwrap();
    let barrier = registry.pause_next_eviction().await;
    let eviction = {
        let registry = registry.clone();
        tokio::spawn(async move {
            registry
                .register("agent", SessionId::new("replacement"))
                .await
        })
    };
    barrier.reached.notified().await;

    original
        .admit_prompt("run".into(), "turn".into())
        .await
        .unwrap();
    barrier.release.notify_one();
    assert!(matches!(
        eviction.await.unwrap(),
        Err(SessionRouteError::Capacity(1))
    ));
    let restored = registry.get(&session_id).await.unwrap();
    assert!(Arc::ptr_eq(&original.inner, &restored.inner));
    original.fail_active("done".into()).await;
}

#[tokio::test]
async fn admission_leases_block_eviction_through_prompt_and_reconstruction_setup() {
    let registry = SessionRegistry::with_capacity(1);
    let session_id = SessionId::new("leased");
    let session = registry
        .register("agent", session_id.clone())
        .await
        .unwrap();

    let prompt_lease = registry.lease(&session_id).await.unwrap();
    prompt_lease
        .session()
        .admit_prompt("run".into(), "turn".into())
        .await
        .unwrap();
    assert!(matches!(
        registry.register("agent", SessionId::new("other")).await,
        Err(SessionRouteError::Capacity(1))
    ));
    prompt_lease.session().fail_active("complete".into()).await;
    drop(prompt_lease);

    let reconstruction_lease = registry.lease(&session_id).await.unwrap();
    let reconstruction = reconstruction_lease
        .session()
        .begin_reconstruction()
        .await
        .unwrap();
    assert!(matches!(
        registry.register("agent", SessionId::new("other")).await,
        Err(SessionRouteError::Capacity(1))
    ));
    reconstruction.finish(true).await;
    drop(reconstruction_lease);

    registry
        .register("agent", SessionId::new("other"))
        .await
        .expect("released lifecycle lease permits eviction");
    assert!(registry.get(&session_id).await.is_none());
    assert_eq!(session.operation().await, None);
}

#[tokio::test]
async fn registry_never_evicts_an_in_progress_registration() {
    let registry = SessionRegistry::with_capacity(1);
    let barrier = registry.pause_next_registration().await;
    let registering = {
        let registry = registry.clone();
        tokio::spawn(async move {
            registry
                .register("agent", SessionId::new("registering"))
                .await
        })
    };
    barrier.reached.notified().await;
    assert!(matches!(
        registry.register("agent", SessionId::new("other")).await,
        Err(SessionRouteError::Capacity(1))
    ));
    barrier.release.notify_one();
    registering.await.unwrap().unwrap();
    assert_eq!(registry.all().await.len(), 1);

    let cleanup_registry = SessionRegistry::with_capacity(1);
    let cleanup_id = SessionId::new("cleanup");
    let cleanup_barrier = cleanup_registry.pause_next_registration().await;
    let cleanup = {
        let registry = cleanup_registry.clone();
        let session_id = cleanup_id.clone();
        tokio::spawn(async move { registry.register("agent", session_id).await })
    };
    cleanup_barrier.reached.notified().await;
    cleanup_registry.remove(&cleanup_id).await;
    cleanup_barrier.release.notify_one();
    cleanup.await.unwrap().unwrap();
    assert!(cleanup_registry.all().await.is_empty());
}

#[tokio::test]
async fn reservations_reject_protected_capacity_release_on_failure_and_bind_atomically() {
    let registry = SessionRegistry::with_capacity(1);
    let protected_id = SessionId::new("protected");
    let protected = registry
        .register("agent", protected_id.clone())
        .await
        .unwrap();
    protected
        .admit_prompt("run".into(), "turn".into())
        .await
        .unwrap();
    assert_eq!(
        registry.reserve().await,
        Err(SessionRouteError::Capacity(1)),
    );
    protected.fail_active("complete".into()).await;

    let reservation = registry.reserve().await.unwrap();
    assert!(registry.get(&protected_id).await.is_none());
    assert_eq!(
        registry.reserve().await,
        Err(SessionRouteError::Capacity(1)),
    );
    registry.release_reservation(reservation).await;

    let replacement = registry.reserve().await.unwrap();
    let bound_id = SessionId::new("bound");
    registry
        .register_reserved("agent", bound_id.clone(), replacement)
        .await
        .unwrap();
    assert!(registry.get(&bound_id).await.is_some());
    assert!(registry.inner.lock().await.reservations.is_empty());

    assert!(matches!(
        registry
            .register_reserved("agent", SessionId::new("invalid"), u64::MAX)
            .await,
        Err(SessionRouteError::Capacity(1))
    ));

    let duplicate_registry = SessionRegistry::with_capacity(2);
    let duplicate_id = SessionId::new("duplicate");
    let original = duplicate_registry
        .register("agent", duplicate_id.clone())
        .await
        .unwrap();
    let duplicate_reservation = duplicate_registry.reserve().await.unwrap();
    let duplicate = duplicate_registry
        .register_reserved("agent", duplicate_id, duplicate_reservation)
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&original.inner, &duplicate.inner));
    assert!(duplicate_registry
        .inner
        .lock()
        .await
        .reservations
        .is_empty());

    let busy_registry = SessionRegistry::with_capacity(1);
    let busy_id = SessionId::new("busy");
    let busy = busy_registry
        .register("agent", busy_id.clone())
        .await
        .unwrap();
    let operation = busy.operation_lock.lock().await;
    assert_eq!(
        busy_registry.reserve().await,
        Err(SessionRouteError::Capacity(1)),
    );
    drop(operation);
    assert!(Arc::ptr_eq(
        &busy.inner,
        &busy_registry.get(&busy_id).await.unwrap().inner
    ));
}

#[tokio::test]
async fn registration_serializes_queued_a_before_live_b() {
    let registry = SessionRegistry::default();
    registry
        .route("agent", notification("race", "a"))
        .await
        .unwrap();
    let barrier = registry.pause_next_registration().await;
    let register = {
        let registry = registry.clone();
        tokio::spawn(async move {
            registry
                .register("agent", SessionId::new("race"))
                .await
                .expect("session capacity")
        })
    };
    barrier.reached.notified().await;
    let duplicate_register = {
        let registry = registry.clone();
        tokio::spawn(async move {
            registry
                .register("agent", SessionId::new("race"))
                .await
                .expect("session capacity")
        })
    };
    tokio::task::yield_now().await;
    assert!(!duplicate_register.is_finished());
    assert!(registry.all().await.is_empty());
    let routes = (0..32).map(|index| {
        let registry = registry.clone();
        tokio::spawn(async move {
            registry
                .route("agent", notification("race", &format!("b-{index:02}")))
                .await
        })
    });
    for route in routes {
        route.await.expect("concurrent route completes").unwrap();
    }
    barrier.release.notify_one();
    let session = register.await.expect("registration completes");
    let duplicate = duplicate_register
        .await
        .expect("duplicate registration completes after owner");
    assert_eq!(
        duplicate.snapshot().await.thread_id,
        session.snapshot().await.thread_id,
    );
    assert_eq!(registry.all().await.len(), 1);
    let snapshot = session.snapshot().await;
    let ids = snapshot
        .messages
        .iter()
        .map(|message| message.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(ids.first(), Some(&"a::agent"));
    assert_eq!(ids.len(), 33);
    assert_eq!(ids.iter().filter(|id| id.starts_with("b-")).count(), 32);
}

#[tokio::test]
async fn receipt_first_notification_keeps_old_operation_across_terminal_transition() {
    let registry = SessionRegistry::default();
    let session_id = SessionId::new("receipt-race");
    let session = registry
        .register("agent", session_id.clone())
        .await
        .expect("session capacity");
    let mut events = session.take_events().await.unwrap();
    session
        .admit_prompt("run-1".into(), "turn-1".into())
        .await
        .unwrap();
    let barrier = session.pause_next_notification_delivery().await;
    let state_guard = session.inner.lock().await;
    let route = {
        let registry = registry.clone();
        tokio::spawn(async move {
            registry
                .route("agent", notification("receipt-race", "old-notification"))
                .await
                .unwrap();
        })
    };
    tokio::task::yield_now().await;
    assert!(!route.is_finished());
    let transition = {
        let session = session.clone();
        tokio::spawn(async move {
            session
                .fail_generation("run-1".into(), "turn-1".into(), 1, "done".into())
                .await;
            session
                .admit_prompt("run-2".into(), "turn-2".into())
                .await
                .unwrap();
        })
    };
    tokio::task::yield_now().await;
    assert!(!transition.is_finished());
    drop(state_guard);
    barrier.reached.notified().await;
    transition.await.unwrap();
    barrier.release.notify_one();
    route.await.unwrap();

    let mut correlated = None;
    while let Ok(event) = events.try_recv() {
        if let CanonicalEvent::MessageChunk {
            message_id,
            run_id,
            source_turn_id,
            generation,
            ..
        } = event
        {
            if message_id == "old-notification::agent" {
                correlated = Some((run_id, source_turn_id, generation));
            }
        }
    }
    assert_eq!(
        correlated,
        Some((Some("run-1".into()), Some("turn-1".into()), Some(1))),
    );
    assert_eq!(
        session.operation().await,
        Some(("run-2".into(), "turn-2".into(), 2)),
    );
}

#[tokio::test]
async fn transition_first_notification_captures_new_operation() {
    let registry = SessionRegistry::default();
    let session_id = SessionId::new("transition-first");
    let session = registry
        .register("agent", session_id)
        .await
        .expect("session capacity");
    let mut events = session.take_events().await.unwrap();
    session
        .admit_prompt("run-1".into(), "turn-1".into())
        .await
        .unwrap();
    session
        .fail_generation("run-1".into(), "turn-1".into(), 1, "done".into())
        .await;
    session
        .admit_prompt("run-2".into(), "turn-2".into())
        .await
        .unwrap();

    registry
        .route(
            "agent",
            notification("transition-first", "new-notification"),
        )
        .await
        .unwrap();

    let mut correlated = None;
    while let Ok(event) = events.try_recv() {
        if let CanonicalEvent::MessageChunk {
            message_id,
            run_id,
            source_turn_id,
            generation,
            ..
        } = event
        {
            if message_id == "new-notification::agent" {
                correlated = Some((run_id, source_turn_id, generation));
            }
        }
    }
    assert_eq!(
        correlated,
        Some((Some("run-2".into()), Some("turn-2".into()), Some(2))),
    );
}

#[tokio::test]
async fn reconstruction_replaces_stale_state_and_rolls_back_failure() {
    let session = AcpSession::new("agent".into(), "thread".into());
    session.finish_reconstruction(true).await;
    for (message_id, commit) in [("old", true), ("new", true), ("failed", false)] {
        let reconstruction = session.begin_reconstruction().await.unwrap();
        session
            .emit(CanonicalEvent::MessageChunk {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::Agent,
                message_id: message_id.into(),
                content: message_id.into(),
                content_block: None,
            })
            .await;
        reconstruction.finish(commit).await;
    }
    let snapshot = session.snapshot().await;
    assert_eq!(snapshot.messages.len(), 1);
    assert_eq!(snapshot.messages[0].id, "new");
    assert!(!snapshot.history_reconstruction);
}

#[tokio::test]
async fn empty_reconstruction_keeps_history_but_adopts_reloaded_metadata() {
    let session = AcpSession::new("agent".into(), "thread".into());
    session
        .emit(CanonicalEvent::MessageChunk {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role: MessageRole::Agent,
            message_id: "kept".into(),
            content: "kept".into(),
            content_block: None,
        })
        .await;

    let reconstruction = session.begin_reconstruction().await.unwrap();
    session
        .emit(CanonicalEvent::Mode {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            id: "plan".into(),
        })
        .await;
    reconstruction.finish(true).await;

    let snapshot = session.snapshot().await;
    assert_eq!(snapshot.messages.len(), 1);
    assert_eq!(snapshot.messages[0].id, "kept");
    assert_eq!(snapshot.mode_id.as_deref(), Some("plan"));
    assert!(!snapshot.history_reconstruction);
}

#[tokio::test]
async fn activity_only_reconstruction_keeps_history_and_new_agent_messages() {
    let session = AcpSession::new("agent".into(), "thread".into());
    for (message_id, role, content) in [
        ("user", MessageRole::User, "Original question"),
        ("assistant", MessageRole::Agent, "Original answer"),
    ] {
        session
            .emit(CanonicalEvent::MessageChunk {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role,
                message_id: message_id.into(),
                content: content.into(),
                content_block: None,
            })
            .await;
    }

    let reconstruction = session.begin_reconstruction().await.unwrap();
    session
        .emit(CanonicalEvent::AgentMessage {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            message: crate::agent_messaging::AgentMessageOrigin {
                message_id: "message-from-child".into(),
                direction: crate::agent_messaging::AgentMessageDirection::Received,
                related_thread_id: "child".into(),
                related_title: Some("Worker".into()),
                relation: crate::agent_messaging::AgentRelationKind::SubAgent,
                disposition: crate::agent_messaging::AgentMessageDisposition::Sent,
                body: "Child update".into(),
            },
        })
        .await;
    reconstruction.finish(true).await;

    let snapshot = session.snapshot().await;
    assert_eq!(
        snapshot
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        ["user", "assistant", "agent-message:message-from-child"],
    );
    assert!(!snapshot.history_reconstruction);
}

#[tokio::test]
async fn empty_reconstruction_preserves_an_activity_only_transcript() {
    let session = AcpSession::new("agent".into(), "thread".into());
    session
        .emit(CanonicalEvent::AgentMessage {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            message: crate::agent_messaging::AgentMessageOrigin {
                message_id: "message-from-child".into(),
                direction: crate::agent_messaging::AgentMessageDirection::Received,
                related_thread_id: "child".into(),
                related_title: Some("Worker".into()),
                relation: crate::agent_messaging::AgentRelationKind::SubAgent,
                disposition: crate::agent_messaging::AgentMessageDisposition::Sent,
                body: "Child update".into(),
            },
        })
        .await;

    let reconstruction = session.begin_reconstruction().await.unwrap();
    reconstruction.finish(true).await;

    let snapshot = session.snapshot().await;
    assert_eq!(snapshot.messages.len(), 1);
    assert_eq!(
        snapshot.messages[0]
            .agent_message
            .as_ref()
            .map(|message| message.message_id.as_str()),
        Some("message-from-child"),
    );
    assert!(!snapshot.history_reconstruction);
}

#[tokio::test]
async fn history_seeding_hydrates_an_activity_only_snapshot() {
    let session = AcpSession::new("agent".into(), "thread".into());
    session
        .emit(CanonicalEvent::AgentMessage {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            message: crate::agent_messaging::AgentMessageOrigin {
                message_id: "message-from-child".into(),
                direction: crate::agent_messaging::AgentMessageDirection::Received,
                related_thread_id: "child".into(),
                related_title: Some("Worker".into()),
                relation: crate::agent_messaging::AgentRelationKind::SubAgent,
                disposition: crate::agent_messaging::AgentMessageDisposition::Sent,
                body: "Child update".into(),
            },
        })
        .await;

    let seeded = session
        .seed_history(vec![
            CanonicalEvent::MessageChunk {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::User,
                message_id: "user".into(),
                content: "Original question".into(),
                content_block: None,
            },
            CanonicalEvent::MessageChunk {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::Agent,
                message_id: "assistant".into(),
                content: "Original answer".into(),
                content_block: None,
            },
        ])
        .await;

    assert!(seeded);
    assert_eq!(
        session
            .snapshot()
            .await
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        ["user", "assistant", "agent-message:message-from-child"],
    );
}

#[tokio::test]
async fn restoring_history_also_restores_the_replay_id_cursor() {
    let session = AcpSession::new("agent".into(), "thread".into());
    let first = session
        .message_id_for_generation(MessageRole::Agent, None, None)
        .await;
    session
        .emit(CanonicalEvent::MessageChunk {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role: MessageRole::Agent,
            message_id: first.clone(),
            content: "first".into(),
            content_block: None,
        })
        .await;

    let reconstruction = session.begin_reconstruction().await.unwrap();
    reconstruction.finish(true).await;

    let next = session
        .message_id_for_generation(MessageRole::User, None, None)
        .await;
    assert_ne!(next, first, "replay ids must not collide after a restore");
}

#[tokio::test]
async fn replayed_history_starts_a_new_message_when_the_speaker_changes() {
    let session = AcpSession::new("agent".into(), "thread".into());
    let mut ids = Vec::new();
    for role in [
        MessageRole::User,
        MessageRole::Agent,
        MessageRole::Agent,
        MessageRole::User,
        MessageRole::Agent,
    ] {
        ids.push(session.message_id_for_generation(role, None, None).await);
    }

    assert_eq!(ids[1], ids[2], "consecutive agent chunks share a message");
    assert_ne!(
        ids[0], ids[3],
        "each replayed user turn gets its own message",
    );
    assert_ne!(
        ids[1], ids[4],
        "each replayed agent turn gets its own message",
    );
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        4,
    );
}

#[tokio::test]
async fn prompt_waits_for_reconstruction_commit_or_rollback() {
    for commit in [true, false] {
        let session = AcpSession::new("agent".into(), "thread".into());
        session
            .emit(CanonicalEvent::MessageChunk {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::Agent,
                message_id: "old".into(),
                content: "old".into(),
                content_block: None,
            })
            .await;
        let reconstruction = session.begin_reconstruction().await.unwrap();
        session
            .emit(CanonicalEvent::MessageChunk {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::Agent,
                message_id: "loaded".into(),
                content: "loaded".into(),
                content_block: None,
            })
            .await;
        let prompt_session = session.clone();
        let prompt = tokio::spawn(async move {
            prompt_session
                .admit_prompt("run".into(), "turn".into())
                .await
        });
        tokio::task::yield_now().await;
        assert!(!prompt.is_finished());
        reconstruction.finish(commit).await;
        prompt.await.expect("prompt task").expect("prompt admitted");
        let snapshot = session.snapshot().await;
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(
            snapshot.messages[0].id,
            if commit { "loaded" } else { "old" },
        );
        assert_eq!(snapshot.active_generation, Some(1));
        assert!(!snapshot.history_reconstruction);
    }
}

#[tokio::test]
async fn initial_reconstruction_commits_journal_and_rolls_back_to_empty() {
    for commit in [true, false] {
        let session = AcpSession::new("agent".into(), "thread".into());
        session
            .emit(CanonicalEvent::MessageChunk {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::Agent,
                message_id: "journal".into(),
                content: "journal".into(),
                content_block: None,
            })
            .await;
        let reconstruction = session.begin_initial_reconstruction().await;
        reconstruction.finish(commit).await;
        let snapshot = session.snapshot().await;
        assert_eq!(snapshot.messages.len(), usize::from(commit));
        assert!(!snapshot.history_reconstruction);
    }
}

#[tokio::test]
async fn cancelling_generation_rejects_interactions_until_matching_completion() {
    let session = AcpSession::new("agent".into(), "thread".into());
    assert_eq!(session.active_interaction_generation().await, None);
    session
        .admit_prompt("run-1".into(), "turn-1".into())
        .await
        .expect("first prompt admitted");
    assert_eq!(session.active_interaction_generation().await, Some(1));
    assert_eq!(session.mark_cancelling().await, Some(1));
    assert_eq!(session.active_interaction_generation().await, None);
    assert_eq!(session.mark_cancelling().await, None);
    assert!(session
        .admit_prompt("blocked".into(), "blocked".into())
        .await
        .is_err());
    assert!(session
        .admit_prompt("still-blocked".into(), "still-blocked".into())
        .await
        .is_err());
    session
        .emit(CanonicalEvent::RunFinished {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            run_id: "run-1".into(),
            source_turn_id: "turn-1".into(),
            generation: 1,
            stop_reason: agent_client_protocol::v1::schema::StopReason::Cancelled,
        })
        .await;
    let (generation, _) = session
        .admit_prompt("run-2".into(), "turn-2".into())
        .await
        .expect("next generation admitted");
    assert_eq!(generation, 2);
}

#[tokio::test]
async fn reconstruction_rejects_without_mutating_an_active_generation() {
    let session = AcpSession::new("agent".into(), "thread".into());
    session
        .admit_prompt("run".into(), "turn".into())
        .await
        .expect("prompt admitted");
    assert_eq!(session.active_interaction_generation().await, Some(1));
    let before = session.snapshot().await;
    assert_eq!(
        session.begin_reconstruction().await.err(),
        Some(ReconstructionError::Busy),
    );
    let after = session.snapshot().await;
    assert_eq!(after.active_run_id, before.active_run_id);
    assert_eq!(after.active_source_turn_id, before.active_source_turn_id);
    assert_eq!(after.active_generation, before.active_generation);
    assert_eq!(after.messages.len(), before.messages.len());
    assert_eq!(after.history_reconstruction, before.history_reconstruction);
    assert_eq!(session.active_interaction_generation().await, Some(1));
}

#[tokio::test]
async fn session_noop_and_terminal_paths_preserve_generation_identity() {
    let session = AcpSession::new("agent".into(), "thread".into());
    session.finish_reconstruction(false).await;
    session.fail_active("inactive".into()).await;
    assert_eq!(
        session
            .message_id(MessageRole::Agent, Some("supplied".into()))
            .await,
        "supplied::agent",
    );
    let generated = session.message_id(MessageRole::Agent, None).await;
    assert_eq!(generated, "thread:history-1:Agent");
    assert_eq!(
        session.message_id(MessageRole::Agent, None).await,
        generated,
    );
    session
        .admit_prompt("run".into(), "turn".into())
        .await
        .expect("prompt admitted");
    let snapshot = session.snapshot().await;
    session
        .emit(CanonicalEvent::RunFinished {
            agent_id: snapshot.agent_id.clone(),
            thread_id: snapshot.thread_id.clone(),
            run_id: "stale".into(),
            source_turn_id: "stale".into(),
            generation: 99,
            stop_reason: agent_client_protocol::v1::schema::StopReason::EndTurn,
        })
        .await;
    assert_eq!(session.active_interaction_generation().await, Some(1));
    session
        .emit(CanonicalEvent::RunFinished {
            agent_id: snapshot.agent_id,
            thread_id: snapshot.thread_id,
            run_id: "run".into(),
            source_turn_id: "turn".into(),
            generation: 1,
            stop_reason: agent_client_protocol::v1::schema::StopReason::EndTurn,
        })
        .await;
    assert_eq!(session.active_interaction_generation().await, None);
    drop(session.take_events().await.expect("event receiver"));
    session
        .emit(CanonicalEvent::Plan {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            entries: Vec::new(),
        })
        .await;
    session.flush_events().await;
}

#[tokio::test]
async fn prompt_admission_survives_closed_mailbox_and_empty_registry_journal() {
    let session = AcpSession::new("agent".into(), "thread".into());
    drop(session.take_events().await.expect("event receiver"));
    let (generation, _) = session
        .admit_prompt("run".into(), "turn".into())
        .await
        .expect("prompt state commits even when mailbox is closed");
    assert_eq!(generation, 1);

    let registry = SessionRegistry::default();
    let session_id = SessionId::new("empty-journal");
    let registered = registry
        .register("agent", session_id.clone())
        .await
        .expect("session capacity");
    let duplicate = registry
        .register("agent", session_id)
        .await
        .expect("session capacity");
    assert_eq!(
        registered.snapshot().await.thread_id,
        duplicate.snapshot().await.thread_id,
    );
    assert_eq!(registry.all().await.len(), 1);
}

#[tokio::test]
async fn overlapping_reconstructions_serialize_success_and_failure() {
    let session = AcpSession::new("agent".into(), "thread".into());
    let first = session.begin_reconstruction().await.unwrap();
    session
        .emit(CanonicalEvent::MessageChunk {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role: MessageRole::Agent,
            message_id: "first".into(),
            content: "first".into(),
            content_block: None,
        })
        .await;
    let second_session = session.clone();
    let second = tokio::spawn(async move { second_session.begin_reconstruction().await });
    tokio::task::yield_now().await;
    assert!(!second.is_finished());
    first.finish(true).await;
    let second = second.await.expect("second reconstruction starts").unwrap();
    session
        .emit(CanonicalEvent::MessageChunk {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role: MessageRole::Agent,
            message_id: "second".into(),
            content: "second".into(),
            content_block: None,
        })
        .await;
    second.finish(false).await;
    let snapshot = session.snapshot().await;
    assert_eq!(snapshot.messages.len(), 1);
    assert_eq!(snapshot.messages[0].id, "first");
    assert!(!snapshot.history_reconstruction);
}

#[tokio::test]
async fn overlapping_failed_then_successful_reconstruction_commits_only_second() {
    let session = AcpSession::new("agent".into(), "thread".into());
    let first = session.begin_reconstruction().await.unwrap();
    session
        .emit(CanonicalEvent::MessageChunk {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role: MessageRole::Agent,
            message_id: "failed-first".into(),
            content: "failed-first".into(),
            content_block: None,
        })
        .await;
    let second_session = session.clone();
    let second = tokio::spawn(async move { second_session.begin_reconstruction().await });
    tokio::task::yield_now().await;
    assert!(!second.is_finished());
    first.finish(false).await;
    let second = second.await.expect("second reconstruction starts").unwrap();
    session
        .emit(CanonicalEvent::MessageChunk {
            agent_id: "agent".into(),
            thread_id: "thread".into(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role: MessageRole::Agent,
            message_id: "successful-second".into(),
            content: "successful-second".into(),
            content_block: None,
        })
        .await;
    second.finish(true).await;
    let snapshot = session.snapshot().await;
    assert_eq!(snapshot.messages.len(), 1);
    assert_eq!(snapshot.messages[0].id, "successful-second");
    assert!(!snapshot.history_reconstruction);
}
