use crate::*;

#[derive(Clone)]
pub(super) struct AppState {
    pub(super) config: Arc<BridgeConfig>,
    pub(super) path_policy: Arc<PathPolicy>,
    pub(super) started_at: Instant,
    pub(super) hub: Arc<ClientHub>,
    pub(super) backend: Arc<RuntimeBackend>,
    pub(super) queue: Arc<BridgeQueueService>,
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
}

impl AppState {
    pub(super) async fn persist_operation_dedupe(&self) -> Result<(), BridgeError> {
        let state = self.operation_dedupe.lock().await;
        self.persist_operation_dedupe_locked(&state).await
    }

    pub(super) async fn update_operation_dedupe<T>(
        &self,
        mutate: impl FnOnce(&mut DurableOperationDedupe) -> T,
    ) -> Result<T, BridgeError> {
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
                Err(BridgeError::server(&format!(
                    "failed to persist request idempotency: {error}"
                )))
            }
        }
    }

    pub(super) fn bridge_capabilities(&self) -> BridgeCapabilities {
        let mut capabilities = self.backend.capabilities(self.hub.stream_id());
        capabilities.ag_ui_events = true;
        capabilities.supports.browser_preview = self.preview.is_available();
        capabilities.supports.generic_ui_surface = true;
        for supports in capabilities.supports_by_agent.values_mut() {
            supports.browser_preview = capabilities.supports.browser_preview;
            supports.generic_ui_surface = true;
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
        let request_metrics = self.metrics.request_snapshot();
        let in_flight_requests = manager_other
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
                    "operation idempotency state exceeds {OPERATION_DEDUPE_MAX_BYTES} bytes"
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
            "failed to read operation idempotency state: {error}"
        )),
    }
}

fn trim_dedupe<T>(results: &mut HashMap<String, T>, order: &mut VecDeque<String>, limit: usize) {
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

fn trim_pending_map<T>(
    pending: &mut HashMap<String, T>,
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
mod tests {
    use super::*;
    use crate::acp::manager::{AgentCapabilities, AgentDescriptor, AgentLifecycle};

    fn descriptor(
        lifecycle: AgentLifecycle,
        session_steer: bool,
        session_fork: bool,
        session_delete: bool,
    ) -> AgentDescriptor {
        AgentDescriptor {
            agent_id: "agent".to_string(),
            display_name: "Agent".to_string(),
            icon: None,
            version: "1.0.0".to_string(),
            provenance: "test".to_string(),
            lifecycle,
            last_error: None,
            capabilities: Some(AgentCapabilities {
                session_list: true,
                session_load: true,
                session_resume: true,
                session_steer,
                session_fork,
                session_delete,
            }),
        }
    }

    #[test]
    fn thread_delete_support_follows_the_agent_capability_and_readiness() {
        assert!(
            BridgeCapabilitySupport::from_agent(&descriptor(
                AgentLifecycle::Ready,
                false,
                false,
                true
            ))
            .thread_delete
        );
        assert!(
            !BridgeCapabilitySupport::from_agent(&descriptor(
                AgentLifecycle::Ready,
                false,
                false,
                false
            ))
            .thread_delete
        );
        assert!(
            !BridgeCapabilitySupport::from_agent(&descriptor(
                AgentLifecycle::Unavailable,
                false,
                false,
                true
            ))
            .thread_delete
        );

        let mut unknown = descriptor(AgentLifecycle::Ready, false, false, true);
        unknown.capabilities = None;
        assert!(!BridgeCapabilitySupport::from_agent(&unknown).thread_delete);
    }

    #[test]
    fn thread_fork_support_follows_the_agent_capability_and_readiness() {
        assert!(
            BridgeCapabilitySupport::from_agent(&descriptor(
                AgentLifecycle::Ready,
                false,
                true,
                false
            ))
            .thread_fork
        );
        assert!(
            !BridgeCapabilitySupport::from_agent(&descriptor(
                AgentLifecycle::Unavailable,
                false,
                true,
                false
            ))
            .thread_fork
        );
    }

    #[test]
    fn contract_capability_cases_project_through_bridge_support() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../../contracts/bridge-rpc/v2/manifest.json"
        ))
        .expect("contract fixture");
        let cases = manifest["fixtures"]["capabilityCases"]
            .as_array()
            .expect("capability cases");
        for case in cases {
            let capabilities = &case["agentCapabilities"];
            let agent = descriptor(
                AgentLifecycle::Ready,
                capabilities["sessionSteer"].as_bool().unwrap_or(false),
                capabilities["sessionFork"].as_bool().unwrap_or(false),
                capabilities["sessionDelete"].as_bool().unwrap_or(false),
            );
            let supports = BridgeCapabilitySupport::from_agent(&agent);
            assert_eq!(
                supports.turn_steer,
                case["supportsByAgent"]["turnSteer"]
                    .as_bool()
                    .unwrap_or(false)
            );
            assert_eq!(
                supports.thread_fork,
                case["supportsByAgent"]["threadFork"]
                    .as_bool()
                    .unwrap_or(false)
            );
            assert_eq!(
                supports.thread_delete,
                case["supportsByAgent"]["threadDelete"]
                    .as_bool()
                    .unwrap_or(false)
            );
        }
    }

    #[tokio::test]
    async fn operation_idempotency_survives_a_worker_restart() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-operation-dedupe-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("operations.json");
        let mut state = DurableOperationDedupe::default();
        state.thread_create_results.insert(
            "submission-1".to_string(),
            BridgeThreadCreateResponse {
                submission_id: "submission-1".to_string(),
                thread: serde_json::json!({"id": "thread-1"}),
            },
        );
        state
            .thread_create_order
            .push_back("submission-1".to_string());
        state
            .thread_create_pending
            .insert("submission-indeterminate".to_string());

        persist_operation_dedupe(&path, &state).await.unwrap();
        let restored = load_operation_dedupe(&path).await.unwrap();
        assert_eq!(
            restored.thread_create_results["submission-1"].thread["id"],
            "thread-1"
        );
        assert_eq!(
            restored.thread_create_order,
            VecDeque::from(["submission-1".to_string()])
        );
        assert!(restored
            .thread_create_pending
            .contains("submission-indeterminate"));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn definitive_operation_failures_release_their_idempotency_keys() {
        let mut state = DurableOperationDedupe::default();
        state.reserve_thread_create("create".to_string());
        state.reserve_thread_fork(
            "fork".to_string(),
            PendingForkOperation {
                source_thread_id: "source".to_string(),
                message_id: "message".to_string(),
            },
        );
        state.reserve_approval_resolution(
            "approval".to_string(),
            PendingApprovalOperation {
                request_id: "request".to_string(),
                decision: "accept".to_string(),
            },
        );

        state.release_thread_create("create");
        state.release_thread_fork("fork");
        state.release_approval_resolution("approval");

        assert!(state.thread_create_pending.is_empty());
        assert!(state.thread_create_pending_order.is_empty());
        assert!(state.thread_fork_pending.is_empty());
        assert!(state.thread_fork_pending_order.is_empty());
        assert!(state.approval_resolution_pending.is_empty());
        assert!(state.approval_resolution_pending_order.is_empty());
    }

    #[tokio::test]
    async fn operation_idempotency_load_rejects_invalid_files_and_bounds_pending_state() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-operation-dedupe-bounds-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("operations.json");

        assert!(load_operation_dedupe(&path)
            .await
            .unwrap()
            .thread_create_pending
            .is_empty());
        assert!(load_operation_dedupe(&directory)
            .await
            .unwrap_err()
            .contains("failed to read"));
        std::fs::write(&path, b"{").unwrap();
        assert!(load_operation_dedupe(&path)
            .await
            .unwrap_err()
            .contains("invalid"));
        std::fs::write(&path, vec![b'x'; OPERATION_DEDUPE_MAX_BYTES + 1]).unwrap();
        assert!(load_operation_dedupe(&path)
            .await
            .unwrap_err()
            .contains("exceeds"));

        let mut state = DurableOperationDedupe::default();
        for index in 0..=SUBMISSION_DEDUPE_LIMIT {
            let create_id = format!("create-{index:05}");
            state.thread_create_results.insert(
                create_id.clone(),
                BridgeThreadCreateResponse {
                    submission_id: create_id.clone(),
                    thread: json!({"id": format!("thread-{index}")}),
                },
            );
            state.thread_create_order.push_back(create_id.clone());
            state.thread_create_pending.insert(create_id);
            let fork_id = format!("fork-{index:05}");
            state.thread_fork_results.insert(
                fork_id.clone(),
                BridgeThreadForkCacheEntry {
                    source_thread_id: "source".to_string(),
                    message_id: "message".to_string(),
                    response: BridgeThreadForkResponse {
                        submission_id: fork_id.clone(),
                        thread: json!({"id": format!("forked-{index}")}),
                    },
                },
            );
            state.thread_fork_order.push_back(fork_id.clone());
            state.thread_fork_pending.insert(
                fork_id,
                PendingForkOperation {
                    source_thread_id: "source".to_string(),
                    message_id: "message".to_string(),
                },
            );
            let approval_id = format!("approval-{index:05}");
            state
                .approval_resolution_results
                .insert(approval_id.clone(), json!({"ok": true}));
            state
                .approval_resolution_order
                .push_back(approval_id.clone());
            state.approval_resolution_pending.insert(
                approval_id,
                PendingApprovalOperation {
                    request_id: "request".to_string(),
                    decision: "accept".to_string(),
                },
            );
        }
        std::fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
        let bounded = load_operation_dedupe(&path).await.unwrap();
        assert_eq!(bounded.thread_create_pending.len(), SUBMISSION_DEDUPE_LIMIT);
        assert_eq!(bounded.thread_create_results.len(), SUBMISSION_DEDUPE_LIMIT);
        assert_eq!(bounded.thread_fork_pending.len(), SUBMISSION_DEDUPE_LIMIT);
        assert_eq!(bounded.thread_fork_results.len(), SUBMISSION_DEDUPE_LIMIT);
        assert_eq!(
            bounded.approval_resolution_pending.len(),
            APPROVAL_RESOLUTION_DEDUPE_LIMIT
        );
        assert_eq!(
            bounded.approval_resolution_results.len(),
            APPROVAL_RESOLUTION_DEDUPE_LIMIT
        );
        assert!(!bounded.thread_create_pending.contains("create-00000"));
        assert!(!bounded.thread_fork_pending.contains_key("fork-00000"));
        assert!(!bounded
            .approval_resolution_pending
            .contains_key("approval-00000"));
        let mut bounded = bounded;
        bounded.reserve_thread_create("create-00001".to_string());
        bounded.reserve_thread_fork(
            "fork-00001".to_string(),
            PendingForkOperation {
                source_thread_id: "source".to_string(),
                message_id: "message".to_string(),
            },
        );
        bounded.reserve_approval_resolution(
            "approval-00001".to_string(),
            PendingApprovalOperation {
                request_id: "request".to_string(),
                decision: "accept".to_string(),
            },
        );

        state.thread_create_pending.clear();
        state.thread_fork_pending.clear();
        state.approval_resolution_pending.clear();
        state.thread_fork_pending.insert(
            "oversized".to_string(),
            PendingForkOperation {
                source_thread_id: "source".to_string(),
                message_id: "x".repeat(OPERATION_DEDUPE_MAX_BYTES),
            },
        );
        assert!(persist_operation_dedupe(&path, &state)
            .await
            .unwrap_err()
            .to_string()
            .contains("exceeds"));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn client_metadata_sanitization_handles_missing_control_only_and_bounded_values() {
        assert_eq!(sanitize_client_metadata(None, "fallback", 8), "fallback");
        assert_eq!(
            sanitize_client_metadata(Some("\0\n"), "fallback", 8),
            "fallback"
        );
        assert_eq!(
            sanitize_client_metadata(Some("  device-name  "), "fallback", 6),
            "device"
        );
    }

    #[tokio::test]
    async fn operation_idempotency_compacts_each_completed_result_class() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-operation-dedupe-compact-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("operations.json");
        let payload = "x".repeat(9 * 1024 * 1024);
        let mut state = DurableOperationDedupe::default();
        state.thread_create_results.insert(
            "create".to_string(),
            BridgeThreadCreateResponse {
                submission_id: "create".to_string(),
                thread: json!(payload),
            },
        );
        state.thread_create_order.push_back("create".to_string());
        state.thread_fork_results.insert(
            "fork".to_string(),
            BridgeThreadForkCacheEntry {
                source_thread_id: "source".to_string(),
                message_id: "message".to_string(),
                response: BridgeThreadForkResponse {
                    submission_id: "fork".to_string(),
                    thread: json!("x".repeat(9 * 1024 * 1024)),
                },
            },
        );
        state.thread_fork_order.push_back("fork".to_string());
        state
            .approval_resolution_results
            .insert("approval".to_string(), json!("x".repeat(9 * 1024 * 1024)));
        state
            .approval_resolution_order
            .push_back("approval".to_string());
        persist_operation_dedupe(&path, &state).await.unwrap();
        let compacted = load_operation_dedupe(&path).await.unwrap();
        assert!(compacted.thread_create_results.is_empty());
        assert!(compacted.thread_fork_results.is_empty());
        assert!(compacted
            .approval_resolution_results
            .contains_key("approval"));

        let mut approval_only = DurableOperationDedupe::default();
        approval_only.approval_resolution_results.insert(
            "approval".to_string(),
            json!("x".repeat(OPERATION_DEDUPE_MAX_BYTES)),
        );
        approval_only
            .approval_resolution_order
            .push_back("approval".to_string());
        persist_operation_dedupe(&path, &approval_only)
            .await
            .unwrap();
        assert!(load_operation_dedupe(&path)
            .await
            .unwrap()
            .approval_resolution_results
            .is_empty());

        let mut results = HashMap::from([
            ("first".to_string(), 1),
            ("second".to_string(), 2),
            ("orphan".to_string(), 3),
        ]);
        let mut order = VecDeque::from(["first".to_string(), "second".to_string()]);
        trim_dedupe(&mut results, &mut order, 1);
        assert_eq!(order, VecDeque::from(["second".to_string()]));
        assert_eq!(results, HashMap::from([("second".to_string(), 2)]));
        let _ = std::fs::remove_dir_all(directory);
    }
}
