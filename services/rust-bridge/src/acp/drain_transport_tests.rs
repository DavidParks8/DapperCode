use super::{Agent, Client, ConnectTo, DrainTransport, Duration, Error};
use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

#[derive(Clone, Debug, Deserialize, Serialize, JsonRpcRequest)]
#[request(method = "test/start", response = StartResponse)]
struct Start {}

#[derive(Clone, Debug, Deserialize, Serialize, JsonRpcResponse)]
struct StartResponse {}

#[derive(Clone, Debug, Deserialize, Serialize, JsonRpcRequest)]
#[request(method = "test/approval", response = ApprovalResponse)]
struct Approval {}

#[derive(Clone, Debug, Deserialize, Serialize, JsonRpcResponse)]
struct ApprovalResponse {
    cancelled: bool,
}

#[tokio::test]
async fn shutdown_delivers_queued_responses_before_the_agent_stops() {
    let (outcomes_tx, mut outcomes_rx) = mpsc::unbounded_channel();
    let (starts_tx, mut starts_rx) = mpsc::unbounded_channel();
    let agent = Agent.v1().on_receive_request(
        async move |_: Start, responder, connection| {
            connection.send_request(Approval {}).on_receiving_result({
                let outcomes_tx = outcomes_tx.clone();
                async move |result| {
                    let response: ApprovalResponse = result?;
                    let _ = outcomes_tx.send(response.cancelled);
                    Ok(())
                }
            })?;
            let _ = starts_tx.send(responder);
            Ok(())
        },
        agent_client_protocol::on_receive_request!(),
    );
    let (approvals_tx, mut approvals_rx) = mpsc::unbounded_channel();
    Client
        .v1()
        .on_receive_request(
            async move |_: Approval, responder, _| {
                let _ = approvals_tx.send(responder);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(
            DrainTransport {
                transport: agent,
                timeout: Duration::from_secs(1),
            },
            async move |connection| {
                connection.send_request(Start {}).detach();
                let responder = approvals_rx
                    .recv()
                    .await
                    .ok_or_else(|| Error::internal_error().data("approval was not received"))?;
                responder.respond(ApprovalResponse { cancelled: true })
            },
        )
        .await
        .expect("client shuts down");
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), outcomes_rx.recv())
            .await
            .expect("agent received the response"),
        Some(true),
    );
    assert!(starts_rx.recv().await.is_some());
}

struct NeverFinishes;

impl ConnectTo<Client> for NeverFinishes {
    async fn connect_to(self, _client: impl ConnectTo<Agent>) -> Result<(), Error> {
        std::future::pending().await
    }
}

#[tokio::test]
async fn shutdown_reports_a_transport_that_cannot_finish() {
    let (channel, driver) = DrainTransport {
        transport: NeverFinishes,
        timeout: Duration::from_millis(25),
    }
    .into_channel_and_future();
    drop(channel);
    let mut driver = driver.expect("transport driver");
    assert!(driver.request_finish());
    let error = tokio::time::timeout(Duration::from_secs(1), driver)
        .await
        .expect("drain is bounded")
        .expect_err("stuck transport must fail");
    assert_eq!(
        error.data,
        Some(serde_json::json!("ACP transport drain timed out")),
    );
}
