use crate::now_iso;
use serde::Serialize;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use uuid::Uuid;

const RECENT_ERROR_LIMIT: usize = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationalError {
    at: String,
    request_id: Option<String>,
    method: Option<String>,
    backend: Option<String>,
    kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestMetrics {
    pub(crate) total: u64,
    pub(crate) completed: u64,
    pub(crate) failed: u64,
    pub(crate) timed_out: u64,
    pub(crate) pending: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PushMetrics {
    pub(crate) attempted: u64,
    pub(crate) accepted: u64,
    pub(crate) failed: u64,
    pub(crate) receipt_errors: u64,
    pub(crate) last_outcome_at: Option<String>,
    pub(crate) last_outcome: Option<String>,
}

pub(crate) struct RequestTrace {
    pub(crate) request_id: String,
    pub(crate) method: String,
    pub(crate) backend: String,
    pub(crate) started_at: Instant,
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
pub(crate) struct OperationalMetrics {
    requests_total: AtomicU64,
    requests_active: AtomicU64,
    requests_completed: AtomicU64,
    requests_failed: AtomicU64,
    requests_timed_out: AtomicU64,
    push_attempted: AtomicU64,
    push_accepted: AtomicU64,
    push_failed: AtomicU64,
    push_receipt_errors: AtomicU64,
    push_last_outcome: Mutex<Option<(String, String)>>,
    recent_errors: Mutex<VecDeque<OperationalError>>,
}

impl OperationalMetrics {
    pub(crate) fn new() -> Self {
        Self {
            requests_total: AtomicU64::new(0),
            requests_active: AtomicU64::new(0),
            requests_completed: AtomicU64::new(0),
            requests_failed: AtomicU64::new(0),
            requests_timed_out: AtomicU64::new(0),
            push_attempted: AtomicU64::new(0),
            push_accepted: AtomicU64::new(0),
            push_failed: AtomicU64::new(0),
            push_receipt_errors: AtomicU64::new(0),
            push_last_outcome: Mutex::new(None),
            recent_errors: Mutex::new(VecDeque::with_capacity(RECENT_ERROR_LIMIT)),
        }
    }

    pub(crate) fn start_request(&self, method: &str, backend: &str) -> RequestTrace {
        self.requests_total.fetch_add(1, Ordering::Relaxed);
        self.requests_active.fetch_add(1, Ordering::AcqRel);
        let trace = RequestTrace {
            request_id: Uuid::new_v4().to_string(),
            method: method.to_string(),
            backend: backend.to_string(),
            started_at: Instant::now(),
        };
        structured_log(
            "info",
            "request_started",
            Some(&trace.request_id),
            Some(method),
            Some(backend),
            None,
            None,
        );
        trace
    }

    pub(crate) fn finish_request(&self, trace: &RequestTrace, outcome: &str) {
        self.requests_active.fetch_sub(1, Ordering::AcqRel);
        if outcome == "ok" {
            self.requests_completed.fetch_add(1, Ordering::Relaxed);
        } else {
            self.requests_failed.fetch_add(1, Ordering::Relaxed);
            if outcome == "timeout" {
                self.requests_timed_out.fetch_add(1, Ordering::Relaxed);
                self.record_error(
                    Some(&trace.request_id),
                    Some(&trace.method),
                    Some(&trace.backend),
                    "request_timeout",
                );
            }
        }
        structured_log(
            if outcome == "ok" { "info" } else { "warn" },
            "request_finished",
            Some(&trace.request_id),
            Some(&trace.method),
            Some(&trace.backend),
            Some(u64::try_from(trace.started_at.elapsed().as_millis()).unwrap_or(u64::MAX)),
            Some(outcome),
        );
    }

    pub(crate) fn record_error(
        &self,
        request_id: Option<&str>,
        method: Option<&str>,
        backend: Option<&str>,
        kind: impl Into<String>,
    ) {
        let error = OperationalError {
            at: now_iso(),
            request_id: request_id.map(str::to_string),
            method: method.map(str::to_string),
            backend: backend.map(str::to_string),
            kind: kind.into(),
        };
        let mut recent = self
            .recent_errors
            .lock()
            .unwrap_or_else(|entry| entry.into_inner());
        if recent.len() == RECENT_ERROR_LIMIT {
            recent.pop_front();
        }
        recent.push_back(error);
    }

    pub(crate) fn request_snapshot(&self) -> RequestMetrics {
        let total = self.requests_total.load(Ordering::Relaxed);
        let completed = self.requests_completed.load(Ordering::Relaxed);
        let failed = self.requests_failed.load(Ordering::Relaxed);
        RequestMetrics {
            total,
            completed,
            failed,
            timed_out: self.requests_timed_out.load(Ordering::Relaxed),
            pending: self.requests_active.load(Ordering::Acquire),
        }
    }

    pub(crate) fn recent_errors(&self) -> Vec<OperationalError> {
        self.recent_errors
            .lock()
            .unwrap_or_else(|entry| entry.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    pub(crate) fn push_attempted(&self, count: usize) {
        self.push_attempted
            .fetch_add(count as u64, Ordering::Relaxed);
    }

    pub(crate) fn push_outcome(&self, accepted: usize, failed: usize) {
        self.push_accepted
            .fetch_add(accepted as u64, Ordering::Relaxed);
        self.push_failed.fetch_add(failed as u64, Ordering::Relaxed);
        let outcome = if failed == 0 {
            "accepted"
        } else {
            "partial_failure"
        };
        *self
            .push_last_outcome
            .lock()
            .unwrap_or_else(|entry| entry.into_inner()) = Some((now_iso(), outcome.to_string()));
    }

    pub(crate) fn push_transport_failure(&self, count: usize) {
        self.push_failed.fetch_add(count as u64, Ordering::Relaxed);
        *self
            .push_last_outcome
            .lock()
            .unwrap_or_else(|entry| entry.into_inner()) =
            Some((now_iso(), "transport_failure".to_string()));
        self.record_error(
            None,
            Some("push/send"),
            Some("expo"),
            "push_transport_failure",
        );
    }

    pub(crate) fn push_receipt_error(&self) {
        self.push_receipt_errors.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn push_snapshot(&self) -> PushMetrics {
        let outcome = self
            .push_last_outcome
            .lock()
            .unwrap_or_else(|entry| entry.into_inner())
            .clone();
        PushMetrics {
            attempted: self.push_attempted.load(Ordering::Relaxed),
            accepted: self.push_accepted.load(Ordering::Relaxed),
            failed: self.push_failed.load(Ordering::Relaxed),
            receipt_errors: self.push_receipt_errors.load(Ordering::Relaxed),
            last_outcome_at: outcome.as_ref().map(|entry| entry.0.clone()),
            last_outcome: outcome.map(|entry| entry.1),
        }
    }
}

fn structured_log(
    level: &str,
    event: &str,
    request_id: Option<&str>,
    method: Option<&str>,
    backend: Option<&str>,
    duration_ms: Option<u64>,
    outcome: Option<&str>,
) {
    eprintln!(
        "{}",
        json!({
            "timestamp": now_iso(),
            "level": level,
            "event": event,
            "requestId": request_id,
            "method": method,
            "backend": backend,
            "durationMs": duration_ms,
            "outcome": outcome,
        }),
    );
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "observability_tests.rs"]
mod tests;
