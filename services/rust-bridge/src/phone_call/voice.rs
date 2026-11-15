use std::{collections::BTreeMap, net::IpAddr, time::Duration};

use futures_util::StreamExt;
use reqwest::{header::CONTENT_TYPE, redirect::Policy, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const DEFAULT_OLLAMA_OPENAI_BASE_URL: &str = "http://127.0.0.1:11434/v1";
pub const DEFAULT_STT_MODEL: &str = "gemma4:e4b";
pub const DEFAULT_LLM_MODEL: &str = "gemma4:e4b";
pub const DEFAULT_TTS_MODEL: &str = "phonon";
pub const DEFAULT_TTS_VOICE: &str = "default";
pub const DEFAULT_KEEP_ALIVE: &str = "15m";
pub const DEFAULT_STT_LANGUAGE: &str = "en";
#[cfg(test)]
pub const TTS_PCM_SAMPLE_RATE_HZ: u32 = 24_000;
pub const CLAUSE_SECONDARY_SPLIT_MIN_CHARS: usize = 64;
pub const STT_PROMPT_MAX_BYTES: usize = 320;
pub const INTERRUPTED_MARKER: &str = "[interrupted]";
pub const LIVE_STEER_PREFIX: &str = "[Live instruction from user via mobile app]: ";

const CONNECT_TIMEOUT_SECS: u64 = 10;
const PRELOAD_REQUEST_TIMEOUT_SECS: u64 = 30;
const STT_REQUEST_TIMEOUT_SECS: u64 = 30;
const ERROR_BODY_MAX_BYTES: usize = 4_096;
const SSE_LINE_MAX_BYTES: usize = 256 * 1024;
const SILENT_PICKUP_USER_CUE: &str =
    "[The phone call has connected. Open by saying who you are calling for and why.]";

#[derive(Debug, thiserror::Error)]
pub enum VoiceError {
    #[error("invalid voice endpoint URL for {field}: {reason}")]
    InvalidEndpointUrl { field: &'static str, reason: String },

    #[error("invalid voice configuration for {field}: {reason}")]
    InvalidConfig { field: &'static str, reason: String },

    #[error("voice operation cancelled")]
    Cancelled,

    #[error("voice HTTP transport error at {endpoint}: {source}")]
    Transport {
        endpoint: String,
        #[source]
        source: reqwest::Error,
    },

    #[error("voice endpoint {endpoint} returned HTTP {status}: {body}")]
    HttpStatus {
        endpoint: String,
        status: u16,
        body: String,
    },

    #[error("invalid voice response from {endpoint}: {reason}")]
    InvalidResponse { endpoint: String, reason: String },

    #[error("invalid voice tool call '{tool_name}': {reason}")]
    InvalidToolCall { tool_name: String, reason: String },
}

impl VoiceError {
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoicePipelineConfig {
    pub stt_base_url: String,
    pub stt_model: String,
    pub llm_base_url: String,
    pub llm_model: String,
    pub tts_base_url: String,
    pub tts_model: String,
    pub tts_voice: String,
}

impl Default for VoicePipelineConfig {
    fn default() -> Self {
        Self {
            stt_base_url: DEFAULT_OLLAMA_OPENAI_BASE_URL.to_string(),
            stt_model: DEFAULT_STT_MODEL.to_string(),
            llm_base_url: DEFAULT_OLLAMA_OPENAI_BASE_URL.to_string(),
            llm_model: DEFAULT_LLM_MODEL.to_string(),
            tts_base_url: DEFAULT_OLLAMA_OPENAI_BASE_URL.to_string(),
            tts_model: DEFAULT_TTS_MODEL.to_string(),
            tts_voice: DEFAULT_TTS_VOICE.to_string(),
        }
    }
}

#[derive(Debug, Clone)]
struct ValidatedEndpoints {
    stt_base: Url,
    llm_base: Url,
    tts_base: Url,
}

impl VoicePipelineConfig {
    pub fn validate(&self) -> Result<(), VoiceError> {
        let _ = self.validated_endpoints()?;
        validate_non_empty_field("stt_model", &self.stt_model)?;
        validate_non_empty_field("llm_model", &self.llm_model)?;
        validate_non_empty_field("tts_model", &self.tts_model)?;
        validate_non_empty_field("tts_voice", &self.tts_voice)?;
        Ok(())
    }

    fn validated_endpoints(&self) -> Result<ValidatedEndpoints, VoiceError> {
        Ok(ValidatedEndpoints {
            stt_base: validate_loopback_base_url("stt_base_url", &self.stt_base_url)?,
            llm_base: validate_loopback_base_url("llm_base_url", &self.llm_base_url)?,
            tts_base: validate_loopback_base_url("tts_base_url", &self.tts_base_url)?,
        })
    }
}

fn validate_non_empty_field(field: &'static str, value: &str) -> Result<(), VoiceError> {
    if value.trim().is_empty() {
        return Err(VoiceError::InvalidConfig {
            field,
            reason: "must not be empty".to_string(),
        });
    }
    Ok(())
}

pub fn validate_loopback_base_url(field: &'static str, raw: &str) -> Result<Url, VoiceError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(VoiceError::InvalidEndpointUrl {
            field,
            reason: "URL must not be empty".to_string(),
        });
    }

    let mut parsed = Url::parse(trimmed).map_err(|err| VoiceError::InvalidEndpointUrl {
        field,
        reason: format!("invalid URL syntax: {err}"),
    })?;

    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(VoiceError::InvalidEndpointUrl {
            field,
            reason: format!(
                "unsupported scheme '{}': only http: and https: are permitted",
                parsed.scheme()
            ),
        });
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(VoiceError::InvalidEndpointUrl {
            field,
            reason: "embedded credentials are not permitted".to_string(),
        });
    }

    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(VoiceError::InvalidEndpointUrl {
            field,
            reason: "query parameters and fragments are not permitted on base URLs".to_string(),
        });
    }

    let host_raw = parsed
        .host_str()
        .ok_or_else(|| VoiceError::InvalidEndpointUrl {
            field,
            reason: "URL must specify a loopback host".to_string(),
        })?;

    if !is_loopback_host(host_raw) {
        return Err(VoiceError::InvalidEndpointUrl {
            field,
            reason: format!(
                "host '{host_raw}' is not loopback; expected 127.0.0.1, ::1, or localhost"
            ),
        });
    }

    let normalized_path = parsed.path().trim_end_matches('/').to_string();
    parsed.set_path(&normalized_path);
    Ok(parsed)
}

fn is_loopback_host(host_raw: &str) -> bool {
    let unbracketed = host_raw
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host_raw);

    if unbracketed.eq_ignore_ascii_case("localhost") {
        return true;
    }

    unbracketed
        .parse::<IpAddr>()
        .is_ok_and(|addr| addr.is_loopback())
}

fn append_endpoint_path(base: &Url, relative_path: &str) -> Url {
    let mut url = base.clone();
    let prefix = url.path().trim_end_matches('/');
    let suffix = relative_path.trim_start_matches('/');
    let combined = if prefix.is_empty() {
        format!("/{suffix}")
    } else {
        format!("{prefix}/{suffix}")
    };
    url.set_path(&combined);
    url
}

fn derive_ollama_api_chat_url(base: &Url) -> Url {
    let mut url = base.clone();
    let trimmed = url.path().trim_end_matches('/');
    let root_prefix = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    let chat_path = if root_prefix.is_empty() {
        "/api/chat".to_string()
    } else {
        format!("{root_prefix}/api/chat")
    };
    url.set_path(&chat_path);
    url
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceCallPromptParams {
    pub user_display_name: String,
    pub callee_name: Option<String>,
    pub objective: String,
    pub first_message: Option<String>,
    pub context: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantToolCallMessage {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: AssistantToolCallFunction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: MessageRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<AssistantToolCallMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    #[must_use]
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::System,
            content: Some(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    #[must_use]
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::User,
            content: Some(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    #[must_use]
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::Assistant,
            content: Some(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    #[must_use]
    pub fn tool(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::Tool,
            content: Some(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: Some(tool_call_id.into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptSpeaker {
    Assistant,
    Callee,
    Steer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranscriptEntry {
    pub speaker: TranscriptSpeaker,
    pub text: String,
    pub interrupted: bool,
}

#[must_use]
pub fn build_stt_vocabulary_prompt(
    user_display_name: &str,
    callee_name: Option<&str>,
    objective: &str,
) -> String {
    let caller = collapse_whitespace(user_display_name);
    let callee = callee_name.map(collapse_whitespace).unwrap_or_default();
    let goal = collapse_whitespace(objective);

    let mut parts = Vec::new();
    if !caller.is_empty() {
        parts.push(format!("Caller: {caller}."));
    }
    if !callee.is_empty() {
        parts.push(format!("Callee: {callee}."));
    }
    if !goal.is_empty() {
        parts.push(format!("Context: {goal}"));
    }

    let joined = parts.join(" ");
    truncate_utf8_at_boundary(&joined, STT_PROMPT_MAX_BYTES).to_string()
}

#[must_use]
pub fn build_system_prompt(params: &VoiceCallPromptParams) -> String {
    let caller_name = {
        let trimmed = params.user_display_name.trim();
        if trimmed.is_empty() {
            "the user"
        } else {
            trimmed
        }
    };

    let mut prompt = format!(
        "You are an automated phone assistant carrying out a request for {caller_name}. This is a live two-way conversation.\n\
         \n\
         Spoken-voice & identity rules:\n\
         1. CALLER-IDENTIFYING OPENING: Your first sentence MUST say who you are calling for and why, such as \"Hi, I'm calling for {caller_name} to book a table for four.\" Do not volunteer that you are an AI, a model, or an automated assistant. Never pretend to be {caller_name} or claim to be human. If asked who is calling or whether you are automated, answer truthfully that you are an automated assistant calling for {caller_name}.\n\
         2. CONCISE SPOKEN TURNS: Speak naturally in one or two short sentences per turn, then pause so the other person can respond. Never output markdown, bullet points, numbered lists, stage directions, brackets, URLs, or emojis.\n\
         3. PHONON TTS WORD NORMALIZATION: Always write times, dates, quantities, phone numbers, and confirmation codes in natural spoken words (for example, write \"seven forty-five p m\" instead of \"7:45pm\", \"October twenty-third\" instead of \"10/23\", and \"party of four\" instead of \"4 ppl\") because the speech synthesizer reads digits and punctuation literally.\n\
         4. PHONE TOOLS: Call send_dtmf with digits (0-9, *, #, A-D) when navigating automated IVR menus such as \"Press 1 for reservations\". A pause, fragment such as \"I\", hesitation, or silence is NOT a refusal or a completed answer: call wait_silently with on_hold=false and let the person finish. Call end_call only AFTER speaking a brief, polite closing goodbye, once the objective is explicitly fulfilled, the person explicitly refuses or cannot help, or they say goodbye. Never give up merely because information has not been provided yet.\n\
         5. HOLD: When asked to hold or wait for someone, acknowledge briefly and call wait_silently with on_hold=true. Remain silent through hold music, silence, queue announcements, repeated recordings, and transfers. None of these means the call is over. While on hold, use only wait_silently; call resume_call only when a live person clearly addresses you again or the user explicitly asks you to speak. Do not speak or call end_call while on hold. After resume_call, answer in your next turn.\n\
         6. TURN DECISION: Every turn MUST include exactly one phone tool. After an ordinary spoken reply, use wait_silently with on_hold=false to listen. After acknowledging a request to hold, use wait_silently with on_hold=true; saying you will wait without this tool does NOT put the call on hold. While already on hold, choose wait_silently or resume_call, never speak.\n\
         7. LIVE STEERING: Immediately honor any later system message prefixed with \"{LIVE_STEER_PREFIX}\" without breaking conversational flow."
    );

    if let Some(callee) = params
        .callee_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        prompt.push_str("\n\nCallee: ");
        prompt.push_str(callee);
    }

    let objective = params.objective.trim();
    if !objective.is_empty() {
        prompt.push_str("\nCall objective: ");
        prompt.push_str(objective);
    }

    if let Some(first_message) = params
        .first_message
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        prompt.push_str("\nOpening turn guidance: ");
        prompt.push_str(first_message);
    }

    if let Some(context) = params
        .context
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        prompt.push_str("\nAdditional background context: ");
        prompt.push_str(context);
    }

    prompt
}

// A transcript with at least two words is a reply; shorter text is a provisional fragment.
#[must_use]
pub fn is_substantive_reply(text: &str) -> bool {
    text.split_whitespace()
        .filter(|word| word.chars().any(char::is_alphanumeric))
        .take(2)
        .count()
        == 2
}

#[derive(Debug, Clone)]
pub struct VoiceConversation {
    messages: Vec<ChatMessage>,
    transcript: Vec<TranscriptEntry>,
    stt_vocabulary_prompt: String,
    on_hold: bool,
}

impl VoiceConversation {
    #[must_use]
    pub fn new(params: VoiceCallPromptParams) -> Self {
        let system_prompt = build_system_prompt(&params);
        let stt_vocabulary_prompt = build_stt_vocabulary_prompt(
            &params.user_display_name,
            params.callee_name.as_deref(),
            &params.objective,
        );
        Self {
            messages: vec![ChatMessage::system(system_prompt)],
            transcript: Vec::new(),
            stt_vocabulary_prompt,
            on_hold: false,
        }
    }

    #[cfg(test)]
    #[must_use]
    pub fn system_prompt(&self) -> &str {
        self.messages
            .first()
            .and_then(|msg| msg.content.as_deref())
            .unwrap_or("")
    }

    #[must_use]
    pub fn stt_vocabulary_prompt(&self) -> &str {
        &self.stt_vocabulary_prompt
    }

    #[cfg(test)]
    #[must_use]
    pub fn messages(&self) -> &[ChatMessage] {
        &self.messages
    }

    #[must_use]
    pub fn transcript(&self) -> &[TranscriptEntry] {
        &self.transcript
    }

    pub fn is_on_hold(&self) -> bool {
        self.on_hold
    }

    // A one-word ASR snippet is provisional, even when the model invents a successful outcome.
    // User hang-up and remote BYE remain available regardless of transcript length.
    pub fn can_end_call(&self) -> bool {
        !self.on_hold
            && self
                .transcript
                .iter()
                .rev()
                .find(|entry| entry.speaker == TranscriptSpeaker::Callee)
                .is_some_and(|entry| is_substantive_reply(&entry.text))
    }

    pub fn set_on_hold(&mut self, on_hold: bool) {
        if self.on_hold != on_hold {
            self.on_hold = on_hold;
            self.messages.push(ChatMessage::system(if on_hold {
                "The call is now ON HOLD. Do not speak or end the call. Music, silence, queue announcements and transfers are not the recipient returning. Use wait_silently until a live person clearly addresses you, then call resume_call without speaking."
            } else {
                "The call has resumed. Respond to the recipient and continue the objective."
            }));
        }
    }

    pub fn push_callee_utterance(&mut self, text: &str) {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return;
        }
        self.messages.push(ChatMessage::user(trimmed));
        self.transcript.push(TranscriptEntry {
            speaker: TranscriptSpeaker::Callee,
            text: trimmed.to_string(),
            interrupted: false,
        });
    }

    pub fn record_assistant_turn(&mut self, turn: &AssistantTurnOutput) {
        let trimmed_text = turn.full_text.trim();
        if trimmed_text.is_empty() && turn.raw_tool_calls.is_empty() {
            return;
        }

        let content = Some(trimmed_text.to_string());

        self.messages.push(ChatMessage {
            role: MessageRole::Assistant,
            content,
            tool_calls: turn.raw_tool_calls.clone(),
            tool_call_id: None,
        });

        if !trimmed_text.is_empty() {
            self.transcript.push(TranscriptEntry {
                speaker: TranscriptSpeaker::Assistant,
                text: trimmed_text.to_string(),
                interrupted: false,
            });
        }
    }

    pub fn record_tool_result(&mut self, tool_call_id: &str, result_text: &str) {
        let id = tool_call_id.trim();
        if id.is_empty() {
            return;
        }
        self.messages
            .push(ChatMessage::tool(id.to_string(), result_text.trim()));
    }

    pub fn inject_steer(&mut self, instruction: &str) {
        let trimmed = instruction.trim();
        if trimmed.is_empty() {
            return;
        }
        let formatted = format!("{LIVE_STEER_PREFIX}{trimmed}");
        self.messages.push(ChatMessage::system(formatted));
        self.transcript.push(TranscriptEntry {
            speaker: TranscriptSpeaker::Steer,
            text: trimmed.to_string(),
            interrupted: false,
        });
    }

    pub fn mark_last_assistant_interrupted(&mut self, spoken_text: &str) {
        let trimmed = spoken_text.trim();
        let truncated = if trimmed.is_empty() {
            INTERRUPTED_MARKER.to_string()
        } else {
            format!("{trimmed} {INTERRUPTED_MARKER}")
        };

        let last_user_idx = self
            .messages
            .iter()
            .enumerate()
            .skip(1)
            .rev()
            .find_map(|(idx, msg)| (msg.role == MessageRole::User).then_some(idx))
            .unwrap_or(0);

        let search_floor = last_user_idx.max(1);
        let assistant_idx = self
            .messages
            .iter()
            .enumerate()
            .skip(search_floor)
            .rev()
            .find_map(|(idx, msg)| (msg.role == MessageRole::Assistant).then_some(idx));

        if let Some(idx) = assistant_idx {
            let answered_ids: Vec<String> = self
                .messages
                .iter()
                .skip(idx.saturating_add(1))
                .filter(|msg| msg.role == MessageRole::Tool)
                .filter_map(|msg| msg.tool_call_id.clone())
                .collect();

            if let Some(msg) = self.messages.get_mut(idx) {
                msg.content = Some(truncated.clone());
                msg.tool_calls
                    .retain(|call| answered_ids.iter().any(|id| id == &call.id));
            }
        } else {
            self.messages
                .push(ChatMessage::assistant(truncated.clone()));
        }

        let last_callee_transcript_idx = self
            .transcript
            .iter()
            .enumerate()
            .rev()
            .find_map(|(idx, entry)| (entry.speaker == TranscriptSpeaker::Callee).then_some(idx));

        let transcript_floor = last_callee_transcript_idx
            .map(|idx| idx.saturating_add(1))
            .unwrap_or(0);

        let existing_assistant_entry = self
            .transcript
            .iter_mut()
            .skip(transcript_floor)
            .rev()
            .find(|entry| entry.speaker == TranscriptSpeaker::Assistant);

        if let Some(entry) = existing_assistant_entry {
            entry.text = truncated;
            entry.interrupted = true;
        } else {
            self.transcript.push(TranscriptEntry {
                speaker: TranscriptSpeaker::Assistant,
                text: truncated,
                interrupted: true,
            });
        }
    }

    fn build_request_messages(&self) -> Vec<ChatMessage> {
        let mut out = Vec::with_capacity(self.messages.len().saturating_add(2));
        let mut has_non_system = false;

        for (idx, msg) in self.messages.iter().enumerate() {
            if msg.role != MessageRole::System {
                has_non_system = true;
            }
            out.push(msg.clone());

            if msg.role == MessageRole::Assistant && !msg.tool_calls.is_empty() {
                for call in &msg.tool_calls {
                    let has_tool_reply =
                        self.messages
                            .iter()
                            .skip(idx.saturating_add(1))
                            .any(|later| {
                                later.role == MessageRole::Tool
                                    && later.tool_call_id.as_deref() == Some(call.id.as_str())
                            });
                    if !has_tool_reply {
                        out.push(ChatMessage::tool(call.id.clone(), "ok"));
                    }
                }
            }
        }

        if !has_non_system {
            out.push(ChatMessage::user(SILENT_PICKUP_USER_CUE));
        }

        out
    }
}

#[derive(Debug, Default, Clone)]
pub struct ClauseChunker {
    buffer: String,
}

impl ClauseChunker {
    #[must_use]
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
        }
    }

    #[cfg(test)]
    #[must_use]
    pub fn buffered(&self) -> &str {
        &self.buffer
    }

    pub fn push_str(&mut self, chunk: &str) -> Vec<String> {
        if chunk.is_empty() {
            return Vec::new();
        }
        self.buffer.push_str(chunk);

        let mut emitted = Vec::new();
        while let Some(split_byte_idx) = find_clause_split_index(&self.buffer) {
            let candidate = self.buffer[..split_byte_idx].trim().to_string();
            let remainder = self.buffer[split_byte_idx..].trim_start().to_string();
            self.buffer = remainder;
            if contains_speakable_char(&candidate) {
                emitted.push(candidate);
            }
        }
        emitted
    }

    pub fn finish(&mut self) -> Option<String> {
        let remaining = std::mem::take(&mut self.buffer);
        let trimmed = remaining.trim();
        if contains_speakable_char(trimmed) {
            Some(trimmed.to_string())
        } else {
            None
        }
    }
}

fn find_clause_split_index(buffer: &str) -> Option<usize> {
    let leading_ws = buffer.len().saturating_sub(buffer.trim_start().len());
    let slice = &buffer[leading_ws..];
    if slice.is_empty() {
        return None;
    }

    let mut char_count: usize = 0;
    let mut has_speakable = false;
    let mut indices = slice.char_indices();

    while let Some((rel_idx, ch)) = indices.next() {
        char_count = char_count.saturating_add(1);
        if ch.is_alphanumeric() {
            has_speakable = true;
        }

        let is_primary = matches!(ch, '.' | '?' | '!');
        let is_secondary =
            matches!(ch, ',' | ';' | ':') && char_count >= CLAUSE_SECONDARY_SPLIT_MIN_CHARS;

        if !has_speakable || (!is_primary && !is_secondary) {
            continue;
        }

        let mut end_rel_idx = rel_idx.saturating_add(ch.len_utf8());
        let mut lookahead = indices.clone().peekable();
        while let Some(&(quote_idx, quote_ch)) = lookahead.peek() {
            if is_closing_delimiter(quote_ch) {
                end_rel_idx = quote_idx.saturating_add(quote_ch.len_utf8());
                let _ = lookahead.next();
            } else {
                break;
            }
        }

        let Some(&(_, next_ch)) = lookahead.peek() else {
            continue;
        };

        if !next_ch.is_whitespace() {
            continue;
        }

        if ch == '.' && ends_with_common_abbreviation(&slice[..rel_idx.saturating_add(1)]) {
            continue;
        }

        return Some(leading_ws.saturating_add(end_rel_idx));
    }

    None
}

fn is_closing_delimiter(ch: char) -> bool {
    matches!(ch, '"' | '\'' | '\u{201D}' | '\u{2019}' | ')')
}

fn ends_with_common_abbreviation(prefix_with_dot: &str) -> bool {
    const ABBREVIATIONS: &[&str] = &[
        "mr.", "mrs.", "ms.", "dr.", "st.", "jr.", "sr.", "prof.", "vs.", "etc.", "e.g.", "i.e.",
    ];
    let token = prefix_with_dot
        .rsplit(|ch: char| ch.is_whitespace() || ch == '(' || ch == '"')
        .next()
        .unwrap_or("");
    ABBREVIATIONS
        .iter()
        .any(|abbr| token.eq_ignore_ascii_case(abbr))
}

fn contains_speakable_char(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum VoiceToolCall {
    SendDtmf {
        call_id: String,
        digits: String,
    },
    EndCall {
        call_id: String,
        reason: String,
        outcome_summary: String,
    },
    WaitSilently {
        call_id: String,
        reason: String,
        on_hold: bool,
    },
    ResumeCall {
        call_id: String,
    },
}

#[cfg(test)]
impl VoiceToolCall {
    #[must_use]
    pub fn call_id(&self) -> &str {
        match self {
            Self::SendDtmf { call_id, .. }
            | Self::EndCall { call_id, .. }
            | Self::WaitSilently { call_id, .. }
            | Self::ResumeCall { call_id } => call_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantTurnOutput {
    pub full_text: String,
    pub clauses: Vec<String>,
    pub tool_calls: Vec<VoiceToolCall>,
    pub raw_tool_calls: Vec<AssistantToolCallMessage>,
}

#[must_use]
pub fn voice_tool_definitions() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "send_dtmf",
                "description": "Send touch-tone DTMF digits (0-9, *, #, A-D) to navigate an IVR phone menu such as 'Press 1 for reservations'.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "digits": {
                            "type": "string",
                            "description": "DTMF digits to transmit (0-9, *, #, A-D)."
                        }
                    },
                    "required": ["digits"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "end_call",
                "description": "End only after a spoken closing goodbye and explicit resolution, refusal, or farewell. Never end because of a partial reply, silence, missing information, hold music, or a request to wait.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reason": {
                            "type": "string",
                            "description": "Short reason for ending the call."
                        },
                        "outcome_summary": {
                            "type": "string",
                            "description": "Concise summary of what was accomplished or learned on the call."
                        }
                    },
                    "required": ["reason", "outcome_summary"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "wait_silently",
                "description": "Wait without ending the call. Set on_hold=true when asked to hold or wait for a person; false for an unfinished sentence or IVR menu. On hold, stay silent through music, silence and announcements until a live person returns.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reason": {
                            "type": "string",
                            "description": "Why the assistant is waiting silently."
                        },
                        "on_hold": {
                            "type": "boolean",
                            "description": "True when the recipient has put the call on hold; false for an incomplete sentence or IVR menu."
                        }
                    },
                    "required": ["reason", "on_hold"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "resume_call",
                "description": "Resume a held conversation only when a live person clearly addresses the assistant again, or the user explicitly requests speech. Not for music, silence or recorded queue announcements. Speak in the next turn, not alongside this tool.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            }
        }
    ])
}

#[derive(Debug, Clone)]
pub struct VoicePipelineClient {
    config: VoicePipelineConfig,
    endpoints: ValidatedEndpoints,
    http: reqwest::Client,
}

impl VoicePipelineClient {
    pub fn new(config: VoicePipelineConfig) -> Result<Self, VoiceError> {
        let http = crate::tls::http_client_builder()
            .redirect(Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .build()
            .map_err(|source| VoiceError::Transport {
                endpoint: config.llm_base_url.clone(),
                source,
            })?;
        Self::with_http_client(config, http)
    }

    pub fn with_http_client(
        config: VoicePipelineConfig,
        http: reqwest::Client,
    ) -> Result<Self, VoiceError> {
        config.validate()?;
        let endpoints = config.validated_endpoints()?;
        Ok(Self {
            config,
            endpoints,
            http,
        })
    }

    #[cfg(test)]
    #[must_use]
    pub fn config(&self) -> &VoicePipelineConfig {
        &self.config
    }

    pub async fn preload_models(&self, cancel: &CancellationToken) -> Result<(), VoiceError> {
        if cancel.is_cancelled() {
            return Err(VoiceError::Cancelled);
        }

        let candidates = [
            (
                derive_ollama_api_chat_url(&self.endpoints.stt_base),
                self.config.stt_model.trim(),
            ),
            (
                derive_ollama_api_chat_url(&self.endpoints.llm_base),
                self.config.llm_model.trim(),
            ),
            (
                derive_ollama_api_chat_url(&self.endpoints.tts_base),
                self.config.tts_model.trim(),
            ),
        ];

        let mut seen: Vec<(String, String)> = Vec::with_capacity(candidates.len());
        for (url, model) in candidates {
            let key = (url.as_str().to_string(), model.to_string());
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            self.preload_single_model(&url, model, cancel).await?;
        }

        Ok(())
    }

    async fn preload_single_model(
        &self,
        api_chat_url: &Url,
        model: &str,
        cancel: &CancellationToken,
    ) -> Result<(), VoiceError> {
        let payload = json!({
            "model": model,
            "messages": [],
            "stream": false,
            "keep_alive": DEFAULT_KEEP_ALIVE,
        });

        let request = self
            .http
            .post(api_chat_url.clone())
            .timeout(Duration::from_secs(PRELOAD_REQUEST_TIMEOUT_SECS))
            .json(&payload);

        let response = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(VoiceError::Cancelled),
            res = request.send() => res.map_err(|source| VoiceError::Transport {
                endpoint: api_chat_url.to_string(),
                source,
            })?,
        };

        let status = response.status();
        if status.is_success()
            || matches!(
                status,
                StatusCode::BAD_REQUEST
                    | StatusCode::NOT_FOUND
                    | StatusCode::METHOD_NOT_ALLOWED
                    | StatusCode::UNPROCESSABLE_ENTITY
                    | StatusCode::NOT_IMPLEMENTED
            )
        {
            return Ok(());
        }

        let body = read_bounded_error_body(response, cancel).await?;
        Err(VoiceError::HttpStatus {
            endpoint: api_chat_url.to_string(),
            status: status.as_u16(),
            body,
        })
    }

    pub async fn transcribe_utterance(
        &self,
        wav_bytes: &[u8],
        conversation: &VoiceConversation,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, VoiceError> {
        self.transcribe_wav(wav_bytes, conversation.stt_vocabulary_prompt(), cancel)
            .await
    }

    pub async fn transcribe_wav(
        &self,
        wav_bytes: &[u8],
        prompt_bias: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, VoiceError> {
        if cancel.is_cancelled() {
            return Err(VoiceError::Cancelled);
        }
        if wav_bytes.is_empty() {
            return Ok(None);
        }

        let endpoint = append_endpoint_path(&self.endpoints.stt_base, "audio/transcriptions");
        let collapsed_prompt = collapse_whitespace(prompt_bias);
        let bounded_prompt = truncate_utf8_at_boundary(&collapsed_prompt, STT_PROMPT_MAX_BYTES);
        let (content_type, body) = build_transcription_multipart(
            wav_bytes,
            self.config.stt_model.trim(),
            DEFAULT_STT_LANGUAGE,
            bounded_prompt,
        );

        let request = self
            .http
            .post(endpoint.clone())
            .timeout(Duration::from_secs(STT_REQUEST_TIMEOUT_SECS))
            .header(CONTENT_TYPE, content_type)
            .body(body);

        let response = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(VoiceError::Cancelled),
            res = request.send() => res.map_err(|source| VoiceError::Transport {
                endpoint: endpoint.to_string(),
                source,
            })?,
        };

        let status = response.status();
        if !status.is_success() {
            let err_body = read_bounded_error_body(response, cancel).await?;
            return Err(VoiceError::HttpStatus {
                endpoint: endpoint.to_string(),
                status: status.as_u16(),
                body: err_body,
            });
        }

        let bytes = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(VoiceError::Cancelled),
            res = response.bytes() => res.map_err(|source| VoiceError::Transport {
                endpoint: endpoint.to_string(),
                source,
            })?,
        };

        let parsed: TranscriptionResponse =
            serde_json::from_slice(&bytes).map_err(|err| VoiceError::InvalidResponse {
                endpoint: endpoint.to_string(),
                reason: format!("invalid transcription JSON: {err}"),
            })?;

        Ok(clean_transcription_text(&parsed.text))
    }

    pub async fn stream_assistant_turn<F>(
        &self,
        conversation: &VoiceConversation,
        cancel: &CancellationToken,
        mut on_clause: F,
    ) -> Result<AssistantTurnOutput, VoiceError>
    where
        F: FnMut(String) + Send,
    {
        if cancel.is_cancelled() {
            return Err(VoiceError::Cancelled);
        }

        let endpoint = append_endpoint_path(&self.endpoints.llm_base, "chat/completions");
        let mut request_messages = conversation.build_request_messages();
        let held = conversation.is_on_hold();
        if held {
            request_messages.push(ChatMessage::system(
                "This is an ON-HOLD listening check, NOT a spoken turn. Return only JSON with decision=wait_silently for silence, music, recorded announcements, or a request to keep waiting. Choose decision=resume_call only when a live person clearly addresses you again or the user explicitly asks you to speak. Do not speak or end the call.",
            ));
        }
        let mut tools = voice_tool_definitions();
        if let Some(tools) = tools.as_array_mut() {
            tools.retain(|tool| match tool["function"]["name"].as_str() {
                Some("end_call") => conversation.can_end_call(),
                Some("send_dtmf") => !conversation.is_on_hold(),
                Some("resume_call") => conversation.is_on_hold(),
                _ => true,
            });
        }
        let payload = ChatCompletionStreamRequest {
            model: self.config.llm_model.trim(),
            messages: &request_messages,
            stream: true,
            reasoning_effort: "none",
            tool_choice: (!held).then_some("required"),
            parallel_tool_calls: (!held).then_some(false),
            tools: if held { Value::Null } else { tools },
            response_format: held.then(|| json!({
                "type": "json_schema",
                "json_schema": {
                    "name": "hold_decision",
                    "strict": true,
                    "schema": {
                        "type": "object",
                        "properties": {"decision": {"type": "string", "enum": ["wait_silently", "resume_call"]}},
                        "required": ["decision"],
                        "additionalProperties": false
                    }
                }
            })),
        };

        let response = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(VoiceError::Cancelled),
            res = self.http.post(endpoint.clone()).json(&payload).send() => res.map_err(|source| VoiceError::Transport {
                endpoint: endpoint.to_string(),
                source,
            })?,
        };

        let status = response.status();
        if !status.is_success() {
            let err_body = read_bounded_error_body(response, cancel).await?;
            return Err(VoiceError::HttpStatus {
                endpoint: endpoint.to_string(),
                status: status.as_u16(),
                body: err_body,
            });
        }

        let mut byte_stream = response.bytes_stream();
        let mut sse_buf: Vec<u8> = Vec::new();
        let mut full_text = String::new();
        let mut clauses: Vec<String> = Vec::new();
        let mut chunker = ClauseChunker::new();
        let mut tool_accumulators: BTreeMap<usize, ToolCallAccumulator> = BTreeMap::new();
        let mut stream_done = false;
        let mut emit_clause = |clause| {
            if !held {
                on_clause(clause);
            }
        };

        while !stream_done {
            let maybe_chunk = tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(VoiceError::Cancelled),
                item = byte_stream.next() => item,
            };

            let Some(chunk_res) = maybe_chunk else {
                break;
            };

            let chunk = chunk_res.map_err(|source| VoiceError::Transport {
                endpoint: endpoint.to_string(),
                source,
            })?;

            if sse_buf.len().saturating_add(chunk.len()) > SSE_LINE_MAX_BYTES {
                return Err(VoiceError::InvalidResponse {
                    endpoint: endpoint.to_string(),
                    reason: "SSE line exceeded maximum buffer size".to_string(),
                });
            }
            sse_buf.extend_from_slice(&chunk);

            while let Some(newline_pos) = sse_buf.iter().position(|&b| b == b'\n') {
                let mut line_bytes: Vec<u8> = sse_buf.drain(..=newline_pos).collect();
                if line_bytes.last() == Some(&b'\n') {
                    let _ = line_bytes.pop();
                }
                if line_bytes.last() == Some(&b'\r') {
                    let _ = line_bytes.pop();
                }

                if process_sse_line(
                    &line_bytes,
                    &endpoint,
                    &mut full_text,
                    &mut chunker,
                    &mut clauses,
                    &mut tool_accumulators,
                    &mut emit_clause,
                )? {
                    stream_done = true;
                    break;
                }
            }
        }

        if !stream_done && !sse_buf.is_empty() {
            if sse_buf.last() == Some(&b'\r') {
                let _ = sse_buf.pop();
            }
            let _ = process_sse_line(
                &sse_buf,
                &endpoint,
                &mut full_text,
                &mut chunker,
                &mut clauses,
                &mut tool_accumulators,
                &mut emit_clause,
            )?;
        }

        if let Some(tail_clause) = chunker.finish() {
            emit_clause(tail_clause.clone());
            clauses.push(tail_clause);
        }

        // Compatible servers may still return native tool calls. Neither response format is
        // spoken while held; schema decisions are normalized into the same validated actions.
        if held && tool_accumulators.is_empty() {
            let decision: HoldDecision =
                serde_json::from_str(&full_text).map_err(|err| VoiceError::InvalidResponse {
                    endpoint: endpoint.to_string(),
                    reason: format!("invalid on-hold listening decision: {err}"),
                })?;
            let (name, arguments) = match decision.decision {
                HoldAction::Wait => (
                    "wait_silently",
                    json!({"reason": "Still on hold", "on_hold": true}),
                ),
                HoldAction::Resume => ("resume_call", json!({})),
            };
            tool_accumulators.insert(
                0,
                ToolCallAccumulator {
                    id: format!("hold_{}", Uuid::new_v4()),
                    name: name.to_string(),
                    arguments: arguments.to_string(),
                },
            );
            full_text.clear();
            clauses.clear();
        }
        let (tool_calls, raw_tool_calls) = finalize_tool_calls(tool_accumulators)?;

        Ok(AssistantTurnOutput {
            full_text,
            clauses,
            tool_calls,
            raw_tool_calls,
        })
    }

    pub async fn synthesize_speech_pcm24k<F>(
        &self,
        clause: &str,
        cancel: &CancellationToken,
        mut on_samples: F,
    ) -> Result<usize, VoiceError>
    where
        F: FnMut(&[i16]) + Send,
    {
        if cancel.is_cancelled() {
            return Err(VoiceError::Cancelled);
        }

        let input = clause.trim();
        if input.is_empty() {
            return Ok(0);
        }

        let endpoint = append_endpoint_path(&self.endpoints.tts_base, "audio/speech");
        let payload = SpeechSynthesisRequest {
            model: self.config.tts_model.trim(),
            input,
            voice: self.config.tts_voice.trim(),
            response_format: "pcm",
        };

        let response = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(VoiceError::Cancelled),
            res = self.http.post(endpoint.clone()).json(&payload).send() => res.map_err(|source| VoiceError::Transport {
                endpoint: endpoint.to_string(),
                source,
            })?,
        };

        let status = response.status();
        if !status.is_success() {
            let err_body = read_bounded_error_body(response, cancel).await?;
            return Err(VoiceError::HttpStatus {
                endpoint: endpoint.to_string(),
                status: status.as_u16(),
                body: err_body,
            });
        }

        let mut byte_stream = response.bytes_stream();
        let mut carry_byte: Option<u8> = None;
        let mut samples_buf: Vec<i16> = Vec::new();
        let mut total_samples: usize = 0;

        loop {
            let maybe_chunk = tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(VoiceError::Cancelled),
                item = byte_stream.next() => item,
            };

            let Some(chunk_res) = maybe_chunk else {
                break;
            };

            let chunk = chunk_res.map_err(|source| VoiceError::Transport {
                endpoint: endpoint.to_string(),
                source,
            })?;

            if chunk.is_empty() {
                continue;
            }

            samples_buf.clear();
            let slice: &[u8] = if let Some(prev_lo) = carry_byte.take() {
                if let Some((&first_hi, rest)) = chunk.split_first() {
                    samples_buf.push(i16::from_le_bytes([prev_lo, first_hi]));
                    rest
                } else {
                    carry_byte = Some(prev_lo);
                    &[]
                }
            } else {
                &chunk
            };

            let mut pairs = slice.chunks_exact(2);
            for pair in &mut pairs {
                if let &[lo, hi] = pair {
                    samples_buf.push(i16::from_le_bytes([lo, hi]));
                }
            }
            if let &[rem] = pairs.remainder() {
                carry_byte = Some(rem);
            }

            if !samples_buf.is_empty() {
                total_samples = total_samples.saturating_add(samples_buf.len());
                on_samples(&samples_buf);
            }
        }

        Ok(total_samples)
    }
}

#[derive(Debug, Serialize)]
struct ChatCompletionStreamRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    reasoning_effort: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parallel_tool_calls: Option<bool>,
    #[serde(skip_serializing_if = "Value::is_null")]
    tools: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HoldDecision {
    decision: HoldAction,
}

#[derive(Deserialize)]
enum HoldAction {
    #[serde(rename = "wait_silently")]
    Wait,
    #[serde(rename = "resume_call")]
    Resume,
}

#[derive(Debug, Serialize)]
struct SpeechSynthesisRequest<'a> {
    model: &'a str,
    input: &'a str,
    voice: &'a str,
    response_format: &'static str,
}

#[derive(Debug, Deserialize)]
struct TranscriptionResponse {
    #[serde(default)]
    text: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionStreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    #[serde(default)]
    error: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
}

#[derive(Debug, Default, Deserialize)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<StreamToolCallDelta>,
}

#[derive(Debug, Deserialize)]
struct StreamToolCallDelta {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<StreamToolFunctionDelta>,
}

#[derive(Debug, Deserialize)]
struct StreamToolFunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Default)]
struct ToolCallAccumulator {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize)]
struct SendDtmfArgs {
    digits: String,
}

#[derive(Debug, Deserialize)]
struct EndCallArgs {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    outcome_summary: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WaitSilentlyArgs {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    on_hold: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResumeCallArgs {}

fn process_sse_line<F>(
    line_bytes: &[u8],
    endpoint: &Url,
    full_text: &mut String,
    chunker: &mut ClauseChunker,
    clauses: &mut Vec<String>,
    tool_accumulators: &mut BTreeMap<usize, ToolCallAccumulator>,
    on_clause: &mut F,
) -> Result<bool, VoiceError>
where
    F: FnMut(String),
{
    if line_bytes.is_empty() || line_bytes.first() == Some(&b':') {
        return Ok(false);
    }

    let line = std::str::from_utf8(line_bytes).map_err(|err| VoiceError::InvalidResponse {
        endpoint: endpoint.to_string(),
        reason: format!("SSE line is not valid UTF-8: {err}"),
    })?;

    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        return Ok(false);
    }

    let Some(raw_data) = trimmed.strip_prefix("data:") else {
        return Ok(false);
    };
    let payload = raw_data.strip_prefix(' ').unwrap_or(raw_data).trim();
    if payload.is_empty() {
        return Ok(false);
    }
    if payload == "[DONE]" {
        return Ok(true);
    }

    let parsed: ChatCompletionStreamChunk =
        serde_json::from_str(payload).map_err(|err| VoiceError::InvalidResponse {
            endpoint: endpoint.to_string(),
            reason: format!("invalid SSE JSON chunk: {err}"),
        })?;

    if let Some(err_payload) = parsed.error {
        return Err(VoiceError::InvalidResponse {
            endpoint: endpoint.to_string(),
            reason: format!("upstream stream error: {err_payload}"),
        });
    }

    for choice in parsed.choices {
        if let Some(content_piece) = choice.delta.content {
            if !content_piece.is_empty() {
                full_text.push_str(&content_piece);
                for ready_clause in chunker.push_str(&content_piece) {
                    on_clause(ready_clause.clone());
                    clauses.push(ready_clause);
                }
            }
        }

        for tc_delta in choice.delta.tool_calls {
            let entry = tool_accumulators.entry(tc_delta.index).or_default();
            if let Some(id) = tc_delta.id.filter(|s| !s.is_empty()) {
                if entry.id.is_empty() {
                    entry.id = id;
                } else {
                    entry.id.push_str(&id);
                }
            }
            if let Some(func) = tc_delta.function {
                if let Some(name) = func.name.filter(|s| !s.is_empty()) {
                    entry.name.push_str(&name);
                }
                if let Some(args) = func.arguments {
                    entry.arguments.push_str(&args);
                }
            }
        }
    }

    Ok(false)
}

fn finalize_tool_calls(
    accumulators: BTreeMap<usize, ToolCallAccumulator>,
) -> Result<(Vec<VoiceToolCall>, Vec<AssistantToolCallMessage>), VoiceError> {
    let mut parsed_calls = Vec::with_capacity(accumulators.len());
    let mut raw_calls = Vec::with_capacity(accumulators.len());

    for (index, acc) in accumulators {
        let tool_name = acc.name.trim().to_string();
        if tool_name.is_empty() {
            return Err(VoiceError::InvalidToolCall {
                tool_name: "<empty>".to_string(),
                reason: format!("tool call at index {index} had an empty function name"),
            });
        }

        let call_id = if acc.id.trim().is_empty() {
            format!("call_{index}_{}", Uuid::new_v4().simple())
        } else {
            acc.id.trim().to_string()
        };

        let raw_arguments = if acc.arguments.trim().is_empty() {
            "{}".to_string()
        } else {
            acc.arguments
        };

        let parsed = parse_single_tool_call(&call_id, &tool_name, &raw_arguments)?;
        raw_calls.push(AssistantToolCallMessage {
            id: call_id,
            kind: "function".to_string(),
            function: AssistantToolCallFunction {
                name: tool_name,
                arguments: raw_arguments,
            },
        });
        parsed_calls.push(parsed);
    }

    Ok((parsed_calls, raw_calls))
}

fn parse_single_tool_call(
    call_id: &str,
    tool_name: &str,
    raw_arguments: &str,
) -> Result<VoiceToolCall, VoiceError> {
    match tool_name {
        "send_dtmf" => {
            let args: SendDtmfArgs =
                serde_json::from_str(raw_arguments).map_err(|err| VoiceError::InvalidToolCall {
                    tool_name: tool_name.to_string(),
                    reason: format!("invalid JSON arguments: {err}"),
                })?;
            let normalized = normalize_dtmf_digits(&args.digits)?;
            Ok(VoiceToolCall::SendDtmf {
                call_id: call_id.to_string(),
                digits: normalized,
            })
        }
        "end_call" => {
            let args: EndCallArgs =
                serde_json::from_str(raw_arguments).map_err(|err| VoiceError::InvalidToolCall {
                    tool_name: tool_name.to_string(),
                    reason: format!("invalid JSON arguments: {err}"),
                })?;
            let reason = args
                .reason
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            let summary = args
                .outcome_summary
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);

            let resolved_reason = reason
                .clone()
                .or_else(|| summary.clone())
                .unwrap_or_else(|| "completed".to_string());
            let resolved_summary = summary
                .or(reason)
                .unwrap_or_else(|| "call completed".to_string());

            Ok(VoiceToolCall::EndCall {
                call_id: call_id.to_string(),
                reason: resolved_reason,
                outcome_summary: resolved_summary,
            })
        }
        "wait_silently" => {
            let args: WaitSilentlyArgs =
                serde_json::from_str(raw_arguments).map_err(|err| VoiceError::InvalidToolCall {
                    tool_name: tool_name.to_string(),
                    reason: format!("invalid JSON arguments: {err}"),
                })?;
            let reason = args
                .reason
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("waiting")
                .to_string();
            Ok(VoiceToolCall::WaitSilently {
                call_id: call_id.to_string(),
                reason,
                on_hold: args.on_hold,
            })
        }
        "resume_call" => {
            let _: ResumeCallArgs =
                serde_json::from_str(raw_arguments).map_err(|err| VoiceError::InvalidToolCall {
                    tool_name: tool_name.to_string(),
                    reason: format!("invalid JSON arguments: {err}"),
                })?;
            Ok(VoiceToolCall::ResumeCall {
                call_id: call_id.to_string(),
            })
        }
        other => Err(VoiceError::InvalidToolCall {
            tool_name: other.to_string(),
            reason: "unsupported tool name".to_string(),
        }),
    }
}

fn normalize_dtmf_digits(raw: &str) -> Result<String, VoiceError> {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_whitespace() || ch == '-' {
            continue;
        }
        let upper = ch.to_ascii_uppercase();
        if matches!(upper, '0'..='9' | '*' | '#' | 'A'..='D') {
            out.push(upper);
        } else {
            return Err(VoiceError::InvalidToolCall {
                tool_name: "send_dtmf".to_string(),
                reason: format!("invalid DTMF character '{ch}'; expected 0-9, *, #, or A-D"),
            });
        }
    }

    if out.is_empty() {
        return Err(VoiceError::InvalidToolCall {
            tool_name: "send_dtmf".to_string(),
            reason: "digits must contain at least one DTMF symbol".to_string(),
        });
    }

    Ok(out)
}

fn build_transcription_multipart(
    wav_bytes: &[u8],
    model: &str,
    language: &str,
    prompt: &str,
) -> (String, Vec<u8>) {
    let boundary = loop {
        let candidate = format!("----dappercodevoice{}", Uuid::new_v4().simple());
        if !contains_subslice(wav_bytes, candidate.as_bytes()) {
            break candidate;
        }
    };

    let mut body = Vec::with_capacity(wav_bytes.len().saturating_add(512));
    append_multipart_text_field(&mut body, &boundary, "model", model);
    append_multipart_text_field(&mut body, &boundary, "language", language);
    if !prompt.is_empty() {
        append_multipart_text_field(&mut body, &boundary, "prompt", prompt);
    }

    body.extend_from_slice(b"--");
    body.extend_from_slice(boundary.as_bytes());
    body.extend_from_slice(
        b"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"utterance.wav\"\r\nContent-Type: audio/wav\r\n\r\n",
    );
    body.extend_from_slice(wav_bytes);
    body.extend_from_slice(b"\r\n--");
    body.extend_from_slice(boundary.as_bytes());
    body.extend_from_slice(b"--\r\n");

    let content_type = format!("multipart/form-data; boundary={boundary}");
    (content_type, body)
}

fn append_multipart_text_field(body: &mut Vec<u8>, boundary: &str, name: &str, value: &str) {
    body.extend_from_slice(b"--");
    body.extend_from_slice(boundary.as_bytes());
    body.extend_from_slice(b"\r\nContent-Disposition: form-data; name=\"");
    body.extend_from_slice(name.as_bytes());
    body.extend_from_slice(b"\"\r\n\r\n");
    body.extend_from_slice(value.as_bytes());
    body.extend_from_slice(b"\r\n");
}

fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn clean_transcription_text(raw: &str) -> Option<String> {
    let without_brackets = strip_non_speech_annotations(raw);
    let collapsed = collapse_whitespace(&without_brackets);
    if !contains_speakable_char(&collapsed) {
        return None;
    }
    Some(collapsed)
}

fn strip_non_speech_annotations(raw: &str) -> String {
    let mut remaining = raw.trim();
    loop {
        let next = strip_leading_or_trailing_annotation(remaining);
        if next.len() == remaining.len() {
            break;
        }
        remaining = next.trim();
    }

    let mut cleaned = String::with_capacity(remaining.len());
    let mut chars = remaining.chars();
    while let Some(ch) = chars.next() {
        if ch == '[' {
            let mut tag = String::new();
            let mut closed = false;
            for inner in chars.by_ref() {
                if inner == ']' {
                    closed = true;
                    break;
                }
                tag.push(inner);
            }
            if closed && is_non_speech_tag(&tag) {
                cleaned.push(' ');
                continue;
            }
            cleaned.push('[');
            cleaned.push_str(&tag);
            if closed {
                cleaned.push(']');
            }
        } else {
            cleaned.push(ch);
        }
    }

    cleaned
}

fn strip_leading_or_trailing_annotation(input: &str) -> &str {
    for (open, close) in [('[', ']'), ('(', ')'), ('*', '*')] {
        if let Some(rest) = input.strip_prefix(open) {
            if let Some((tag, after)) = rest.split_once(close) {
                if is_non_speech_tag(tag) {
                    return after;
                }
            }
        }
        if let Some(before_close) = input.strip_suffix(close) {
            if let Some((before, tag)) = before_close.rsplit_once(open) {
                if is_non_speech_tag(tag) {
                    return before;
                }
            }
        }
    }
    input
}

fn is_non_speech_tag(tag: &str) -> bool {
    const NON_SPEECH_TAGS: &[&str] = &[
        "blank_audio",
        "blank audio",
        "silence",
        "quiet",
        "pause",
        "no speech",
        "no_speech",
        "inaudible",
        "unintelligible",
        "music",
        "background music",
        "noise",
        "background noise",
        "static",
        "line noise",
        "beep",
        "tone",
        "dial tone",
        "ringing",
        "cough",
        "coughing",
        "sigh",
        "breathing",
        "breath",
        "laughter",
        "laughing",
        "applause",
        "clicking",
    ];
    let normalized = collapse_whitespace(tag).to_ascii_lowercase();
    normalized.is_empty()
        || !contains_speakable_char(&normalized)
        || NON_SPEECH_TAGS.iter().any(|&known| normalized == known)
}

fn collapse_whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for word in input.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

fn truncate_utf8_at_boundary(input: &str, max_bytes: usize) -> &str {
    if input.len() <= max_bytes {
        return input;
    }
    let mut end = max_bytes;
    while end > 0 && !input.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    input[..end].trim_end()
}

async fn read_bounded_error_body(
    response: reqwest::Response,
    cancel: &CancellationToken,
) -> Result<String, VoiceError> {
    let mut stream = response.bytes_stream();
    let mut collected = Vec::new();
    while collected.len() < ERROR_BODY_MAX_BYTES {
        let next = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(VoiceError::Cancelled),
            item = stream.next() => item,
        };
        let Some(Ok(chunk)) = next else {
            break;
        };
        let remaining = ERROR_BODY_MAX_BYTES.saturating_sub(collected.len());
        let slice = chunk.get(..remaining).unwrap_or(&chunk);
        collected.extend_from_slice(slice);
        if collected.len() >= ERROR_BODY_MAX_BYTES {
            break;
        }
    }
    let text = String::from_utf8_lossy(&collected);
    Ok(text.trim().to_string())
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use axum::{
        body::Body,
        extract::{Multipart, State},
        http::StatusCode,
        response::{IntoResponse, Response},
        routing::post,
        Json, Router,
    };
    use tokio::{net::TcpListener, sync::Mutex};

    #[tokio::test]
    #[ignore = "requires locally installed Ollama and gemma4:e4b; run under the local E2E resource lease"]
    async fn local_ollama_caller_identifying_opening_and_truthful_identity() {
        let client = VoicePipelineClient::new(VoicePipelineConfig::default()).unwrap();
        let cancel = CancellationToken::new();
        for first_message in [
            None,
            Some("Greet warmly and ask for a table for four.".to_string()),
        ] {
            let callee_greeted = first_message.is_some();
            let mut conversation = VoiceConversation::new(VoiceCallPromptParams {
                user_display_name: "Test Caller".to_string(),
                callee_name: Some("Local test restaurant".to_string()),
                objective: "Book a table for four at seven p m.".to_string(),
                first_message,
                context: None,
            });
            if callee_greeted {
                conversation
                    .push_callee_utterance("Hello, this is the restaurant. How can I help you?");
            }
            let opening = client
                .stream_assistant_turn(&conversation, &cancel, |_| {})
                .await
                .unwrap();
            let spoken = opening.full_text.to_lowercase();
            let words: Vec<_> = spoken
                .split(|ch: char| !ch.is_alphanumeric())
                .filter(|word| !word.is_empty())
                .collect();
            assert!(
                spoken.contains("test caller"),
                "the opening must identify who the call is for: {opening:?}"
            );
            for identity_word in ["ai", "artificial", "automated", "assistant", "model"] {
                assert!(
                    !words.contains(&identity_word),
                    "unsolicited identity introduction: {opening:?}"
                );
            }
            assert!(
                spoken.contains("table") || spoken.contains("reservation"),
                "{opening:?}"
            );
            conversation.record_assistant_turn(&opening);
            for tool in &opening.tool_calls {
                conversation
                    .record_tool_result(tool.call_id(), "Waiting for the recipient to respond.");
            }
            conversation.push_callee_utterance(
                "Before we continue, are you a human or an automated assistant, and who are you helping?",
            );
            let identity = client
                .stream_assistant_turn(&conversation, &cancel, |_| {})
                .await
                .unwrap();
            let spoken = identity.full_text.to_lowercase();
            assert!(
                spoken.contains("automated")
                    || spoken.contains("artificial intelligence")
                    || spoken
                        .split_whitespace()
                        .any(|word| word.trim_matches(|ch: char| !ch.is_alphanumeric()) == "ai"),
                "identity questions must be answered truthfully: {identity:?}"
            );
            assert!(spoken.contains("test caller"), "{identity:?}");
        }
    }

    #[tokio::test]
    #[ignore = "requires locally installed Ollama and gemma4:e4b; run under the local E2E resource lease"]
    async fn local_ollama_partial_reply_hold_and_resume() {
        let client = VoicePipelineClient::new(VoicePipelineConfig::default()).unwrap();
        let cancel = CancellationToken::new();
        for _ in 0..3 {
            let mut conversation = VoiceConversation::new(VoiceCallPromptParams {
                user_display_name: "Test Caller".to_string(),
                callee_name: Some("Local test business".to_string()),
                objective: "Ask for the business address, then thank the person.".to_string(),
                first_message: None,
                context: None,
            });
            conversation.messages.push(ChatMessage::assistant(
                "Hello, could you tell me your business address?",
            ));
            conversation.push_callee_utterance("I");
            let reply = client
                .stream_assistant_turn(&conversation, &cancel, |_| {})
                .await
                .unwrap();
            assert!(
                !reply
                    .tool_calls
                    .iter()
                    .any(|tool| matches!(tool, VoiceToolCall::EndCall { .. })),
                "a fragment is not a refusal: {reply:?}"
            );
            assert!(
                !reply
                    .tool_calls
                    .iter()
                    .any(|tool| matches!(tool, VoiceToolCall::WaitSilently { on_hold: true, .. })),
                "a fragment alone is not a request to go on hold: {reply:?}"
            );

            conversation
                .push_callee_utterance("Could you hold for a moment while I check, please?");
            let held = client
                .stream_assistant_turn(&conversation, &cancel, |_| {})
                .await
                .unwrap();
            assert!(
                held.tool_calls
                    .iter()
                    .any(|tool| matches!(tool, VoiceToolCall::WaitSilently { on_hold: true, .. })),
                "{held:?}"
            );
            conversation.record_assistant_turn(&held);
            for tool in &held.tool_calls {
                conversation.record_tool_result(tool.call_id(), "Waiting on hold.");
            }
            conversation.set_on_hold(true);
            conversation.push_callee_utterance(
                "Your call is important to us. Please continue to hold for the next available representative.",
            );
            let waiting = client
                .stream_assistant_turn(&conversation, &cancel, |_| {})
                .await
                .unwrap();
            assert!(
                !waiting.tool_calls.iter().any(|tool| matches!(
                    tool,
                    VoiceToolCall::ResumeCall { .. } | VoiceToolCall::EndCall { .. }
                )),
                "{waiting:?}"
            );
            conversation.record_assistant_turn(&waiting);
            for tool in &waiting.tool_calls {
                conversation.record_tool_result(tool.call_id(), "Still waiting on hold.");
            }
            conversation.push_callee_utterance(
                "Hello, this is Morgan. Thanks for holding. Are you still there?",
            );
            let resumed = client
                .stream_assistant_turn(&conversation, &cancel, |_| {})
                .await
                .unwrap();
            assert!(
                resumed
                    .tool_calls
                    .iter()
                    .any(|tool| matches!(tool, VoiceToolCall::ResumeCall { .. })),
                "{resumed:?}"
            );
        }
    }

    #[derive(Debug, Default)]
    struct CapturedTranscription {
        file_name: Option<String>,
        content_type: Option<String>,
        file_bytes: Vec<u8>,
        model: Option<String>,
        language: Option<String>,
        prompt: Option<String>,
    }

    #[derive(Debug, Default)]
    struct MockServerState {
        preload_bodies: Mutex<Vec<Value>>,
        preload_status: StatusCode,
        transcriptions: Mutex<Vec<CapturedTranscription>>,
        transcription_reply_text: Mutex<String>,
        chat_requests: Mutex<Vec<Value>>,
        chat_sse_chunks: Mutex<Vec<Vec<u8>>>,
        chat_chunk_delay_ms: AtomicUsize,
        chat_status: Mutex<StatusCode>,
        speech_requests: Mutex<Vec<Value>>,
        speech_pcm_chunks: Mutex<Vec<Vec<u8>>>,
        speech_chunk_delay_ms: AtomicUsize,
        speech_chunks_sent: AtomicUsize,
    }

    impl MockServerState {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                preload_bodies: Mutex::new(Vec::new()),
                preload_status: StatusCode::OK,
                transcriptions: Mutex::new(Vec::new()),
                transcription_reply_text: Mutex::new(String::new()),
                chat_requests: Mutex::new(Vec::new()),
                chat_sse_chunks: Mutex::new(Vec::new()),
                chat_chunk_delay_ms: AtomicUsize::new(0),
                chat_status: Mutex::new(StatusCode::OK),
                speech_requests: Mutex::new(Vec::new()),
                speech_pcm_chunks: Mutex::new(Vec::new()),
                speech_chunk_delay_ms: AtomicUsize::new(0),
                speech_chunks_sent: AtomicUsize::new(0),
            })
        }

        fn with_preload_status(status: StatusCode) -> Arc<Self> {
            Arc::new(Self {
                preload_status: status,
                chat_status: Mutex::new(StatusCode::OK),
                ..Self::default()
            })
        }
    }

    async fn spawn_mock_voice_server(state: Arc<MockServerState>) -> String {
        let app = Router::new()
            .route("/api/chat", post(handle_ollama_preload))
            .route("/v1/audio/transcriptions", post(handle_transcriptions))
            .route("/v1/chat/completions", post(handle_chat_completions))
            .route("/v1/audio/speech", post(handle_audio_speech))
            .with_state(state);

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback mock server");
        let addr = listener.local_addr().expect("mock server local_addr");
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("run mock voice server");
        });
        format!("http://{addr}/v1")
    }

    async fn handle_ollama_preload(
        State(state): State<Arc<MockServerState>>,
        Json(body): Json<Value>,
    ) -> Response {
        state.preload_bodies.lock().await.push(body);
        (state.preload_status, Json(json!({ "done": true }))).into_response()
    }

    async fn handle_transcriptions(
        State(state): State<Arc<MockServerState>>,
        mut multipart: Multipart,
    ) -> Response {
        let mut captured = CapturedTranscription::default();
        while let Some(field) = multipart.next_field().await.expect("read multipart field") {
            let name = field.name().unwrap_or("").to_string();
            match name.as_str() {
                "file" => {
                    captured.file_name = field.file_name().map(ToOwned::to_owned);
                    captured.content_type = field.content_type().map(ToOwned::to_owned);
                    captured.file_bytes = field.bytes().await.expect("read wav bytes").to_vec();
                }
                "model" => {
                    captured.model = Some(field.text().await.expect("read model field"));
                }
                "language" => {
                    captured.language = Some(field.text().await.expect("read language field"));
                }
                "prompt" => {
                    captured.prompt = Some(field.text().await.expect("read prompt field"));
                }
                _ => {}
            }
        }
        state.transcriptions.lock().await.push(captured);
        let reply = state.transcription_reply_text.lock().await.clone();
        (StatusCode::OK, Json(json!({ "text": reply }))).into_response()
    }

    async fn handle_chat_completions(
        State(state): State<Arc<MockServerState>>,
        Json(body): Json<Value>,
    ) -> Response {
        state.chat_requests.lock().await.push(body);
        let status = *state.chat_status.lock().await;
        if !status.is_success() {
            return (status, "upstream chat failure").into_response();
        }

        let chunks = state.chat_sse_chunks.lock().await.clone();
        let delay_ms = state.chat_chunk_delay_ms.load(Ordering::SeqCst);

        let stream = futures_util::stream::unfold(
            (chunks.into_iter(), delay_ms),
            |(mut iter, wait_ms)| async move {
                let next_chunk = iter.next()?;
                if wait_ms > 0 {
                    let millis = u64::try_from(wait_ms).unwrap_or(50);
                    tokio::time::sleep(Duration::from_millis(millis)).await;
                }
                Some((
                    Ok::<Vec<u8>, std::convert::Infallible>(next_chunk),
                    (iter, wait_ms),
                ))
            },
        );

        Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "text/event-stream")
            .body(Body::from_stream(stream))
            .expect("build SSE response")
    }

    async fn handle_audio_speech(
        State(state): State<Arc<MockServerState>>,
        Json(body): Json<Value>,
    ) -> Response {
        state.speech_requests.lock().await.push(body);
        let chunks = state.speech_pcm_chunks.lock().await.clone();
        let delay_ms = state.speech_chunk_delay_ms.load(Ordering::SeqCst);
        let state_for_stream = Arc::clone(&state);

        let stream = futures_util::stream::unfold(
            (chunks.into_iter(), state_for_stream, delay_ms),
            |(mut iter, st, wait_ms)| async move {
                let next_chunk = iter.next()?;
                if wait_ms > 0 {
                    let millis = u64::try_from(wait_ms).unwrap_or(50);
                    tokio::time::sleep(Duration::from_millis(millis)).await;
                }
                st.speech_chunks_sent.fetch_add(1, Ordering::SeqCst);
                Some((
                    Ok::<Vec<u8>, std::convert::Infallible>(next_chunk),
                    (iter, st, wait_ms),
                ))
            },
        );

        Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "application/octet-stream")
            .body(Body::from_stream(stream))
            .expect("build PCM stream response")
    }

    #[test]
    fn defaults_and_loopback_url_security_enforced() {
        let default_cfg = VoicePipelineConfig::default();
        assert_eq!(default_cfg.stt_base_url, DEFAULT_OLLAMA_OPENAI_BASE_URL);
        assert_eq!(default_cfg.llm_base_url, DEFAULT_OLLAMA_OPENAI_BASE_URL);
        assert_eq!(default_cfg.tts_base_url, DEFAULT_OLLAMA_OPENAI_BASE_URL);
        assert_eq!(default_cfg.stt_model, DEFAULT_STT_MODEL);
        assert_eq!(default_cfg.llm_model, DEFAULT_LLM_MODEL);
        assert_eq!(default_cfg.tts_model, DEFAULT_TTS_MODEL);
        assert_eq!(default_cfg.tts_voice, DEFAULT_TTS_VOICE);
        assert_eq!(TTS_PCM_SAMPLE_RATE_HZ, 24_000);
        default_cfg
            .validate()
            .expect("default config should be valid");

        for accepted in [
            "http://127.0.0.1:11434/v1",
            "https://127.0.0.1:8443/v1/",
            "http://[::1]:11434/v1",
            "http://localhost:8000/v1",
            "https://LOCALHOST:9000",
        ] {
            let parsed = validate_loopback_base_url("llm_base_url", accepted)
                .expect("loopback URL should pass validation");
            assert!(matches!(parsed.scheme(), "http" | "https"));
        }

        for rejected in [
            "",
            "https://api.example.com/v1",
            "http://192.168.1.25:11434/v1",
            "http://10.0.0.5:11434/v1",
            "http://0.0.0.0:11434/v1",
            "http://[::]:11434/v1",
            "http://localhost.evil.example/v1",
            "ws://127.0.0.1:11434/v1",
            "file:///etc/passwd",
            "http://user:secret@127.0.0.1:11434/v1",
            "http://token@localhost:11434/v1",
            "http://127.0.0.1:11434/v1? leaked=1",
            "http://127.0.0.1:11434/v1#frag",
        ] {
            let err = validate_loopback_base_url("stt_base_url", rejected)
                .expect_err("non-loopback or credentialed URL must be rejected");
            assert!(matches!(
                err,
                VoiceError::InvalidEndpointUrl {
                    field: "stt_base_url",
                    ..
                }
            ));
        }

        let bad_remote_cfg = VoicePipelineConfig {
            llm_base_url: "https://api.example.com/v1".to_string(),
            ..VoicePipelineConfig::default()
        };
        assert!(VoicePipelineClient::new(bad_remote_cfg).is_err());

        let empty_model_cfg = VoicePipelineConfig {
            tts_model: "   ".to_string(),
            ..VoicePipelineConfig::default()
        };
        assert!(matches!(
            empty_model_cfg.validate(),
            Err(VoiceError::InvalidConfig {
                field: "tts_model",
                ..
            })
        ));
    }

    #[test]
    fn clause_chunker_splits_sentences_and_long_clauses_across_token_boundaries() {
        assert_eq!(CLAUSE_SECONDARY_SPLIT_MIN_CHARS, 64);

        let mut chunker = ClauseChunker::new();
        assert_eq!(chunker.buffered(), "");

        assert!(chunker.push_str("Hi").is_empty());
        assert!(chunker.push_str(", I am calling for Dr. Parks!").is_empty());
        let first_emit = chunker.push_str(" Do you");
        assert_eq!(first_emit, vec!["Hi, I am calling for Dr. Parks!"]);
        assert_eq!(chunker.buffered(), "Do you");

        let second_emit = chunker.push_str(
            " have a quiet dinner table available for a party of four around seven forty-five p m, or would eight o'clock work better?",
        );
        assert_eq!(
            second_emit,
            vec![
                "Do you have a quiet dinner table available for a party of four around seven forty-five p m,"
            ]
        );
        assert_eq!(
            chunker.finish(),
            Some("or would eight o'clock work better?".to_string())
        );
        assert_eq!(chunker.finish(), None);
    }

    #[tokio::test]
    async fn preload_models_warms_deduplicated_ollama_models_and_ignores_404() {
        let state = MockServerState::new();
        let base_url = spawn_mock_voice_server(Arc::clone(&state)).await;

        let cfg = VoicePipelineConfig {
            stt_base_url: base_url.clone(),
            llm_base_url: base_url.clone(),
            tts_base_url: base_url,
            ..VoicePipelineConfig::default()
        };
        let client = VoicePipelineClient::new(cfg).expect("create voice client");
        assert_eq!(client.config().llm_model, DEFAULT_LLM_MODEL);

        let cancel = CancellationToken::new();
        client
            .preload_models(&cancel)
            .await
            .expect("preload_models succeeds");

        {
            let bodies = state.preload_bodies.lock().await;
            assert_eq!(bodies.len(), 2);
            assert_eq!(bodies[0]["model"], DEFAULT_LLM_MODEL);
            assert_eq!(bodies[0]["keep_alive"], DEFAULT_KEEP_ALIVE);
            assert_eq!(bodies[0]["stream"], false);
            assert_eq!(bodies[1]["model"], DEFAULT_TTS_MODEL);
            assert_eq!(bodies[1]["keep_alive"], DEFAULT_KEEP_ALIVE);
        }

        let state_404 = MockServerState::with_preload_status(StatusCode::NOT_FOUND);
        let non_ollama_url = spawn_mock_voice_server(state_404).await;
        let mixed_client = VoicePipelineClient::with_http_client(
            VoicePipelineConfig {
                stt_base_url: non_ollama_url.clone(),
                llm_base_url: non_ollama_url.clone(),
                tts_base_url: non_ollama_url,
                ..VoicePipelineConfig::default()
            },
            crate::tls::http_client(),
        )
        .expect("create mixed voice client");
        mixed_client
            .preload_models(&cancel)
            .await
            .expect("404 on /api/chat must be ignored gracefully");
    }

    #[tokio::test]
    async fn transcribe_wav_sends_multipart_fields_and_filters_noise_hallucinations() {
        let state = MockServerState::new();
        *state.transcription_reply_text.lock().await =
            "  [Static] Hello, Osteria Bella, how can I help you?  ".to_string();
        let base_url = spawn_mock_voice_server(Arc::clone(&state)).await;

        let client = VoicePipelineClient::new(VoicePipelineConfig {
            stt_base_url: base_url,
            ..VoicePipelineConfig::default()
        })
        .expect("create voice client");

        let params = VoiceCallPromptParams {
            user_display_name: "Alex Example".to_string(),
            callee_name: Some("Osteria Bella".to_string()),
            objective: "Book a dinner reservation for a party of four at seven forty-five p m"
                .to_string(),
            first_message: None,
            context: None,
        };
        let conv = VoiceConversation::new(params);
        assert!(conv.stt_vocabulary_prompt().len() <= STT_PROMPT_MAX_BYTES);
        assert!(conv.stt_vocabulary_prompt().contains("Alex Example"));
        assert!(conv.stt_vocabulary_prompt().contains("Osteria Bella"));

        let fake_wav = b"RIFF\x24\x00\x00\x00WAVEfmt mock-pcm-payload";
        let cancel = CancellationToken::new();
        let text = client
            .transcribe_utterance(fake_wav, &conv, &cancel)
            .await
            .expect("transcribe utterance")
            .expect("non-empty speech");

        assert_eq!(text, "Hello, Osteria Bella, how can I help you?");

        {
            let captured = state.transcriptions.lock().await;
            assert_eq!(captured.len(), 1);
            assert_eq!(captured[0].file_name.as_deref(), Some("utterance.wav"));
            assert_eq!(captured[0].content_type.as_deref(), Some("audio/wav"));
            assert_eq!(captured[0].file_bytes, fake_wav);
            assert_eq!(captured[0].model.as_deref(), Some(DEFAULT_STT_MODEL));
            assert_eq!(captured[0].language.as_deref(), Some(DEFAULT_STT_LANGUAGE));
            assert_eq!(
                captured[0].prompt.as_deref(),
                Some(conv.stt_vocabulary_prompt())
            );
        }

        let huge_prompt = build_stt_vocabulary_prompt(
            "Alex Example",
            Some("Osteria Bella"),
            &"word ".repeat(200),
        );
        assert!(huge_prompt.len() <= STT_PROMPT_MAX_BYTES);

        for artifact in [
            "   ",
            "[BLANK_AUDIO]",
            "[Silence] [Music]",
            "(inaudible)",
            "*static*",
            "...",
        ] {
            *state.transcription_reply_text.lock().await = artifact.to_string();
            let filtered = client
                .transcribe_wav(fake_wav, conv.stt_vocabulary_prompt(), &cancel)
                .await
                .expect("transcribe noise artifact");
            assert_eq!(
                filtered, None,
                "expected artifact '{artifact}' to be ignored"
            );
        }
    }

    #[tokio::test]
    async fn streaming_chat_completions_preserves_kv_cache_reassembles_tools_and_truncates_barge_in(
    ) {
        let state = MockServerState::new();
        let base_url = spawn_mock_voice_server(Arc::clone(&state)).await;

        let client = VoicePipelineClient::new(VoicePipelineConfig {
            llm_base_url: base_url,
            ..VoicePipelineConfig::default()
        })
        .expect("create voice client");

        let params = VoiceCallPromptParams {
            user_display_name: "Alex Example".to_string(),
            callee_name: Some("Osteria Bella".to_string()),
            objective: "Reserve a table for four on October twenty-third at seven forty-five p m"
                .to_string(),
            first_message: Some("Greet warmly and ask for reservations.".to_string()),
            context: Some("Anniversary dinner; quiet table preferred.".to_string()),
        };
        let expected_system_prompt = build_system_prompt(&params);
        assert!(expected_system_prompt.contains("CALLER-IDENTIFYING OPENING"));
        assert!(expected_system_prompt.contains("I'm calling for Alex Example"));
        assert!(expected_system_prompt.contains("Never pretend to be Alex Example"));
        assert!(expected_system_prompt.contains("answer truthfully"));
        assert!(!expected_system_prompt.contains("mandatory AI disclosure"));
        assert!(expected_system_prompt
            .contains("Opening turn guidance: Greet warmly and ask for reservations."));
        assert!(expected_system_prompt.contains("seven forty-five p m"));
        assert!(expected_system_prompt.contains("7:45pm"));
        assert!(expected_system_prompt.contains("Osteria Bella"));

        let mut conv = VoiceConversation::new(params);
        let initial_msg_zero = conv.messages()[0].clone();
        assert_eq!(conv.system_prompt(), expected_system_prompt);

        conv.push_callee_utterance(
            "Thank you for calling Osteria Bella. Press 1 for reservations or hold.",
        );

        let sse_lines = [
            b": keep-alive\r\n\r\n".to_vec(),
            b"data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Hi, I am an AI assistant calling on behalf of Alex Example.\"}}]}\n\n".to_vec(),
            b"data: {\"choices\":[{\"delta\":{\"content\":\" Pressing one for reservations now!\"}}]}\n\n".to_vec(),
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_dtmf_1\",\"type\":\"function\",\"function\":{\"name\":\"send_\",\"arguments\":\"{\\\"dig\"}}]}}]}\n\n".to_vec(),
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"dtmf\",\"arguments\":\"its\\\":\\\"1\\\"}\"}},{\"index\":1,\"id\":\"call_wait_2\",\"type\":\"function\",\"function\":{\"name\":\"wait_silently\",\"arguments\":\"{\\\"reason\\\":\\\"navigating IVR\\\"}\"}},{\"index\":2,\"id\":\"call_end_3\",\"type\":\"function\",\"function\":{\"name\":\"end_call\",\"arguments\":\"{\\\"reason\\\":\\\"done\\\",\\\"outcome_summary\\\":\\\"Pressed 1 and confirmed\\\"}\"}}]}}]}\n\n".to_vec(),
            b"data: [DONE]\n\n".to_vec(),
        ];
        *state.chat_sse_chunks.lock().await = sse_lines.to_vec();

        let cancel = CancellationToken::new();
        let mut live_clauses: Vec<String> = Vec::new();
        let turn1: AssistantTurnOutput = client
            .stream_assistant_turn(&conv, &cancel, |clause| {
                live_clauses.push(clause);
            })
            .await
            .expect("stream turn 1");

        assert_eq!(
            live_clauses,
            vec![
                "Hi, I am an AI assistant calling on behalf of Alex Example.",
                "Pressing one for reservations now!",
            ]
        );
        assert_eq!(turn1.clauses, live_clauses);
        assert_eq!(
            turn1.tool_calls,
            vec![
                VoiceToolCall::SendDtmf {
                    call_id: "call_dtmf_1".to_string(),
                    digits: "1".to_string(),
                },
                VoiceToolCall::WaitSilently {
                    call_id: "call_wait_2".to_string(),
                    reason: "navigating IVR".to_string(),
                    on_hold: false,
                },
                VoiceToolCall::EndCall {
                    call_id: "call_end_3".to_string(),
                    reason: "done".to_string(),
                    outcome_summary: "Pressed 1 and confirmed".to_string(),
                },
            ]
        );
        assert_eq!(turn1.tool_calls[0].call_id(), "call_dtmf_1");
        assert_eq!(
            turn1.raw_tool_calls[0],
            AssistantToolCallMessage {
                id: "call_dtmf_1".to_string(),
                kind: "function".to_string(),
                function: AssistantToolCallFunction {
                    name: "send_dtmf".to_string(),
                    arguments: "{\"digits\":\"1\"}".to_string(),
                },
            }
        );

        conv.record_assistant_turn(&turn1);
        conv.record_tool_result("call_dtmf_1", "sent DTMF 1");

        conv.mark_last_assistant_interrupted(
            "Hi, I am an AI assistant calling on behalf of Alex Example.",
        );

        conv.inject_steer("Ask if the heated patio is open tonight.");
        assert_eq!(conv.messages()[0], initial_msg_zero);

        let last_msg = conv.messages().last().expect("trailing steer message");
        assert_eq!(
            last_msg,
            &ChatMessage::system(format!(
                "{LIVE_STEER_PREFIX}Ask if the heated patio is open tonight."
            ))
        );

        let assistant_msg = conv
            .messages()
            .iter()
            .find(|m| m.role == MessageRole::Assistant)
            .expect("assistant message in history");
        assert_eq!(
            assistant_msg.content.as_deref(),
            Some("Hi, I am an AI assistant calling on behalf of Alex Example. [interrupted]")
        );
        assert_eq!(assistant_msg.tool_calls.len(), 1);
        assert_eq!(assistant_msg.tool_calls[0].id, "call_dtmf_1");

        assert_eq!(
            conv.transcript(),
            &[
                TranscriptEntry {
                    speaker: TranscriptSpeaker::Callee,
                    text:
                        "Thank you for calling Osteria Bella. Press 1 for reservations or hold."
                            .to_string(),
                    interrupted: false,
                },
                TranscriptEntry {
                    speaker: TranscriptSpeaker::Assistant,
                    text: format!(
                        "Hi, I am an AI assistant calling on behalf of Alex Example. {INTERRUPTED_MARKER}"
                    ),
                    interrupted: true,
                },
                TranscriptEntry {
                    speaker: TranscriptSpeaker::Steer,
                    text: "Ask if the heated patio is open tonight.".to_string(),
                    interrupted: false,
                },
            ]
        );

        *state.chat_sse_chunks.lock().await = vec![
            b"data: {\"choices\":[{\"delta\":{\"content\":\"Could we get the heated patio at seven forty-five p m?\"}}]}\n\n".to_vec(),
            b"data: [DONE]\n\n".to_vec(),
        ];
        let _turn2 = client
            .stream_assistant_turn(&conv, &cancel, |_| {})
            .await
            .expect("stream turn 2");

        let recorded_requests = state.chat_requests.lock().await;
        assert_eq!(recorded_requests.len(), 2);

        let req1 = &recorded_requests[0];
        let req2 = &recorded_requests[1];
        assert_eq!(req1["reasoning_effort"], "none");
        assert_eq!(req1["stream"], true);
        assert_eq!(req1["model"], DEFAULT_LLM_MODEL);
        let normal_tools: Vec<Value> = voice_tool_definitions()
            .as_array()
            .unwrap()
            .iter()
            .filter(|tool| tool["function"]["name"] != "resume_call")
            .cloned()
            .collect();
        assert_eq!(req1["tools"], json!(normal_tools));
        assert_eq!(req1["tool_choice"], "required");
        assert_eq!(req1["parallel_tool_calls"], false);

        assert_eq!(req1["messages"][0], req2["messages"][0]);
        assert_eq!(req2["messages"][0]["role"], "system");
        assert_eq!(req2["messages"][0]["content"], expected_system_prompt);

        let req2_msgs = req2["messages"].as_array().expect("messages array");
        let trailing = req2_msgs.last().expect("last message in turn 2");
        assert_eq!(trailing["role"], "system");
        assert_eq!(
            trailing["content"],
            "[Live instruction from user via mobile app]: Ask if the heated patio is open tonight."
        );
        drop(recorded_requests);

        conv.push_callee_utterance("I");
        client
            .stream_assistant_turn(&conv, &cancel, |_| {})
            .await
            .unwrap();
        conv.set_on_hold(true);
        for action in ["wait_silently", "resume_call"] {
            *state.chat_sse_chunks.lock().await =
                vec![
                format!("data: {}\n\n", json!({
                    "choices": [{"delta": {"content": json!({"decision": action}).to_string()}}]
                })).into_bytes(),
                b"data: [DONE]\n\n".to_vec(),
            ];
            let result = client
                .stream_assistant_turn(&conv, &cancel, |_| panic!("hold decisions are not speech"))
                .await
                .unwrap();
            assert!(result.full_text.is_empty());
            assert!(result.clauses.is_empty());
            assert_eq!(result.raw_tool_calls[0].function.name, action);
        }
        let requests = state.chat_requests.lock().await;
        let names = |request: &Value| -> Vec<String> {
            request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| tool["function"]["name"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(names(&requests[2]), vec!["send_dtmf", "wait_silently"]);
        assert!(requests[3]["tools"].is_null());
        assert!(requests[3]["tool_choice"].is_null());
        assert_eq!(
            requests[3]["response_format"]["json_schema"]["schema"]["properties"]["decision"]
                ["enum"],
            json!(["wait_silently", "resume_call"])
        );
        drop(requests);
        *state.chat_sse_chunks.lock().await = vec![
            format!(
                "data: {}\n\n",
                json!({"choices": [{"delta": {"content": "{\"decision\":\"end_call\"}"}}]})
            )
            .into_bytes(),
            b"data: [DONE]\n\n".to_vec(),
        ];
        assert!(matches!(
            client.stream_assistant_turn(&conv, &cancel, |_| {}).await,
            Err(VoiceError::InvalidResponse { .. })
        ));
    }

    #[tokio::test]
    async fn synthesize_speech_pcm24k_omits_speed_handles_odd_byte_frames_and_aborts_on_cancel() {
        let state = MockServerState::new();
        let expected_samples: [i16; 4] = [100, -200, 300, -400];
        let mut raw_pcm = Vec::new();
        for sample in expected_samples {
            raw_pcm.extend_from_slice(&sample.to_le_bytes());
        }
        *state.speech_pcm_chunks.lock().await = vec![
            raw_pcm[0..3].to_vec(),
            raw_pcm[3..5].to_vec(),
            raw_pcm[5..8].to_vec(),
        ];

        let base_url = spawn_mock_voice_server(Arc::clone(&state)).await;
        let client = VoicePipelineClient::new(VoicePipelineConfig {
            tts_base_url: base_url,
            ..VoicePipelineConfig::default()
        })
        .expect("create voice client");

        let cancel = CancellationToken::new();
        let mut decoded = Vec::new();
        let sample_count = client
            .synthesize_speech_pcm24k(
                "We have a table at seven forty-five p m.",
                &cancel,
                |samples| decoded.extend_from_slice(samples),
            )
            .await
            .expect("synthesize speech");

        assert_eq!(sample_count, 4);
        assert_eq!(decoded, expected_samples);

        {
            let speech_reqs = state.speech_requests.lock().await;
            assert_eq!(speech_reqs.len(), 1);
            let req_obj = speech_reqs[0].as_object().expect("speech JSON object");
            assert_eq!(req_obj.get("model"), Some(&json!(DEFAULT_TTS_MODEL)));
            assert_eq!(req_obj.get("voice"), Some(&json!(DEFAULT_TTS_VOICE)));
            assert_eq!(req_obj.get("response_format"), Some(&json!("pcm")));
            assert_eq!(
                req_obj.get("input"),
                Some(&json!("We have a table at seven forty-five p m."))
            );
            assert!(
                !req_obj.contains_key("speed"),
                "TTS payload must not contain 'speed'"
            );
        }

        state.speech_chunk_delay_ms.store(40, Ordering::SeqCst);
        state.speech_chunks_sent.store(0, Ordering::SeqCst);
        *state.speech_pcm_chunks.lock().await =
            (0..20).map(|_| vec![0x01_u8, 0x00, 0x02, 0x00]).collect();

        let barge_in_cancel = CancellationToken::new();
        let cancel_trigger = barge_in_cancel.clone();
        let mut chunks_seen = 0_usize;
        let err = client
            .synthesize_speech_pcm24k(
                "Long sentence that gets interrupted mid-playback.",
                &barge_in_cancel,
                |_samples| {
                    chunks_seen = chunks_seen.saturating_add(1);
                    if chunks_seen == 2 {
                        cancel_trigger.cancel();
                    }
                },
            )
            .await
            .expect_err("mid-stream cancel must abort TTS");

        assert!(err.is_cancelled());
        assert_eq!(chunks_seen, 2);
        assert!(state.speech_chunks_sent.load(Ordering::SeqCst) < 20);
    }

    #[tokio::test]
    async fn sse_mid_utf8_splits_mid_stream_barge_in_dtmf_validation_and_silent_pickup() {
        let state = MockServerState::new();
        let base_url = spawn_mock_voice_server(Arc::clone(&state)).await;

        let client = VoicePipelineClient::new(VoicePipelineConfig {
            llm_base_url: base_url,
            ..VoicePipelineConfig::default()
        })
        .expect("create voice client");

        let mut conv = VoiceConversation::new(VoiceCallPromptParams {
            user_display_name: "Zoë Martin".to_string(),
            callee_name: None,
            objective: "Confirm appointment".to_string(),
            first_message: None,
            context: None,
        });
        let initial_system_msg = conv.messages()[0].clone();

        let full_sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello, calling on behalf of Zoë! Press tone now.\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"dtmf_lc\",\"function\":{\"name\":\"send_dtmf\",\"arguments\":\"{\\\"digits\\\":\\\"1 a #\\\"}\"}}]}}]}\n\ndata: [DONE]\n\n".as_bytes().to_vec();
        let e_diaeresis_pos = full_sse
            .windows(2)
            .position(|w| w == [0xC3, 0xAB])
            .expect("find UTF-8 ë bytes");
        let split_at = e_diaeresis_pos.saturating_add(1);
        *state.chat_sse_chunks.lock().await =
            vec![full_sse[..split_at].to_vec(), full_sse[split_at..].to_vec()];

        let cancel = CancellationToken::new();
        let mut clauses = Vec::new();
        let turn = client
            .stream_assistant_turn(&conv, &cancel, |c| clauses.push(c))
            .await
            .expect("stream silent pickup turn with split UTF-8");

        assert_eq!(
            clauses,
            vec!["Hello, calling on behalf of Zoë!", "Press tone now.",]
        );
        assert_eq!(
            turn.tool_calls,
            vec![VoiceToolCall::SendDtmf {
                call_id: "dtmf_lc".to_string(),
                digits: "1A#".to_string(),
            }]
        );
        assert_eq!(conv.messages().len(), 1);
        assert_eq!(conv.messages()[0], initial_system_msg);
        {
            let reqs = state.chat_requests.lock().await;
            assert_eq!(reqs[0]["messages"][0]["role"], "system");
            assert_eq!(reqs[0]["messages"][1]["role"], "user");
            assert_eq!(reqs[0]["messages"][1]["content"], SILENT_PICKUP_USER_CUE);
            assert!(!reqs[0]["messages"][0]["content"]
                .as_str()
                .unwrap()
                .contains("mandatory AI disclosure"));
        }

        conv.push_callee_utterance("Please hold while I check.");
        state.chat_chunk_delay_ms.store(40, Ordering::SeqCst);
        *state.chat_sse_chunks.lock().await = vec![
            b"data: {\"choices\":[{\"delta\":{\"content\":\"Of course, I can hold.\"}}]}\n\n"
                .to_vec(),
            b"data: {\"choices\":[{\"delta\":{\"content\":\" Take all the time you need.\"}}]}\n\n"
                .to_vec(),
            b"data: {\"choices\":[{\"delta\":{\"content\":\" Still here.\"}}]}\n\n".to_vec(),
            b"data: [DONE]\n\n".to_vec(),
        ];

        let stream_cancel = CancellationToken::new();
        let stream_cancel_trigger = stream_cancel.clone();
        let mut partial_clauses = Vec::new();
        let cancel_err = client
            .stream_assistant_turn(&conv, &stream_cancel, |clause| {
                partial_clauses.push(clause);
                stream_cancel_trigger.cancel();
            })
            .await
            .expect_err("barge-in cancel must abort streaming LLM turn");
        assert!(cancel_err.is_cancelled());
        assert_eq!(partial_clauses, vec!["Of course, I can hold."]);

        conv.mark_last_assistant_interrupted("Of course, I can hold.");
        assert_eq!(conv.messages()[0], initial_system_msg);
        assert_eq!(
            conv.messages().last(),
            Some(&ChatMessage::assistant(
                "Of course, I can hold. [interrupted]"
            ))
        );
        assert_eq!(
            conv.transcript().last(),
            Some(&TranscriptEntry {
                speaker: TranscriptSpeaker::Assistant,
                text: "Of course, I can hold. [interrupted]".to_string(),
                interrupted: true,
            })
        );

        state.chat_chunk_delay_ms.store(0, Ordering::SeqCst);
        *state.chat_sse_chunks.lock().await = vec![
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"bad_dtmf\",\"function\":{\"name\":\"send_dtmf\",\"arguments\":\"{\\\"digits\\\":\\\"99Z\\\"}\"}}]}}]}\n\n".to_vec(),
            b"data: [DONE]\n\n".to_vec(),
        ];
        let bad_tool_err = client
            .stream_assistant_turn(&conv, &cancel, |_| {})
            .await
            .expect_err("invalid DTMF character must fail");
        assert!(matches!(
            bad_tool_err,
            VoiceError::InvalidToolCall {
                ref tool_name,
                ..
            } if tool_name == "send_dtmf"
        ));

        *state.chat_sse_chunks.lock().await =
            vec![b"data: {\"error\":{\"message\":\"runner crashed\"}}\n\n".to_vec()];
        let sse_err = client
            .stream_assistant_turn(&conv, &cancel, |_| {})
            .await
            .expect_err("mid-stream SSE error object must fail");
        assert!(matches!(sse_err, VoiceError::InvalidResponse { .. }));

        *state.chat_status.lock().await = StatusCode::INTERNAL_SERVER_ERROR;
        let status_err = client
            .stream_assistant_turn(&conv, &cancel, |_| {})
            .await
            .expect_err("HTTP 500 must fail");
        assert!(matches!(
            status_err,
            VoiceError::HttpStatus { status: 500, .. }
        ));
    }

    async fn spawn_status_server(status: StatusCode, body: Vec<u8>) -> String {
        let app = Router::new()
            .route("/v1/audio/transcriptions", post(handle_status_reply))
            .route("/v1/audio/speech", post(handle_status_reply))
            .with_state(Arc::new((status, body)));

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback status server");
        let addr = listener.local_addr().expect("status server local_addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("run status server");
        });
        format!("http://{addr}/v1")
    }

    async fn handle_status_reply(
        State(reply): State<Arc<(StatusCode, Vec<u8>)>>,
        _request_body: axum::body::Bytes,
    ) -> Response {
        (reply.0, reply.1.clone()).into_response()
    }

    fn no_context_params(user_display_name: &str, objective: &str) -> VoiceCallPromptParams {
        VoiceCallPromptParams {
            user_display_name: user_display_name.to_string(),
            callee_name: None,
            objective: objective.to_string(),
            first_message: None,
            context: None,
        }
    }

    #[test]
    fn endpoint_paths_and_prompts_handle_root_paths_credentials_and_blank_fields() {
        let err = validate_loopback_base_url("tts_base_url", "http://:secret@127.0.0.1:11434/v1")
            .expect_err("password-only credentials must be rejected");
        assert!(matches!(
            err,
            VoiceError::InvalidEndpointUrl { field: "tts_base_url", ref reason }
                if reason.contains("credentials")
        ));

        let root = validate_loopback_base_url("llm_base_url", "http://127.0.0.1:11434/").unwrap();
        assert_eq!(
            append_endpoint_path(&root, "/chat/completions").as_str(),
            "http://127.0.0.1:11434/chat/completions"
        );
        assert_eq!(
            derive_ollama_api_chat_url(&root).as_str(),
            "http://127.0.0.1:11434/api/chat"
        );
        let proxied =
            validate_loopback_base_url("llm_base_url", "http://localhost:8080/proxy/v1/").unwrap();
        assert_eq!(
            append_endpoint_path(&proxied, "audio/speech").as_str(),
            "http://localhost:8080/proxy/v1/audio/speech"
        );
        assert_eq!(
            derive_ollama_api_chat_url(&proxied).as_str(),
            "http://localhost:8080/proxy/api/chat"
        );

        assert_eq!(build_stt_vocabulary_prompt(" ", None, "\t"), "");
        assert_eq!(
            build_stt_vocabulary_prompt("", Some(" Osteria   Bella "), ""),
            "Callee: Osteria Bella."
        );
        let multibyte = build_stt_vocabulary_prompt("", None, &"\u{e9}".repeat(200));
        assert_eq!(multibyte.len(), STT_PROMPT_MAX_BYTES - 1);
        assert!(multibyte.starts_with("Context: \u{e9}"));
        assert!(multibyte.ends_with('\u{e9}'));
        assert_eq!(truncate_utf8_at_boundary("\u{e9}", 1), "");

        let prompt = build_system_prompt(&VoiceCallPromptParams {
            user_display_name: "  ".to_string(),
            callee_name: Some("  ".to_string()),
            objective: " ".to_string(),
            first_message: Some("\n".to_string()),
            context: Some("\t".to_string()),
        });
        assert!(prompt.contains("carrying out a request for the user."));
        assert!(prompt.contains("I'm calling for the user to book"));
        for absent in [
            "Callee:",
            "Call objective:",
            "Opening turn guidance:",
            "Additional background context:",
        ] {
            assert!(!prompt.contains(absent), "unexpected {absent} section");
        }
        assert!(prompt.ends_with("without breaking conversational flow."));

        assert_eq!(normalize_dtmf_digits("1-800 *#").unwrap(), "1800*#");
        assert!(matches!(
            normalize_dtmf_digits(" - - "),
            Err(VoiceError::InvalidToolCall { ref reason, .. })
                if reason.contains("at least one DTMF symbol")
        ));
        assert!(!contains_subslice(b"boundary", b""));
    }

    #[test]
    fn transcript_cleanup_strips_only_closed_non_speech_annotations() {
        for (raw, expected) in [
            (
                "hello [music] there [Bob] and [unclosed tail",
                Some("hello there [Bob] and [unclosed tail"),
            ),
            ("[unclosed hello", Some("[unclosed hello")),
            ("[Bob] says hi", Some("[Bob] says hi")),
            ("thanks for holding [music]", Some("thanks for holding")),
            ("closing bracket]", Some("closing bracket]")),
            ("call me (maybe)", Some("call me (maybe)")),
            ("[] hello", Some("hello")),
            ("(...) hello (laughter)", Some("hello")),
            ("[ ] (\u{266a})", None),
        ] {
            assert_eq!(
                clean_transcription_text(raw).as_deref(),
                expected,
                "cleaning {raw:?}"
            );
        }
    }

    #[test]
    fn conversation_ignores_blank_inputs_and_answers_unreplied_tool_calls() {
        let mut conv = VoiceConversation::new(no_context_params("   ", "  "));
        assert_eq!(conv.stt_vocabulary_prompt(), "");
        assert!(conv.system_prompt().contains("request for the user."));

        conv.push_callee_utterance(" \t ");
        conv.record_assistant_turn(&AssistantTurnOutput {
            full_text: "  ".to_string(),
            clauses: Vec::new(),
            tool_calls: Vec::new(),
            raw_tool_calls: Vec::new(),
        });
        conv.record_tool_result("  ", "ignored");
        conv.inject_steer("\n");
        assert_eq!(conv.messages().len(), 1);
        assert!(conv.transcript().is_empty());
        assert_eq!(
            conv.build_request_messages().last(),
            Some(&ChatMessage::user(SILENT_PICKUP_USER_CUE))
        );

        conv.push_callee_utterance("Hello, who is calling?");
        let unreplied_call = AssistantToolCallMessage {
            id: "call_wait".to_string(),
            kind: "function".to_string(),
            function: AssistantToolCallFunction {
                name: "wait_silently".to_string(),
                arguments: "{}".to_string(),
            },
        };
        conv.record_assistant_turn(&AssistantTurnOutput {
            full_text: " ".to_string(),
            clauses: Vec::new(),
            tool_calls: Vec::new(),
            raw_tool_calls: vec![unreplied_call.clone()],
        });
        assert_eq!(conv.messages().len(), 3);
        assert_eq!(conv.messages()[2].tool_calls, vec![unreplied_call]);
        assert_eq!(conv.transcript().len(), 1);

        let request = conv.build_request_messages();
        assert_eq!(request.len(), 4);
        assert_eq!(request[3], ChatMessage::tool("call_wait", "ok"));
        assert!(request
            .iter()
            .all(|msg| msg.content.as_deref() != Some(SILENT_PICKUP_USER_CUE)));

        conv.mark_last_assistant_interrupted("   ");
        assert_eq!(
            conv.messages()[2].content.as_deref(),
            Some(INTERRUPTED_MARKER)
        );
        assert!(conv.messages()[2].tool_calls.is_empty());
        assert_eq!(
            conv.transcript().last(),
            Some(&TranscriptEntry {
                speaker: TranscriptSpeaker::Assistant,
                text: INTERRUPTED_MARKER.to_string(),
                interrupted: true,
            })
        );
    }

    #[test]
    fn clause_chunker_handles_blank_input_closing_quotes_decimals_and_parenthesized_titles() {
        let mut chunker = ClauseChunker::new();
        assert!(chunker.push_str("").is_empty());
        assert!(chunker.push_str("   ").is_empty());
        assert_eq!(chunker.finish(), None);

        assert_eq!(
            chunker.push_str("She said \"yes.\" Then"),
            vec!["She said \"yes.\""]
        );
        assert_eq!(chunker.buffered(), "Then");
        assert_eq!(
            chunker.push_str(" version 2.5 shipped. Next"),
            vec!["Then version 2.5 shipped."]
        );
        assert_eq!(chunker.buffered(), "Next");
        assert_eq!(
            chunker.push_str(" (Dr. Smith) will call. Ok"),
            vec!["Next (Dr. Smith) will call."]
        );
        assert_eq!(chunker.finish(), Some("Ok".to_string()));
    }

    #[tokio::test]
    async fn cancelled_or_empty_requests_return_without_contacting_endpoints() {
        let client = VoicePipelineClient::new(VoicePipelineConfig::default()).unwrap();
        let conv = VoiceConversation::new(no_context_params("Alex Example", "Confirm"));
        let cancelled = CancellationToken::new();
        cancelled.cancel();

        assert!(client
            .preload_models(&cancelled)
            .await
            .unwrap_err()
            .is_cancelled());
        assert!(client
            .transcribe_wav(b"RIFF", "prompt", &cancelled)
            .await
            .unwrap_err()
            .is_cancelled());
        assert!(client
            .stream_assistant_turn(&conv, &cancelled, |_| panic!("no clause expected"))
            .await
            .unwrap_err()
            .is_cancelled());
        assert!(client
            .synthesize_speech_pcm24k("Hello.", &cancelled, |_| panic!("no audio expected"))
            .await
            .unwrap_err()
            .is_cancelled());

        let live = CancellationToken::new();
        assert_eq!(
            client.transcribe_wav(&[], "prompt", &live).await.unwrap(),
            None
        );
        assert_eq!(
            client
                .synthesize_speech_pcm24k(" \n ", &live, |_| panic!("no audio expected"))
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn stt_and_tts_http_failures_report_status_with_bounded_error_body() {
        let mut oversized_body = "a".repeat(ERROR_BODY_MAX_BYTES - 1).into_bytes();
        oversized_body.extend_from_slice("\u{e9} and everything after the cap".as_bytes());
        let stt_url = spawn_status_server(StatusCode::BAD_GATEWAY, oversized_body).await;
        let tts_url = spawn_status_server(
            StatusCode::SERVICE_UNAVAILABLE,
            b"  model loading  ".to_vec(),
        )
        .await;
        let client = VoicePipelineClient::new(VoicePipelineConfig {
            stt_base_url: stt_url,
            tts_base_url: tts_url,
            ..VoicePipelineConfig::default()
        })
        .expect("create voice client");
        let cancel = CancellationToken::new();

        match client.transcribe_wav(b"RIFFdata", "prompt", &cancel).await {
            Err(VoiceError::HttpStatus {
                endpoint,
                status,
                body,
            }) => {
                assert!(endpoint.ends_with("/v1/audio/transcriptions"));
                assert_eq!(status, 502);
                let expected = "a".repeat(ERROR_BODY_MAX_BYTES - 1) + "\u{fffd}";
                assert_eq!(body, expected);
            }
            other => panic!("expected bounded STT HTTP error, got {other:?}"),
        }

        match client
            .synthesize_speech_pcm24k("Hello there.", &cancel, |_| panic!("no audio expected"))
            .await
        {
            Err(VoiceError::HttpStatus {
                endpoint,
                status,
                body,
            }) => {
                assert!(endpoint.ends_with("/v1/audio/speech"));
                assert_eq!(status, 503);
                assert_eq!(body, "model loading");
            }
            other => panic!("expected TTS HTTP error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn sse_stream_skips_non_data_lines_parses_unterminated_tails_and_partial_tool_deltas() {
        let state = MockServerState::new();
        let base_url = spawn_mock_voice_server(Arc::clone(&state)).await;
        let client = VoicePipelineClient::new(VoicePipelineConfig {
            llm_base_url: base_url,
            ..VoicePipelineConfig::default()
        })
        .expect("create voice client");
        let mut conv = VoiceConversation::new(no_context_params(
            "Alex Example",
            "Confirm the delivery window",
        ));
        conv.push_callee_utterance("Please hold while I look that up.");
        let cancel = CancellationToken::new();
        let content_chunk = |text: &str| json!({"choices": [{"delta": {"content": text}}]});
        let tool_delta = |delta: Value| json!({"choices": [{"delta": {"tool_calls": [delta]}}]});

        let lines = [
            "   ".to_string(),
            " : padded comment".to_string(),
            "event: message".to_string(),
            "data:    ".to_string(),
            format!("data: {}", content_chunk("Sure, one moment.")),
            format!("data: {}", tool_delta(json!({"index": 0, "id": "call_"}))),
            format!(
                "data: {}",
                tool_delta(json!({"index": 0, "id": "hold", "function": {"name": "wait_"}}))
            ),
            format!(
                "data: {}",
                tool_delta(
                    json!({"index": 0, "function": {"name": "", "arguments": "{\"on_hold\":true}"}})
                )
            ),
            format!(
                "data: {}",
                tool_delta(json!({"index": 0, "function": {"name": "silently"}}))
            ),
            format!(
                "data: {}",
                tool_delta(json!({"index": 1, "function": {"name": "resume_call"}}))
            ),
        ];
        // The stream closes after a complete CRLF-terminated line without sending [DONE].
        *state.chat_sse_chunks.lock().await = vec![(lines.join("\r\n") + "\r\n").into_bytes()];
        let mut spoken = Vec::new();
        let turn = client
            .stream_assistant_turn(&conv, &cancel, |clause| spoken.push(clause))
            .await
            .expect("stream without [DONE]");
        assert_eq!(turn.full_text, "Sure, one moment.");
        assert_eq!(turn.clauses, vec!["Sure, one moment."]);
        assert_eq!(spoken, turn.clauses);
        assert_eq!(
            turn.tool_calls[0],
            VoiceToolCall::WaitSilently {
                call_id: "call_hold".to_string(),
                reason: "waiting".to_string(),
                on_hold: true,
            }
        );
        assert_eq!(turn.raw_tool_calls[0].function.name, "wait_silently");
        assert_eq!(
            turn.raw_tool_calls[0].function.arguments,
            "{\"on_hold\":true}"
        );
        let generated_id = turn.tool_calls[1].call_id();
        assert!(generated_id.starts_with("call_1_"), "{generated_id}");
        assert_eq!(
            turn.tool_calls[1],
            VoiceToolCall::ResumeCall {
                call_id: generated_id.to_string(),
            }
        );
        assert_eq!(turn.raw_tool_calls[1].id, generated_id);
        assert_eq!(turn.raw_tool_calls[1].function.arguments, "{}");

        for (tail, text) in [
            (
                format!("data: {}", content_chunk("Final words.")),
                "Final words.",
            ),
            (
                format!("data: {}\r", content_chunk("Carriage return tail.")),
                "Carriage return tail.",
            ),
        ] {
            *state.chat_sse_chunks.lock().await = vec![tail.into_bytes()];
            let mut tail_clauses = Vec::new();
            let tail_turn = client
                .stream_assistant_turn(&conv, &cancel, |clause| tail_clauses.push(clause))
                .await
                .expect("unterminated final SSE line");
            assert_eq!(tail_turn.full_text, text);
            assert_eq!(tail_turn.clauses, vec![text.to_string()]);
            assert_eq!(tail_clauses, tail_turn.clauses);
            assert!(tail_turn.tool_calls.is_empty());
        }

        *state.chat_sse_chunks.lock().await = vec![vec![b'a'; SSE_LINE_MAX_BYTES + 1]];
        let oversized = client
            .stream_assistant_turn(&conv, &cancel, |_| {})
            .await
            .expect_err("oversized SSE line must fail");
        assert!(matches!(
            oversized,
            VoiceError::InvalidResponse { ref reason, .. } if reason.contains("exceeded")
        ));

        *state.chat_sse_chunks.lock().await = vec![format!(
            "data: {}\n\ndata: [DONE]\n\n",
            tool_delta(json!({"index": 0, "id": "call_nameless", "function": {"arguments": "{}"}}))
        )
        .into_bytes()];
        let nameless = client
            .stream_assistant_turn(&conv, &cancel, |_| {})
            .await
            .expect_err("nameless tool call must fail");
        assert!(matches!(
            nameless,
            VoiceError::InvalidToolCall { ref tool_name, .. } if tool_name == "<empty>"
        ));
    }

    #[tokio::test]
    async fn transcription_without_prompt_and_single_byte_tts_chunks_round_trip() {
        let state = MockServerState::new();
        *state.transcription_reply_text.lock().await = " Yes,  that works. ".to_string();
        let expected_samples: [i16; 4] = [1_234, -5_678, 32_000, -1];
        let pcm: Vec<u8> = expected_samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        *state.speech_pcm_chunks.lock().await = vec![
            pcm[..1].to_vec(),
            pcm[1..4].to_vec(),
            pcm[4..7].to_vec(),
            pcm[7..].to_vec(),
        ];
        state.speech_chunk_delay_ms.store(20, Ordering::SeqCst);
        let base_url = spawn_mock_voice_server(Arc::clone(&state)).await;
        let client = VoicePipelineClient::new(VoicePipelineConfig {
            stt_base_url: base_url.clone(),
            tts_base_url: base_url,
            ..VoicePipelineConfig::default()
        })
        .expect("create voice client");
        let cancel = CancellationToken::new();

        let text = client
            .transcribe_wav(b"RIFF", " \n\t ", &cancel)
            .await
            .expect("transcribe without prompt");
        assert_eq!(text.as_deref(), Some("Yes, that works."));
        {
            let captured = state.transcriptions.lock().await;
            assert_eq!(captured.len(), 1);
            assert_eq!(captured[0].prompt, None);
            assert_eq!(captured[0].file_bytes, b"RIFF");
            assert_eq!(captured[0].model.as_deref(), Some(DEFAULT_STT_MODEL));
        }

        let mut deliveries: Vec<Vec<i16>> = Vec::new();
        let sample_count = client
            .synthesize_speech_pcm24k("Thanks!", &cancel, |samples| {
                deliveries.push(samples.to_vec());
            })
            .await
            .expect("synthesize split PCM");
        assert_eq!(sample_count, expected_samples.len());
        assert!(deliveries.iter().all(|chunk| !chunk.is_empty()));
        assert_eq!(deliveries.concat(), expected_samples);
    }
}
