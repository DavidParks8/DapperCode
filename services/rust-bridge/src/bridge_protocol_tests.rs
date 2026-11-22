use super::{PendingApproval, PendingUserInputRequest, Value};
use agent_client_protocol::v1::schema::{PermissionOptionKind, ToolCallStatus, ToolKind};

use crate::acp::interactions::{
    ElicitationFieldKind, ElicitationFieldSummary, PendingElicitationSummary,
    PendingPermissionSummary, PermissionOptionSummary,
};

#[test]
fn production_pending_dtos_match_cross_language_fixtures() {
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../contracts/bridge-rpc/v2/manifest.json"
    ))
    .unwrap();
    let approval = PendingApproval::from(PendingPermissionSummary {
        agent_id: "agent-alpha".into(),
        request_id: "approval-1".into(),
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        tool_call_id: "tool-1".into(),
        title: "Run tests".into(),
        kind: ToolKind::Execute,
        status: ToolCallStatus::Pending,
        options: vec![PermissionOptionSummary {
            id: "allow-once".into(),
            name: "Allow once".into(),
            kind: PermissionOptionKind::AllowOnce,
        }],
        requested_at: "2026-07-20T00:00:00+00:00".into(),
        requested_order: 1,
    });
    assert_eq!(
        serde_json::to_value(approval).unwrap(),
        manifest["fixtures"]["notification"]["params"],
    );

    let user_input = PendingUserInputRequest::from(PendingElicitationSummary {
        agent_id: "agent-alpha".into(),
        request_id: "input-1".into(),
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        tool_call_id: Some("tool-1".into()),
        message: "Deployment settings".into(),
        fields: vec![ElicitationFieldSummary {
            name: "environment".into(),
            title: Some("Environment".into()),
            description: Some("Choose an environment".into()),
            kind: ElicitationFieldKind::String,
            required: true,
            sensitive: true,
            options: vec![("production".into(), "Production".into())],
            default: None,
        }],
        requested_at: "2026-07-20T00:00:01+00:00".into(),
        requested_order: 2,
    });
    assert_eq!(
        serde_json::to_value(user_input).unwrap(),
        manifest["fixtures"]["pendingUserInput"],
    );
}
