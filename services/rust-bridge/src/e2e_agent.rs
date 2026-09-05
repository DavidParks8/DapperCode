use std::{
    env,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use agent_client_protocol::{
    on_receive_notification, on_receive_request,
    schema::v1::{
        AgentCapabilities, CancelNotification, ContentChunk, InitializeRequest, InitializeResponse,
        ListSessionsRequest, ListSessionsResponse, LoadSessionRequest, LoadSessionResponse,
        MessageId, NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse,
        ResumeSessionRequest, ResumeSessionResponse, SessionCapabilities, SessionInfo,
        SessionListCapabilities, SessionNotification, SessionResumeCapabilities, SessionUpdate,
        StopReason,
    },
    Agent, JsonRpcRequest, JsonRpcResponse, Lines,
};
use serde::{Deserialize, Serialize};
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
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

    Agent
        .builder()
        .on_receive_request(
            async |request: InitializeRequest, responder, _| {
                let capabilities = AgentCapabilities::new()
                    .load_session(true)
                    .session_capabilities(
                        SessionCapabilities::new()
                            .list(SessionListCapabilities::new())
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
                async move |_request: ListSessionsRequest, responder, _| {
                    responder.respond(ListSessionsResponse::new(
                        scenario
                            .chats
                            .iter()
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
                async move |request: LoadSessionRequest, responder, connection| {
                    replay_chat(&scenario, request.session_id.0.as_ref(), &connection).await?;
                    responder.respond(LoadSessionResponse::new())
                }
            },
            on_receive_request!(),
        )
        .on_receive_request(
            {
                let scenario = Arc::clone(&scenario);
                async move |request: ResumeSessionRequest, responder, connection| {
                    replay_chat(&scenario, request.session_id.0.as_ref(), &connection).await?;
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
                let control_path = control_path.clone();
                async move |request: PromptRequest, responder, connection| {
                    let control: PromptControl = serde_json::from_slice(
                        &fs::read(&control_path)
                            .await
                            .map_err(agent_client_protocol::Error::into_internal_error)?,
                    )
                    .map_err(agent_client_protocol::Error::into_internal_error)?;
                    for (index, step) in control.tool_steps.iter().enumerate() {
                        connection.send_notification(SessionNotification::new(
                            request.session_id.clone(),
                            step.update.clone(),
                        ))?;
                        if step.hold {
                            wait_for_release(&control_path, &format!("tool-{index}.")).await?;
                        }
                    }
                    if control.hold_before_chunks {
                        wait_for_release(&control_path, "").await?;
                    }
                    for (index, chunk) in control.chunks.iter().enumerate() {
                        if control.delay_ms > 0 {
                            sleep(Duration::from_millis(control.delay_ms)).await;
                        }
                        connection.send_notification(SessionNotification::new(
                            request.session_id.clone(),
                            SessionUpdate::AgentMessageChunk(
                                ContentChunk::new(chunk.clone().into()).message_id(MessageId::new(
                                    if control.separate_messages {
                                        format!("{}-{index}", control.message_id)
                                    } else {
                                        control.message_id.clone()
                                    },
                                )),
                            ),
                        ))?;
                    }
                    if control.hold {
                        wait_for_release(&control_path, "").await?;
                    }
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
        .connect_to(transport)
        .await?;

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
    session_id: &str,
    connection: &agent_client_protocol::ConnectionTo<agent_client_protocol::Client>,
) -> Result<(), agent_client_protocol::Error> {
    let Some(chat) = scenario.chats.iter().find(|chat| chat.id == session_id) else {
        return Ok(());
    };
    for (index, message) in chat.messages.iter().enumerate() {
        let message_id = message
            .id
            .clone()
            .unwrap_or_else(|| format!("{}-message-{index}", chat.id));
        let chunk =
            ContentChunk::new(message.text.clone().into()).message_id(MessageId::new(message_id));
        let update = match message.role {
            MessageRole::User => SessionUpdate::UserMessageChunk(chunk),
            MessageRole::Assistant => SessionUpdate::AgentMessageChunk(chunk),
        };
        connection.send_notification(SessionNotification::new(session_id.to_string(), update))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
