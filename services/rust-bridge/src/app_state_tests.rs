use super::{
    json, load_operation_dedupe, persist_operation_dedupe, sanitize_client_metadata, trim_dedupe,
    BridgeCapabilitySupport, BridgeThreadCreateResponse, BridgeThreadForkCacheEntry,
    BridgeThreadForkResponse, DurableOperationDedupe, HashMap, PendingApprovalOperation,
    PendingForkOperation, VecDeque, APPROVAL_RESOLUTION_DEDUPE_LIMIT, OPERATION_DEDUPE_MAX_BYTES,
    SUBMISSION_DEDUPE_LIMIT,
};
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
        BridgeCapabilitySupport::from_agent(&descriptor(AgentLifecycle::Ready, false, false, true))
            .thread_delete,
    );
    assert!(
        !BridgeCapabilitySupport::from_agent(&descriptor(
            AgentLifecycle::Ready,
            false,
            false,
            false
        ))
        .thread_delete,
    );
    assert!(
        !BridgeCapabilitySupport::from_agent(&descriptor(
            AgentLifecycle::Unavailable,
            false,
            false,
            true
        ))
        .thread_delete,
    );

    let mut unknown = descriptor(AgentLifecycle::Ready, false, false, true);
    unknown.capabilities = None;
    assert!(!BridgeCapabilitySupport::from_agent(&unknown).thread_delete);
}

#[test]
fn thread_fork_support_follows_the_agent_capability_and_readiness() {
    assert!(
        BridgeCapabilitySupport::from_agent(&descriptor(AgentLifecycle::Ready, false, true, false))
            .thread_fork,
    );
    assert!(
        !BridgeCapabilitySupport::from_agent(&descriptor(
            AgentLifecycle::Unavailable,
            false,
            true,
            false
        ))
        .thread_fork,
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
                .unwrap_or(false),
        );
        assert_eq!(
            supports.thread_fork,
            case["supportsByAgent"]["threadFork"]
                .as_bool()
                .unwrap_or(false),
        );
        assert_eq!(
            supports.thread_delete,
            case["supportsByAgent"]["threadDelete"]
                .as_bool()
                .unwrap_or(false),
        );
    }
}

#[tokio::test]
async fn operation_idempotency_survives_a_worker_restart() {
    let directory = std::env::temp_dir().join(format!(
        "dappercode-operation-dedupe-{}",
        uuid::Uuid::new_v4(),
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
        "thread-1",
    );
    assert_eq!(
        restored.thread_create_order,
        VecDeque::from(["submission-1".to_string()]),
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
        uuid::Uuid::new_v4(),
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
        APPROVAL_RESOLUTION_DEDUPE_LIMIT,
    );
    assert_eq!(
        bounded.approval_resolution_results.len(),
        APPROVAL_RESOLUTION_DEDUPE_LIMIT,
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
        "fallback",
    );
    assert_eq!(
        sanitize_client_metadata(Some("  device-name  "), "fallback", 6),
        "device",
    );
}

#[tokio::test]
async fn operation_idempotency_compacts_each_completed_result_class() {
    let directory = std::env::temp_dir().join(format!(
        "dappercode-operation-dedupe-compact-{}",
        uuid::Uuid::new_v4(),
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
