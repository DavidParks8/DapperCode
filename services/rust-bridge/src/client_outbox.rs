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
#[path = "client_outbox_tests.rs"]
mod tests;
