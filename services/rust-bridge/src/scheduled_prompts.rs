#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::bridge_protocol::{
    BridgeQueueService, BridgeThreadQueueDisposition, BridgeThreadQueueSendRequest,
    BridgeThreadSchedulesState,
};
use crate::client_hub::ClientHub;
use crate::queue_service::QueueSubmissionCancelOutcome;
use dappercode_bridge_core::resource_limits::{
    truncate_utf8_bytes, QUEUE_MAX_CONTENT_BYTES, QUEUE_MAX_ITEM_BYTES,
};

const SCHEDULER_STATE_VERSION: u32 = 1;
const SCHEDULER_STATE_MAX_BYTES: usize = 8 * 1024 * 1024;
const SCHEDULES_PER_THREAD_MAX: usize = 100;
const SCHEDULE_IDENTIFIER_MAX_BYTES: usize = 128;
const SCHEDULER_ERROR_MAX_BYTES: usize = 1024;
const SCHEDULE_PROMPT_PREVIEW_MAX_BYTES: usize = 256;
const RETRY_MIN: Duration = Duration::from_millis(250);
const RETRY_MAX: Duration = Duration::from_secs(30);
const MAX_WORKER_SLEEP: Duration = Duration::from_secs(24 * 60 * 60);
const SCHEDULER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub(crate) enum ScheduledPromptError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Internal(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StoredScheduledPromptStatus {
    Scheduled,
    Queued,
    Retrying,
    Cancelling,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredScheduledPrompt {
    schedule_id: String,
    thread_id: String,
    prompt: String,
    scheduled_for: DateTime<Utc>,
    created_at: DateTime<Utc>,
    status: StoredScheduledPromptStatus,
    retry_attempt: u32,
    next_attempt_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduledPromptState {
    version: u32,
    prompts: BTreeMap<String, StoredScheduledPrompt>,
}

impl Default for ScheduledPromptState {
    fn default() -> Self {
        Self {
            version: SCHEDULER_STATE_VERSION,
            prompts: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ScheduledPromptStatus {
    Scheduled,
    Queued,
    Retrying,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduledPromptMetadata {
    pub(crate) schedule_id: String,
    pub(crate) thread_id: String,
    pub(crate) prompt: String,
    pub(crate) prompt_bytes: usize,
    pub(crate) scheduled_for: String,
    pub(crate) created_at: String,
    pub(crate) status: ScheduledPromptStatus,
    pub(crate) retry_attempt: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduledPromptSummary {
    pub(crate) schedule_id: String,
    pub(crate) thread_id: String,
    pub(crate) prompt_preview: String,
    pub(crate) prompt_bytes: usize,
    pub(crate) scheduled_for: String,
    pub(crate) created_at: String,
    pub(crate) status: ScheduledPromptStatus,
    pub(crate) retry_attempt: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CancelScheduledPromptStatus {
    Cancelled,
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelScheduledPromptResult {
    pub(crate) schedule_id: String,
    pub(crate) status: CancelScheduledPromptStatus,
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
pub(crate) struct ScheduledPromptService {
    path: Option<PathBuf>,
    queue: Weak<BridgeQueueService>,
    hub: Arc<ClientHub>,
    state: Mutex<ScheduledPromptState>,
    operation: Arc<Mutex<()>>,
    retirement_fence: Arc<crate::queue_service::ThreadRetirementFence>,
    wake: Arc<Notify>,
    cancellation: CancellationToken,
    task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
    retry_min: Duration,
    retry_max: Duration,
    #[cfg(test)]
    fail_next_persist: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    cancellation_persisted: StdMutex<Option<Arc<Notify>>>,
    #[cfg(test)]
    worker_cycle_completed: StdMutex<Option<Arc<Notify>>>,
    #[cfg(test)]
    process_ready_operation_barrier: StdMutex<Option<(Arc<Notify>, Arc<Notify>)>>,
}

pub(crate) struct ScheduledPromptRetirement {
    thread_ids: Vec<String>,
    previous: ScheduledPromptState,
    _operation_guard: tokio::sync::OwnedMutexGuard<()>,
}

impl ScheduledPromptService {
    #[cfg(test)]
    pub(crate) async fn start(
        path: PathBuf,
        queue: Weak<BridgeQueueService>,
        hub: Arc<ClientHub>,
    ) -> Result<Arc<Self>, String> {
        let service = Self::start_paused(path, queue, hub).await?;
        service.start_worker()?;
        Ok(service)
    }

    pub(crate) async fn start_paused(
        path: PathBuf,
        queue: Weak<BridgeQueueService>,
        hub: Arc<ClientHub>,
    ) -> Result<Arc<Self>, String> {
        let state = load_state(&path).await?;
        Ok(Self::build_with_state(
            Some(path),
            queue,
            hub,
            state,
            RETRY_MIN,
            RETRY_MAX,
        ))
    }

    #[cfg(test)]
    fn start_with_state(
        path: Option<PathBuf>,
        queue: Weak<BridgeQueueService>,
        hub: Arc<ClientHub>,
        state: ScheduledPromptState,
        retry_min: Duration,
        retry_max: Duration,
    ) -> Arc<Self> {
        let service = Self::build_with_state(path, queue, hub, state, retry_min, retry_max);
        service
            .start_worker()
            .expect("new scheduled prompt worker starts");
        service
    }

    fn build_with_state(
        path: Option<PathBuf>,
        queue: Weak<BridgeQueueService>,
        hub: Arc<ClientHub>,
        state: ScheduledPromptState,
        retry_min: Duration,
        retry_max: Duration,
    ) -> Arc<Self> {
        let retirement_fence = queue
            .upgrade()
            .map(|queue| queue.retirement_fence.clone())
            .unwrap_or_default();
        let service = Arc::new(Self {
            path,
            queue,
            hub,
            state: Mutex::new(state),
            operation: Arc::new(Mutex::new(())),
            retirement_fence,
            wake: Arc::new(Notify::new()),
            cancellation: CancellationToken::new(),
            task: StdMutex::new(None),
            retry_min,
            retry_max,
            #[cfg(test)]
            fail_next_persist: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            cancellation_persisted: StdMutex::new(None),
            #[cfg(test)]
            worker_cycle_completed: StdMutex::new(None),
            #[cfg(test)]
            process_ready_operation_barrier: StdMutex::new(None),
        });
        if let Some(queue) = service.queue.upgrade() {
            queue.attach_submission_completion_wake(&service.wake);
        }
        service
    }

    pub(crate) fn start_worker(self: &Arc<Self>) -> Result<(), String> {
        let mut task_slot = self.task.lock().unwrap_or_else(|error| error.into_inner());
        if task_slot.is_some() {
            return Err("scheduled prompt worker is already running".to_string());
        }
        let weak = Arc::downgrade(self);
        let cancellation = self.cancellation.clone();
        let wake = self.wake.clone();
        let task = tokio::spawn(async move {
            worker_loop(weak, cancellation, wake).await;
        });
        *task_slot = Some(task);
        drop(task_slot);
        self.wake.notify_one();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn inert_for_test() -> Arc<Self> {
        Arc::new(Self {
            path: None,
            queue: Weak::new(),
            hub: Arc::new(ClientHub::new()),
            state: Mutex::new(ScheduledPromptState::default()),
            operation: Arc::new(Mutex::new(())),
            retirement_fence: Arc::new(crate::queue_service::ThreadRetirementFence::default()),
            wake: Arc::new(Notify::new()),
            cancellation: CancellationToken::new(),
            task: StdMutex::new(None),
            retry_min: Duration::from_millis(10),
            retry_max: Duration::from_millis(40),
            fail_next_persist: std::sync::atomic::AtomicBool::new(false),
            cancellation_persisted: StdMutex::new(None),
            worker_cycle_completed: StdMutex::new(None),
            process_ready_operation_barrier: StdMutex::new(None),
        })
    }

    #[cfg(test)]
    async fn make_due_for_test(&self, schedule_id: &str) {
        let _operation = self.operation.lock().await;
        let mut next = self.state.lock().await.clone();
        let entry = next
            .prompts
            .get_mut(schedule_id)
            .expect("scheduled prompt exists");
        let due = Utc::now() - chrono::Duration::seconds(1);
        entry.created_at = due - chrono::Duration::seconds(1);
        entry.scheduled_for = due;
        entry.next_attempt_at = due;
        self.commit(next).await.expect("test due state persists");
        self.wake.notify_one();
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(crate) async fn schedule(
        &self,
        thread_id: &str,
        prompt: String,
        scheduled_for: &str,
    ) -> Result<ScheduledPromptMetadata, ScheduledPromptError> {
        validate_thread_id(thread_id).map_err(ScheduledPromptError::Invalid)?;
        if prompt.trim().is_empty() {
            return Err(ScheduledPromptError::Invalid(
                "prompt must not be empty".to_string(),
            ));
        }
        if prompt.len() > QUEUE_MAX_CONTENT_BYTES {
            return Err(ScheduledPromptError::Invalid(format!(
                "prompt must be at most {QUEUE_MAX_CONTENT_BYTES} bytes",
            )));
        }
        validate_prompt_queue_encoding(&prompt).map_err(ScheduledPromptError::Invalid)?;
        let scheduled_for = DateTime::parse_from_rfc3339(scheduled_for)
            .map_err(|_| {
                ScheduledPromptError::Invalid(
                    "scheduledFor must be an absolute RFC 3339 timestamp".to_string(),
                )
            })?
            .with_timezone(&Utc);
        let now = Utc::now();
        if scheduled_for <= now {
            return Err(ScheduledPromptError::Invalid(
                "scheduledFor must be strictly in the future".to_string(),
            ));
        }

        let _retirement_admission = self
            .retirement_fence
            .admit(thread_id)
            .await
            .map_err(ScheduledPromptError::Internal)?;
        let _operation = self.operation.lock().await;
        let mut next = self.state.lock().await.clone();
        if next
            .prompts
            .values()
            .filter(|entry| entry.thread_id == thread_id)
            .count()
            >= SCHEDULES_PER_THREAD_MAX
        {
            return Err(ScheduledPromptError::Invalid(format!(
                "pending schedule limit reached for thread (max {SCHEDULES_PER_THREAD_MAX})",
            )));
        }
        let schedule_id = loop {
            let candidate = Uuid::new_v4().to_string();
            if !next.prompts.contains_key(&candidate) {
                break candidate;
            }
        };
        let entry = StoredScheduledPrompt {
            schedule_id: schedule_id.clone(),
            thread_id: thread_id.to_string(),
            prompt,
            scheduled_for,
            created_at: now,
            status: StoredScheduledPromptStatus::Scheduled,
            retry_attempt: 0,
            next_attempt_at: scheduled_for,
            last_error: None,
        };
        let result = metadata(&entry).expect("new schedules have a public status");
        next.prompts.insert(schedule_id, entry);
        encode_state(&next).map_err(ScheduledPromptError::Invalid)?;
        self.commit(next).await?;
        self.broadcast_thread(thread_id).await;
        self.wake.notify_one();
        Ok(result)
    }

    pub(crate) async fn list(&self, thread_id: &str) -> Vec<ScheduledPromptMetadata> {
        let mut prompts = self
            .state
            .lock()
            .await
            .prompts
            .values()
            .filter(|entry| entry.thread_id == thread_id)
            .filter_map(metadata)
            .collect::<Vec<_>>();
        prompts.sort_by(|left, right| {
            left.scheduled_for
                .cmp(&right.scheduled_for)
                .then_with(|| left.schedule_id.cmp(&right.schedule_id))
        });
        prompts
    }

    pub(crate) async fn read(&self, thread_id: &str) -> BridgeThreadSchedulesState {
        let mut schedules = self
            .state
            .lock()
            .await
            .prompts
            .values()
            .filter(|entry| entry.thread_id == thread_id)
            .filter_map(summary)
            .collect::<Vec<_>>();
        schedules.sort_by(|left, right| {
            left.scheduled_for
                .cmp(&right.scheduled_for)
                .then_with(|| left.schedule_id.cmp(&right.schedule_id))
        });
        BridgeThreadSchedulesState {
            thread_id: thread_id.to_string(),
            schedules,
        }
    }

    pub(crate) async fn pending_count(&self) -> usize {
        self.state.lock().await.prompts.len()
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(crate) async fn cancel(
        &self,
        thread_id: &str,
        schedule_id: &str,
    ) -> Result<CancelScheduledPromptResult, ScheduledPromptError> {
        validate_schedule_id(schedule_id).map_err(ScheduledPromptError::Invalid)?;
        let _retirement_admission = self
            .retirement_fence
            .admit(thread_id)
            .await
            .map_err(ScheduledPromptError::Internal)?;
        let _operation = self.operation.lock().await;
        let current = self.state.lock().await.clone();
        let Some(entry) = current.prompts.get(schedule_id) else {
            return Ok(cancel_result(
                schedule_id,
                CancelScheduledPromptStatus::NotFound,
            ));
        };
        if entry.thread_id != thread_id {
            return Ok(cancel_result(
                schedule_id,
                CancelScheduledPromptStatus::NotFound,
            ));
        }

        let mut cancelling = current;
        let entry = cancelling
            .prompts
            .get_mut(schedule_id)
            .expect("entry came from the same snapshot");
        entry.status = StoredScheduledPromptStatus::Cancelling;
        entry.next_attempt_at = Utc::now();
        entry.last_error = None;
        self.commit(cancelling).await?;
        #[cfg(test)]
        let persisted = self
            .cancellation_persisted
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        #[cfg(test)]
        if let Some(notify) = persisted {
            notify.notify_one();
        }

        let queue = self.queue.upgrade().ok_or_else(|| {
            ScheduledPromptError::Internal("scheduled prompt queue is shutting down".to_string())
        })?;
        let submission_id = submission_id(schedule_id);
        let outcome = match queue.cancel_submission(thread_id, &submission_id).await {
            Ok(outcome) => outcome,
            Err(error) => {
                self.record_cancellation_retry(schedule_id, error.clone())
                    .await?;
                self.wake.notify_one();
                return Err(ScheduledPromptError::Internal(error));
            }
        };
        let mut next = self.state.lock().await.clone();
        next.prompts.remove(schedule_id);
        self.commit(next).await?;
        self.broadcast_thread(thread_id).await;
        self.wake.notify_one();
        Ok(cancel_result(
            schedule_id,
            if outcome == QueueSubmissionCancelOutcome::Sent {
                CancelScheduledPromptStatus::NotFound
            } else {
                CancelScheduledPromptStatus::Cancelled
            },
        ))
    }

    pub(crate) async fn begin_thread_retirement(
        &self,
        thread_ids: &[String],
    ) -> Result<ScheduledPromptRetirement, ScheduledPromptError> {
        let mut thread_ids = thread_ids
            .iter()
            .map(String::as_str)
            .map(str::trim)
            .map(str::to_string)
            .collect::<Vec<_>>();
        for thread_id in &thread_ids {
            validate_thread_id(thread_id).map_err(ScheduledPromptError::Invalid)?;
        }
        thread_ids.sort();
        thread_ids.dedup();
        let operation_guard = self.operation.clone().lock_owned().await;
        let previous = self.state.lock().await.clone();
        Ok(ScheduledPromptRetirement {
            thread_ids,
            previous,
            _operation_guard: operation_guard,
        })
    }

    pub(crate) async fn commit_thread_retirement(
        &self,
        retirement: &ScheduledPromptRetirement,
    ) -> Result<(), ScheduledPromptError> {
        let thread_ids = &retirement.thread_ids;
        let retired = thread_ids
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let mut next = retirement.previous.clone();
        next.prompts
            .retain(|_, entry| !retired.contains(&entry.thread_id));
        self.commit(next).await?;
        Ok(())
    }

    pub(crate) async fn rollback_thread_retirement(&self, retirement: ScheduledPromptRetirement) {
        let ScheduledPromptRetirement {
            thread_ids: _thread_ids,
            previous: _previous,
            _operation_guard: operation_guard,
        } = retirement;
        drop(operation_guard);
    }

    pub(crate) async fn publish_thread_retirement(&self, thread_ids: &[String]) {
        for thread_id in thread_ids {
            self.broadcast_thread(thread_id).await;
        }
        self.wake.notify_one();
    }

    async fn record_cancellation_retry(
        &self,
        schedule_id: &str,
        error: String,
    ) -> Result<(), ScheduledPromptError> {
        let mut next = self.state.lock().await.clone();
        let Some(entry) = next.prompts.get_mut(schedule_id) else {
            return Ok(());
        };
        entry.retry_attempt = entry.retry_attempt.saturating_add(1);
        entry.next_attempt_at = Utc::now()
            + chrono::Duration::from_std(self.retry_delay(entry.retry_attempt))
                .expect("scheduler retry delays are bounded to 30 seconds");
        entry.last_error = Some(truncate_error(error));
        self.commit(next).await
    }

    async fn settle_delivered(&self, entry: &StoredScheduledPrompt) {
        let mut next = self.state.lock().await.clone();
        next.prompts.remove(&entry.schedule_id);
        if let Err(error) = self.commit(next).await {
            eprintln!(
                "failed to settle delivered scheduled prompt {}: {error}",
                entry.schedule_id,
            );
        } else {
            self.broadcast_thread(&entry.thread_id).await;
        }
    }

    async fn commit(&self, next: ScheduledPromptState) -> Result<(), ScheduledPromptError> {
        #[cfg(test)]
        if self
            .fail_next_persist
            .swap(false, std::sync::atomic::Ordering::AcqRel)
        {
            return Err(ScheduledPromptError::Internal(
                "injected scheduled prompt persistence failure".to_string(),
            ));
        }
        let bytes = encode_state(&next).map_err(ScheduledPromptError::Internal)?;
        if let Some(path) = &self.path {
            crate::storage::atomic_write_private(path, &bytes)
                .await
                .map_err(|error| {
                    ScheduledPromptError::Internal(format!(
                        "failed to persist scheduled prompt state: {error}",
                    ))
                })?;
        }
        *self.state.lock().await = next;
        Ok(())
    }

    async fn broadcast_thread(&self, thread_id: &str) {
        let snapshot = self.read(thread_id).await;
        let value = serde_json::to_value(snapshot).expect("scheduled prompt snapshot serializes");
        self.hub
            .broadcast_notification("bridge/thread/schedules/updated", value)
            .await;
    }

    async fn next_wake(&self) -> Option<DateTime<Utc>> {
        self.state
            .lock()
            .await
            .prompts
            .values()
            .map(|entry| entry.next_attempt_at)
            .min()
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn settle_completed_submissions(&self) {
        let queued = self
            .state
            .lock()
            .await
            .prompts
            .values()
            .filter(|entry| entry.status == StoredScheduledPromptStatus::Queued)
            .cloned()
            .collect::<Vec<_>>();
        if queued.is_empty() {
            return;
        }
        let mut thread_ids = queued
            .iter()
            .map(|entry| entry.thread_id.as_str())
            .collect::<Vec<_>>();
        thread_ids.sort_unstable();
        thread_ids.dedup();
        let _retirement_admission = match self.retirement_fence.admit_threads(&thread_ids).await {
            Ok(admission) => admission,
            Err(_) => return,
        };
        let _operation = self.operation.lock().await;
        let Some(queue) = self.queue.upgrade() else {
            return;
        };
        let current = self.state.lock().await.clone();
        let mut completed = Vec::new();
        for entry in queued.into_iter().filter(|entry| {
            current
                .prompts
                .get(&entry.schedule_id)
                .is_some_and(|stored| {
                    stored.thread_id == entry.thread_id
                        && stored.status == StoredScheduledPromptStatus::Queued
                })
        }) {
            match queue
                .submission_was_sent(&entry.thread_id, &submission_id(&entry.schedule_id))
                .await
            {
                Ok(true) => completed.push(entry),
                Ok(false) => {}
                Err(error) => {
                    eprintln!(
                        "failed to inspect queued scheduled prompt {}: {error}",
                        entry.schedule_id,
                    );
                }
            }
        }
        if completed.is_empty() {
            return;
        }
        let mut next = self.state.lock().await.clone();
        for entry in &completed {
            next.prompts.remove(&entry.schedule_id);
        }
        if let Err(error) = self.commit(next).await {
            eprintln!("failed to settle dispatched scheduled prompts: {error}");
            return;
        }
        completed.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
        completed.dedup_by(|left, right| left.thread_id == right.thread_id);
        for entry in completed {
            self.broadcast_thread(&entry.thread_id).await;
        }
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
    async fn process_ready(&self) {
        let Some(candidate) = self
            .state
            .lock()
            .await
            .prompts
            .values()
            .filter(|entry| entry.next_attempt_at <= Utc::now())
            .min_by(|left, right| {
                left.next_attempt_at
                    .cmp(&right.next_attempt_at)
                    .then_with(|| left.schedule_id.cmp(&right.schedule_id))
            })
            .cloned()
        else {
            return;
        };
        let _retirement_admission = match self.retirement_fence.admit(&candidate.thread_id).await {
            Ok(admission) => admission,
            Err(_) => return,
        };
        let queue_to_wake = {
            let _operation = self.operation.lock().await;
            #[cfg(test)]
            let process_ready_operation_barrier = {
                self.process_ready_operation_barrier
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take()
            };
            #[cfg(test)]
            if let Some((reached, release)) = process_ready_operation_barrier {
                reached.notify_one();
                release.notified().await;
            }
            let now = Utc::now();
            let current = self.state.lock().await.clone();
            let Some(entry) = current.prompts.get(&candidate.schedule_id).cloned() else {
                return;
            };
            if entry.next_attempt_at > now {
                return;
            }
            let Some(queue) = self.queue.upgrade() else {
                return;
            };

            if entry
                .last_error
                .as_deref()
                .is_some_and(crate::queue_service::definitive_settlement_was_interrupted)
            {
                let dispatch_error = entry
                    .last_error
                    .as_deref()
                    .expect("interrupted settlement error was checked");
                if let Err(error) = queue
                    .settle_interrupted_definitive_failure(
                        &entry.thread_id,
                        &submission_id(&entry.schedule_id),
                        dispatch_error,
                    )
                    .await
                {
                    let mut next = self.state.lock().await.clone();
                    if let Some(stored) = next.prompts.get_mut(&entry.schedule_id) {
                        stored.status = StoredScheduledPromptStatus::Retrying;
                        stored.retry_attempt = stored.retry_attempt.saturating_add(1);
                        stored.next_attempt_at = Utc::now()
                            + chrono::Duration::from_std(self.retry_delay(stored.retry_attempt))
                                .expect("scheduler retry delays are bounded to 30 seconds");
                        stored.last_error = Some(truncate_error(error));
                    }
                    if let Err(error) = self.commit(next).await {
                        eprintln!(
                            "failed to persist definitive settlement retry {}: {error}",
                            entry.schedule_id,
                        );
                    } else {
                        self.broadcast_thread(&entry.thread_id).await;
                    }
                    return;
                }
            }

            if entry.status == StoredScheduledPromptStatus::Cancelling {
                match queue
                    .cancel_submission(&entry.thread_id, &submission_id(&entry.schedule_id))
                    .await
                {
                    Ok(_) => {
                        let mut next = self.state.lock().await.clone();
                        next.prompts.remove(&entry.schedule_id);
                        if let Err(error) = self.commit(next).await {
                            eprintln!(
                                "failed to finish scheduled prompt cancellation {}: {error}",
                                entry.schedule_id,
                            );
                        } else {
                            self.broadcast_thread(&entry.thread_id).await;
                        }
                    }
                    Err(error) => {
                        if let Err(persist_error) = self
                            .record_cancellation_retry(&entry.schedule_id, error)
                            .await
                        {
                            eprintln!(
                                "failed to persist scheduled prompt cancellation retry {}: {persist_error}",
                                entry.schedule_id,
                            );
                        }
                    }
                }
                None
            } else {
                let request = BridgeThreadQueueSendRequest {
                    thread_id: entry.thread_id.clone(),
                    submission_id: submission_id(&entry.schedule_id),
                    content: entry.prompt.clone(),
                    turn_start: prompt_turn_start(&entry.prompt),
                };
                match queue
                    .send_scheduled_prompt_admitted(request, &_retirement_admission)
                    .await
                {
                    Ok(result)
                        if matches!(result.disposition, BridgeThreadQueueDisposition::Sent) =>
                    {
                        self.settle_delivered(&entry).await;
                        None
                    }
                    Ok(_) => {
                        let mut next = self.state.lock().await.clone();
                        if let Some(stored) = next.prompts.get_mut(&entry.schedule_id) {
                            stored.status = StoredScheduledPromptStatus::Queued;
                            stored.retry_attempt = stored.retry_attempt.saturating_add(1);
                            stored.next_attempt_at = Utc::now()
                                + chrono::Duration::from_std(
                                    self.retry_delay(stored.retry_attempt),
                                )
                                .expect("scheduler retry delays are bounded to 30 seconds");
                            stored.last_error = None;
                        }
                        if let Err(error) = self.commit(next).await {
                            eprintln!(
                                "failed to persist queued scheduled prompt {}: {error}",
                                entry.schedule_id,
                            );
                        } else {
                            self.broadcast_thread(&entry.thread_id).await;
                        }
                        Some((queue, entry.thread_id))
                    }
                    Err(error) => {
                        if !crate::queue_service::definitive_settlement_was_interrupted(&error) {
                            match queue
                                .reconcile_indeterminate_submission(
                                    &entry.thread_id,
                                    &submission_id(&entry.schedule_id),
                                )
                                .await
                            {
                                Ok(Some(result))
                                    if matches!(
                                        result.disposition,
                                        BridgeThreadQueueDisposition::Sent,
                                    ) =>
                                {
                                    self.settle_delivered(&entry).await;
                                    return;
                                }
                                Ok(_) => {}
                                Err(reconcile_error) => {
                                    eprintln!(
                                        "failed to reconcile scheduled prompt submission {}: {reconcile_error}",
                                        entry.schedule_id,
                                    );
                                }
                            }
                        }
                        let mut next = self.state.lock().await.clone();
                        if let Some(stored) = next.prompts.get_mut(&entry.schedule_id) {
                            stored.status = StoredScheduledPromptStatus::Retrying;
                            stored.retry_attempt = stored.retry_attempt.saturating_add(1);
                            stored.next_attempt_at = Utc::now()
                                + chrono::Duration::from_std(
                                    self.retry_delay(stored.retry_attempt),
                                )
                                .expect("scheduler retry delays are bounded to 30 seconds");
                            stored.last_error = Some(truncate_error(error));
                        }
                        if let Err(error) = self.commit(next).await {
                            eprintln!(
                                "failed to persist scheduled prompt retry {}: {error}",
                                entry.schedule_id,
                            );
                        } else {
                            self.broadcast_thread(&entry.thread_id).await;
                        }
                        None
                    }
                }
            }
        };
        if let Some((queue, thread_id)) = queue_to_wake {
            queue.drain_thread_queue(thread_id).await;
        }
    }

    fn retry_delay(&self, attempt: u32) -> Duration {
        let shift = attempt.saturating_sub(1).min(16);
        self.retry_min
            .saturating_mul(1_u32 << shift)
            .min(self.retry_max)
    }

    async fn persist_interrupted_definitive_settlements(&self, queue: &BridgeQueueService) {
        let interrupted = queue.interrupted_definitive_settlements().await;
        if interrupted.is_empty() {
            return;
        }
        let _operation = self.operation.lock().await;
        let mut next = self.state.lock().await.clone();
        let mut affected_threads = Vec::new();
        for (submission_id, (thread_id, error)) in &interrupted {
            let Some(schedule_id) = submission_id
                .strip_prefix(crate::queue_service::SCHEDULED_PROMPT_SUBMISSION_PREFIX)
            else {
                continue;
            };
            let Some(stored) = next.prompts.get_mut(schedule_id) else {
                continue;
            };
            if stored.thread_id != *thread_id {
                continue;
            }
            if stored.last_error.as_deref() != Some(error) {
                stored.retry_attempt = stored.retry_attempt.saturating_add(1);
            }
            stored.status = StoredScheduledPromptStatus::Retrying;
            stored.next_attempt_at = Utc::now()
                + chrono::Duration::from_std(self.retry_delay(stored.retry_attempt.max(1)))
                    .expect("scheduler retry delays are bounded to 30 seconds");
            stored.last_error = Some(truncate_error(error.clone()));
            affected_threads.push(thread_id.clone());
        }
        let submission_ids = interrupted.keys().cloned().collect::<Vec<_>>();
        match self.commit(next).await {
            Ok(()) => {
                queue
                    .clear_interrupted_definitive_settlements(&submission_ids)
                    .await;
                affected_threads.sort();
                affected_threads.dedup();
                for thread_id in affected_threads {
                    self.broadcast_thread(&thread_id).await;
                }
            }
            Err(error) => {
                eprintln!(
                    "failed to persist interrupted definitive queue settlements during shutdown: \
                     {error}",
                );
            }
        }
    }

    pub(crate) async fn shutdown(&self) {
        self.cancellation.cancel();
        let queue = self.queue.upgrade();
        if let Some(queue) = &queue {
            queue.begin_definitive_settlement_shutdown();
        }
        let task = self
            .task
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(mut task) = task {
            if tokio::time::timeout(SCHEDULER_SHUTDOWN_TIMEOUT, &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
        if let Some(queue) = queue {
            if tokio::time::timeout(
                SCHEDULER_SHUTDOWN_TIMEOUT,
                queue.wait_for_definitive_settlements(),
            )
            .await
            .is_err()
            {
                eprintln!("timed out waiting for definitive queue failure persistence settlements");
            }
            self.persist_interrupted_definitive_settlements(&queue)
                .await;
        }
    }
}

async fn worker_loop(
    service: Weak<ScheduledPromptService>,
    cancellation: CancellationToken,
    wake: Arc<Notify>,
) {
    loop {
        let Some(scheduler) = service.upgrade() else {
            return;
        };
        let next_wake = scheduler.next_wake().await;
        drop(scheduler);
        let delay = next_wake.map_or(MAX_WORKER_SLEEP, |next| {
            (next - Utc::now())
                .to_std()
                .unwrap_or(Duration::ZERO)
                .min(MAX_WORKER_SLEEP)
        });
        let notified = tokio::select! {
            _ = cancellation.cancelled() => return,
            _ = wake.notified() => true,
            _ = tokio::time::sleep(delay) => false,
        };
        let Some(scheduler) = service.upgrade() else {
            return;
        };
        if notified {
            scheduler.settle_completed_submissions().await;
        } else {
            scheduler.process_ready().await;
        }
        #[cfg(test)]
        let completed = {
            scheduler
                .worker_cycle_completed
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
        };
        #[cfg(test)]
        if let Some(notify) = completed {
            notify.notify_one();
        }
    }
}

async fn load_state(path: &Path) -> Result<ScheduledPromptState, String> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ScheduledPromptState::default())
        }
        Err(error) => return Err(format!("failed to read scheduled prompt state: {error}")),
    };
    if bytes.len() > SCHEDULER_STATE_MAX_BYTES {
        return Err(format!(
            "scheduled prompt state exceeds {SCHEDULER_STATE_MAX_BYTES} bytes",
        ));
    }
    let state: ScheduledPromptState = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid scheduled prompt state: {error}"))?;
    validate_state(&state)?;
    encode_state(&state)?;
    Ok(state)
}

fn encode_state(state: &ScheduledPromptState) -> Result<Vec<u8>, String> {
    validate_state(state)?;
    let bytes = serde_json::to_vec(state)
        .map_err(|error| format!("failed to serialize scheduled prompt state: {error}"))?;
    if bytes.len() > SCHEDULER_STATE_MAX_BYTES {
        return Err(format!(
            "scheduled prompt state exceeds its {SCHEDULER_STATE_MAX_BYTES}-byte budget",
        ));
    }
    Ok(bytes)
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn validate_state(state: &ScheduledPromptState) -> Result<(), String> {
    if state.version != SCHEDULER_STATE_VERSION {
        return Err(format!(
            "unsupported scheduled prompt state version {}",
            state.version,
        ));
    }
    let mut per_thread = HashMap::<&str, usize>::new();
    for (key, entry) in &state.prompts {
        validate_schedule_id(key)?;
        if key != &entry.schedule_id {
            return Err("scheduled prompt map key does not match scheduleId".to_string());
        }
        validate_thread_id(&entry.thread_id)?;
        if entry.prompt.trim().is_empty() || entry.prompt.len() > QUEUE_MAX_CONTENT_BYTES {
            return Err("scheduled prompt content is empty or oversized".to_string());
        }
        validate_prompt_queue_encoding(&entry.prompt)?;
        if entry
            .last_error
            .as_ref()
            .is_some_and(|error| error.len() > SCHEDULER_ERROR_MAX_BYTES)
        {
            return Err("scheduled prompt retry error is oversized".to_string());
        }
        if entry.created_at > entry.scheduled_for {
            return Err("scheduled prompt creation time follows its delivery time".to_string());
        }
        match entry.status {
            StoredScheduledPromptStatus::Scheduled
                if entry.retry_attempt != 0
                    || entry.last_error.is_some()
                    || entry.next_attempt_at != entry.scheduled_for =>
            {
                return Err("scheduled prompt has inconsistent scheduled state".to_string());
            }
            StoredScheduledPromptStatus::Queued
                if entry.retry_attempt == 0 || entry.last_error.is_some() =>
            {
                return Err("scheduled prompt has inconsistent queued state".to_string());
            }
            StoredScheduledPromptStatus::Retrying if entry.retry_attempt == 0 => {
                return Err("scheduled prompt has inconsistent retry state".to_string());
            }
            _ => {}
        }
        let count = per_thread.entry(&entry.thread_id).or_default();
        *count += 1;
        if *count > SCHEDULES_PER_THREAD_MAX {
            return Err(format!(
                "scheduled prompt state exceeds {SCHEDULES_PER_THREAD_MAX} pending prompts for a thread",
            ));
        }
    }
    Ok(())
}

fn validate_thread_id(thread_id: &str) -> Result<(), String> {
    crate::acp::identity::AgentSessionId::decode(thread_id)
        .map(|_| ())
        .map_err(|_| "invalid opaque ACP thread ID".to_string())
}

fn validate_schedule_id(schedule_id: &str) -> Result<(), String> {
    if schedule_id.is_empty() || schedule_id.len() > SCHEDULE_IDENTIFIER_MAX_BYTES {
        return Err(format!(
            "scheduleId must be between 1 and {SCHEDULE_IDENTIFIER_MAX_BYTES} bytes",
        ));
    }
    let parsed =
        Uuid::parse_str(schedule_id).map_err(|_| "scheduleId must be a UUID".to_string())?;
    if parsed.to_string() != schedule_id {
        return Err("scheduleId must use canonical lowercase UUID form".to_string());
    }
    Ok(())
}

fn metadata(entry: &StoredScheduledPrompt) -> Option<ScheduledPromptMetadata> {
    let status = match entry.status {
        StoredScheduledPromptStatus::Scheduled => ScheduledPromptStatus::Scheduled,
        StoredScheduledPromptStatus::Queued => ScheduledPromptStatus::Queued,
        StoredScheduledPromptStatus::Retrying => ScheduledPromptStatus::Retrying,
        StoredScheduledPromptStatus::Cancelling => return None,
    };
    Some(ScheduledPromptMetadata {
        schedule_id: entry.schedule_id.clone(),
        thread_id: entry.thread_id.clone(),
        prompt: entry.prompt.clone(),
        prompt_bytes: entry.prompt.len(),
        scheduled_for: format_timestamp(entry.scheduled_for),
        created_at: format_timestamp(entry.created_at),
        status,
        retry_attempt: entry.retry_attempt,
        last_error: entry.last_error.clone(),
    })
}

fn summary(entry: &StoredScheduledPrompt) -> Option<ScheduledPromptSummary> {
    let metadata = metadata(entry)?;
    Some(ScheduledPromptSummary {
        schedule_id: metadata.schedule_id,
        thread_id: metadata.thread_id,
        prompt_preview: truncate_utf8_bytes(
            metadata.prompt.trim(),
            SCHEDULE_PROMPT_PREVIEW_MAX_BYTES,
        )
        .0,
        prompt_bytes: metadata.prompt_bytes,
        scheduled_for: metadata.scheduled_for,
        created_at: metadata.created_at,
        status: metadata.status,
        retry_attempt: metadata.retry_attempt,
    })
}

fn cancel_result(
    schedule_id: impl Into<String>,
    status: CancelScheduledPromptStatus,
) -> CancelScheduledPromptResult {
    CancelScheduledPromptResult {
        schedule_id: schedule_id.into(),
        status,
    }
}

fn format_timestamp(timestamp: DateTime<Utc>) -> String {
    timestamp.to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

fn submission_id(schedule_id: &str) -> String {
    format!(
        "{}{schedule_id}",
        crate::queue_service::SCHEDULED_PROMPT_SUBMISSION_PREFIX,
    )
}

fn prompt_turn_start(prompt: &str) -> serde_json::Value {
    serde_json::json!({
        "input": [{
            "type": "text",
            "text": prompt,
            "text_elements": [],
        }],
    })
}

fn validate_prompt_queue_encoding(prompt: &str) -> Result<(), String> {
    if crate::agent_messaging::text_contains_reserved_agent_message_marker(prompt) {
        return Err("prompt contains an agent-message marker reserved by the bridge".to_string());
    }
    let item_bytes = serde_json::to_vec(&prompt_turn_start(prompt))
        .map(|value| value.len())
        .unwrap_or(usize::MAX)
        .saturating_add(prompt.len());
    if item_bytes > QUEUE_MAX_ITEM_BYTES {
        return Err(format!(
            "encoded prompt exceeds the {QUEUE_MAX_ITEM_BYTES}-byte queue item limit",
        ));
    }
    Ok(())
}

fn truncate_error(mut error: String) -> String {
    while error.len() > SCHEDULER_ERROR_MAX_BYTES {
        error.pop();
    }
    error
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "scheduled_prompts_tests.rs"]
mod tests;
