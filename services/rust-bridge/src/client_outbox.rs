use axum::extract::ws::Message;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(super) struct ClientOutbox {
    sender: mpsc::Sender<Message>,
    cancellation: CancellationToken,
}

pub(super) struct ClientOutboxReceiver {
    receiver: mpsc::Receiver<Message>,
}

pub(super) fn client_outbox(capacity: usize) -> (ClientOutbox, ClientOutboxReceiver) {
    let (sender, receiver) = mpsc::channel(capacity);
    (
        ClientOutbox {
            sender,
            cancellation: CancellationToken::new(),
        },
        ClientOutboxReceiver { receiver },
    )
}

impl ClientOutbox {
    pub(super) fn try_send(
        &self,
        message: Message,
    ) -> Result<(), mpsc::error::TrySendError<Message>> {
        if self.cancellation.is_cancelled() {
            return Err(mpsc::error::TrySendError::Closed(message));
        }
        self.sender.try_send(message)
    }

    pub(super) async fn send(&self, message: Message) -> Result<(), ()> {
        if self.cancellation.is_cancelled() {
            return Err(());
        }
        let permit = tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => return Err(()),
            permit = self.sender.reserve() => match permit {
                Ok(permit) => permit,
                Err(_) => return Err(()),
            },
        };
        if self.cancellation.is_cancelled() {
            return Err(());
        }
        permit.send(message);
        Ok(())
    }

    pub(super) fn disconnect(&self) {
        self.cancellation.cancel();
    }

    #[cfg(test)]
    pub(super) fn is_disconnected(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    pub(super) async fn disconnected(&self) {
        self.cancellation.cancelled().await;
    }
}

impl ClientOutboxReceiver {
    pub(super) async fn recv(&mut self) -> Option<Message> {
        self.receiver.recv().await
    }

    #[cfg(test)]
    pub(super) fn try_recv(&mut self) -> Result<Message, mpsc::error::TryRecvError> {
        self.receiver.try_recv()
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    #[tokio::test]
    async fn disconnect_wakes_a_sender_waiting_for_capacity() {
        let (outbox, _receiver) = client_outbox(1);
        outbox
            .try_send(Message::Text("full".into()))
            .expect("first message");
        let blocked = {
            let outbox = outbox.clone();
            tokio::spawn(async move { outbox.send(Message::Text("blocked".into())).await })
        };
        tokio::task::yield_now().await;
        assert!(!blocked.is_finished());

        outbox.disconnect();

        assert!(outbox.is_disconnected());
        assert!(matches!(
            outbox.try_send(Message::Text("closed".into())),
            Err(mpsc::error::TrySendError::Closed(_))
        ));
        assert_eq!(
            timeout(Duration::from_millis(100), blocked)
                .await
                .expect("blocked sender wakes")
                .expect("sender task"),
            Err(())
        );
    }
}
