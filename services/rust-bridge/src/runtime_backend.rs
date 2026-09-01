use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Mutex as StdMutex,
    },
    time::Duration,
};

use agent_client_protocol::schema::v1::{
    ContentBlock, ElicitationContentValue, NewSessionRequest, ResourceLink,
    SessionConfigOptionValue,
};
use dappercode_bridge_platform::wait_for_shutdown_signal as wait_for_platform_shutdown;
use futures_util::future::BoxFuture;
use tokio_util::sync::CancellationToken;

use crate::acp::interactions::{ApprovalPolicy, ElicitationFieldKind};
use crate::acp::manager::{
    AgentLifecycle, AgentManager, AgentOperationFailure, HarnessChildSession,
    LocalAgentManifestSet, ManagedSession, RetirementPlanReconciliation,
};
use crate::acp::runtime::RequestCancellation;
use crate::*;

pub(super) const INDETERMINATE_OPERATION_PREFIX: &str = "indeterminate operation outcome: ";

fn indeterminate_operation_error(error: impl std::fmt::Display) -> String {
    format!("{INDETERMINATE_OPERATION_PREFIX}{error}")
}

fn classified_operation_error(error: AgentOperationFailure) -> String {
    if error.is_indeterminate() {
        indeterminate_operation_error(error)
    } else {
        error.to_string()
    }
}

pub(super) struct RuntimeBackend {
    manager: Arc<AgentManager>,
    hub: Arc<ClientHub>,
    event_pump: Mutex<Option<tokio::task::JoinHandle<()>>>,
    event_side_effects: Mutex<Option<tokio::task::JoinHandle<()>>>,
    agent_messaging: Mutex<Option<crate::agent_messaging::AgentMessagingService>>,
    thread_lifecycle: Mutex<Option<ThreadLifecycleServices>>,
    retirement_journal: Arc<crate::retirement_journal::ThreadRetirementJournal>,
    retirement_shutdown: CancellationToken,
    client_requests: ClientRequestTracker,
}

struct ThreadLifecycleServices {
    queue: std::sync::Weak<BridgeQueueService>,
    scheduler: std::sync::Weak<crate::scheduled_prompts::ScheduledPromptService>,
}

#[cfg(not(test))]
const THREAD_RETIREMENT_RETRY_MIN: Duration = Duration::from_millis(25);
#[cfg(not(test))]
const THREAD_RETIREMENT_RETRY_MAX: Duration = Duration::from_secs(1);
const THREAD_RETIREMENT_STARTUP_MAX_ATTEMPTS: u32 = 5;

pub(crate) struct ThreadStateRetirement {
    transaction: Option<ThreadStateRetirementTransaction>,
}

struct ThreadStateRetirementTransaction {
    thread_ids: Vec<String>,
    queue: Arc<BridgeQueueService>,
    scheduler: Arc<crate::scheduled_prompts::ScheduledPromptService>,
    queue_retirement: Option<crate::queue_service::QueueThreadRetirement>,
    scheduler_retirement: Option<crate::scheduled_prompts::ScheduledPromptRetirement>,
    fence: Option<crate::queue_service::ThreadRetirementLease>,
    journal: Arc<crate::retirement_journal::ThreadRetirementJournal>,
    journal_retirement_ids: Vec<String>,
    shutdown: CancellationToken,
    max_commit_attempts: Option<u32>,
}

struct ExistingThreadRetirement {
    journal_retirement_ids: Vec<String>,
    max_commit_attempts: u32,
}

trait RetirementSessionReconciler: Send + Sync {
    fn reconcile_retirement_plan<'a>(
        &'a self,
        thread_ids: &'a [String],
    ) -> BoxFuture<'a, RetirementPlanReconciliation>;

    fn expand_absent_retirement_family<'a>(
        &'a self,
        thread_ids: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<String>, String>>;

    fn finalize_confirmed_deleted_sessions<'a>(
        &'a self,
        thread_ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), String>>;
}

impl RetirementSessionReconciler for AgentManager {
    fn reconcile_retirement_plan<'a>(
        &'a self,
        thread_ids: &'a [String],
    ) -> BoxFuture<'a, RetirementPlanReconciliation> {
        Box::pin(AgentManager::reconcile_retirement_plan(self, thread_ids))
    }

    fn expand_absent_retirement_family<'a>(
        &'a self,
        thread_ids: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<String>, String>> {
        Box::pin(async move {
            AgentManager::expand_retirement_family(self, thread_ids)
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn finalize_confirmed_deleted_sessions<'a>(
        &'a self,
        thread_ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            AgentManager::finalize_confirmed_deleted_sessions(self, thread_ids)
                .await
                .map_err(|error| error.to_string())
        })
    }
}

impl ThreadStateRetirement {
    #[cfg(test)]
    pub(crate) async fn begin(
        queue: Arc<BridgeQueueService>,
        scheduler: Arc<crate::scheduled_prompts::ScheduledPromptService>,
        thread_ids: &[String],
    ) -> Result<Self, String> {
        let barrier = queue.block_retirement_admissions().await;
        let retirement = Self::begin_authoritative_with_journal(
            queue.clone(),
            scheduler,
            Arc::new(crate::retirement_journal::ThreadRetirementJournal::inert_for_test()),
            CancellationToken::new(),
            thread_ids,
            &barrier,
        )
        .await?;
        drop(barrier);
        Ok(retirement)
    }

    #[cfg(test)]
    async fn begin_with_journal(
        queue: Arc<BridgeQueueService>,
        scheduler: Arc<crate::scheduled_prompts::ScheduledPromptService>,
        journal: Arc<crate::retirement_journal::ThreadRetirementJournal>,
        shutdown: CancellationToken,
        thread_ids: &[String],
    ) -> Result<Self, String> {
        let barrier = queue.block_retirement_admissions().await;
        let retirement = Self::begin_authoritative_with_journal(
            queue, scheduler, journal, shutdown, thread_ids, &barrier,
        )
        .await?;
        drop(barrier);
        Ok(retirement)
    }

    async fn begin_transaction(
        queue: Arc<BridgeQueueService>,
        scheduler: Arc<crate::scheduled_prompts::ScheduledPromptService>,
        journal: Arc<crate::retirement_journal::ThreadRetirementJournal>,
        shutdown: CancellationToken,
        thread_ids: &[String],
        existing: Option<ExistingThreadRetirement>,
        admission_barrier: Option<&crate::queue_service::ThreadRetirementAdmissionBarrier>,
    ) -> Result<Self, String> {
        let mut thread_ids = thread_ids.to_vec();
        thread_ids.sort();
        thread_ids.dedup();
        let fence = match admission_barrier {
            Some(barrier) => queue.begin_retirement_fence_blocked(&thread_ids, barrier)?,
            None => queue.begin_retirement_fence(&thread_ids).await?,
        };
        let scheduler_retirement = match scheduler.begin_thread_retirement(&thread_ids).await {
            Ok(retirement) => retirement,
            Err(error) => {
                fence.finish().await;
                return Err(error.to_string());
            }
        };
        let queue_retirement = match queue.begin_thread_retirement(&thread_ids).await {
            Ok(retirement) => retirement,
            Err(error) => {
                scheduler
                    .rollback_thread_retirement(scheduler_retirement)
                    .await;
                fence.finish().await;
                return Err(error);
            }
        };
        let (journal_retirement_ids, max_commit_attempts) = match existing {
            Some(existing) => (
                existing.journal_retirement_ids,
                Some(existing.max_commit_attempts),
            ),
            None => match journal.add_prepared(&thread_ids).await {
                Ok(retirement_id) => (vec![retirement_id], None),
                Err(error) => {
                    queue.rollback_thread_retirement(queue_retirement).await;
                    scheduler
                        .rollback_thread_retirement(scheduler_retirement)
                        .await;
                    fence.finish().await;
                    return Err(error);
                }
            },
        };
        Ok(Self {
            transaction: Some(ThreadStateRetirementTransaction {
                thread_ids,
                queue,
                scheduler,
                queue_retirement: Some(queue_retirement),
                scheduler_retirement: Some(scheduler_retirement),
                fence: Some(fence),
                journal,
                journal_retirement_ids,
                shutdown,
                max_commit_attempts,
            }),
        })
    }

    async fn begin_authoritative_with_journal(
        queue: Arc<BridgeQueueService>,
        scheduler: Arc<crate::scheduled_prompts::ScheduledPromptService>,
        journal: Arc<crate::retirement_journal::ThreadRetirementJournal>,
        shutdown: CancellationToken,
        thread_ids: &[String],
        admission_barrier: &crate::queue_service::ThreadRetirementAdmissionBarrier,
    ) -> Result<Self, String> {
        Self::begin_transaction(
            queue,
            scheduler,
            journal,
            shutdown,
            thread_ids,
            None,
            Some(admission_barrier),
        )
        .await
    }

    async fn recover_pending(
        queue: Arc<BridgeQueueService>,
        scheduler: Arc<crate::scheduled_prompts::ScheduledPromptService>,
        journal: Arc<crate::retirement_journal::ThreadRetirementJournal>,
        reconciler: &dyn RetirementSessionReconciler,
        shutdown: CancellationToken,
    ) -> Result<(), String> {
        let entries = journal.entries().await;
        if entries.is_empty() {
            return Ok(());
        }
        let persisted_deleted_thread_ids = entries
            .iter()
            .filter(|entry| entry.phase == crate::retirement_journal::RetirementPhase::Deleted)
            .flat_map(|entry| entry.deleted_thread_ids.iter().cloned())
            .collect::<Vec<_>>();
        if !persisted_deleted_thread_ids.is_empty() {
            queue
                .install_deleted_thread_tombstones(&persisted_deleted_thread_ids)
                .await?;
        }
        let mut retirement_ids = Vec::new();
        let mut thread_ids = Vec::new();
        for entry in entries {
            match entry.phase {
                crate::retirement_journal::RetirementPhase::Prepared => {
                    match reconciler
                        .reconcile_retirement_plan(&entry.requested_thread_ids)
                        .await
                    {
                        RetirementPlanReconciliation::Present => {
                            Self::clear_journal_until_converged(
                                &queue,
                                &journal,
                                std::slice::from_ref(&entry.retirement_id),
                                &shutdown,
                                Some(THREAD_RETIREMENT_STARTUP_MAX_ATTEMPTS),
                            )
                            .await?;
                            continue;
                        }
                        RetirementPlanReconciliation::Absent => {
                            let expanded = reconciler
                                .expand_absent_retirement_family(&entry.requested_thread_ids)
                                .await?;
                            match reconciler.reconcile_retirement_plan(&expanded).await {
                                RetirementPlanReconciliation::Absent => {}
                                RetirementPlanReconciliation::Present
                                | RetirementPlanReconciliation::Indeterminate => {
                                    return Err(format!(
                                        "prepared retirement {} has an indeterminate or mixed expanded ACP session family",
                                        entry.retirement_id
                                    ));
                                }
                            }
                            let deleted = Self::mark_journal_deleted_until_converged(
                                &queue,
                                &journal,
                                &entry.retirement_id,
                                &expanded,
                                &shutdown,
                                Some(THREAD_RETIREMENT_STARTUP_MAX_ATTEMPTS),
                            )
                            .await?;
                            retirement_ids.push(entry.retirement_id);
                            thread_ids.extend(deleted);
                        }
                        RetirementPlanReconciliation::Indeterminate => {
                            return Err(format!(
                                "prepared retirement {} has an indeterminate or mixed ACP session state",
                                entry.retirement_id
                            ));
                        }
                    }
                }
                crate::retirement_journal::RetirementPhase::Deleted => {
                    retirement_ids.push(entry.retirement_id);
                    thread_ids.extend(entry.deleted_thread_ids);
                }
            }
        }
        if retirement_ids.is_empty() {
            return Ok(());
        }
        thread_ids.sort();
        thread_ids.dedup();
        queue.install_deleted_thread_tombstones(&thread_ids).await?;
        reconciler
            .finalize_confirmed_deleted_sessions(&thread_ids)
            .await?;
        let retirement = Self::begin_transaction(
            queue,
            scheduler,
            journal,
            shutdown,
            &thread_ids,
            Some(ExistingThreadRetirement {
                journal_retirement_ids: retirement_ids,
                max_commit_attempts: THREAD_RETIREMENT_STARTUP_MAX_ATTEMPTS,
            }),
            None,
        )
        .await?;
        retirement.commit_deleted(thread_ids).await
    }

    #[cfg(test)]
    fn abandon_for_test(mut self) {
        drop(self.transaction.take());
    }

    #[cfg(test)]
    async fn commit_queue_then_abandon_for_test(mut self) -> Result<(), String> {
        let transaction = self.take_transaction();
        let thread_ids =
            Self::mark_deleted_until_converged(&transaction, &transaction.thread_ids).await?;
        Self::commit_queue_until_converged(
            &transaction.queue,
            transaction
                .queue_retirement
                .as_ref()
                .expect("active retirement owns queue guards"),
            &transaction.shutdown,
            transaction.max_commit_attempts,
        )
        .await?;
        assert_eq!(thread_ids, transaction.thread_ids);
        drop(transaction);
        Ok(())
    }

    #[cfg(test)]
    async fn commit_scheduler_then_abandon_for_test(mut self) -> Result<(), String> {
        let transaction = self.take_transaction();
        let thread_ids =
            Self::mark_deleted_until_converged(&transaction, &transaction.thread_ids).await?;
        Self::commit_scheduler_until_converged(
            &transaction.queue,
            &transaction.scheduler,
            transaction
                .scheduler_retirement
                .as_ref()
                .expect("active retirement owns scheduler guard"),
            &transaction.shutdown,
            transaction.max_commit_attempts,
        )
        .await?;
        assert_eq!(thread_ids, transaction.thread_ids);
        drop(transaction);
        Ok(())
    }

    #[cfg(test)]
    async fn mark_deleted_then_abandon_for_test(
        mut self,
        deleted_thread_ids: &[String],
    ) -> Result<Vec<String>, String> {
        let transaction = self.take_transaction();
        let thread_ids =
            Self::mark_deleted_until_converged(&transaction, deleted_thread_ids).await?;
        drop(transaction);
        Ok(thread_ids)
    }

    pub(crate) async fn finish_delete(
        mut self,
        deletion: Result<Vec<String>, String>,
    ) -> Result<Vec<String>, String> {
        let transaction = self.take_transaction();
        match deletion {
            Ok(deleted_thread_ids) => {
                let mut frozen_deleted_thread_ids = deleted_thread_ids.clone();
                frozen_deleted_thread_ids.sort();
                frozen_deleted_thread_ids.dedup();
                if frozen_deleted_thread_ids != transaction.thread_ids {
                    Self::release_transaction_preserving_journal(transaction).await;
                    return Err(
                        "ACP deletion returned a family different from its prepared scope"
                            .to_string(),
                    );
                }
                let thread_ids =
                    Self::mark_deleted_until_converged(&transaction, &deleted_thread_ids)
                        .await
                        .map_err(|error| {
                            format!(
                        "ACP deletion succeeded but deleted state could not be journaled: {error}"
                    )
                        })?;
                Self::commit_transaction(transaction, thread_ids.clone())
                    .await
                    .map_err(|error| {
                        format!("ACP deletion succeeded but bridge state cleanup failed: {error}")
                    })?;
                Ok(deleted_thread_ids)
            }
            Err(delete_error) => {
                Self::release_transaction_preserving_journal(transaction).await;
                Err(delete_error)
            }
        }
    }

    async fn commit_deleted(mut self, thread_ids: Vec<String>) -> Result<(), String> {
        let transaction = self.take_transaction();
        Self::commit_transaction(transaction, thread_ids).await
    }

    async fn commit_transaction(
        transaction: ThreadStateRetirementTransaction,
        cleanup_thread_ids: Vec<String>,
    ) -> Result<(), String> {
        let ThreadStateRetirementTransaction {
            thread_ids: _,
            queue,
            scheduler,
            queue_retirement,
            scheduler_retirement,
            fence,
            journal,
            journal_retirement_ids,
            shutdown,
            max_commit_attempts,
        } = transaction;
        let queue_retirement =
            queue_retirement.expect("active retirement owns complete-family queue guards");
        let scheduler_retirement =
            scheduler_retirement.expect("active retirement owns complete-family scheduler guard");

        Self::commit_queue_until_converged(
            &queue,
            &queue_retirement,
            &shutdown,
            max_commit_attempts,
        )
        .await?;
        drop(queue_retirement);
        Self::commit_scheduler_until_converged(
            &queue,
            &scheduler,
            &scheduler_retirement,
            &shutdown,
            max_commit_attempts,
        )
        .await?;
        drop(scheduler_retirement);

        Self::clear_journal_until_converged(
            &queue,
            &journal,
            &journal_retirement_ids,
            &shutdown,
            max_commit_attempts,
        )
        .await?;
        queue.publish_thread_retirement(&cleanup_thread_ids).await;
        scheduler
            .publish_thread_retirement(&cleanup_thread_ids)
            .await;
        fence
            .expect("active retirement owns complete-family admission fence")
            .finish_deleted()
            .await;
        Ok(())
    }

    async fn mark_deleted_until_converged(
        transaction: &ThreadStateRetirementTransaction,
        deleted_thread_ids: &[String],
    ) -> Result<Vec<String>, String> {
        let retirement_id = transaction
            .journal_retirement_ids
            .first()
            .filter(|_| transaction.journal_retirement_ids.len() == 1)
            .ok_or_else(|| {
                "active thread deletion must own exactly one retirement journal entry".to_string()
            })?;
        Self::mark_journal_deleted_until_converged(
            &transaction.queue,
            &transaction.journal,
            retirement_id,
            deleted_thread_ids,
            &transaction.shutdown,
            transaction.max_commit_attempts,
        )
        .await
    }

    async fn mark_journal_deleted_until_converged(
        queue: &BridgeQueueService,
        journal: &crate::retirement_journal::ThreadRetirementJournal,
        retirement_id: &str,
        deleted_thread_ids: &[String],
        shutdown: &CancellationToken,
        max_attempts: Option<u32>,
    ) -> Result<Vec<String>, String> {
        let mut attempt = 0_u32;
        loop {
            attempt = attempt.saturating_add(1);
            match journal
                .mark_deleted(retirement_id, deleted_thread_ids)
                .await
            {
                Ok(thread_ids) => return Ok(thread_ids),
                Err(error) => {
                    if max_attempts.is_some_and(|limit| attempt >= limit) {
                        return Err(format!(
                            "thread retirement persistence did not converge after {attempt} attempts: {error}"
                        ));
                    }
                    eprintln!(
                        "failed to persist deleted thread retirement phase on attempt {attempt}: {error}; retrying"
                    );
                }
            }
            if !Self::wait_for_commit_retry(queue, attempt, shutdown).await {
                return Err("thread retirement interrupted by bridge shutdown".to_string());
            }
        }
    }

    async fn commit_queue_until_converged(
        queue: &BridgeQueueService,
        retirement: &crate::queue_service::QueueThreadRetirement,
        shutdown: &CancellationToken,
        max_attempts: Option<u32>,
    ) -> Result<(), String> {
        let mut attempt = 0_u32;
        loop {
            attempt = attempt.saturating_add(1);
            match queue.commit_thread_retirement(retirement).await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if max_attempts.is_some_and(|limit| attempt >= limit) {
                        return Err(format!(
                            "thread retirement persistence did not converge after {attempt} attempts: {error}"
                        ));
                    }
                    eprintln!(
                        "failed to persist queue thread retirement cleanup on attempt {attempt}: {error}; retrying"
                    );
                }
            }
            if !Self::wait_for_commit_retry(queue, attempt, shutdown).await {
                return Err("thread retirement interrupted by bridge shutdown".to_string());
            }
        }
    }

    async fn commit_scheduler_until_converged(
        queue: &BridgeQueueService,
        scheduler: &crate::scheduled_prompts::ScheduledPromptService,
        retirement: &crate::scheduled_prompts::ScheduledPromptRetirement,
        shutdown: &CancellationToken,
        max_attempts: Option<u32>,
    ) -> Result<(), String> {
        let mut attempt = 0_u32;
        loop {
            attempt = attempt.saturating_add(1);
            match scheduler.commit_thread_retirement(retirement).await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if max_attempts.is_some_and(|limit| attempt >= limit) {
                        return Err(format!(
                            "thread retirement persistence did not converge after {attempt} attempts: {error}"
                        ));
                    }
                    eprintln!(
                        "failed to persist scheduled prompt thread retirement cleanup on attempt {attempt}: {error}; retrying"
                    );
                }
            }
            if !Self::wait_for_commit_retry(queue, attempt, shutdown).await {
                return Err("thread retirement interrupted by bridge shutdown".to_string());
            }
        }
    }

    async fn clear_journal_until_converged(
        queue: &BridgeQueueService,
        journal: &crate::retirement_journal::ThreadRetirementJournal,
        retirement_ids: &[String],
        shutdown: &CancellationToken,
        max_attempts: Option<u32>,
    ) -> Result<(), String> {
        let mut attempt = 0_u32;
        loop {
            attempt = attempt.saturating_add(1);
            match journal.remove(retirement_ids).await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if max_attempts.is_some_and(|limit| attempt >= limit) {
                        return Err(format!(
                            "thread retirement persistence did not converge after {attempt} attempts: {error}"
                        ));
                    }
                    eprintln!(
                        "failed to clear thread retirement journal on attempt {attempt}: {error}; retrying"
                    );
                }
            }
            if !Self::wait_for_commit_retry(queue, attempt, shutdown).await {
                return Err("thread retirement interrupted by bridge shutdown".to_string());
            }
        }
    }

    async fn wait_for_commit_retry(
        _queue: &BridgeQueueService,
        _attempt: u32,
        shutdown: &CancellationToken,
    ) -> bool {
        #[cfg(test)]
        {
            tokio::select! {
                _ = shutdown.cancelled() => return false,
                () = async {
                    _queue.wait_for_retirement_retry_barrier().await;
                    tokio::task::yield_now().await;
                } => {}
            }
        }
        #[cfg(not(test))]
        {
            let shift = _attempt.saturating_sub(1).min(16);
            let delay = THREAD_RETIREMENT_RETRY_MIN
                .saturating_mul(1_u32 << shift)
                .min(THREAD_RETIREMENT_RETRY_MAX);
            tokio::select! {
                _ = shutdown.cancelled() => return false,
                () = tokio::time::sleep(delay) => {}
            }
        }
        true
    }

    fn take_transaction(&mut self) -> ThreadStateRetirementTransaction {
        self.transaction
            .take()
            .expect("thread retirement transaction is active")
    }

    async fn release_transaction_preserving_journal(
        mut transaction: ThreadStateRetirementTransaction,
    ) {
        if let Some(queue_retirement) = transaction.queue_retirement.take() {
            transaction
                .queue
                .rollback_thread_retirement(queue_retirement)
                .await;
        }
        if let Some(scheduler_retirement) = transaction.scheduler_retirement.take() {
            transaction
                .scheduler
                .rollback_thread_retirement(scheduler_retirement)
                .await;
        }
        if let Some(fence) = transaction.fence.take() {
            fence.finish().await;
        }
    }
}

const MAX_TRACKED_CLIENT_REQUESTS: usize = 4096;
#[cfg(not(test))]
const OWNED_REQUEST_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const OWNED_REQUEST_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

fn parent_subagent_snapshot_envelope(parent: &ManagedSession) -> crate::agui::AgUiEventEnvelope {
    let run_id = parent
        .snapshot
        .active_run_id
        .clone()
        .unwrap_or_else(|| format!("{}::history", parent.thread_id));
    let source_turn_id = parent.snapshot.active_source_turn_id.clone();
    crate::agui::messages_snapshot_envelope(&parent.snapshot, run_id, source_turn_id)
}

/// The bridge thread id for a child ACP session spawned by `parent_thread_id`.
fn child_thread_id(parent_thread_id: &str, child_session_id: &str) -> Option<String> {
    crate::acp::identity::AgentSessionId::decode(parent_thread_id)
        .ok()
        .and_then(|parent| {
            crate::acp::identity::AgentSessionId::new(parent.agent_id, child_session_id.to_string())
                .ok()
        })
        .map(|identity| identity.encode())
}

/// How long to keep looking for the child session a sub-agent tool just spawned.
const SUBAGENT_DISCOVERY_ATTEMPTS: usize = 120;
const SUBAGENT_DISCOVERY_INTERVAL: Duration = Duration::from_millis(500);

/// Bookkeeping shared by every sub-agent discovery in flight.
#[derive(Default)]
struct SubagentDiscoveryState {
    /// Tool calls already being polled, so repeated reports of a running task tool add nothing.
    polling: HashSet<String>,
    /// Child threads already attached, so concurrent sub-agents cannot claim each other's.
    claimed: HashSet<String>,
}

const MAX_CLAIMED_SUBAGENTS: usize = 512;

type SubagentDiscoveries = Arc<StdMutex<SubagentDiscoveryState>>;

/// Attaches to a sub-agent while it is still working.
///
/// A foreground task tool reports its child only once that child has finished, so waiting for the
/// tool leaves the sub-agent invisible for its whole run. The agent knows about the child as soon
/// as it is created, so poll for it and adopt it the moment it appears; adopting resumes the
/// child session, which is what starts its updates flowing.
async fn discover_subagent_session(
    manager: Arc<AgentManager>,
    hub: Arc<ClientHub>,
    parent_thread_id: String,
    tool_call_id: String,
    in_flight: SubagentDiscoveries,
) {
    let mut baseline: Option<HashSet<String>> = None;
    for attempt in 0..SUBAGENT_DISCOVERY_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(SUBAGENT_DISCOVERY_INTERVAL).await;
        }
        let Ok(parent) = manager.read_session(&parent_thread_id).await else {
            break;
        };
        let Some(tool) = parent.snapshot.tools.get(&tool_call_id) else {
            continue;
        };
        if matches!(
            tool.status,
            agent_client_protocol::schema::v1::ToolCallStatus::Completed
                | agent_client_protocol::schema::v1::ToolCallStatus::Failed
        ) {
            // The tool named its child on the way out; the header path owns it from here.
            break;
        }
        let mut candidates = Vec::new();
        for child in manager.harness_child_sessions(&parent_thread_id).await {
            let Some(thread_id) = child_thread_id(&parent_thread_id, &child.acp_session_id) else {
                continue;
            };
            // The bridge indexes a sub-agent's session for other reasons, so being known is not
            // evidence that anything is following it. Only an attachment claims a child.
            let claimed = in_flight
                .lock()
                .map(|state| state.claimed.contains(&thread_id))
                .unwrap_or(true)
                || manager.tracks_subagent_generation(&thread_id).await;
            if claimed {
                continue;
            }
            candidates.push((child, thread_id));
        }
        // With several sub-agents in flight the title is what tells them apart: an agent titles
        // the child after the task description it also puts on the tool call.
        let baseline = baseline.get_or_insert_with(|| {
            candidates
                .iter()
                .map(|(_, thread_id)| thread_id.clone())
                .collect()
        });
        let selected = select_spawned_child(&candidates, &tool.title, baseline);
        let Some((selected, child_thread)) = selected else {
            continue;
        };
        if let Ok(mut state) = in_flight.lock() {
            if state.claimed.len() >= MAX_CLAIMED_SUBAGENTS {
                state.claimed.clear();
            }
            state.claimed.insert(child_thread.clone());
        }
        adopt_subagent_session(
            &manager,
            &hub,
            AdoptedSubagent {
                parent_thread_id: &parent_thread_id,
                parent_run_id: parent.snapshot.active_run_id.as_deref(),
                parent_source_turn_id: parent.snapshot.active_source_turn_id.clone(),
                child_session_id: &selected.acp_session_id,
                child_title: selected.title.as_deref(),
                tool_call_id: &tool_call_id,
                link: true,
            },
        )
        .await;
        break;
    }
    if let Ok(mut state) = in_flight.lock() {
        state
            .polling
            .remove(&discovery_key(&parent_thread_id, &tool_call_id));
    }
}

/// A key that identifies one tool call, and cannot be forged by ids that contain the separator.
fn discovery_key(parent_thread_id: &str, tool_call_id: &str) -> String {
    format!(
        "{}\u{1}{parent_thread_id}\u{1}{tool_call_id}",
        parent_thread_id.len()
    )
}

/// Whether a child session's title names the same task as the tool call that spawned it.
fn child_matches_tool_title(child_title: Option<&str>, tool_title: &str) -> bool {
    let tool_title = tool_title.trim().to_ascii_lowercase();
    // Every task tool starts out called "task", which describes nothing and matches everything.
    if tool_title.is_empty() || tool_title == "task" {
        return false;
    }
    child_title
        .map(|title| title.trim().to_ascii_lowercase())
        .is_some_and(|title| title.starts_with(&tool_title))
}

/// Picks the child session a still-running task tool spawned.
///
/// The tool's title is the best evidence, but a task tool is called "task" until it finishes, so
/// usually there is none. `baseline` holds the children the parent already had when this tool call
/// started polling, which makes a child that appears afterwards the one it spawned. Without that,
/// a parent that already owned an unclaimed child could never resolve its sub-agent while it ran,
/// and the card stayed unopenable until the tool finished and named the child itself.
fn select_spawned_child<'a>(
    candidates: &'a [(HarnessChildSession, String)],
    tool_title: &str,
    baseline: &HashSet<String>,
) -> Option<&'a (HarnessChildSession, String)> {
    candidates
        .iter()
        .find(|(child, _)| child_matches_tool_title(child.title.as_deref(), tool_title))
        .or_else(|| {
            let mut appeared = candidates
                .iter()
                .filter(|(_, thread_id)| !baseline.contains(thread_id));
            let first = appeared.next()?;
            appeared.next().is_none().then_some(first)
        })
        .or_else(|| candidates.first().filter(|_| candidates.len() == 1))
}

struct AdoptedSubagent<'a> {
    parent_thread_id: &'a str,
    parent_run_id: Option<&'a str>,
    parent_source_turn_id: Option<String>,
    child_session_id: &'a str,
    child_title: Option<&'a str>,
    tool_call_id: &'a str,
    /// Whether the sub-agent is still working, and so worth tracking for progress.
    link: bool,
}

/// Indexes a sub-agent's session, resumes it, and tells clients it exists.
///
/// Resuming is what makes the sub-agent stream: an agent only forwards updates for sessions the
/// client has asked for, so until the bridge reads the child session its work is invisible.
async fn adopt_subagent_session(
    manager: &Arc<AgentManager>,
    hub: &Arc<ClientHub>,
    subagent: AdoptedSubagent<'_>,
) -> Option<String> {
    let thread_id = match manager
        .adopt_related_session(
            subagent.parent_thread_id,
            subagent.child_session_id,
            subagent.child_title,
        )
        .await
    {
        Ok(thread_id) => thread_id,
        Err(error) => {
            eprintln!("failed to adopt ACP subagent session: {error}");
            return None;
        }
    };
    if subagent.link {
        manager
            .note_subagent_link(subagent.parent_thread_id, &thread_id, subagent.tool_call_id)
            .await;
        if let Some(parent_run_id) = subagent.parent_run_id {
            hub.link_subagent(
                subagent.parent_thread_id,
                parent_run_id,
                subagent.parent_source_turn_id,
                subagent.tool_call_id,
                &thread_id,
            )
            .await;
        }
    }
    if let Ok(session) = manager.read_session(&thread_id).await {
        hub.broadcast_ag_ui_envelope(crate::agui::messages_snapshot_envelope(
            &session.snapshot,
            format!("{thread_id}::history"),
            None,
        ))
        .await;
    }
    hub.broadcast_notification(
        "thread/subagent/adopted",
        json!({
            "threadId": thread_id,
            "parentThreadId": subagent.parent_thread_id,
        }),
    )
    .await;
    Some(thread_id)
}

async fn process_event_side_effects(
    manager: &Arc<AgentManager>,
    hub: &Arc<ClientHub>,
    subagent_discoveries: &SubagentDiscoveries,
    event: &crate::acp::events::CanonicalEvent,
) {
    if let crate::acp::events::CanonicalEvent::Tool {
        thread_id,
        tool_call_id,
        kind,
        status,
        title,
        ..
    } = event
    {
        let settled = matches!(
            status,
            agent_client_protocol::schema::v1::ToolCallStatus::Completed
                | agent_client_protocol::schema::v1::ToolCallStatus::Failed
        );
        if !settled
            && crate::acp::snapshot::is_subagent_task_tool(*kind, title)
            && manager.can_discover_subagents(thread_id)
        {
            let key = discovery_key(thread_id, tool_call_id);
            let started = subagent_discoveries
                .lock()
                .map(|mut state| state.polling.insert(key))
                .unwrap_or(false);
            if started {
                tokio::spawn(discover_subagent_session(
                    manager.clone(),
                    hub.clone(),
                    thread_id.clone(),
                    tool_call_id.clone(),
                    subagent_discoveries.clone(),
                ));
            }
        }
    }
    if let crate::acp::events::CanonicalEvent::RunStarted {
        thread_id,
        generation,
        ..
    } = event
    {
        manager.note_subagent_started(thread_id, *generation).await;
    }
    let related_terminal = match event {
        crate::acp::events::CanonicalEvent::RunFinished {
            thread_id,
            stop_reason: agent_client_protocol::schema::v1::StopReason::Cancelled,
            generation,
            ..
        } => Some((thread_id.as_str(), *generation, "cancelled")),
        crate::acp::events::CanonicalEvent::RunFinished {
            thread_id,
            generation,
            ..
        } => Some((thread_id.as_str(), *generation, "completed")),
        crate::acp::events::CanonicalEvent::RunFailed {
            thread_id,
            generation,
            ..
        } => Some((thread_id.as_str(), *generation, "failed")),
        _ => None,
    };
    if let Some((child_thread_id, generation, status)) = related_terminal {
        let accepted = manager
            .accepted_subagent_terminal(child_thread_id, generation)
            .await;
        let correlation_target = accepted.clone();
        let correction = if let Some(target) = accepted {
            manager
                .mark_parent_subagent_tool_terminal(
                    &target.parent_thread_id,
                    &target.tool_call_id,
                    status,
                )
                .await
        } else if !manager.tracks_subagent_generation(child_thread_id).await {
            manager
                .mark_parent_subagent_terminal(child_thread_id, status)
                .await
        } else {
            Ok(None)
        };
        match correction {
            Ok(Some(parent)) => {
                if let Some(target) = correlation_target {
                    manager
                        .retire_subagent_link(child_thread_id, &target.tool_call_id)
                        .await;
                }
                hub.broadcast_ag_ui_envelope(parent_subagent_snapshot_envelope(&parent))
                    .await;
            }
            Ok(None) => {
                if let Some(target) = correlation_target {
                    manager
                        .retire_subagent_link(child_thread_id, &target.tool_call_id)
                        .await;
                }
            }
            Err(error) => {
                eprintln!("failed to persist parent sub-agent status: {error}");
            }
        }
    }
    if let Some((parent_thread_id, child_session_id, child_title, tool_call_id, terminal)) =
        crate::agui::discovered_subagent_session(event)
    {
        let (parent_run_id, parent_source_turn_id) = match event {
            crate::acp::events::CanonicalEvent::Tool {
                run_id,
                source_turn_id,
                ..
            } => (run_id.as_deref(), source_turn_id.clone()),
            _ => (None, None),
        };
        if terminal {
            if let Some(thread_id) = child_thread_id(parent_thread_id, &child_session_id) {
                manager.retire_subagent_link(&thread_id, tool_call_id).await;
            }
        }
        adopt_subagent_session(
            manager,
            hub,
            AdoptedSubagent {
                parent_thread_id,
                parent_run_id,
                parent_source_turn_id,
                child_session_id: &child_session_id,
                child_title,
                tool_call_id,
                link: !terminal,
            },
        )
        .await;
    }
    let terminal = match event {
        crate::acp::events::CanonicalEvent::RunFinished {
            thread_id,
            run_id,
            source_turn_id,
            ..
        }
        | crate::acp::events::CanonicalEvent::RunFailed {
            thread_id,
            run_id,
            source_turn_id,
            ..
        } => Some((thread_id.clone(), run_id.clone(), source_turn_id.clone())),
        _ => None,
    };
    if let Some((thread_id, run_id, source_turn_id)) = terminal {
        if let Ok(session) = manager.read_session(&thread_id).await {
            hub.broadcast_ag_ui_envelope(crate::agui::messages_snapshot_envelope(
                &session.snapshot,
                run_id,
                Some(source_turn_id),
            ))
            .await;
        }
    }
}

#[cfg(test)]
pub(crate) async fn process_event_side_effects_for_test(
    manager: &Arc<AgentManager>,
    hub: &Arc<ClientHub>,
    events: &[crate::acp::events::CanonicalEvent],
) {
    let discoveries = Arc::new(StdMutex::new(SubagentDiscoveryState::default()));
    for event in events {
        process_event_side_effects(manager, hub, &discoveries, event).await;
    }
}

fn event_has_side_effects(event: &crate::acp::events::CanonicalEvent) -> bool {
    matches!(
        event,
        crate::acp::events::CanonicalEvent::Tool { .. }
            | crate::acp::events::CanonicalEvent::RunStarted { .. }
            | crate::acp::events::CanonicalEvent::RunFinished { .. }
            | crate::acp::events::CanonicalEvent::RunFailed { .. }
    )
}

async fn pump_canonical_events(
    mut events: crate::acp::events::CanonicalEventReceiver,
    event_hub: Arc<ClientHub>,
    side_effects_tx: tokio::sync::mpsc::UnboundedSender<crate::acp::events::CanonicalEvent>,
) {
    while let Some(event) = events.recv().await {
        event_hub.broadcast_canonical_event(&event).await;
        if event_has_side_effects(&event) && side_effects_tx.send(event).is_err() {
            break;
        }
    }
}

struct ClientRequestOwner {
    client_id: u64,
    cancellation: RequestCancellation,
}

#[derive(Default)]
struct ClientRequestRegistry {
    requests: HashMap<u64, ClientRequestOwner>,
    active_clients: HashSet<u64>,
}

struct ClientRequestGuard {
    request_id: u64,
    requests: Arc<StdMutex<ClientRequestRegistry>>,
}

struct OwnedClientRequestGuard {
    active: Arc<AtomicUsize>,
}

#[derive(Default)]
struct OwnedClientRequestRegistry {
    shutting_down: bool,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
struct ClientRequestTracker {
    registry: Arc<StdMutex<ClientRequestRegistry>>,
    next_request_id: AtomicU64,
    active_owned_requests: Arc<AtomicUsize>,
    owned_requests: Arc<StdMutex<OwnedClientRequestRegistry>>,
}

impl Drop for ClientRequestGuard {
    fn drop(&mut self) {
        self.requests
            .lock()
            .expect("client request registry poisoned")
            .requests
            .remove(&self.request_id);
    }
}

impl Drop for OwnedClientRequestGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

impl ClientRequestTracker {
    fn active_request_count(&self) -> usize {
        self.registry
            .lock()
            .expect("client request registry poisoned")
            .requests
            .len()
            .saturating_add(self.active_owned_requests.load(Ordering::Acquire))
    }

    fn register_client(&self, client_id: u64) {
        self.registry
            .lock()
            .expect("client request registry poisoned")
            .active_clients
            .insert(client_id);
    }

    fn cancel_client(&self, client_id: u64) {
        let cancelled = {
            let mut registry = self
                .registry
                .lock()
                .expect("client request registry poisoned");
            registry.active_clients.remove(&client_id);
            let request_ids = registry
                .requests
                .iter()
                .filter_map(|(request_id, owner)| {
                    (owner.client_id == client_id).then_some(*request_id)
                })
                .collect::<Vec<_>>();
            request_ids
                .into_iter()
                .filter_map(|request_id| registry.requests.remove(&request_id))
                .collect::<Vec<_>>()
        };
        for owner in cancelled {
            owner.cancellation.cancel();
        }
    }

    #[cfg(test)]
    async fn run<T>(
        &self,
        client_id: u64,
        future: impl Future<Output = T>,
    ) -> Result<T, &'static str> {
        self.run_with(client_id, |_| future).await
    }

    async fn run_with<T, F, Fut>(&self, client_id: u64, make: F) -> Result<T, &'static str>
    where
        F: FnOnce(RequestCancellation) -> Fut,
        Fut: Future<Output = T>,
    {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let cancellation = RequestCancellation::default();
        {
            let mut registry = self
                .registry
                .lock()
                .expect("client request registry poisoned");
            if !registry.active_clients.contains(&client_id) {
                return Err("client disconnected");
            }
            if registry.requests.len() >= MAX_TRACKED_CLIENT_REQUESTS {
                return Err("client request tracking capacity reached");
            }
            registry.requests.insert(
                request_id,
                ClientRequestOwner {
                    client_id,
                    cancellation: cancellation.clone(),
                },
            );
        }
        let request_guard = ClientRequestGuard {
            request_id,
            requests: self.registry.clone(),
        };
        let future = make(cancellation.clone());
        if cancellation.is_cancelled() {
            drop(request_guard);
            return Err("client disconnected");
        }
        tokio::pin!(future);
        let started = Arc::new(AtomicBool::new(false));
        let observed_started = Arc::clone(&started);
        let result = {
            let tracked_future = std::future::poll_fn(move |context| {
                observed_started.store(true, Ordering::Release);
                future.as_mut().poll(context)
            });
            tokio::pin!(tracked_future);
            tokio::select! {
                result = &mut tracked_future => Some(result),
                _ = cancellation.cancelled() => None,
            }
        };
        drop(request_guard);
        if cancellation.is_cancelled() || result.is_none() {
            return Err(if started.load(Ordering::Acquire) {
                "client request cancelled"
            } else {
                "client disconnected"
            });
        }
        Ok(result.expect("completed client request result"))
    }

    async fn run_owned_with<T, F, Fut>(
        &self,
        client_id: u64,
        make: F,
    ) -> Result<Result<T, String>, &'static str>
    where
        T: Send + 'static,
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = T> + Send + 'static,
    {
        let active = self.active_owned_requests.clone();
        let owned_requests = self.owned_requests.clone();
        self.run_with(client_id, |_| async move {
            let result_rx = {
                let mut owned = owned_requests
                    .lock()
                    .expect("owned client request registry poisoned");
                if owned.shutting_down {
                    return Err("runtime is shutting down".to_string());
                }
                owned.tasks.retain(|task| !task.is_finished());
                active.fetch_add(1, Ordering::AcqRel);
                let (result_tx, result_rx) = tokio::sync::oneshot::channel();
                let task = tokio::spawn(async move {
                    let _activity = OwnedClientRequestGuard { active };
                    let _ = result_tx.send(make().await);
                });
                owned.tasks.push(task);
                result_rx
            };
            result_rx
                .await
                .map_err(|_| "owned client request task failed".to_string())
        })
        .await
    }

    async fn shutdown_owned_requests(&self) {
        let tasks = {
            let mut owned = self
                .owned_requests
                .lock()
                .expect("owned client request registry poisoned");
            owned.shutting_down = true;
            std::mem::take(&mut owned.tasks)
        };
        let deadline = tokio::time::Instant::now() + OWNED_REQUEST_SHUTDOWN_TIMEOUT;
        let mut tasks = tasks.into_iter();
        while let Some(mut task) = tasks.next() {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, &mut task).await {
                Ok(Ok(())) => continue,
                Ok(Err(error)) => {
                    eprintln!("owned client request task failed during shutdown: {error}");
                    continue;
                }
                Err(_) => {
                    let mut pending = vec![task];
                    pending.extend(tasks);
                    eprintln!(
                        "owned client requests did not settle within {:?}; aborting them",
                        OWNED_REQUEST_SHUTDOWN_TIMEOUT
                    );
                    for task in &pending {
                        task.abort();
                    }
                    for task in pending {
                        if let Err(error) = task.await {
                            if !error.is_cancelled() {
                                eprintln!(
                                    "owned client request task failed while aborting: {error}"
                                );
                            }
                        }
                    }
                    return;
                }
            }
        }
    }

    #[cfg(test)]
    fn request_count(&self) -> usize {
        self.registry
            .lock()
            .expect("client request registry poisoned")
            .requests
            .len()
    }
}

#[derive(Debug, Clone)]
pub(super) struct QueueRuntimeSnapshot {
    pub(super) session: crate::acp::snapshot::SessionSnapshot,
    pub(super) pending_approval_ids: HashSet<String>,
    pub(super) pending_user_input_ids: HashSet<String>,
}

pub(super) trait QueueRuntimeDispatcher: Send + Sync {
    fn read_snapshot<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxFuture<'a, Result<QueueRuntimeSnapshot, String>>;
    fn supports_steer(&self, thread_id: &str) -> Result<bool, String>;
    fn supports_live_agent_message(&self, _thread_id: &str) -> Result<bool, String> {
        Ok(false)
    }
    fn prepare_steer<'a>(&'a self, thread_id: &'a str) -> BoxFuture<'a, Result<u64, String>>;
    fn current_steer_epoch<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> BoxFuture<'a, Result<u64, String>> {
        Box::pin(async { Err("live agent messaging is unsupported".to_string()) })
    }
    fn verify_steer_epoch<'a>(
        &'a self,
        thread_id: &'a str,
        epoch: u64,
    ) -> BoxFuture<'a, Result<bool, String>>;
    fn steer<'a>(
        &'a self,
        thread_id: &'a str,
        expected_run_id: String,
        expected_source_turn_id: String,
        prompt_generation: u64,
        interaction_epoch: u64,
        prompt: Vec<ContentBlock>,
    ) -> BoxFuture<'a, Result<(), String>>;
    #[allow(clippy::too_many_arguments)]
    fn deliver_live_agent_message<'a>(
        &'a self,
        _thread_id: &'a str,
        _expected_run_id: String,
        _expected_source_turn_id: String,
        _prompt_generation: u64,
        _interaction_epoch: u64,
        _prompt: Vec<ContentBlock>,
    ) -> BoxFuture<'a, Result<crate::acp::harness::HarnessAgentMessageOutcome, String>> {
        Box::pin(async { Err("live agent messaging is unsupported".to_string()) })
    }
    fn turn_start<'a>(
        &'a self,
        thread_id: &'a str,
        turn_start: &'a Value,
        source_turn_id: &'a str,
    ) -> BoxFuture<'a, Result<String, String>>;
    fn reconcile_turn_start<'a>(
        &'a self,
        thread_id: &'a str,
        source_turn_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            let snapshot = self.read_snapshot(thread_id).await?.session;
            let message_id = format!("{thread_id}::user::{source_turn_id}");
            Ok(
                (snapshot.active_source_turn_id.as_deref() == Some(source_turn_id)
                    || snapshot
                        .messages
                        .iter()
                        .any(|message| message.id == message_id))
                .then(|| source_turn_id.to_string()),
            )
        })
    }
    fn record_agent_messages<'a>(
        &'a self,
        _messages: Vec<(String, crate::agent_messaging::AgentMessageOrigin)>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn publish_agent_message<'a>(&'a self, _message_id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
    fn remove_agent_message<'a>(
        &'a self,
        _message_id: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn update_agent_message_disposition<'a>(
        &'a self,
        _message_id: &'a str,
        _disposition: crate::agent_messaging::AgentMessageDisposition,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

impl RuntimeBackend {
    #[cfg(test)]
    pub(crate) async fn from_manager_for_test(
        manager: Arc<AgentManager>,
        hub: Arc<ClientHub>,
        retirement_journal: Arc<crate::retirement_journal::ThreadRetirementJournal>,
    ) -> Arc<Self> {
        let events = manager
            .take_events()
            .await
            .expect("test manager canonical event receiver is available");
        let event_hub = hub.clone();
        let subagent_discoveries: SubagentDiscoveries =
            Arc::new(StdMutex::new(SubagentDiscoveryState::default()));
        let (side_effects_tx, mut side_effects_rx) =
            tokio::sync::mpsc::unbounded_channel::<crate::acp::events::CanonicalEvent>();
        let side_effects_manager = manager.clone();
        let side_effects_hub = hub.clone();
        let side_effects_discoveries = subagent_discoveries.clone();
        let event_side_effects = tokio::spawn(async move {
            while let Some(event) = side_effects_rx.recv().await {
                process_event_side_effects(
                    &side_effects_manager,
                    &side_effects_hub,
                    &side_effects_discoveries,
                    &event,
                )
                .await;
            }
        });
        let event_pump = tokio::spawn(pump_canonical_events(events, event_hub, side_effects_tx));
        Arc::new(Self {
            manager,
            hub,
            event_pump: Mutex::new(Some(event_pump)),
            event_side_effects: Mutex::new(Some(event_side_effects)),
            agent_messaging: Mutex::new(None),
            thread_lifecycle: Mutex::new(None),
            retirement_journal,
            retirement_shutdown: CancellationToken::new(),
            client_requests: ClientRequestTracker::default(),
        })
    }

    pub(super) async fn start(
        config: &Arc<BridgeConfig>,
        hub: Arc<ClientHub>,
        _metrics: Arc<OperationalMetrics>,
    ) -> Result<Arc<Self>, String> {
        let retirement_journal = Arc::new(
            crate::retirement_journal::ThreadRetirementJournal::load(
                config.state_dir.join("thread-retirements.json"),
            )
            .await?,
        );
        let manifests = LocalAgentManifestSet::load(
            &config.acp_manifest_path,
            &config.acp_approved_executable_roots,
        )
        .map_err(|error| error.to_string())?;
        let host_environment = [
            "CODEX_PATH",
            "HOME",
            "PATH",
            "TMPDIR",
            "LANG",
            "XDG_CONFIG_HOME",
        ]
        .into_iter()
        .filter_map(|name| env::var(name).ok().map(|value| (name.to_string(), value)))
        .collect::<BTreeMap<_, _>>();
        let manager = Arc::new(
            AgentManager::start(
                manifests,
                &config.acp_approved_executable_roots,
                &host_environment,
                config.acp_initialize_timeout,
                &config.workdir,
                &config.state_dir,
                config.allow_outside_root_cwd,
            )
            .await
            .map_err(|error| error.to_string())?,
        );
        let events = manager
            .take_events()
            .await
            .ok_or_else(|| "ACP canonical event receiver already taken".to_string())?;
        let event_hub = hub.clone();
        let subagent_discoveries: SubagentDiscoveries =
            Arc::new(StdMutex::new(SubagentDiscoveryState::default()));
        let (side_effects_tx, mut side_effects_rx) =
            tokio::sync::mpsc::unbounded_channel::<crate::acp::events::CanonicalEvent>();
        let side_effects_manager = manager.clone();
        let side_effects_hub = hub.clone();
        let side_effects_discoveries = subagent_discoveries.clone();
        let event_side_effects = tokio::spawn(async move {
            while let Some(event) = side_effects_rx.recv().await {
                process_event_side_effects(
                    &side_effects_manager,
                    &side_effects_hub,
                    &side_effects_discoveries,
                    &event,
                )
                .await;
            }
        });
        let event_pump = tokio::spawn(pump_canonical_events(events, event_hub, side_effects_tx));
        Ok(Arc::new(Self {
            manager,
            hub,
            event_pump: Mutex::new(Some(event_pump)),
            event_side_effects: Mutex::new(Some(event_side_effects)),
            agent_messaging: Mutex::new(None),
            thread_lifecycle: Mutex::new(None),
            retirement_journal,
            retirement_shutdown: CancellationToken::new(),
            client_requests: ClientRequestTracker::default(),
        }))
    }

    pub(crate) async fn attach_thread_lifecycle(
        &self,
        queue: std::sync::Weak<BridgeQueueService>,
        scheduler: std::sync::Weak<crate::scheduled_prompts::ScheduledPromptService>,
    ) -> Result<(), String> {
        let mut attached = self.thread_lifecycle.lock().await;
        if attached.is_some() {
            return Err("thread lifecycle services are already attached".to_string());
        }
        let recovery_queue = queue
            .upgrade()
            .ok_or_else(|| "thread queue service is shutting down".to_string())?;
        let recovery_scheduler = scheduler
            .upgrade()
            .ok_or_else(|| "scheduled prompt service is shutting down".to_string())?;
        ThreadStateRetirement::recover_pending(
            recovery_queue,
            recovery_scheduler,
            self.retirement_journal.clone(),
            self.manager.as_ref(),
            self.retirement_shutdown.clone(),
        )
        .await
        .map_err(|error| format!("failed to recover thread retirement journal: {error}"))?;
        *attached = Some(ThreadLifecycleServices { queue, scheduler });
        Ok(())
    }

    async fn thread_lifecycle_services(
        &self,
    ) -> Result<
        (
            Arc<BridgeQueueService>,
            Arc<crate::scheduled_prompts::ScheduledPromptService>,
        ),
        String,
    > {
        let attached = self.thread_lifecycle.lock().await;
        let services = attached
            .as_ref()
            .ok_or_else(|| "thread lifecycle services are unavailable".to_string())?;
        let scheduler = services
            .scheduler
            .upgrade()
            .ok_or_else(|| "scheduled prompt service is shutting down".to_string())?;
        let queue = services
            .queue
            .upgrade()
            .ok_or_else(|| "thread queue service is shutting down".to_string())?;
        drop(attached);
        Ok((queue, scheduler))
    }

    pub(crate) async fn attach_agent_messaging(
        &self,
        service: crate::agent_messaging::AgentMessagingService,
    ) -> Result<(), String> {
        let mut attached = self.agent_messaging.lock().await;
        if attached.is_some() {
            return Err("shared agent messaging MCP service is already attached".to_string());
        }
        self.manager
            .attach_agent_messaging(service.config())
            .map_err(|error| error.to_string())?;
        *attached = Some(service);
        Ok(())
    }

    pub(crate) async fn agent_relations(
        &self,
        caller_thread_id: &str,
    ) -> Result<crate::agent_messaging::AgentRelations, crate::agent_messaging::AgentRelationError>
    {
        self.manager.agent_relations(caller_thread_id).await
    }

    pub(crate) async fn direct_agent_relation_sessions(
        &self,
        caller_thread_id: &str,
        target_thread_id: &str,
    ) -> Result<
        (
            crate::agent_messaging::AgentRelationKind,
            crate::agent_messaging::AgentRelationSession,
            crate::agent_messaging::AgentRelationSession,
        ),
        crate::agent_messaging::AgentRelationError,
    > {
        self.manager
            .direct_agent_relation_sessions(caller_thread_id, target_thread_id)
            .await
    }

    pub(crate) async fn record_agent_messages(
        &self,
        messages: Vec<(String, crate::agent_messaging::AgentMessageOrigin)>,
    ) -> Result<(), String> {
        self.manager
            .record_agent_messages(messages)
            .await
            .map_err(|error| error.to_string())
    }

    pub(crate) async fn publish_agent_message(&self, message_id: &str) {
        self.manager.publish_agent_message(message_id).await;
    }

    pub(crate) async fn remove_agent_message(&self, message_id: &str) -> Result<(), String> {
        self.manager
            .remove_agent_message(message_id)
            .await
            .map_err(|error| error.to_string())
    }

    pub(crate) async fn update_agent_message_disposition(
        &self,
        message_id: &str,
        disposition: crate::agent_messaging::AgentMessageDisposition,
    ) -> Result<(), String> {
        self.manager
            .update_agent_message_disposition(message_id, disposition)
            .await
            .map_err(|error| error.to_string())
    }

    pub(super) async fn shutdown(&self) {
        self.retirement_shutdown.cancel();
        self.client_requests.shutdown_owned_requests().await;
        let agent_messaging = self.agent_messaging.lock().await.take();
        if let Some(service) = agent_messaging {
            service.shutdown().await;
        }
        self.manager.shutdown().await;
        self.manager.flush_events().await;
        if let Some(pump) = self.event_pump.lock().await.take() {
            pump.abort();
            let _ = pump.await;
        }
        if let Some(mut side_effects) = self.event_side_effects.lock().await.take() {
            if tokio::time::timeout(std::time::Duration::from_secs(5), &mut side_effects)
                .await
                .is_err()
            {
                side_effects.abort();
                let _ = side_effects.await;
            }
        }
    }

    pub(super) async fn runtime_activity(&self) -> (usize, usize, usize, usize) {
        let mut active_runs = 0;
        let mut other_live_work = self.client_requests.active_request_count();
        for thread_id in self.manager.loaded_session_ids().await {
            let Ok(session) = self.manager.read_session(&thread_id).await else {
                other_live_work += 1;
                continue;
            };
            if session.snapshot.active_run_id.is_some() {
                active_runs += 1;
            }
            if !session.snapshot.active_tool_ids.is_empty() {
                other_live_work += 1;
            }
        }
        (
            active_runs,
            self.manager.pending_permissions().await.len(),
            self.manager.pending_elicitations().await.len(),
            other_live_work,
        )
    }

    pub(super) fn register_client(&self, client_id: u64) {
        self.client_requests.register_client(client_id);
    }

    pub(super) async fn cancel_client_requests(&self, client_id: u64) {
        self.client_requests.cancel_client(client_id);
    }

    pub(super) async fn session_snapshot(
        &self,
        thread_id: &str,
    ) -> Result<crate::acp::snapshot::SessionSnapshot, String> {
        self.manager
            .read_session(thread_id)
            .await
            .map(|session| session.snapshot)
            .map_err(|error| error.to_string())
    }

    pub(super) async fn prepare_steer(&self, thread_id: &str) -> Result<u64, String> {
        self.manager
            .prepare_steer(thread_id)
            .await
            .map_err(|error| error.to_string())
    }

    pub(super) async fn current_steer_epoch(&self, thread_id: &str) -> Result<u64, String> {
        self.manager
            .current_steer_epoch(thread_id)
            .await
            .map_err(|error| error.to_string())
    }

    pub(super) async fn verify_steer_epoch(
        &self,
        thread_id: &str,
        epoch: u64,
    ) -> Result<bool, String> {
        self.manager
            .verify_steer_epoch(thread_id, epoch)
            .await
            .map_err(|error| error.to_string())
    }

    pub(super) fn supports_steer(&self, thread_id: &str) -> Result<bool, String> {
        self.manager
            .supports_steer(thread_id)
            .map_err(|error| error.to_string())
    }

    pub(super) fn supports_live_agent_message(&self, thread_id: &str) -> Result<bool, String> {
        self.manager
            .supports_live_agent_message(thread_id)
            .map_err(|error| error.to_string())
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn deliver_live_agent_message(
        &self,
        thread_id: &str,
        expected_run_id: String,
        expected_source_turn_id: String,
        prompt_generation: u64,
        interaction_epoch: u64,
        prompt: Vec<ContentBlock>,
    ) -> Result<crate::acp::harness::HarnessAgentMessageOutcome, String> {
        self.manager
            .deliver_live_agent_message(
                thread_id,
                expected_run_id,
                expected_source_turn_id,
                prompt_generation,
                interaction_epoch,
                prompt,
            )
            .await
            .map_err(classified_operation_error)
    }

    pub(super) async fn steer(
        &self,
        thread_id: &str,
        expected_run_id: String,
        expected_source_turn_id: String,
        prompt_generation: u64,
        interaction_epoch: u64,
        prompt: Vec<ContentBlock>,
    ) -> Result<(), String> {
        self.manager
            .steer(
                thread_id,
                expected_run_id,
                expected_source_turn_id,
                prompt_generation,
                interaction_epoch,
                prompt,
            )
            .await
            .map_err(|error| error.to_string())
    }

    pub(super) fn capabilities(&self, stream_id: &str) -> BridgeCapabilities {
        let agents = self.manager.list_agents();
        let preferred_agent_id = self.manager.preferred_agent_id().to_string();
        let active_agent_id = agents
            .iter()
            .find(|agent| {
                agent.agent_id == preferred_agent_id && agent.lifecycle == AgentLifecycle::Ready
            })
            .or_else(|| {
                agents
                    .iter()
                    .find(|agent| agent.lifecycle == AgentLifecycle::Ready)
            })
            .map(|agent| agent.agent_id.clone());
        let supports_by_agent = agents
            .iter()
            .map(|agent| {
                (
                    agent.agent_id.clone(),
                    BridgeCapabilitySupport::from_agent(agent),
                )
            })
            .collect::<HashMap<_, _>>();
        let supports = active_agent_id
            .as_ref()
            .and_then(|id| supports_by_agent.get(id).copied())
            .unwrap_or_default();
        BridgeCapabilities {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            stream_id: stream_id.to_string(),
            preferred_agent_id,
            active_agent_id,
            agents,
            ag_ui_events: true,
            supports,
            supports_by_agent,
        }
    }

    pub(super) async fn request_internal(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, String> {
        let params = params.unwrap_or_else(|| json!({}));
        match method {
            "thread/start" => {
                self.start_thread(params, RequestCancellation::default())
                    .await
            }
            "thread/list" => {
                let cursor = read_string(params.get("cursor"));
                let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
                let agent_id = read_string(params.get("agentId"));
                let page = self
                    .manager
                    .list_sessions_for(cursor.as_deref(), limit, agent_id.as_deref())
                    .await
                    .map_err(|error| error.to_string())?;
                let data = page
                    .sessions
                    .into_iter()
                    .map(session_to_thread_value)
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(json!({
                    "data": data,
                    "nextCursor": page.next_cursor,
                    "partial": page.partial,
                    "diagnostics": page.diagnostics,
                }))
            }
            "thread/loaded/list" => Ok(json!({
                "data": self.manager.loaded_session_ids().await
            })),
            "thread/read" => {
                let thread_id = required_string(&params, "threadId")?;
                let session = self
                    .manager
                    .read_session(&thread_id)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(json!({ "thread": session_to_thread_value(session)? }))
            }
            "thread/name/update" => {
                let thread_id = required_string(&params, "threadId")?;
                let title = required_string(&params, "title")?;
                let session = self
                    .manager
                    .rename_session(&thread_id, &title)
                    .await
                    .map_err(|error| error.to_string())?;
                self.hub
                    .broadcast_notification(
                        "thread/name/updated",
                        json!({ "threadId": thread_id, "threadName": title.trim() }),
                    )
                    .await;
                Ok(json!({ "thread": session_to_thread_value(session)? }))
            }
            "thread/fork" => {
                let thread_id = required_string(&params, "threadId")?;
                let message_id = required_string(&params, "messageId")?;
                let session = self
                    .manager
                    .fork_session_with_outcome(&thread_id, &message_id)
                    .await
                    .map_err(classified_operation_error)?;
                Ok(json!({
                    "thread": session_to_thread_value(session)
                        .map_err(indeterminate_operation_error)?
                }))
            }
            "thread/delete" => {
                let thread_id = required_string(&params, "threadId")?;
                let (queue, scheduler) = self.thread_lifecycle_services().await?;
                let admission_barrier = queue.block_retirement_admissions().await;
                let deletion_plan = match self.manager.prepare_session_deletion(&thread_id).await {
                    Ok(deletion_plan) => deletion_plan,
                    Err(error) => return Err(error.to_string()),
                };
                let authoritative_thread_ids = deletion_plan.affected_thread_ids();
                let retirement = match ThreadStateRetirement::begin_authoritative_with_journal(
                    queue,
                    scheduler,
                    self.retirement_journal.clone(),
                    self.retirement_shutdown.clone(),
                    &authoritative_thread_ids,
                    &admission_barrier,
                )
                .await
                {
                    Ok(retirement) => retirement,
                    Err(error) => {
                        deletion_plan.abort().await;
                        return Err(error);
                    }
                };
                drop(admission_barrier);
                let deletion = deletion_plan
                    .execute()
                    .await
                    .map_err(|error| error.to_string());
                let deleted_thread_ids = retirement.finish_delete(deletion).await?;
                for deleted_thread_id in deleted_thread_ids {
                    self.hub
                        .broadcast_notification(
                            "thread/deleted",
                            json!({ "threadId": deleted_thread_id }),
                        )
                        .await;
                }
                Ok(json!({ "ok": true, "threadId": thread_id }))
            }
            "thread/snapshot/page" => {
                let thread_id = required_string(&params, "threadId")?;
                let before = read_string(params.get("beforeCursor"));
                let after = read_string(params.get("afterCursor"));
                let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
                let page = self
                    .manager
                    .snapshot_page(&thread_id, before.as_deref(), after.as_deref(), limit)
                    .await
                    .map_err(|error| error.to_string())?;
                serde_json::to_value(page).map_err(|error| error.to_string())
            }
            "thread/approvalPolicy/set" => {
                let approval_policy = approval_policy(&params);
                self.manager
                    .set_all_session_approval_policies(approval_policy)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(json!({ "ok": true }))
            }
            "thread/resume" => {
                let thread_id = required_string(&params, "threadId")?;
                let cwd = required_string(&params, "cwd")?;
                let approval_policy = approval_policy(&params);
                let session = self
                    .manager
                    .resume_session_with_policy(&thread_id, cwd, approval_policy)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(json!({ "thread": session_to_thread_value(session)? }))
            }
            "thread/config/set" => {
                let thread_id = required_string(&params, "threadId")?;
                let config_id = required_string(&params, "configId")?;
                let value = match params.get("value") {
                    Some(Value::Bool(value)) => SessionConfigOptionValue::boolean(*value),
                    Some(Value::String(value)) if !value.trim().is_empty() => {
                        SessionConfigOptionValue::value_id(value.trim().to_string())
                    }
                    _ => {
                        return Err("config value must be a non-empty string or boolean".to_string())
                    }
                };
                let session = self
                    .manager
                    .set_session_config_option(&thread_id, &config_id, value)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(json!({ "thread": session_to_thread_value(session)? }))
            }
            "turn/start" => {
                let thread_id = required_string(&params, "threadId")?;
                let prompt = bridge_prompt(&params)?;
                let approval_policy = approval_policy(&params);
                let source_turn_id = Uuid::new_v4().to_string();
                let run_id = format!("{thread_id}::turn::{source_turn_id}");
                let admission = self
                    .manager
                    .prompt_with_policy_outcome(
                        &thread_id,
                        prompt,
                        run_id,
                        source_turn_id,
                        approval_policy,
                    )
                    .await
                    .map_err(classified_operation_error)?;
                Ok(json!({
                    "turn": { "id": admission.source_turn_id, "status": "inProgress" }
                }))
            }
            "turn/interrupt" => {
                let thread_id = required_string(&params, "threadId")?;
                let turn_id = required_string(&params, "turnId")?;
                self.manager
                    .cancel_turn(&thread_id, &turn_id)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(json!({ "ok": true }))
            }
            "model/list" => Ok(json!({
                "data": self.manager.harness_model_catalog(read_string(params.get("agentId")).as_deref()).await,
                "source": "harnessCatalog",
            })),
            _ => Err(format!("method not supported by ACP runtime: {method}")),
        }
    }

    async fn start_thread(
        &self,
        params: Value,
        cancellation: RequestCancellation,
    ) -> Result<Value, String> {
        let agent_id = read_string(params.get("agentId"))
            .unwrap_or_else(|| self.manager.preferred_agent_id().to_string());
        let cwd = read_string(params.get("cwd")).unwrap_or_else(|| ".".to_string());
        let model = read_string(params.get("model"));
        let effort = read_string(params.get("effort"));
        let approval_policy = approval_policy(&params);
        let mode = read_string(params.get("mode")).map(|value| {
            if value == "default" {
                "build".to_string()
            } else {
                value
            }
        });
        let mut session = self
            .manager
            .new_session_with_policy_outcome(
                &agent_id,
                NewSessionRequest::new(cwd),
                approval_policy,
                cancellation,
            )
            .await
            .map_err(classified_operation_error)?;
        for (category, value) in [("model", model), ("thought_level", effort), ("mode", mode)] {
            let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
                continue;
            };
            let Some(option) = session
                .snapshot
                .config
                .iter()
                .find(|option| option.category.as_deref() == Some(category))
            else {
                continue;
            };
            if !option.options.is_empty()
                && !option.options.iter().any(|choice| choice.value == value)
            {
                return Err(format!(
                    "{INDETERMINATE_OPERATION_PREFIX}{category} option is not advertised by this ACP agent"
                ));
            }
            session = self
                .manager
                .set_session_config_option(
                    &session.thread_id,
                    &option.id,
                    SessionConfigOptionValue::value_id(value),
                )
                .await
                .map_err(indeterminate_operation_error)?;
        }
        Ok(json!({
            "thread": session_to_thread_value(session).map_err(indeterminate_operation_error)?
        }))
    }

    pub(super) async fn request_for_client(
        self: &Arc<Self>,
        client_id: u64,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, String> {
        if method == "thread/delete" {
            let backend = Arc::clone(self);
            let method = method.to_string();
            return self
                .client_requests
                .run_owned_with(client_id, move || async move {
                    reject_client_agent_message_envelope(&method, params.as_ref())?;
                    backend.request_internal(&method, params).await
                })
                .await
                .map_err(str::to_string)??;
        }
        self.client_requests
            .run_with(client_id, |cancellation| async move {
                if method == "thread/start" {
                    return self
                        .start_thread(params.unwrap_or_else(|| json!({})), cancellation)
                        .await;
                }
                reject_client_agent_message_envelope(method, params.as_ref())?;
                self.request_internal(method, params).await
            })
            .await
            .map_err(str::to_string)?
    }

    pub(super) async fn forward_request(
        self: &Arc<Self>,
        client_id: u64,
        client_request_id: Value,
        method: &str,
        params: Option<Value>,
        permits: Option<InFlightRequestPermits>,
    ) -> Result<(), String> {
        let result = self.request_for_client(client_id, method, params).await;
        drop(permits);
        if result.as_ref().map_err(String::as_str) == Err("client request cancelled")
            || result.as_ref().map_err(String::as_str) == Err("client disconnected")
        {
            return Ok(());
        }
        let payload = match result {
            Ok(result) => json!({ "id": client_request_id, "result": result }),
            Err(message) => json!({
                "id": client_request_id,
                "error": { "code": -32601, "message": message }
            }),
        };
        self.hub.send_json(client_id, payload).await;
        Ok(())
    }

    pub(super) async fn list_pending_approvals(&self) -> Vec<PendingApproval> {
        self.manager
            .pending_permissions()
            .await
            .into_iter()
            .map(PendingApproval::from)
            .collect()
    }

    pub(super) async fn list_pending_user_inputs(&self) -> Vec<PendingUserInputRequest> {
        self.manager
            .pending_elicitations()
            .await
            .into_iter()
            .map(PendingUserInputRequest::from)
            .collect()
    }

    pub(super) async fn resolve_approval(
        &self,
        approval_id: &str,
        decision: &str,
    ) -> Result<Option<PendingApproval>, String> {
        let Some(pending) = self
            .manager
            .pending_permissions()
            .await
            .into_iter()
            .find(|entry| entry.request_id == approval_id)
        else {
            return Ok(None);
        };
        if decision == "cancel" {
            self.manager
                .cancel_permission_with_outcome(&pending.thread_id, approval_id)
                .await
                .map_err(classified_operation_error)?;
        } else {
            self.manager
                .resolve_permission_with_outcome(&pending.thread_id, approval_id, decision)
                .await
                .map_err(classified_operation_error)?;
        }
        Ok(Some(pending.into()))
    }

    pub(super) async fn resolve_user_input(
        &self,
        request_id: &str,
        answers: &HashMap<String, Value>,
        action: Option<&str>,
    ) -> Result<Option<PendingUserInputRequest>, String> {
        let Some(pending) = self
            .manager
            .pending_elicitations()
            .await
            .into_iter()
            .find(|entry| entry.request_id == request_id)
        else {
            return Ok(None);
        };
        let thread_id = pending.thread_id.as_str();
        match action.unwrap_or("submit") {
            "decline" => {
                self.manager
                    .decline_elicitation(thread_id, request_id)
                    .await
                    .map_err(|error| error.to_string())?;
                return Ok(Some(pending.into()));
            }
            "cancel" => {
                self.manager
                    .cancel_elicitation(thread_id, request_id)
                    .await
                    .map_err(|error| error.to_string())?;
                return Ok(Some(pending.into()));
            }
            "submit" => {}
            _ => return Err("invalid elicitation action".to_string()),
        }
        let mut values = BTreeMap::new();
        for field in &pending.fields {
            let Some(answer) = answers.get(&field.name) else {
                if field.required {
                    return Err(format!("missing required answer: {}", field.name));
                }
                continue;
            };
            values.insert(field.name.clone(), elicitation_value(field.kind, answer)?);
        }
        self.manager
            .accept_elicitation(thread_id, request_id, values)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Some(pending.into()))
    }
}

impl QueueRuntimeDispatcher for RuntimeBackend {
    fn read_snapshot<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxFuture<'a, Result<QueueRuntimeSnapshot, String>> {
        Box::pin(async move {
            let session = self.session_snapshot(thread_id).await?;
            let pending_approval_ids = self
                .list_pending_approvals()
                .await
                .into_iter()
                .filter(|entry| entry.thread_id == thread_id)
                .map(|entry| entry.request_id)
                .collect();
            let pending_user_input_ids = self
                .list_pending_user_inputs()
                .await
                .into_iter()
                .filter(|entry| entry.thread_id == thread_id)
                .map(|entry| entry.request_id)
                .collect();
            Ok(QueueRuntimeSnapshot {
                session,
                pending_approval_ids,
                pending_user_input_ids,
            })
        })
    }

    fn supports_steer(&self, thread_id: &str) -> Result<bool, String> {
        RuntimeBackend::supports_steer(self, thread_id)
    }

    fn supports_live_agent_message(&self, thread_id: &str) -> Result<bool, String> {
        RuntimeBackend::supports_live_agent_message(self, thread_id)
    }

    fn prepare_steer<'a>(&'a self, thread_id: &'a str) -> BoxFuture<'a, Result<u64, String>> {
        Box::pin(RuntimeBackend::prepare_steer(self, thread_id))
    }

    fn current_steer_epoch<'a>(&'a self, thread_id: &'a str) -> BoxFuture<'a, Result<u64, String>> {
        Box::pin(RuntimeBackend::current_steer_epoch(self, thread_id))
    }

    fn verify_steer_epoch<'a>(
        &'a self,
        thread_id: &'a str,
        epoch: u64,
    ) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(RuntimeBackend::verify_steer_epoch(self, thread_id, epoch))
    }

    fn steer<'a>(
        &'a self,
        thread_id: &'a str,
        expected_run_id: String,
        expected_source_turn_id: String,
        prompt_generation: u64,
        interaction_epoch: u64,
        prompt: Vec<ContentBlock>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(RuntimeBackend::steer(
            self,
            thread_id,
            expected_run_id,
            expected_source_turn_id,
            prompt_generation,
            interaction_epoch,
            prompt,
        ))
    }

    fn deliver_live_agent_message<'a>(
        &'a self,
        thread_id: &'a str,
        expected_run_id: String,
        expected_source_turn_id: String,
        prompt_generation: u64,
        interaction_epoch: u64,
        prompt: Vec<ContentBlock>,
    ) -> BoxFuture<'a, Result<crate::acp::harness::HarnessAgentMessageOutcome, String>> {
        Box::pin(RuntimeBackend::deliver_live_agent_message(
            self,
            thread_id,
            expected_run_id,
            expected_source_turn_id,
            prompt_generation,
            interaction_epoch,
            prompt,
        ))
    }

    fn turn_start<'a>(
        &'a self,
        thread_id: &'a str,
        turn_start: &'a Value,
        source_turn_id: &'a str,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let prompt = bridge_prompt(turn_start)?;
            let approval_policy = approval_policy(turn_start);
            let run_id = format!("{thread_id}::turn::{source_turn_id}");
            let admission = self
                .manager
                .prompt_with_policy_outcome(
                    thread_id,
                    prompt,
                    run_id,
                    source_turn_id.to_string(),
                    approval_policy,
                )
                .await
                .map_err(classified_operation_error)?;
            Ok(admission.source_turn_id)
        })
    }

    fn record_agent_messages<'a>(
        &'a self,
        messages: Vec<(String, crate::agent_messaging::AgentMessageOrigin)>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(RuntimeBackend::record_agent_messages(self, messages))
    }

    fn publish_agent_message<'a>(&'a self, message_id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(RuntimeBackend::publish_agent_message(self, message_id))
    }

    fn remove_agent_message<'a>(
        &'a self,
        message_id: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(RuntimeBackend::remove_agent_message(self, message_id))
    }

    fn update_agent_message_disposition<'a>(
        &'a self,
        message_id: &'a str,
        disposition: crate::agent_messaging::AgentMessageDisposition,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(RuntimeBackend::update_agent_message_disposition(
            self,
            message_id,
            disposition,
        ))
    }
}

fn reject_client_agent_message_envelope(
    method: &str,
    params: Option<&Value>,
) -> Result<(), String> {
    if method != "turn/start" {
        return Ok(());
    }
    let prompt = bridge_prompt(params.ok_or_else(|| "turn/start requires params".to_string())?)?;
    if crate::agent_messaging::prompt_contains_agent_message_envelope(&prompt) {
        return Err("agent message envelopes are reserved for the bridge".to_string());
    }
    Ok(())
}

fn elicitation_value(
    kind: ElicitationFieldKind,
    answer: &Value,
) -> Result<ElicitationContentValue, String> {
    match kind {
        ElicitationFieldKind::String => answer
            .as_str()
            .map(|value| ElicitationContentValue::String(value.to_string()))
            .ok_or_else(|| "answer must be a string".to_string()),
        ElicitationFieldKind::Integer => answer
            .as_i64()
            .map(ElicitationContentValue::Integer)
            .ok_or_else(|| "answer must be an integer".to_string()),
        ElicitationFieldKind::Number => answer
            .as_f64()
            .map(ElicitationContentValue::Number)
            .ok_or_else(|| "answer must be a number".to_string()),
        ElicitationFieldKind::Boolean => answer
            .as_bool()
            .map(ElicitationContentValue::Boolean)
            .ok_or_else(|| "answer must be a boolean".to_string()),
        ElicitationFieldKind::StringArray => answer
            .as_array()
            .and_then(|values| {
                values
                    .iter()
                    .map(|value| value.as_str().map(str::to_string))
                    .collect::<Option<Vec<_>>>()
            })
            .map(ElicitationContentValue::StringArray)
            .ok_or_else(|| "answer must be a string array".to_string()),
        ElicitationFieldKind::Unsupported => Err("elicitation field is unsupported".to_string()),
    }
}

fn required_string(params: &Value, name: &str) -> Result<String, String> {
    read_string(params.get(name))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} must not be empty"))
}

fn approval_policy(params: &Value) -> ApprovalPolicy {
    ApprovalPolicy::from_wire(read_string(params.get("approvalPolicy")).as_deref())
}

fn session_to_thread_value(session: crate::acp::manager::ManagedSession) -> Result<Value, String> {
    let snapshot = crate::acp::snapshot::BridgeThreadSnapshot::from(session.snapshot);
    let title = snapshot.session.title.clone();
    let updated_at = snapshot.session.updated_at.clone();
    let source = session.parent_thread_id.as_ref().map(|parent_thread_id| {
        json!({
            "subAgent": {
                "thread_spawn": {
                    "parentThreadId": parent_thread_id,
                    "depth": 1,
                },
            },
        })
    });
    Ok(json!({
        "id": session.thread_id,
        "agentId": session.agent_id,
        "cwd": session.cwd,
        "name": title,
        "createdAt": updated_at.clone(),
        "updatedAt": updated_at,
        "source": source,
        "acpSnapshot": snapshot,
    }))
}

pub(super) fn bridge_prompt(params: &Value) -> Result<Vec<ContentBlock>, String> {
    let input = params
        .get("input")
        .and_then(Value::as_array)
        .ok_or_else(|| "input must be an array".to_string())?;
    let mut prompt = Vec::with_capacity(input.len());
    for block in input {
        if let Some(text) = block.as_str() {
            prompt.push(ContentBlock::from(text));
            continue;
        }
        if let Ok(content) = serde_json::from_value::<ContentBlock>(block.clone()) {
            prompt.push(content);
            continue;
        }
        let block_type = block.get("type").and_then(Value::as_str);
        match block_type {
            Some("text") => {
                let text = block
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "text input block requires text".to_string())?;
                prompt.push(ContentBlock::from(text));
            }
            Some("mention") => {
                let path = block
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|path| !path.trim().is_empty())
                    .ok_or_else(|| "mention input block requires path".to_string())?;
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or(path);
                prompt.push(ContentBlock::ResourceLink(ResourceLink::new(name, path)));
            }
            Some("localImage") => {
                let path = block
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|path| !path.trim().is_empty())
                    .ok_or_else(|| "localImage input block requires path".to_string())?;
                let name = Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(path);
                let mime_type = match Path::new(path)
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref()
                {
                    Some("jpg" | "jpeg") => Some("image/jpeg"),
                    Some("png") => Some("image/png"),
                    Some("gif") => Some("image/gif"),
                    Some("webp") => Some("image/webp"),
                    _ => None,
                };
                let mut resource = ResourceLink::new(name, path);
                if let Some(mime_type) = mime_type {
                    resource = resource.mime_type(mime_type.to_string());
                }
                prompt.push(ContentBlock::ResourceLink(resource));
            }
            Some(other) => return Err(format!("unsupported input block type: {other}")),
            None => return Err("input block requires type".to_string()),
        }
    }
    if prompt.is_empty() {
        return Err("ACP prompt requires at least one content block".to_string());
    }
    Ok(prompt)
}

pub(super) async fn wait_for_shutdown_signal() -> &'static str {
    wait_for_platform_shutdown().await
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod client_request_tests {
    use super::*;
    use crate::acp::events::{canonical_event_channel, CanonicalEvent, MessageRole};
    use agent_client_protocol::schema::v1::{ToolCallStatus, ToolKind};
    use std::path::PathBuf;
    use tokio::{
        sync::{oneshot, Notify, Semaphore},
        time::{timeout, Duration},
    };

    struct RetirementDispatcher;

    impl QueueRuntimeDispatcher for RetirementDispatcher {
        fn read_snapshot<'a>(
            &'a self,
            thread_id: &'a str,
        ) -> BoxFuture<'a, Result<QueueRuntimeSnapshot, String>> {
            let snapshot =
                crate::acp::snapshot::SessionSnapshot::new("agent".to_string(), thread_id.into());
            Box::pin(async move {
                Ok(QueueRuntimeSnapshot {
                    session: snapshot,
                    pending_approval_ids: HashSet::new(),
                    pending_user_input_ids: HashSet::new(),
                })
            })
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
            Box::pin(async { Ok(false) })
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
            _source_turn_id: &'a str,
        ) -> BoxFuture<'a, Result<String, String>> {
            Box::pin(async { Err("unused".to_string()) })
        }
    }

    fn retirement_test_directory(name: &str) -> PathBuf {
        let directory = std::env::current_dir()
            .expect("current directory")
            .join("target")
            .join(format!("{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("create retirement test directory");
        directory
    }

    fn retirement_test_thread(name: &str) -> String {
        crate::acp::identity::AgentSessionId::new("agent", name)
            .expect("valid test thread ID")
            .encode()
    }

    async fn seeded_durable_retirement_services(
        directory: &std::path::Path,
        thread_id: &str,
    ) -> (
        Arc<BridgeQueueService>,
        Arc<crate::scheduled_prompts::ScheduledPromptService>,
        Arc<crate::retirement_journal::ThreadRetirementJournal>,
    ) {
        let hub = Arc::new(ClientHub::new());
        let receipt_path = directory.join("queue-idempotency.json");
        let queue = BridgeQueueService::with_submission_store(
            Arc::new(RetirementDispatcher),
            hub.clone(),
            Some(receipt_path),
            crate::queue_service::DurableQueueSubmissions::default(),
        );
        queue
            .remember_submission_result(BridgeThreadQueueSendResponse {
                submission_id: "sent-before-delete".to_string(),
                disposition: BridgeThreadQueueDisposition::Sent,
                queue: BridgeQueueService::snapshot_for_thread(thread_id, None),
                turn_id: Some("turn-before-delete".to_string()),
            })
            .await
            .expect("seed durable queue receipt");
        let scheduler = crate::scheduled_prompts::ScheduledPromptService::start_paused(
            directory.join("scheduled-prompts.json"),
            Arc::downgrade(&queue),
            hub,
        )
        .await
        .expect("start paused scheduler");
        scheduler
            .schedule(
                thread_id,
                "survives until ACP deletion succeeds".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .expect("seed durable schedule");
        let journal = Arc::new(
            crate::retirement_journal::ThreadRetirementJournal::load(
                directory.join("thread-retirements.json"),
            )
            .await
            .expect("load retirement journal"),
        );
        (queue, scheduler, journal)
    }

    async fn reload_retirement_services(
        directory: &std::path::Path,
    ) -> (
        Arc<BridgeQueueService>,
        Arc<crate::scheduled_prompts::ScheduledPromptService>,
        Arc<crate::retirement_journal::ThreadRetirementJournal>,
    ) {
        let hub = Arc::new(ClientHub::new());
        let receipt_path = directory.join("queue-idempotency.json");
        let submissions = BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .expect("reload queue idempotency state");
        let queue = BridgeQueueService::with_submission_store(
            Arc::new(RetirementDispatcher),
            hub.clone(),
            Some(receipt_path),
            submissions,
        );
        let scheduler = crate::scheduled_prompts::ScheduledPromptService::start_paused(
            directory.join("scheduled-prompts.json"),
            Arc::downgrade(&queue),
            hub,
        )
        .await
        .expect("reload paused scheduler");
        let journal = Arc::new(
            crate::retirement_journal::ThreadRetirementJournal::load(
                directory.join("thread-retirements.json"),
            )
            .await
            .expect("reload retirement journal"),
        );
        (queue, scheduler, journal)
    }

    struct FixedRetirementReconciler {
        result: RetirementPlanReconciliation,
        expanded: Option<Vec<String>>,
        finalized: StdMutex<Vec<Vec<String>>>,
    }

    impl FixedRetirementReconciler {
        fn new(result: RetirementPlanReconciliation) -> Self {
            Self {
                result,
                expanded: None,
                finalized: StdMutex::new(Vec::new()),
            }
        }

        fn with_expanded(mut self, expanded: Vec<String>) -> Self {
            self.expanded = Some(expanded);
            self
        }

        fn finalized(&self) -> Vec<Vec<String>> {
            self.finalized
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
        }
    }

    impl RetirementSessionReconciler for FixedRetirementReconciler {
        fn reconcile_retirement_plan<'a>(
            &'a self,
            _thread_ids: &'a [String],
        ) -> BoxFuture<'a, RetirementPlanReconciliation> {
            Box::pin(async move { self.result })
        }

        fn expand_absent_retirement_family<'a>(
            &'a self,
            thread_ids: &'a [String],
        ) -> BoxFuture<'a, Result<Vec<String>, String>> {
            Box::pin(
                async move { Ok(self.expanded.clone().unwrap_or_else(|| thread_ids.to_vec())) },
            )
        }

        fn finalize_confirmed_deleted_sessions<'a>(
            &'a self,
            thread_ids: &'a [String],
        ) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                self.finalized
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .push(thread_ids.to_vec());
                Ok(())
            })
        }
    }

    #[test]
    fn client_turn_start_rejects_reserved_agent_message_envelopes() {
        let envelope = crate::agent_messaging::AgentMessageEnvelope::new(
            "message-1".to_string(),
            "parent".to_string(),
            "child".to_string(),
            crate::agent_messaging::AgentRelationKind::SubAgent,
            Some("Parent".to_string()),
            "Inspect the queue.".to_string(),
        )
        .encode()
        .expect("agent-message envelope");
        let split_at = envelope
            .find(",\"senderThreadId\"")
            .expect("encoded sender field");

        for params in [
            json!({"input": [{"type": "text", "text": envelope.clone(), "text_elements": []}]}),
            json!({
                "input": [
                    {"type": "text", "text": &envelope[..split_at], "text_elements": []},
                    {"type": "text", "text": &envelope[split_at..], "text_elements": []},
                ]
            }),
        ] {
            assert_eq!(
                reject_client_agent_message_envelope("turn/start", Some(&params)),
                Err("agent message envelopes are reserved for the bridge".to_string())
            );
        }
        assert!(reject_client_agent_message_envelope(
            "turn/start",
            Some(&json!({
                "input": [{"type": "text", "text": "ordinary user prompt", "text_elements": []}]
            })),
        )
        .is_ok());
        assert!(reject_client_agent_message_envelope(
            "bridge/thread/queue/send",
            Some(&json!({"input": []})),
        )
        .is_ok());
    }

    #[tokio::test]
    async fn canonical_event_pump_keeps_draining_while_side_effects_are_backlogged() {
        let (sender, events) = canonical_event_channel(4);
        let hub = Arc::new(ClientHub::new());
        let mut subscriber = hub.subscribe_canonical_events();
        let (side_effects_tx, mut side_effects_rx) = tokio::sync::mpsc::unbounded_channel();
        let pump = tokio::spawn(pump_canonical_events(events, hub.clone(), side_effects_tx));

        sender
            .send(CanonicalEvent::RunStarted {
                agent_id: "agent".to_string(),
                thread_id: "thread".to_string(),
                run_id: "run".to_string(),
                source_turn_id: "turn".to_string(),
                generation: 1,
            })
            .await
            .expect("run event");
        sender
            .send(CanonicalEvent::MessageChunk {
                agent_id: "agent".to_string(),
                thread_id: "thread".to_string(),
                run_id: Some("run".to_string()),
                source_turn_id: Some("turn".to_string()),
                generation: Some(1),
                role: MessageRole::Agent,
                message_id: "message".to_string(),
                content: "continued".to_string(),
                content_block: None,
            })
            .await
            .expect("message event");

        let first = timeout(Duration::from_millis(100), subscriber.recv())
            .await
            .expect("first event broadcast")
            .expect("first event");
        let second = timeout(Duration::from_millis(100), subscriber.recv())
            .await
            .expect("second event broadcast")
            .expect("second event");
        assert!(matches!(first.event, CanonicalEvent::RunStarted { .. }));
        assert!(matches!(second.event, CanonicalEvent::MessageChunk { .. }));
        assert!(matches!(
            side_effects_rx.try_recv(),
            Ok(CanonicalEvent::RunStarted { .. })
        ));
        assert!(side_effects_rx.try_recv().is_err());

        drop(sender);
        pump.await.expect("event pump");
    }

    /// Several sub-agents at once are told apart by the description their child session is
    /// named after; the placeholder title every task tool starts with names none of them.
    #[test]
    fn child_titles_are_matched_to_the_task_they_were_spawned_for() {
        assert!(child_matches_tool_title(
            Some("Read txt files, write report (@general subagent)"),
            "Read txt files, write report",
        ));
        assert!(!child_matches_tool_title(
            Some("Audit dependencies (@general subagent)"),
            "Read txt files, write report",
        ));
        assert!(!child_matches_tool_title(
            Some("Read txt files, write report (@general subagent)"),
            "task",
        ));
        assert!(!child_matches_tool_title(None, "Read txt files"));
        assert!(!child_matches_tool_title(Some("anything"), "   "));
    }

    #[test]
    fn session_threads_emit_the_current_subagent_source_shape() {
        let value = session_to_thread_value(ManagedSession {
            thread_id: "child-thread".to_string(),
            agent_id: "alpha-agent".to_string(),
            cwd: PathBuf::from("/tmp"),
            parent_thread_id: Some("parent-thread".to_string()),
            snapshot: crate::acp::snapshot::SessionSnapshot::new(
                "alpha-agent".to_string(),
                "child-thread".to_string(),
            ),
        })
        .expect("thread response");

        assert_eq!(
            value["source"],
            json!({
                "subAgent": {
                    "thread_spawn": {
                        "parentThreadId": "parent-thread",
                        "depth": 1,
                    },
                },
            })
        );
    }

    #[test]
    fn parses_all_three_approval_policies_conservatively() {
        assert_eq!(
            approval_policy(&json!({ "approvalPolicy": "never" })),
            ApprovalPolicy::Never
        );
        assert_eq!(
            approval_policy(&json!({ "approvalPolicy": "on-request" })),
            ApprovalPolicy::OnRequest
        );
        assert_eq!(
            approval_policy(&json!({ "approvalPolicy": "untrusted" })),
            ApprovalPolicy::Untrusted
        );
        assert_eq!(approval_policy(&json!({})), ApprovalPolicy::Untrusted);
        assert_eq!(
            approval_policy(&json!({ "approvalPolicy": "invalid" })),
            ApprovalPolicy::Untrusted
        );
    }

    /// A sub-agent has to be found while it is still running, because that is the only thing that
    /// makes its card openable before the task tool finishes. A parent that already owns other
    /// unclaimed children must not defeat that.
    #[test]
    fn a_child_that_appears_after_polling_started_is_the_one_the_tool_spawned() {
        let child = |id: &str, title: Option<&str>| {
            (
                HarnessChildSession {
                    title: title.map(str::to_string),
                    acp_session_id: id.to_string(),
                },
                format!("thread-{id}"),
            )
        };
        let existing = child("old", Some("Earlier errand (@general subagent)"));
        let spawned = child("new", None);

        // Nothing has appeared yet, so the single-candidate rule still resolves the sub-agent.
        let baseline = HashSet::new();
        let candidates = vec![spawned.clone()];
        assert_eq!(
            select_spawned_child(&candidates, "task", &baseline)
                .map(|(_, thread_id)| thread_id.as_str()),
            Some("thread-new"),
        );

        // A leftover child from earlier work used to make this unresolvable, leaving the running
        // card unopenable for the whole run.
        let baseline: HashSet<String> = [existing.1.clone()].into_iter().collect();
        let candidates = vec![existing.clone(), spawned.clone()];
        assert_eq!(
            select_spawned_child(&candidates, "task", &baseline)
                .map(|(_, thread_id)| thread_id.as_str()),
            Some("thread-new"),
        );

        // Two children appearing at once are genuinely ambiguous without a title to tell them
        // apart, so nothing is claimed and the tool's own header resolves it later.
        let both_new = vec![existing.clone(), spawned.clone()];
        assert!(select_spawned_child(&both_new, "task", &HashSet::new()).is_none());

        // A named tool call still wins outright.
        assert_eq!(
            select_spawned_child(&both_new, "Earlier errand", &HashSet::new())
                .map(|(_, thread_id)| thread_id.as_str()),
            Some("thread-old"),
        );
    }

    /// One discovery per tool call: the agent reports a running task tool repeatedly, and each
    /// report must not start another poller for the same sub-agent.
    #[test]
    fn discovery_keys_separate_tool_calls_without_colliding() {
        let mut in_flight = HashSet::new();
        assert!(in_flight.insert(discovery_key("parent", "call-1")));
        assert!(!in_flight.insert(discovery_key("parent", "call-1")));
        assert!(in_flight.insert(discovery_key("parent", "call-2")));
        assert_ne!(
            discovery_key("parent", "a\u{1}b"),
            discovery_key("parent\u{1}a", "b"),
        );
    }

    #[test]
    fn late_child_terminal_after_projector_state_loss_broadcasts_the_updated_parent_snapshot() {
        let mut snapshot = crate::acp::snapshot::SessionSnapshot::new(
            "alpha-agent".to_string(),
            "parent-thread".to_string(),
        );
        snapshot.apply(&crate::acp::events::CanonicalEvent::Tool {
            agent_id: "alpha-agent".to_string(),
            thread_id: "parent-thread".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            tool_call_id: "task-1".to_string(),
            kind: ToolKind::Other,
            status: ToolCallStatus::InProgress,
            title: "Research dependency options".to_string(),
            content: crate::acp::events::FieldUpdate::Set(
                "<task id=\"child-1\" state=\"running\">\nWorking\n</task>".to_string(),
            ),
            structured_content: crate::acp::events::FieldUpdate::Set(Vec::new()),
            locations: crate::acp::events::FieldUpdate::Set(Vec::new()),
        });
        assert!(snapshot.mark_subagent_terminal("child-1", "failed"));
        snapshot.apply(&crate::acp::events::CanonicalEvent::Tool {
            agent_id: "alpha-agent".to_string(),
            thread_id: "parent-thread".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            tool_call_id: "task-1".to_string(),
            kind: ToolKind::Other,
            status: ToolCallStatus::Completed,
            title: "Research dependency options".to_string(),
            content: crate::acp::events::FieldUpdate::Set(
                "<task id=\"child-1\" state=\"running\">\nWrapper completed\n</task>".to_string(),
            ),
            structured_content: crate::acp::events::FieldUpdate::Unchanged,
            locations: crate::acp::events::FieldUpdate::Unchanged,
        });
        let parent = ManagedSession {
            thread_id: "parent-thread".to_string(),
            agent_id: "alpha-agent".to_string(),
            cwd: PathBuf::from("/tmp"),
            parent_thread_id: None,
            snapshot,
        };

        let envelope = parent_subagent_snapshot_envelope(&parent);
        assert_eq!(envelope.thread_id, "parent-thread");
        let card = envelope
            .event
            .messages
            .expect("parent snapshot messages")
            .into_iter()
            .find(|message| message.id == "subagent:task-1")
            .and_then(|message| serde_json::to_value(message).ok())
            .expect("corrected parent card");
        assert_eq!(card["content"]["subAgent"]["agentStatus"], "failed");
        assert!(card["content"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("Sub-agent failed")));
    }

    #[tokio::test]
    async fn disconnect_cancels_blocked_permit_and_acp_futures_and_cleans_map() {
        let tracker = Arc::new(ClientRequestTracker::default());
        tracker.register_client(7);
        let semaphore = Arc::new(Semaphore::new(0));
        let permit_wait = {
            let tracker = tracker.clone();
            let semaphore = semaphore.clone();
            tokio::spawn(async move {
                tracker
                    .run(7, async move { semaphore.acquire_owned().await })
                    .await
            })
        };
        let (_acp_tx, acp_rx) = oneshot::channel::<()>();
        let acp_wait = {
            let tracker = tracker.clone();
            tokio::spawn(async move { tracker.run(7, acp_rx).await })
        };
        while tracker.request_count() != 2 {
            tokio::task::yield_now().await;
        }

        tracker.cancel_client(7);
        assert_eq!(
            timeout(Duration::from_secs(1), permit_wait)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err(),
            "client request cancelled"
        );
        assert_eq!(
            timeout(Duration::from_secs(1), acp_wait)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err(),
            "client request cancelled"
        );
        assert_eq!(tracker.request_count(), 0);
        assert_eq!(tracker.run(7, async {}).await, Err("client disconnected"));
    }

    #[tokio::test]
    async fn disconnect_before_the_operation_is_polled_is_definitive() {
        let tracker = Arc::new(ClientRequestTracker::default());
        tracker.register_client(8);
        let cancelling_tracker = Arc::clone(&tracker);

        let result = tracker
            .run_with(8, move |_| {
                cancelling_tracker.cancel_client(8);
                std::future::pending::<()>()
            })
            .await;

        assert_eq!(result, Err("client disconnected"));
        assert_eq!(tracker.request_count(), 0);
    }

    #[tokio::test]
    async fn post_apply_response_loss_preserves_prepared_family_and_recovers_indexed_descendants() {
        let directory = retirement_test_directory("retirement-response-loss");
        let thread_id = retirement_test_thread("response-loss");
        let child_thread_id = retirement_test_thread("response-loss-child");
        let late_child_thread_id = retirement_test_thread("response-loss-late-child");
        let retiring_thread_ids = vec![thread_id.clone(), child_thread_id.clone()];
        let (queue, scheduler, journal) =
            seeded_durable_retirement_services(&directory, &thread_id).await;
        let retirement = ThreadStateRetirement::begin_with_journal(
            queue.clone(),
            scheduler.clone(),
            journal,
            CancellationToken::new(),
            &retiring_thread_ids,
        )
        .await
        .expect("begin durable retirement");

        let persisted = crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json"),
        )
        .await
        .expect("load persisted tombstone");
        let mut expected_thread_ids = retiring_thread_ids.clone();
        expected_thread_ids.sort();
        let entries = persisted.entries().await;
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].phase,
            crate::retirement_journal::RetirementPhase::Prepared
        );
        assert_eq!(entries[0].requested_thread_ids, expected_thread_ids);
        assert_eq!(scheduler.list(&thread_id).await.len(), 1);
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .contains_key("sent-before-delete"));

        assert_eq!(
            retirement
                .finish_delete(Err("ACP response was lost after apply".to_string()))
                .await
                .unwrap_err(),
            "ACP response was lost after apply"
        );
        let entries = crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json"),
        )
        .await
        .unwrap()
        .entries()
        .await;
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].phase,
            crate::retirement_journal::RetirementPhase::Prepared
        );
        assert_eq!(entries[0].requested_thread_ids, expected_thread_ids);
        assert_eq!(scheduler.list(&thread_id).await.len(), 1);
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .contains_key("sent-before-delete"));
        drop(
            queue
                .retirement_fence
                .admit(&thread_id)
                .await
                .expect("indeterminate delete releases the fence"),
        );
        drop(
            queue
                .retirement_fence
                .admit(&child_thread_id)
                .await
                .expect("indeterminate delete releases the complete family fence"),
        );
        scheduler
            .schedule(
                &late_child_thread_id,
                "indexed after the prepared family was frozen".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .expect("seed late indexed descendant schedule");
        queue
            .remember_submission_result(BridgeThreadQueueSendResponse {
                submission_id: "sent-before-late-child-delete".to_string(),
                disposition: BridgeThreadQueueDisposition::Sent,
                queue: BridgeQueueService::snapshot_for_thread(&late_child_thread_id, None),
                turn_id: Some("turn-before-late-child-delete".to_string()),
            })
            .await
            .expect("seed late indexed descendant receipt");
        scheduler.shutdown().await;
        drop(scheduler);

        let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
        let mut recovered_family = vec![
            thread_id.clone(),
            child_thread_id,
            late_child_thread_id.clone(),
        ];
        recovered_family.sort();
        let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Absent)
            .with_expanded(recovered_family.clone());
        ThreadStateRetirement::recover_pending(
            queue,
            scheduler.clone(),
            journal,
            &reconciler,
            CancellationToken::new(),
        )
        .await
        .expect("confirmed absent expanded family converges");

        assert!(scheduler.list(&thread_id).await.is_empty());
        assert!(scheduler.list(&late_child_thread_id).await.is_empty());
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .is_empty());
        assert_eq!(reconciler.finalized(), vec![recovered_family]);
        assert!(crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json")
        )
        .await
        .unwrap()
        .entries()
        .await
        .is_empty());
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn drop_before_delete_invocation_preserves_prepared_tombstone_without_background_work() {
        let directory = retirement_test_directory("retirement-pre-delete-drop");
        let thread_id = retirement_test_thread("pre-delete-drop");
        let (queue, scheduler, journal) =
            seeded_durable_retirement_services(&directory, &thread_id).await;
        let retirement = ThreadStateRetirement::begin_with_journal(
            queue.clone(),
            scheduler.clone(),
            journal,
            CancellationToken::new(),
            std::slice::from_ref(&thread_id),
        )
        .await
        .expect("begin durable retirement");

        drop(retirement);
        drop(
            queue
                .retirement_fence
                .admit(&thread_id)
                .await
                .expect("dropping retirement releases its fence synchronously"),
        );
        let entries = crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json"),
        )
        .await
        .unwrap()
        .entries()
        .await;
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].phase,
            crate::retirement_journal::RetirementPhase::Prepared
        );
        assert_eq!(scheduler.list(&thread_id).await.len(), 1);
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .contains_key("sent-before-delete"));

        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn shutdown_abort_joins_owned_delete_and_preserves_recoverable_prepared_tombstone() {
        let directory = retirement_test_directory("retirement-abort-during-delete");
        let thread_id = retirement_test_thread("abort-during-delete");
        let (queue, scheduler, journal) =
            seeded_durable_retirement_services(&directory, &thread_id).await;
        let tracker = Arc::new(ClientRequestTracker::default());
        tracker.register_client(82);
        let (delete_invoked_tx, delete_invoked_rx) = oneshot::channel();
        let delete = tokio::spawn({
            let tracker = tracker.clone();
            let queue = queue.clone();
            let scheduler = scheduler.clone();
            let journal = journal.clone();
            let thread_id = thread_id.clone();
            async move {
                tracker
                    .run_owned_with(82, move || async move {
                        let retirement = ThreadStateRetirement::begin_with_journal(
                            queue,
                            scheduler,
                            journal,
                            CancellationToken::new(),
                            std::slice::from_ref(&thread_id),
                        )
                        .await
                        .expect("begin durable retirement");
                        delete_invoked_tx.send(()).unwrap();
                        let _retirement = retirement;
                        std::future::pending::<()>().await;
                    })
                    .await
            }
        });
        delete_invoked_rx.await.unwrap();

        timeout(Duration::from_secs(1), tracker.shutdown_owned_requests())
            .await
            .expect("shutdown aborts and joins the owned delete task");
        assert_eq!(
            delete
                .await
                .expect("delete request wrapper settles")
                .expect("client request remains registered")
                .unwrap_err(),
            "owned client request task failed"
        );
        assert_eq!(
            tracker.active_request_count(),
            0,
            "no retirement task survives the tracked outer delete task"
        );
        drop(
            queue
                .retirement_fence
                .admit(&thread_id)
                .await
                .expect("aborted delete releases in-memory guards before shutdown returns"),
        );

        let entries = crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json"),
        )
        .await
        .unwrap()
        .entries()
        .await;
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].phase,
            crate::retirement_journal::RetirementPhase::Prepared
        );
        assert_eq!(scheduler.list(&thread_id).await.len(), 1);
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .contains_key("sent-before-delete"));

        scheduler.shutdown().await;
        drop(scheduler);

        let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
        let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Absent);
        ThreadStateRetirement::recover_pending(
            queue.clone(),
            scheduler.clone(),
            journal.clone(),
            &reconciler,
            CancellationToken::new(),
        )
        .await
        .expect("startup reconciles the journal preserved by shutdown abort");
        assert!(journal.entries().await.is_empty());
        assert!(scheduler.list(&thread_id).await.is_empty());
        assert_eq!(
            queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
            "thread is being deleted",
            "confirmed-absent startup recovery installs a deleted-thread tombstone"
        );
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .is_empty());
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn prepared_recovery_with_live_acp_session_preserves_work_and_clears_journal() {
        let directory = retirement_test_directory("retirement-prepared-live");
        let thread_id = retirement_test_thread("prepared-live");
        let (queue, scheduler, journal) =
            seeded_durable_retirement_services(&directory, &thread_id).await;
        let retirement = ThreadStateRetirement::begin_with_journal(
            queue,
            scheduler.clone(),
            journal,
            CancellationToken::new(),
            std::slice::from_ref(&thread_id),
        )
        .await
        .expect("begin durable retirement");

        retirement.abandon_for_test();
        scheduler.shutdown().await;
        drop(scheduler);

        let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
        let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Present);
        ThreadStateRetirement::recover_pending(
            queue.clone(),
            scheduler.clone(),
            journal.clone(),
            &reconciler,
            CancellationToken::new(),
        )
        .await
        .expect("live prepared retirement rolls back");

        assert_eq!(scheduler.list(&thread_id).await.len(), 1);
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .contains_key("sent-before-delete"));
        assert!(crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json")
        )
        .await
        .unwrap()
        .entries()
        .await
        .is_empty());
        assert!(reconciler.finalized().is_empty());
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn prepared_recovery_with_confirmed_absent_session_promotes_and_cleans() {
        let directory = retirement_test_directory("retirement-prepared-absent");
        let thread_id = retirement_test_thread("prepared-absent");
        let (queue, scheduler, journal) =
            seeded_durable_retirement_services(&directory, &thread_id).await;
        let retirement = ThreadStateRetirement::begin_with_journal(
            queue,
            scheduler.clone(),
            journal,
            CancellationToken::new(),
            std::slice::from_ref(&thread_id),
        )
        .await
        .expect("begin durable retirement");
        retirement.abandon_for_test();
        scheduler.shutdown().await;
        drop(scheduler);

        let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
        let (outbox, mut notifications) = crate::client_outbox::client_outbox(8);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Absent);
        ThreadStateRetirement::recover_pending(
            queue.clone(),
            scheduler.clone(),
            journal,
            &reconciler,
            CancellationToken::new(),
        )
        .await
        .expect("startup recovery converges");

        assert!(scheduler.list(&thread_id).await.is_empty());
        assert_eq!(
            queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
            "thread is being deleted",
            "confirmed-absent startup recovery installs a deleted-thread tombstone"
        );
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .is_empty());
        assert!(crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json")
        )
        .await
        .unwrap()
        .entries()
        .await
        .is_empty());
        assert_eq!(reconciler.finalized(), vec![vec![thread_id.clone()]]);
        let mut methods = HashSet::new();
        for _ in 0..2 {
            let message = timeout(Duration::from_secs(1), notifications.recv())
                .await
                .expect("recovery notification timeout")
                .expect("recovery notification");
            let axum::extract::ws::Message::Text(text) = message else {
                panic!("expected text recovery notification");
            };
            let value: Value = serde_json::from_str(text.as_str()).unwrap();
            assert_eq!(value["params"]["threadId"], thread_id);
            methods.insert(value["method"].as_str().unwrap().to_string());
        }
        assert_eq!(
            methods,
            HashSet::from([
                "bridge/thread/queue/updated".to_string(),
                "bridge/thread/schedules/updated".to_string(),
            ])
        );
        scheduler
            .start_worker()
            .expect("scheduled worker starts only after recovery");
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn deleted_phase_freezes_expanded_family_before_cleanup_and_recovers_union() {
        let directory = retirement_test_directory("retirement-deleted-expanded");
        let thread_id = retirement_test_thread("deleted-expanded");
        let additional_thread_id = retirement_test_thread("deleted-expanded-child");
        let (queue, scheduler, journal) =
            seeded_durable_retirement_services(&directory, &thread_id).await;
        queue
            .remember_submission_result(BridgeThreadQueueSendResponse {
                submission_id: "sent-before-expanded-delete".to_string(),
                disposition: BridgeThreadQueueDisposition::Sent,
                queue: BridgeQueueService::snapshot_for_thread(&additional_thread_id, None),
                turn_id: Some("turn-before-expanded-delete".to_string()),
            })
            .await
            .expect("seed expanded durable queue receipt");
        scheduler
            .schedule(
                &additional_thread_id,
                "expanded child survives until deleted phase".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .expect("seed expanded durable schedule");
        let mut expected_family = vec![thread_id.clone(), additional_thread_id.clone()];
        expected_family.sort();
        let retirement = ThreadStateRetirement::begin_with_journal(
            queue,
            scheduler.clone(),
            journal,
            CancellationToken::new(),
            &expected_family,
        )
        .await
        .expect("begin durable retirement");
        assert_eq!(
            retirement
                .mark_deleted_then_abandon_for_test(&expected_family)
                .await
                .expect("persist delete response before cleanup"),
            expected_family
        );
        scheduler.shutdown().await;
        drop(scheduler);

        let persisted = crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json"),
        )
        .await
        .unwrap()
        .entries()
        .await;
        assert_eq!(persisted.len(), 1);
        assert_eq!(
            persisted[0].phase,
            crate::retirement_journal::RetirementPhase::Deleted
        );
        assert_eq!(persisted[0].deleted_thread_ids, expected_family);

        let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
        let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Present);
        ThreadStateRetirement::recover_pending(
            queue.clone(),
            scheduler.clone(),
            journal.clone(),
            &reconciler,
            CancellationToken::new(),
        )
        .await
        .expect("deleted union recovery converges");
        assert!(scheduler.list(&thread_id).await.is_empty());
        assert!(scheduler.list(&additional_thread_id).await.is_empty());
        for deleted_thread_id in [&thread_id, &additional_thread_id] {
            assert_eq!(
                queue
                    .retirement_fence
                    .admit(deleted_thread_id)
                    .await
                    .unwrap_err(),
                "thread is being deleted",
                "deleted journal recovery leaves the complete family tombstoned"
            );
        }
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .is_empty());
        assert_eq!(reconciler.finalized(), vec![expected_family]);
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn global_retirement_barrier_drains_manager_waiting_descendant_without_deadlock() {
        let queue =
            BridgeQueueService::new(Arc::new(RetirementDispatcher), Arc::new(ClientHub::new()));
        let parent = retirement_test_thread("barrier-parent");
        let descendant = retirement_test_thread("barrier-descendant");
        let manager_family_lock = Arc::new(Mutex::new(()));
        let held_manager_operation = manager_family_lock.clone().lock_owned().await;
        let dispatch_reached_manager = Arc::new(Notify::new());
        let dispatch = tokio::spawn({
            let queue = queue.clone();
            let descendant = descendant.clone();
            let manager_family_lock = manager_family_lock.clone();
            let dispatch_reached_manager = dispatch_reached_manager.clone();
            async move {
                let _admission = queue
                    .retirement_fence
                    .admit(&descendant)
                    .await
                    .expect("descendant dispatch is initially admitted");
                dispatch_reached_manager.notify_one();
                let _manager_operation = manager_family_lock.lock().await;
            }
        });
        timeout(Duration::from_secs(1), dispatch_reached_manager.notified())
            .await
            .expect("descendant dispatch reaches the manager family lock");

        let barrier_attempted = Arc::new(Notify::new());
        *queue
            .retirement_fence
            .begin_attempted
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(barrier_attempted.clone());
        let deletion = tokio::spawn({
            let queue = queue.clone();
            let parent = parent.clone();
            let descendant = descendant.clone();
            let manager_family_lock = manager_family_lock.clone();
            async move {
                let barrier = queue.block_retirement_admissions().await;
                let _manager_family = manager_family_lock.lock().await;
                let lease = queue
                    .begin_retirement_fence_blocked(&[parent, descendant], &barrier)
                    .expect("authoritative family fence installs beneath global barrier");
                drop(barrier);
                lease
            }
        });
        timeout(Duration::from_secs(1), barrier_attempted.notified())
            .await
            .expect("deletion queues the global admission barrier before manager planning");
        let late_admission = tokio::spawn({
            let queue = queue.clone();
            let descendant = descendant.clone();
            async move { queue.retirement_fence.admit(&descendant).await }
        });
        tokio::task::yield_now().await;
        assert!(!deletion.is_finished());
        assert!(!late_admission.is_finished());

        drop(held_manager_operation);
        timeout(Duration::from_secs(1), dispatch)
            .await
            .expect("admitted dispatch clears the manager lock")
            .expect("dispatch task");
        let lease = timeout(Duration::from_secs(1), deletion)
            .await
            .expect("global-barrier deletion cannot deadlock")
            .expect("deletion task");
        assert_eq!(
            timeout(Duration::from_secs(1), late_admission)
                .await
                .expect("late admission settles after full-family fence installation")
                .expect("late admission task")
                .unwrap_err(),
            "thread is being deleted"
        );
        lease.finish().await;
    }

    #[tokio::test]
    async fn prepared_authoritative_family_recovers_after_delete_and_index_removal_crash() {
        let directory = retirement_test_directory("retirement-post-delete-crash");
        let parent = retirement_test_thread("post-delete-crash-parent");
        let descendant = retirement_test_thread("post-delete-crash-descendant");
        let (queue, scheduler, journal) =
            seeded_durable_retirement_services(&directory, &parent).await;
        scheduler
            .schedule(
                &descendant,
                "frozen before ACP deletion".to_string(),
                &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            )
            .await
            .expect("seed descendant schedule");
        queue
            .remember_submission_result(BridgeThreadQueueSendResponse {
                submission_id: "sent-before-post-delete-crash".to_string(),
                disposition: BridgeThreadQueueDisposition::Sent,
                queue: BridgeQueueService::snapshot_for_thread(&descendant, None),
                turn_id: Some("turn-before-post-delete-crash".to_string()),
            })
            .await
            .expect("seed descendant receipt");
        let mut authoritative = vec![parent.clone(), descendant.clone()];
        authoritative.sort();
        let retirement = ThreadStateRetirement::begin_with_journal(
            queue,
            scheduler.clone(),
            journal,
            CancellationToken::new(),
            &authoritative,
        )
        .await
        .expect("freeze authoritative family before ACP deletion");

        retirement.abandon_for_test();
        scheduler.shutdown().await;
        drop(scheduler);
        let persisted = crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json"),
        )
        .await
        .unwrap()
        .entries()
        .await;
        assert_eq!(persisted.len(), 1);
        assert_eq!(
            persisted[0].phase,
            crate::retirement_journal::RetirementPhase::Prepared
        );
        assert_eq!(persisted[0].requested_thread_ids, authoritative);

        let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
        let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Absent)
            .with_expanded(authoritative.clone());
        ThreadStateRetirement::recover_pending(
            queue,
            scheduler.clone(),
            journal.clone(),
            &reconciler,
            CancellationToken::new(),
        )
        .await
        .expect("prepared complete family recovers without session-index ancestry");

        assert!(scheduler.list(&parent).await.is_empty());
        assert!(scheduler.list(&descendant).await.is_empty());
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .is_empty());
        assert_eq!(reconciler.finalized(), vec![authoritative]);
        assert!(journal.entries().await.is_empty());
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn authoritative_delete_fences_descendants_before_journal_retry_and_cleanup() {
        let directory = retirement_test_directory("retirement-authoritative-fence");
        let parent = retirement_test_thread("authoritative-fence-parent");
        let queued_descendant = retirement_test_thread("authoritative-fence-queued");
        let steered_descendant = retirement_test_thread("authoritative-fence-steered");
        let (queue, scheduler, journal) =
            seeded_durable_retirement_services(&directory, &parent).await;
        let queued_entry = |id: &str| BridgeQueuedMessageEntry {
            id: id.to_string(),
            submission_id: format!("submission-{id}"),
            created_at: now_iso(),
            content: format!("content-{id}"),
            turn_start: json!({
                "input": [{"type": "text", "text": format!("content-{id}"), "text_elements": []}]
            }),
            agent_message: None,
        };
        queue.threads.write().await.insert(
            queued_descendant.clone(),
            BridgeThreadQueueRuntime {
                items: std::collections::VecDeque::from([queued_entry("expanded-queue")]),
                ..BridgeThreadQueueRuntime::default()
            },
        );
        queue.threads.write().await.insert(
            steered_descendant.clone(),
            BridgeThreadQueueRuntime {
                pending_steers: std::collections::VecDeque::from([queued_entry("expanded-steer")]),
                active_turn_id: Some("turn".to_string()),
                active_run_id: Some("run".to_string()),
                active_prompt_generation: Some(1),
                live_generation_known: true,
                thread_running: true,
                ..BridgeThreadQueueRuntime::default()
            },
        );
        let mut deleted_family = vec![
            parent.clone(),
            queued_descendant.clone(),
            steered_descendant.clone(),
        ];
        deleted_family.sort();
        let retirement = ThreadStateRetirement::begin_with_journal(
            queue.clone(),
            scheduler.clone(),
            journal.clone(),
            CancellationToken::new(),
            &deleted_family,
        )
        .await
        .expect("freeze and guard the authoritative family before ACP deletion");
        let prepared = journal.entries().await;
        assert_eq!(prepared.len(), 1);
        assert_eq!(prepared[0].requested_thread_ids, deleted_family);
        for thread_id in [&queued_descendant, &steered_descendant] {
            assert_eq!(
                queue.retirement_fence.admit(thread_id).await.unwrap_err(),
                "thread is being deleted"
            );
        }

        journal.fail_all_persists(true);
        let retry_reached = Arc::new(Notify::new());
        let release_retry = Arc::new(Notify::new());
        *queue
            .retirement_retry_barrier
            .lock()
            .unwrap_or_else(|error| error.into_inner()) =
            Some((retry_reached.clone(), release_retry.clone()));
        let cleanup = tokio::spawn({
            let deleted_family = deleted_family.clone();
            async move { retirement.finish_delete(Ok(deleted_family)).await }
        });
        timeout(Duration::from_secs(1), retry_reached.notified())
            .await
            .expect("deleted journal phase reaches persistence retry");

        for thread_id in [&queued_descendant, &steered_descendant] {
            assert_eq!(
                queue.retirement_fence.admit(thread_id).await.unwrap_err(),
                "thread is being deleted"
            );
        }
        timeout(Duration::from_secs(1), async {
            tokio::join!(
                queue.drain_thread_queue(queued_descendant.clone()),
                queue.drain_pending_steers(steered_descendant.clone()),
            );
        })
        .await
        .expect("fenced background dispatch attempts return");
        {
            let threads = queue.threads.read().await;
            let queued = threads
                .get(&queued_descendant)
                .expect("queued descendant remains pending before cleanup");
            assert_eq!(queued.items.len(), 1);
            assert!(!queued.turn_start_in_flight);
            assert!(queued.last_error.is_none());
            let steered = threads
                .get(&steered_descendant)
                .expect("steered descendant remains pending before cleanup");
            assert_eq!(steered.pending_steers.len(), 1);
            assert!(!steered.steer_prepare_in_flight);
            assert!(steered.steer_dispatch_in_flight.is_none());
            assert!(steered.last_error.is_none());
        }

        journal.fail_all_persists(false);
        release_retry.notify_one();
        assert_eq!(
            timeout(Duration::from_secs(1), cleanup)
                .await
                .expect("expanded retirement cleanup completes")
                .expect("cleanup task")
                .expect("retirement converges"),
            deleted_family
        );
        for thread_id in [&queued_descendant, &steered_descendant] {
            assert_eq!(
                queue.retirement_fence.admit(thread_id).await.unwrap_err(),
                "thread is being deleted",
                "successful cleanup leaves the authoritative family tombstoned"
            );
        }
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn prepared_recovery_with_mixed_or_indeterminate_sessions_keeps_tombstone_and_work() {
        let directory = retirement_test_directory("retirement-prepared-indeterminate");
        let thread_id = retirement_test_thread("prepared-indeterminate");
        let child_thread_id = retirement_test_thread("prepared-indeterminate-child");
        let (queue, scheduler, journal) =
            seeded_durable_retirement_services(&directory, &thread_id).await;
        let retirement = ThreadStateRetirement::begin_with_journal(
            queue,
            scheduler.clone(),
            journal,
            CancellationToken::new(),
            &[thread_id.clone(), child_thread_id],
        )
        .await
        .expect("begin durable retirement");
        retirement.abandon_for_test();
        scheduler.shutdown().await;
        drop(scheduler);

        let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
        let reconciler =
            FixedRetirementReconciler::new(RetirementPlanReconciliation::Indeterminate);
        let error = ThreadStateRetirement::recover_pending(
            queue,
            scheduler.clone(),
            journal,
            &reconciler,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("indeterminate or mixed"));
        assert_eq!(scheduler.list(&thread_id).await.len(), 1);
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .contains_key("sent-before-delete"));
        let entries = crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json"),
        )
        .await
        .unwrap()
        .entries()
        .await;
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].phase,
            crate::retirement_journal::RetirementPhase::Prepared
        );
        assert!(reconciler.finalized().is_empty());
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn restart_idempotently_recovers_either_partially_cleaned_store() {
        for scheduler_cleaned_first in [false, true] {
            let directory = retirement_test_directory(if scheduler_cleaned_first {
                "retirement-crash-scheduler-clean"
            } else {
                "retirement-crash-queue-clean"
            });
            let thread_id = retirement_test_thread(if scheduler_cleaned_first {
                "scheduler-clean"
            } else {
                "queue-clean"
            });
            let (queue, scheduler, journal) =
                seeded_durable_retirement_services(&directory, &thread_id).await;
            let retirement = ThreadStateRetirement::begin_with_journal(
                queue,
                scheduler.clone(),
                journal,
                CancellationToken::new(),
                std::slice::from_ref(&thread_id),
            )
            .await
            .expect("begin durable retirement");
            if scheduler_cleaned_first {
                retirement
                    .commit_scheduler_then_abandon_for_test()
                    .await
                    .expect("persist scheduler cleanup");
                assert!(scheduler.list(&thread_id).await.is_empty());
                assert!(BridgeQueueService::load_submission_store(
                    &directory.join("queue-idempotency.json")
                )
                .await
                .unwrap()
                .results
                .contains_key("sent-before-delete"));
            } else {
                retirement
                    .commit_queue_then_abandon_for_test()
                    .await
                    .expect("persist queue cleanup");
                assert!(scheduler.list(&thread_id).await.len() == 1);
                assert!(BridgeQueueService::load_submission_store(
                    &directory.join("queue-idempotency.json")
                )
                .await
                .unwrap()
                .results
                .is_empty());
            }
            assert!(!crate::retirement_journal::ThreadRetirementJournal::load(
                directory.join("thread-retirements.json")
            )
            .await
            .unwrap()
            .entries()
            .await
            .is_empty());
            scheduler.shutdown().await;
            drop(scheduler);

            let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
            let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Present);
            ThreadStateRetirement::recover_pending(
                queue.clone(),
                scheduler.clone(),
                journal.clone(),
                &reconciler,
                CancellationToken::new(),
            )
            .await
            .expect("partial startup recovery converges");
            assert!(scheduler.list(&thread_id).await.is_empty());
            assert!(BridgeQueueService::load_submission_store(
                &directory.join("queue-idempotency.json")
            )
            .await
            .unwrap()
            .results
            .is_empty());
            assert!(crate::retirement_journal::ThreadRetirementJournal::load(
                directory.join("thread-retirements.json")
            )
            .await
            .unwrap()
            .entries()
            .await
            .is_empty());
            ThreadStateRetirement::recover_pending(
                queue,
                scheduler.clone(),
                journal,
                &reconciler,
                CancellationToken::new(),
            )
            .await
            .expect("cleared deleted journal recovery is idempotent");
            scheduler.shutdown().await;
            let _ = std::fs::remove_dir_all(directory);
        }
    }

    #[tokio::test]
    async fn journal_clear_precedes_success_snapshots_and_deleted_tombstone_transition() {
        let directory = retirement_test_directory("retirement-final-commit-order");
        let thread_id = retirement_test_thread("final-commit-order");
        let (queue, scheduler, journal) =
            seeded_durable_retirement_services(&directory, &thread_id).await;
        let (outbox, mut notifications) = crate::client_outbox::client_outbox(8);
        queue
            .hub
            .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let retirement = ThreadStateRetirement::begin_with_journal(
            queue.clone(),
            scheduler.clone(),
            journal.clone(),
            CancellationToken::new(),
            std::slice::from_ref(&thread_id),
        )
        .await
        .expect("begin durable retirement");
        journal.fail_all_removes(true);
        let retry_reached = Arc::new(Notify::new());
        let release_retry = Arc::new(Notify::new());
        *queue
            .retirement_retry_barrier
            .lock()
            .unwrap_or_else(|error| error.into_inner()) =
            Some((retry_reached.clone(), release_retry.clone()));
        let cleanup = tokio::spawn({
            let thread_id = thread_id.clone();
            async move { retirement.finish_delete(Ok(vec![thread_id])).await }
        });
        timeout(Duration::from_secs(1), retry_reached.notified())
            .await
            .expect("journal clear reaches its retry owner");

        assert!(scheduler.list(&thread_id).await.is_empty());
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .is_empty());
        assert_eq!(
            crate::retirement_journal::ThreadRetirementJournal::load(
                directory.join("thread-retirements.json")
            )
            .await
            .unwrap()
            .entries()
            .await[0]
                .phase,
            crate::retirement_journal::RetirementPhase::Deleted
        );
        assert!(
            notifications.try_recv().is_err(),
            "durable cleanup must not look committed before the tombstone clears"
        );
        assert_eq!(
            queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
            "thread is being deleted"
        );

        journal.fail_all_removes(false);
        release_retry.notify_one();
        assert_eq!(
            timeout(Duration::from_secs(1), cleanup)
                .await
                .expect("journal clear retry completes")
                .expect("cleanup task")
                .expect("retirement converges"),
            vec![thread_id.clone()]
        );
        assert!(journal.entries().await.is_empty());
        let mut methods = HashSet::new();
        for _ in 0..2 {
            let message = timeout(Duration::from_secs(1), notifications.recv())
                .await
                .expect("success notification timeout")
                .expect("success notification");
            let axum::extract::ws::Message::Text(text) = message else {
                panic!("expected text success notification");
            };
            let value: Value = serde_json::from_str(text.as_str()).unwrap();
            methods.insert(value["method"].as_str().unwrap().to_string());
        }
        assert_eq!(
            methods,
            HashSet::from([
                "bridge/thread/queue/updated".to_string(),
                "bridge/thread/schedules/updated".to_string(),
            ])
        );
        assert_eq!(
            queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
            "thread is being deleted",
            "journal clear transitions retirement to a permanent deleted tombstone"
        );

        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn startup_recovery_bounds_permanent_persistence_failure_and_retains_journal() {
        let directory = retirement_test_directory("retirement-startup-bound");
        let thread_id = retirement_test_thread("startup-bound");
        let (queue, scheduler, journal) =
            seeded_durable_retirement_services(&directory, &thread_id).await;
        let retirement = ThreadStateRetirement::begin_with_journal(
            queue.clone(),
            scheduler.clone(),
            journal.clone(),
            CancellationToken::new(),
            std::slice::from_ref(&thread_id),
        )
        .await
        .expect("begin durable retirement");
        retirement
            .mark_deleted_then_abandon_for_test(std::slice::from_ref(&thread_id))
            .await
            .expect("freeze deleted phase");
        journal.fail_all_removes(true);
        let attempts_before = journal.remove_attempt_count();
        let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Absent);

        let error = timeout(
            Duration::from_secs(1),
            ThreadStateRetirement::recover_pending(
                queue.clone(),
                scheduler.clone(),
                journal.clone(),
                &reconciler,
                CancellationToken::new(),
            ),
        )
        .await
        .expect("startup recovery is bounded")
        .unwrap_err();
        assert!(error.contains(&format!(
            "did not converge after {THREAD_RETIREMENT_STARTUP_MAX_ATTEMPTS} attempts"
        )));
        assert_eq!(
            journal.remove_attempt_count() - attempts_before,
            THREAD_RETIREMENT_STARTUP_MAX_ATTEMPTS as usize
        );
        assert_eq!(journal.entries().await.len(), 1);
        assert_eq!(
            journal.entries().await[0].phase,
            crate::retirement_journal::RetirementPhase::Deleted
        );
        assert_eq!(
            queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
            "thread is being deleted",
            "deleted-plan recovery keeps its in-memory tombstone after bounded cleanup failure"
        );

        journal.fail_all_removes(false);
        ThreadStateRetirement::recover_pending(
            queue,
            scheduler.clone(),
            journal.clone(),
            &reconciler,
            CancellationToken::new(),
        )
        .await
        .expect("next startup completes retained cleanup");
        assert!(journal.entries().await.is_empty());
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn shutdown_bounds_permanent_journal_failure_and_leaves_recoverable_tombstone() {
        let directory = retirement_test_directory("retirement-shutdown");
        let thread_id = retirement_test_thread("shutdown");
        let (queue, scheduler, journal) =
            seeded_durable_retirement_services(&directory, &thread_id).await;
        let shutdown = CancellationToken::new();
        let retirement = ThreadStateRetirement::begin_with_journal(
            queue.clone(),
            scheduler.clone(),
            journal.clone(),
            shutdown.clone(),
            std::slice::from_ref(&thread_id),
        )
        .await
        .expect("begin durable retirement");
        journal.fail_all_persists(true);
        let retry_reached = Arc::new(Notify::new());
        let release_retry = Arc::new(Notify::new());
        *queue
            .retirement_retry_barrier
            .lock()
            .unwrap_or_else(|error| error.into_inner()) =
            Some((retry_reached.clone(), release_retry));
        let cleanup =
            tokio::spawn(async move { retirement.finish_delete(Ok(vec![thread_id])).await });
        timeout(Duration::from_secs(1), retry_reached.notified())
            .await
            .expect("journal clear reaches retry");

        shutdown.cancel();
        let result = timeout(Duration::from_secs(1), cleanup)
            .await
            .expect("shutdown bounds cleanup")
            .expect("cleanup task")
            .unwrap_err();
        assert!(result.contains("bridge shutdown"));
        assert!(!crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json")
        )
        .await
        .unwrap()
        .entries()
        .await
        .is_empty());
        assert_eq!(
            scheduler
                .list(&retirement_test_thread("shutdown"))
                .await
                .len(),
            1
        );
        assert!(BridgeQueueService::load_submission_store(
            &directory.join("queue-idempotency.json")
        )
        .await
        .unwrap()
        .results
        .contains_key("sent-before-delete"));
        scheduler.shutdown().await;
        drop(scheduler);

        let (queue, scheduler, journal) = reload_retirement_services(&directory).await;
        let reconciler = FixedRetirementReconciler::new(RetirementPlanReconciliation::Absent);
        ThreadStateRetirement::recover_pending(
            queue,
            scheduler.clone(),
            journal,
            &reconciler,
            CancellationToken::new(),
        )
        .await
        .expect("next startup clears preserved tombstone");
        assert!(crate::retirement_journal::ThreadRetirementJournal::load(
            directory.join("thread-retirements.json")
        )
        .await
        .unwrap()
        .entries()
        .await
        .is_empty());
        scheduler.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn owned_request_shutdown_aborts_a_permanently_stalled_task_within_its_bound() {
        let tracker = Arc::new(ClientRequestTracker::default());
        tracker.register_client(91);
        let request = tokio::spawn({
            let tracker = tracker.clone();
            async move { tracker.run_owned_with(91, std::future::pending::<()>).await }
        });
        while tracker.active_request_count() == 0 {
            tokio::task::yield_now().await;
        }

        timeout(Duration::from_secs(1), tracker.shutdown_owned_requests())
            .await
            .expect("owned request shutdown is bounded");
        assert!(request.await.unwrap().unwrap().is_err());
        assert_eq!(tracker.active_request_count(), 0);
    }

    #[tokio::test]
    async fn disconnect_after_delete_keeps_retrying_retirement_until_shutdown_can_join_it() {
        let directory = std::env::current_dir()
            .expect("current directory")
            .join("target")
            .join(format!("disconnected-retirement-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("create retirement test directory");
        let receipt_path = directory.join("queue.json");
        let queue = BridgeQueueService::with_submission_store(
            Arc::new(RetirementDispatcher),
            Arc::new(ClientHub::new()),
            Some(receipt_path.clone()),
            crate::queue_service::DurableQueueSubmissions::default(),
        );
        let scheduler = crate::scheduled_prompts::ScheduledPromptService::inert_for_test();
        let thread_id = crate::acp::identity::AgentSessionId::new("agent", "deleted-thread")
            .expect("valid test thread ID")
            .encode();
        queue
            .remember_submission_result(BridgeThreadQueueSendResponse {
                submission_id: "sent-before-delete".to_string(),
                disposition: BridgeThreadQueueDisposition::Sent,
                queue: BridgeQueueService::snapshot_for_thread(&thread_id, None),
                turn_id: Some("turn-before-delete".to_string()),
            })
            .await
            .expect("seed durable receipt");
        queue
            .fail_next_submission_persist
            .store(true, Ordering::Release);
        let retry_reached = Arc::new(Notify::new());
        let release_retry = Arc::new(Notify::new());
        *queue
            .retirement_retry_barrier
            .lock()
            .unwrap_or_else(|error| error.into_inner()) =
            Some((retry_reached.clone(), release_retry.clone()));

        let tracker = Arc::new(ClientRequestTracker::default());
        tracker.register_client(81);
        let deletion_succeeded = Arc::new(Notify::new());
        let request = {
            let tracker = tracker.clone();
            let deletion_succeeded = deletion_succeeded.clone();
            let queue = queue.clone();
            let scheduler = scheduler.clone();
            let thread_id = thread_id.clone();
            tokio::spawn(async move {
                tracker
                    .run_owned_with(81, move || async move {
                        let retirement = ThreadStateRetirement::begin(
                            queue,
                            scheduler,
                            std::slice::from_ref(&thread_id),
                        )
                        .await
                        .expect("begin retirement");
                        deletion_succeeded.notify_one();
                        retirement.finish_delete(Ok(vec![thread_id])).await
                    })
                    .await
            })
        };

        timeout(Duration::from_secs(1), deletion_succeeded.notified())
            .await
            .expect("ACP deletion reaches success before disconnect");
        timeout(Duration::from_secs(1), retry_reached.notified())
            .await
            .expect("cleanup reaches durable retry after ACP deletion");
        tracker.cancel_client(81);
        assert_eq!(
            timeout(Duration::from_secs(1), request)
                .await
                .expect("cancelled request settles")
                .unwrap(),
            Err("client request cancelled")
        );
        assert_eq!(
            tracker.active_request_count(),
            1,
            "the owned delete remains tracked after its client disconnects"
        );

        let shutdown = tokio::spawn({
            let tracker = tracker.clone();
            async move { tracker.shutdown_owned_requests().await }
        });
        tokio::task::yield_now().await;
        assert!(
            !shutdown.is_finished(),
            "runtime shutdown waits for the tracked owned delete"
        );
        assert_eq!(
            queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
            "thread is being deleted"
        );
        assert!(BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .expect("load pre-retry receipt")
            .results
            .contains_key("sent-before-delete"));

        release_retry.notify_one();
        timeout(Duration::from_secs(1), shutdown)
            .await
            .expect("runtime shutdown settles after cleanup")
            .expect("shutdown task");
        assert!(BridgeQueueService::load_submission_store(&receipt_path)
            .await
            .expect("load converged receipt store")
            .results
            .is_empty());
        assert_eq!(
            queue.retirement_fence.admit(&thread_id).await.unwrap_err(),
            "thread is being deleted",
            "converged cleanup leaves a permanent deleted-thread tombstone"
        );
        assert_eq!(tracker.request_count(), 0);
        assert_eq!(tracker.active_request_count(), 0);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn tracker_rejects_capacity_and_completes_after_capacity_is_released() {
        let tracker = ClientRequestTracker::default();
        tracker.register_client(9);
        {
            let mut registry = tracker
                .registry
                .lock()
                .expect("client request registry lock");
            for request_id in 0..MAX_TRACKED_CLIENT_REQUESTS as u64 {
                registry.requests.insert(
                    request_id,
                    ClientRequestOwner {
                        client_id: 9,
                        cancellation: RequestCancellation::default(),
                    },
                );
            }
        }
        assert_eq!(
            tracker.run(9, async { 1 }).await,
            Err("client request tracking capacity reached")
        );

        tracker
            .registry
            .lock()
            .expect("client request registry lock")
            .requests
            .clear();
        assert_eq!(tracker.run(9, async { 2 }).await, Ok(2));
        assert_eq!(tracker.request_count(), 0);

        tracker.cancel_client(9);
        tracker.cancel_client(999);
        assert_eq!(
            tracker.run(9, async { 3 }).await,
            Err("client disconnected")
        );
    }

    #[tokio::test]
    async fn disconnect_is_owner_scoped_and_completion_races_cleanup_once() {
        let tracker = Arc::new(ClientRequestTracker::default());
        tracker.register_client(1);
        tracker.register_client(2);
        let (one_tx, one_rx) = oneshot::channel::<u8>();
        let (two_tx, two_rx) = oneshot::channel::<u8>();
        let one = {
            let tracker = tracker.clone();
            tokio::spawn(async move { tracker.run(1, one_rx).await })
        };
        let two = {
            let tracker = tracker.clone();
            tokio::spawn(async move { tracker.run(2, two_rx).await })
        };
        while tracker.request_count() != 2 {
            tokio::task::yield_now().await;
        }
        tracker.cancel_client(1);
        two_tx.send(2).unwrap();
        assert_eq!(one.await.unwrap(), Err("client request cancelled"));
        assert_eq!(two.await.unwrap().unwrap().unwrap(), 2);
        drop(one_tx);
        assert_eq!(tracker.request_count(), 0);

        for client_id in 10..110 {
            tracker.register_client(client_id);
            let (complete_tx, complete_rx) = oneshot::channel::<()>();
            let request = {
                let tracker = tracker.clone();
                tokio::spawn(async move { tracker.run(client_id, complete_rx).await })
            };
            while tracker.request_count() != 1 {
                tokio::task::yield_now().await;
            }
            let _ = complete_tx.send(());
            tracker.cancel_client(client_id);
            let result = request.await.unwrap();
            assert!(matches!(
                result,
                Ok(Ok(())) | Err("client request cancelled")
            ));
            assert_eq!(tracker.request_count(), 0);
        }
    }

    #[tokio::test]
    async fn retirement_rejects_a_deleted_family_outside_its_prepared_scope() {
        let thread_id = retirement_test_thread("prepared");
        let other_thread_id = retirement_test_thread("unexpected");
        let queue =
            BridgeQueueService::new(Arc::new(RetirementDispatcher), Arc::new(ClientHub::new()));
        let scheduler = crate::scheduled_prompts::ScheduledPromptService::inert_for_test();
        let journal =
            Arc::new(crate::retirement_journal::ThreadRetirementJournal::inert_for_test());
        let retirement = ThreadStateRetirement::begin_with_journal(
            queue.clone(),
            scheduler,
            journal.clone(),
            CancellationToken::new(),
            std::slice::from_ref(&thread_id),
        )
        .await
        .unwrap();

        assert_eq!(
            retirement
                .finish_delete(Ok(vec![other_thread_id]))
                .await
                .unwrap_err(),
            "ACP deletion returned a family different from its prepared scope"
        );
        assert_eq!(journal.entries().await.len(), 1);
        drop(queue.retirement_fence.admit(&thread_id).await.unwrap());
    }

    #[tokio::test]
    async fn bounded_retirement_retries_cover_limits_and_shutdown_interruption() {
        let thread_id = retirement_test_thread("bounded-retries");
        let queue =
            BridgeQueueService::new(Arc::new(RetirementDispatcher), Arc::new(ClientHub::new()));
        let scheduler = crate::scheduled_prompts::ScheduledPromptService::inert_for_test();
        let journal =
            Arc::new(crate::retirement_journal::ThreadRetirementJournal::inert_for_test());
        let retirement_id = journal
            .add_prepared(std::slice::from_ref(&thread_id))
            .await
            .unwrap();

        journal.fail_all_persists(true);
        assert!(ThreadStateRetirement::mark_journal_deleted_until_converged(
            &queue,
            &journal,
            &retirement_id,
            std::slice::from_ref(&thread_id),
            &CancellationToken::new(),
            Some(1),
        )
        .await
        .unwrap_err()
        .contains("did not converge after 1 attempts"));
        journal.fail_all_persists(false);

        let queue_retirement = queue
            .begin_thread_retirement(std::slice::from_ref(&thread_id))
            .await
            .unwrap();
        queue
            .fail_next_submission_persist
            .store(true, Ordering::Release);
        assert!(ThreadStateRetirement::commit_queue_until_converged(
            &queue,
            &queue_retirement,
            &CancellationToken::new(),
            Some(1),
        )
        .await
        .unwrap_err()
        .contains("did not converge after 1 attempts"));

        let shutdown = CancellationToken::new();
        shutdown.cancel();
        queue
            .fail_next_submission_persist
            .store(true, Ordering::Release);
        assert_eq!(
            ThreadStateRetirement::commit_queue_until_converged(
                &queue,
                &queue_retirement,
                &shutdown,
                None,
            )
            .await
            .unwrap_err(),
            "thread retirement interrupted by bridge shutdown"
        );

        journal.fail_all_removes(true);
        assert_eq!(
            ThreadStateRetirement::clear_journal_until_converged(
                &queue,
                &journal,
                std::slice::from_ref(&retirement_id),
                &shutdown,
                None,
            )
            .await
            .unwrap_err(),
            "thread retirement interrupted by bridge shutdown"
        );
        journal.fail_all_removes(false);

        let partial = ThreadStateRetirementTransaction {
            thread_ids: vec![thread_id],
            queue,
            scheduler,
            queue_retirement: None,
            scheduler_retirement: None,
            fence: None,
            journal,
            journal_retirement_ids: vec![retirement_id],
            shutdown,
            max_commit_attempts: None,
        };
        ThreadStateRetirement::release_transaction_preserving_journal(partial).await;
    }
}
