#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "session_tests.rs"]
pub(crate) mod tests;

use super::events::{
    canonical_event_channel, CanonicalEvent, CanonicalEventReceiver, CanonicalEventSender,
    MessageRole,
};
use super::snapshot::SessionSnapshot;
use agent_client_protocol::v1::schema::{ContentBlock, SessionId, SessionNotification};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{mpsc, oneshot, Mutex, OwnedMutexGuard};
use uuid::Uuid;

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
    notification_delivery_barrier: Arc<Mutex<Option<tests::RegistrationBarrier>>>,
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
struct SessionState {
    snapshot: SessionSnapshot,
    reconstruction_backup: Option<SessionSnapshot>,
    reconstruction_history_cursor: Option<(Option<MessageRole>, u64)>,
    next_generation: u64,
    generation_state: GenerationState,
    /// The message each live run is currently streaming into, keyed by generation.
    /// Only one message per generation is ever open, so anything that interrupts the
    /// stream (the speaker changing or a tool call landing) starts a new one.
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

    pub(super) async fn runtime_activity(&self) -> (usize, usize) {
        let state = self.inner.lock().await;
        (
            usize::from(state.snapshot.active_run_id.is_some()),
            usize::from(
                state.snapshot.history_reconstruction || !state.snapshot.active_tool_ids.is_empty(),
            ),
        )
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
        let backup_absent = state.reconstruction_backup.is_none();
        debug_assert!(backup_absent);
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
        let backup_absent = state.reconstruction_backup.is_none();
        debug_assert!(backup_absent);
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
                | GenerationState::Handoff { .. },
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
            state.snapshot.thread_id,
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
                    } if active == *generation,
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
                        if active == *generation,
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
            "failed" | "error" | "aborted" | "cancelled" | "canceled",
        ) {
            agent_client_protocol::v1::schema::ToolCallStatus::Failed
        } else {
            agent_client_protocol::v1::schema::ToolCallStatus::Completed
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
            let delivery_barrier = self.notification_delivery_barrier.lock().await.take();
            #[cfg(test)]
            if let Some(barrier) = delivery_barrier {
                barrier.reached.notify_one();
                barrier.release.notified().await;
            }
            super::handlers::handle_session_notification(&routed.agent_id, self, routed.received)
                .await;
        }
    }

    #[cfg(test)]
    async fn pause_next_notification_delivery(&self) -> tests::RegistrationBarrier {
        let barrier = tests::RegistrationBarrier {
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

#[derive(Clone)]
pub struct SessionRegistry {
    inner: Arc<Mutex<RegistryState>>,
    capacity: usize,
    removal_listener: Arc<StdMutex<Option<SessionRemovalSender>>>,
    #[cfg(test)]
    registration_barrier: Arc<Mutex<Option<tests::RegistrationBarrier>>>,
    #[cfg(test)]
    eviction_barrier: Arc<Mutex<Option<tests::RegistrationBarrier>>>,
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

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
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
                    if Arc::ptr_eq(&current.inner, &session.inner),
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
                    if Arc::ptr_eq(&current.inner, &session.inner),
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
            }) if *current == token,
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
            }) if *current == token,
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
                    Some(RegistryEntry::Removing { .. }),
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
            let eviction_barrier = self.eviction_barrier.lock().await.take();
            #[cfg(test)]
            if let Some(barrier) = eviction_barrier {
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
                    if Arc::ptr_eq(&session.inner, &evicted_session.inner),
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
        let registration_barrier = self.registration_barrier.lock().await.take();
        #[cfg(test)]
        if let Some(barrier) = registration_barrier {
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
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
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
            Some(RegistryEntry::Removing { .. }),
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
                    if Arc::ptr_eq(&current.inner, &session.inner),
            ) {
                drop(state);
                session
                    .route_received_notifications(agent_id, std::iter::once(received))
                    .await;
                return Ok(());
            }
            if matches!(
                state.sessions.get(&session_id),
                Some(RegistryEntry::Removing { .. }),
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
    pub(crate) async fn pause_next_registration(&self) -> tests::RegistrationBarrier {
        let barrier = tests::RegistrationBarrier {
            reached: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
        };
        *self.registration_barrier.lock().await = Some(barrier.clone());
        barrier
    }

    #[cfg(test)]
    pub(crate) async fn pause_next_eviction(&self) -> tests::RegistrationBarrier {
        let barrier = tests::RegistrationBarrier {
            reached: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
        };
        *self.eviction_barrier.lock().await = Some(barrier.clone());
        barrier
    }
}
