use std::time::Duration;

use agent_client_protocol::{Agent, Channel, Client, ConnectTo, ConnectionDriver, Error};
use tokio::sync::oneshot;

pub(super) struct DrainTransport<T> {
    pub(super) transport: T,
    pub(super) timeout: Duration,
}

impl<T: ConnectTo<Client>> ConnectTo<Client> for DrainTransport<T> {
    async fn connect_to(self, client: impl ConnectTo<Agent>) -> Result<(), Error> {
        self.transport.connect_to(client).await
    }

    fn into_channel_and_future(self) -> (Channel, Option<ConnectionDriver>) {
        let (channel, peer) = Channel::duplex();
        let (finish_tx, finish_rx) = oneshot::channel();
        let work = async move {
            let driver = self.transport.connect_to(peer);
            tokio::pin!(driver);
            tokio::select! {
                result = &mut driver => result,
                finish = finish_rx => {
                    if finish.is_err() {
                        return driver.await;
                    }
                    tokio::time::timeout(self.timeout, driver)
                        .await
                        .map_err(|_| Error::internal_error().data("ACP transport drain timed out"))?
                }
            }
        };
        // The SDK closes the channel after handing off queued responses, before requesting finish.
        let driver = ConnectionDriver::with_finish(work, move || {
            let _ = finish_tx.send(());
        });
        (channel, Some(driver))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
            Some(true)
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
            Some(serde_json::json!("ACP transport drain timed out"))
        );
    }
}
