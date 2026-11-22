use super::{
    browser_preview_label_for_port, build_preview_bootstrap_path, is_loopback_http_port_reachable,
    normalize_browser_preview_target_url, BrowserPreviewService, BrowserPreviewSessionResponse,
    SystemTime, Url, BROWSER_PREVIEW_MAX_SESSIONS,
};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn test_service() -> BrowserPreviewService {
    let service = BrowserPreviewService::new(8787, 8788, None, None);
    service.set_available(true);
    service
}

#[test]
fn session_debug_redacts_credentials_and_target_urls() {
    let session = BrowserPreviewSessionResponse {
        session_id: "session-secret".to_string(),
        target_url: "http://example.test/?api_key=target-secret".to_string(),
        preview_port: 8788,
        preview_base_url: None,
        bootstrap_path: "/?st=bootstrap-secret".to_string(),
        created_at: "created".to_string(),
        last_accessed_at: "accessed".to_string(),
        expires_at: "expires".to_string(),
    };
    for output in [format!("{session:?}"), format!("{session:#?}")] {
        assert!(!output.contains("session-secret"));
        assert!(!output.contains("target-secret"));
        assert!(!output.contains("bootstrap-secret"));
        assert!(output.contains("[REDACTED]"));
    }
}

#[tokio::test]
async fn credentials_are_random_and_owner_replacement_is_immediate() {
    let service = test_service();
    let first = service
        .create_session(7, "http://127.0.0.1:3000")
        .await
        .unwrap();
    let second = service
        .create_session(7, "http://127.0.0.1:5173")
        .await
        .unwrap();

    assert_ne!(first.session_id, second.session_id);
    assert!(first.session_id.len() >= 32);
    assert!(second.bootstrap_path.contains("st="));
    assert!(service
        .resolve_bootstrap(&first.session_id, "irrelevant")
        .await
        .is_none());
}

#[tokio::test]
async fn unavailable_service_rejects_new_sessions() {
    let service = BrowserPreviewService::new(8787, 8788, None, None);
    assert!(!service.is_available());
    let error = service
        .create_session(7, "http://127.0.0.1:3000")
        .await
        .unwrap_err();
    assert_eq!(error.message, "browser preview server is unavailable");
}

#[tokio::test]
async fn close_and_disconnect_revocation_are_owner_scoped() {
    let service = test_service();
    let session = service
        .create_session(7, "http://127.0.0.1:3000")
        .await
        .unwrap();

    assert!(!service.close_session(8, &session.session_id).await);
    assert_eq!(service.revoke_owner(8).await, 0);
    assert_eq!(service.revoke_owner(7).await, 1);
}

#[tokio::test]
async fn bootstrap_and_cookie_resolution_require_the_generated_token() {
    let service = test_service();
    let session = service
        .create_session(7, "http://localhost:3000/path?mode=dev#ignored")
        .await
        .unwrap();
    let token = Url::parse(&format!("http://preview{}", session.bootstrap_path))
        .unwrap()
        .query_pairs()
        .find_map(|(key, value)| (key == "st").then(|| value.into_owned()))
        .unwrap();

    assert!(service.resolve_bootstrap("missing", &token).await.is_none());
    assert!(service
        .resolve_bootstrap(&session.session_id, "wrong")
        .await
        .is_none());
    let resolved = service
        .resolve_bootstrap(&session.session_id, &token)
        .await
        .unwrap();
    assert_eq!(resolved.session_id, session.session_id);
    assert_eq!(
        resolved.target_url.as_str(),
        "http://localhost:3000/path?mode=dev",
    );
    assert!(service.resolve_cookie("wrong").await.is_none());
    assert_eq!(
        service.resolve_cookie(&token).await.unwrap().session_id,
        session.session_id,
    );
    assert!(service.close_session(7, &session.session_id).await);
    assert!(!service.close_session(7, &session.session_id).await);
}

#[tokio::test]
async fn expired_sessions_are_removed_without_access_extending_them() {
    let service = test_service();
    let session = service
        .create_session(7, "http://127.0.0.1:3000")
        .await
        .unwrap();
    service
        .sessions
        .write()
        .await
        .get_mut(&session.session_id)
        .unwrap()
        .expires_at = SystemTime::UNIX_EPOCH;

    assert!(!service.close_session(7, &session.session_id).await);
}

#[test]
fn secure_cookie_follows_https_preview_origin() {
    assert!(BrowserPreviewService::new(
        8787,
        8788,
        Some("https://preview.example.com".to_string()),
        None,
    )
    .secure_cookie());
    assert!(BrowserPreviewService::new(
        8787,
        8788,
        None,
        Some("https://bridge.example.com".to_string()),
    )
    .secure_cookie());
    assert!(!BrowserPreviewService::new(8787, 8788, None, None).secure_cookie());
    assert!(
        !BrowserPreviewService::new(8787, 8788, Some("not a URL".to_string()), None,)
            .secure_cookie(),
    );
    assert!(!BrowserPreviewService::new(
        8787,
        8788,
        Some("http://preview.example.com".to_string()),
        Some("https://bridge.example.com".to_string()),
    )
    .secure_cookie());
}

#[test]
fn target_url_normalization_accepts_only_safe_loopback_http_urls() {
    assert!(normalize_browser_preview_target_url(" ").is_err());
    assert!(normalize_browser_preview_target_url("not a url").is_err());
    assert!(normalize_browser_preview_target_url("ftp://localhost/file").is_err());
    assert!(normalize_browser_preview_target_url("http://user@localhost/").is_err());
    assert!(normalize_browser_preview_target_url("http://user:pass@localhost/").is_err());
    assert!(normalize_browser_preview_target_url("http://:pass@localhost/").is_err());
    assert!(normalize_browser_preview_target_url("http:///missing").is_err());
    assert!(normalize_browser_preview_target_url("http://example.com/").is_err());

    assert_eq!(
        normalize_browser_preview_target_url(" http://LOCALHOST:3000#fragment ")
            .unwrap()
            .as_str(),
        "http://localhost:3000/",
    );
    assert_eq!(
        normalize_browser_preview_target_url("https://127.0.0.1/path?q=1")
            .unwrap()
            .as_str(),
        "https://127.0.0.1/path?q=1",
    );
    assert_eq!(
        normalize_browser_preview_target_url("http://[::1]:8080")
            .unwrap()
            .as_str(),
        "http://[::1]:8080/",
    );
}

#[test]
fn bootstrap_path_preserves_existing_query_and_encodes_credentials() {
    let target = Url::parse("http://localhost:3000/a%20b?mode=one#fragment").unwrap();
    assert_eq!(
        build_preview_bootstrap_path(&target, "session/id", "token value"),
        "/a%20b?mode=one&sid=session%2Fid&st=token+value",
    );
    let target = Url::parse("http://localhost:3000/").unwrap();
    assert_eq!(
        build_preview_bootstrap_path(&target, "sid", "token"),
        "/?sid=sid&st=token",
    );
}

async fn local_http_server(response: &'static [u8]) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 1024];
        let _ = socket.read(&mut request).await;
        socket.write_all(response).await.unwrap();
    });
    (port, task)
}

#[tokio::test]
async fn reachability_accepts_http_errors_but_rejects_closed_ports() {
    let (port, task) = local_http_server(
        b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    )
    .await;
    let http = crate::tls::http_client();
    assert!(is_loopback_http_port_reachable(&http, port).await);
    task.await.unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let closed_port = listener.local_addr().unwrap().port();
    drop(listener);
    assert!(!is_loopback_http_port_reachable(&http, closed_port).await);
}

#[tokio::test]
async fn discovery_probes_local_listener_and_excludes_bridge_ports() {
    let (port, task) =
        local_http_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await;
    let service = Arc::new(BrowserPreviewService::new(1, 2, None, None));
    let response = service.discover_targets().await;
    task.await.unwrap();
    assert!(response.suggestions.iter().any(|item| item.port == port));
    assert!(!response
        .suggestions
        .iter()
        .any(|item| item.port == 1 || item.port == 2));
}

#[test]
fn labels_cover_known_and_fallback_ports() {
    for (port, label) in [
        (3000, "Local dev server on :3000"),
        (3005, "Local dev server on :3005"),
        (4173, "Vite preview on :4173"),
        (4200, "Angular dev server on :4200"),
        (4321, "Metro / Expo web on :4321"),
        (5000, "Local dev server on :5000"),
        (5173, "Vite dev server on :5173"),
        (5500, "Live Server on :5500"),
        (8000, "Local dev server on :8000"),
        (8080, "Local dev server on :8080"),
        (8081, "Metro bundler on :8081"),
        (9999, "Local dev server on :9999"),
    ] {
        assert_eq!(browser_preview_label_for_port(port), label);
    }
}

#[tokio::test]
async fn session_capacity_evicts_the_oldest_entry() {
    let service = test_service();
    let mut oldest_id = String::new();
    for owner in 0..=BROWSER_PREVIEW_MAX_SESSIONS {
        let response = service
            .create_session(owner as u64, "http://localhost:3000")
            .await
            .unwrap();
        if owner == 0 {
            oldest_id = response.session_id.clone();
        }
        if let Some(entry) = service.sessions.write().await.get_mut(&response.session_id) {
            entry.last_accessed_at = format!("{owner:04}");
        }
    }
    assert_eq!(
        service.sessions.read().await.len(),
        BROWSER_PREVIEW_MAX_SESSIONS,
    );
    assert!(!service.sessions.read().await.contains_key(&oldest_id));
}
