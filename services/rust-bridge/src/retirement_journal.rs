use serde::de::{Error as _, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;
use uuid::Uuid;

const RETIREMENT_JOURNAL_VERSION: u32 = 2;
const RETIREMENT_ENTRY_VERSION: u32 = 1;
const RETIREMENT_JOURNAL_MAX_BYTES: usize = 1024 * 1024;
const RETIREMENT_JOURNAL_MAX_ENTRIES: usize = 256;
const RETIREMENT_JOURNAL_MAX_THREAD_IDS: usize = 4096;
const RETIREMENT_THREAD_ID_MAX_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RetirementPhase {
    Prepared,
    Deleted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRetirement {
    version: u32,
    phase: RetirementPhase,
    requested_thread_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deleted_thread_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RetirementJournalEntry {
    pub(crate) retirement_id: String,
    pub(crate) phase: RetirementPhase,
    pub(crate) requested_thread_ids: Vec<String>,
    pub(crate) deleted_thread_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetirementJournalState {
    version: u32,
    #[serde(deserialize_with = "deserialize_retirements")]
    retirements: BTreeMap<String, StoredRetirement>,
}

impl Default for RetirementJournalState {
    fn default() -> Self {
        Self {
            version: RETIREMENT_JOURNAL_VERSION,
            retirements: BTreeMap::new(),
        }
    }
}

fn deserialize_retirements<'de, De>(
    deserializer: De,
) -> Result<BTreeMap<String, StoredRetirement>, De::Error>
where
    De: Deserializer<'de>,
{
    struct RetirementsVisitor;

    impl<'de> Visitor<'de> for RetirementsVisitor {
        type Value = BTreeMap<String, StoredRetirement>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a map of unique retirement IDs")
        }

        fn visit_map<Access>(self, mut map: Access) -> Result<Self::Value, Access::Error>
        where
            Access: MapAccess<'de>,
        {
            let mut retirements = BTreeMap::new();
            while let Some((retirement_id, retirement)) = map.next_entry()? {
                if retirements.insert(retirement_id, retirement).is_some() {
                    return Err(Access::Error::custom(
                        "thread retirement journal contains a duplicate retirement ID",
                    ));
                }
            }
            Ok(retirements)
        }
    }

    deserializer.deserialize_map(RetirementsVisitor)
}

pub(crate) struct ThreadRetirementJournal {
    path: Option<PathBuf>,
    state: Mutex<RetirementJournalState>,
    #[cfg(test)]
    fail_next_persist: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    fail_persist: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    fail_remove: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    remove_attempts: std::sync::atomic::AtomicUsize,
}

impl ThreadRetirementJournal {
    pub(crate) async fn load(path: PathBuf) -> Result<Self, String> {
        let state = load_state(&path).await?;
        Ok(Self {
            path: Some(path),
            state: Mutex::new(state),
            #[cfg(test)]
            fail_next_persist: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            fail_persist: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            fail_remove: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            remove_attempts: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    #[cfg(test)]
    pub(crate) fn inert_for_test() -> Self {
        Self {
            path: None,
            state: Mutex::new(RetirementJournalState::default()),
            fail_next_persist: std::sync::atomic::AtomicBool::new(false),
            fail_persist: std::sync::atomic::AtomicBool::new(false),
            fail_remove: std::sync::atomic::AtomicBool::new(false),
            remove_attempts: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    pub(crate) async fn add_prepared(&self, thread_ids: &[String]) -> Result<String, String> {
        let requested_thread_ids = normalize_thread_ids(thread_ids)?;
        let mut state = self.state.lock().await;
        if state.retirements.len() >= RETIREMENT_JOURNAL_MAX_ENTRIES {
            return Err(format!(
                "thread retirement journal exceeds {RETIREMENT_JOURNAL_MAX_ENTRIES} entries",
            ));
        }
        let retirement_id = loop {
            let candidate = Uuid::new_v4().to_string();
            if !state.retirements.contains_key(&candidate) {
                break candidate;
            }
        };
        let mut next = state.clone();
        next.retirements.insert(
            retirement_id.clone(),
            StoredRetirement {
                version: RETIREMENT_ENTRY_VERSION,
                phase: RetirementPhase::Prepared,
                requested_thread_ids,
                deleted_thread_ids: None,
            },
        );
        self.persist(&next).await?;
        *state = next;
        Ok(retirement_id)
    }

    pub(crate) async fn mark_deleted(
        &self,
        retirement_id: &str,
        deleted_thread_ids: &[String],
    ) -> Result<Vec<String>, String> {
        let deleted_thread_ids = normalize_thread_ids(deleted_thread_ids)?;
        let mut state = self.state.lock().await;
        let stored = state
            .retirements
            .get(retirement_id)
            .ok_or_else(|| "thread retirement journal entry is missing".to_string())?;
        let mut complete_family = stored.requested_thread_ids.clone();
        complete_family.extend(deleted_thread_ids);
        if let Some(previous) = &stored.deleted_thread_ids {
            complete_family.extend(previous.iter().cloned());
        }
        complete_family.sort();
        complete_family.dedup();
        let mut next = state.clone();
        next.retirements.insert(
            retirement_id.to_string(),
            StoredRetirement {
                version: RETIREMENT_ENTRY_VERSION,
                phase: RetirementPhase::Deleted,
                requested_thread_ids: stored.requested_thread_ids.clone(),
                deleted_thread_ids: Some(complete_family.clone()),
            },
        );
        self.persist(&next).await?;
        *state = next;
        Ok(complete_family)
    }

    pub(crate) async fn remove(&self, retirement_ids: &[String]) -> Result<(), String> {
        #[cfg(test)]
        {
            self.remove_attempts
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            if self.fail_remove.load(std::sync::atomic::Ordering::Acquire) {
                return Err("injected thread retirement journal removal failure".to_string());
            }
        }
        let mut state = self.state.lock().await;
        if retirement_ids
            .iter()
            .all(|retirement_id| !state.retirements.contains_key(retirement_id))
        {
            return Ok(());
        }
        let mut next = state.clone();
        for retirement_id in retirement_ids {
            next.retirements.remove(retirement_id);
        }
        self.persist(&next).await?;
        *state = next;
        Ok(())
    }

    pub(crate) async fn entries(&self) -> Vec<RetirementJournalEntry> {
        let state = self.state.lock().await;
        state
            .retirements
            .iter()
            .map(|(retirement_id, retirement)| RetirementJournalEntry {
                retirement_id: retirement_id.clone(),
                phase: retirement.phase,
                requested_thread_ids: retirement.requested_thread_ids.clone(),
                deleted_thread_ids: retirement.deleted_thread_ids.clone().unwrap_or_default(),
            })
            .collect()
    }

    async fn persist(&self, state: &RetirementJournalState) -> Result<(), String> {
        #[cfg(test)]
        if self.fail_persist.load(std::sync::atomic::Ordering::Acquire)
            || self
                .fail_next_persist
                .swap(false, std::sync::atomic::Ordering::AcqRel)
        {
            return Err("injected thread retirement journal persistence failure".to_string());
        }
        let bytes = encode_state(state)?;
        if let Some(path) = &self.path {
            crate::storage::atomic_write_private(path, &bytes)
                .await
                .map_err(|error| format!("failed to persist thread retirement journal: {error}"))?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn fail_all_persists(&self, fail: bool) {
        self.fail_persist
            .store(fail, std::sync::atomic::Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn fail_all_removes(&self, fail: bool) {
        self.fail_remove
            .store(fail, std::sync::atomic::Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn remove_attempt_count(&self) -> usize {
        self.remove_attempts
            .load(std::sync::atomic::Ordering::Acquire)
    }
}

async fn load_state(path: &Path) -> Result<RetirementJournalState, String> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RetirementJournalState::default())
        }
        Err(error) => return Err(format!("failed to read thread retirement journal: {error}")),
    };
    if bytes.len() > RETIREMENT_JOURNAL_MAX_BYTES {
        return Err(format!(
            "thread retirement journal exceeds {RETIREMENT_JOURNAL_MAX_BYTES} bytes",
        ));
    }
    let state: RetirementJournalState = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid thread retirement journal: {error}"))?;
    validate_state(&state)?;
    encode_state(&state)?;
    Ok(state)
}

fn encode_state(state: &RetirementJournalState) -> Result<Vec<u8>, String> {
    validate_state(state)?;
    let bytes = serde_json::to_vec(state)
        .map_err(|error| format!("failed to serialize thread retirement journal: {error}"))?;
    if bytes.len() > RETIREMENT_JOURNAL_MAX_BYTES {
        return Err(format!(
            "thread retirement journal exceeds its {RETIREMENT_JOURNAL_MAX_BYTES}-byte budget",
        ));
    }
    Ok(bytes)
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn validate_state(state: &RetirementJournalState) -> Result<(), String> {
    if state.version != RETIREMENT_JOURNAL_VERSION {
        return Err(format!(
            "unsupported thread retirement journal version {}",
            state.version,
        ));
    }
    if state.retirements.len() > RETIREMENT_JOURNAL_MAX_ENTRIES {
        return Err(format!(
            "thread retirement journal exceeds {RETIREMENT_JOURNAL_MAX_ENTRIES} entries",
        ));
    }
    let mut total_thread_ids = 0_usize;
    for (retirement_id, retirement) in &state.retirements {
        validate_retirement_id(retirement_id)?;
        if retirement.version != RETIREMENT_ENTRY_VERSION {
            return Err(format!(
                "unsupported thread retirement journal entry version {}",
                retirement.version,
            ));
        }
        let requested_thread_ids = &retirement.requested_thread_ids;
        if requested_thread_ids.is_empty() {
            return Err("thread retirement journal entry has no requested thread IDs".to_string());
        }
        let deleted_thread_ids = match retirement.phase {
            RetirementPhase::Prepared => {
                if retirement.deleted_thread_ids.is_some() {
                    return Err(
                        "prepared thread retirement journal entry contains deleted thread IDs"
                            .to_string(),
                    );
                }
                &[][..]
            }
            RetirementPhase::Deleted => retirement
                .deleted_thread_ids
                .as_deref()
                .filter(|thread_ids| !thread_ids.is_empty())
                .ok_or_else(|| {
                    "deleted thread retirement journal entry has no deleted thread IDs".to_string()
                })?,
        };
        total_thread_ids = total_thread_ids
            .saturating_add(requested_thread_ids.len())
            .saturating_add(deleted_thread_ids.len());
        if total_thread_ids > RETIREMENT_JOURNAL_MAX_THREAD_IDS {
            return Err(format!(
                "thread retirement journal exceeds {RETIREMENT_JOURNAL_MAX_THREAD_IDS} thread IDs",
            ));
        }
        let mut requested_unique = HashSet::with_capacity(requested_thread_ids.len());
        for thread_id in requested_thread_ids {
            validate_thread_id(thread_id)?;
            if !requested_unique.insert(thread_id) {
                return Err(
                    "thread retirement journal entry contains duplicate requested thread IDs"
                        .to_string(),
                );
            }
        }
        let mut deleted_unique = HashSet::with_capacity(deleted_thread_ids.len());
        for thread_id in deleted_thread_ids {
            validate_thread_id(thread_id)?;
            if !deleted_unique.insert(thread_id) {
                return Err(
                    "thread retirement journal entry contains duplicate deleted thread IDs"
                        .to_string(),
                );
            }
        }
        if retirement.phase == RetirementPhase::Deleted
            && !requested_unique.is_subset(&deleted_unique)
        {
            return Err(
                "deleted thread retirement journal entry omits a requested thread ID".to_string(),
            );
        }
    }
    Ok(())
}

fn normalize_thread_ids(thread_ids: &[String]) -> Result<Vec<String>, String> {
    let mut normalized = thread_ids
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .map(str::to_string)
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    if normalized.is_empty() {
        return Err("thread retirement requires at least one thread ID".to_string());
    }
    for thread_id in &normalized {
        validate_thread_id(thread_id)?;
    }
    Ok(normalized)
}

fn validate_retirement_id(retirement_id: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(retirement_id)
        .map_err(|_| "thread retirement journal key must be a UUID".to_string())?;
    if parsed.to_string() != retirement_id {
        return Err(
            "thread retirement journal key must use canonical lowercase UUID form".to_string(),
        );
    }
    Ok(())
}

fn validate_thread_id(thread_id: &str) -> Result<(), String> {
    if thread_id.is_empty() || thread_id.len() > RETIREMENT_THREAD_ID_MAX_BYTES {
        return Err(format!(
            "thread retirement journal thread ID must be between 1 and {RETIREMENT_THREAD_ID_MAX_BYTES} bytes",
        ));
    }
    crate::acp::identity::AgentSessionId::decode(thread_id)
        .map(|_| ())
        .map_err(|_| {
            "thread retirement journal contains an invalid opaque ACP thread ID".to_string()
        })
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "retirement_journal_tests.rs"]
mod tests;
