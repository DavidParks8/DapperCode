use super::{
    fs, on_receive_notification, on_receive_request, scenario_agent, Arc, Duration,
    InitializeRequest, LoadSessionRequest, PathBuf, PromptControl, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, ResumeSessionRequest, Scenario,
    SessionNotification, SessionUpdate, StopReason,
};

#[tokio::test]
async fn permission_response_releases_the_fixture_prompt() {
    use agent_client_protocol::v1::schema::{RequestPermissionResponse, SelectedPermissionOutcome};

    let directory = std::env::temp_dir().join(format!(
        "dappercode-e2e-permission-fixture-{}",
        uuid::Uuid::new_v4(),
    ));
    fs::create_dir(&directory).await.unwrap();
    let control_path = directory.join("control.json");
    fs::write(
        &control_path,
        serde_json::json!({
            "messageId": "approved-answer",
            "chunks": ["Approved answer"],
            "requestPermission": true,
        })
        .to_string(),
    )
    .await
    .unwrap();
    let scenario = Arc::new(Scenario { chats: Vec::new() });
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        agent_client_protocol::Client
            .v1()
            .on_receive_request(
                async |_: RequestPermissionRequest, responder, _| {
                    responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new("allow")),
                    ))
                },
                on_receive_request!(),
            )
            .connect_with(scenario_agent(scenario, control_path), async |connection| {
                connection
                    .send_request(InitializeRequest::new(
                        agent_client_protocol::schema::ProtocolVersion::V1,
                    ))
                    .block_task()
                    .await?;
                connection
                    .send_request(PromptRequest::new(
                        "permission",
                        vec!["Please proceed".into()],
                    ))
                    .block_task()
                    .await
            }),
    )
    .await;
    fs::remove_dir_all(&directory).await.unwrap();
    assert_eq!(
        result
            .expect("permission response completes the prompt")
            .unwrap()
            .stop_reason,
        StopReason::EndTurn,
    );
}

#[tokio::test]
async fn completed_prompts_replay_once_with_followups_and_tool_updates() {
    let directory = std::env::temp_dir().join(format!(
        "dappercode-e2e-history-fixture-{}",
        uuid::Uuid::new_v4(),
    ));
    fs::create_dir(&directory).await.unwrap();
    let control_path = directory.join("control.json");
    fs::write(
        &control_path,
        serde_json::json!({
            "messageId": "answer-1",
            "chunks": ["First answer.", "Second answer."],
            "separateMessages": true,
            "toolSteps": [
                {"update": {
                    "sessionUpdate": "tool_call", "toolCallId": "tool-1",
                    "title": "Fixture tool", "kind": "read", "status": "pending"
                }},
                {"update": {
                    "sessionUpdate": "tool_call_update", "toolCallId": "tool-1",
                    "status": "completed",
                    "content": [{"type": "content", "content": {
                        "type": "text", "text": "Fixture tool result"
                    }}]
                }}
            ]
        })
        .to_string(),
    )
    .await
    .unwrap();
    let scenario = Arc::new(
        serde_json::from_value::<Scenario>(serde_json::json!({
            "chats": [{
                "id": "completed",
                "title": "Fixture conversation",
                "updatedAt": 1750000000,
                "messages": []
            }]
        }))
        .unwrap(),
    );
    let updates = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = updates.clone();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        agent_client_protocol::Client
            .v1()
            .on_receive_notification(
                async move |notification: SessionNotification, _| {
                    observed
                        .lock()
                        .unwrap()
                        .push(serde_json::to_value(notification.update).unwrap());
                    Ok(())
                },
                on_receive_notification!(),
            )
            .connect_with(
                scenario_agent(scenario, control_path.clone()),
                async move |connection| {
                    connection
                        .send_request(InitializeRequest::new(
                            agent_client_protocol::schema::ProtocolVersion::V1,
                        ))
                        .block_task()
                        .await?;
                    connection
                        .send_request(PromptRequest::new(
                            "completed",
                            vec!["First prompt.".into()],
                        ))
                        .block_task()
                        .await?;
                    let first_live = std::mem::take(&mut *updates.lock().unwrap());
                    let mut loads = Vec::new();
                    for _ in 0..2 {
                        connection
                            .send_request(LoadSessionRequest::new("completed", "/workspace"))
                            .block_task()
                            .await?;
                        loads.push(std::mem::take(&mut *updates.lock().unwrap()));
                    }
                    fs::write(
                        &control_path,
                        serde_json::json!({
                            "messageId": "answer-2",
                            "chunks": ["Follow-up answer."]
                        })
                        .to_string(),
                    )
                    .await
                    .map_err(agent_client_protocol::Error::into_internal_error)?;
                    connection
                        .send_request(PromptRequest::new(
                            "completed",
                            vec!["Follow-up prompt.".into()],
                        ))
                        .block_task()
                        .await?;
                    let second_live = std::mem::take(&mut *updates.lock().unwrap());
                    for _ in 0..2 {
                        connection
                            .send_request(LoadSessionRequest::new("completed", "/workspace"))
                            .block_task()
                            .await?;
                        loads.push(std::mem::take(&mut *updates.lock().unwrap()));
                    }
                    connection
                        .send_request(ResumeSessionRequest::new("completed", "/workspace"))
                        .block_task()
                        .await?;
                    let resumed = std::mem::take(&mut *updates.lock().unwrap());
                    Ok((first_live, second_live, loads, resumed))
                },
            ),
    )
    .await;
    fs::remove_dir_all(&directory).await.unwrap();
    let (first_live, second_live, loads, resumed) = result
        .expect("fixture prompt and load requests complete")
        .unwrap();

    assert_eq!(first_live.len(), 4);
    assert_eq!(first_live[0]["sessionUpdate"], "tool_call");
    assert_eq!(first_live[1]["status"], "completed");
    assert_eq!(first_live[2]["messageId"], "answer-1-0");
    assert_eq!(first_live[3]["messageId"], "answer-1-1");
    assert_eq!(second_live.len(), 1);
    assert_eq!(second_live[0]["messageId"], "answer-2");
    assert_eq!(loads[0], loads[1], "reloading must not duplicate the turn");
    assert_eq!(loads[0].len(), first_live.len() + 2);
    assert_eq!(loads[0][0]["sessionUpdate"], "user_message_chunk");
    assert_eq!(loads[0][0]["content"]["text"], "First prompt.");
    assert_eq!(loads[0][1..5], first_live);
    assert_eq!(
        loads[2], loads[3],
        "follow-up reload must also be idempotent",
    );
    assert_eq!(loads[2].len(), 8);
    assert_eq!(loads[2][..5], loads[0][..5]);
    assert_eq!(loads[2][5]["content"]["text"], "Follow-up prompt.");
    assert_ne!(loads[2][0]["messageId"], loads[2][5]["messageId"]);
    assert_eq!(loads[2][6], second_live[0]);
    assert_eq!(resumed.len(), 1);
    assert_eq!(loads[2].last(), resumed.first());
    assert_eq!(resumed[0]["sessionUpdate"], "session_info_update");
    assert_eq!(resumed[0]["title"], "Fixture conversation");
}

#[tokio::test]
async fn load_replays_history_but_resume_emits_only_metadata() {
    let scenario = Arc::new(
        serde_json::from_value::<Scenario>(serde_json::json!({
            "chats": [{
                "id": "completed",
                "title": "Completed conversation",
                "updatedAt": 1750000000,
                "messages": [
                    {"id": "user", "role": "user", "text": "A phone prompt"},
                    {"id": "answer", "role": "assistant", "text": "Completed answer"}
                ]
            }]
        }))
        .unwrap(),
    );
    let updates = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = updates.clone();
    tokio::time::timeout(
        Duration::from_secs(1),
        agent_client_protocol::Client
            .v1()
            .on_receive_notification(
                async move |notification: SessionNotification, _| {
                    observed.lock().unwrap().push(notification.update);
                    Ok(())
                },
                on_receive_notification!(),
            )
            .connect_with(
                scenario_agent(scenario, PathBuf::new()),
                async move |connection| {
                    connection
                        .send_request(InitializeRequest::new(
                            agent_client_protocol::schema::ProtocolVersion::V1,
                        ))
                        .block_task()
                        .await?;
                    connection
                        .send_request(LoadSessionRequest::new("completed", "/workspace"))
                        .block_task()
                        .await?;
                    let loaded = std::mem::take(&mut *updates.lock().unwrap());
                    assert_eq!(loaded.len(), 3);
                    assert!(matches!(loaded[0], SessionUpdate::UserMessageChunk(_)));
                    assert!(matches!(loaded[1], SessionUpdate::AgentMessageChunk(_)));
                    assert!(matches!(loaded[2], SessionUpdate::SessionInfoUpdate(_)));

                    connection
                        .send_request(ResumeSessionRequest::new("completed", "/workspace"))
                        .block_task()
                        .await?;
                    let resumed = std::mem::take(&mut *updates.lock().unwrap());
                    assert_eq!(resumed.len(), 1, "resume must not replay message history");
                    let metadata = serde_json::to_value(&resumed[0]).unwrap();
                    assert_eq!(metadata["sessionUpdate"], "session_info_update");
                    assert_eq!(metadata["title"], "Completed conversation");
                    assert_eq!(metadata["updatedAt"], "2025-06-15T15:06:40+00:00");
                    Ok(())
                },
            ),
    )
    .await
    .expect("fixture lifecycle requests complete")
    .unwrap();
}

#[test]
fn prompt_control_accepts_typed_patch_steps_and_status_only_completion() {
    let control: PromptControl = serde_json::from_value(serde_json::json!({
        "chunks": [],
        "messageId": "patch-message",
        "toolSteps": [
            {
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "patch",
                    "title": "apply_patch",
                    "kind": "other",
                    "status": "pending"
                },
                "hold": true
            },
            {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "patch",
                    "status": "in_progress",
                    "content": [{
                        "type": "diff",
                        "path": "src/settings.ts",
                        "oldText": "old\n",
                        "newText": "new\n"
                    }]
                },
                "hold": true
            },
            {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "patch",
                    "status": "completed"
                }
            }
        ]
    }))
    .expect("typed ACP patch control");
    assert!(matches!(
        control.tool_steps[0].update,
        SessionUpdate::ToolCall(_)
    ));
    let update = serde_json::to_value(&control.tool_steps[1].update).unwrap();
    assert_eq!(update["content"][0]["type"], "diff");
    assert_eq!(update["content"][0]["oldText"], "old\n");
    assert_eq!(update["content"][0]["newText"], "new\n");
    assert!(control.tool_steps[1].hold);
    let completed = serde_json::to_value(&control.tool_steps[2].update).unwrap();
    assert_eq!(completed["status"], "completed");
    assert!(completed.get("content").is_none());
    assert!(!control.tool_steps[2].hold);
    assert!(control.succeed);
}

#[test]
fn existing_assistant_controls_need_no_tool_steps() {
    let control: PromptControl = serde_json::from_value(serde_json::json!({
        "chunks": ["Working."],
        "messageId": "existing-message",
        "hold": true
    }))
    .unwrap();
    assert!(control.tool_steps.is_empty());
    assert!(control.hold);
    assert_eq!(control.chunks, ["Working."]);
}
