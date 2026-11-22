use crate::acp::manager::{AgentDescriptor, AgentLifecycle};
use crate::now_iso;
use crate::observability::{OperationalError, PushMetrics, RequestMetrics};
use crate::replay::ReplayStatus;
use serde::Serialize;
use std::time::Instant;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeDeviceConnection {
    pub(crate) client_id: u64,
    pub(crate) client_type: String,
    pub(crate) client_name: String,
    pub(crate) connected_at: String,
    pub(crate) last_seen_at: String,
    #[serde(skip)]
    pub(crate) foreground: bool,
    #[serde(skip)]
    pub(crate) foreground_sequence: u64,
    #[serde(skip)]
    pub(crate) foreground_updated_at: Instant,
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
#[path = "health_tests.rs"]
mod tests;
