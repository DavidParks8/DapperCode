use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex as StdMutex,
    },
};

use agent_client_protocol::schema::v1::{
    ContentBlock, ElicitationContentValue, NewSessionRequest, ResourceLink,
    SessionConfigOptionValue,
};
use futures_util::future::BoxFuture;

use crate::acp::interactions::ElicitationFieldKind;
use crate::acp::manager::{AgentLifecycle, AgentManager, LocalAgentManifestSet, ManagedSession};
use crate::acp::runtime::RequestCancellation;
use crate::*;

pub(super) struct RuntimeBackend {
    manager: Arc<AgentManager>,
    hub: Arc<ClientHub>,
    event_pump: Mutex<Option<tokio::task::JoinHandle<()>>>,
    client_requests: ClientRequestTracker,
}

const MAX_TRACKED_CLIENT_REQUESTS: usize = 4096;

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
        for child in manager.opencode_child_sessions(&parent_thread_id).await {
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
        let selected = candidates
            .iter()
            .find(|(child, _)| child_matches_tool_title(child.title.as_deref(), &tool.title))
            .or_else(|| candidates.first().filter(|_| candidates.len() == 1));
        let Some((selected, child_thread)) = selected else {
            continue;
        };
        if let Ok(mut state) = in_flight.lock() {
            if state.claimed.len() >= MAX_CLAIMED_SUBAGENTS {
                state.claimed.clear();
            }
            state.claimed.insert(child_thread.clone());
        }
        let adopted = adopt_subagent_session(
            &manager,
            &hub,
            AdoptedSubagent {
                parent_thread_id: &parent_thread_id,
                child_session_id: &selected.acp_session_id,
                child_title: selected.title.as_deref(),
                tool_call_id: &tool_call_id,
                link: true,
            },
        )
        .await;
        if let (Some(child_thread), Some(parent_run_id)) =
            (adopted, parent.snapshot.active_run_id.as_deref())
        {
            hub.link_subagent(
                &parent_thread_id,
                parent_run_id,
                parent.snapshot.active_source_turn_id.clone(),
                &tool_call_id,
                &child_thread,
            )
            .await;
        }
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

struct AdoptedSubagent<'a> {
    parent_thread_id: &'a str,
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

#[derive(Default)]
struct ClientRequestTracker {
    registry: Arc<StdMutex<ClientRequestRegistry>>,
    next_request_id: AtomicU64,
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

impl ClientRequestTracker {
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
        tokio::pin!(future);
        let result = tokio::select! {
            result = &mut future => Some(result),
            _ = cancellation.cancelled() => None,
        };
        drop(request_guard);
        if cancellation.is_cancelled() || result.is_none() {
            return Err("client request cancelled");
        }
        Ok(result.expect("completed client request result"))
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
    fn prepare_steer<'a>(&'a self, thread_id: &'a str) -> BoxFuture<'a, Result<u64, String>>;
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
    fn turn_start<'a>(
        &'a self,
        thread_id: &'a str,
        turn_start: &'a Value,
    ) -> BoxFuture<'a, Result<String, String>>;
}

impl RuntimeBackend {
    pub(super) async fn start(
        config: &Arc<BridgeConfig>,
        hub: Arc<ClientHub>,
        _metrics: Arc<OperationalMetrics>,
    ) -> Result<Arc<Self>, String> {
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
        let mut events = manager
            .take_events()
            .await
            .ok_or_else(|| "ACP canonical event receiver already taken".to_string())?;
        let event_hub = hub.clone();
        let snapshot_manager = manager.clone();
        let subagent_discoveries: SubagentDiscoveries =
            Arc::new(StdMutex::new(SubagentDiscoveryState::default()));
        let event_pump = tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                if let crate::acp::events::CanonicalEvent::Tool {
                    thread_id,
                    tool_call_id,
                    kind,
                    status,
                    title,
                    ..
                } = &event
                {
                    let settled = matches!(
                        status,
                        agent_client_protocol::schema::v1::ToolCallStatus::Completed
                            | agent_client_protocol::schema::v1::ToolCallStatus::Failed
                    );
                    if !settled
                        && crate::acp::snapshot::is_subagent_task_tool(*kind, title)
                        && snapshot_manager.can_discover_subagents(thread_id)
                    {
                        let key = discovery_key(thread_id, tool_call_id);
                        let started = subagent_discoveries
                            .lock()
                            .map(|mut state| state.polling.insert(key))
                            .unwrap_or(false);
                        if started {
                            tokio::spawn(discover_subagent_session(
                                snapshot_manager.clone(),
                                event_hub.clone(),
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
                } = &event
                {
                    snapshot_manager
                        .note_subagent_started(thread_id, *generation)
                        .await;
                }
                let related_terminal = match &event {
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
                    let accepted = snapshot_manager
                        .accepted_subagent_terminal(child_thread_id, generation)
                        .await;
                    let correlation_target = accepted.clone();
                    let correction = if let Some(target) = accepted {
                        snapshot_manager
                            .mark_parent_subagent_tool_terminal(
                                &target.parent_thread_id,
                                &target.tool_call_id,
                                status,
                            )
                            .await
                    } else if !snapshot_manager
                        .tracks_subagent_generation(child_thread_id)
                        .await
                    {
                        snapshot_manager
                            .mark_parent_subagent_terminal(child_thread_id, status)
                            .await
                    } else {
                        Ok(None)
                    };
                    match correction {
                        Ok(Some(parent)) => {
                            if let Some(target) = correlation_target {
                                snapshot_manager
                                    .retire_subagent_link(child_thread_id, &target.tool_call_id)
                                    .await;
                            }
                            event_hub
                                .broadcast_ag_ui_envelope(parent_subagent_snapshot_envelope(
                                    &parent,
                                ))
                                .await;
                        }
                        Ok(None) => {
                            if let Some(target) = correlation_target {
                                snapshot_manager
                                    .retire_subagent_link(child_thread_id, &target.tool_call_id)
                                    .await;
                            }
                        }
                        Err(error) => {
                            eprintln!("failed to persist parent sub-agent status: {error}");
                        }
                    }
                }
                if let Some((
                    parent_thread_id,
                    child_session_id,
                    child_title,
                    tool_call_id,
                    terminal,
                )) = crate::agui::discovered_subagent_session(&event)
                {
                    if terminal {
                        if let Some(thread_id) =
                            child_thread_id(parent_thread_id, &child_session_id)
                        {
                            snapshot_manager
                                .retire_subagent_link(&thread_id, tool_call_id)
                                .await;
                        }
                    }
                    adopt_subagent_session(
                        &snapshot_manager,
                        &event_hub,
                        AdoptedSubagent {
                            parent_thread_id,
                            child_session_id: &child_session_id,
                            child_title,
                            tool_call_id,
                            link: !terminal,
                        },
                    )
                    .await;
                }
                event_hub.broadcast_canonical_event(&event).await;
                let terminal = match &event {
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
                    if let Ok(session) = snapshot_manager.read_session(&thread_id).await {
                        event_hub
                            .broadcast_ag_ui_envelope(crate::agui::messages_snapshot_envelope(
                                &session.snapshot,
                                run_id,
                                Some(source_turn_id),
                            ))
                            .await;
                    }
                }
            }
        });
        Ok(Arc::new(Self {
            manager,
            hub,
            event_pump: Mutex::new(Some(event_pump)),
            client_requests: ClientRequestTracker::default(),
        }))
    }

    pub(super) async fn shutdown(&self) {
        self.manager.shutdown().await;
        self.manager.flush_events().await;
        if let Some(pump) = self.event_pump.lock().await.take() {
            pump.abort();
            let _ = pump.await;
        }
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
            "thread/delete" => {
                let thread_id = required_string(&params, "threadId")?;
                self.manager
                    .delete_session(&thread_id)
                    .await
                    .map_err(|error| error.to_string())?;
                self.hub
                    .broadcast_notification("thread/deleted", json!({ "threadId": thread_id }))
                    .await;
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
            "thread/resume" => {
                let thread_id = required_string(&params, "threadId")?;
                let cwd = required_string(&params, "cwd")?;
                let session = self
                    .manager
                    .resume_session(&thread_id, cwd)
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
                let source_turn_id = Uuid::new_v4().to_string();
                let run_id = format!("{thread_id}::turn::{source_turn_id}");
                let admission = self
                    .manager
                    .prompt(&thread_id, prompt, run_id, source_turn_id)
                    .await
                    .map_err(|error| error.to_string())?;
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
                "data": self.manager.opencode_model_catalog(read_string(params.get("agentId")).as_deref()).await,
                "source": "opencodeCatalog",
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
        let mode = read_string(params.get("mode")).map(|value| {
            if value == "default" {
                "build".to_string()
            } else {
                value
            }
        });
        let mut session = self
            .manager
            .new_session_with_cancellation(&agent_id, NewSessionRequest::new(cwd), cancellation)
            .await
            .map_err(|error| error.to_string())?;
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
                    "{category} option is not advertised by this ACP agent"
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
                .map_err(|error| error.to_string())?;
        }
        Ok(json!({ "thread": session_to_thread_value(session)? }))
    }

    pub(super) async fn request_for_client(
        &self,
        client_id: u64,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, String> {
        self.client_requests
            .run_with(client_id, |cancellation| async move {
                if method == "thread/start" {
                    return self
                        .start_thread(params.unwrap_or_else(|| json!({})), cancellation)
                        .await;
                }
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
                .cancel_permission(&pending.thread_id, approval_id)
                .await
                .map_err(|error| error.to_string())?;
        } else {
            self.manager
                .resolve_permission(&pending.thread_id, approval_id, decision)
                .await
                .map_err(|error| error.to_string())?;
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

    fn prepare_steer<'a>(&'a self, thread_id: &'a str) -> BoxFuture<'a, Result<u64, String>> {
        Box::pin(RuntimeBackend::prepare_steer(self, thread_id))
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

    fn turn_start<'a>(
        &'a self,
        thread_id: &'a str,
        turn_start: &'a Value,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let mut params = turn_start.clone();
            let params_object = params
                .as_object_mut()
                .ok_or_else(|| "turnStart payload must be an object".to_string())?;
            params_object.insert("threadId".to_string(), Value::String(thread_id.to_string()));
            let response = self
                .request_internal("turn/start", Some(Value::Object(params_object.clone())))
                .await?;
            read_string(
                response
                    .as_object()
                    .and_then(|object| object.get("turn"))
                    .and_then(Value::as_object)
                    .and_then(|turn| turn.get("id")),
            )
            .ok_or_else(|| "turn/start did not return turn id".to_string())
        })
    }
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

fn session_to_thread_value(session: crate::acp::manager::ManagedSession) -> Result<Value, String> {
    let snapshot = crate::acp::snapshot::BridgeThreadSnapshot::from(session.snapshot);
    let title = snapshot.session.title.clone();
    let updated_at = snapshot.session.updated_at.clone();
    let source = session.parent_thread_id.as_ref().map(|parent_thread_id| {
        json!({
            "kind": "subAgentThreadSpawn",
            "parentThreadId": parent_thread_id,
            "depth": 1,
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

#[cfg(unix)]
pub(super) async fn wait_for_shutdown_signal() -> &'static str {
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .expect("failed to install SIGINT handler");
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("failed to install SIGTERM handler");
    tokio::select! {
        _ = sigint.recv() => "SIGINT",
        _ = sigterm.recv() => "SIGTERM",
    }
}

#[cfg(not(unix))]
pub(super) async fn wait_for_shutdown_signal() -> &'static str {
    let _ = tokio::signal::ctrl_c().await;
    "Ctrl+C"
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod client_request_tests {
    use super::*;
    use agent_client_protocol::schema::v1::{ToolCallStatus, ToolKind};
    use std::path::PathBuf;
    use tokio::{
        sync::{oneshot, Semaphore},
        time::{timeout, Duration},
    };

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
}
