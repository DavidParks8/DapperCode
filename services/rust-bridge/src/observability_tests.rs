use super::{OperationalMetrics, RECENT_ERROR_LIMIT};

#[test]
fn recent_errors_are_bounded_and_payload_free() {
    let metrics = OperationalMetrics::new();
    for index in 0..40 {
        metrics.record_error(
            None,
            Some("turn/start"),
            Some("codex"),
            format!("kind_{index}"),
        );
    }
    let errors = metrics.recent_errors();
    assert_eq!(errors.len(), RECENT_ERROR_LIMIT);
    assert_eq!(
        errors.first().map(|entry| entry.kind.as_str()),
        Some("kind_8"),
    );
}

#[test]
fn request_counts_track_terminal_outcomes() {
    let metrics = OperationalMetrics::new();
    let completed = metrics.start_request("bridge/capabilities/read", "bridge");
    metrics.finish_request(&completed, "ok");
    let timed_out = metrics.start_request("thread/read", "codex");
    metrics.finish_request(&timed_out, "timeout");
    let snapshot = metrics.request_snapshot();
    assert_eq!(snapshot.total, 2);
    assert_eq!(snapshot.completed, 1);
    assert_eq!(snapshot.failed, 1);
    assert_eq!(snapshot.timed_out, 1);
    assert_eq!(snapshot.pending, 0);
}

#[test]
fn request_failure_and_pending_snapshots_are_distinct() {
    let metrics = OperationalMetrics::new();
    let pending = metrics.start_request("thread/read", "codex");
    let failed = metrics.start_request("turn/start", "codex");
    metrics.finish_request(&failed, "backend_error");

    let snapshot = metrics.request_snapshot();
    assert_eq!(snapshot.total, 2);
    assert_eq!(snapshot.completed, 0);
    assert_eq!(snapshot.failed, 1);
    assert_eq!(snapshot.pending, 1);
    assert!(!pending.request_id.is_empty());
}

#[test]
fn push_metrics_cover_accepted_partial_and_transport_failures() {
    let metrics = OperationalMetrics::new();
    let empty = metrics.push_snapshot();
    assert!(empty.last_outcome.is_none());
    assert!(empty.last_outcome_at.is_none());

    metrics.push_attempted(5);
    metrics.push_outcome(2, 0);
    assert_eq!(
        metrics.push_snapshot().last_outcome.as_deref(),
        Some("accepted"),
    );
    metrics.push_outcome(1, 1);
    assert_eq!(
        metrics.push_snapshot().last_outcome.as_deref(),
        Some("partial_failure"),
    );
    metrics.push_transport_failure(2);
    metrics.push_receipt_error();

    let snapshot = metrics.push_snapshot();
    assert_eq!(snapshot.attempted, 5);
    assert_eq!(snapshot.accepted, 3);
    assert_eq!(snapshot.failed, 3);
    assert_eq!(snapshot.receipt_errors, 1);
    assert_eq!(snapshot.last_outcome.as_deref(), Some("transport_failure"));
    assert!(snapshot.last_outcome_at.is_some());
    assert_eq!(metrics.recent_errors().len(), 1);
}
