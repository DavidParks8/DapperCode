use super::{
    encode_state, normalize_thread_ids, validate_retirement_id, validate_state, validate_thread_id,
    BTreeMap, PathBuf, RetirementJournalEntry, RetirementJournalState, RetirementPhase,
    StoredRetirement, ThreadRetirementJournal, Uuid, RETIREMENT_ENTRY_VERSION,
    RETIREMENT_JOURNAL_MAX_BYTES, RETIREMENT_JOURNAL_MAX_ENTRIES,
    RETIREMENT_JOURNAL_MAX_THREAD_IDS, RETIREMENT_JOURNAL_VERSION, RETIREMENT_THREAD_ID_MAX_BYTES,
};
use std::sync::atomic::Ordering;

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
        }],
    );
    assert_eq!(
        loaded
            .mark_deleted(&retirement_id, &complete_family)
            .await
            .unwrap(),
        complete_family,
    );
    let deleted = ThreadRetirementJournal::load(path.clone()).await.unwrap();
    assert_eq!(deleted.entries().await[0].phase, RetirementPhase::Deleted);
    assert_eq!(
        deleted.entries().await[0].requested_thread_ids,
        complete_family,
    );
    assert_eq!(
        deleted.entries().await[0].deleted_thread_ids,
        complete_family,
    );
    #[cfg(unix)]
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&path).unwrap().permissions())
            & 0o777,
        0o600,
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
        test_thread("two"),
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
            r#"{{"version":1,"phase":"prepared","requestedThreadIds":["{thread_id}"],"deletedThreadIds":["{thread_id}"]}}"#,
        ),
        format!(r#"{{"version":1,"phase":"deleted","requestedThreadIds":["{thread_id}"]}}"#),
    ] {
        std::fs::write(
            &path,
            format!(
                r#"{{"version":2,"retirements":{{"00000000-0000-4000-8000-000000000001":{entry}}}}}"#,
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
    let state_with = |retirement_id: String, retirement: StoredRetirement| RetirementJournalState {
        version: RETIREMENT_JOURNAL_VERSION,
        retirements: BTreeMap::from([(retirement_id, retirement)]),
    };

    let mut invalid_version =
        stored_retirement(RetirementPhase::Prepared, vec![requested.clone()], None);
    invalid_version.version += 1;
    assert!(
        validate_state(&state_with(retirement_id.clone(), invalid_version))
            .unwrap_err()
            .contains("entry version"),
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
            .contains("between"),
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
