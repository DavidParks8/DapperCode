use std::time::Duration;

use agent_client_protocol::{Agent, Channel, Client, ConnectTo, ConnectionDriver, Error};
use tokio::sync::oneshot;

pub(super) struct DrainTransport<Transport> {
    pub(super) transport: Transport,
    pub(super) timeout: Duration,
}

impl<Transport: ConnectTo<Client>> ConnectTo<Client> for DrainTransport<Transport> {
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
#[path = "drain_transport_tests.rs"]
mod tests;
