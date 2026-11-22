use super::{
    bridge_status, runtime_activity, user_device_connections, AgentLifecycle,
    BridgeDeviceConnection, BridgeOperationalStatus, Instant, QueueStatus, RuntimeActivity,
};
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
        foreground: true,
        foreground_sequence: 1,
        foreground_updated_at: Instant::now(),
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
            foreground: true,
            foreground_sequence: 1,
            foreground_updated_at: Instant::now(),
        },
        BridgeDeviceConnection {
            client_id: 2,
            client_type: "desktop-monitor".to_string(),
            client_name: "DapperCode".to_string(),
            connected_at: "then".to_string(),
            last_seen_at: "now".to_string(),
            foreground: false,
            foreground_sequence: 0,
            foreground_updated_at: Instant::now(),
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
