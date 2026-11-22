use super::{client_outbox, mpsc, Message};
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
        Err(()),
    );
}

#[tokio::test]
async fn messages_are_delivered_and_closed_receivers_reject_sends() {
    let (outbox, mut receiver) = client_outbox(1);
    outbox
        .send(Message::Text("delivered".into()))
        .await
        .expect("message sends");
    assert_eq!(
        receiver.recv().await,
        Some(Message::Text("delivered".into())),
    );
    drop(receiver);
    assert_eq!(outbox.send(Message::Text("closed".into())).await, Err(()));
}
