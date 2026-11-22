use super::{
    client_heartbeat_expired, client_outbox, failure_is_definitive,
    heartbeat_send_requires_disconnect, is_ordered_push_control,
    normalize_thread_list_stream_limits, protected_request_error, take_client_thread_list_streams,
    Arc, BridgeConfig, Duration, HashMap, HashSet, HeaderMap, Message, PathBuf, StatusCode,
    ThreadListStreamCancellation, INDETERMINATE_OPERATION_PREFIX, ORIGIN,
    THREAD_LIST_STREAM_DEFAULT_LIMITS, THREAD_LIST_STREAM_MAX_LIMIT, WS_CLIENT_HEARTBEAT_INTERVAL,
    WS_CLIENT_HEARTBEAT_TIMEOUT,
};
use crate::config::{
    WebSocketResourceLimits, DEFAULT_WS_GLOBAL_IN_FLIGHT, DEFAULT_WS_MAX_FRAME_BYTES,
    DEFAULT_WS_MAX_MESSAGE_BYTES, DEFAULT_WS_PER_CLIENT_IN_FLIGHT,
};

#[test]
fn only_definitive_operation_failures_release_idempotency_keys() {
    assert!(failure_is_definitive("invalid option"));
    assert!(!failure_is_definitive(&format!(
        "{INDETERMINATE_OPERATION_PREFIX}connection lost"
    )));
    assert!(!failure_is_definitive("client request cancelled"));
    assert!(failure_is_definitive("client disconnected"));
}

#[test]
fn client_connection_heartbeat_has_a_bounded_expiry() {
    assert!(WS_CLIENT_HEARTBEAT_TIMEOUT > WS_CLIENT_HEARTBEAT_INTERVAL);
    let last_activity = tokio::time::Instant::now();
    assert!(!client_heartbeat_expired(
        last_activity,
        last_activity + WS_CLIENT_HEARTBEAT_TIMEOUT - Duration::from_millis(1),
    ));
    assert!(client_heartbeat_expired(
        last_activity,
        last_activity + WS_CLIENT_HEARTBEAT_TIMEOUT,
    ));
}

#[test]
fn push_controls_are_processed_in_socket_order_for_notifications_and_requests() {
    assert!(is_ordered_push_control(
        r#"{"method":"bridge/push/presence","params":{"foreground":false,"sequence":2}}"#
    ));
    assert!(is_ordered_push_control(
        r#"{"method":"bridge/push/observed","params":{"candidateId":"7","presenceSequence":2}}"#
    ));
    assert!(is_ordered_push_control(
        r#"{"id":1,"method":"bridge/push/presence","params":{"foreground":true,"sequence":1}}"#
    ));
    assert!(!is_ordered_push_control(
        r#"{"method":"bridge/other","params":{}}"#
    ));
}

#[tokio::test]
async fn a_full_or_closed_heartbeat_outbox_requires_disconnect() {
    let (outbox, receiver) = client_outbox(1);
    outbox
        .try_send(Message::Text("busy".into()))
        .expect("fill outbox");
    assert!(heartbeat_send_requires_disconnect(
        &outbox.try_send(Message::Ping(Vec::new().into()))
    ));

    drop(receiver);
    assert!(heartbeat_send_requires_disconnect(
        &outbox.try_send(Message::Ping(Vec::new().into()))
    ));
}

fn protected_request_config() -> BridgeConfig {
    BridgeConfig {
        host: "127.0.0.1".to_string(),
        port: 8787,
        preview_host: "127.0.0.1".to_string(),
        preview_port: 8788,
        preview_enabled: true,
        connect_url: None,
        preview_connect_url: None,
        workdir: PathBuf::from("/tmp"),
        state_dir: PathBuf::from("/tmp/.dappercode"),
        attachments_dir: PathBuf::from("/tmp/.dappercode-attachments"),
        acp_manifest_path: PathBuf::from("/tmp/agents.json"),
        acp_approved_executable_roots: vec![PathBuf::from("/tmp")],
        acp_initialize_timeout: Duration::from_secs(15),
        auth_token: Some("secret".to_string()),
        auth_enabled: true,
        allow_insecure_no_auth: false,
        no_auth_allowed_origins: HashSet::new(),
        allow_query_token_auth: true,
        allow_outside_root_cwd: false,
        show_pairing_qr: false,
        ws_limits: WebSocketResourceLimits {
            max_frame_bytes: DEFAULT_WS_MAX_FRAME_BYTES,
            max_message_bytes: DEFAULT_WS_MAX_MESSAGE_BYTES,
            per_client_in_flight: DEFAULT_WS_PER_CLIENT_IN_FLIGHT,
            global_in_flight: DEFAULT_WS_GLOBAL_IN_FLIGHT,
        },
        phone_call: None,
    }
}

#[test]
fn protected_requests_enforce_origin_before_credentials() {
    let config = protected_request_config();
    let headers = HeaderMap::new();

    let unauthorized = protected_request_error(&config, &headers, None).unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    assert!(protected_request_error(&config, &headers, Some("secret")).is_none());

    let mut no_auth = config;
    no_auth.auth_token = None;
    no_auth.auth_enabled = false;
    no_auth.allow_insecure_no_auth = true;
    let mut foreign_origin = HeaderMap::new();
    foreign_origin.insert(ORIGIN, "https://example.com".parse().unwrap());
    let forbidden = protected_request_error(&no_auth, &foreign_origin, None).unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn disconnect_cancels_only_owned_streams_and_wakes_blocked_requests() {
    let client_one_a = Arc::new(ThreadListStreamCancellation::default());
    let client_one_b = Arc::new(ThreadListStreamCancellation::default());
    let client_two = Arc::new(ThreadListStreamCancellation::default());
    let mut streams = HashMap::from([
        ("1:a".to_string(), client_one_a.clone()),
        ("1:b".to_string(), client_one_b.clone()),
        ("2:a".to_string(), client_two.clone()),
    ]);
    let waiting_cancellation = client_one_a.clone();
    let blocked = waiting_cancellation.cancelled();
    tokio::pin!(blocked);
    assert!(futures_util::poll!(&mut blocked).is_pending());

    let owned = take_client_thread_list_streams(&mut streams, 1);
    assert_eq!(owned.len(), 2);
    for cancellation in owned {
        cancellation.cancel();
    }
    tokio::time::timeout(Duration::from_secs(1), blocked)
        .await
        .expect("blocked request wakes");
    assert!(client_one_a.is_cancelled());
    assert!(client_one_b.is_cancelled());
    assert!(!client_two.is_cancelled());
    assert_eq!(streams.len(), 1);
    assert!(streams.contains_key("2:a"));
    tokio::time::timeout(Duration::from_secs(1), client_one_b.cancelled())
        .await
        .expect("cancellation is visible to a later waiter");

    let remaining = take_client_thread_list_streams(&mut streams, 2);
    assert_eq!(remaining.len(), 1);
    remaining[0].cancel();
    assert!(streams.is_empty());
    assert!(take_client_thread_list_streams(&mut streams, 99).is_empty());

    assert_eq!(
        normalize_thread_list_stream_limits(Some(vec![0, 1, usize::MAX, 1])),
        vec![1, THREAD_LIST_STREAM_MAX_LIMIT],
    );
    assert_eq!(
        normalize_thread_list_stream_limits(Some(Vec::new())),
        THREAD_LIST_STREAM_DEFAULT_LIMITS,
    );
}
