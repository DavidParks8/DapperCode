use super::{execute_web_search_with_endpoints, parse_ddg_lite_snippets, sanitize_query};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::Router;
use serde_json::json;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[test]
fn parse_ddg_lite_snippets_strips_tags_decodes_entities_and_bounds_count() {
    let html = r#"
        <tr><td class="result-snippet">End cities &amp; <b>ships</b> spawn in chunks 0-8 &quot;infinitely&quot;.</td></tr>
        <tr><td class='result-snippet'>White chocolate uses cocoa butter&#39;s fat, sugar, and milk.</td></tr>
        <tr><td class="result-snippet">Third result</td></tr>
        <tr><td class="result-snippet">Fourth result</td></tr>
        <tr><td class="result-snippet">Fifth result ignored</td></tr>
    "#;
    let parsed = parse_ddg_lite_snippets(html);
    assert_eq!(parsed.len(), 4);
    assert_eq!(
        parsed[0],
        r#"End cities & ships spawn in chunks 0-8 "infinitely"."#,
    );
    assert_eq!(
        parsed[1],
        "White chocolate uses cocoa butter's fat, sugar, and milk.",
    );
    assert_eq!(sanitize_query("  hello   world \n "), "hello world");
}

#[tokio::test]
async fn execute_web_search_uses_ddg_falls_back_to_wikipedia_and_answers_self_name() {
    let app = Router::new()
        .route(
            "/ddg-ok",
            post(|| async {
                r#"<table><tr><td class="result-snippet">End cities generate infinitely across the outer End islands.</td></tr></table>"#
            }),
        )
        .route(
            "/ddg-empty",
            post(|| async { (StatusCode::ACCEPTED, "<html>challenge</html>") }),
        )
        .route(
            "/wiki-ok",
            get(|| async {
                json!({
                    "query": {
                        "search": [{
                            "title": "White chocolate",
                            "snippet": r#"<span class="searchmatch">White chocolate</span> is made from cocoa butter, sugar, and milk solids."#
                        }]
                    }
                })
                .to_string()
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let http = crate::tls::http_client();
    let cancel = CancellationToken::new();

    let self_name = execute_web_search_with_endpoints(
        &http,
        "What's my name?",
        &format!("http://{addr}/ddg-empty"),
        &format!("http://{addr}/wiki-ok"),
        &cancel,
    )
    .await;
    assert_eq!(self_name["answer"], "Your name is Lily.");

    let ddg_res = execute_web_search_with_endpoints(
        &http,
        "Minecraft end cities",
        &format!("http://{addr}/ddg-ok"),
        &format!("http://{addr}/wiki-ok"),
        &cancel,
    )
    .await;
    assert_eq!(
        ddg_res["results"][0],
        "End cities generate infinitely across the outer End islands.",
    );

    let wiki_fallback = execute_web_search_with_endpoints(
        &http,
        "how is white chocolate made",
        &format!("http://{addr}/ddg-empty"),
        &format!("http://{addr}/wiki-ok"),
        &cancel,
    )
    .await;
    assert_eq!(
        wiki_fallback["results"][0],
        "White chocolate: White chocolate is made from cocoa butter, sugar, and milk solids.",
    );
}
