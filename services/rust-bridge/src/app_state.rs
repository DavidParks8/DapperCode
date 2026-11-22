#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::wildcard_imports,
        reason = "flat sibling modules split from main.rs share crate-root symbols"
    )
)]
use crate::*;

#[derive(Clone)]
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
pub(super) struct AppState {
    pub(super) config: Arc<BridgeConfig>,
    pub(super) path_policy: Arc<PathPolicy>,
    pub(super) started_at: Instant,
    pub(super) hub: Arc<ClientHub>,
    pub(super) backend: Arc<RuntimeBackend>,
    pub(super) queue: Arc<BridgeQueueService>,
    pub(super) scheduler: Arc<crate::scheduled_prompts::ScheduledPromptService>,
    pub(super) phone_calls: Arc<crate::phone_call::PhoneCallService>,
    pub(super) operation_dedupe: Arc<Mutex<DurableOperationDedupe>>,
    pub(super) thread_create_actor: Arc<Mutex<()>>,
    pub(super) thread_fork_actor: Arc<Mutex<()>>,
    pub(super) approval_resolution_actor: Arc<Mutex<()>>,
    pub(super) operation_dedupe_path: std::path::PathBuf,
    pub(super) operation_dedupe_dirty: Arc<std::sync::atomic::AtomicBool>,
    pub(super) thread_list_streams: Arc<Mutex<HashMap<String, Arc<ThreadListStreamCancellation>>>>,
    pub(super) git: Arc<GitService>,
    pub(super) preview: Arc<BrowserPreviewService>,
    pub(super) push: Arc<PushService>,
    pub(super) ws_global_in_flight: Arc<Semaphore>,
    pub(super) metrics: Arc<OperationalMetrics>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
pub(super) struct DurableOperationDedupe {
    #[serde(default)]
    pub(super) thread_create_results: HashMap<String, BridgeThreadCreateResponse>,
    #[serde(default)]
    pub(super) thread_create_order: VecDeque<String>,
    #[serde(default)]
    pub(super) thread_create_pending: HashSet<String>,
    #[serde(default)]
    pub(super) thread_create_pending_order: VecDeque<String>,
    #[serde(default)]
    pub(super) thread_fork_results: HashMap<String, BridgeThreadForkCacheEntry>,
    #[serde(default)]
    pub(super) thread_fork_order: VecDeque<String>,
    #[serde(default)]
    pub(super) thread_fork_pending: HashMap<String, PendingForkOperation>,
    #[serde(default)]
    pub(super) thread_fork_pending_order: VecDeque<String>,
    #[serde(default)]
    pub(super) approval_resolution_results: HashMap<String, Value>,
    #[serde(default)]
    pub(super) approval_resolution_order: VecDeque<String>,
    #[serde(default)]
    pub(super) approval_resolution_pending: HashMap<String, PendingApprovalOperation>,
    #[serde(default)]
    pub(super) approval_resolution_pending_order: VecDeque<String>,
}

impl DurableOperationDedupe {
    pub(super) fn reserve_thread_create(&mut self, submission_id: String) {
        if self.thread_create_pending.insert(submission_id.clone()) {
            self.thread_create_pending_order.push_back(submission_id);
        }
        trim_pending_set(
            &mut self.thread_create_pending,
            &mut self.thread_create_pending_order,
            SUBMISSION_DEDUPE_LIMIT,
        );
    }

    pub(super) fn release_thread_create(&mut self, submission_id: &str) {
        self.thread_create_pending.remove(submission_id);
        self.thread_create_pending_order
            .retain(|candidate| candidate != submission_id);
    }

    pub(super) fn reserve_thread_fork(
        &mut self,
        submission_id: String,
        operation: PendingForkOperation,
    ) {
        if self
            .thread_fork_pending
            .insert(submission_id.clone(), operation)
            .is_none()
        {
            self.thread_fork_pending_order.push_back(submission_id);
        }
        trim_pending_map(
            &mut self.thread_fork_pending,
            &mut self.thread_fork_pending_order,
            SUBMISSION_DEDUPE_LIMIT,
        );
    }

    pub(super) fn release_thread_fork(&mut self, submission_id: &str) {
        self.thread_fork_pending.remove(submission_id);
        self.thread_fork_pending_order
            .retain(|candidate| candidate != submission_id);
    }

    pub(super) fn reserve_approval_resolution(
        &mut self,
        resolution_id: String,
        operation: PendingApprovalOperation,
    ) {
        if self
            .approval_resolution_pending
            .insert(resolution_id.clone(), operation)
            .is_none()
        {
            self.approval_resolution_pending_order
                .push_back(resolution_id);
        }
        trim_pending_map(
            &mut self.approval_resolution_pending,
            &mut self.approval_resolution_pending_order,
            APPROVAL_RESOLUTION_DEDUPE_LIMIT,
        );
    }

    pub(super) fn release_approval_resolution(&mut self, resolution_id: &str) {
        self.approval_resolution_pending.remove(resolution_id);
        self.approval_resolution_pending_order
            .retain(|candidate| candidate != resolution_id);
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingForkOperation {
    pub(super) source_thread_id: String,
    pub(super) message_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingApprovalOperation {
    pub(super) request_id: String,
    pub(super) decision: String,
}

const OPERATION_DEDUPE_MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeCapabilities {
    pub(super) protocol_version: u32,
    pub(super) stream_id: String,
    pub(super) preferred_agent_id: String,
    pub(super) active_agent_id: Option<String>,
    pub(super) agents: Vec<crate::acp::manager::AgentDescriptor>,
    pub(super) ag_ui_events: bool,
    pub(super) supports: BridgeCapabilitySupport,
    pub(super) supports_by_agent: HashMap<String, BridgeCapabilitySupport>,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
pub(super) struct BridgeCapabilitySupport {
    pub(super) review_start: bool,
    pub(super) compact_start: bool,
    pub(super) goal_slash: bool,
    pub(super) plan_mode: bool,
    pub(super) agent_list: bool,
    pub(super) turn_steer: bool,
    pub(super) thread_fork: bool,
    pub(super) thread_delete: bool,
    pub(super) command_output_delta: bool,
    pub(super) fast_mode: bool,
    pub(super) account: bool,
    pub(super) account_rate_limits: bool,
    pub(super) browser_preview: bool,
    pub(super) generic_ui_surface: bool,
    pub(super) phone_calls: bool,
}

impl AppState {
    pub(super) async fn persist_operation_dedupe(&self) -> Result<(), BridgeError> {
        let state = self.operation_dedupe.lock().await;
        self.persist_operation_dedupe_locked(&state).await
    }

    pub(super) async fn update_operation_dedupe<Outcome>(
        &self,
        mutate: impl FnOnce(&mut DurableOperationDedupe) -> Outcome,
    ) -> Result<Outcome, BridgeError> {
        let mut state = self.operation_dedupe.lock().await;
        let previous = state.clone();
        let result = mutate(&mut state);
        if let Err(error) = self.persist_operation_dedupe_locked(&state).await {
            *state = previous;
            let _ = self.persist_operation_dedupe_locked(&state).await;
            return Err(error);
        }
        Ok(result)
    }

    async fn persist_operation_dedupe_locked(
        &self,
        state: &DurableOperationDedupe,
    ) -> Result<(), BridgeError> {
        match persist_operation_dedupe(&self.operation_dedupe_path, state).await {
            Ok(()) => {
                self.operation_dedupe_dirty
                    .store(false, std::sync::atomic::Ordering::Release);
                Ok(())
            }
            Err(error) => {
                self.operation_dedupe_dirty
                    .store(true, std::sync::atomic::Ordering::Release);
                Err(BridgeError::server(format!(
                    "failed to persist request idempotency: {error}",
                )))
            }
        }
    }

    pub(super) fn bridge_capabilities(&self) -> BridgeCapabilities {
        let mut capabilities = self.backend.capabilities(self.hub.stream_id());
        capabilities.ag_ui_events = true;
        capabilities.supports.browser_preview = self.preview.is_available();
        capabilities.supports.generic_ui_surface = true;
        capabilities.supports.phone_calls = self.phone_calls.is_configured();
        for supports in capabilities.supports_by_agent.values_mut() {
            supports.browser_preview = capabilities.supports.browser_preview;
            supports.generic_ui_surface = true;
            supports.phone_calls = capabilities.supports.phone_calls;
        }

        capabilities
    }

    pub(super) async fn bridge_status(&self) -> BridgeStatus {
        if self
            .operation_dedupe_dirty
            .load(std::sync::atomic::Ordering::Acquire)
        {
            let _ = self.persist_operation_dedupe().await;
        }
        let devices = crate::health::user_device_connections(self.hub.client_connections().await);
        let agents = self.backend.capabilities(self.hub.stream_id()).agents;
        let queue = self.queue.status().await;
        let (manager_active_runs, manager_approvals, manager_inputs, manager_other) =
            self.backend.runtime_activity().await;
        let active_preview_sessions = self.preview.active_session_count().await;
        let scheduled_prompts = self.scheduler.pending_count().await;
        let request_metrics = self.metrics.request_snapshot();
        let in_flight_requests = manager_other
            .saturating_add(scheduled_prompts)
            .saturating_add(self.phone_calls.live_work_count())
            .saturating_add(usize::try_from(request_metrics.pending).unwrap_or(usize::MAX))
            .saturating_add(self.push.pending_delivery_count())
            .saturating_add(usize::from(
                self.operation_dedupe_dirty
                    .load(std::sync::atomic::Ordering::Acquire),
            ));
        let runtime = runtime_activity(
            devices.len(),
            &queue,
            manager_active_runs,
            manager_approvals,
            manager_inputs,
            in_flight_requests,
            active_preview_sessions,
        );
        let operational = BridgeOperationalStatus {
            requests: request_metrics,
            replay: self.hub.replay_status().await,
            queue,
            push: self.metrics.push_snapshot(),
            recent_errors: self.metrics.recent_errors(),
        };
        bridge_status(self.started_at, devices, agents, runtime, operational)
    }
}

pub(super) async fn load_operation_dedupe(
    path: &std::path::Path,
) -> Result<DurableOperationDedupe, String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            if bytes.len() > OPERATION_DEDUPE_MAX_BYTES {
                return Err(format!(
                    "operation idempotency state exceeds {OPERATION_DEDUPE_MAX_BYTES} bytes",
                ));
            }
            let mut state: DurableOperationDedupe = serde_json::from_slice(&bytes)
                .map_err(|error| format!("invalid operation idempotency state: {error}"))?;
            trim_dedupe(
                &mut state.thread_create_results,
                &mut state.thread_create_order,
                SUBMISSION_DEDUPE_LIMIT,
            );
            trim_dedupe(
                &mut state.thread_fork_results,
                &mut state.thread_fork_order,
                SUBMISSION_DEDUPE_LIMIT,
            );
            trim_dedupe(
                &mut state.approval_resolution_results,
                &mut state.approval_resolution_order,
                APPROVAL_RESOLUTION_DEDUPE_LIMIT,
            );
            trim_pending_set(
                &mut state.thread_create_pending,
                &mut state.thread_create_pending_order,
                SUBMISSION_DEDUPE_LIMIT,
            );
            trim_pending_map(
                &mut state.thread_fork_pending,
                &mut state.thread_fork_pending_order,
                SUBMISSION_DEDUPE_LIMIT,
            );
            trim_pending_map(
                &mut state.approval_resolution_pending,
                &mut state.approval_resolution_pending_order,
                APPROVAL_RESOLUTION_DEDUPE_LIMIT,
            );
            Ok(state)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(DurableOperationDedupe::default())
        }
        Err(error) => Err(format!(
            "failed to read operation idempotency state: {error}",
        )),
    }
}

fn trim_dedupe<Entry>(
    results: &mut HashMap<String, Entry>,
    order: &mut VecDeque<String>,
    limit: usize,
) {
    while order.len() > limit {
        if let Some(oldest) = order.pop_front() {
            results.remove(&oldest);
        }
    }
    let retained = order.iter().cloned().collect::<HashSet<_>>();
    results.retain(|key, _| retained.contains(key));
}

fn trim_pending_set(pending: &mut HashSet<String>, order: &mut VecDeque<String>, limit: usize) {
    order.retain(|submission_id| pending.contains(submission_id));
    let ordered = order.iter().cloned().collect::<HashSet<_>>();
    let mut missing = pending
        .iter()
        .filter(|submission_id| !ordered.contains(*submission_id))
        .cloned()
        .collect::<Vec<_>>();
    missing.sort();
    order.extend(missing);
    while order.len() > limit {
        if let Some(oldest) = order.pop_front() {
            pending.remove(&oldest);
        }
    }
}

fn trim_pending_map<Entry>(
    pending: &mut HashMap<String, Entry>,
    order: &mut VecDeque<String>,
    limit: usize,
) {
    order.retain(|submission_id| pending.contains_key(submission_id));
    let ordered = order.iter().cloned().collect::<HashSet<_>>();
    let mut missing = pending
        .keys()
        .filter(|submission_id| !ordered.contains(*submission_id))
        .cloned()
        .collect::<Vec<_>>();
    missing.sort();
    order.extend(missing);
    while order.len() > limit {
        if let Some(oldest) = order.pop_front() {
            pending.remove(&oldest);
        }
    }
}

async fn persist_operation_dedupe(
    path: &std::path::Path,
    state: &DurableOperationDedupe,
) -> std::io::Result<()> {
    let mut compact = state.clone();
    let mut pending_only = compact.clone();
    pending_only.thread_create_results.clear();
    pending_only.thread_create_order.clear();
    pending_only.thread_fork_results.clear();
    pending_only.thread_fork_order.clear();
    pending_only.approval_resolution_results.clear();
    pending_only.approval_resolution_order.clear();
    if serde_json::to_vec(&pending_only)
        .map_err(std::io::Error::other)?
        .len()
        > OPERATION_DEDUPE_MAX_BYTES
    {
        return Err(std::io::Error::other(
            "pending operation idempotency state exceeds its byte budget",
        ));
    }
    let bytes = loop {
        let bytes = serde_json::to_vec(&compact).map_err(std::io::Error::other)?;
        if bytes.len() <= OPERATION_DEDUPE_MAX_BYTES {
            break bytes;
        }
        let result_count = compact.thread_create_order.len()
            + compact.thread_fork_order.len()
            + compact.approval_resolution_order.len();
        if result_count == 0 {
            return Err(std::io::Error::other(
                "pending operation idempotency state exceeds its byte budget",
            ));
        }
        let batch_size = result_count
            .saturating_mul(bytes.len() - OPERATION_DEDUPE_MAX_BYTES)
            .div_ceil(bytes.len())
            .max(1);
        for _ in 0..batch_size {
            if let Some(oldest) = compact.thread_create_order.pop_front() {
                compact.thread_create_results.remove(&oldest);
            } else if let Some(oldest) = compact.thread_fork_order.pop_front() {
                compact.thread_fork_results.remove(&oldest);
            } else if let Some(oldest) = compact.approval_resolution_order.pop_front() {
                compact.approval_resolution_results.remove(&oldest);
            } else {
                break;
            }
        }
    };
    crate::storage::atomic_write_private(path, &bytes).await
}

impl BridgeCapabilitySupport {
    pub(super) fn from_agent(agent: &crate::acp::manager::AgentDescriptor) -> Self {
        let ready = agent.lifecycle == crate::acp::manager::AgentLifecycle::Ready;
        let thread_fork = ready
            && agent
                .capabilities
                .as_ref()
                .is_some_and(|capabilities| capabilities.session_fork);
        Self {
            turn_steer: ready
                && agent
                    .capabilities
                    .as_ref()
                    .is_some_and(|capabilities| capabilities.session_steer),
            thread_fork,
            thread_delete: ready
                && agent
                    .capabilities
                    .as_ref()
                    .is_some_and(|capabilities| capabilities.session_delete),
            generic_ui_surface: ready,
            ..Self::default()
        }
    }
}

pub(super) fn sanitize_client_metadata(
    value: Option<&str>,
    fallback: &str,
    max_chars: usize,
) -> String {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return fallback.to_string();
    };

    let sanitized = value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string();

    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "app_state_tests.rs"]
mod tests;
