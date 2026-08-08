use crate::*;

#[derive(Clone)]
pub(super) struct AppState {
    pub(super) config: Arc<BridgeConfig>,
    pub(super) path_policy: Arc<PathPolicy>,
    pub(super) started_at: Instant,
    pub(super) hub: Arc<ClientHub>,
    pub(super) backend: Arc<RuntimeBackend>,
    pub(super) queue: Arc<BridgeQueueService>,
    pub(super) thread_create_results: Arc<Mutex<HashMap<String, BridgeThreadCreateResponse>>>,
    pub(super) thread_create_order: Arc<Mutex<VecDeque<String>>>,
    pub(super) thread_create_actor: Arc<Mutex<()>>,
    pub(super) thread_fork_results: Arc<Mutex<HashMap<String, BridgeThreadForkCacheEntry>>>,
    pub(super) thread_fork_order: Arc<Mutex<VecDeque<String>>>,
    pub(super) thread_fork_actor: Arc<Mutex<()>>,
    pub(super) approval_resolution_results: Arc<Mutex<HashMap<String, Value>>>,
    pub(super) approval_resolution_order: Arc<Mutex<VecDeque<String>>>,
    pub(super) approval_resolution_actor: Arc<Mutex<()>>,
    pub(super) thread_list_streams: Arc<Mutex<HashMap<String, Arc<ThreadListStreamCancellation>>>>,
    pub(super) git: Arc<GitService>,
    pub(super) preview: Arc<BrowserPreviewService>,
    pub(super) push: Arc<PushService>,
    pub(super) ws_global_in_flight: Arc<Semaphore>,
    pub(super) metrics: Arc<OperationalMetrics>,
}

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
        let devices = crate::health::user_device_connections(self.hub.client_connections().await);
        let agents = self.backend.capabilities(self.hub.stream_id()).agents;
        let operational = BridgeOperationalStatus {
            requests: self.metrics.request_snapshot(),
            replay: self.hub.replay_status().await,
            queue: self.queue.status().await,
            push: self.metrics.push_snapshot(),
            recent_errors: self.metrics.recent_errors(),
        };
        bridge_status(self.started_at, devices, agents, operational)
    }
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
}
