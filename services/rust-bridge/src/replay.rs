use axum::extract::ws::Message;
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::RwLock;

#[derive(Clone)]
struct ReplayableNotification {
    event_id: u64,
    payload: Message,
    bytes: usize,
}

pub(crate) struct NotificationReplay {
    capacity: usize,
    max_bytes: usize,
    entries: RwLock<VecDeque<ReplayableNotification>>,
    dropped_oversize: AtomicU64,
    evicted: AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplayStatus {
    pub(crate) capacity: usize,
    pub(crate) max_bytes: usize,
    pub(crate) entries: usize,
    pub(crate) bytes: usize,
    pub(crate) earliest_event_id: Option<u64>,
    pub(crate) latest_event_id: Option<u64>,
    pub(crate) dropped_oversize: u64,
    pub(crate) evicted: u64,
    pub(crate) client_queue_drops: u64,
}

impl NotificationReplay {
    pub(crate) fn new(capacity: usize, max_bytes: usize) -> Self {
        Self {
            capacity,
            max_bytes,
            entries: RwLock::new(VecDeque::new()),
            dropped_oversize: AtomicU64::new(0),
            evicted: AtomicU64::new(0),
        }
    }

    pub(crate) async fn push(&self, event_id: u64, payload: Message, bytes: usize) {
        if self.capacity == 0 || bytes > self.max_bytes {
            self.dropped_oversize.fetch_add(1, Ordering::Relaxed);
            return;
        }

        let mut entries = self.entries.write().await;
        entries.push_back(ReplayableNotification {
            event_id,
            payload,
            bytes,
        });
        let mut total_bytes = entries.iter().map(|entry| entry.bytes).sum::<usize>();
        while entries.len() > self.capacity || total_bytes > self.max_bytes {
            let removed = entries
                .pop_front()
                .expect("replay eviction requires a non-empty buffer");
            total_bytes = total_bytes.saturating_sub(removed.bytes);
            self.evicted.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub(crate) async fn since(
        &self,
        after_event_id: Option<u64>,
        limit: usize,
        max_bytes: usize,
    ) -> (Vec<Value>, bool, usize) {
        let after = after_event_id.unwrap_or(0);
        let entries = self.entries.read().await;
        let mut events = Vec::new();
        let mut has_more = false;
        let mut response_bytes = 0usize;

        for entry in entries.iter() {
            if entry.event_id <= after {
                continue;
            }

            if events.len() >= limit || response_bytes.saturating_add(entry.bytes) > max_bytes {
                has_more = true;
                break;
            }

            let Message::Text(text) = &entry.payload else {
                unreachable!("notification replay only stores JSON text messages");
            };
            events.push(
                serde_json::from_str(text.as_str())
                    .expect("replayed notification JSON remains valid"),
            );
            response_bytes += entry.bytes;
        }

        (events, has_more, response_bytes)
    }

    pub(crate) async fn earliest_event_id(&self) -> Option<u64> {
        self.entries
            .read()
            .await
            .front()
            .map(|entry| entry.event_id)
    }

    pub(crate) async fn status(&self, client_queue_drops: u64) -> ReplayStatus {
        let entries = self.entries.read().await;
        ReplayStatus {
            capacity: self.capacity,
            max_bytes: self.max_bytes,
            entries: entries.len(),
            bytes: entries.iter().map(|entry| entry.bytes).sum(),
            earliest_event_id: entries.front().map(|entry| entry.event_id),
            latest_event_id: entries.back().map(|entry| entry.event_id),
            dropped_oversize: self.dropped_oversize.load(Ordering::Relaxed),
            evicted: self.evicted.load(Ordering::Relaxed),
            client_queue_drops,
        }
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "replay_tests.rs"]
mod tests;
