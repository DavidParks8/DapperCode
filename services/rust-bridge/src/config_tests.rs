use super::{
    config_env, env, normalize_browser_origin, normalize_connect_url, parse_absolute_dir_env,
    parse_bool_env, parse_bool_env_with_default, parse_connect_url_env, parse_origin_csv_env,
    parse_path_list_env, parse_positive_u64_env, parse_positive_usize_env,
    parse_sip_server_host_port, parse_unresolved_absolute_dir_env, resolve_bridge_workdir,
    validate_no_auth_listener, BridgeConfig, Duration, HashSet, HeaderMap, PathBuf,
    PhoneCallRuntimeConfig, SipTransportKind, VoicePipelineConfig, WebSocketResourceLimits,
    DEFAULT_WS_GLOBAL_IN_FLIGHT, DEFAULT_WS_MAX_FRAME_BYTES, DEFAULT_WS_MAX_MESSAGE_BYTES,
    DEFAULT_WS_PER_CLIENT_IN_FLIGHT, MAX_SIP_PASSWORD_BYTES, MAX_SIP_USERNAME_BYTES,
    MAX_USER_DISPLAY_NAME_BYTES, ORIGIN,
};

thread_local! {
    static TEST_ENV: std::cell::RefCell<std::collections::HashMap<String, Option<std::ffi::OsString>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

pub(super) fn config_env_for_test(name: &str) -> Result<String, env::VarError> {
    match TEST_ENV.with(|vars| vars.borrow().get(name).cloned()) {
        Some(Some(value)) => value.into_string().map_err(env::VarError::NotUnicode),
        Some(None) => Err(env::VarError::NotPresent),
        None => env::var(name),
    }
}

/// Scratch directory that cleans itself up, mirroring the helper the attachment tests use so
/// the bridge keeps its dependency-free test setup.
struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = env::temp_dir().join(format!(
            "dappercode-config-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos(),
        ));
        std::fs::create_dir_all(&path).expect("create test directory");
        Self(path)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct DirEnvGuard {
    name: String,
    previous: Option<Option<std::ffi::OsString>>,
}

impl DirEnvGuard {
    fn set(name: impl Into<String>, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let guard = Self::unset(name);
        set_test_var(&guard.name, value);
        guard
    }

    fn set_raw(name: impl Into<String>, value: &str) -> Self {
        Self::set(name, value)
    }

    fn unset(name: impl Into<String>) -> Self {
        let name = name.into();
        let previous = TEST_ENV.with(|vars| vars.borrow_mut().insert(name.clone(), None));
        Self { name, previous }
    }
}

impl Drop for DirEnvGuard {
    fn drop(&mut self) {
        TEST_ENV.with(|vars| match self.previous.take() {
            Some(value) => {
                vars.borrow_mut().insert(self.name.clone(), value);
            }
            None => {
                vars.borrow_mut().remove(&self.name);
            }
        });
    }
}

fn set_test_var(name: impl AsRef<str>, value: impl AsRef<std::ffi::OsStr>) {
    TEST_ENV.with(|vars| {
        vars.borrow_mut().insert(
            name.as_ref().to_string(),
            Some(value.as_ref().to_os_string()),
        );
    });
}

fn remove_test_var(name: impl AsRef<str>) {
    TEST_ENV.with(|vars| {
        vars.borrow_mut().insert(name.as_ref().to_string(), None);
    });
}

#[test]
fn test_environment_overrides_are_thread_local_and_restore_nested_values() {
    let name = format!("DAPPERCODE_TEST_ISOLATION_{}", uuid::Uuid::new_v4());
    let original = env::var(&name).ok();
    let outer = DirEnvGuard::set(&name, "outer");
    assert_eq!(config_env(&name).as_deref(), Ok("outer"));
    assert_eq!(env::var(&name).ok(), original);

    {
        let _inner = DirEnvGuard::set(&name, "inner");
        assert_eq!(config_env(&name).as_deref(), Ok("inner"));
        let other_name = name.clone();
        let observed = std::thread::spawn(move || config_env(&other_name).ok())
            .join()
            .expect("environment observer thread");
        assert_eq!(observed, original);
    }
    assert_eq!(config_env(&name).as_deref(), Ok("outer"));
    drop(outer);
    assert_eq!(config_env(&name).ok(), original);
}

#[test]
fn state_and_attachment_directories_default_beside_the_workspace() {
    let temp = TestDir::new();
    let workdir = temp.path().canonicalize().expect("canonical workdir");

    let state = parse_absolute_dir_env(
        "BRIDGE_STATE_DIR_UNSET_FOR_TEST",
        workdir.join(".dappercode"),
    )
    .expect("default state dir");
    assert_eq!(state, workdir.join(".dappercode"));
    assert!(state.is_dir(), "the default state directory is created");

    let attachments = workdir.join(".dappercode-attachments");
    let unresolved = parse_unresolved_absolute_dir_env(
        "BRIDGE_ATTACHMENTS_DIR_UNSET_FOR_TEST",
        attachments.clone(),
    )
    .expect("default attachments dir");
    assert_eq!(unresolved, attachments);
    assert!(
        !unresolved.exists(),
        "attachment creation and reparse validation belong to PathPolicy",
    );
}

#[test]
fn workdir_validation_does_not_create_an_unused_attachment_directory() {
    let temp = TestDir::new();
    let workdir = temp.path().canonicalize().expect("canonical workdir");

    assert_eq!(
        resolve_bridge_workdir(workdir.clone()).expect("valid workdir"),
        workdir,
    );
    assert!(!workdir.join(".dappercode-attachments").exists());
}

#[test]
fn an_explicit_state_directory_overrides_the_default() {
    let temp = TestDir::new();
    let configured = temp.path().join("central/state");
    let _guard = DirEnvGuard::set("BRIDGE_STATE_DIR", &configured);

    let resolved = parse_absolute_dir_env("BRIDGE_STATE_DIR", temp.path().join("ignored"))
        .expect("explicit state dir");
    assert_eq!(resolved, configured.canonicalize().expect("canonical"));
    assert!(!temp.path().join("ignored").exists());
}

#[test]
fn a_blank_directory_variable_falls_back_to_the_default() {
    let temp = TestDir::new();
    let _guard = DirEnvGuard::set_raw("BRIDGE_STATE_DIR", "   ");

    let resolved = parse_absolute_dir_env("BRIDGE_STATE_DIR", temp.path().join("fallback"))
        .expect("fallback state dir");
    assert_eq!(
        resolved,
        temp.path()
            .join("fallback")
            .canonicalize()
            .expect("canonical"),
    );
}

#[test]
fn a_relative_directory_variable_is_rejected() {
    let temp = TestDir::new();
    let _guard = DirEnvGuard::set_raw("BRIDGE_STATE_DIR", "relative/state");

    let error = parse_absolute_dir_env("BRIDGE_STATE_DIR", temp.path().to_path_buf())
        .expect_err("relative paths must be rejected");
    assert!(error.contains("must be an absolute path"), "{error}");
}

#[test]
fn a_directory_variable_that_cannot_be_created_is_reported() {
    let temp = TestDir::new();
    let blocking_file = temp.path().join("blocked");
    std::fs::write(&blocking_file, b"file").expect("write blocking file");
    let _guard = DirEnvGuard::set("BRIDGE_STATE_DIR", blocking_file.join("child"));

    let error = parse_absolute_dir_env("BRIDGE_STATE_DIR", temp.path().to_path_buf())
        .expect_err("a file cannot host a directory");
    assert!(error.contains("could not be created"), "{error}");
}

fn no_auth_config(host: &str) -> BridgeConfig {
    BridgeConfig {
        host: host.to_string(),
        port: 8787,
        preview_host: "127.0.0.1".to_string(),
        preview_port: 8788,
        preview_enabled: true,
        connect_url: None,
        preview_connect_url: None,
        workdir: PathBuf::from("/tmp/workdir"),
        state_dir: PathBuf::from("/tmp/workdir/.dappercode"),
        attachments_dir: PathBuf::from("/tmp/workdir/.dappercode-attachments"),
        acp_manifest_path: PathBuf::from("/tmp/workdir/.dappercode/agents.json"),
        acp_approved_executable_roots: vec![PathBuf::from("/bin")],
        acp_initialize_timeout: Duration::from_secs(15),
        auth_token: None,
        auth_enabled: false,
        allow_insecure_no_auth: true,
        no_auth_allowed_origins: HashSet::new(),
        allow_query_token_auth: false,
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

fn headers_with_origin(origin: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(ORIGIN, origin.parse().expect("valid test header"));
    headers
}

#[test]
fn no_auth_listener_requires_literal_loopback_ip() {
    for host in ["127.0.0.1", "127.42.0.9", "::1"] {
        assert!(
            validate_no_auth_listener(host).is_ok(),
            "expected {host} to pass",
        );
    }
    for host in ["0.0.0.0", "::", "192.168.1.20", "10.0.0.4", "localhost"] {
        assert!(
            validate_no_auth_listener(host).is_err(),
            "expected {host} to fail",
        );
    }
}

#[test]
fn no_auth_allows_originless_operator_and_native_clients() {
    assert!(no_auth_config("127.0.0.1").is_browser_origin_allowed(&HeaderMap::new()));
}

#[test]
fn no_auth_allows_only_same_or_explicit_exact_browser_origins() {
    let mut config = no_auth_config("127.0.0.1");
    config
        .no_auth_allowed_origins
        .insert("https://trusted.example".to_string());

    assert!(config.is_browser_origin_allowed(&headers_with_origin("http://127.0.0.1:8787")));
    assert!(config.is_browser_origin_allowed(&headers_with_origin("https://trusted.example")));
    assert!(!config.is_browser_origin_allowed(&headers_with_origin("https://trusted.example:444")));
    assert!(!config.is_browser_origin_allowed(&headers_with_origin("https://evil.example")));
    assert!(!config.is_browser_origin_allowed(&headers_with_origin("http://192.168.1.20:8787")));
    assert!(!config.is_browser_origin_allowed(&headers_with_origin("*")));
    assert!(!config.is_browser_origin_allowed(&headers_with_origin("null")));

    let mut malformed_origin = HeaderMap::new();
    malformed_origin.insert(
        ORIGIN,
        axum::http::HeaderValue::from_bytes(b"\xff").unwrap(),
    );
    assert!(!config.is_browser_origin_allowed(&malformed_origin));

    let mut duplicate_origins = headers_with_origin("http://127.0.0.1:8787");
    duplicate_origins.append(ORIGIN, "https://evil.example".parse().unwrap());
    assert!(!config.is_browser_origin_allowed(&duplicate_origins));
}

#[test]
fn no_auth_recognizes_ipv6_listener_origin() {
    let config = no_auth_config("::1");
    assert!(config.is_browser_origin_allowed(&headers_with_origin("http://[::1]:8787")));
    assert!(!config.is_browser_origin_allowed(&headers_with_origin("http://127.0.0.1:8787")));
}

#[test]
fn configured_origins_reject_wildcards_null_and_non_origins() {
    assert_eq!(
        normalize_browser_origin("https://trusted.example/"),
        Some("https://trusted.example".to_string()),
    );
    for origin in [
        "*",
        "null",
        "https://*.example.com",
        "https://user@example.com",
        "https://example.com/path",
        "https://example.com?query=1",
        "file:///tmp/index.html",
    ] {
        assert!(
            normalize_browser_origin(origin).is_none(),
            "expected {origin} to fail",
        );
    }
}

#[test]
fn authenticated_mode_does_not_apply_no_auth_origin_policy() {
    let mut config = no_auth_config("127.0.0.1");
    config.auth_enabled = true;
    config.auth_token = Some("secret".to_string());
    assert!(config.is_browser_origin_allowed(&headers_with_origin("https://evil.example")));
}

#[test]
fn authorization_covers_bearer_and_query_token_variants() {
    let mut config = no_auth_config("127.0.0.1");
    assert!(config.is_authorized(&HeaderMap::new(), None));

    config.auth_enabled = true;
    assert!(!config.is_authorized(&HeaderMap::new(), None));
    config.auth_token = Some("secret".to_string());

    for raw in [
        "Basic secret",
        "Bearer",
        "Bearer secret extra",
        "Bearer wrong",
    ] {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", raw.parse().unwrap());
        assert!(!config.is_authorized(&headers, None), "accepted {raw}");
    }

    let mut headers = HeaderMap::new();
    headers.insert("authorization", "bEaReR secret".parse().unwrap());
    assert!(config.is_authorized(&headers, None));

    config.allow_query_token_auth = true;
    assert!(!config.is_authorized(&HeaderMap::new(), Some("   ")));
    assert!(!config.is_authorized(&HeaderMap::new(), Some("wrong")));
    assert!(config.is_authorized(&HeaderMap::new(), Some(" secret ")));
}

#[test]
fn connect_url_normalization_rejects_unsafe_values_and_strips_suffixes() {
    assert_eq!(normalize_connect_url("   "), None);
    assert_eq!(normalize_connect_url("not a url"), None);
    assert_eq!(normalize_connect_url("ftp://example.com"), None);
    assert_eq!(normalize_connect_url("https://user@example.com"), None);
    assert_eq!(
        normalize_connect_url("https://example.com/"),
        Some("https://example.com".into()),
    );
    assert_eq!(
        normalize_connect_url(" https://example.com/base///?query=1#fragment "),
        Some("https://example.com/base".into()),
    );
    assert_eq!(normalize_connect_url("https://:secret@example.com"), None);
}

#[test]
fn unresolved_directories_and_path_lists_validate_every_input_shape() {
    let suffix = uuid::Uuid::new_v4();
    let directory_name = format!("DAPPERCODE_TEST_UNRESOLVED_DIR_{suffix}");
    let path_list_name = format!("DAPPERCODE_TEST_PATH_LIST_{suffix}");
    let fallback = env::temp_dir().join(format!("dappercode-unresolved-{suffix}"));
    let _directory_env = DirEnvGuard::unset(directory_name.clone());
    let _path_list_env = DirEnvGuard::unset(path_list_name.clone());

    assert_eq!(
        parse_unresolved_absolute_dir_env(&directory_name, fallback.clone()).unwrap(),
        fallback,
    );
    set_test_var(&directory_name, "   ");
    assert_eq!(
        parse_unresolved_absolute_dir_env(&directory_name, fallback.clone()).unwrap(),
        fallback,
    );
    set_test_var(&directory_name, "relative/path");
    assert!(parse_unresolved_absolute_dir_env(&directory_name, fallback.clone()).is_err());

    let defaults = [fallback.clone()];
    assert_eq!(
        parse_path_list_env(&path_list_name, &defaults).unwrap(),
        defaults,
    );
    set_test_var(&path_list_name, "");
    assert!(parse_path_list_env(&path_list_name, &defaults).is_err());
    set_test_var(
        &path_list_name,
        env::join_paths([fallback.as_path(), std::path::Path::new("relative")]).unwrap(),
    );
    assert!(parse_path_list_env(&path_list_name, &defaults).is_err());
    set_test_var(
        &path_list_name,
        env::join_paths([fallback.as_path(), env::temp_dir().as_path()]).unwrap(),
    );
    assert_eq!(
        parse_path_list_env(&path_list_name, &defaults)
            .unwrap()
            .len(),
        2,
    );
}

#[test]
fn positive_u64_parser_covers_missing_valid_zero_and_invalid_values() {
    let name = format!("DAPPERCODE_TEST_U64_{}", uuid::Uuid::new_v4());
    let _env = DirEnvGuard::unset(name.clone());
    assert_eq!(parse_positive_u64_env(&name, 11).unwrap(), 11);
    set_test_var(&name, " 17 ");
    assert_eq!(parse_positive_u64_env(&name, 11).unwrap(), 17);
    set_test_var(&name, "0");
    assert!(parse_positive_u64_env(&name, 11).is_err());
    set_test_var(&name, "invalid");
    assert!(parse_positive_u64_env(&name, 11).is_err());
}

#[test]
fn websocket_limits_validate_both_relationships() {
    assert!(WebSocketResourceLimits {
        max_frame_bytes: 2,
        max_message_bytes: 1,
        per_client_in_flight: 1,
        global_in_flight: 1,
    }
    .validate()
    .is_err());
    assert!(WebSocketResourceLimits {
        max_frame_bytes: 1,
        max_message_bytes: 1,
        per_client_in_flight: 2,
        global_in_flight: 1,
    }
    .validate()
    .is_err());
    assert!(WebSocketResourceLimits {
        max_frame_bytes: 1,
        max_message_bytes: 1,
        per_client_in_flight: 1,
        global_in_flight: 1,
    }
    .validate()
    .is_ok());
}

#[test]
fn environment_parsers_cover_missing_valid_and_invalid_values() {
    let suffix = uuid::Uuid::new_v4();
    let bool_name = format!("DAPPERCODE_TEST_BOOL_{suffix}");
    let default_bool_name = format!("DAPPERCODE_TEST_DEFAULT_BOOL_{suffix}");
    let usize_name = format!("DAPPERCODE_TEST_USIZE_{suffix}");
    let url_name = format!("DAPPERCODE_TEST_URL_{suffix}");
    let origin_name = format!("DAPPERCODE_TEST_ORIGIN_{suffix}");
    let _env = [
        &bool_name,
        &default_bool_name,
        &usize_name,
        &url_name,
        &origin_name,
    ]
    .into_iter()
    .cloned()
    .map(DirEnvGuard::unset)
    .collect::<Vec<_>>();

    assert!(!parse_bool_env(&bool_name));
    set_test_var(&bool_name, " TRUE ");
    assert!(parse_bool_env(&bool_name));
    set_test_var(&bool_name, "false");
    assert!(!parse_bool_env(&bool_name));

    assert!(parse_bool_env_with_default(&default_bool_name, true));
    set_test_var(&default_bool_name, "true");
    assert!(parse_bool_env_with_default(&default_bool_name, false));
    set_test_var(&default_bool_name, "false");
    assert!(!parse_bool_env_with_default(&default_bool_name, true));
    set_test_var(&default_bool_name, "invalid");
    assert!(parse_bool_env_with_default(&default_bool_name, true));

    assert_eq!(parse_positive_usize_env(&usize_name, 7).unwrap(), 7);
    set_test_var(&usize_name, "9");
    assert_eq!(parse_positive_usize_env(&usize_name, 7).unwrap(), 9);
    set_test_var(&usize_name, "0");
    assert!(parse_positive_usize_env(&usize_name, 7).is_err());
    set_test_var(&usize_name, "invalid");
    assert!(parse_positive_usize_env(&usize_name, 7).is_err());

    assert_eq!(parse_connect_url_env(&url_name).unwrap(), None);
    set_test_var(&url_name, "  ");
    assert_eq!(parse_connect_url_env(&url_name).unwrap(), None);
    set_test_var(&url_name, "https://example.com/path/");
    assert_eq!(
        parse_connect_url_env(&url_name).unwrap(),
        Some("https://example.com/path".into()),
    );
    set_test_var(&url_name, "ftp://example.com");
    assert!(parse_connect_url_env(&url_name).is_err());

    assert!(parse_origin_csv_env(&origin_name).unwrap().is_empty());
    set_test_var(&origin_name, "https://one.example, https://two.example");
    assert_eq!(parse_origin_csv_env(&origin_name).unwrap().len(), 2);
    set_test_var(&origin_name, "https://example.com/path");
    assert!(parse_origin_csv_env(&origin_name).is_err());
}

#[test]
fn bridge_config_loads_a_fully_configured_environment() {
    const NAMES: &[&str] = &[
        "BRIDGE_HOST",
        "BRIDGE_PORT",
        "BRIDGE_PREVIEW_HOST",
        "BRIDGE_PREVIEW_PORT",
        "BRIDGE_DISABLE_BROWSER_PREVIEW",
        "BRIDGE_CONNECT_URL",
        "BRIDGE_PREVIEW_CONNECT_URL",
        "BRIDGE_WORKDIR",
        "ACP_AGENT_MANIFEST",
        "ACP_AGENT_ROOTS",
        "ACP_INITIALIZE_TIMEOUT_MS",
        "BRIDGE_AUTH_TOKEN",
        "BRIDGE_ALLOW_INSECURE_NO_AUTH",
        "BRIDGE_NO_AUTH_ALLOWED_ORIGINS",
        "BRIDGE_ALLOW_QUERY_TOKEN_AUTH",
        "BRIDGE_ALLOW_OUTSIDE_ROOT_CWD",
        "BRIDGE_SHOW_PAIRING_QR",
        "BRIDGE_WS_MAX_FRAME_BYTES",
        "BRIDGE_WS_MAX_MESSAGE_BYTES",
        "BRIDGE_WS_PER_CLIENT_IN_FLIGHT",
        "BRIDGE_WS_GLOBAL_IN_FLIGHT",
        "PHONE_CALL_SIP_SERVER",
        "PHONE_CALL_SIP_TRANSPORT",
        "PHONE_CALL_SIP_USERNAME",
        "PHONE_CALL_SIP_PASSWORD",
        "PHONE_CALL_CALLER_ID",
        "PHONE_CALL_USER_DISPLAY_NAME",
        "PHONE_CALL_STT_BASE_URL",
        "PHONE_CALL_STT_MODEL",
        "PHONE_CALL_LLM_BASE_URL",
        "PHONE_CALL_LLM_MODEL",
        "PHONE_CALL_TTS_BASE_URL",
        "PHONE_CALL_TTS_MODEL",
        "PHONE_CALL_TTS_VOICE",
    ];

    let _environment = NAMES
        .iter()
        .map(|name| DirEnvGuard::unset(*name))
        .collect::<Vec<_>>();
    let root = TestDir::new();
    let values = [
        ("BRIDGE_HOST", "127.0.0.1"),
        ("BRIDGE_PORT", "9000"),
        ("BRIDGE_PREVIEW_HOST", "127.0.0.1"),
        ("BRIDGE_PREVIEW_PORT", "9001"),
        ("BRIDGE_CONNECT_URL", "https://bridge.example/base/"),
        ("BRIDGE_PREVIEW_CONNECT_URL", "https://preview.example/"),
        ("BRIDGE_WORKDIR", root.path().to_str().unwrap()),
        ("ACP_AGENT_MANIFEST", "/tmp/agents.json"),
        ("ACP_AGENT_ROOTS", "/bin:/usr/bin"),
        ("ACP_INITIALIZE_TIMEOUT_MS", "2500"),
        ("BRIDGE_AUTH_TOKEN", "secret"),
        ("BRIDGE_ALLOW_INSECURE_NO_AUTH", "false"),
        ("BRIDGE_NO_AUTH_ALLOWED_ORIGINS", "https://trusted.example"),
        ("BRIDGE_ALLOW_QUERY_TOKEN_AUTH", "true"),
        ("BRIDGE_ALLOW_OUTSIDE_ROOT_CWD", "false"),
        ("BRIDGE_SHOW_PAIRING_QR", "false"),
        ("BRIDGE_WS_MAX_FRAME_BYTES", "1024"),
        ("BRIDGE_WS_MAX_MESSAGE_BYTES", "2048"),
        ("BRIDGE_WS_PER_CLIENT_IN_FLIGHT", "2"),
        ("BRIDGE_WS_GLOBAL_IN_FLIGHT", "4"),
    ];
    for (name, value) in values {
        set_test_var(name, value);
    }

    let config = BridgeConfig::from_env().unwrap();
    assert_eq!(config.port, 9000);
    assert_eq!(config.preview_port, 9001);
    assert_eq!(
        config.connect_url.as_deref(),
        Some("https://bridge.example/base"),
    );
    assert_eq!(config.acp_manifest_path, PathBuf::from("/tmp/agents.json"));
    assert_eq!(config.acp_approved_executable_roots.len(), 2);
    assert_eq!(config.acp_initialize_timeout, Duration::from_millis(2500));
    assert!(config.auth_enabled);
    assert!(config.allow_query_token_auth);
    assert!(!config.allow_outside_root_cwd);
    assert_eq!(config.ws_limits.global_in_flight, 4);

    set_test_var("BRIDGE_PREVIEW_PORT", "9000");
    assert!(BridgeConfig::from_env().is_err());
    set_test_var("BRIDGE_DISABLE_BROWSER_PREVIEW", "true");
    set_test_var("BRIDGE_PORT", "0");
    set_test_var("BRIDGE_PREVIEW_PORT", "0");
    let ephemeral = BridgeConfig::from_env().unwrap();
    assert_eq!((ephemeral.port, ephemeral.preview_port), (0, 0));
    assert!(!ephemeral.preview_enabled);
    set_test_var("BRIDGE_DISABLE_BROWSER_PREVIEW", "false");
    set_test_var("BRIDGE_PORT", "9000");
    set_test_var("BRIDGE_PREVIEW_PORT", "9001");
    assert!(BridgeConfig::from_env().is_ok());

    remove_test_var("BRIDGE_AUTH_TOKEN");
    set_test_var("BRIDGE_ALLOW_INSECURE_NO_AUTH", "false");
    assert!(BridgeConfig::from_env().is_err());
    set_test_var("BRIDGE_ALLOW_INSECURE_NO_AUTH", "true");
    set_test_var("BRIDGE_HOST", "0.0.0.0");
    assert!(BridgeConfig::from_env().is_err());
    set_test_var("BRIDGE_HOST", "127.0.0.1");
    assert!(!BridgeConfig::from_env().unwrap().auth_enabled);

    assert_eq!(normalize_connect_url("https://user:pass@example.com"), None);
    assert_eq!(normalize_connect_url("https://:pass@example.com"), None);
    assert_eq!(normalize_browser_origin(""), None);
    assert_eq!(
        normalize_browser_origin("https://user:pass@example.com"),
        None,
    );
    assert_eq!(
        normalize_browser_origin("https://example.com/#fragment"),
        None,
    );
}

#[test]
fn phone_call_runtime_config_parses_defaults_redacts_password_and_rejects_partial_or_invalid() {
    const PHONE_VARS: &[&str] = &[
        "PHONE_CALL_SIP_SERVER",
        "PHONE_CALL_SIP_TRANSPORT",
        "PHONE_CALL_SIP_USERNAME",
        "PHONE_CALL_SIP_PASSWORD",
        "PHONE_CALL_CALLER_ID",
        "PHONE_CALL_USER_DISPLAY_NAME",
        "PHONE_CALL_STT_BASE_URL",
        "PHONE_CALL_STT_MODEL",
        "PHONE_CALL_LLM_BASE_URL",
        "PHONE_CALL_LLM_MODEL",
        "PHONE_CALL_TTS_BASE_URL",
        "PHONE_CALL_TTS_MODEL",
        "PHONE_CALL_TTS_VOICE",
    ];
    let _guards = PHONE_VARS
        .iter()
        .map(|name| DirEnvGuard::unset(*name))
        .collect::<Vec<_>>();

    assert_eq!(PhoneCallRuntimeConfig::from_env().unwrap(), None);

    // Partial configuration must fail cleanly.
    set_test_var("PHONE_CALL_SIP_SERVER", "sip.telnyx.com:5061");
    assert!(PhoneCallRuntimeConfig::from_env().is_err());

    remove_test_var("PHONE_CALL_SIP_SERVER");
    set_test_var("PHONE_CALL_CALLER_ID", "+15551234567");
    assert!(PhoneCallRuntimeConfig::from_env().is_err());

    set_test_var("PHONE_CALL_SIP_SERVER", "sip.telnyx.com:5061");
    set_test_var("PHONE_CALL_SIP_USERNAME", "sip-user");
    assert!(PhoneCallRuntimeConfig::from_env().is_err());

    remove_test_var("PHONE_CALL_SIP_USERNAME");
    set_test_var("PHONE_CALL_SIP_PASSWORD", "top-secret-sip-pw");
    assert!(PhoneCallRuntimeConfig::from_env().is_err());

    // Port 5061 defaults transport to TLS and applies Ollama/Phonon defaults.
    set_test_var("PHONE_CALL_SIP_USERNAME", "sip-user");
    let tls_default = PhoneCallRuntimeConfig::from_env()
        .expect("valid phone call config")
        .expect("present phone call config");
    assert_eq!(tls_default.server_host, "sip.telnyx.com");
    assert_eq!(tls_default.server_port, 5061);
    assert_eq!(tls_default.transport, SipTransportKind::Tls);
    assert_eq!(tls_default.sip_username, "sip-user");
    assert_eq!(tls_default.sip_password, "top-secret-sip-pw");
    assert_eq!(tls_default.caller_id, "+15551234567");
    assert_eq!(tls_default.voice, VoicePipelineConfig::default());

    let debug_repr = format!("{tls_default:?}");
    assert!(!debug_repr.contains("top-secret-sip-pw"));
    assert!(debug_repr.contains("[REDACTED]"));

    // Non-5061 port defaults transport to UDP, and IPv6 [::1]:5060 unbrackets host.
    set_test_var("PHONE_CALL_SIP_SERVER", "[::1]:5060");
    set_test_var("PHONE_CALL_USER_DISPLAY_NAME", "Alex Example");
    let udp_default = PhoneCallRuntimeConfig::from_env()
        .expect("valid IPv6 UDP config")
        .expect("present");
    assert_eq!(udp_default.server_host, "::1");
    assert_eq!(udp_default.server_port, 5060);
    assert_eq!(udp_default.transport, SipTransportKind::Udp);
    assert_eq!(udp_default.user_display_name, "Alex Example");

    // Invalid E.164, invalid transport, bad host:port, and non-loopback model URL must fail.
    set_test_var("PHONE_CALL_CALLER_ID", "15551234567");
    assert!(PhoneCallRuntimeConfig::from_env().is_err());
    set_test_var("PHONE_CALL_CALLER_ID", "+15551234567");

    set_test_var("PHONE_CALL_SIP_TRANSPORT", "tcp");
    assert!(PhoneCallRuntimeConfig::from_env().is_err());
    set_test_var("PHONE_CALL_SIP_TRANSPORT", "udp");

    set_test_var("PHONE_CALL_SIP_SERVER", "sip.telnyx.com:0");
    assert!(PhoneCallRuntimeConfig::from_env().is_err());
    set_test_var("PHONE_CALL_SIP_SERVER", "127.0.0.1:5060");

    set_test_var("PHONE_CALL_LLM_BASE_URL", "https://api.openai.com/v1");
    assert!(PhoneCallRuntimeConfig::from_env().is_err());
}

#[test]
fn phone_call_runtime_config_rejects_each_invalid_field_and_honors_explicit_tls() {
    const PHONE_VARS: &[&str] = &[
        "PHONE_CALL_SIP_SERVER",
        "PHONE_CALL_SIP_TRANSPORT",
        "PHONE_CALL_SIP_USERNAME",
        "PHONE_CALL_SIP_PASSWORD",
        "PHONE_CALL_CALLER_ID",
        "PHONE_CALL_USER_DISPLAY_NAME",
        "PHONE_CALL_STT_BASE_URL",
        "PHONE_CALL_STT_MODEL",
        "PHONE_CALL_LLM_BASE_URL",
        "PHONE_CALL_LLM_MODEL",
        "PHONE_CALL_TTS_BASE_URL",
        "PHONE_CALL_TTS_MODEL",
        "PHONE_CALL_TTS_VOICE",
    ];
    let _guards = PHONE_VARS
        .iter()
        .map(|name| DirEnvGuard::unset(*name))
        .collect::<Vec<_>>();
    let generated_secret = format!("sip-secret-{}", std::process::id());

    // Any SIP credential or transport without a server is a partial configuration.
    for (name, value) in [
        ("PHONE_CALL_SIP_TRANSPORT", "tls".to_string()),
        ("PHONE_CALL_SIP_USERNAME", "sip-user".to_string()),
        ("PHONE_CALL_SIP_PASSWORD", generated_secret.clone()),
    ] {
        set_test_var(name, value);
        let err = PhoneCallRuntimeConfig::from_env().expect_err("partial phone config");
        assert!(
            err.contains("PHONE_CALL_SIP_SERVER is required"),
            "{name}: {err}",
        );
        remove_test_var(name);
    }

    // Blank values are treated as absent rather than as partial configuration.
    set_test_var("PHONE_CALL_SIP_TRANSPORT", "   ");
    set_test_var("PHONE_CALL_SIP_PASSWORD", "");
    assert_eq!(PhoneCallRuntimeConfig::from_env().unwrap(), None);

    let baseline = [
        ("PHONE_CALL_SIP_SERVER", "sip.example.com:5070".to_string()),
        ("PHONE_CALL_SIP_TRANSPORT", "TLS".to_string()),
        ("PHONE_CALL_SIP_USERNAME", "sip-user".to_string()),
        ("PHONE_CALL_SIP_PASSWORD", generated_secret.clone()),
        ("PHONE_CALL_CALLER_ID", "+15551234567".to_string()),
        ("PHONE_CALL_USER_DISPLAY_NAME", "Alex Example".to_string()),
    ];
    let apply_baseline = || {
        for (name, value) in &baseline {
            set_test_var(name, value);
        }
    };
    apply_baseline();
    let explicit_tls = PhoneCallRuntimeConfig::from_env()
        .expect("valid explicit TLS config")
        .expect("present phone call config");
    assert_eq!(explicit_tls.transport, SipTransportKind::Tls);
    assert_eq!(explicit_tls.server_host, "sip.example.com");
    assert_eq!(explicit_tls.server_port, 5070);
    assert_eq!(explicit_tls.sip_password, generated_secret);

    const USERNAME_ERROR: &str = "PHONE_CALL_SIP_USERNAME must be at most";
    const PASSWORD_ERROR: &str = "PHONE_CALL_SIP_PASSWORD must be non-empty";
    const DISPLAY_NAME_ERROR: &str = "PHONE_CALL_USER_DISPLAY_NAME must be at most";
    const CALLER_ID_ERROR: &str = "PHONE_CALL_CALLER_ID must start with '+' followed by 7 to 15";
    const SERVER_ERROR: &str = "PHONE_CALL_SIP_SERVER must be a valid host:port";
    const HOST_ERROR: &str = "PHONE_CALL_SIP_SERVER contains an invalid host";
    let cases = [
        (
            "PHONE_CALL_SIP_USERNAME",
            "u".repeat(MAX_SIP_USERNAME_BYTES + 1),
            USERNAME_ERROR,
        ),
        (
            "PHONE_CALL_SIP_USERNAME",
            "sip\u{7}user".to_string(),
            USERNAME_ERROR,
        ),
        (
            "PHONE_CALL_SIP_PASSWORD",
            " ".repeat(generated_secret.len()),
            PASSWORD_ERROR,
        ),
        (
            "PHONE_CALL_SIP_PASSWORD",
            generated_secret.clone() + &"x".repeat(MAX_SIP_PASSWORD_BYTES),
            PASSWORD_ERROR,
        ),
        (
            "PHONE_CALL_SIP_PASSWORD",
            generated_secret.clone() + "\r",
            PASSWORD_ERROR,
        ),
        (
            "PHONE_CALL_SIP_PASSWORD",
            generated_secret.clone() + "\n",
            PASSWORD_ERROR,
        ),
        (
            "PHONE_CALL_SIP_PASSWORD",
            generated_secret.clone() + "\0",
            PASSWORD_ERROR,
        ),
        (
            "PHONE_CALL_USER_DISPLAY_NAME",
            "D".repeat(MAX_USER_DISPLAY_NAME_BYTES + 1),
            DISPLAY_NAME_ERROR,
        ),
        (
            "PHONE_CALL_USER_DISPLAY_NAME",
            "David\u{1b}Parks".to_string(),
            DISPLAY_NAME_ERROR,
        ),
        (
            "PHONE_CALL_CALLER_ID",
            "+123456".to_string(),
            CALLER_ID_ERROR,
        ),
        (
            "PHONE_CALL_CALLER_ID",
            "+1234567890123456".to_string(),
            CALLER_ID_ERROR,
        ),
        (
            "PHONE_CALL_CALLER_ID",
            "+1555123456a".to_string(),
            CALLER_ID_ERROR,
        ),
        (
            "PHONE_CALL_SIP_SERVER",
            "h".repeat(266) + ":5060",
            SERVER_ERROR,
        ),
        (
            "PHONE_CALL_SIP_SERVER",
            "sip\u{1}example.com:5060".to_string(),
            SERVER_ERROR,
        ),
        (
            "PHONE_CALL_SIP_SERVER",
            "sip example.com:5060".to_string(),
            SERVER_ERROR,
        ),
        ("PHONE_CALL_SIP_SERVER", ":5060".to_string(), HOST_ERROR),
        (
            "PHONE_CALL_SIP_SERVER",
            "sip:example.com:5060".to_string(),
            HOST_ERROR,
        ),
        (
            "PHONE_CALL_SIP_SERVER",
            "sip..example.com:5060".to_string(),
            HOST_ERROR,
        ),
        (
            "PHONE_CALL_SIP_SERVER",
            ".example.com:5060".to_string(),
            HOST_ERROR,
        ),
        (
            "PHONE_CALL_SIP_SERVER",
            "-example.com:5060".to_string(),
            HOST_ERROR,
        ),
        (
            "PHONE_CALL_SIP_SERVER",
            "example-:5060".to_string(),
            HOST_ERROR,
        ),
        (
            "PHONE_CALL_SIP_SERVER",
            "sip_example.com:5060".to_string(),
            HOST_ERROR,
        ),
    ];
    // Failures name the case index, never the value: password cases carry the generated secret.
    for (index, (name, value, expected)) in cases.into_iter().enumerate() {
        apply_baseline();
        set_test_var(name, &value);
        let err = PhoneCallRuntimeConfig::from_env()
            .expect_err("invalid phone call field must be rejected");
        assert!(
            err.contains(expected),
            "case {index} ({name}): unexpected error {err}",
        );
        assert!(
            !err.contains(&generated_secret),
            "errors must not echo the SIP secret",
        );
    }

    assert_eq!(
        parse_sip_server_host_port(""),
        Err(SERVER_ERROR.to_string()),
    );
    assert_eq!(
        normalize_browser_origin("https://:secret@example.com"),
        None,
    );
}
