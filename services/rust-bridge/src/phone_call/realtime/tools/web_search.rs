#![forbid(unsafe_code)]

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "web_search_tests.rs"]
pub(super) mod tests;

use super::{
    spawn_async_tool, FillerClip, RealtimeTool, ToolDispatch, ToolExecutionContext, ToolOutcome,
};
use crate::phone_call::realtime::strategy::{
    RealtimeModelStrategy, RealtimeToolInvocation, RealtimeToolSpec,
};
use crate::phone_call::voice::VoicePipelineClient;
use reqwest::header::{CONTENT_TYPE, USER_AGENT};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const DDG_LITE_URL: &str = "https://lite.duckduckgo.com/lite/";
const WIKIPEDIA_API_URL: &str = "https://en.wikipedia.org/w/api.php";
const SEARCH_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const SEARCH_TIMEOUT_SECS: u64 = 4;
const MAX_QUERY_CHARS: usize = 160;
const MAX_RESPONSE_BYTES: usize = 128 * 1024;
const MAX_SNIPPET_CHARS: usize = 240;
const MAX_RESULTS: usize = 3;
const SEARCH_FILLER_PHRASES: &[&str] = &["One sec.", "Let me check.", "Hold on, checking."];

pub(super) struct SearchFillerBank {
    clips: Arc<StdMutex<Vec<FillerClip>>>,
    next_idx: AtomicUsize,
}

impl SearchFillerBank {
    pub(super) fn start_warming(
        strategy: Arc<dyn RealtimeModelStrategy>,
        voice_client: VoicePipelineClient,
        cancel: CancellationToken,
    ) -> Self {
        let clips = Arc::new(StdMutex::new(Vec::new()));
        let task_clips = Arc::clone(&clips);
        tokio::spawn(async move {
            for &phrase in SEARCH_FILLER_PHRASES {
                if cancel.is_cancelled() {
                    break;
                }
                if let Some(frames) = strategy
                    .synthesize_filler_frames(&voice_client, phrase, &cancel)
                    .await
                {
                    if let Ok(mut guard) = task_clips.lock() {
                        guard.push(FillerClip {
                            text: phrase,
                            frames,
                        });
                    }
                }
            }
        });
        Self {
            clips,
            next_idx: AtomicUsize::new(0),
        }
    }

    pub(super) fn next_clip(&self) -> Option<FillerClip> {
        let guard = self.clips.lock().ok()?;
        if guard.is_empty() {
            return None;
        }
        let idx = self.next_idx.fetch_add(1, Ordering::Relaxed) % guard.len();
        Some(guard[idx].clone())
    }
}

pub struct WebSearchTool {
    fillers: SearchFillerBank,
    last_query: StdMutex<Option<String>>,
}

impl WebSearchTool {
    #[must_use]
    pub fn new(
        strategy: Arc<dyn RealtimeModelStrategy>,
        voice_client: VoicePipelineClient,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            fillers: SearchFillerBank::start_warming(strategy, voice_client, cancel),
            last_query: StdMutex::new(None),
        }
    }

    fn is_duplicate_and_record(&self, normalized: &str) -> bool {
        if normalized.is_empty() {
            return false;
        }
        let Ok(mut guard) = self.last_query.lock() else {
            return false;
        };
        if guard.as_deref() == Some(normalized) {
            return true;
        }
        *guard = Some(normalized.to_string());
        false
    }
}

impl RealtimeTool for WebSearchTool {
    fn name(&self) -> &'static str {
        "web_search"
    }

    fn spec(&self) -> RealtimeToolSpec {
        RealtimeToolSpec {
            name: self.name(),
            description: "Search the web for specific external facts, game mechanics, recipes, trivia, or current events you do not know. Do NOT use for casual chat, opinions, your name, or complaints.",
            prompt_guidance: Some("Use web_search ONLY for specific external facts, game mechanics, recipes, trivia, or current events you do not know (never for casual chat, choosing dinner, opinions, your name, or complaints)."),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Concise factual web search query."
                    }
                },
                "required": ["query"]
            }),
        }
    }

    fn dispatch(
        self: Arc<Self>,
        invocation: RealtimeToolInvocation,
        ctx: &mut ToolExecutionContext<'_>,
    ) -> ToolDispatch {
        let raw_query = invocation
            .arguments
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("");
        let normalized = sanitize_query(raw_query).to_ascii_lowercase();
        if normalized.is_empty() || self.is_duplicate_and_record(&normalized) {
            return ToolDispatch::Immediate(ToolOutcome {
                call_id: invocation.call_id,
                output: r#"{"ok":true}"#.to_string(),
                request_spoken_reply: false,
            });
        }
        let filler = self.fillers.next_clip();
        let http = ctx.http.clone();
        let query = raw_query.to_string();
        let call_id = invocation.call_id.clone();
        let task = spawn_async_tool(invocation.call_id, ctx.call_cancel, move |cancel| {
            Box::pin(async move {
                let output = execute_web_search(&http, &query, &cancel).await;
                ToolOutcome {
                    call_id,
                    output,
                    request_spoken_reply: true,
                }
            })
        });
        ToolDispatch::Async { task, filler }
    }
}

/// Executes a bounded factual web search for the realtime voice model, returning natural plain-text notes.
pub(super) async fn execute_web_search(
    http: &reqwest::Client,
    raw_query: &str,
    cancel: &CancellationToken,
) -> String {
    execute_web_search_with_endpoints(http, raw_query, DDG_LITE_URL, WIKIPEDIA_API_URL, cancel)
        .await
}

pub(super) async fn execute_web_search_with_endpoints(
    http: &reqwest::Client,
    raw_query: &str,
    ddg_url: &str,
    wiki_url: &str,
    cancel: &CancellationToken,
) -> String {
    let query = sanitize_query(raw_query);
    if query.is_empty() {
        return "No background notes found. Reply naturally from what you know.".to_string();
    }
    if is_self_name_query(&query) {
        return "Your name is Lily.".to_string();
    }
    if let Some(snippets) = fetch_ddg_lite_snippets(http, ddg_url, &query, cancel).await {
        if !snippets.is_empty() {
            return format_search_notes(&snippets);
        }
    }
    if let Some(snippets) = fetch_wikipedia_snippets(http, wiki_url, &query, cancel).await {
        if !snippets.is_empty() {
            return format_search_notes(&snippets);
        }
    }
    "No background notes found. Answer naturally from what you know or say you are not sure."
        .to_string()
}

fn format_search_notes(snippets: &[String]) -> String {
    let mut out = String::from(
        r#"Background notes (answer naturally in your own words without saying "search results"):"#,
    );
    for snippet in snippets {
        out.push_str("\n- ");
        out.push_str(snippet);
    }
    out
}

pub(super) fn sanitize_query(raw: &str) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(MAX_QUERY_CHARS).collect()
}

fn is_self_name_query(query: &str) -> bool {
    let normalized = query
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    matches!(
        normalized.as_str(),
        "what is my name"
            | "whats my name"
            | "what s my name"
            | "what is your name"
            | "whats your name"
            | "what s your name"
            | "my name"
            | "your name",
    )
}

async fn fetch_ddg_lite_snippets(
    http: &reqwest::Client,
    endpoint: &str,
    query: &str,
    cancel: &CancellationToken,
) -> Option<Vec<String>> {
    let encoded_query = percent_encode_form(query);
    let request = http
        .post(endpoint)
        .header(USER_AGENT, SEARCH_USER_AGENT)
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS))
        .body(format!("q={encoded_query}"));
    let body = send_bounded_text(request, cancel).await?;
    Some(parse_ddg_lite_snippets(&body))
}

async fn fetch_wikipedia_snippets(
    http: &reqwest::Client,
    endpoint: &str,
    query: &str,
    cancel: &CancellationToken,
) -> Option<Vec<String>> {
    let mut url = Url::parse(endpoint).ok()?;
    url.query_pairs_mut()
        .append_pair("action", "query")
        .append_pair("list", "search")
        .append_pair("srlimit", "3")
        .append_pair("utf8", "1")
        .append_pair("format", "json")
        .append_pair("srsearch", query);
    let request = http
        .get(url)
        .header(USER_AGENT, "DapperCode/1.0")
        .timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS));
    let body = send_bounded_text(request, cancel).await?;
    parse_wikipedia_snippets(&body)
}

fn percent_encode_form(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(char::from(byte));
            }
            b' ' => out.push('+'),
            other => {
                let _ = std::fmt::Write::write_fmt(&mut out, format_args!("%{other:02X}"));
            }
        }
    }
    out
}

async fn send_bounded_text(
    request: reqwest::RequestBuilder,
    cancel: &CancellationToken,
) -> Option<String> {
    let response = tokio::select! {
        biased;
        () = cancel.cancelled() => return None,
        res = request.send() => res.ok()?,
    };
    if !response.status().is_success() {
        return None;
    }
    let bytes = tokio::select! {
        biased;
        () = cancel.cancelled() => return None,
        res = response.bytes() => res.ok()?,
    };
    let bounded = &bytes[..bytes.len().min(MAX_RESPONSE_BYTES)];
    Some(String::from_utf8_lossy(bounded).into_owned())
}

pub(super) fn parse_ddg_lite_snippets(html: &str) -> Vec<String> {
    let mut results = Vec::new();
    let mut rest = html;
    while results.len() < MAX_RESULTS {
        let Some(marker_pos) = find_snippet_class(rest) else {
            break;
        };
        rest = &rest[marker_pos..];
        let Some(tag_end) = rest.find('>') else {
            break;
        };
        rest = &rest[tag_end + 1..];
        let Some(close_pos) = rest.find("</td>") else {
            break;
        };
        let cleaned = clean_html_snippet(&rest[..close_pos]);
        if !cleaned.is_empty() {
            results.push(cleaned);
        }
        rest = &rest[close_pos + 5..];
    }
    results
}

fn find_snippet_class(haystack: &str) -> Option<usize> {
    let double = haystack.find(r#"class="result-snippet""#);
    let single = haystack.find("class='result-snippet'");
    match (double, single) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(pos), None) | (None, Some(pos)) => Some(pos),
        (None, None) => None,
    }
}

#[derive(Deserialize)]
struct WikiResponse {
    #[serde(default)]
    query: Option<WikiQuery>,
}

#[derive(Deserialize)]
struct WikiQuery {
    #[serde(default)]
    search: Vec<WikiHit>,
}

#[derive(Deserialize)]
struct WikiHit {
    title: String,
    #[serde(default)]
    snippet: String,
}

fn parse_wikipedia_snippets(body: &str) -> Option<Vec<String>> {
    let parsed: WikiResponse = serde_json::from_str(body).ok()?;
    let hits = parsed.query?.search;
    let snippets = hits
        .into_iter()
        .take(MAX_RESULTS)
        .filter_map(|hit| {
            let title = clean_html_snippet(&hit.title);
            let snippet = clean_html_snippet(&hit.snippet);
            if title.is_empty() || snippet.is_empty() {
                None
            } else {
                Some(format!("{title}: {snippet}"))
            }
        })
        .collect();
    Some(snippets)
}

fn clean_html_snippet(raw: &str) -> String {
    let stripped = strip_html_tags(raw);
    let unescaped = decode_basic_html_entities(&stripped);
    let collapsed = unescaped.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(MAX_SNIPPET_CHARS).collect()
}

fn strip_html_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn decode_basic_html_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&quot;", r#"""#)
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}
