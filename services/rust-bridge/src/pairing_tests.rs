use super::{wait_for_shutdown_trigger, watch};

#[tokio::test]
async fn shutdown_wait_returns_when_channel_closes_before_triggering() {
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    drop(shutdown_tx);

    wait_for_shutdown_trigger(&mut shutdown_rx).await;
    assert!(!*shutdown_rx.borrow());
}
