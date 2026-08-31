use std::{env, path::PathBuf, sync::Arc, time::Duration};

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
    Agent, Lines,
};
use serde::Deserialize;
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    time::{sleep, Instant},
};

const SCENARIO_ENV: &str = "DAPPERCODE_E2E_SCENARIO_PATH";
const CONTROL_ENV: &str = "DAPPERCODE_E2E_CONTROL_PATH";
const HOLD_TIMEOUT: Duration = Duration::from_secs(30);

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
    delay_ms: u64,
    #[serde(default = "default_success")]
    succeed: bool,
    #[serde(default)]
    hold: bool,
    message_id: String,
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
                responder.respond(
                    InitializeResponse::new(request.protocol_version)
                        .agent_capabilities(capabilities),
                )
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
                    for chunk in &control.chunks {
                        if control.delay_ms > 0 {
                            sleep(Duration::from_millis(control.delay_ms)).await;
                        }
                        connection.send_notification(SessionNotification::new(
                            request.session_id.clone(),
                            SessionUpdate::AgentMessageChunk(
                                ContentChunk::new(chunk.clone().into())
                                    .message_id(MessageId::new(control.message_id.clone())),
                            ),
                        ))?;
                    }
                    if control.hold {
                        let holding = control_path.with_extension("holding");
                        let release = control_path.with_extension("release");
                        fs::write(&holding, b"holding")
                            .await
                            .map_err(agent_client_protocol::Error::into_internal_error)?;
                        let deadline = Instant::now() + HOLD_TIMEOUT;
                        while !fs::try_exists(&release)
                            .await
                            .map_err(agent_client_protocol::Error::into_internal_error)?
                        {
                            if Instant::now() >= deadline {
                                return responder.respond_with_error(
                                    agent_client_protocol::Error::internal_error(),
                                );
                            }
                            sleep(Duration::from_millis(10)).await;
                        }
                        let _ = fs::remove_file(release).await;
                        let _ = fs::remove_file(holding).await;
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
