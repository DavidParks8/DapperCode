use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex as StdMutex,
};

use agent_client_protocol::schema::v1::{ContentBlock, SessionId, SessionNotification};
use tokio::sync::{mpsc, oneshot, Mutex, OwnedMutexGuard};
use uuid::Uuid;

use super::events::{
    canonical_event_channel, CanonicalEvent, CanonicalEventReceiver, CanonicalEventSender,
    MessageRole,
};
use super::snapshot::SessionSnapshot;

#[derive(Debug, Clone)]
pub struct ReceivedSessionNotification {
    pub notification: SessionNotification,
    pub operation: Option<(String, String, u64)>,
    pub reconstruction: bool,
}

impl From<SessionNotification> for ReceivedSessionNotification {
    fn from(notification: SessionNotification) -> Self {
        Self {
            notification,
            operation: None,
            reconstruction: true,
        }
    }
}

#[derive(Clone)]
pub struct AcpSession {
    instance_id: Uuid,
    inner: Arc<Mutex<SessionState>>,
    operation_lock: Arc<Mutex<()>>,
    interaction_lock: Arc<Mutex<()>>,
    events: CanonicalEventSender,
    event_receiver: Arc<Mutex<Option<CanonicalEventReceiver>>>,
    #[cfg(test)]
    notification_delivery_barrier: Arc<Mutex<Option<RegistrationBarrier>>>,
}

struct SessionState {
    snapshot: SessionSnapshot,
    reconstruction_backup: Option<SessionSnapshot>,
    reconstruction_history_cursor: Option<(Option<MessageRole>, u64)>,
    next_generation: u64,
    generation_state: GenerationState,
    /// The message each live run is currently streaming into, keyed by generation.
    /// Only one message per generation is ever open, so anything that interrupts the
    /// stream -- the speaker changing or a tool call landing -- starts a new one.
    open_messages: HashMap<u64, (MessageRole, String)>,
    pending_agent_message_envelopes: HashMap<String, PendingAgentMessageEnvelope>,
    pending_agent_message_serial: u64,
    live_serial: u64,
    history_role: Option<MessageRole>,
    history_serial: u64,
    notification_receipts: VecDeque<RoutedSessionNotification>,
    notification_draining: bool,
}

struct PendingAgentMessageEnvelope {
    content: String,
    after_timeline_id: Option<String>,
    serial: u64,
}

struct RoutedSessionNotification {
    agent_id: String,
    received: ReceivedSessionNotification,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GenerationState {
    Terminal,
    Active(u64),
    Cancelling(u64),
    Handoff { generation: u64, settled: bool },
}

impl SessionState {
    fn flush_pending_agent_message_envelopes(&mut self) {
        let mut pending = std::mem::take(&mut self.pending_agent_message_envelopes)
            .into_iter()
            .collect::<Vec<_>>();
        let (mut anchored, mut unanchored): (Vec<_>, Vec<_>) = pending
            .drain(..)
            .partition(|(_, pending)| pending.after_timeline_id.is_some());
        unanchored.sort_by_key(|(_, pending)| std::cmp::Reverse(pending.serial));
        anchored.sort_by_key(|(_, pending)| std::cmp::Reverse(pending.serial));
        for (message_id, pending) in unanchored.into_iter().chain(anchored) {
            self.snapshot.append_message_after(
                message_id,
                MessageRole::User,
                pending.content,
                None,
                pending.after_timeline_id.as_deref(),
            );
        }
    }
}

pub(crate) enum AgentMessageChunkMatch {
    Ordinary(String),
    Pending,
    Complete(crate::agent_messaging::AgentMessageEnvelope),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ReconstructionError {
    #[error("ACP session already has an active prompt")]
    Busy,
    #[error("ACP session prompt is being cancelled")]
    Cancelled,
}

impl AcpSession {
    pub fn new(agent_id: String, thread_id: String) -> Self {
        Self::with_event_capacity(agent_id, thread_id, 256)
    }

    fn with_event_capacity(agent_id: String, thread_id: String, capacity: usize) -> Self {
        let (events, event_receiver) = canonical_event_channel(capacity);
        Self {
            instance_id: Uuid::new_v4(),
            inner: Arc::new(Mutex::new(SessionState {
                snapshot: SessionSnapshot::new(agent_id, thread_id),
                reconstruction_backup: None,
                reconstruction_history_cursor: None,
                next_generation: 0,
                generation_state: GenerationState::Terminal,
                open_messages: HashMap::new(),
                pending_agent_message_envelopes: HashMap::new(),
                pending_agent_message_serial: 0,
                live_serial: 0,
                history_role: None,
                history_serial: 0,
                notification_receipts: VecDeque::new(),
                notification_draining: false,
            })),
            operation_lock: Arc::new(Mutex::new(())),
            interaction_lock: Arc::new(Mutex::new(())),
            events,
            event_receiver: Arc::new(Mutex::new(Some(event_receiver))),
            #[cfg(test)]
            notification_delivery_barrier: Arc::new(Mutex::new(None)),
        }
    }

    pub fn instance_id(&self) -> Uuid {
        self.instance_id
    }

    pub(crate) async fn lock_interactions(&self) -> OwnedMutexGuard<()> {
        self.interaction_lock.clone().lock_owned().await
    }

    pub async fn begin_reconstruction(
        &self,
    ) -> Result<ReconstructionTransaction, ReconstructionError> {
        let guard = self.operation_lock.clone().lock_owned().await;
        let mut state = self.inner.lock().await;
        match state.generation_state {
            GenerationState::Active(_) => return Err(ReconstructionError::Busy),
            GenerationState::Cancelling(_) => return Err(ReconstructionError::Cancelled),
            GenerationState::Handoff { .. } => return Err(ReconstructionError::Busy),
            GenerationState::Terminal => {}
        }
        debug_assert!(state.reconstruction_backup.is_none());
        let mut fresh = SessionSnapshot::new(
            state.snapshot.agent_id.clone(),
            state.snapshot.thread_id.clone(),
        );
        fresh.history_reconstruction = true;
        state.reconstruction_backup = Some(std::mem::replace(&mut state.snapshot, fresh));
        state.open_messages.clear();
        state.pending_agent_message_envelopes.clear();
        state.pending_agent_message_serial = 0;
        state.reconstruction_history_cursor = Some((state.history_role, state.history_serial));
        state.history_role = None;
        state.history_serial = 0;
        Ok(ReconstructionTransaction {
            session: self.clone(),
            _guard: guard,
        })
    }
    pub async fn begin_initial_reconstruction(&self) -> ReconstructionTransaction {
        let guard = self.operation_lock.clone().lock_owned().await;
        let mut state = self.inner.lock().await;
        debug_assert!(state.reconstruction_backup.is_none());
        let previous = SessionSnapshot::new(
            state.snapshot.agent_id.clone(),
            state.snapshot.thread_id.clone(),
        );
        state.snapshot.history_reconstruction = true;
        state.reconstruction_backup = Some(previous);
        state.pending_agent_message_envelopes.clear();
        state.pending_agent_message_serial = 0;
        ReconstructionTransaction {
            session: self.clone(),
            _guard: guard,
        }
    }
    async fn finish_reconstruction(&self, commit: bool) {
        let mut state = self.inner.lock().await;
        let restored_cursor = state.reconstruction_history_cursor.take();
        let Some(previous) = state.reconstruction_backup.take() else {
            return;
        };
        let restored = if !commit {
            state.snapshot = previous;
            true
        } else if !state.snapshot.has_ordinary_transcript()
            && (previous.has_ordinary_transcript() || !previous.timeline.is_empty())
        {
            // Agents are expected to replay the conversation while `session/load` is
            // in flight. Agent-message envelopes are auxiliary activity, not proof that
            // the ordinary conversation was replayed, so keep the transcript we already
            // had while retaining both the new activity and the metadata the reload reported.
            state.snapshot.restore_transcript_from(previous);
            true
        } else {
            false
        };
        if commit && !restored {
            state.flush_pending_agent_message_envelopes();
        } else {
            state.pending_agent_message_envelopes.clear();
        }
        // Restoring a transcript also has to restore the history id cursor, otherwise
        // the next replayed chunk reuses `history-1` and is appended to the oldest
        // message instead of starting a new one.
        if restored {
            if let Some((role, serial)) = restored_cursor {
                state.history_role = role;
                state.history_serial = serial;
            }
        }
        if commit {
            state.snapshot.history_reconstruction = false;
            state.snapshot.settle_unresolved_subagents_without_run();
        }
    }

    pub(crate) async fn classify_agent_message_chunk(
        &self,
        message_id: &str,
        content: String,
        recipient_thread_id: &str,
    ) -> AgentMessageChunkMatch {
        const MAX_ENVELOPE_BYTES: usize = 64 * 1024;

        let mut state = self.inner.lock().await;
        let (combined, after_timeline_id, serial) =
            if let Some(mut pending) = state.pending_agent_message_envelopes.remove(message_id) {
                pending.content.push_str(&content);
                (pending.content, pending.after_timeline_id, pending.serial)
            } else {
                state.pending_agent_message_serial =
                    state.pending_agent_message_serial.saturating_add(1);
                (
                    content,
                    state
                        .snapshot
                        .latest_timeline_canonical_id()
                        .map(str::to_string),
                    state.pending_agent_message_serial,
                )
            };
        if let Some(envelope) = crate::agent_messaging::AgentMessageEnvelope::decode_echo(&combined)
        {
            return if envelope.recipient_thread_id == recipient_thread_id {
                AgentMessageChunkMatch::Complete(envelope)
            } else {
                AgentMessageChunkMatch::Ordinary(combined)
            };
        }
        if combined.len() > MAX_ENVELOPE_BYTES
            || !crate::agent_messaging::AgentMessageEnvelope::may_be_partial(&combined)
            || crate::agent_messaging::AgentMessageEnvelope::has_complete_suffix(&combined)
        {
            return AgentMessageChunkMatch::Ordinary(combined);
        }
        state.pending_agent_message_envelopes.insert(
            message_id.to_string(),
            PendingAgentMessageEnvelope {
                content: combined,
                after_timeline_id,
                serial,
            },
        );
        AgentMessageChunkMatch::Pending
    }

    pub async fn admit_prompt(
        &self,
        run_id: String,
        source_turn_id: String,
    ) -> Result<(u64, CanonicalEvent), &'static str> {
        let _operation = self.operation_lock.lock().await;
        let mut state = self.inner.lock().await;
        if matches!(
            state.generation_state,
            GenerationState::Active(_)
                | GenerationState::Cancelling(_)
                | GenerationState::Handoff { .. }
        ) {
            return Err("ACP session already has an active prompt");
        }
        state.next_generation += 1;
        let generation = state.next_generation;
        let event = CanonicalEvent::RunStarted {
            agent_id: state.snapshot.agent_id.clone(),
            thread_id: state.snapshot.thread_id.clone(),
            run_id,
            source_turn_id,
            generation,
        };
        state.snapshot.apply(&event);
        state.generation_state = GenerationState::Active(generation);
        drop(state);
        if self.events.send(event.clone()).await.is_err() {
            eprintln!("ACP session canonical event mailbox closed during prompt admission");
        }
        Ok((generation, event))
    }

    pub async fn reserve_handoff(
        &self,
        expected_run_id: &str,
        expected_source_turn_id: &str,
        expected_generation: u64,
    ) -> Result<(), &'static str> {
        let _operation = self.operation_lock.lock().await;
        let mut state = self.inner.lock().await;
        let matches_operation = state.snapshot.active_run_id.as_deref() == Some(expected_run_id)
            && state.snapshot.active_source_turn_id.as_deref() == Some(expected_source_turn_id)
            && state.snapshot.active_generation == Some(expected_generation);
        if !matches_operation
            || state.generation_state != GenerationState::Active(expected_generation)
        {
            return Err("steer target is no longer the active prompt");
        }
        state.generation_state = GenerationState::Handoff {
            generation: expected_generation,
            settled: false,
        };
        Ok(())
    }

    pub async fn admit_handoff(
        &self,
        run_id: String,
        source_turn_id: String,
    ) -> Result<(u64, CanonicalEvent), &'static str> {
        let _operation = self.operation_lock.lock().await;
        let mut state = self.inner.lock().await;
        if !matches!(state.generation_state, GenerationState::Handoff { .. }) {
            return Err("steer handoff is no longer reserved");
        }
        state.next_generation += 1;
        let generation = state.next_generation;
        let event = CanonicalEvent::RunStarted {
            agent_id: state.snapshot.agent_id.clone(),
            thread_id: state.snapshot.thread_id.clone(),
            run_id,
            source_turn_id,
            generation,
        };
        state.snapshot.apply(&event);
        state.generation_state = GenerationState::Active(generation);
        drop(state);
        if self.events.send(event.clone()).await.is_err() {
            eprintln!("ACP session canonical event mailbox closed during steer handoff");
        }
        Ok((generation, event))
    }

    pub async fn release_handoff(&self) {
        let _operation = self.operation_lock.lock().await;
        let mut state = self.inner.lock().await;
        if let GenerationState::Handoff {
            generation,
            settled,
        } = state.generation_state
        {
            state.generation_state = if settled {
                GenerationState::Terminal
            } else {
                GenerationState::Active(generation)
            };
        }
    }
    pub async fn operation(&self) -> Option<(String, String, u64)> {
        let state = self.inner.lock().await;
        Some((
            state.snapshot.active_run_id.clone()?,
            state.snapshot.active_source_turn_id.clone()?,
            state.snapshot.active_generation?,
        ))
    }
    #[cfg(test)]
    pub async fn message_id(&self, role: MessageRole, supplied: Option<String>) -> String {
        let generation = self.inner.lock().await.snapshot.active_generation;
        self.message_id_for_generation(role, supplied, generation)
            .await
    }

    pub async fn message_id_for_generation(
        &self,
        role: MessageRole,
        supplied: Option<String>,
        generation: Option<u64>,
    ) -> String {
        let mut state = self.inner.lock().await;
        if let Some(id) = supplied {
            return match role {
                MessageRole::User => id,
                MessageRole::Agent => format!("{id}::agent"),
                MessageRole::Thought => format!("{id}::thought"),
            };
        }
        let Some(generation) = generation else {
            // Replayed history has no run generations, so start a new message every
            // time the speaker changes. Otherwise every past turn would collapse into
            // a single user message and a single agent message.
            if state.history_role != Some(role) {
                state.history_role = Some(role);
                state.history_serial = state.history_serial.saturating_add(1);
            }
            let serial = state.history_serial;
            return format!("{}:history-{serial}:{role:?}", state.snapshot.thread_id);
        };
        // A turn is not one thought followed by one answer: an agent reasons, calls a
        // tool, reasons again, and only then answers. Reusing a single id per role for
        // the whole turn folds every later block back into the first one, so reasoning
        // that is still streaming renders above the tool calls that already ran.
        if let Some((open_role, id)) = state.open_messages.get(&generation) {
            if *open_role == role {
                return id.clone();
            }
        }
        state.live_serial = state.live_serial.saturating_add(1);
        let serial = state.live_serial;
        let id = format!(
            "{}:{generation}:{serial}:{role:?}",
            state.snapshot.thread_id
        );
        state.open_messages.insert(generation, (role, id.clone()));
        id
    }
    pub(crate) async fn agent_message_disposition(
        &self,
        message_id: &str,
    ) -> Option<crate::agent_messaging::AgentMessageDisposition> {
        let activity_id = format!("agent-message:{message_id}");
        self.inner
            .lock()
            .await
            .snapshot
            .messages
            .iter()
            .find(|message| message.id == activity_id)
            .and_then(|message| message.agent_message.as_ref())
            .map(|message| message.disposition)
    }

    pub async fn emit_prompt_transcript(
        &self,
        prompt: &[ContentBlock],
        run_id: Option<String>,
        source_turn_id: Option<String>,
        generation: Option<u64>,
        message_id: String,
    ) {
        let snapshot = self.snapshot().await;
        for block in prompt {
            if let ContentBlock::Text(text) = block {
                if let Some(envelope) =
                    crate::agent_messaging::AgentMessageEnvelope::decode(&text.text)
                        .filter(|envelope| envelope.recipient_thread_id == snapshot.thread_id)
                {
                    let disposition = self
                        .agent_message_disposition(&envelope.message_id)
                        .await
                        .unwrap_or(crate::agent_messaging::AgentMessageDisposition::Queued);
                    self.emit(CanonicalEvent::AgentMessage {
                        agent_id: snapshot.agent_id.clone(),
                        thread_id: snapshot.thread_id.clone(),
                        message: crate::agent_messaging::AgentMessageOrigin {
                            message_id: envelope.message_id,
                            direction: crate::agent_messaging::AgentMessageDirection::Received,
                            related_thread_id: envelope.sender_thread_id,
                            related_title: envelope.sender_title,
                            relation: envelope.recipient_relation.inverse(),
                            disposition,
                            body: envelope.body,
                        },
                    })
                    .await;
                    continue;
                }
            }
            let (content, content_block) = match block {
                ContentBlock::Text(text) => (text.text.clone(), None),
                block => (String::new(), serde_json::to_value(block).ok()),
            };
            self.emit(CanonicalEvent::MessageChunk {
                agent_id: snapshot.agent_id.clone(),
                thread_id: snapshot.thread_id.clone(),
                run_id: run_id.clone(),
                source_turn_id: source_turn_id.clone(),
                generation,
                role: MessageRole::User,
                message_id: message_id.clone(),
                content,
                content_block,
            })
            .await;
        }
    }

    pub async fn emit(&self, event: CanonicalEvent) {
        let mut state = self.inner.lock().await;
        match &event {
            CanonicalEvent::RunFinished { generation, .. }
            | CanonicalEvent::RunFailed { generation, .. }
                if matches!(
                    state.generation_state,
                    GenerationState::Handoff {
                        generation: active,
                        ..
                    } if active == *generation
                ) =>
            {
                state.flush_pending_agent_message_envelopes();
                state.generation_state = GenerationState::Handoff {
                    generation: *generation,
                    settled: true,
                };
                state.open_messages.remove(generation);
            }
            CanonicalEvent::RunFinished { generation, .. }
            | CanonicalEvent::RunFailed { generation, .. }
                if matches!(
                    state.generation_state,
                    GenerationState::Active(active) | GenerationState::Cancelling(active)
                        if active == *generation
                ) =>
            {
                state.flush_pending_agent_message_envelopes();
                state.generation_state = GenerationState::Terminal;
                state.open_messages.remove(generation);
            }
            CanonicalEvent::RunFinished { .. } | CanonicalEvent::RunFailed { .. } => return,
            // A tool call ends whatever message was streaming: text that follows it
            // belongs below the tool row, not appended to a bubble that sits above it.
            CanonicalEvent::Tool {
                generation: Some(generation),
                tool_call_id,
                ..
            } if !state.snapshot.tools.contains_key(tool_call_id) => {
                state.open_messages.remove(generation);
            }
            _ => {}
        }
        state.snapshot.apply(&event);
        let live = !state.snapshot.history_reconstruction;
        drop(state);
        if live && self.events.send(event).await.is_err() {
            eprintln!("ACP session canonical event mailbox closed during event delivery");
        }
    }

    /// Replays exported history into a transcript that still has none.
    ///
    /// The export is produced by a subprocess that takes seconds, and a sub-agent adopted
    /// while it is still working streams into the same session during that window. Replaying
    /// then restates the turn the live stream already recorded under a second, exported id and
    /// files the older prompt after the newer answer, so the emptiness test and the replay have
    /// to be one indivisible step rather than two awaits with a subprocess between them.
    /// History a declined replay would have carried is recovered whole the next time the
    /// session is loaded cold, which is strictly better than a duplicated, out-of-order one.
    pub async fn seed_history(&self, events: Vec<CanonicalEvent>) -> bool {
        let mut state = self.inner.lock().await;
        if state.snapshot.has_ordinary_transcript() {
            return false;
        }
        let mut seeded = SessionSnapshot::new(
            state.snapshot.agent_id.clone(),
            state.snapshot.thread_id.clone(),
        );
        for event in &events {
            seeded.apply(event);
        }
        if !seeded.has_ordinary_transcript() {
            return false;
        }
        state.snapshot.restore_transcript_from(seeded);
        let live = !state.snapshot.history_reconstruction;
        drop(state);
        if live {
            for event in events {
                if self.events.send(event).await.is_err() {
                    eprintln!("ACP session canonical event mailbox closed during history seeding");
                    break;
                }
            }
        }
        true
    }

    pub async fn fail_active(&self, message: String) {
        let Some((run_id, source_turn_id, generation)) = self.operation().await else {
            return;
        };
        self.fail_generation(run_id, source_turn_id, generation, message)
            .await;
    }

    pub async fn fail_generation(
        &self,
        run_id: String,
        source_turn_id: String,
        generation: u64,
        message: String,
    ) {
        let snapshot = self.snapshot().await;
        self.emit(CanonicalEvent::RunFailed {
            agent_id: snapshot.agent_id,
            thread_id: snapshot.thread_id,
            run_id,
            source_turn_id,
            generation,
            message,
        })
        .await;
    }
    pub async fn take_events(&self) -> Option<CanonicalEventReceiver> {
        self.event_receiver.lock().await.take()
    }
    pub async fn flush_events(&self) {
        let _ = self.events.flush().await;
    }
    pub async fn snapshot(&self) -> SessionSnapshot {
        self.inner.lock().await.snapshot.clone()
    }

    pub async fn mark_subagent_terminal(&self, child_session_id: &str, status: &str) -> bool {
        self.inner
            .lock()
            .await
            .snapshot
            .mark_subagent_terminal(child_session_id, status)
    }

    pub async fn mark_subagent_tool_terminal(&self, tool_call_id: &str, status: &str) -> bool {
        let tool_status = if matches!(
            status.trim().to_ascii_lowercase().as_str(),
            "failed" | "error" | "aborted" | "cancelled" | "canceled"
        ) {
            agent_client_protocol::schema::v1::ToolCallStatus::Failed
        } else {
            agent_client_protocol::schema::v1::ToolCallStatus::Completed
        };
        self.inner
            .lock()
            .await
            .snapshot
            .mark_subagent_tool_terminal(tool_call_id, status, tool_status)
    }

    pub async fn active_interaction_generation(&self) -> Option<u64> {
        let state = self.inner.lock().await;
        match state.generation_state {
            GenerationState::Active(generation) if !state.snapshot.history_reconstruction => {
                Some(generation)
            }
            _ => None,
        }
    }

    pub async fn is_evictable(&self) -> bool {
        let state = self.inner.lock().await;
        state.generation_state == GenerationState::Terminal
            && state.reconstruction_backup.is_none()
            && !state.snapshot.history_reconstruction
            && !state.notification_draining
            && state.notification_receipts.is_empty()
    }

    fn try_eviction_guard(&self) -> Option<OwnedMutexGuard<()>> {
        self.operation_lock.clone().try_lock_owned().ok()
    }

    pub async fn mark_cancelling(&self) -> Option<u64> {
        let mut state = self.inner.lock().await;
        let GenerationState::Active(generation) = state.generation_state else {
            return None;
        };
        state.generation_state = GenerationState::Cancelling(generation);
        Some(generation)
    }

    async fn route_notification(&self, agent_id: &str, notification: SessionNotification) {
        let received = self.capture_notification(notification).await;
        self.route_received_notifications(agent_id, std::iter::once(received))
            .await;
    }

    async fn capture_notification(
        &self,
        notification: SessionNotification,
    ) -> ReceivedSessionNotification {
        let state = self.inner.lock().await;
        let operation = match (
            state.snapshot.active_run_id.clone(),
            state.snapshot.active_source_turn_id.clone(),
            state.snapshot.active_generation,
        ) {
            (Some(run_id), Some(source_turn_id), Some(generation)) => {
                Some((run_id, source_turn_id, generation))
            }
            _ => None,
        };
        ReceivedSessionNotification {
            notification,
            operation,
            reconstruction: state.snapshot.history_reconstruction,
        }
    }

    async fn route_reconstruction_notifications(
        &self,
        agent_id: &str,
        notifications: impl IntoIterator<Item = ReceivedSessionNotification>,
    ) {
        self.route_received_notifications(agent_id, notifications)
            .await;
    }

    async fn route_received_notifications(
        &self,
        agent_id: &str,
        notifications: impl IntoIterator<Item = ReceivedSessionNotification>,
    ) {
        let mut state = self.inner.lock().await;
        for received in notifications {
            state
                .notification_receipts
                .push_back(RoutedSessionNotification {
                    agent_id: agent_id.to_string(),
                    received,
                });
        }
        if state.notification_draining {
            return;
        }
        state.notification_draining = true;
        drop(state);
        self.drain_notifications().await;
    }

    async fn drain_notifications(&self) {
        loop {
            let routed = {
                let mut state = self.inner.lock().await;
                match state.notification_receipts.pop_front() {
                    Some(routed) => routed,
                    None => {
                        state.notification_draining = false;
                        return;
                    }
                }
            };
            #[cfg(test)]
            if let Some(barrier) = self.notification_delivery_barrier.lock().await.take() {
                barrier.reached.notify_one();
                barrier.release.notified().await;
            }
            super::handlers::handle_session_notification(&routed.agent_id, self, routed.received)
                .await;
        }
    }

    #[cfg(test)]
    async fn pause_next_notification_delivery(&self) -> RegistrationBarrier {
        let barrier = RegistrationBarrier {
            reached: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
        };
        *self.notification_delivery_barrier.lock().await = Some(barrier.clone());
        barrier
    }
}

pub struct ReconstructionTransaction {
    session: AcpSession,
    _guard: OwnedMutexGuard<()>,
}

impl ReconstructionTransaction {
    pub async fn finish(self, commit: bool) {
        self.session.finish_reconstruction(commit).await;
    }
}

const PENDING_NOTIFICATION_CAPACITY: usize = 4096;
const LIVE_SESSION_CAPACITY: usize = 256;
type SessionRemovalNotice = (SessionId, oneshot::Sender<()>);
type SessionRemovalSender = mpsc::UnboundedSender<SessionRemovalNotice>;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SessionRouteError {
    #[error("ACP pre-registration notification journal overflowed at {0} entries")]
    JournalOverflow(usize),
    #[error("ACP live session capacity reached at {0} protected sessions")]
    Capacity(usize),
}

#[derive(Default)]
struct RegistryState {
    sessions: HashMap<SessionId, RegistryEntry>,
    pending_notifications: HashMap<SessionId, VecDeque<ReceivedSessionNotification>>,
    pending_notification_count: usize,
    next_access: u64,
    reservations: HashSet<u64>,
    next_reservation: u64,
}

impl RegistryState {
    fn discard_pending_notifications(&mut self, session_id: &SessionId) {
        let discarded = self
            .pending_notifications
            .remove(session_id)
            .map_or(0, |notifications| notifications.len());
        self.pending_notification_count = self
            .pending_notification_count
            .checked_sub(discarded)
            .expect("pending notification count tracks every journal entry");
    }
}

enum RegistryEntry {
    Registering {
        session: AcpSession,
        journal: VecDeque<ReceivedSessionNotification>,
        ready: tokio::sync::watch::Receiver<bool>,
    },
    Live {
        session: AcpSession,
        last_access: u64,
        leases: Arc<AtomicUsize>,
    },
    Evicting {
        session: AcpSession,
        last_access: u64,
        leases: Arc<AtomicUsize>,
    },
    Removing {
        token: Uuid,
        ready: tokio::sync::watch::Receiver<bool>,
    },
}

pub struct SessionLease {
    session: AcpSession,
    leases: Arc<AtomicUsize>,
}

impl SessionLease {
    pub fn session(&self) -> &AcpSession {
        &self.session
    }
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        self.leases.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct RegistrationBarrier {
    reached: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

#[cfg(test)]
impl RegistrationBarrier {
    pub(crate) async fn wait_until_reached(&self) {
        self.reached.notified().await;
    }

    pub(crate) fn release(&self) {
        self.release.notify_one();
    }
}

#[derive(Clone)]
pub struct SessionRegistry {
    inner: Arc<Mutex<RegistryState>>,
    capacity: usize,
    removal_listener: Arc<StdMutex<Option<SessionRemovalSender>>>,
    #[cfg(test)]
    registration_barrier: Arc<Mutex<Option<RegistrationBarrier>>>,
    #[cfg(test)]
    eviction_barrier: Arc<Mutex<Option<RegistrationBarrier>>>,
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::with_capacity(LIVE_SESSION_CAPACITY)
    }
}

impl SessionRegistry {
    #[cfg(test)]
    pub async fn register(
        &self,
        agent_id: &str,
        session_id: SessionId,
    ) -> Result<AcpSession, SessionRouteError> {
        self.register_with_freshness(agent_id, session_id)
            .await
            .map(|(session, _)| session)
    }

    pub async fn reserve(&self) -> Result<u64, SessionRouteError> {
        let mut rejected_evictions = HashSet::new();
        loop {
            let mut state = self.inner.lock().await;
            if state
                .sessions
                .len()
                .saturating_add(state.reservations.len())
                < self.capacity
            {
                let reservation = state.next_reservation;
                state.next_reservation = state.next_reservation.saturating_add(1);
                state.reservations.insert(reservation);
                return Ok(reservation);
            }
            let candidate = state
                .sessions
                .iter()
                .filter_map(|(id, entry)| match entry {
                    RegistryEntry::Live {
                        session,
                        last_access,
                        leases,
                    } if leases.load(Ordering::Acquire) == 0
                        && !rejected_evictions.contains(id) =>
                    {
                        Some((id.clone(), session.clone(), *last_access, leases.clone()))
                    }
                    _ => None,
                })
                .min_by_key(|(_, _, last_access, _)| *last_access);
            let Some((session_id, session, last_access, leases)) = candidate else {
                return Err(SessionRouteError::Capacity(self.capacity));
            };
            state.sessions.insert(
                session_id.clone(),
                RegistryEntry::Evicting {
                    session: session.clone(),
                    last_access,
                    leases: leases.clone(),
                },
            );
            drop(state);
            let Some(_operation) = session.try_eviction_guard() else {
                self.restore_eviction(&session_id, session, last_access, leases)
                    .await;
                rejected_evictions.insert(session_id);
                continue;
            };
            let mut state = self.inner.lock().await;
            let still_evicting = matches!(
                state.sessions.get(&session_id),
                Some(RegistryEntry::Evicting { session: current, .. })
                    if Arc::ptr_eq(&current.inner, &session.inner)
            );
            if still_evicting
                && leases.load(Ordering::Acquire) == 0
                && !state.pending_notifications.contains_key(&session_id)
                && session.is_evictable().await
            {
                let token = Uuid::new_v4();
                let (ready_tx, mut ready_rx) = tokio::sync::watch::channel(false);
                state.sessions.insert(
                    session_id.clone(),
                    RegistryEntry::Removing {
                        token,
                        ready: ready_rx.clone(),
                    },
                );
                drop(state);
                self.spawn_removal(session_id.clone(), token, ready_tx);
                Self::wait_for_removal(&mut ready_rx).await;
                continue;
            }
            drop(state);
            self.restore_eviction(&session_id, session, last_access, leases)
                .await;
            rejected_evictions.insert(session_id);
        }
    }

    pub async fn release_reservation(&self, reservation: u64) {
        self.inner.lock().await.reservations.remove(&reservation);
    }

    pub async fn register_reserved(
        &self,
        agent_id: &str,
        session_id: SessionId,
        reservation: u64,
    ) -> Result<AcpSession, SessionRouteError> {
        let result = self
            .register_with_freshness_reserved(agent_id, session_id, Some(reservation))
            .await
            .map(|(session, _)| session);
        self.release_reservation(reservation).await;
        result
    }

    async fn restore_eviction(
        &self,
        session_id: &SessionId,
        session: AcpSession,
        last_access: u64,
        leases: Arc<AtomicUsize>,
    ) {
        let journal = {
            let mut state = self.inner.lock().await;
            if !matches!(
                state.sessions.get(session_id),
                Some(RegistryEntry::Evicting { session: current, .. })
                    if Arc::ptr_eq(&current.inner, &session.inner)
            ) {
                return;
            }
            let journal = state
                .pending_notifications
                .remove(session_id)
                .unwrap_or_default();
            state.pending_notification_count = state
                .pending_notification_count
                .checked_sub(journal.len())
                .expect("pending notification count tracks every journal entry");
            state.sessions.insert(
                session_id.clone(),
                RegistryEntry::Live {
                    session: session.clone(),
                    last_access,
                    leases,
                },
            );
            journal
        };
        session
            .route_received_notifications(&session.snapshot().await.agent_id, journal)
            .await;
    }

    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryState::default())),
            capacity,
            removal_listener: Arc::new(StdMutex::new(None)),
            #[cfg(test)]
            registration_barrier: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            eviction_barrier: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn subscribe_removals(&self) -> mpsc::UnboundedReceiver<SessionRemovalNotice> {
        let (sender, receiver) = mpsc::unbounded_channel();
        *self
            .removal_listener
            .lock()
            .expect("session removal listener lock") = Some(sender);
        receiver
    }

    async fn notify_removed(&self, session_id: SessionId) {
        let listener = self
            .removal_listener
            .lock()
            .expect("session removal listener lock")
            .clone();
        let Some(listener) = listener else {
            return;
        };
        let (acknowledge, acknowledged) = oneshot::channel();
        if listener.send((session_id, acknowledge)).is_ok() {
            let _ = acknowledged.await;
        }
    }

    async fn complete_removal(
        &self,
        session_id: SessionId,
        token: Uuid,
        ready: tokio::sync::watch::Sender<bool>,
    ) {
        self.notify_removed(session_id.clone()).await;
        let mut state = self.inner.lock().await;
        if matches!(
            state.sessions.get(&session_id),
            Some(RegistryEntry::Removing {
                token: current, ..
            }) if *current == token
        ) {
            state.sessions.remove(&session_id);
            state.discard_pending_notifications(&session_id);
        }
        let _ = ready.send(true);
    }

    fn spawn_removal(
        &self,
        session_id: SessionId,
        token: Uuid,
        ready: tokio::sync::watch::Sender<bool>,
    ) {
        let registry = self.clone();
        tokio::spawn(async move {
            registry.complete_removal(session_id, token, ready).await;
        });
    }

    async fn wait_for_removal(ready: &mut tokio::sync::watch::Receiver<bool>) -> bool {
        while !*ready.borrow_and_update() {
            if ready.changed().await.is_err() {
                return false;
            }
        }
        true
    }

    async fn clear_abandoned_removal(&self, session_id: &SessionId, token: Uuid) {
        let mut state = self.inner.lock().await;
        if matches!(
            state.sessions.get(session_id),
            Some(RegistryEntry::Removing {
                token: current, ..
            }) if *current == token
        ) {
            state.sessions.remove(session_id);
            state.discard_pending_notifications(session_id);
        }
    }

    pub async fn register_with_freshness(
        &self,
        agent_id: &str,
        session_id: SessionId,
    ) -> Result<(AcpSession, bool), SessionRouteError> {
        self.register_with_freshness_reserved(agent_id, session_id, None)
            .await
    }

    async fn register_with_freshness_reserved(
        &self,
        agent_id: &str,
        session_id: SessionId,
        reservation: Option<u64>,
    ) -> Result<(AcpSession, bool), SessionRouteError> {
        let mut rejected_evictions = HashSet::new();
        let mut state = loop {
            let mut state = self.inner.lock().await;
            if reservation.is_some_and(|reservation| !state.reservations.contains(&reservation)) {
                return Err(SessionRouteError::Capacity(self.capacity));
            }
            if state.sessions.contains_key(&session_id) {
                let is_removing = matches!(
                    state.sessions.get(&session_id),
                    Some(RegistryEntry::Removing { .. })
                );
                if !is_removing {
                    if let Some(reservation) = reservation {
                        state.reservations.remove(&reservation);
                    }
                }
                let entry = state
                    .sessions
                    .get(&session_id)
                    .expect("checked session remains present");
                match entry {
                    RegistryEntry::Live { session, .. } => return Ok((session.clone(), false)),
                    RegistryEntry::Registering { session, ready, .. } => {
                        let session = session.clone();
                        let mut ready = ready.clone();
                        drop(state);
                        while !*ready.borrow_and_update() {
                            ready
                                .changed()
                                .await
                                .expect("registration sender remains alive with its entry");
                        }
                        return Ok((session, false));
                    }
                    RegistryEntry::Evicting {
                        session,
                        last_access,
                        leases,
                    } => {
                        let session = session.clone();
                        let last_access = *last_access;
                        let leases = leases.clone();
                        drop(state);
                        self.restore_eviction(&session_id, session.clone(), last_access, leases)
                            .await;
                        return Ok((session, false));
                    }
                    RegistryEntry::Removing { token, ready } => {
                        let token = *token;
                        let mut ready = ready.clone();
                        drop(state);
                        if !Self::wait_for_removal(&mut ready).await {
                            self.clear_abandoned_removal(&session_id, token).await;
                        }
                        continue;
                    }
                }
            }
            let occupied = state
                .sessions
                .len()
                .saturating_add(state.reservations.len());
            let own_reservation = usize::from(reservation.is_some());
            if occupied.saturating_sub(own_reservation) < self.capacity {
                break state;
            }
            let candidates = state
                .sessions
                .iter()
                .filter_map(|(id, entry)| match entry {
                    RegistryEntry::Live {
                        session,
                        last_access,
                        leases,
                    } if leases.load(Ordering::Acquire) == 0
                        && !rejected_evictions.contains(id) =>
                    {
                        Some((id.clone(), session.clone(), *last_access, leases.clone()))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            let mut evict = None;
            for candidate in candidates {
                if evict
                    .as_ref()
                    .is_none_or(|(_, _, oldest, _)| candidate.2 < *oldest)
                {
                    evict = Some(candidate);
                }
            }
            let Some((evicted_id, evicted_session, last_access, leases)) = evict else {
                return Err(SessionRouteError::Capacity(self.capacity));
            };
            state.sessions.insert(
                evicted_id.clone(),
                RegistryEntry::Evicting {
                    session: evicted_session.clone(),
                    last_access,
                    leases: leases.clone(),
                },
            );
            drop(state);

            #[cfg(test)]
            if let Some(barrier) = self.eviction_barrier.lock().await.take() {
                barrier.reached.notify_one();
                barrier.release.notified().await;
            }

            let Some(_operation) = evicted_session.try_eviction_guard() else {
                self.restore_eviction(&evicted_id, evicted_session, last_access, leases)
                    .await;
                rejected_evictions.insert(evicted_id);
                continue;
            };
            let mut state = self.inner.lock().await;
            let still_evicting = matches!(
                state.sessions.get(&evicted_id),
                Some(RegistryEntry::Evicting { session, .. })
                    if Arc::ptr_eq(&session.inner, &evicted_session.inner)
            );
            if still_evicting
                && leases.load(Ordering::Acquire) == 0
                && !state.pending_notifications.contains_key(&evicted_id)
                && evicted_session.is_evictable().await
            {
                let token = Uuid::new_v4();
                let (ready_tx, mut ready_rx) = tokio::sync::watch::channel(false);
                state.sessions.insert(
                    evicted_id.clone(),
                    RegistryEntry::Removing {
                        token,
                        ready: ready_rx.clone(),
                    },
                );
                drop(state);
                self.spawn_removal(evicted_id.clone(), token, ready_tx);
                Self::wait_for_removal(&mut ready_rx).await;
                continue;
            }
            if still_evicting {
                drop(state);
                self.restore_eviction(&evicted_id, evicted_session, last_access, leases)
                    .await;
            }
            rejected_evictions.insert(evicted_id);
        };
        let identity = super::identity::AgentSessionId::new(agent_id, session_id.to_string())
            .expect("SDK session ID is bounded by transport");
        let session = AcpSession::new(agent_id.to_string(), identity.encode());
        if state.pending_notifications.contains_key(&session_id) {
            session.inner.lock().await.snapshot.history_reconstruction = true;
        }
        let journal = state
            .pending_notifications
            .remove(&session_id)
            .unwrap_or_default();
        let (ready_tx, ready_rx) = tokio::sync::watch::channel(false);
        if let Some(reservation) = reservation {
            state.reservations.remove(&reservation);
        }
        state.sessions.insert(
            session_id.clone(),
            RegistryEntry::Registering {
                session: session.clone(),
                journal,
                ready: ready_rx,
            },
        );
        drop(state);

        #[cfg(test)]
        if let Some(barrier) = self.registration_barrier.lock().await.take() {
            barrier.reached.notify_one();
            barrier.release.notified().await;
        }

        loop {
            let notification = {
                let mut state = self.inner.lock().await;
                let Some(RegistryEntry::Registering { journal, .. }) =
                    state.sessions.get_mut(&session_id)
                else {
                    return Ok((session, false));
                };
                if let Some(notification) = journal.pop_front() {
                    state.pending_notification_count =
                        state.pending_notification_count.saturating_sub(1);
                    Some(notification)
                } else {
                    let mut inner = session.inner.lock().await;
                    inner.snapshot.history_reconstruction = false;
                    inner.snapshot.settle_unresolved_subagents_without_run();
                    drop(inner);
                    let last_access = state.next_access;
                    state.next_access = state.next_access.saturating_add(1);
                    state.sessions.insert(
                        session_id.clone(),
                        RegistryEntry::Live {
                            session: session.clone(),
                            last_access,
                            leases: Arc::new(AtomicUsize::new(0)),
                        },
                    );
                    let _ = ready_tx.send(true);
                    None
                }
            };
            let Some(notification) = notification else {
                break;
            };
            session
                .route_reconstruction_notifications(agent_id, std::iter::once(notification))
                .await;
        }
        Ok((session, true))
    }
    pub async fn get(&self, session_id: &SessionId) -> Option<AcpSession> {
        let mut state = self.inner.lock().await;
        let last_access = state.next_access;
        state.next_access = state.next_access.saturating_add(1);
        let RegistryEntry::Live {
            session,
            last_access: seen,
            ..
        } = state.sessions.get_mut(session_id)?
        else {
            return None;
        };
        *seen = last_access;
        Some(session.clone())
    }

    pub async fn lease(&self, session_id: &SessionId) -> Option<SessionLease> {
        let mut state = self.inner.lock().await;
        let last_access = state.next_access;
        state.next_access = state.next_access.saturating_add(1);
        let RegistryEntry::Live {
            session,
            last_access: seen,
            leases,
        } = state.sessions.get_mut(session_id)?
        else {
            return None;
        };
        *seen = last_access;
        leases.fetch_add(1, Ordering::AcqRel);
        Some(SessionLease {
            session: session.clone(),
            leases: leases.clone(),
        })
    }

    pub(crate) async fn stable_lease(&self, session_id: &SessionId) -> Option<SessionLease> {
        loop {
            let mut state = self.inner.lock().await;
            let last_access = state.next_access;
            state.next_access = state.next_access.saturating_add(1);
            match state.sessions.get_mut(session_id)? {
                RegistryEntry::Live {
                    session,
                    last_access: seen,
                    leases,
                } => {
                    *seen = last_access;
                    leases.fetch_add(1, Ordering::AcqRel);
                    return Some(SessionLease {
                        session: session.clone(),
                        leases: leases.clone(),
                    });
                }
                RegistryEntry::Evicting {
                    session,
                    last_access,
                    leases,
                } => {
                    let session = session.clone();
                    let last_access = *last_access;
                    let leases = leases.clone();
                    drop(state);
                    self.restore_eviction(session_id, session, last_access, leases)
                        .await;
                }
                RegistryEntry::Registering { .. } | RegistryEntry::Removing { .. } => return None,
            }
        }
    }

    pub async fn all(&self) -> Vec<AcpSession> {
        self.inner
            .lock()
            .await
            .sessions
            .values()
            .filter_map(|entry| match entry {
                RegistryEntry::Live { session, .. } => Some(session.clone()),
                RegistryEntry::Registering { .. }
                | RegistryEntry::Evicting { .. }
                | RegistryEntry::Removing { .. } => None,
            })
            .collect()
    }
    pub async fn remove(&self, session_id: &SessionId) {
        let removal = {
            let mut state = self.inner.lock().await;
            let registering_notification_count = match state.sessions.get(session_id) {
                None => {
                    state.discard_pending_notifications(session_id);
                    return;
                }
                Some(RegistryEntry::Removing { token, ready }) => {
                    let token = *token;
                    let mut ready = ready.clone();
                    drop(state);
                    if !Self::wait_for_removal(&mut ready).await {
                        self.clear_abandoned_removal(session_id, token).await;
                    }
                    return;
                }
                Some(RegistryEntry::Registering { journal, .. }) => journal.len(),
                Some(_) => 0,
            };
            state.discard_pending_notifications(session_id);
            state.pending_notification_count = state
                .pending_notification_count
                .checked_sub(registering_notification_count)
                .expect("pending notification count tracks every journal entry");
            let token = Uuid::new_v4();
            let (ready_tx, ready_rx) = tokio::sync::watch::channel(false);
            state.sessions.insert(
                session_id.clone(),
                RegistryEntry::Removing {
                    token,
                    ready: ready_rx.clone(),
                },
            );
            (token, ready_tx, ready_rx)
        };
        let (token, ready_tx, mut ready_rx) = removal;
        self.spawn_removal(session_id.clone(), token, ready_tx);
        Self::wait_for_removal(&mut ready_rx).await;
    }
    pub async fn route(
        &self,
        agent_id: &str,
        notification: SessionNotification,
    ) -> Result<(), SessionRouteError> {
        let mut state = self.inner.lock().await;
        if let Some(RegistryEntry::Live {
            session, leases, ..
        }) = state.sessions.get(&notification.session_id)
        {
            let session = session.clone();
            let leases = leases.clone();
            leases.fetch_add(1, Ordering::AcqRel);
            drop(state);
            session.route_notification(agent_id, notification).await;
            leases.fetch_sub(1, Ordering::AcqRel);
            return Ok(());
        }
        if matches!(
            state.sessions.get(&notification.session_id),
            Some(RegistryEntry::Removing { .. })
        ) {
            return Ok(());
        }
        if let Some(RegistryEntry::Evicting { session, .. }) =
            state.sessions.get(&notification.session_id)
        {
            let session = session.clone();
            drop(state);
            let received = session.capture_notification(notification).await;
            let session_id = received.notification.session_id.clone();
            let mut state = self.inner.lock().await;
            if matches!(
                state.sessions.get(&session_id),
                Some(RegistryEntry::Live { session: current, .. })
                    if Arc::ptr_eq(&current.inner, &session.inner)
            ) {
                drop(state);
                session
                    .route_received_notifications(agent_id, std::iter::once(received))
                    .await;
                return Ok(());
            }
            if matches!(
                state.sessions.get(&session_id),
                Some(RegistryEntry::Removing { .. })
            ) {
                return Ok(());
            }
            if state.pending_notification_count >= PENDING_NOTIFICATION_CAPACITY {
                return Err(SessionRouteError::JournalOverflow(
                    PENDING_NOTIFICATION_CAPACITY,
                ));
            }
            state
                .pending_notifications
                .entry(session_id)
                .or_default()
                .push_back(received);
            state.pending_notification_count += 1;
            return Ok(());
        }
        if state.pending_notification_count >= PENDING_NOTIFICATION_CAPACITY {
            return Err(SessionRouteError::JournalOverflow(
                PENDING_NOTIFICATION_CAPACITY,
            ));
        }
        if let Some(RegistryEntry::Registering { journal, .. }) =
            state.sessions.get_mut(&notification.session_id)
        {
            journal.push_back(ReceivedSessionNotification {
                notification,
                operation: None,
                reconstruction: true,
            });
            state.pending_notification_count += 1;
            return Ok(());
        }
        let session_id = notification.session_id.clone();
        state
            .pending_notifications
            .entry(session_id)
            .or_default()
            .push_back(ReceivedSessionNotification {
                notification,
                operation: None,
                reconstruction: true,
            });
        state.pending_notification_count += 1;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) async fn pause_next_registration(&self) -> RegistrationBarrier {
        let barrier = RegistrationBarrier {
            reached: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
        };
        *self.registration_barrier.lock().await = Some(barrier.clone());
        barrier
    }

    #[cfg(test)]
    pub(crate) async fn pause_next_eviction(&self) -> RegistrationBarrier {
        let barrier = RegistrationBarrier {
            reached: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
        };
        *self.eviction_barrier.lock().await = Some(barrier.clone());
        barrier
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

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
            Some(("run".into(), "turn".into(), generation))
        );
        assert_eq!(
            session.active_interaction_generation().await,
            Some(generation)
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
            "id"
        );
        assert_eq!(
            session
                .message_id_for_generation(MessageRole::Agent, Some("id".into()), None)
                .await,
            "id::agent"
        );
        assert_eq!(
            session
                .message_id_for_generation(MessageRole::Thought, Some("id".into()), None)
                .await,
            "id::thought"
        );
        let first = session
            .message_id_for_generation(MessageRole::User, None, None)
            .await;
        assert_eq!(
            session
                .message_id_for_generation(MessageRole::User, None, None)
                .await,
            first
        );
        assert_ne!(
            session
                .message_id_for_generation(MessageRole::Agent, None, None)
                .await,
            first
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
            "<<<dappercode.dev/agent-message:v1>>>\n", "\n<<<dappercode.dev/agent-message:end>>>"
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
            crate::agent_messaging::AgentMessageDisposition::Steering
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
            ["before", "partial-prefix", "second-prefix", "after"]
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
            ["first-prefix", "second-prefix", "after"]
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
                stop_reason: agent_client_protocol::schema::v1::StopReason::Cancelled,
            })
            .await;
        let (successor_generation, _) = session
            .admit_handoff("run".to_string(), "turn".to_string())
            .await
            .expect("successor admission");
        assert_eq!(
            session.operation().await,
            Some(("run".to_string(), "turn".to_string(), successor_generation))
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
            Some(("run".to_string(), "turn".to_string(), successor_generation))
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
            Some(("run".to_string(), "turn".to_string(), generation))
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
                stop_reason: agent_client_protocol::schema::v1::StopReason::Cancelled,
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
            "thread:history-1:Agent"
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
            Some(("run".to_string(), "turn".to_string(), 1))
        );
        assert_eq!(
            session
                .message_id(MessageRole::Agent, Some("supplied".to_string()))
                .await,
            "supplied::agent"
        );
        assert_eq!(
            session
                .message_id(MessageRole::Thought, Some("supplied".to_string()))
                .await,
            "supplied::thought"
        );
        let generated = session.message_id(MessageRole::Thought, None).await;
        assert_eq!(generated, "thread:1:1:Thought");
        assert_eq!(
            session.message_id(MessageRole::Thought, None).await,
            generated
        );
        // Switching speaker mid-turn opens a new message so the answer renders after
        // the reasoning instead of being folded into a bubble that already streamed.
        let answer = session.message_id(MessageRole::Agent, None).await;
        assert_eq!(answer, "thread:1:2:Agent");
        assert_eq!(
            session.message_id(MessageRole::Thought, None).await,
            "thread:1:3:Thought",
            "reasoning that resumes after the answer must not reopen the first block"
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
                        stop_reason: agent_client_protocol::schema::v1::StopReason::EndTurn,
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
            late.snapshot().await.thread_id
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
            ))
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
                )
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
                .thread_id
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
            ["during-eviction::agent", "during-eviction-2::agent"]
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
            ))
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
            ))
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
            Err(SessionRouteError::Capacity(1))
        );
        protected.fail_active("complete".into()).await;

        let reservation = registry.reserve().await.unwrap();
        assert!(registry.get(&protected_id).await.is_none());
        assert_eq!(
            registry.reserve().await,
            Err(SessionRouteError::Capacity(1))
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
            Err(SessionRouteError::Capacity(1))
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
            session.snapshot().await.thread_id
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
            Some((Some("run-1".into()), Some("turn-1".into()), Some(1)))
        );
        assert_eq!(
            session.operation().await,
            Some(("run-2".into(), "turn-2".into(), 2))
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
            Some((Some("run-2".into()), Some("turn-2".into()), Some(2)))
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
            ["user", "assistant", "agent-message:message-from-child"]
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
            Some("message-from-child")
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
            ["user", "assistant", "agent-message:message-from-child"]
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
            "each replayed user turn gets its own message"
        );
        assert_ne!(
            ids[1], ids[4],
            "each replayed agent turn gets its own message"
        );
        assert_eq!(
            ids.iter().collect::<std::collections::HashSet<_>>().len(),
            4
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
                if commit { "loaded" } else { "old" }
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
                stop_reason: agent_client_protocol::schema::v1::StopReason::Cancelled,
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
            Some(ReconstructionError::Busy)
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
            "supplied::agent"
        );
        let generated = session.message_id(MessageRole::Agent, None).await;
        assert_eq!(generated, "thread:history-1:Agent");
        assert_eq!(
            session.message_id(MessageRole::Agent, None).await,
            generated
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
                stop_reason: agent_client_protocol::schema::v1::StopReason::EndTurn,
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
                stop_reason: agent_client_protocol::schema::v1::StopReason::EndTurn,
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
            duplicate.snapshot().await.thread_id
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
}
