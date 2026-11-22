use super::{canonical_event_channel, CanonicalEvent};

fn ignored(kind: &str) -> CanonicalEvent {
    CanonicalEvent::Ignored {
        agent_id: "agent".into(),
        thread_id: None,
        kind: kind.into(),
    }
}

#[tokio::test]
async fn mailbox_flushes_in_order_and_reports_closed_endpoints() {
    let (sender, mut receiver) = canonical_event_channel(2);
    sender.send(ignored("before")).await.expect("send event");
    let flush = {
        let sender = sender.clone();
        tokio::spawn(async move { sender.flush().await })
    };
    assert!(
        matches!(receiver.recv().await, Some(CanonicalEvent::Ignored { kind, .. }) if kind == "before"),
    );
    let receive_after_flush = {
        let mut receiver = receiver;
        tokio::spawn(async move {
            let event = receiver.recv().await;
            (receiver, event)
        })
    };
    tokio::task::yield_now().await;
    assert!(flush.await.expect("flush task").is_ok());
    sender
        .send(ignored("after"))
        .await
        .expect("send after flush");
    let (receiver, event) = receive_after_flush.await.expect("receiver task");
    assert!(matches!(event, Some(CanonicalEvent::Ignored { kind, .. }) if kind == "after"));
    drop(receiver);
    assert!(sender.send(ignored("closed")).await.is_err());
    assert!(sender.flush().await.is_err());

    let (sender, mut receiver) = canonical_event_channel(1);
    drop(sender);
    assert!(receiver.recv().await.is_none());
    assert!(receiver.try_recv().is_err());
}
