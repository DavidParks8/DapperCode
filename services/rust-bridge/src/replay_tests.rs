use super::NotificationReplay;
use axum::extract::ws::Message;
use serde_json::json;

fn message(value: serde_json::Value) -> Message {
    Message::Text(serde_json::to_string(&value).unwrap().into())
}

#[tokio::test]
async fn evicts_by_total_bytes_and_bounds_response_bytes() {
    let replay = NotificationReplay::new(10, 10);
    replay.push(1, message(json!({ "id": 1 })), 6).await;
    replay.push(2, message(json!({ "id": 2 })), 4).await;
    assert_eq!(replay.earliest_event_id().await, Some(1));

    replay.push(3, message(json!({ "id": 3 })), 1).await;
    assert_eq!(replay.earliest_event_id().await, Some(2));

    let (events, has_more, bytes) = replay.since(None, 10, 4).await;
    assert_eq!(events, vec![json!({ "id": 2 })]);
    assert!(has_more);
    assert_eq!(bytes, 4);
}

#[tokio::test]
async fn drops_single_entry_larger_than_storage_budget() {
    let replay = NotificationReplay::new(10, 4);
    replay.push(1, message(json!({ "id": 1 })), 5).await;
    assert_eq!(replay.earliest_event_id().await, None);
    assert_eq!(replay.status(0).await.dropped_oversize, 1);
}

#[tokio::test]
async fn zero_capacity_drops_and_since_skips_the_cursor() {
    let disabled = NotificationReplay::new(0, 100);
    disabled.push(1, message(json!({ "id": 1 })), 1).await;
    assert_eq!(disabled.status(7).await.dropped_oversize, 1);
    assert_eq!(disabled.status(7).await.client_queue_drops, 7);

    let replay = NotificationReplay::new(3, 100);
    replay.push(1, message(json!({ "id": 1 })), 2).await;
    replay.push(2, message(json!({ "id": 2 })), 2).await;
    replay.push(3, message(json!({ "id": 3 })), 2).await;
    let (events, has_more, bytes) = replay.since(Some(1), 1, 100).await;
    assert_eq!(events, vec![json!({ "id": 2 })]);
    assert!(has_more);
    assert_eq!(bytes, 2);

    let count_bounded = NotificationReplay::new(1, 100);
    count_bounded.push(1, message(json!({ "id": 1 })), 1).await;
    count_bounded.push(2, message(json!({ "id": 2 })), 1).await;
    assert_eq!(count_bounded.earliest_event_id().await, Some(2));
    assert_eq!(count_bounded.status(0).await.evicted, 1);

    let status = replay.status(0).await;
    assert_eq!(status.latest_event_id, Some(3));
    assert_eq!(status.bytes, 6);

    let (remaining, has_more, bytes) = replay.since(Some(2), 10, 100).await;
    assert_eq!(remaining, vec![json!({ "id": 3 })]);
    assert!(!has_more);
    assert_eq!(bytes, 2);
}
