use std::{
    collections::{HashMap, HashSet},
    env,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use agent_client_protocol::{
    on_receive_notification, on_receive_request,
    schema::v1::{
        AgentCapabilities, CancelNotification, ContentChunk, DeleteSessionRequest,
        DeleteSessionResponse, InitializeRequest, InitializeResponse, ListSessionsRequest,
        ListSessionsResponse, LoadSessionRequest, LoadSessionResponse, MessageId,
        NewSessionRequest, NewSessionResponse, PermissionOption, PermissionOptionKind,
        PromptRequest, PromptResponse, RequestPermissionOutcome, RequestPermissionRequest,
        ResumeSessionRequest, ResumeSessionResponse, SessionCapabilities,
        SessionDeleteCapabilities, SessionInfo, SessionListCapabilities, SessionNotification,
        SessionResumeCapabilities, SessionUpdate, StopReason, ToolCallStatus, ToolCallUpdate,
        ToolCallUpdateFields, ToolKind,
    },
    Agent, ConnectTo, JsonRpcRequest, JsonRpcResponse, Lines,
};
use serde::{Deserialize, Serialize};
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::RwLock,
    time::{sleep, Instant},
};

const SCENARIO_ENV: &str = "DAPPERCODE_E2E_SCENARIO_PATH";
const CONTROL_ENV: &str = "DAPPERCODE_E2E_CONTROL_PATH";
const HOLD_TIMEOUT: Duration = Duration::from_secs(30);
const STEER_METHOD: &str = "_dappercode.dev/session/steer";
const FORK_METHOD: &str = "_dappercode.dev/session/fork";

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[request(method = "_dappercode.dev/session/steer", response = SteerResponse)]
struct SteerRequest {
    session_id: agent_client_protocol::schema::v1::SessionId,
    expected_run_id: String,
    expected_source_turn_id: String,
    prompt_generation: u64,
    prompt: Vec<agent_client_protocol::schema::v1::ContentBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SteerResponse {
    accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[request(method = "_dappercode.dev/session/fork", response = ForkResponse)]
struct ForkRequest {
    session_id: agent_client_protocol::schema::v1::SessionId,
    message_id: Option<String>,
    user_message_ordinal: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForkResponse {
    session_id: agent_client_protocol::schema::v1::SessionId,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    chats: Vec<ScenarioChat>,
}

type LiveHistory = RwLock<HashMap<String, Vec<SessionUpdate>>>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioChat {
    id: String,
    title: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    updated_at: Option<i64>,
    #[serde(default)]
    messages: Vec<ScenarioMessage>,
}

#[derive(Debug, Deserialize)]
struct ScenarioMessage {
    #[serde(default)]
    id: Option<String>,
    role: MessageRole,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum MessageRole {
    User,
    Assistant,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptControl {
    chunks: Vec<String>,
    #[serde(default)]
    tool_steps: Vec<ToolStep>,
    #[serde(default)]
    delay_ms: u64,
    #[serde(default = "default_success")]
    succeed: bool,
    #[serde(default)]
    hold: bool,
    #[serde(default)]
    hold_before_chunks: bool,
    #[serde(default)]
    request_permission: bool,
    #[serde(default)]
    separate_messages: bool,
    message_id: String,
}

#[derive(Debug, Deserialize)]
struct ToolStep {
    update: SessionUpdate,
    #[serde(default)]
    hold: bool,
}

fn default_success() -> bool {
    true
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let scenario_path = required_path(SCENARIO_ENV)?;
    let control_path = required_path(CONTROL_ENV)?;
    let scenario: Arc<Scenario> =
        Arc::new(serde_json::from_slice(&fs::read(&scenario_path).await?)?);
    let stdin = futures_util::stream::try_unfold(
        BufReader::new(tokio::io::stdin()).lines(),
        |mut lines| async move {
            let line = lines.next_line().await?;
            Ok::<_, std::io::Error>(line.map(|line| (line, lines)))
        },
    );
    let stdout =
        futures_util::sink::unfold(tokio::io::stdout(), |mut writer, line: String| async move {
            writer.write_all(line.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await?;
            Ok::<_, std::io::Error>(writer)
        });
    let transport = Lines::new(stdout, stdin);

    scenario_agent(scenario, control_path)
        .connect_to(transport)
        .await?;
    Ok(())
}

fn scenario_agent(
    scenario: Arc<Scenario>,
    control_path: PathBuf,
) -> impl ConnectTo<agent_client_protocol::Client> {
    let deleted_sessions = Arc::new(RwLock::new(HashSet::<String>::new()));
    let live_history = Arc::new(LiveHistory::default());
    Agent
        .builder()
        .on_receive_request(
            async |request: InitializeRequest, responder, _| {
                let capabilities = AgentCapabilities::new()
                    .load_session(true)
                    .session_capabilities(
                        SessionCapabilities::new()
                            .list(SessionListCapabilities::new())
                            .delete(SessionDeleteCapabilities::new())
                            .resume(SessionResumeCapabilities::new()),
                    );
                let mut response = InitializeResponse::new(request.protocol_version)
                    .agent_capabilities(capabilities);
                response.meta = Some(
                    serde_json::from_value(serde_json::json!({
                        "dappercode.dev": {
                            "version": 1,
                            "capabilities": {
                                "sessionSteer": {"method": STEER_METHOD, "version": 1},
                                "sessionFork": {"method": FORK_METHOD, "version": 1}
                            }
                        }
                    }))
                    .expect("valid DapperCode extension metadata"),
                );
                responder.respond(response)
            },
            on_receive_request!(),
        )
        .on_receive_request(
            {
                let scenario = Arc::clone(&scenario);
                let deleted_sessions = Arc::clone(&deleted_sessions);
                async move |_request: ListSessionsRequest, responder, _| {
                    let deleted = deleted_sessions.read().await;
                    responder.respond(ListSessionsResponse::new(
                        scenario
                            .chats
                            .iter()
                            .filter(|chat| !deleted.contains(&chat.id))
                            .map(|chat| {
                                let mut info = SessionInfo::new(
                                    chat.id.clone(),
                                    chat.cwd.as_deref().unwrap_or("/workspace/dappercode"),
                                )
                                .title(chat.title.clone());
                                if let Some(updated_at) = chat.updated_at {
                                    info = info.updated_at(
                                        chrono::DateTime::from_timestamp(updated_at, 0)
                                            .map(|value| value.to_rfc3339()),
                                    );
                                }
                                info
                            })
                            .collect(),
                    ))
                }
            },
            on_receive_request!(),
        )
        .on_receive_request(
            {
                let scenario = Arc::clone(&scenario);
                let deleted_sessions = Arc::clone(&deleted_sessions);
                let live_history = Arc::clone(&live_history);
                async move |request: LoadSessionRequest, responder, connection| {
                    if deleted_sessions
                        .read()
                        .await
                        .contains(request.session_id.0.as_ref())
                    {
                        return responder
                            .respond_with_error(agent_client_protocol::Error::invalid_params());
                    }
                    replay_chat(
                        &scenario,
                        &live_history,
                        request.session_id.0.as_ref(),
                        &connection,
                    )
                    .await?;
                    responder.respond(LoadSessionResponse::new())
                }
            },
            on_receive_request!(),
        )
        .on_receive_request(
            {
                let scenario = Arc::clone(&scenario);
                let deleted_sessions = Arc::clone(&deleted_sessions);
                async move |request: ResumeSessionRequest, responder, connection| {
                    if deleted_sessions
                        .read()
                        .await
                        .contains(request.session_id.0.as_ref())
                    {
                        return responder
                            .respond_with_error(agent_client_protocol::Error::invalid_params());
                    }
                    send_chat_metadata(&scenario, request.session_id.0.as_ref(), &connection)?;
                    responder.respond(ResumeSessionResponse::new())
                }
            },
            on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: NewSessionRequest, responder, _| {
                responder.respond(NewSessionResponse::new("e2e-new-session"))
            },
            on_receive_request!(),
        )
        .on_receive_request(
            {
                let live_history = Arc::clone(&live_history);
                async move |request: DeleteSessionRequest, responder, _| {
                    deleted_sessions
                        .write()
                        .await
                        .insert(request.session_id.to_string());
                    live_history
                        .write()
                        .await
                        .remove(request.session_id.0.as_ref());
                    responder.respond(DeleteSessionResponse::new())
                }
            },
            on_receive_request!(),
        )
        .on_receive_request(
            {
                let control_path = control_path.clone();
                async move |request: PromptRequest, responder, connection| {
                    let control: PromptControl = serde_json::from_slice(
                        &fs::read(&control_path)
                            .await
                            .map_err(agent_client_protocol::Error::into_internal_error)?,
                    )
                    .map_err(agent_client_protocol::Error::into_internal_error)?;
                    {
                        let mut history = live_history.write().await;
                        let updates = history.entry(request.session_id.to_string()).or_default();
                        let message_id = format!("{}-prompt-{}", request.session_id, updates.len());
                        updates.extend(request.prompt.iter().cloned().map(|content| {
                            SessionUpdate::UserMessageChunk(
                                ContentChunk::new(content)
                                    .message_id(MessageId::new(message_id.clone())),
                            )
                        }));
                    }
                    for (index, step) in control.tool_steps.iter().enumerate() {
                        record_and_send(
                            &live_history,
                            SessionNotification::new(
                                request.session_id.clone(),
                                step.update.clone(),
                            ),
                            &connection,
                        )
                        .await?;
                        if step.hold {
                            wait_for_release(&control_path, &format!("tool-{index}.")).await?;
                        }
                    }
                    if control.request_permission {
                        let live_history = Arc::clone(&live_history);
                        let control_path = control_path.clone();
                        let output_connection = connection.clone();
                        return connection
                            .send_request(RequestPermissionRequest::new(
                                request.session_id.clone(),
                                ToolCallUpdate::new(
                                    "fixture-permission",
                                    ToolCallUpdateFields::new()
                                        .title("Approve deterministic fixture operation")
                                        .kind(ToolKind::Execute)
                                        .status(ToolCallStatus::Pending),
                                ),
                                vec![PermissionOption::new(
                                    "allow",
                                    "Allow once",
                                    PermissionOptionKind::AllowOnce,
                                )],
                            ))
                            .on_receiving_result(async move |permission| {
                                let permission = permission
                                    .map_err(agent_client_protocol::Error::into_internal_error)?;
                                if !matches!(
                                    permission.outcome,
                                    RequestPermissionOutcome::Selected(selected)
                                        if selected.option_id.0.as_ref() == "allow"
                                ) {
                                    return responder
                                        .respond(PromptResponse::new(StopReason::Cancelled));
                                }
                                send_prompt_output(
                                    &control,
                                    &control_path,
                                    &live_history,
                                    &request.session_id,
                                    &output_connection,
                                )
                                .await?;
                                if control.succeed {
                                    responder.respond(PromptResponse::new(StopReason::EndTurn))
                                } else {
                                    responder.respond_with_error(
                                        agent_client_protocol::Error::internal_error(),
                                    )
                                }
                            });
                    }
                    send_prompt_output(
                        &control,
                        &control_path,
                        &live_history,
                        &request.session_id,
                        &connection,
                    )
                    .await?;
                    if control.succeed {
                        responder.respond(PromptResponse::new(StopReason::EndTurn))
                    } else {
                        responder.respond_with_error(agent_client_protocol::Error::internal_error())
                    }
                }
            },
            on_receive_request!(),
        )
        .on_receive_request(
            async |request: ForkRequest, responder, _| {
                responder.respond(ForkResponse {
                    session_id: agent_client_protocol::schema::v1::SessionId::new(format!(
                        "{}-fork",
                        request.session_id
                    )),
                    title: Some("Forked layout session".to_string()),
                })
            },
            on_receive_request!(),
        )
        .on_receive_request(
            async |_request: SteerRequest, responder, _| {
                responder.respond(SteerResponse { accepted: true })
            },
            on_receive_request!(),
        )
        .on_receive_notification(
            async |_notification: CancelNotification, _| Ok(()),
            on_receive_notification!(),
        )
}

async fn send_prompt_output(
    control: &PromptControl,
    control_path: &Path,
    live_history: &LiveHistory,
    session_id: &agent_client_protocol::schema::v1::SessionId,
    connection: &agent_client_protocol::ConnectionTo<agent_client_protocol::Client>,
) -> Result<(), agent_client_protocol::Error> {
    if control.hold_before_chunks {
        wait_for_release(control_path, "").await?;
    }
    for (index, chunk) in control.chunks.iter().enumerate() {
        if control.delay_ms > 0 {
            sleep(Duration::from_millis(control.delay_ms)).await;
        }
        record_and_send(
            live_history,
            SessionNotification::new(
                session_id.clone(),
                SessionUpdate::AgentMessageChunk(
                    ContentChunk::new(chunk.clone().into()).message_id(MessageId::new(
                        if control.separate_messages {
                            format!("{}-{index}", control.message_id)
                        } else {
                            control.message_id.clone()
                        },
                    )),
                ),
            ),
            connection,
        )
        .await?;
    }
    if control.hold {
        wait_for_release(control_path, "").await?;
    }
    Ok(())
}

fn required_path(name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let value = env::var(name)?;
    Ok(PathBuf::from(value))
}

async fn wait_for_release(
    control_path: &Path,
    checkpoint: &str,
) -> Result<(), agent_client_protocol::Error> {
    let holding = control_path.with_extension(format!("{checkpoint}holding"));
    let release = control_path.with_extension(format!("{checkpoint}release"));
    fs::write(&holding, b"holding")
        .await
        .map_err(agent_client_protocol::Error::into_internal_error)?;
    let deadline = Instant::now() + HOLD_TIMEOUT;
    while !fs::try_exists(&release)
        .await
        .map_err(agent_client_protocol::Error::into_internal_error)?
    {
        if Instant::now() >= deadline {
            return Err(agent_client_protocol::Error::internal_error());
        }
        sleep(Duration::from_millis(10)).await;
    }
    fs::remove_file(release)
        .await
        .map_err(agent_client_protocol::Error::into_internal_error)?;
    fs::remove_file(holding)
        .await
        .map_err(agent_client_protocol::Error::into_internal_error)?;
    Ok(())
}

async fn replay_chat(
    scenario: &Scenario,
    live_history: &LiveHistory,
    session_id: &str,
    connection: &agent_client_protocol::ConnectionTo<agent_client_protocol::Client>,
) -> Result<(), agent_client_protocol::Error> {
    if let Some(chat) = scenario.chats.iter().find(|chat| chat.id == session_id) {
        for (index, message) in chat.messages.iter().enumerate() {
            let message_id = message
                .id
                .clone()
                .unwrap_or_else(|| format!("{}-message-{index}", chat.id));
            let chunk = ContentChunk::new(message.text.clone().into())
                .message_id(MessageId::new(message_id));
            let update = match message.role {
                MessageRole::User => SessionUpdate::UserMessageChunk(chunk),
                MessageRole::Assistant => SessionUpdate::AgentMessageChunk(chunk),
            };
            connection
                .send_notification(SessionNotification::new(session_id.to_string(), update))?;
        }
    }
    for update in live_history
        .read()
        .await
        .get(session_id)
        .into_iter()
        .flatten()
    {
        connection.send_notification(SessionNotification::new(
            session_id.to_string(),
            update.clone(),
        ))?;
    }
    send_chat_metadata(scenario, session_id, connection)
}

async fn record_and_send(
    live_history: &LiveHistory,
    notification: SessionNotification,
    connection: &agent_client_protocol::ConnectionTo<agent_client_protocol::Client>,
) -> Result<(), agent_client_protocol::Error> {
    live_history
        .write()
        .await
        .entry(notification.session_id.to_string())
        .or_default()
        .push(notification.update.clone());
    connection.send_notification(notification)?;
    Ok(())
}

fn send_chat_metadata(
    scenario: &Scenario,
    session_id: &str,
    connection: &agent_client_protocol::ConnectionTo<agent_client_protocol::Client>,
) -> Result<(), agent_client_protocol::Error> {
    let Some(chat) = scenario.chats.iter().find(|chat| chat.id == session_id) else {
        return Ok(());
    };
    let update = serde_json::from_value(serde_json::json!({
        "sessionUpdate": "session_info_update",
        "title": chat.title,
        "updatedAt": chat.updated_at
            .and_then(|timestamp| chrono::DateTime::from_timestamp(timestamp, 0))
            .map(|timestamp| timestamp.to_rfc3339()),
    }))
    .map_err(agent_client_protocol::Error::into_internal_error)?;
    connection.send_notification(SessionNotification::new(session_id.to_string(), update))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn permission_response_releases_the_fixture_prompt() {
        use agent_client_protocol::schema::v1::{
            RequestPermissionResponse, SelectedPermissionOutcome,
        };

        let directory = std::env::temp_dir().join(format!(
            "dappercode-e2e-permission-fixture-{}",
            uuid::Uuid::new_v4()
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
                .builder()
                .on_receive_request(
                    async |_: RequestPermissionRequest, responder, _| {
                        responder.respond(RequestPermissionResponse::new(
                            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                                "allow",
                            )),
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
            StopReason::EndTurn
        );
    }

    #[tokio::test]
    async fn completed_prompts_replay_once_with_followups_and_tool_updates() {
        let directory = std::env::temp_dir().join(format!(
            "dappercode-e2e-history-fixture-{}",
            uuid::Uuid::new_v4()
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
                .builder()
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
            "follow-up reload must also be idempotent"
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
                .builder()
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
}
