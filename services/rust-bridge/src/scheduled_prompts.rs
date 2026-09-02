use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[cfg(test)]
use crate::bridge_protocol::BridgeThreadQueueSendResponse;
use crate::bridge_protocol::{
    BridgeQueueService, BridgeThreadQueueDisposition, BridgeThreadQueueSendRequest,
    BridgeThreadSchedulesState,
};
use crate::client_hub::ClientHub;
use crate::queue_service::QueueSubmissionCancelOutcome;
use crate::resource_limits::{truncate_utf8_bytes, QUEUE_MAX_CONTENT_BYTES, QUEUE_MAX_ITEM_BYTES};

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
    fail_next_persist: AtomicBool,
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
            fail_next_persist: AtomicBool::new(false),
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
            fail_next_persist: AtomicBool::new(false),
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
                "prompt must be at most {QUEUE_MAX_CONTENT_BYTES} bytes"
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
                "pending schedule limit reached for thread (max {SCHEDULES_PER_THREAD_MAX})"
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
        if let Some(notify) = self
            .cancellation_persisted
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
        {
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
            .map(|thread_id| thread_id.trim().to_string())
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
        entry.next_attempt_at =
            Utc::now() + chrono::Duration::from_std(self.retry_delay(entry.retry_attempt)).unwrap();
        entry.last_error = Some(truncate_error(error));
        self.commit(next).await
    }

    async fn settle_delivered(&self, entry: &StoredScheduledPrompt) {
        let mut next = self.state.lock().await.clone();
        next.prompts.remove(&entry.schedule_id);
        if let Err(error) = self.commit(next).await {
            eprintln!(
                "failed to settle delivered scheduled prompt {}: {error}",
                entry.schedule_id
            );
        } else {
            self.broadcast_thread(&entry.thread_id).await;
        }
    }

    async fn commit(&self, next: ScheduledPromptState) -> Result<(), ScheduledPromptError> {
        #[cfg(test)]
        if self.fail_next_persist.swap(false, Ordering::AcqRel) {
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
                        "failed to persist scheduled prompt state: {error}"
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
                        entry.schedule_id
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
                                .unwrap();
                        stored.last_error = Some(truncate_error(error));
                    }
                    if let Err(error) = self.commit(next).await {
                        eprintln!(
                            "failed to persist definitive settlement retry {}: {error}",
                            entry.schedule_id
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
                                entry.schedule_id
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
                                entry.schedule_id
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
                                .unwrap();
                            stored.last_error = None;
                        }
                        if let Err(error) = self.commit(next).await {
                            eprintln!(
                                "failed to persist queued scheduled prompt {}: {error}",
                                entry.schedule_id
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
                                        BridgeThreadQueueDisposition::Sent
                                    ) =>
                                {
                                    self.settle_delivered(&entry).await;
                                    return;
                                }
                                Ok(_) => {}
                                Err(reconcile_error) => {
                                    eprintln!(
                                        "failed to reconcile scheduled prompt submission {}: {reconcile_error}",
                                        entry.schedule_id
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
                                .unwrap();
                            stored.last_error = Some(truncate_error(error));
                        }
                        if let Err(error) = self.commit(next).await {
                            eprintln!(
                                "failed to persist scheduled prompt retry {}: {error}",
                                entry.schedule_id
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
                    .unwrap();
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
                     {error}"
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
            "scheduled prompt state exceeds {SCHEDULER_STATE_MAX_BYTES} bytes"
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
            "scheduled prompt state exceeds its {SCHEDULER_STATE_MAX_BYTES}-byte budget"
        ));
    }
    Ok(bytes)
}

fn validate_state(state: &ScheduledPromptState) -> Result<(), String> {
    if state.version != SCHEDULER_STATE_VERSION {
        return Err(format!(
            "unsupported scheduled prompt state version {}",
            state.version
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
                "scheduled prompt state exceeds {SCHEDULES_PER_THREAD_MAX} pending prompts for a thread"
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
            "scheduleId must be between 1 and {SCHEDULE_IDENTIFIER_MAX_BYTES} bytes"
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
    schedule_id: &str,
    status: CancelScheduledPromptStatus,
) -> CancelScheduledPromptResult {
    CancelScheduledPromptResult {
        schedule_id: schedule_id.to_string(),
        status,
    }
}

fn format_timestamp(timestamp: DateTime<Utc>) -> String {
    timestamp.to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

fn submission_id(schedule_id: &str) -> String {
    format!(
        "{}{schedule_id}",
        crate::queue_service::SCHEDULED_PROMPT_SUBMISSION_PREFIX
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
            "encoded prompt exceeds the {QUEUE_MAX_ITEM_BYTES}-byte queue item limit"
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
mod tests {
    use std::collections::{HashSet, VecDeque};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex as StdMutex;

    use agent_client_protocol::schema::v1::ContentBlock;
    use futures_util::future::BoxFuture;
    use tokio::sync::{mpsc, oneshot};

    use crate::client_hub::{ClientConnectionMetadata, ClientHub};
    use crate::client_outbox::{client_outbox, ClientOutboxReceiver};
    use crate::runtime_backend::{QueueRuntimeDispatcher, QueueRuntimeSnapshot};

    use super::*;

    struct TurnStartCall {
        thread_id: String,
        turn_start: serde_json::Value,
        source_turn_id: String,
        response: oneshot::Sender<Result<String, String>>,
    }

    struct TestDispatcher {
        busy: AtomicBool,
        responses: StdMutex<VecDeque<Result<String, String>>>,
        calls: mpsc::UnboundedSender<TurnStartCall>,
    }

    impl QueueRuntimeDispatcher for TestDispatcher {
        fn read_snapshot<'a>(
            &'a self,
            thread_id: &'a str,
        ) -> BoxFuture<'a, Result<QueueRuntimeSnapshot, String>> {
            let mut session =
                crate::acp::snapshot::SessionSnapshot::new("agent".to_string(), thread_id.into());
            if self.busy.load(Ordering::SeqCst) {
                session.active_run_id = Some("run-active".to_string());
                session.active_source_turn_id = Some("turn-active".to_string());
                session.active_generation = Some(1);
            }
            Box::pin(async move {
                Ok(QueueRuntimeSnapshot {
                    session,
                    pending_approval_ids: HashSet::new(),
                    pending_user_input_ids: HashSet::new(),
                })
            })
        }

        fn supports_steer(&self, _thread_id: &str) -> Result<bool, String> {
            Ok(false)
        }

        fn prepare_steer<'a>(&'a self, _thread_id: &'a str) -> BoxFuture<'a, Result<u64, String>> {
            Box::pin(async { Ok(1) })
        }

        fn verify_steer_epoch<'a>(
            &'a self,
            _thread_id: &'a str,
            _epoch: u64,
        ) -> BoxFuture<'a, Result<bool, String>> {
            Box::pin(async { Ok(true) })
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
            Box::pin(async { Err("steering is disabled".to_string()) })
        }

        fn turn_start<'a>(
            &'a self,
            thread_id: &'a str,
            turn_start: &'a serde_json::Value,
            source_turn_id: &'a str,
        ) -> BoxFuture<'a, Result<String, String>> {
            let scripted = self
                .responses
                .lock()
                .expect("response script lock")
                .pop_front();
            Box::pin(async move {
                if let Some(scripted) = scripted {
                    return scripted;
                }
                let (response, received) = oneshot::channel();
                self.calls
                    .send(TurnStartCall {
                        thread_id: thread_id.to_string(),
                        turn_start: turn_start.clone(),
                        source_turn_id: source_turn_id.to_string(),
                        response,
                    })
                    .map_err(|_| "turn-start receiver closed".to_string())?;
                received
                    .await
                    .map_err(|_| "turn-start response dropped".to_string())?
            })
        }
    }

    fn test_thread(name: &str) -> String {
        crate::acp::identity::AgentSessionId::new("agent", name)
            .unwrap()
            .encode()
    }

    fn test_directory(name: &str) -> PathBuf {
        let path = std::env::current_dir()
            .expect("current directory")
            .join("target")
            .join("scheduler-tests")
            .join(format!("{name}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create scheduler test directory");
        path
    }

    fn make_dispatcher(
        busy: bool,
        responses: Vec<Result<String, String>>,
    ) -> (Arc<TestDispatcher>, mpsc::UnboundedReceiver<TurnStartCall>) {
        let (calls, receiver) = mpsc::unbounded_channel();
        (
            Arc::new(TestDispatcher {
                busy: AtomicBool::new(busy),
                responses: StdMutex::new(responses.into()),
                calls,
            }),
            receiver,
        )
    }

    fn make_queue(
        dispatcher: Arc<TestDispatcher>,
        receipt_path: Option<PathBuf>,
    ) -> Arc<BridgeQueueService> {
        BridgeQueueService::with_submission_store(
            dispatcher,
            Arc::new(ClientHub::new()),
            receipt_path,
            crate::queue_service::DurableQueueSubmissions::default(),
        )
    }

    fn start_test_scheduler(
        path: PathBuf,
        queue: &Arc<BridgeQueueService>,
        state: ScheduledPromptState,
    ) -> Arc<ScheduledPromptService> {
        ScheduledPromptService::start_with_state(
            Some(path),
            Arc::downgrade(queue),
            queue.hub.clone(),
            state,
            Duration::from_millis(50),
            Duration::from_millis(200),
        )
    }

    fn fixture_entry(
        schedule_id: String,
        thread_id: String,
        scheduled_for: DateTime<Utc>,
    ) -> StoredScheduledPrompt {
        StoredScheduledPrompt {
            schedule_id,
            thread_id,
            prompt: "scheduled work".to_string(),
            scheduled_for,
            created_at: scheduled_for - chrono::Duration::minutes(1),
            status: StoredScheduledPromptStatus::Scheduled,
            retry_attempt: 0,
            next_attempt_at: scheduled_for,
            last_error: None,
        }
    }

    async fn next_bridge_notification(receiver: &mut ClientOutboxReceiver) -> serde_json::Value {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let message = receiver.recv().await.expect("notification");
                let axum::extract::ws::Message::Text(text) = message else {
                    continue;
                };
                let payload: serde_json::Value =
                    serde_json::from_str(text.as_str()).expect("notification JSON");
                return payload;
            }
        })
        .await
        .expect("bridge notification timeout")
    }

    async fn next_schedule_notification(receiver: &mut ClientOutboxReceiver) -> serde_json::Value {
        loop {
            let payload = next_bridge_notification(receiver).await;
            if payload["method"] == "bridge/thread/schedules/updated" {
                return payload;
            }
        }
    }

    #[test]
    fn public_schedule_state_matches_cross_language_fixture() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../../contracts/bridge-rpc/v2/manifest.json"
        ))
        .expect("contract fixture");
        let state = BridgeThreadSchedulesState {
            thread_id: "thread-1".to_string(),
            schedules: vec![ScheduledPromptSummary {
                schedule_id: "00000000-0000-4000-8000-000000000002".to_string(),
                thread_id: "thread-1".to_string(),
                prompt_preview: "Review the deployment checklist.".to_string(),
                prompt_bytes: 32,
                scheduled_for: "2026-09-01T16:00:00Z".to_string(),
                created_at: "2026-08-29T21:00:00Z".to_string(),
                status: ScheduledPromptStatus::Scheduled,
                retry_attempt: 0,
            }],
        };
        assert_eq!(
            serde_json::to_value(state).unwrap(),
            manifest["fixtures"]["threadSchedules"]
        );

        let mut stored = fixture_entry(
            Uuid::new_v4().to_string(),
            test_thread("preview"),
            Utc::now() + chrono::Duration::hours(1),
        );
        stored.prompt = format!("{}é", "a".repeat(SCHEDULE_PROMPT_PREVIEW_MAX_BYTES - 1));
        let bounded = summary(&stored).expect("public summary");
        assert_eq!(
            bounded.prompt_preview,
            "a".repeat(SCHEDULE_PROMPT_PREVIEW_MAX_BYTES - 1)
        );
        assert_eq!(bounded.prompt_bytes, stored.prompt.len());
    }

    #[tokio::test]
    async fn mutations_broadcast_complete_thread_schedule_snapshots() {
        let directory = test_directory("notifications");
        let path = directory.join("scheduled-prompts.json");
        let (dispatcher, _) = make_dispatcher(false, Vec::new());
        let queue = make_queue(dispatcher, None);
        let (outbox, mut notifications) = client_outbox(8);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let scheduler = start_test_scheduler(path, &queue, ScheduledPromptState::default());
        let thread_id = test_thread("notifications");
        let scheduled = scheduler
            .schedule(
                &thread_id,
                "visible after reload".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .expect("schedule accepted");

        let added = next_schedule_notification(&mut notifications).await;
        assert_eq!(added["params"]["threadId"], thread_id);
        assert_eq!(
            added["params"]["schedules"][0]["scheduleId"],
            scheduled.schedule_id
        );
        assert_eq!(added["params"]["schedules"].as_array().unwrap().len(), 1);

        scheduler
            .cancel(&thread_id, &scheduled.schedule_id)
            .await
            .expect("schedule cancelled");
        let removed = next_schedule_notification(&mut notifications).await;
        assert_eq!(removed["params"]["threadId"], thread_id);
        assert!(removed["params"]["schedules"]
            .as_array()
            .unwrap()
            .is_empty());

        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn admission_is_bounded_normalized_private_and_caller_scoped() {
        let directory = test_directory("admission");
        let path = directory.join("scheduled-prompts.json");
        let (dispatcher, _) = make_dispatcher(false, Vec::new());
        let queue = make_queue(dispatcher, None);
        let scheduler = start_test_scheduler(path.clone(), &queue, ScheduledPromptState::default());
        let owner = test_thread("owner");
        let other = test_thread("other");
        let scheduled_for = Utc::now() + chrono::Duration::hours(1);
        let offset_time = scheduled_for
            .with_timezone(&chrono::FixedOffset::west_opt(7 * 3600).unwrap())
            .to_rfc3339();

        let scheduled = scheduler
            .schedule(&owner, "remember this".to_string(), &offset_time)
            .await
            .expect("schedule accepted");
        assert!(scheduled.scheduled_for.ends_with('Z'));
        assert_eq!(scheduled.status, ScheduledPromptStatus::Scheduled);
        let persisted = load_state(&path)
            .await
            .expect("persisted before acknowledgement");
        assert!(persisted.prompts.contains_key(&scheduled.schedule_id));
        assert_eq!(scheduler.pending_count().await, 1);
        #[cfg(unix)]
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(
                &std::fs::metadata(&path).unwrap().permissions()
            ) & 0o777,
            0o600
        );
        assert!(scheduler.list(&other).await.is_empty());
        assert_eq!(
            scheduler
                .cancel(&other, &scheduled.schedule_id)
                .await
                .unwrap()
                .status,
            CancelScheduledPromptStatus::NotFound
        );
        assert_eq!(scheduler.list(&owner).await.len(), 1);

        for invalid in ["tomorrow", "2026-01-01", "2026-01-01T00:00:00"] {
            assert!(matches!(
                scheduler
                    .schedule(&owner, "prompt".to_string(), invalid)
                    .await,
                Err(ScheduledPromptError::Invalid(_))
            ));
        }
        assert!(scheduler
            .schedule(&owner, "prompt".to_string(), &Utc::now().to_rfc3339())
            .await
            .is_err());
        assert!(scheduler
            .schedule(
                &owner,
                "x".repeat(QUEUE_MAX_CONTENT_BYTES + 1),
                &(Utc::now() + chrono::Duration::hours(2)).to_rfc3339()
            )
            .await
            .is_err());
        assert!(scheduler
            .schedule(
                &owner,
                "<<<dappercode.dev/agent-message:v1>>>".to_string(),
                &(Utc::now() + chrono::Duration::hours(2)).to_rfc3339()
            )
            .await
            .is_err());
        assert!(scheduler
            .schedule(
                &owner,
                "\u{0001}".repeat(QUEUE_MAX_CONTENT_BYTES),
                &(Utc::now() + chrono::Duration::hours(2)).to_rfc3339()
            )
            .await
            .is_err());
        assert_eq!(
            scheduler
                .cancel(&owner, &scheduled.schedule_id)
                .await
                .unwrap()
                .status,
            CancelScheduledPromptStatus::Cancelled
        );
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn startup_rejects_malformed_oversized_and_over_capacity_state() {
        let directory = test_directory("invalid-state");
        let path = directory.join("scheduled-prompts.json");
        std::fs::write(&path, b"{").unwrap();
        assert!(load_state(&path).await.unwrap_err().contains("invalid"));
        std::fs::write(&path, vec![b' '; SCHEDULER_STATE_MAX_BYTES + 1]).unwrap();
        assert!(load_state(&path).await.unwrap_err().contains("exceeds"));

        let thread_id = test_thread("capacity");
        let future = Utc::now() + chrono::Duration::hours(1);
        let mut state = ScheduledPromptState::default();
        for _ in 0..=SCHEDULES_PER_THREAD_MAX {
            let id = Uuid::new_v4().to_string();
            state
                .prompts
                .insert(id.clone(), fixture_entry(id, thread_id.clone(), future));
        }
        std::fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
        assert!(load_state(&path)
            .await
            .unwrap_err()
            .contains("pending prompts"));

        state.prompts.pop_first();
        std::fs::write(&path, encode_state(&state).unwrap()).unwrap();
        let (dispatcher, _) = make_dispatcher(false, Vec::new());
        let queue = make_queue(dispatcher, None);
        let scheduler =
            ScheduledPromptService::start(path.clone(), Arc::downgrade(&queue), queue.hub.clone())
                .await
                .expect("state at exact per-thread limit loads");
        assert!(matches!(
            scheduler
                .schedule(
                    &thread_id,
                    "one too many".to_string(),
                    &(Utc::now() + chrono::Duration::hours(2)).to_rfc3339(),
                )
                .await,
            Err(ScheduledPromptError::Invalid(_))
        ));
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn worker_wakes_for_future_prompt_and_catches_up_overdue_restart() {
        let directory = test_directory("wake-restart");
        let path = directory.join("scheduled-prompts.json");
        let thread_id = test_thread("wake");
        let (dispatcher, mut calls) = make_dispatcher(false, Vec::new());
        let queue = make_queue(dispatcher, None);
        let (outbox, mut notifications) = client_outbox(8);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let scheduler = start_test_scheduler(path.clone(), &queue, ScheduledPromptState::default());
        let scheduled = scheduler
            .schedule(
                &thread_id,
                "future prompt".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .unwrap();
        let _ = next_schedule_notification(&mut notifications).await;
        scheduler.make_due_for_test(&scheduled.schedule_id).await;
        let call = calls.recv().await.expect("future prompt dispatched");
        assert_eq!(call.thread_id, thread_id);
        assert_eq!(
            call.turn_start["input"][0]["text"].as_str(),
            Some("future prompt")
        );
        call.response.send(Ok("turn-future".to_string())).unwrap();
        assert!(
            next_schedule_notification(&mut notifications).await["params"]["schedules"]
                .as_array()
                .is_some_and(Vec::is_empty)
        );
        assert!(load_state(&path).await.unwrap().prompts.is_empty());
        scheduler.shutdown().await;

        let overdue_id = Uuid::new_v4().to_string();
        let overdue = Utc::now() - chrono::Duration::minutes(5);
        let mut state = ScheduledPromptState::default();
        state.prompts.insert(
            overdue_id.clone(),
            fixture_entry(overdue_id, test_thread("restart"), overdue),
        );
        std::fs::write(&path, encode_state(&state).unwrap()).unwrap();
        let (dispatcher, mut calls) = make_dispatcher(false, Vec::new());
        let queue = make_queue(dispatcher, None);
        let (outbox, mut notifications) = client_outbox(8);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let restarted =
            ScheduledPromptService::start(path.clone(), Arc::downgrade(&queue), queue.hub.clone())
                .await
                .expect("scheduler restarts");
        let call = calls.recv().await.expect("overdue prompt dispatched");
        call.response.send(Ok("turn-overdue".to_string())).unwrap();
        assert!(
            next_schedule_notification(&mut notifications).await["params"]["schedules"]
                .as_array()
                .is_some_and(Vec::is_empty)
        );
        assert!(load_state(&path).await.unwrap().prompts.is_empty());
        restarted.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn busy_thread_queues_without_steering_and_queued_cancel_is_durable() {
        let directory = test_directory("queued-cancel");
        let path = directory.join("scheduled-prompts.json");
        let thread_id = test_thread("busy");
        let (dispatcher, mut calls) = make_dispatcher(true, Vec::new());
        let queue = make_queue(dispatcher, None);
        let (outbox, mut notifications) = client_outbox(16);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let scheduler = start_test_scheduler(path.clone(), &queue, ScheduledPromptState::default());
        let scheduled = scheduler
            .schedule(
                &thread_id,
                "queue me".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .unwrap();
        assert_eq!(
            next_schedule_notification(&mut notifications).await["params"]["schedules"][0]
                ["status"],
            "scheduled"
        );
        scheduler.make_due_for_test(&scheduled.schedule_id).await;
        let queued_notification = next_schedule_notification(&mut notifications).await;
        assert_eq!(
            queued_notification["params"]["schedules"][0]["status"],
            "queued"
        );
        assert_eq!(
            scheduler.list(&thread_id).await[0].status,
            ScheduledPromptStatus::Queued
        );
        assert!(queue.read_queue(&thread_id).await.items.is_empty());
        assert_eq!(queue.status().await.depth, 1);
        assert!(calls.try_recv().is_err());
        assert_eq!(
            scheduler
                .cancel(&thread_id, &scheduled.schedule_id)
                .await
                .unwrap()
                .status,
            CancelScheduledPromptStatus::Cancelled
        );
        assert!(scheduler.list(&thread_id).await.is_empty());
        assert!(
            next_schedule_notification(&mut notifications).await["params"]["schedules"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(queue.read_queue(&thread_id).await.items.is_empty());
        assert!(load_state(&path).await.unwrap().prompts.is_empty());
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn queued_schedule_survives_unrelated_receipt_persistence_and_bridge_restart() {
        let directory = test_directory("queued-restart");
        let scheduler_path = directory.join("scheduled-prompts.json");
        let receipt_path = directory.join("queue-idempotency.json");
        let thread_id = test_thread("queued-restart");
        let (dispatcher, mut initial_calls) = make_dispatcher(true, Vec::new());
        let queue = make_queue(dispatcher, Some(receipt_path.clone()));
        let scheduler = start_test_scheduler(
            scheduler_path.clone(),
            &queue,
            ScheduledPromptState::default(),
        );
        let scheduled = scheduler
            .schedule(
                &thread_id,
                "survive the bridge restart".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .unwrap();
        scheduler.make_due_for_test(&scheduled.schedule_id).await;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if scheduler.list(&thread_id).await[0].status == ScheduledPromptStatus::Queued {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("scheduled prompt reaches the volatile queue");
        assert!(initial_calls.try_recv().is_err());
        let scheduled_submission_id = submission_id(&scheduled.schedule_id);
        assert!(queue
            .submission_volatile_pending
            .lock()
            .await
            .contains_key(&scheduled_submission_id));

        queue
            .remember_submission_result(crate::BridgeThreadQueueSendResponse {
                submission_id: "unrelated-receipt".to_string(),
                disposition: BridgeThreadQueueDisposition::Sent,
                queue: BridgeQueueService::snapshot_for_thread(&test_thread("unrelated"), None),
                turn_id: Some("unrelated-turn".to_string()),
            })
            .await
            .unwrap();
        let durable = BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .unwrap();
        assert!(durable.results.contains_key("unrelated-receipt"));
        assert!(!durable.results.contains_key(&scheduled_submission_id));
        assert!(!durable.pending.contains_key(&scheduled_submission_id));
        assert_eq!(
            load_state(&scheduler_path).await.unwrap().prompts[&scheduled.schedule_id].status,
            StoredScheduledPromptStatus::Queued
        );
        scheduler.shutdown().await;

        let (restarted_dispatcher, mut restarted_calls) = make_dispatcher(false, Vec::new());
        let restarted_queue = BridgeQueueService::with_submission_store(
            restarted_dispatcher,
            Arc::new(ClientHub::new()),
            Some(receipt_path.clone()),
            durable,
        );
        let restarted = ScheduledPromptService::start(
            scheduler_path,
            Arc::downgrade(&restarted_queue),
            restarted_queue.hub.clone(),
        )
        .await
        .unwrap();
        let call = tokio::time::timeout(Duration::from_secs(1), restarted_calls.recv())
            .await
            .expect("queued schedule retries after restart")
            .expect("restarted schedule dispatch");
        assert_eq!(call.thread_id, thread_id);
        assert_eq!(
            call.turn_start["input"][0]["text"].as_str(),
            Some("survive the bridge restart")
        );
        call.response
            .send(Ok("turn-after-restart".to_string()))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if restarted.list(&thread_id).await.is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("retried schedule settles after restart");
        assert!(restarted_calls.try_recv().is_err());
        restarted.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn temporary_failures_retry_until_delivery_with_capped_state() {
        let directory = test_directory("retry");
        let path = directory.join("scheduled-prompts.json");
        let thread_id = test_thread("retry");
        let (dispatcher, mut calls) = make_dispatcher(false, Vec::new());
        let queue = make_queue(dispatcher, None);
        let (outbox, mut notifications) = client_outbox(16);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let scheduler = ScheduledPromptService::start_with_state(
            Some(path.clone()),
            Arc::downgrade(&queue),
            queue.hub.clone(),
            ScheduledPromptState::default(),
            Duration::from_secs(60 * 60),
            Duration::from_secs(60 * 60),
        );
        let scheduled = scheduler
            .schedule(
                &thread_id,
                "retry prompt".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .unwrap();
        let _ = next_schedule_notification(&mut notifications).await;
        scheduler.make_due_for_test(&scheduled.schedule_id).await;

        let first = calls.recv().await.unwrap();
        let deterministic_source_turn_id = first.source_turn_id.clone();
        first
            .response
            .send(Err("temporarily offline".to_string()))
            .unwrap();
        let retrying_notification = next_schedule_notification(&mut notifications).await;
        assert_eq!(
            retrying_notification["params"]["schedules"][0]["status"],
            "retrying"
        );
        let retrying = scheduler.list(&thread_id).await;
        assert_eq!(retrying[0].status, ScheduledPromptStatus::Retrying);
        assert_eq!(
            retrying[0].last_error.as_deref(),
            Some("temporarily offline")
        );
        scheduler.make_due_for_test(&scheduled.schedule_id).await;
        let second = calls.recv().await.unwrap();
        assert_eq!(second.source_turn_id, deterministic_source_turn_id);
        second
            .response
            .send(Err("still offline".to_string()))
            .unwrap();
        let second_retrying_notification = next_schedule_notification(&mut notifications).await;
        assert_eq!(
            second_retrying_notification["params"]["schedules"][0]["retryAttempt"],
            2
        );
        scheduler.make_due_for_test(&scheduled.schedule_id).await;
        let third = calls.recv().await.unwrap();
        assert_eq!(third.source_turn_id, deterministic_source_turn_id);
        third.response.send(Ok("turn-retried".to_string())).unwrap();
        loop {
            let notification = next_schedule_notification(&mut notifications).await;
            if notification["params"]["schedules"]
                .as_array()
                .is_some_and(Vec::is_empty)
            {
                break;
            }
        }
        assert!(scheduler.list(&thread_id).await.is_empty());
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn definitive_direct_failure_survives_permanent_settlement_failure_and_restart() {
        let directory = test_directory("direct-definitive-settlement-restart");
        let scheduler_path = directory.join("scheduled-prompts.json");
        let receipt_path = directory.join("queue-idempotency.json");
        let thread_id = test_thread("direct-definitive-settlement-restart");
        let (dispatcher, mut calls) = make_dispatcher(false, Vec::new());
        let queue = make_queue(dispatcher, Some(receipt_path.clone()));
        let scheduler = start_test_scheduler(
            scheduler_path.clone(),
            &queue,
            ScheduledPromptState::default(),
        );
        let scheduled = scheduler
            .schedule(
                &thread_id,
                "retry direct definitive failure".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .unwrap();
        scheduler.make_due_for_test(&scheduled.schedule_id).await;
        let failed = calls.recv().await.expect("direct scheduled dispatch");
        queue
            .fail_all_submission_persists
            .store(true, Ordering::Release);
        failed
            .response
            .send(Err("definitive direct failure".to_string()))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if queue.submission_dirty.load(Ordering::Acquire)
                    && queue.definitive_settlements_active.load(Ordering::Acquire) == 1
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("direct failure retains settlement ownership");
        assert_eq!(
            scheduler.list(&thread_id).await[0].status,
            ScheduledPromptStatus::Scheduled
        );
        assert!(BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .unwrap()
            .pending
            .contains_key(&submission_id(&scheduled.schedule_id)));

        tokio::time::timeout(Duration::from_secs(1), scheduler.shutdown())
            .await
            .expect("permanent queue persistence failure has bounded shutdown");
        let persisted = load_state(&scheduler_path).await.unwrap();
        let interrupted = &persisted.prompts[&scheduled.schedule_id];
        assert_eq!(interrupted.status, StoredScheduledPromptStatus::Retrying);
        assert!(interrupted
            .last_error
            .as_deref()
            .is_some_and(crate::queue_service::definitive_settlement_was_interrupted));
        let durable = BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .unwrap();
        assert!(durable
            .pending
            .contains_key(&submission_id(&scheduled.schedule_id)));
        assert!(durable.results.is_empty());
        drop(scheduler);
        drop(queue);

        let (restarted_dispatcher, mut restarted_calls) = make_dispatcher(false, Vec::new());
        let restarted_queue = BridgeQueueService::with_submission_store(
            restarted_dispatcher,
            Arc::new(ClientHub::new()),
            Some(receipt_path.clone()),
            durable,
        );
        let restarted = ScheduledPromptService::start(
            scheduler_path,
            Arc::downgrade(&restarted_queue),
            restarted_queue.hub.clone(),
        )
        .await
        .unwrap();
        let retried = tokio::time::timeout(Duration::from_secs(1), restarted_calls.recv())
            .await
            .expect("settled direct failure retries after restart")
            .expect("retried direct scheduled dispatch");
        assert_eq!(
            retried.turn_start["input"][0]["text"].as_str(),
            Some("retry direct definitive failure")
        );
        retried
            .response
            .send(Ok("retried-turn".to_string()))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if restarted.list(&thread_id).await.is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("retried direct prompt settles");
        assert!(restarted_calls.try_recv().is_err());
        let settled = BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .unwrap();
        assert!(settled.pending.is_empty());
        assert_eq!(settled.results.len(), 1);
        restarted.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn definitive_auto_failure_survives_permanent_settlement_failure_and_restart() {
        let directory = test_directory("auto-definitive-settlement-restart");
        let scheduler_path = directory.join("scheduled-prompts.json");
        let receipt_path = directory.join("queue-idempotency.json");
        let thread_id = test_thread("auto-definitive-settlement-restart");
        let (dispatcher, mut calls) = make_dispatcher(true, Vec::new());
        let queue = make_queue(dispatcher.clone(), Some(receipt_path.clone()));
        let scheduler = start_test_scheduler(
            scheduler_path.clone(),
            &queue,
            ScheduledPromptState::default(),
        );
        let scheduled = scheduler
            .schedule(
                &thread_id,
                "retry queued definitive failure".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .unwrap();
        scheduler.make_due_for_test(&scheduled.schedule_id).await;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if scheduler.list(&thread_id).await[0].status == ScheduledPromptStatus::Queued {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("scheduled prompt enters the queue");
        dispatcher.busy.store(false, Ordering::SeqCst);
        {
            let mut threads = queue.threads.write().await;
            let runtime = threads.get_mut(&thread_id).expect("queued runtime");
            runtime.thread_running = false;
            runtime.active_turn_id = None;
            runtime.active_run_id = None;
        }
        queue.spawn_auto_dispatch(thread_id.clone());
        let failed = calls.recv().await.expect("queued scheduled auto-dispatch");
        queue
            .fail_all_submission_persists
            .store(true, Ordering::Release);
        failed
            .response
            .send(Err("definitive queued failure".to_string()))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if queue.submission_dirty.load(Ordering::Acquire)
                    && queue.definitive_settlements_active.load(Ordering::Acquire) == 1
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("queued failure retains settlement ownership");
        assert!(queue.read_queue(&thread_id).await.items.is_empty());
        assert!(calls.try_recv().is_err());

        tokio::time::timeout(Duration::from_secs(1), scheduler.shutdown())
            .await
            .expect("queued permanent persistence failure has bounded shutdown");
        let persisted = load_state(&scheduler_path).await.unwrap();
        let interrupted = &persisted.prompts[&scheduled.schedule_id];
        assert_eq!(interrupted.status, StoredScheduledPromptStatus::Retrying);
        assert!(interrupted
            .last_error
            .as_deref()
            .is_some_and(crate::queue_service::definitive_settlement_was_interrupted));
        {
            let threads = queue.threads.read().await;
            let runtime = threads.get(&thread_id).expect("failed queued runtime");
            assert!(!runtime.turn_start_in_flight);
            assert_eq!(runtime.items.len(), 1);
            assert_eq!(runtime.items[0].content, "retry queued definitive failure");
        }
        let durable = BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .unwrap();
        assert!(durable
            .pending
            .contains_key(&submission_id(&scheduled.schedule_id)));
        assert!(durable.results.is_empty());
        drop(scheduler);
        drop(queue);

        let (restarted_dispatcher, mut restarted_calls) = make_dispatcher(false, Vec::new());
        let restarted_queue = BridgeQueueService::with_submission_store(
            restarted_dispatcher,
            Arc::new(ClientHub::new()),
            Some(receipt_path.clone()),
            durable,
        );
        let restarted = ScheduledPromptService::start(
            scheduler_path,
            Arc::downgrade(&restarted_queue),
            restarted_queue.hub.clone(),
        )
        .await
        .unwrap();
        let retried = tokio::time::timeout(Duration::from_secs(1), restarted_calls.recv())
            .await
            .expect("settled auto failure retries after restart")
            .expect("retried queued scheduled dispatch");
        assert_eq!(
            retried.turn_start["input"][0]["text"].as_str(),
            Some("retry queued definitive failure")
        );
        retried
            .response
            .send(Ok("retried-auto-turn".to_string()))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if restarted.list(&thread_id).await.is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("retried auto prompt settles");
        assert!(restarted_calls.try_recv().is_err());
        let settled = BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .unwrap();
        assert!(settled.pending.is_empty());
        assert_eq!(settled.results.len(), 1);
        restarted.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn cancellation_loses_safely_to_an_already_dispatched_queued_prompt() {
        let directory = test_directory("cancel-race");
        let path = directory.join("scheduled-prompts.json");
        let thread_id = test_thread("race");
        let (dispatcher, mut calls) = make_dispatcher(true, Vec::new());
        let queue = make_queue(dispatcher, None);
        let (outbox, mut notifications) = client_outbox(8);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let scheduler = start_test_scheduler(path.clone(), &queue, ScheduledPromptState::default());
        let scheduled = scheduler
            .schedule(
                &thread_id,
                "race prompt".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .unwrap();
        let _ = next_schedule_notification(&mut notifications).await;
        scheduler.make_due_for_test(&scheduled.schedule_id).await;
        let queued_notification = next_schedule_notification(&mut notifications).await;
        assert_eq!(
            queued_notification["params"]["schedules"][0]["status"],
            "queued"
        );
        assert!(queue.read_queue(&thread_id).await.items.is_empty());
        assert_eq!(queue.status().await.depth, 1);
        {
            let mut threads = queue.threads.write().await;
            let runtime = threads.get_mut(&thread_id).unwrap();
            runtime.thread_running = false;
            runtime.active_run_id = None;
            runtime.active_turn_id = None;
        }
        queue.spawn_auto_dispatch(thread_id.clone());
        let call = calls.recv().await.expect("queued prompt begins dispatch");
        let cancellation_persisted = Arc::new(Notify::new());
        *scheduler
            .cancellation_persisted
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(cancellation_persisted.clone());
        let cancel = tokio::spawn({
            let scheduler = scheduler.clone();
            let thread_id = thread_id.clone();
            let schedule_id = scheduled.schedule_id.clone();
            async move { scheduler.cancel(&thread_id, &schedule_id).await }
        });
        tokio::time::timeout(Duration::from_secs(1), cancellation_persisted.notified())
            .await
            .expect("cancellation durably reaches the queue-dispatch race");
        assert!(!cancel.is_finished());
        assert_eq!(
            load_state(&path).await.unwrap().prompts[&scheduled.schedule_id].status,
            StoredScheduledPromptStatus::Cancelling
        );
        call.response.send(Ok("turn-race".to_string())).unwrap();
        let result = cancel.await.unwrap().unwrap();
        assert_eq!(result.status, CancelScheduledPromptStatus::NotFound);
        assert!(scheduler.list(&thread_id).await.is_empty());
        assert!(calls.try_recv().is_err());
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn durable_sent_receipt_suppresses_duplicate_after_scheduler_restart() {
        let directory = test_directory("dedupe");
        let scheduler_path = directory.join("scheduled-prompts.json");
        let receipt_path = directory.join("queue-idempotency.json");
        let thread_id = test_thread("dedupe");
        let schedule_id = Uuid::new_v4().to_string();
        let (dispatcher, mut calls) = make_dispatcher(false, Vec::new());
        let queue = make_queue(dispatcher, Some(receipt_path));
        let (outbox, mut notifications) = client_outbox(8);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        queue
            .remember_submission_result(crate::BridgeThreadQueueSendResponse {
                submission_id: submission_id(&schedule_id),
                disposition: BridgeThreadQueueDisposition::Sent,
                queue: BridgeQueueService::snapshot_for_thread(&thread_id, None),
                turn_id: Some("turn-already-sent".to_string()),
            })
            .await
            .unwrap();
        let overdue = Utc::now() - chrono::Duration::minutes(1);
        let mut state = ScheduledPromptState::default();
        state.prompts.insert(
            schedule_id.clone(),
            fixture_entry(schedule_id, thread_id.clone(), overdue),
        );
        std::fs::write(&scheduler_path, encode_state(&state).unwrap()).unwrap();

        let scheduler = ScheduledPromptService::start(
            scheduler_path.clone(),
            Arc::downgrade(&queue),
            queue.hub.clone(),
        )
        .await
        .unwrap();
        assert!(
            next_schedule_notification(&mut notifications).await["params"]["schedules"]
                .as_array()
                .is_some_and(Vec::is_empty)
        );
        assert!(scheduler.list(&thread_id).await.is_empty());
        assert!(calls.try_recv().is_err());
        scheduler.shutdown().await;

        let restarted = ScheduledPromptService::start(
            scheduler_path,
            Arc::downgrade(&queue),
            queue.hub.clone(),
        )
        .await
        .unwrap();
        let cycle_completed = Arc::new(Notify::new());
        *restarted
            .worker_cycle_completed
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(cycle_completed.clone());
        let completed = cycle_completed.notified();
        tokio::pin!(completed);
        restarted.wake.notify_one();
        tokio::time::timeout(Duration::from_secs(1), completed)
            .await
            .expect("restarted scheduler inspects empty state");
        assert!(calls.try_recv().is_err());
        restarted.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn indeterminate_durable_admission_converges_without_rotating_the_submission_id() {
        let directory = test_directory("indeterminate-recovery");
        let scheduler_path = directory.join("scheduled-prompts.json");
        let receipt_path = directory.join("queue-idempotency.json");
        let thread_id = test_thread("indeterminate");
        let schedule_id = Uuid::new_v4().to_string();
        let submission_id = submission_id(&schedule_id);
        let mut submissions = crate::queue_service::DurableQueueSubmissions::default();
        submissions
            .pending
            .insert(submission_id.clone(), thread_id.clone());
        submissions.pending_order.push_back(submission_id.clone());
        let (dispatcher, mut calls) = make_dispatcher(false, Vec::new());
        let queue = BridgeQueueService::with_submission_store(
            dispatcher,
            Arc::new(ClientHub::new()),
            Some(receipt_path.clone()),
            submissions,
        );
        let (outbox, mut notifications) = client_outbox(8);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let overdue = Utc::now() - chrono::Duration::minutes(1);
        let mut state = ScheduledPromptState::default();
        state.prompts.insert(
            schedule_id.clone(),
            fixture_entry(schedule_id, thread_id.clone(), overdue),
        );
        std::fs::write(&scheduler_path, encode_state(&state).unwrap()).unwrap();

        let scheduler = ScheduledPromptService::start(
            scheduler_path.clone(),
            Arc::downgrade(&queue),
            queue.hub.clone(),
        )
        .await
        .unwrap();
        assert!(
            next_schedule_notification(&mut notifications).await["params"]["schedules"]
                .as_array()
                .is_some_and(Vec::is_empty)
        );
        assert!(scheduler.list(&thread_id).await.is_empty());
        assert!(calls.try_recv().is_err());
        assert!(!queue
            .submission_pending
            .lock()
            .await
            .contains_key(&submission_id));
        assert!(queue
            .submission_results
            .lock()
            .await
            .contains_key(&submission_id));
        let reloaded = BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .expect("reconciled receipt reloads");
        assert!(reloaded.results.contains_key(&submission_id));
        assert!(reloaded.pending.is_empty());
        scheduler.shutdown().await;

        let restarted = ScheduledPromptService::start(
            scheduler_path,
            Arc::downgrade(&queue),
            queue.hub.clone(),
        )
        .await
        .unwrap();
        let cycle_completed = Arc::new(Notify::new());
        *restarted
            .worker_cycle_completed
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(cycle_completed.clone());
        let completed = cycle_completed.notified();
        tokio::pin!(completed);
        restarted.wake.notify_one();
        tokio::time::timeout(Duration::from_secs(1), completed)
            .await
            .expect("restarted scheduler inspects reconciled state");
        assert!(calls.try_recv().is_err());
        restarted.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn queued_delivery_receipt_wakes_scheduler_and_removes_indicator_immediately() {
        let directory = test_directory("queued-delivery-wake");
        let path = directory.join("scheduled-prompts.json");
        let thread_id = test_thread("queued-delivery");
        let (dispatcher, mut calls) = make_dispatcher(true, Vec::new());
        let queue = make_queue(dispatcher.clone(), None);
        let (outbox, mut notifications) = client_outbox(16);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let scheduler = ScheduledPromptService::start_with_state(
            Some(path),
            Arc::downgrade(&queue),
            queue.hub.clone(),
            ScheduledPromptState::default(),
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        let scheduled = scheduler
            .schedule(
                &thread_id,
                "dispatch after busy".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .unwrap();
        let _ = next_schedule_notification(&mut notifications).await;
        scheduler.make_due_for_test(&scheduled.schedule_id).await;
        let queued_notification = next_schedule_notification(&mut notifications).await;
        assert_eq!(
            queued_notification["params"]["schedules"][0]["status"],
            "queued"
        );
        assert_eq!(
            scheduler.list(&thread_id).await[0].status,
            ScheduledPromptStatus::Queued
        );

        dispatcher.busy.store(false, Ordering::SeqCst);
        {
            let mut threads = queue.threads.write().await;
            let runtime = threads.get_mut(&thread_id).expect("queued runtime");
            runtime.thread_running = false;
            runtime.active_run_id = None;
            runtime.active_turn_id = None;
        }
        queue.spawn_auto_dispatch(thread_id.clone());
        let call = tokio::time::timeout(Duration::from_secs(1), calls.recv())
            .await
            .expect("queued dispatch timeout")
            .expect("queued prompt dispatched");
        call.response.send(Ok("turn-queued".to_string())).unwrap();

        let removed = next_schedule_notification(&mut notifications).await;
        assert!(removed["params"]["schedules"]
            .as_array()
            .is_some_and(Vec::is_empty));
        assert!(scheduler.list(&thread_id).await.is_empty());
        assert!(calls.try_recv().is_err());
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn retirement_fences_racing_admissions_and_failed_delete_rollback_restores_state() {
        let directory = test_directory("retirement-rollback");
        let scheduler_path = directory.join("scheduled-prompts.json");
        let receipt_path = directory.join("queue-idempotency.json");
        let parent = test_thread("retiring-parent");
        let child = test_thread("retiring-child");
        let family = vec![parent.clone(), child.clone()];
        let (dispatcher, mut calls) = make_dispatcher(false, Vec::new());
        let queue = make_queue(dispatcher.clone(), Some(receipt_path.clone()));
        let scheduler = start_test_scheduler(
            scheduler_path.clone(),
            &queue,
            ScheduledPromptState::default(),
        );
        scheduler
            .schedule(
                &parent,
                "existing schedule".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .unwrap();
        dispatcher.busy.store(true, Ordering::SeqCst);
        queue
            .send_message(BridgeThreadQueueSendRequest {
                thread_id: child.clone(),
                submission_id: "queued-before-retirement".to_string(),
                content: "restore this queued item".to_string(),
                turn_start: prompt_turn_start("restore this queued item"),
            })
            .await
            .expect("busy child queues an item");
        dispatcher.busy.store(false, Ordering::SeqCst);

        let admitted = tokio::spawn({
            let queue = queue.clone();
            let parent = parent.clone();
            async move {
                queue
                    .send_message(BridgeThreadQueueSendRequest {
                        thread_id: parent,
                        submission_id: "admitted-before-retirement".to_string(),
                        content: "already admitted".to_string(),
                        turn_start: prompt_turn_start("already admitted"),
                    })
                    .await
            }
        });
        let call = calls.recv().await.expect("turn start reaches dispatcher");
        let (outbox, mut notifications) = client_outbox(8);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let begin_attempted = Arc::new(Notify::new());
        *queue
            .retirement_fence
            .begin_attempted
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(begin_attempted.clone());
        let begin_retirement = tokio::spawn({
            let queue = queue.clone();
            let scheduler = scheduler.clone();
            let family = family.clone();
            async move {
                crate::runtime_backend::ThreadStateRetirement::begin(queue, scheduler, &family)
                    .await
                    .unwrap()
            }
        });
        tokio::time::timeout(Duration::from_secs(1), begin_attempted.notified())
            .await
            .expect("retirement reaches the admission fence");
        assert!(!begin_retirement.is_finished());
        call.response
            .send(Ok("turn-before-retirement".to_string()))
            .unwrap();
        admitted.await.unwrap().unwrap();
        let retirement = begin_retirement.await.unwrap();

        let scheduled_for = (Utc::now() + chrono::Duration::hours(2)).to_rfc3339();
        let (schedule_result, queue_result) = tokio::join!(
            scheduler.schedule(&child, "must be fenced".to_string(), &scheduled_for),
            queue.send_message(BridgeThreadQueueSendRequest {
                thread_id: child.clone(),
                submission_id: "must-be-fenced".to_string(),
                content: "must be fenced".to_string(),
                turn_start: prompt_turn_start("must be fenced"),
            })
        );
        assert!(matches!(
            schedule_result,
            Err(ScheduledPromptError::Internal(error)) if error == "thread is being deleted"
        ));
        assert_eq!(queue_result.unwrap_err(), "thread is being deleted");
        assert_eq!(scheduler.list(&parent).await.len(), 1);
        assert_eq!(queue.read_queue(&child).await.items.len(), 1);
        assert_eq!(
            load_state(&scheduler_path).await.unwrap().prompts.len(),
            1,
            "begin keeps scheduled prompts durable during ACP deletion"
        );
        let durable_during_delete = BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .expect("queue idempotency state remains durable during ACP deletion");
        assert!(durable_during_delete
            .results
            .contains_key("admitted-before-retirement"));
        assert!(
            notifications.try_recv().is_err(),
            "begin must not publish provisional empty state"
        );

        let delete_error = retirement
            .finish_delete(Err("injected ACP deletion failure".to_string()))
            .await
            .unwrap_err();
        assert_eq!(delete_error, "injected ACP deletion failure");

        assert_eq!(scheduler.list(&parent).await.len(), 1);
        assert_eq!(
            queue
                .submission_results
                .lock()
                .await
                .get("admitted-before-retirement")
                .and_then(|receipt| receipt.turn_id.as_deref()),
            Some("turn-before-retirement")
        );
        assert_eq!(
            queue.read_queue(&child).await.items[0].content,
            "restore this queued item"
        );
        assert_eq!(scheduler.list(&parent).await[0].prompt, "existing schedule");
        assert_eq!(
            load_state(&scheduler_path).await.unwrap().prompts.len(),
            1,
            "failed ACP deletion leaves durable schedules untouched"
        );
        let restored_submissions = BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .expect("unchanged queue state reloads");
        assert_eq!(
            restored_submissions
                .results
                .get("admitted-before-retirement")
                .map(|receipt| &receipt.thread_id),
            Some(&parent),
            "failed ACP deletion leaves durable queue receipts untouched"
        );
        assert!(
            notifications.try_recv().is_err(),
            "rollback of an unchanged begin phase must not broadcast restoration"
        );
        drop(
            queue
                .retirement_fence
                .admit(&parent)
                .await
                .expect("failed deletion releases retirement fence"),
        );
        dispatcher.busy.store(true, Ordering::SeqCst);
        scheduler
            .schedule(
                &child,
                "accepted after rollback".to_string(),
                &(Utc::now() + chrono::Duration::hours(3)).to_rfc3339(),
            )
            .await
            .expect("schedule admission reopens after failed deletion");
        queue
            .send_message(BridgeThreadQueueSendRequest {
                thread_id: child,
                submission_id: "accepted-after-rollback".to_string(),
                content: "accepted after rollback".to_string(),
                turn_start: prompt_turn_start("accepted after rollback"),
            })
            .await
            .expect("queue admission reopens after failed deletion");
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn due_dispatch_admission_precedes_scheduler_operation_and_global_retirement_barrier() {
        let directory = test_directory("dispatch-retirement-lock-order");
        let thread_id = test_thread("dispatch-retirement-lock-order");
        let schedule_id = Uuid::new_v4().to_string();
        let due = Utc::now() - chrono::Duration::seconds(1);
        let state = ScheduledPromptState {
            version: SCHEDULER_STATE_VERSION,
            prompts: BTreeMap::from([(
                schedule_id.clone(),
                fixture_entry(schedule_id, thread_id.clone(), due),
            )]),
        };
        let (dispatcher, mut calls) = make_dispatcher(false, Vec::new());
        let queue = make_queue(dispatcher, None);
        let scheduler = ScheduledPromptService::build_with_state(
            Some(directory.join("scheduled-prompts.json")),
            Arc::downgrade(&queue),
            queue.hub.clone(),
            state,
            Duration::from_millis(50),
            Duration::from_millis(200),
        );
        let operation_reached = Arc::new(Notify::new());
        let release_operation = Arc::new(Notify::new());
        *scheduler
            .process_ready_operation_barrier
            .lock()
            .unwrap_or_else(|error| error.into_inner()) =
            Some((operation_reached.clone(), release_operation.clone()));
        let dispatch = tokio::spawn({
            let scheduler = scheduler.clone();
            async move { scheduler.process_ready().await }
        });
        tokio::time::timeout(Duration::from_secs(1), operation_reached.notified())
            .await
            .expect("due dispatch reaches scheduler operation with admission held");

        let barrier_attempted = Arc::new(Notify::new());
        *queue
            .retirement_fence
            .begin_attempted
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(barrier_attempted.clone());
        let retirement = tokio::spawn({
            let queue = queue.clone();
            let scheduler = scheduler.clone();
            let thread_id = thread_id.clone();
            async move {
                crate::runtime_backend::ThreadStateRetirement::begin(
                    queue,
                    scheduler,
                    std::slice::from_ref(&thread_id),
                )
                .await
            }
        });
        tokio::time::timeout(Duration::from_secs(1), barrier_attempted.notified())
            .await
            .expect("deletion queues the global admission barrier");
        assert!(!retirement.is_finished());

        release_operation.notify_one();
        let call = tokio::time::timeout(Duration::from_secs(1), calls.recv())
            .await
            .expect("dispatch cannot deadlock behind a barrier waiting for scheduler operation")
            .expect("due prompt reaches queue dispatcher");
        call.response
            .send(Ok("scheduled-turn".to_string()))
            .expect("settle due prompt");
        tokio::time::timeout(Duration::from_secs(1), dispatch)
            .await
            .expect("due dispatch completes")
            .expect("dispatch task");
        let retirement = tokio::time::timeout(Duration::from_secs(1), retirement)
            .await
            .expect("retirement acquires scheduler operation after dispatch admission drains")
            .expect("retirement task")
            .expect("retirement begins");
        assert_eq!(
            retirement
                .finish_delete(Err("injected delete failure".to_string()))
                .await
                .unwrap_err(),
            "injected delete failure"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn dropping_a_pending_delete_preserves_durable_state_and_releases_fences() {
        let directory = test_directory("dropped-delete");
        let scheduler_path = directory.join("scheduled-prompts.json");
        let thread_id = test_thread("dropped-delete");
        let (dispatcher, _) = make_dispatcher(true, Vec::new());
        let queue = make_queue(dispatcher, None);
        let scheduler = start_test_scheduler(
            scheduler_path.clone(),
            &queue,
            ScheduledPromptState::default(),
        );
        scheduler
            .schedule(
                &thread_id,
                "survives disconnect".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .unwrap();
        queue
            .send_message(BridgeThreadQueueSendRequest {
                thread_id: thread_id.clone(),
                submission_id: "survives-disconnect".to_string(),
                content: "survives disconnect".to_string(),
                turn_start: prompt_turn_start("survives disconnect"),
            })
            .await
            .unwrap();

        let retirement = crate::runtime_backend::ThreadStateRetirement::begin(
            queue.clone(),
            scheduler.clone(),
            std::slice::from_ref(&thread_id),
        )
        .await
        .unwrap();
        assert_eq!(scheduler.list(&thread_id).await.len(), 1);
        assert_eq!(queue.read_queue(&thread_id).await.items.len(), 1);
        assert_eq!(
            load_state(&scheduler_path).await.unwrap().prompts.len(),
            1,
            "dropping a future before ACP deletion completes cannot require durable restoration"
        );

        let (outbox, mut notifications) = client_outbox(8);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let (pending_tx, pending_rx) = oneshot::channel();
        let pending_delete = tokio::spawn(async move {
            let _retirement = retirement;
            pending_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        pending_rx.await.unwrap();
        pending_delete.abort();
        assert!(pending_delete.await.unwrap_err().is_cancelled());

        assert_eq!(scheduler.list(&thread_id).await.len(), 1);
        assert_eq!(queue.read_queue(&thread_id).await.items.len(), 1);
        assert_eq!(load_state(&scheduler_path).await.unwrap().prompts.len(), 1);
        assert!(
            notifications.try_recv().is_err(),
            "abnormal rollback has no provisional state to restore or broadcast"
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                match queue.retirement_fence.admit(&thread_id).await {
                    Ok(_) => break,
                    Err(error) if error == "thread is being deleted" => {
                        tokio::task::yield_now().await;
                    }
                    Err(error) => panic!("unexpected retirement fence error: {error}"),
                }
            }
        })
        .await
        .expect("dropped retirement fence release");

        scheduler
            .schedule(
                &thread_id,
                "accepted after disconnect".to_string(),
                &(Utc::now() + chrono::Duration::hours(2)).to_rfc3339(),
            )
            .await
            .expect("scheduler fence is released");
        queue
            .send_message(BridgeThreadQueueSendRequest {
                thread_id,
                submission_id: "accepted-after-disconnect".to_string(),
                content: "accepted after disconnect".to_string(),
                turn_start: prompt_turn_start("accepted after disconnect"),
            })
            .await
            .expect("queue fence is released");
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn queue_then_scheduler_cleanup_failures_retry_without_releasing_fence() {
        let directory = test_directory("ordered-cleanup-persist-failures");
        let scheduler_path = directory.join("scheduled-prompts.json");
        let receipt_path = directory.join("queue-idempotency.json");
        let thread_id = test_thread("ordered-cleanup-persist-failures");
        let (dispatcher, _) = make_dispatcher(true, Vec::new());
        let queue = make_queue(dispatcher, Some(receipt_path.clone()));
        let scheduler = start_test_scheduler(
            scheduler_path.clone(),
            &queue,
            ScheduledPromptState::default(),
        );
        scheduler
            .schedule(
                &thread_id,
                "recoverable schedule".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .unwrap();
        queue
            .send_message(BridgeThreadQueueSendRequest {
                thread_id: thread_id.clone(),
                submission_id: "recoverable-queue-item".to_string(),
                content: "recoverable queue item".to_string(),
                turn_start: prompt_turn_start("recoverable queue item"),
            })
            .await
            .unwrap();
        queue
            .remember_submission_result(BridgeThreadQueueSendResponse {
                submission_id: "durable-sent-before-delete".to_string(),
                disposition: BridgeThreadQueueDisposition::Sent,
                queue: BridgeQueueService::snapshot_for_thread(&thread_id, None),
                turn_id: Some("sent-before-delete".to_string()),
            })
            .await
            .unwrap();
        let (outbox, mut notifications) = client_outbox(8);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;

        let retirement = crate::runtime_backend::ThreadStateRetirement::begin(
            queue.clone(),
            scheduler.clone(),
            std::slice::from_ref(&thread_id),
        )
        .await
        .unwrap();
        queue
            .fail_next_submission_persist
            .store(true, Ordering::Release);
        scheduler.fail_next_persist.store(true, Ordering::Release);
        let queue_retry_reached = Arc::new(Notify::new());
        let release_queue_retry = Arc::new(Notify::new());
        *queue
            .retirement_retry_barrier
            .lock()
            .unwrap_or_else(|error| error.into_inner()) =
            Some((queue_retry_reached.clone(), release_queue_retry.clone()));
        let cleanup = tokio::spawn({
            let thread_id = thread_id.clone();
            async move { retirement.finish_delete(Ok(vec![thread_id])).await }
        });
        tokio::time::timeout(Duration::from_secs(1), queue_retry_reached.notified())
            .await
            .expect("cleanup reaches retry owner after queue persistence failure");
        assert!(!cleanup.is_finished());
        assert_eq!(scheduler.list(&thread_id).await.len(), 1);
        assert_eq!(queue.read_queue(&thread_id).await.items.len(), 1);
        assert_eq!(load_state(&scheduler_path).await.unwrap().prompts.len(), 1);
        assert!(BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .unwrap()
            .results
            .contains_key("durable-sent-before-delete"));
        assert!(queue.submission_dirty.load(Ordering::Acquire));
        assert!(
            notifications.try_recv().is_err(),
            "partial cleanup must not publish successful empty snapshots"
        );
        assert_eq!(
            queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
            "thread is being deleted"
        );

        let scheduler_retry_reached = Arc::new(Notify::new());
        let release_scheduler_retry = Arc::new(Notify::new());
        *queue
            .retirement_retry_barrier
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some((
            scheduler_retry_reached.clone(),
            release_scheduler_retry.clone(),
        ));
        release_queue_retry.notify_one();
        tokio::time::timeout(Duration::from_secs(1), scheduler_retry_reached.notified())
            .await
            .expect("cleanup reaches retry owner after scheduler persistence failure");
        assert!(!cleanup.is_finished());
        assert!(queue.read_queue(&thread_id).await.items.is_empty());
        assert!(BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .unwrap()
            .results
            .is_empty());
        assert_eq!(scheduler.list(&thread_id).await.len(), 1);
        assert_eq!(load_state(&scheduler_path).await.unwrap().prompts.len(), 1);
        assert_eq!(
            queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
            "thread is being deleted"
        );

        release_scheduler_retry.notify_one();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), cleanup)
                .await
                .expect("ordered cleanup retries complete")
                .expect("cleanup task")
                .expect("retirement converges"),
            vec![thread_id.clone()]
        );
        assert!(scheduler.list(&thread_id).await.is_empty());
        assert!(load_state(&scheduler_path)
            .await
            .unwrap()
            .prompts
            .is_empty());
        assert_eq!(
            queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
            "thread is being deleted",
            "converged cleanup leaves a permanent deleted-thread tombstone"
        );
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn parent_family_retirement_clears_schedules_queue_state_and_durable_pending_ids() {
        let directory = test_directory("family-retirement");
        let scheduler_path = directory.join("scheduled-prompts.json");
        let receipt_path = directory.join("queue-idempotency.json");
        let parent = test_thread("parent");
        let child = test_thread("child");
        let interrupted_id = "interrupted-before-delete".to_string();
        let mut submissions = crate::queue_service::DurableQueueSubmissions::default();
        submissions
            .pending
            .insert(interrupted_id.clone(), child.clone());
        submissions.pending_order.push_back(interrupted_id);
        let (dispatcher, _) = make_dispatcher(true, Vec::new());
        let queue = BridgeQueueService::with_submission_store(
            dispatcher,
            Arc::new(ClientHub::new()),
            Some(receipt_path.clone()),
            submissions,
        );
        let (outbox, mut notifications) = client_outbox(32);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let scheduler = start_test_scheduler(
            scheduler_path.clone(),
            &queue,
            ScheduledPromptState::default(),
        );
        for thread_id in [&parent, &child] {
            scheduler
                .schedule(
                    thread_id,
                    format!("scheduled for {thread_id}"),
                    &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
                )
                .await
                .unwrap();
            queue
                .send_message(BridgeThreadQueueSendRequest {
                    thread_id: thread_id.clone(),
                    submission_id: format!("ordinary-queue-{thread_id}"),
                    content: "queued before delete".to_string(),
                    turn_start: prompt_turn_start("queued before delete"),
                })
                .await
                .unwrap();
        }
        let _ = next_schedule_notification(&mut notifications).await;
        let _ = next_schedule_notification(&mut notifications).await;
        while notifications.try_recv().is_ok() {}

        let family = vec![parent.clone(), child.clone()];
        let retirement = crate::runtime_backend::ThreadStateRetirement::begin(
            queue.clone(),
            scheduler.clone(),
            &family,
        )
        .await
        .unwrap();
        assert_eq!(scheduler.list(&parent).await.len(), 1);
        assert_eq!(scheduler.list(&child).await.len(), 1);
        assert_eq!(queue.read_queue(&parent).await.items.len(), 1);
        assert_eq!(queue.read_queue(&child).await.items.len(), 1);
        assert_eq!(load_state(&scheduler_path).await.unwrap().prompts.len(), 2);
        assert!(
            notifications.try_recv().is_err(),
            "begin does not publish provisional empty family snapshots"
        );
        assert_eq!(
            retirement.finish_delete(Ok(family.clone())).await.unwrap(),
            family
        );

        let mut empty_schedule_threads = HashSet::new();
        let mut empty_queue_threads = HashSet::new();
        tokio::time::timeout(Duration::from_secs(1), async {
            while empty_schedule_threads.len() < 2 || empty_queue_threads.len() < 2 {
                let notification = next_bridge_notification(&mut notifications).await;
                let Some(thread_id) = notification["params"]["threadId"].as_str() else {
                    continue;
                };
                match notification["method"].as_str() {
                    Some("bridge/thread/schedules/updated")
                        if notification["params"]["schedules"]
                            .as_array()
                            .is_some_and(Vec::is_empty) =>
                    {
                        empty_schedule_threads.insert(thread_id.to_string());
                    }
                    Some("bridge/thread/queue/updated")
                        if notification["params"]["items"]
                            .as_array()
                            .is_some_and(Vec::is_empty) =>
                    {
                        empty_queue_threads.insert(thread_id.to_string());
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("empty family snapshots broadcast");
        assert_eq!(
            empty_schedule_threads,
            HashSet::from([parent.clone(), child.clone()])
        );
        assert_eq!(
            empty_queue_threads,
            HashSet::from([parent.clone(), child.clone()])
        );
        assert!(scheduler.list(&parent).await.is_empty());
        assert!(scheduler.list(&child).await.is_empty());
        assert_eq!(scheduler.pending_count().await, 0);
        let queue_status = queue.status().await;
        assert_eq!(queue_status.tracked_threads, 0);
        assert_eq!(queue_status.depth, 0);
        let reloaded = BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .expect("retired queue state reloads");
        assert!(reloaded.pending.is_empty());
        assert!(reloaded.results.is_empty());
        assert!(load_state(&scheduler_path)
            .await
            .unwrap()
            .prompts
            .is_empty());
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    fn state_with_entry(map_key: String, entry: StoredScheduledPrompt) -> ScheduledPromptState {
        ScheduledPromptState {
            version: SCHEDULER_STATE_VERSION,
            prompts: BTreeMap::from([(map_key, entry)]),
        }
    }

    #[test]
    fn persisted_state_validation_rejects_each_field_invariant() {
        let schedule_id = Uuid::new_v4().to_string();
        let future = Utc::now() + chrono::Duration::hours(1);
        let valid = fixture_entry(schedule_id.clone(), test_thread("validation"), future);
        let invalid_error = |entry: StoredScheduledPrompt| {
            validate_state(&state_with_entry(schedule_id.clone(), entry)).unwrap_err()
        };

        let mut state = ScheduledPromptState::default();
        state.version += 1;
        assert!(validate_state(&state).unwrap_err().contains("version"));

        let mut entry = valid.clone();
        entry.schedule_id = Uuid::new_v4().to_string();
        assert!(invalid_error(entry).contains("map key"));

        for prompt in [" ".to_string(), "x".repeat(QUEUE_MAX_CONTENT_BYTES + 1)] {
            let mut entry = valid.clone();
            entry.prompt = prompt;
            assert!(invalid_error(entry).contains("content"));
        }

        let mut entry = valid.clone();
        entry.status = StoredScheduledPromptStatus::Retrying;
        entry.retry_attempt = 1;
        entry.last_error = Some("x".repeat(SCHEDULER_ERROR_MAX_BYTES + 1));
        assert!(invalid_error(entry).contains("retry error"));

        let mut entry = valid.clone();
        entry.created_at = entry.scheduled_for + chrono::Duration::seconds(1);
        assert!(invalid_error(entry).contains("creation time"));

        let mut inconsistent_scheduled = Vec::new();
        let mut entry = valid.clone();
        entry.retry_attempt = 1;
        inconsistent_scheduled.push(entry);
        let mut entry = valid.clone();
        entry.last_error = Some("error".to_string());
        inconsistent_scheduled.push(entry);
        let mut entry = valid.clone();
        entry.next_attempt_at += chrono::Duration::seconds(1);
        inconsistent_scheduled.push(entry);
        for entry in inconsistent_scheduled {
            assert!(invalid_error(entry).contains("inconsistent scheduled"));
        }

        let mut entry = valid.clone();
        entry.status = StoredScheduledPromptStatus::Queued;
        entry.retry_attempt = 0;
        assert!(invalid_error(entry).contains("inconsistent queued"));
        let mut entry = valid.clone();
        entry.status = StoredScheduledPromptStatus::Queued;
        entry.retry_attempt = 1;
        entry.last_error = Some("error".to_string());
        assert!(invalid_error(entry).contains("inconsistent queued"));

        let mut entry = valid;
        entry.status = StoredScheduledPromptStatus::Retrying;
        entry.retry_attempt = 0;
        assert!(invalid_error(entry).contains("inconsistent retry"));

        assert!(validate_schedule_id("").unwrap_err().contains("between"));
        assert!(
            validate_schedule_id(&"x".repeat(SCHEDULE_IDENTIFIER_MAX_BYTES + 1))
                .unwrap_err()
                .contains("between")
        );
        assert!(validate_schedule_id(&schedule_id.to_uppercase())
            .unwrap_err()
            .contains("canonical"));
        assert_eq!(
            truncate_error("é".repeat(SCHEDULER_ERROR_MAX_BYTES)).len(),
            SCHEDULER_ERROR_MAX_BYTES
        );
    }

    #[tokio::test]
    async fn scheduler_guards_worker_and_handles_missing_or_unavailable_work() {
        let scheduler = ScheduledPromptService::inert_for_test();
        assert_eq!(
            scheduler
                .cancel(&test_thread("missing"), &Uuid::new_v4().to_string())
                .await
                .unwrap()
                .status,
            CancelScheduledPromptStatus::NotFound
        );
        assert!(scheduler
            .schedule(
                &test_thread("blank"),
                " \n ".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .is_err());
        assert!(scheduler.start_worker().is_ok());
        assert!(scheduler
            .start_worker()
            .unwrap_err()
            .contains("already running"));
        scheduler.shutdown().await;

        let unavailable = ScheduledPromptService::build_with_state(
            None,
            Weak::new(),
            Arc::new(ClientHub::new()),
            ScheduledPromptState::default(),
            Duration::from_millis(1),
            Duration::from_millis(2),
        );
        unavailable.process_ready().await;
        unavailable
            .record_cancellation_retry(&Uuid::new_v4().to_string(), "ignored".to_string())
            .await
            .unwrap();

        let due = Utc::now() - chrono::Duration::seconds(1);
        let schedule_id = Uuid::new_v4().to_string();
        let due_state = state_with_entry(
            schedule_id.clone(),
            fixture_entry(schedule_id, test_thread("unavailable"), due),
        );
        let unavailable = ScheduledPromptService::build_with_state(
            None,
            Weak::new(),
            Arc::new(ClientHub::new()),
            due_state,
            Duration::from_millis(1),
            Duration::from_millis(2),
        );
        unavailable.process_ready().await;
        assert_eq!(unavailable.pending_count().await, 1);
    }

    #[tokio::test]
    async fn settlement_paths_retain_work_when_scheduler_persistence_fails() {
        let due = Utc::now() - chrono::Duration::seconds(1);

        let scheduler = ScheduledPromptService::inert_for_test();
        let schedule_id = Uuid::new_v4().to_string();
        let mut entry = fixture_entry(schedule_id.clone(), test_thread("retry-record"), due);
        entry.status = StoredScheduledPromptStatus::Cancelling;
        scheduler
            .state
            .lock()
            .await
            .prompts
            .insert(schedule_id.clone(), entry.clone());
        scheduler
            .record_cancellation_retry(&schedule_id, "retry".to_string())
            .await
            .unwrap();
        assert_eq!(
            scheduler
                .state
                .lock()
                .await
                .prompts
                .get(&schedule_id)
                .unwrap()
                .retry_attempt,
            1
        );
        scheduler.fail_next_persist.store(true, Ordering::Release);
        scheduler.settle_delivered(&entry).await;
        assert!(scheduler
            .state
            .lock()
            .await
            .prompts
            .contains_key(&schedule_id));

        let schedule_id = Uuid::new_v4().to_string();
        let mut queued = fixture_entry(
            schedule_id.clone(),
            test_thread("unavailable-settlement"),
            due,
        );
        queued.status = StoredScheduledPromptStatus::Queued;
        queued.retry_attempt = 1;
        queued.next_attempt_at = due + chrono::Duration::seconds(1);
        let unavailable = ScheduledPromptService::build_with_state(
            None,
            Weak::new(),
            Arc::new(ClientHub::new()),
            state_with_entry(schedule_id, queued),
            Duration::from_millis(1),
            Duration::from_millis(2),
        );
        unavailable.settle_completed_submissions().await;

        let schedule_id = Uuid::new_v4().to_string();
        let thread_id = test_thread("completed-persist-failure");
        let mut queued = fixture_entry(schedule_id.clone(), thread_id.clone(), due);
        queued.status = StoredScheduledPromptStatus::Queued;
        queued.retry_attempt = 1;
        queued.next_attempt_at = due + chrono::Duration::seconds(1);
        let (dispatcher, _) = make_dispatcher(true, Vec::new());
        let queue = make_queue(dispatcher, None);
        queue
            .remember_submission_result(BridgeThreadQueueSendResponse {
                submission_id: submission_id(&schedule_id),
                disposition: BridgeThreadQueueDisposition::Sent,
                queue: BridgeQueueService::snapshot_for_thread(&thread_id, None),
                turn_id: Some("completed-turn".to_string()),
            })
            .await
            .unwrap();
        let scheduler = ScheduledPromptService::build_with_state(
            None,
            Arc::downgrade(&queue),
            queue.hub.clone(),
            state_with_entry(schedule_id.clone(), queued),
            Duration::from_millis(1),
            Duration::from_millis(2),
        );
        scheduler.fail_next_persist.store(true, Ordering::Release);
        scheduler.settle_completed_submissions().await;
        assert!(scheduler
            .state
            .lock()
            .await
            .prompts
            .contains_key(&schedule_id));
    }

    #[tokio::test]
    async fn interrupted_settlement_for_another_thread_does_not_mutate_the_schedule() {
        let scheduler = ScheduledPromptService::inert_for_test();
        let schedule_id = Uuid::new_v4().to_string();
        let thread_id = test_thread("interrupted-settlement");
        let entry = fixture_entry(
            schedule_id.clone(),
            thread_id.clone(),
            Utc::now() + chrono::Duration::hours(1),
        );
        scheduler
            .state
            .lock()
            .await
            .prompts
            .insert(schedule_id.clone(), entry.clone());
        let (dispatcher, _) = make_dispatcher(false, Vec::new());
        let queue = make_queue(dispatcher, None);
        queue
            .interrupted_definitive_settlements
            .lock()
            .await
            .insert(
                submission_id(&schedule_id),
                (test_thread("other"), "interrupted".to_string()),
            );

        scheduler
            .persist_interrupted_definitive_settlements(&queue)
            .await;

        assert_eq!(
            scheduler.state.lock().await.prompts[&schedule_id].status,
            entry.status
        );
        assert!(queue.interrupted_definitive_settlements().await.is_empty());
    }

    #[tokio::test]
    async fn ready_work_preserves_cancellation_queue_and_retry_on_persist_failure() {
        let due = Utc::now() - chrono::Duration::seconds(1);

        let schedule_id = Uuid::new_v4().to_string();
        let mut cancelling = fixture_entry(
            schedule_id.clone(),
            test_thread("cancel-persist-failure"),
            due,
        );
        cancelling.status = StoredScheduledPromptStatus::Cancelling;
        let (dispatcher, _) = make_dispatcher(false, Vec::new());
        let queue = make_queue(dispatcher, None);
        let scheduler = ScheduledPromptService::build_with_state(
            None,
            Arc::downgrade(&queue),
            queue.hub.clone(),
            state_with_entry(schedule_id.clone(), cancelling),
            Duration::from_millis(1),
            Duration::from_millis(2),
        );
        scheduler.fail_next_persist.store(true, Ordering::Release);
        scheduler.process_ready().await;
        assert!(scheduler
            .state
            .lock()
            .await
            .prompts
            .contains_key(&schedule_id));

        let schedule_id = Uuid::new_v4().to_string();
        let queued = fixture_entry(
            schedule_id.clone(),
            test_thread("queue-persist-failure"),
            due,
        );
        let (dispatcher, _) = make_dispatcher(true, Vec::new());
        let queue = make_queue(dispatcher, None);
        let scheduler = ScheduledPromptService::build_with_state(
            None,
            Arc::downgrade(&queue),
            queue.hub.clone(),
            state_with_entry(schedule_id.clone(), queued),
            Duration::from_millis(1),
            Duration::from_millis(2),
        );
        scheduler.fail_next_persist.store(true, Ordering::Release);
        scheduler.process_ready().await;
        assert!(scheduler
            .state
            .lock()
            .await
            .prompts
            .contains_key(&schedule_id));

        let schedule_id = Uuid::new_v4().to_string();
        let retrying = fixture_entry(
            schedule_id.clone(),
            test_thread("retry-persist-failure"),
            due,
        );
        let (dispatcher, _) =
            make_dispatcher(false, vec![Err("injected dispatch failure".to_string())]);
        let queue = make_queue(dispatcher, None);
        let scheduler = ScheduledPromptService::build_with_state(
            None,
            Arc::downgrade(&queue),
            queue.hub.clone(),
            state_with_entry(schedule_id.clone(), retrying),
            Duration::from_millis(1),
            Duration::from_millis(2),
        );
        scheduler.fail_next_persist.store(true, Ordering::Release);
        scheduler.process_ready().await;
        assert!(scheduler
            .state
            .lock()
            .await
            .prompts
            .contains_key(&schedule_id));
    }

    #[tokio::test]
    async fn ready_work_is_rechecked_after_waiting_for_the_operation_lock() {
        for remove in [false, true] {
            let schedule_id = Uuid::new_v4().to_string();
            let thread_id = test_thread(if remove {
                "removed-while-waiting"
            } else {
                "deferred-while-waiting"
            });
            let due = Utc::now() - chrono::Duration::seconds(1);
            let state = state_with_entry(
                schedule_id.clone(),
                fixture_entry(schedule_id.clone(), thread_id, due),
            );
            let (dispatcher, _) = make_dispatcher(false, Vec::new());
            let queue = make_queue(dispatcher, None);
            let scheduler = ScheduledPromptService::build_with_state(
                None,
                Arc::downgrade(&queue),
                queue.hub.clone(),
                state,
                Duration::from_millis(1),
                Duration::from_millis(2),
            );
            let reached = Arc::new(Notify::new());
            let release = Arc::new(Notify::new());
            *scheduler
                .process_ready_operation_barrier
                .lock()
                .unwrap_or_else(|error| error.into_inner()) =
                Some((reached.clone(), release.clone()));
            let processing = tokio::spawn({
                let scheduler = scheduler.clone();
                async move { scheduler.process_ready().await }
            });
            reached.notified().await;
            if remove {
                scheduler.state.lock().await.prompts.remove(&schedule_id);
            } else {
                scheduler
                    .state
                    .lock()
                    .await
                    .prompts
                    .get_mut(&schedule_id)
                    .unwrap()
                    .next_attempt_at = Utc::now() + chrono::Duration::hours(1);
            }
            release.notify_one();
            processing.await.unwrap();
            assert_eq!(
                scheduler
                    .state
                    .lock()
                    .await
                    .prompts
                    .contains_key(&schedule_id),
                !remove
            );
        }
    }

    #[tokio::test]
    async fn encoded_state_budget_is_enforced_after_field_validation() {
        let prompt = "x".repeat(QUEUE_MAX_CONTENT_BYTES);
        let future = Utc::now() + chrono::Duration::hours(1);
        let mut state = ScheduledPromptState::default();
        for index in 0..140 {
            let schedule_id = Uuid::new_v4().to_string();
            let mut entry = fixture_entry(
                schedule_id.clone(),
                test_thread(&format!("large-state-{index}")),
                future,
            );
            entry.prompt = prompt.clone();
            state.prompts.insert(schedule_id, entry);
        }
        assert!(encode_state(&state)
            .expect_err("large valid state must exceed encoded byte budget")
            .contains("byte budget"));
    }
}
