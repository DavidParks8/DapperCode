#[cfg(test)]
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
};

use serde::{
    de::{Error as _, MapAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
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

fn deserialize_retirements<'de, D>(
    deserializer: D,
) -> Result<BTreeMap<String, StoredRetirement>, D::Error>
where
    D: Deserializer<'de>,
{
    struct RetirementsVisitor;

    impl<'de> Visitor<'de> for RetirementsVisitor {
        type Value = BTreeMap<String, StoredRetirement>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a map of unique retirement IDs")
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut retirements = BTreeMap::new();
            while let Some((retirement_id, retirement)) = map.next_entry()? {
                if retirements.insert(retirement_id, retirement).is_some() {
                    return Err(A::Error::custom(
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
    fail_next_persist: AtomicBool,
    #[cfg(test)]
    fail_persist: AtomicBool,
    #[cfg(test)]
    fail_remove: AtomicBool,
    #[cfg(test)]
    remove_attempts: AtomicUsize,
}

impl ThreadRetirementJournal {
    pub(crate) async fn load(path: PathBuf) -> Result<Self, String> {
        let state = load_state(&path).await?;
        Ok(Self {
            path: Some(path),
            state: Mutex::new(state),
            #[cfg(test)]
            fail_next_persist: AtomicBool::new(false),
            #[cfg(test)]
            fail_persist: AtomicBool::new(false),
            #[cfg(test)]
            fail_remove: AtomicBool::new(false),
            #[cfg(test)]
            remove_attempts: AtomicUsize::new(0),
        })
    }

    #[cfg(test)]
    pub(crate) fn inert_for_test() -> Self {
        Self {
            path: None,
            state: Mutex::new(RetirementJournalState::default()),
            fail_next_persist: AtomicBool::new(false),
            fail_persist: AtomicBool::new(false),
            fail_remove: AtomicBool::new(false),
            remove_attempts: AtomicUsize::new(0),
        }
    }

    pub(crate) async fn add_prepared(&self, thread_ids: &[String]) -> Result<String, String> {
        let requested_thread_ids = normalize_thread_ids(thread_ids)?;
        let mut state = self.state.lock().await;
        if state.retirements.len() >= RETIREMENT_JOURNAL_MAX_ENTRIES {
            return Err(format!(
                "thread retirement journal exceeds {RETIREMENT_JOURNAL_MAX_ENTRIES} entries"
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
            self.remove_attempts.fetch_add(1, Ordering::AcqRel);
            if self.fail_remove.load(Ordering::Acquire) {
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
        if self.fail_persist.load(Ordering::Acquire)
            || self.fail_next_persist.swap(false, Ordering::AcqRel)
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
        self.fail_persist.store(fail, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn fail_all_removes(&self, fail: bool) {
        self.fail_remove.store(fail, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn remove_attempt_count(&self) -> usize {
        self.remove_attempts.load(Ordering::Acquire)
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
            "thread retirement journal exceeds {RETIREMENT_JOURNAL_MAX_BYTES} bytes"
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
            "thread retirement journal exceeds its {RETIREMENT_JOURNAL_MAX_BYTES}-byte budget"
        ));
    }
    Ok(bytes)
}

fn validate_state(state: &RetirementJournalState) -> Result<(), String> {
    if state.version != RETIREMENT_JOURNAL_VERSION {
        return Err(format!(
            "unsupported thread retirement journal version {}",
            state.version
        ));
    }
    if state.retirements.len() > RETIREMENT_JOURNAL_MAX_ENTRIES {
        return Err(format!(
            "thread retirement journal exceeds {RETIREMENT_JOURNAL_MAX_ENTRIES} entries"
        ));
    }
    let mut total_thread_ids = 0_usize;
    for (retirement_id, retirement) in &state.retirements {
        validate_retirement_id(retirement_id)?;
        if retirement.version != RETIREMENT_ENTRY_VERSION {
            return Err(format!(
                "unsupported thread retirement journal entry version {}",
                retirement.version
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
                "thread retirement journal exceeds {RETIREMENT_JOURNAL_MAX_THREAD_IDS} thread IDs"
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
        .map(|thread_id| thread_id.trim().to_string())
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
            "thread retirement journal thread ID must be between 1 and {RETIREMENT_THREAD_ID_MAX_BYTES} bytes"
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
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        let path = std::env::current_dir()
            .expect("current directory")
            .join("target")
            .join("retirement-journal-tests")
            .join(format!("{name}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create retirement journal test directory");
        path
    }

    fn test_thread(name: &str) -> String {
        crate::acp::identity::AgentSessionId::new("agent", name)
            .unwrap()
            .encode()
    }

    #[tokio::test]
    async fn private_versioned_journal_round_trips_and_clears_atomically() {
        let directory = test_directory("round-trip");
        let path = directory.join("thread-retirements.json");
        let journal = ThreadRetirementJournal::load(path.clone()).await.unwrap();
        let requested = test_thread("one");
        let additional = test_thread("two");
        let mut complete_family = vec![requested.clone(), additional];
        complete_family.sort();
        let retirement_id = journal.add_prepared(&complete_family).await.unwrap();

        let loaded = ThreadRetirementJournal::load(path.clone()).await.unwrap();
        assert_eq!(
            loaded.entries().await,
            vec![RetirementJournalEntry {
                retirement_id: retirement_id.clone(),
                phase: RetirementPhase::Prepared,
                requested_thread_ids: complete_family.clone(),
                deleted_thread_ids: Vec::new(),
            }]
        );
        assert_eq!(
            loaded
                .mark_deleted(&retirement_id, &complete_family)
                .await
                .unwrap(),
            complete_family
        );
        let deleted = ThreadRetirementJournal::load(path.clone()).await.unwrap();
        assert_eq!(deleted.entries().await[0].phase, RetirementPhase::Deleted);
        assert_eq!(
            deleted.entries().await[0].requested_thread_ids,
            complete_family
        );
        assert_eq!(
            deleted.entries().await[0].deleted_thread_ids,
            complete_family
        );
        #[cfg(unix)]
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(
                &std::fs::metadata(&path).unwrap().permissions()
            ) & 0o777,
            0o600
        );

        loaded.remove(&[retirement_id]).await.unwrap();
        assert!(ThreadRetirementJournal::load(path)
            .await
            .unwrap()
            .entries()
            .await
            .is_empty());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn malformed_unknown_and_oversized_journals_are_rejected() {
        let directory = test_directory("invalid");
        let path = directory.join("thread-retirements.json");
        for invalid in [
            br#"{"version":2,"retirements":[]}"#.as_slice(),
            br#"{"version":1,"retirements":{}}"#.as_slice(),
            br#"{"version":2,"retirements":{},"unknown":true}"#.as_slice(),
        ] {
            std::fs::write(&path, invalid).unwrap();
            assert!(ThreadRetirementJournal::load(path.clone()).await.is_err());
        }
        let duplicate_key = format!(
            r#"{{"version":2,"retirements":{{"00000000-0000-4000-8000-000000000001":{{"version":1,"phase":"prepared","requestedThreadIds":["{}"]}},"00000000-0000-4000-8000-000000000001":{{"version":1,"phase":"prepared","requestedThreadIds":["{}"]}}}}}}"#,
            test_thread("one"),
            test_thread("two")
        );
        std::fs::write(&path, duplicate_key).unwrap();
        assert!(ThreadRetirementJournal::load(path.clone()).await.is_err());
        std::fs::write(&path, vec![b' '; RETIREMENT_JOURNAL_MAX_BYTES + 1]).unwrap();
        assert!(ThreadRetirementJournal::load(path).await.is_err());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn malformed_phases_and_phase_payloads_are_rejected() {
        let directory = test_directory("invalid-phase");
        let path = directory.join("thread-retirements.json");
        let thread_id = test_thread("one");
        for entry in [
            format!(r#"{{"version":1,"phase":"unknown","requestedThreadIds":["{thread_id}"]}}"#),
            format!(
                r#"{{"version":1,"phase":"prepared","requestedThreadIds":["{thread_id}"],"deletedThreadIds":["{thread_id}"]}}"#
            ),
            format!(r#"{{"version":1,"phase":"deleted","requestedThreadIds":["{thread_id}"]}}"#),
        ] {
            std::fs::write(
                &path,
                format!(
                    r#"{{"version":2,"retirements":{{"00000000-0000-4000-8000-000000000001":{entry}}}}}"#
                ),
            )
            .unwrap();
            assert!(ThreadRetirementJournal::load(path.clone()).await.is_err());
        }
        let _ = std::fs::remove_dir_all(directory);
    }

    fn stored_retirement(
        phase: RetirementPhase,
        requested_thread_ids: Vec<String>,
        deleted_thread_ids: Option<Vec<String>>,
    ) -> StoredRetirement {
        StoredRetirement {
            version: RETIREMENT_ENTRY_VERSION,
            phase,
            requested_thread_ids,
            deleted_thread_ids,
        }
    }

    #[test]
    fn validation_rejects_every_bounded_journal_invariant() {
        let retirement_id = Uuid::new_v4().to_string();
        let requested = test_thread("requested");
        let deleted = test_thread("deleted");
        let state_with =
            |retirement_id: String, retirement: StoredRetirement| RetirementJournalState {
                version: RETIREMENT_JOURNAL_VERSION,
                retirements: BTreeMap::from([(retirement_id, retirement)]),
            };

        let mut invalid_version =
            stored_retirement(RetirementPhase::Prepared, vec![requested.clone()], None);
        invalid_version.version += 1;
        assert!(
            validate_state(&state_with(retirement_id.clone(), invalid_version))
                .unwrap_err()
                .contains("entry version")
        );

        assert!(validate_state(&state_with(
            retirement_id.clone(),
            stored_retirement(RetirementPhase::Prepared, Vec::new(), None),
        ))
        .unwrap_err()
        .contains("no requested"));

        assert!(validate_state(&state_with(
            retirement_id.clone(),
            stored_retirement(
                RetirementPhase::Prepared,
                vec![requested.clone(), requested.clone()],
                None,
            ),
        ))
        .unwrap_err()
        .contains("duplicate requested"));

        assert!(validate_state(&state_with(
            retirement_id.clone(),
            stored_retirement(
                RetirementPhase::Deleted,
                vec![requested.clone()],
                Some(vec![requested.clone(), requested.clone()]),
            ),
        ))
        .unwrap_err()
        .contains("duplicate deleted"));

        assert!(validate_state(&state_with(
            retirement_id.clone(),
            stored_retirement(
                RetirementPhase::Deleted,
                vec![requested.clone()],
                Some(vec![deleted]),
            ),
        ))
        .unwrap_err()
        .contains("omits"));

        assert!(validate_state(&state_with(
            retirement_id.clone(),
            stored_retirement(
                RetirementPhase::Prepared,
                vec![requested.clone(); RETIREMENT_JOURNAL_MAX_THREAD_IDS + 1],
                None,
            ),
        ))
        .unwrap_err()
        .contains("thread IDs"));

        let mut too_many = RetirementJournalState::default();
        for index in 0..=RETIREMENT_JOURNAL_MAX_ENTRIES {
            too_many.retirements.insert(
                Uuid::from_u128(index as u128 + 1).to_string(),
                stored_retirement(RetirementPhase::Prepared, vec![requested.clone()], None),
            );
        }
        assert!(validate_state(&too_many).unwrap_err().contains("entries"));

        assert!(validate_retirement_id(&retirement_id.to_uppercase())
            .unwrap_err()
            .contains("canonical"));
        assert!(normalize_thread_ids(&[])
            .unwrap_err()
            .contains("at least one"));
        assert!(validate_thread_id("").unwrap_err().contains("between"));
        assert!(
            validate_thread_id(&"x".repeat(RETIREMENT_THREAD_ID_MAX_BYTES + 1))
                .unwrap_err()
                .contains("between")
        );
    }

    #[tokio::test]
    async fn capacity_idempotence_and_persistence_failures_preserve_state() {
        let requested = test_thread("requested");
        let journal = ThreadRetirementJournal::inert_for_test();

        {
            let mut state = journal.state.lock().await;
            for index in 0..RETIREMENT_JOURNAL_MAX_ENTRIES {
                state.retirements.insert(
                    Uuid::from_u128(index as u128 + 1).to_string(),
                    stored_retirement(RetirementPhase::Prepared, vec![requested.clone()], None),
                );
            }
        }
        assert!(journal
            .add_prepared(std::slice::from_ref(&requested))
            .await
            .unwrap_err()
            .contains("entries"));

        journal.remove(&["absent".to_string()]).await.unwrap();
        journal.state.lock().await.retirements.clear();
        journal.fail_next_persist.store(true, Ordering::Release);
        assert!(journal
            .add_prepared(std::slice::from_ref(&requested))
            .await
            .unwrap_err()
            .contains("persistence"));
        assert!(journal.entries().await.is_empty());

        let retirement_id = journal
            .add_prepared(std::slice::from_ref(&requested))
            .await
            .unwrap();
        let additional = test_thread("additional");
        journal
            .mark_deleted(&retirement_id, std::slice::from_ref(&requested))
            .await
            .unwrap();
        let complete = journal
            .mark_deleted(&retirement_id, std::slice::from_ref(&additional))
            .await
            .unwrap();
        assert!(complete.contains(&requested));
        assert!(complete.contains(&additional));
    }

    #[tokio::test]
    async fn load_reports_non_missing_read_errors_and_encoded_size_limit() {
        let directory = test_directory("read-error");
        assert!(ThreadRetirementJournal::load(directory.clone())
            .await
            .err()
            .expect("reading a directory must fail")
            .contains("failed to read"));

        let long_threads = (0..4)
            .map(|index| test_thread(&format!("{}{index}", "x".repeat(1_023))))
            .collect::<Vec<_>>();
        assert!(long_threads
            .iter()
            .all(|thread_id| thread_id.len() <= RETIREMENT_THREAD_ID_MAX_BYTES));
        let retirement = stored_retirement(RetirementPhase::Prepared, long_threads, None);
        let mut state = RetirementJournalState::default();
        for index in 0..RETIREMENT_JOURNAL_MAX_ENTRIES {
            state.retirements.insert(
                Uuid::from_u128(index as u128 + 1).to_string(),
                retirement.clone(),
            );
        }
        assert!(encode_state(&state).unwrap_err().contains("byte budget"));

        let _ = std::fs::remove_dir_all(directory);
    }
}
