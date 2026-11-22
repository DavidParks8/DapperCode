use super::{
    field_summary, is_sensitive, valid_email, validate_elicitation, AbandonedInteractionCleanup,
    AbandonedInteractionKind, ApprovalPolicy, Arc, BTreeMap, BlockedSessionGuard,
    ElicitationContentValue, ElicitationFieldKind, ElicitationPropertySchema, ElicitationSchema,
    InteractionError, InteractionPublication, InteractionRegistry, InteractionState, Mutex,
    SessionId, SessionRegistry,
};
use serde_json::json;
use std::time::Duration;

#[derive(Clone)]
pub(crate) struct PermissionPublicationBarrier {
    pub(super) reached: Arc<tokio::sync::Notify>,
    pub(super) release: Arc<tokio::sync::Notify>,
}

impl PermissionPublicationBarrier {
    pub(crate) async fn wait_until_reached(&self) {
        self.reached.notified().await;
    }

    pub(crate) fn release(&self) {
        self.release.notify_one();
    }
}

#[tokio::test]
async fn steer_epoch_verification_accepts_only_current_stable_epoch() {
    let registry = InteractionRegistry::new(SessionRegistry::default());
    let session_id = SessionId::new("epoch-session");
    assert!(!registry.at_capacity(&InteractionState::default(), None));
    let zero_capacity = InteractionRegistry::with_limits(SessionRegistry::default(), 0, 0);
    assert!(zero_capacity.at_capacity(&InteractionState::default(), None));
    let zero_session_capacity = InteractionRegistry::with_limits(SessionRegistry::default(), 1, 0);
    assert!(zero_session_capacity.at_capacity(&InteractionState::default(), Some(&session_id)));
    assert!(registry.verify_steer_epoch(&session_id, 0).await);
    assert_eq!(registry.current_steer_epoch(&session_id).await, 0);
    {
        let mut state = registry.inner.lock().await;
        assert_eq!(InteractionRegistry::bump_epoch(&mut state, &session_id), 1);
    }

    assert!(registry.verify_steer_epoch(&session_id, 1).await);
    assert_eq!(registry.current_steer_epoch(&session_id).await, 1);
    assert!(!registry.verify_steer_epoch(&session_id, 0).await);
    assert_eq!(
        registry
            .with_verified_steer_epoch(&session_id, 1, || "sent")
            .await,
        Some("sent"),
    );
    assert_eq!(
        registry
            .with_verified_steer_epoch(&session_id, 0, || "not-sent")
            .await,
        None,
    );
}

#[tokio::test]
async fn publication_and_blocked_session_guards_cover_both_settlement_paths() {
    let inner = Arc::new(Mutex::new(InteractionState::default()));
    let session_id = SessionId::new("guarded");
    inner
        .lock()
        .await
        .blocked_sessions
        .insert(session_id.clone());
    BlockedSessionGuard::new(inner.clone(), session_id.clone())
        .clear()
        .await;
    assert!(!inner.lock().await.blocked_sessions.contains(&session_id));

    inner
        .lock()
        .await
        .blocked_sessions
        .insert(session_id.clone());
    drop(BlockedSessionGuard::new(inner.clone(), session_id.clone()));
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if !inner.lock().await.blocked_sessions.contains(&session_id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("dropped guard clears the blocked session");
    assert!(!inner.lock().await.blocked_sessions.contains(&session_id));

    let cleanup = || AbandonedInteractionCleanup {
        inner: inner.clone(),
        request_id: "missing".to_string(),
        kind: AbandonedInteractionKind::Permission,
    };
    let (published, publisher) = InteractionPublication::new(cleanup());
    let published_wait = tokio::spawn({
        let published = published.clone();
        async move { published.wait().await }
    });
    publisher.publish();
    assert!(published_wait.await.unwrap());
    assert!(published.is_published());
    assert!(!published.is_abandoned());

    let (abandoned, publisher) = InteractionPublication::new(AbandonedInteractionCleanup {
        inner: inner.clone(),
        request_id: "missing".to_string(),
        kind: AbandonedInteractionKind::Elicitation,
    });
    drop(publisher);
    assert!(!abandoned.wait().await);
    assert!(abandoned.is_abandoned());

    let (abandoned_without_cleanup, mut no_cleanup) = InteractionPublication::new(cleanup());
    no_cleanup.cleanup = None;
    drop(no_cleanup);
    assert!(!abandoned_without_cleanup.wait().await);
}

#[tokio::test]
async fn committed_session_eviction_removes_approval_policy_state() {
    let sessions = SessionRegistry::with_capacity(1);
    let registry = InteractionRegistry::new(sessions.clone());
    let first_id = SessionId::new("first-policy-session");
    sessions.register("agent", first_id.clone()).await.unwrap();
    registry
        .set_approval_policy(&first_id, ApprovalPolicy::Never)
        .await
        .unwrap();
    assert_eq!(registry.inner.lock().await.approval_policies.len(), 1);

    sessions
        .register("agent", SessionId::new("second-policy-session"))
        .await
        .unwrap();

    assert!(!registry
        .inner
        .lock()
        .await
        .approval_policies
        .contains_key(&first_id));
}

#[tokio::test]
async fn policy_update_restores_a_tentative_eviction_before_applying_state() {
    let sessions = SessionRegistry::with_capacity(1);
    let registry = InteractionRegistry::new(sessions.clone());
    let first_id = SessionId::new("tentatively-evicted");
    sessions.register("agent", first_id.clone()).await.unwrap();
    registry
        .set_approval_policy(&first_id, ApprovalPolicy::Never)
        .await
        .unwrap();
    let eviction = sessions.pause_next_eviction().await;
    let replacement = {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            sessions
                .register("agent", SessionId::new("replacement"))
                .await
        })
    };
    eviction.wait_until_reached().await;

    registry
        .set_approval_policy(&first_id, ApprovalPolicy::OnRequest)
        .await
        .expect("policy update restores the live session");
    eviction.release();

    assert!(replacement.await.expect("replacement task").is_err());
    assert!(sessions.get(&first_id).await.is_some());
    assert_eq!(
        registry.approval_policy(&first_id).await,
        ApprovalPolicy::OnRequest,
    );
}

#[tokio::test]
async fn policy_update_is_retained_while_a_session_is_registering() {
    let sessions = SessionRegistry::default();
    let registry = InteractionRegistry::new(sessions.clone());
    let session_id = SessionId::new("registering-policy-session");
    let barrier = sessions.pause_next_registration().await;
    let registration = {
        let sessions = sessions.clone();
        let session_id = session_id.clone();
        tokio::spawn(async move { sessions.register("agent", session_id).await })
    };
    barrier.wait_until_reached().await;

    registry
        .set_approval_policy(&session_id, ApprovalPolicy::Never)
        .await
        .expect("policy update succeeds during registration");
    assert_eq!(
        registry.approval_policy(&session_id).await,
        ApprovalPolicy::Never,
    );

    barrier.release();
    registration
        .await
        .expect("registration task")
        .expect("registration succeeds");
    assert_eq!(
        registry.approval_policy(&session_id).await,
        ApprovalPolicy::Never,
    );
}

fn property(value: serde_json::Value) -> ElicitationPropertySchema {
    serde_json::from_value(value).expect("valid elicitation property")
}

fn schema(properties: BTreeMap<String, ElicitationPropertySchema>) -> ElicitationSchema {
    let mut schema = ElicitationSchema::new();
    schema.properties = properties;
    schema
}

fn assert_invalid(schema: &ElicitationSchema, name: &str, value: ElicitationContentValue) {
    assert!(matches!(
        validate_elicitation(schema, &BTreeMap::from([(name.to_string(), value)])),
        Err(InteractionError::InvalidElicitation(_))
    ));
}

#[test]
fn elicitation_validation_rejects_missing_unknown_and_wrong_type_fields() {
    let mut requested = schema(BTreeMap::from([(
        "name".to_string(),
        property(json!({"type": "string"})),
    )]));
    requested.required = Some(vec!["name".to_string()]);
    assert!(matches!(
        validate_elicitation(&requested, &BTreeMap::new()),
        Err(InteractionError::InvalidElicitation(message)) if message.contains("missing required")
    ));
    assert!(matches!(
        validate_elicitation(
            &requested,
            &BTreeMap::from([
                (
                    "name".to_string(),
                    ElicitationContentValue::String("value".to_string()),
                ),
                (
                    "other".to_string(),
                    ElicitationContentValue::String("value".to_string()),
                ),
            ]),
        ),
        Err(InteractionError::InvalidElicitation(message)) if message.contains("unknown field")
    ));
    assert_invalid(&requested, "name", ElicitationContentValue::Boolean(true));
}

#[test]
fn elicitation_validation_covers_string_constraints_and_formats() {
    let constrained = schema(BTreeMap::from([(
        "value".to_string(),
        property(json!({
            "type": "string",
            "minLength": 2,
            "maxLength": 4,
            "enum": ["okay", "yes"],
            "oneOf": [{"const": "okay", "title": "Okay"}],
            "pattern": "^[a-z]+$"
        })),
    )]));
    for value in ["x", "large", "yes", "NOPE"] {
        assert_invalid(
            &constrained,
            "value",
            ElicitationContentValue::String(value.to_string()),
        );
    }
    assert!(validate_elicitation(
        &constrained,
        &BTreeMap::from([(
            "value".to_string(),
            ElicitationContentValue::String("okay".to_string()),
        )]),
    )
    .is_ok());

    let invalid_pattern = schema(BTreeMap::from([(
        "value".to_string(),
        property(json!({"type": "string", "pattern": "["})),
    )]));
    assert_invalid(
        &invalid_pattern,
        "value",
        ElicitationContentValue::String("anything".to_string()),
    );

    for (format, invalid_value, valid_value) in [
        ("email", "missing-at", "person@example.com"),
        ("uri", "not a uri", "https://example.com/path"),
        ("date", "2026-99-99", "2026-07-19"),
        ("date-time", "yesterday", "2026-07-19T12:30:00Z"),
    ] {
        let formatted = schema(BTreeMap::from([(
            "value".to_string(),
            property(json!({"type": "string", "format": format})),
        )]));
        assert_invalid(
            &formatted,
            "value",
            ElicitationContentValue::String(invalid_value.to_string()),
        );
        assert!(validate_elicitation(
            &formatted,
            &BTreeMap::from([(
                "value".to_string(),
                ElicitationContentValue::String(valid_value.to_string()),
            )]),
        )
        .is_ok());
    }
    for invalid_email in ["@example.com", "person@example", "person@example."] {
        assert!(!valid_email(invalid_email));
    }
    assert!(valid_email("person@example.com"));
}

#[test]
fn elicitation_validation_covers_numeric_boolean_and_array_constraints() {
    let requested = schema(BTreeMap::from([
        (
            "integer".to_string(),
            property(json!({"type": "integer", "minimum": 2, "maximum": 4})),
        ),
        (
            "number".to_string(),
            property(json!({"type": "number", "minimum": 1.5, "maximum": 2.5})),
        ),
        ("enabled".to_string(), property(json!({"type": "boolean"}))),
        (
            "plain".to_string(),
            property(json!({
                "type": "array",
                "items": {"type": "string", "enum": ["one", "two"]},
                "minItems": 1,
                "maxItems": 2
            })),
        ),
        (
            "titled".to_string(),
            property(json!({
                "type": "array",
                "items": {"anyOf": [{"const": "one", "title": "One"}]}
            })),
        ),
        (
            "future".to_string(),
            property(json!({"type": "array", "items": {"type": "future"}})),
        ),
    ]));

    for value in [1, 5] {
        assert_invalid(
            &requested,
            "integer",
            ElicitationContentValue::Integer(value),
        );
    }
    for value in [1.0, 3.0, f64::NAN] {
        assert_invalid(&requested, "number", ElicitationContentValue::Number(value));
    }
    assert_invalid(
        &requested,
        "plain",
        ElicitationContentValue::StringArray(Vec::new()),
    );
    assert_invalid(
        &requested,
        "plain",
        ElicitationContentValue::StringArray(vec!["one".to_string(); 3]),
    );
    assert_invalid(
        &requested,
        "plain",
        ElicitationContentValue::StringArray(vec!["other".to_string()]),
    );
    assert_invalid(
        &requested,
        "titled",
        ElicitationContentValue::StringArray(vec!["other".to_string()]),
    );
    assert_invalid(
        &requested,
        "future",
        ElicitationContentValue::StringArray(vec!["one".to_string()]),
    );

    assert!(validate_elicitation(
        &requested,
        &BTreeMap::from([
            ("integer".to_string(), ElicitationContentValue::Integer(3)),
            ("number".to_string(), ElicitationContentValue::Number(2.0)),
            (
                "enabled".to_string(),
                ElicitationContentValue::Boolean(true)
            ),
            (
                "plain".to_string(),
                ElicitationContentValue::StringArray(vec!["one".to_string()]),
            ),
            (
                "titled".to_string(),
                ElicitationContentValue::StringArray(vec!["one".to_string()]),
            ),
        ]),
    )
    .is_ok());
}

#[test]
fn elicitation_field_summaries_cover_all_kinds_options_defaults_and_secrets() {
    let requested = schema(BTreeMap::from([
        (
            "choice".to_string(),
            property(json!({
                "type": "string",
                "title": "Choice",
                "description": "Select one",
                "oneOf": [{"const": "a", "title": "Alpha"}],
                "default": "a"
            })),
        ),
        (
            "plain".to_string(),
            property(json!({"type": "string", "enum": ["a"], "default": "a"})),
        ),
        (
            "count".to_string(),
            property(json!({"type": "integer", "default": 2})),
        ),
        (
            "ratio".to_string(),
            property(json!({"type": "number", "default": 1.5})),
        ),
        (
            "enabled".to_string(),
            property(json!({"type": "boolean", "default": true})),
        ),
        (
            "tags".to_string(),
            property(json!({
                "type": "array",
                "items": {"type": "string", "enum": ["a"]},
                "default": ["a"]
            })),
        ),
        (
            "labels".to_string(),
            property(json!({
                "type": "array",
                "items": {"anyOf": [{"const": "a", "title": "Alpha"}]}
            })),
        ),
        ("future".to_string(), property(json!({"type": "future"}))),
        (
            "password".to_string(),
            property(json!({"type": "string", "default": "hidden"})),
        ),
        (
            "metadata".to_string(),
            property(json!({"type": "string", "_meta": {"isSensitive": true}})),
        ),
    ]));
    let mut requested = requested;
    requested.required = Some(vec!["choice".to_string()]);

    let summaries = requested
        .properties
        .iter()
        .map(|(name, property)| field_summary(name, property, &requested))
        .collect::<Vec<_>>();
    assert!(summaries.iter().any(|field| {
        field.name == "choice"
            && field.required
            && field.options == vec![("a".to_string(), "Alpha".to_string())]
            && field.default == Some(ElicitationContentValue::String("a".to_string()))
    }));
    assert!(summaries
        .iter()
        .any(|field| field.name == "plain" && field.options[0].0 == "a"));
    assert!(summaries
        .iter()
        .any(|field| field.kind == ElicitationFieldKind::Integer));
    assert!(summaries
        .iter()
        .any(|field| field.kind == ElicitationFieldKind::Number));
    assert!(summaries
        .iter()
        .any(|field| field.kind == ElicitationFieldKind::Boolean));
    assert_eq!(
        summaries
            .iter()
            .filter(|field| field.kind == ElicitationFieldKind::StringArray)
            .count(),
        2,
    );
    assert!(summaries
        .iter()
        .any(|field| field.kind == ElicitationFieldKind::Unsupported));
    for name in ["password", "metadata"] {
        let field = summaries.iter().find(|field| field.name == name).unwrap();
        assert!(field.sensitive);
        assert_eq!(field.default, None);
    }
    assert!(is_sensitive("field", Some("API Key"), None, None));
    assert!(is_sensitive(
        "field",
        None,
        Some("Access token used by the service"),
        None,
    ));
    assert!(!is_sensitive("field", Some("Display name"), None, None));
}
