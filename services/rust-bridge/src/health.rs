use std::time::Instant;

use serde::Serialize;

use crate::{
    acp::manager::{AgentDescriptor, AgentLifecycle},
    now_iso,
    observability::{OperationalError, PushMetrics, RequestMetrics},
    replay::ReplayStatus,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeDeviceConnection {
    pub(crate) client_id: u64,
    pub(crate) client_type: String,
    pub(crate) client_name: String,
    pub(crate) connected_at: String,
    pub(crate) last_seen_at: String,
}

pub(crate) fn user_device_connections(
    devices: Vec<BridgeDeviceConnection>,
) -> Vec<BridgeDeviceConnection> {
    devices
        .into_iter()
        .filter(|device| device.client_type != "desktop-monitor")
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeStatus {
    pub(crate) status: String,
    at: String,
    uptime_sec: u64,
    connected_clients: usize,
    devices: Vec<BridgeDeviceConnection>,
    pub(crate) agents: Vec<AgentDescriptor>,
    pub(crate) runtime: RuntimeActivity,
    pub(crate) operational: BridgeOperationalStatus,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeActivity {
    pub(crate) active_runs: usize,
    pub(crate) queued_messages: usize,
    pub(crate) pending_steers: usize,
    pub(crate) pending_approvals: usize,
    pub(crate) pending_user_inputs: usize,
    pub(crate) active_preview_sessions: usize,
    pub(crate) in_flight_requests: usize,
    pub(crate) other_live_work: usize,
    pub(crate) can_retire: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeOperationalStatus {
    pub(crate) requests: RequestMetrics,
    pub(crate) replay: ReplayStatus,
    pub(crate) queue: QueueStatus,
    pub(crate) push: PushMetrics,
    pub(crate) recent_errors: Vec<OperationalError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueueStatus {
    pub(crate) tracked_threads: usize,
    pub(crate) depth: usize,
    pub(crate) busy_threads: usize,
    pub(crate) active_runs: usize,
    pub(crate) pending_steers: usize,
    pub(crate) pending_approvals: usize,
    pub(crate) pending_user_inputs: usize,
    pub(crate) other_live_work: usize,
}

pub(crate) fn runtime_activity(
    connected_clients: usize,
    queue: &QueueStatus,
    manager_active_runs: usize,
    manager_approvals: usize,
    manager_inputs: usize,
    manager_other: usize,
    active_preview_sessions: usize,
) -> RuntimeActivity {
    RuntimeActivity {
        active_runs: manager_active_runs.max(queue.active_runs),
        queued_messages: queue.depth,
        pending_steers: queue.pending_steers,
        pending_approvals: manager_approvals.max(queue.pending_approvals),
        pending_user_inputs: manager_inputs.max(queue.pending_user_inputs),
        active_preview_sessions,
        in_flight_requests: manager_other,
        other_live_work: queue.other_live_work,
        can_retire: connected_clients == 0
            && manager_active_runs == 0
            && queue.active_runs == 0
            && queue.depth == 0
            && queue.pending_steers == 0
            && manager_approvals == 0
            && queue.pending_approvals == 0
            && manager_inputs == 0
            && queue.pending_user_inputs == 0
            && active_preview_sessions == 0
            && manager_other == 0
            && queue.other_live_work == 0,
    }
}

pub(crate) fn bridge_status(
    started_at: Instant,
    devices: Vec<BridgeDeviceConnection>,
    agents: Vec<AgentDescriptor>,
    runtime: RuntimeActivity,
    operational: BridgeOperationalStatus,
) -> BridgeStatus {
    let available = agents
        .iter()
        .filter(|agent| agent.lifecycle == AgentLifecycle::Ready)
        .count();
    let status = if available == 0 {
        "unhealthy"
    } else if agents
        .iter()
        .all(|agent| agent.lifecycle == AgentLifecycle::Ready)
    {
        "ok"
    } else {
        "degraded"
    };
    BridgeStatus {
        status: status.to_string(),
        at: now_iso(),
        uptime_sec: started_at.elapsed().as_secs(),
        connected_clients: devices.len(),
        devices,
        agents,
        runtime,
        operational,
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::acp::manager::{AgentCapabilities, AgentDescriptor};
    use crate::observability::OperationalMetrics;

    fn agent(id: &str, lifecycle: AgentLifecycle) -> AgentDescriptor {
        AgentDescriptor {
            agent_id: id.to_string(),
            display_name: id.to_string(),
            icon: None,
            version: "1.0.0".to_string(),
            provenance: "test".to_string(),
            lifecycle,
            last_error: None,
            capabilities: Some(AgentCapabilities {
                session_list: true,
                session_load: true,
                session_resume: true,
                session_steer: false,
                session_fork: false,
                session_delete: false,
            }),
        }
    }

    async fn operational() -> BridgeOperationalStatus {
        let metrics = OperationalMetrics::new();
        BridgeOperationalStatus {
            requests: metrics.request_snapshot(),
            replay: crate::replay::NotificationReplay::new(4, 1024)
                .status(0)
                .await,
            queue: QueueStatus {
                tracked_threads: 0,
                depth: 0,
                busy_threads: 0,
                active_runs: 0,
                pending_steers: 0,
                pending_approvals: 0,
                pending_user_inputs: 0,
                other_live_work: 0,
            },
            push: metrics.push_snapshot(),
            recent_errors: Vec::new(),
        }
    }

    #[tokio::test]
    async fn status_is_unhealthy_without_available_engines() {
        let status = bridge_status(
            Instant::now(),
            Vec::new(),
            Vec::new(),
            RuntimeActivity::default(),
            operational().await,
        );
        assert_eq!(status.status, "unhealthy");
        assert_eq!(status.connected_clients, 0);
    }

    #[tokio::test]
    async fn status_is_ok_when_every_engine_is_available() {
        let devices = vec![BridgeDeviceConnection {
            client_id: 1,
            client_type: "mobile".to_string(),
            client_name: "phone".to_string(),
            connected_at: "then".to_string(),
            last_seen_at: "now".to_string(),
        }];
        let agents = vec![
            agent("alpha", AgentLifecycle::Ready),
            agent("beta", AgentLifecycle::Ready),
        ];
        let status = bridge_status(
            Instant::now(),
            devices,
            agents,
            RuntimeActivity::default(),
            operational().await,
        );
        assert_eq!(status.status, "ok");
        assert_eq!(status.connected_clients, 1);
        assert_eq!(status.devices[0].client_id, 1);
    }

    #[test]
    fn desktop_status_monitors_are_not_reported_as_connected_devices() {
        let devices = vec![
            BridgeDeviceConnection {
                client_id: 1,
                client_type: "mobile".to_string(),
                client_name: "phone".to_string(),
                connected_at: "then".to_string(),
                last_seen_at: "now".to_string(),
            },
            BridgeDeviceConnection {
                client_id: 2,
                client_type: "desktop-monitor".to_string(),
                client_name: "DapperCode".to_string(),
                connected_at: "then".to_string(),
                last_seen_at: "now".to_string(),
            },
        ];

        let visible = user_device_connections(devices);
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].client_type, "mobile");
    }

    #[tokio::test]
    async fn status_is_degraded_for_mixed_engine_availability() {
        let agents = vec![
            agent("alpha", AgentLifecycle::Ready),
            agent("beta", AgentLifecycle::Unavailable),
        ];
        let status = bridge_status(
            Instant::now(),
            Vec::new(),
            agents,
            RuntimeActivity::default(),
            operational().await,
        );
        assert_eq!(status.status, "degraded");
    }

    #[test]
    fn retirement_requires_every_client_and_live_work_blocker_to_clear() {
        let idle_queue = QueueStatus {
            tracked_threads: 0,
            depth: 0,
            busy_threads: 0,
            active_runs: 0,
            pending_steers: 0,
            pending_approvals: 0,
            pending_user_inputs: 0,
            other_live_work: 0,
        };
        assert!(runtime_activity(0, &idle_queue, 0, 0, 0, 0, 0).can_retire);

        for activity in [
            runtime_activity(1, &idle_queue, 0, 0, 0, 0, 0),
            runtime_activity(0, &idle_queue, 1, 0, 0, 0, 0),
            runtime_activity(0, &idle_queue, 0, 1, 0, 0, 0),
            runtime_activity(0, &idle_queue, 0, 0, 1, 0, 0),
            runtime_activity(0, &idle_queue, 0, 0, 0, 1, 0),
            runtime_activity(0, &idle_queue, 0, 0, 0, 0, 1),
        ] {
            assert!(!activity.can_retire);
        }

        for mutate in [
            |queue: &mut QueueStatus| queue.active_runs = 1,
            |queue: &mut QueueStatus| queue.depth = 1,
            |queue: &mut QueueStatus| queue.pending_steers = 1,
            |queue: &mut QueueStatus| queue.pending_approvals = 1,
            |queue: &mut QueueStatus| queue.pending_user_inputs = 1,
            |queue: &mut QueueStatus| queue.other_live_work = 1,
        ] {
            let mut queue = idle_queue.clone();
            mutate(&mut queue);
            assert!(!runtime_activity(0, &queue, 0, 0, 0, 0, 0).can_retire);
        }
    }
}
