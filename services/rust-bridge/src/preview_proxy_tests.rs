use super::{
    preview_desktop_shell_response, preview_overview_shell_response, PreviewViewportConfig,
    PreviewViewportPreset, Response, StatusCode, CACHE_CONTROL, CONTENT_TYPE, REFERRER_POLICY,
};
use axum::body::to_bytes;

fn desktop_viewport() -> PreviewViewportConfig {
    PreviewViewportConfig {
        preset: PreviewViewportPreset::Desktop,
        width: Some(1440),
        height: Some(900),
    }
}

async fn response_body(response: Response) -> String {
    String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("preview shell response body should be readable")
            .to_vec(),
    )
    .expect("preview shell response body should be UTF-8")
}

#[tokio::test]
async fn preview_shell_responses_share_headers_and_navigation_runtime() {
    let responses = [
        preview_desktop_shell_response("/workspace", desktop_viewport(), Some("session"), None),
        preview_overview_shell_response("/workspace", desktop_viewport(), Some("session"), None),
    ];

    for response in responses {
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(CONTENT_TYPE)
                .map(axum::http::HeaderValue::to_str)
                .and_then(Result::ok),
            Some("text/html; charset=utf-8"),
        );
        assert_eq!(
            response
                .headers()
                .get(CACHE_CONTROL)
                .map(axum::http::HeaderValue::to_str)
                .and_then(Result::ok),
            Some("no-store, private"),
        );
        assert_eq!(
            response
                .headers()
                .get(REFERRER_POLICY)
                .map(axum::http::HeaderValue::to_str)
                .and_then(Result::ok),
            Some("no-referrer"),
        );
        assert_eq!(
            response
                .headers()
                .get("x-content-type-options")
                .map(axum::http::HeaderValue::to_str)
                .and_then(Result::ok),
            Some("nosniff"),
        );

        let body = response_body(response).await;
        for marker in [
            "type: 'dappercodeDesktopFrameState'",
            "function currentFrameWindow()",
            "function currentFrameDocument()",
            "function installFrameObservers()",
            "new ResizeObserver",
            "new MutationObserver",
            "window.__dappercodeDesktopFrame =",
            "goBack: function()",
            "goForward: function()",
            "reload: function()",
        ] {
            assert!(
                body.contains(marker),
                "missing shared runtime marker: {marker}",
            );
        }
    }
}

#[tokio::test]
async fn preview_shell_responses_preserve_mode_layouts_and_sanitize_frame_source() {
    let path = "/workspace?sid=query-session&st=query-token&shell=overview&frame=0&theme=dark";
    let desktop = response_body(preview_desktop_shell_response(
        path,
        desktop_viewport(),
        Some("request-key"),
        Some("bootstrap-token"),
    ))
    .await;
    let overview = response_body(preview_overview_shell_response(
        path,
        desktop_viewport(),
        Some("request-key"),
        Some("bootstrap-token"),
    ))
    .await;

    for body in [&desktop, &overview] {
        assert!(
            body.contains(r#"var frameSrc = "/workspace?theme=dark&frame=1";"#),
            "frame source should retain only safe query parameters",
        );
        assert!(!body.contains("sid=query-session"));
        assert!(!body.contains("st=query-token"));
        assert!(!body.contains("shell=overview"));
        assert!(!body.contains("frame=0"));
    }

    assert!(desktop.contains(r#"title="Desktop preview""#));
    assert!(desktop.contains("background: #fff;"));
    assert!(desktop.contains("overflow-x: auto;"));
    assert!(desktop.contains("window.addEventListener('resize', queueMeasureFrameHeight"));
    assert!(desktop.contains("shell.style.height = minimumDesktopHeight + 'px';"));
    assert!(!desktop.contains("window.visualViewport"));

    assert!(overview.contains(r#"title="Overview preview""#));
    assert!(overview.contains("background: #000;"));
    assert!(overview.contains("overflow: visible;"));
    assert!(overview.contains("window.visualViewport"));
    assert!(overview.contains("html.style.overflow = 'hidden';"));
    assert!(overview.contains("applyLayout(minimumDesktopHeight);"));
    assert!(!overview.contains("window.addEventListener('resize', queueMeasureFrameHeight"));
}
