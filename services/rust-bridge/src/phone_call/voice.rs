#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
use futures_util::StreamExt;
use reqwest::header::CONTENT_TYPE;
use reqwest::redirect::Policy;
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::net::IpAddr;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const DEFAULT_LOCAL_VOICE_BASE_URL: &str = "http://127.0.0.1:8000/v1";
pub const DEFAULT_STT_MODEL: &str = super::realtime::DEFAULT_LFM3_AUDIO_MODEL;
pub const DEFAULT_LLM_MODEL: &str = super::realtime::DEFAULT_LFM3_AUDIO_MODEL;
pub const DEFAULT_TTS_MODEL: &str = super::realtime::DEFAULT_LFM3_AUDIO_MODEL;
pub const DEFAULT_TTS_VOICE: &str = "female";
pub const DEFAULT_KEEP_ALIVE: &str = "15m";
pub const DEFAULT_STT_LANGUAGE: &str = "en";
pub const STT_PROMPT_MAX_BYTES: usize = 320;
pub const INTERRUPTED_MARKER: &str = "[interrupted]";
pub const LIVE_STEER_PREFIX: &str = "[Live instruction from user via mobile app]: ";

const CONNECT_TIMEOUT_SECS: u64 = 10;
const PRELOAD_REQUEST_TIMEOUT_SECS: u64 = 30;
const STT_REQUEST_TIMEOUT_SECS: u64 = 30;
const MIN_CLAUSE_SPLIT_CHARS: usize = 12;
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
            stt_base_url: DEFAULT_LOCAL_VOICE_BASE_URL.to_string(),
            stt_model: DEFAULT_STT_MODEL.to_string(),
            llm_base_url: DEFAULT_LOCAL_VOICE_BASE_URL.to_string(),
            llm_model: DEFAULT_LLM_MODEL.to_string(),
            tts_base_url: DEFAULT_LOCAL_VOICE_BASE_URL.to_string(),
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
                parsed.scheme(),
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
                "host '{host_raw}' is not loopback; expected 127.0.0.1, ::1, or localhost",
            ),
        });
    }

    let normalized_path = parsed.path().trim_end_matches('/').to_string();
    parsed.set_path(&normalized_path);
    Ok(parsed)
}

pub(super) fn is_loopback_base_url(url: &Url) -> bool {
    url.host_str().is_some_and(is_loopback_host)
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
    Event,
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
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
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
         You are CALLING the recipient on the caller's behalf; you do not work for the recipient. Messages labelled Recipient are what the other person said. Your replies answer them using the caller's objective and background. Never reverse these roles or ask for facts already supplied in the objective.\n\
         \n\
         CALLER-IDENTIFYING OPENING: Begin with who you are calling for and why using the actual call objective, for example: \"Hi, I'm calling for {caller_name} about <the actual call objective>.\" If Opening turn guidance is provided below, open naturally following that guidance and the actual objective rather than inventing a different reason for calling. For routine questions like \"Who's calling?\" or \"Who am I speaking with?\", answer \"I'm calling for {caller_name}\" with the actual purpose. Answer their question; do not ask for their name, turn the question back, or restart the greeting. These are not questions about automation: use no AI, automation, bot, or model labels. Do not volunteer those labels or use a stock \"automated assistant\" introduction. Never pretend to be {caller_name} or claim to be human. Only if directly asked whether you are human, AI, or automated, answer truthfully and briefly.\n\
         \n\
         RESPONSE: Return exactly one JSON object with speech, decision, digits, reason, on_hold, and outcome_summary. Only speech is spoken; reason is a brief private explanation of the action. For send_dtmf, digits must contain the literal menu symbols, such as \"1\", never \"one\"; for other decisions use digits=\"\". Set on_hold=true whenever asked to hold or wait for a person; false for ordinary listening. Use one or two short sentences, at most one question, contractions and plain language. No markdown, stage directions, tool syntax, fake hesitations, or invented human experiences. Never say you are \"following a script\", never repeat the call objective word-for-word, and never give robotic disclaimers like \"I don't have personal preferences or feelings\". In speech, write numbers, times and codes in spoken words: \"seven forty-five p m\", not \"7:45pm\"; \"October twenty-third\", not \"10/23\".\n\
         \n\
         FIRST decide whether the recipient can continue:\n\
         - If they explicitly ask to stop or hang up, cannot help further, refuse automation, or report a wrong number: apologize or acknowledge their situation, say goodbye without another question, and decision=end_call. For a wrong number or refusal, do not repeat or explain the business request; a short apology and goodbye is enough. Criticism or questions about your voice, tone, pacing, or latency are feedback, NOT a refusal to continue: apologize briefly, adjust, and keep talking with decision=wait_silently.\n\
         - If grieving and asking to leave: express sympathy, close gently, and decision=end_call. Do not discuss the objective or offer another conversation.\n\
         - If someone reports a medical emergency: tell them to contact local emergency services now, close, and decision=end_call. Never claim help was dispatched or delay them with booking questions.\n\
         - If there is a fire: give an urgent protective action and emergency-services referral in one sentence, for example \"Please get everyone outside and contact local emergency services now.\" Then decision=end_call. Do not advise going back inside.\n\
         - If voicemail invites a message: identify the caller and objective with supplied facts only, then close and decision=end_call. Never invent callback details.\n\
         - Otherwise continue. Acknowledge good news warmly (for example, \"Congratulations!\") AND answer the recipient's question from the objective. If rushed, give just the requested facts. If frustrated, apologize specifically and repair the misunderstanding. Never claim you know exactly how they feel.\n\
         \n\
         CONTINUING: Answer before pursuing the task. Keep corrections. Ask one focused clarification for unclear details; never guess. After {INTERRUPTED_MARKER}, unfinished words may not have been heard; do not repeat the introduction. Use speech=\"\" with decision=wait_silently and on_hold=false ONLY for unintelligible noise, empty audio, or trailing silence; never for a greeting (like \"Hello?\"), a question (like \"Why did you stop talking?\"), or any understandable sentence from the recipient. Whenever the recipient speaks understandable words and the call is not on hold, ALWAYS reply briefly in speech rather than staying silent. Unclear fragments are not success or refusal.\n\
         \n\
         AUTHORITY: Never invent confirmations, availability, payment details, or permission for fees or changed dates. If not authorized, explain briefly and ask the recipient to check alternatives; decision=wait_silently. Your lack of permission is not recipient refusal. End after explicit resolution or no further help, never while alternatives remain. For end_call, outcome_summary records only what happened and unresolved details; otherwise it is empty.\n\
         \n\
         PHONE ACTIONS: Ordinarily decision=wait_silently, on_hold=false after speaking. For IVR menus, decision=send_dtmf with digits (0-9, *, #, A-D). When asked to hold, acknowledge and choose wait_silently, on_hold=true. While held, stay silent through recordings, music and transfers; resume_call only when a live person addresses you or the mobile user explicitly requests speech. Reply next turn.\n\
         \n\
         LIVE STEERING: Honor any later system message prefixed with \"{LIVE_STEER_PREFIX}\" without breaking conversational flow.",
    );

    if let Some(callee) = params
        .callee_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
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
        .filter(|value| !value.is_empty())
    {
        prompt.push_str("\nOpening turn guidance: ");
        prompt.push_str(first_message);
    }

    if let Some(context) = params
        .context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
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
    require_spoken_reply: bool,
    caller_request: String,
    steer_revision: usize,
    pending_steers: Vec<(usize, String)>,
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
            require_spoken_reply: false,
            steer_revision: 0,
            pending_steers: Vec::new(),
            caller_request: format!(
                "Caller request: {}\nAuthorized background: {}",
                params.objective.trim(),
                params.context.as_deref().unwrap_or("").trim(),
            ),
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

    pub fn requires_spoken_reply(&self) -> bool {
        self.require_spoken_reply
    }

    pub fn set_require_spoken_reply(&mut self, required: bool) {
        self.require_spoken_reply = required;
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
        self.require_spoken_reply = false;
        self.messages.push(ChatMessage::user(trimmed));
        self.transcript.push(TranscriptEntry {
            speaker: TranscriptSpeaker::Callee,
            text: trimmed.to_string(),
            interrupted: false,
        });
    }

    pub fn record_assistant_turn(&mut self, turn: &AssistantTurnOutput) {
        let trimmed_text = turn.full_text.trim();
        if !trimmed_text.is_empty() {
            self.require_spoken_reply = false;
        }
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
        if self
            .messages
            .iter()
            .any(|message| message.tool_calls.iter().any(|call| call.id == id))
        {
            self.messages
                .push(ChatMessage::tool(id.to_string(), result_text.trim()));
        } else {
            self.messages.push(ChatMessage::system(format!(
                "Phone action result: {}",
                result_text.trim(),
            )));
        }
    }

    pub fn record_event(&mut self, description: &str) {
        let trimmed = description.trim();
        if trimmed.is_empty() {
            return;
        }
        self.transcript.push(TranscriptEntry {
            speaker: TranscriptSpeaker::Event,
            text: trimmed.to_string(),
            interrupted: false,
        });
    }

    pub fn inject_steer(&mut self, instruction: &str) {
        let trimmed = instruction.trim();
        if trimmed.is_empty() {
            return;
        }
        let formatted = format!("{LIVE_STEER_PREFIX}{trimmed}");
        self.steer_revision += 1;
        self.pending_steers
            .push((self.steer_revision, formatted.clone()));
        self.messages.push(ChatMessage::system(formatted));
        self.transcript.push(TranscriptEntry {
            speaker: TranscriptSpeaker::Steer,
            text: trimmed.to_string(),
            interrupted: false,
        });
    }

    pub fn steer_revision(&self) -> usize {
        self.steer_revision
    }

    pub fn has_pending_steers(&self) -> bool {
        !self.pending_steers.is_empty()
    }

    pub fn acknowledge_steers_through(&mut self, revision: usize) {
        self.pending_steers
            .retain(|(pending, _)| *pending > revision);
    }

    pub fn record_active_assistant_interrupted(&mut self, spoken_text: &str) {
        let text = interrupted_text(spoken_text);
        self.messages.push(ChatMessage::assistant(text.clone()));
        self.transcript.push(TranscriptEntry {
            speaker: TranscriptSpeaker::Assistant,
            text,
            interrupted: true,
        });
    }

    #[cfg(test)]
    pub fn mark_last_assistant_interrupted(&mut self, spoken_text: &str) {
        let truncated = interrupted_text(spoken_text);

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

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::excessive_nesting,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    fn build_request_messages(&self) -> Vec<ChatMessage> {
        let mut out = Vec::with_capacity(self.messages.len().saturating_add(2));
        let mut has_non_system = false;

        for (idx, msg) in self.messages.iter().enumerate() {
            if msg.role != MessageRole::System {
                has_non_system = true;
            }
            let mut request_message = msg.clone();
            if msg.role == MessageRole::User {
                request_message.content = msg
                    .content
                    .as_deref()
                    .map(|text| format!("Recipient: {text}"));
            }
            out.push(request_message);

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

fn interrupted_text(spoken_text: &str) -> String {
    let trimmed = spoken_text.trim();
    if trimmed.is_empty() {
        INTERRUPTED_MARKER.to_string()
    } else {
        format!("{trimmed} {INTERRUPTED_MARKER}")
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn find_clause_split_index(buffer: &str) -> Option<usize> {
    let leading_ws = buffer.len().saturating_sub(buffer.trim_start().len());
    let slice = &buffer[leading_ws..];
    if slice.is_empty() {
        return None;
    }

    let mut has_speakable = false;
    let mut indices = slice.char_indices();

    while let Some((rel_idx, ch)) = indices.next() {
        if ch.is_alphanumeric() {
            has_speakable = true;
        }

        let is_primary = matches!(ch, '.' | '?' | '!');
        if !has_speakable || !is_primary {
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

        if slice[..end_rel_idx].chars().count() < MIN_CLAUSE_SPLIT_CHARS {
            continue;
        }

        return Some(leading_ws.saturating_add(end_rel_idx));
    }

    None
}

fn is_closing_delimiter(ch: char) -> bool {
    matches!(ch, '"' | '\'' | '”' | '’' | ')')
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantTurnOutput {
    pub full_text: String,
    pub clauses: Vec<String>,
    pub tool_calls: Vec<VoiceToolCall>,
    pub raw_tool_calls: Vec<AssistantToolCallMessage>,
}

fn phone_turn_response_schema(can_end_call: bool, require_spoken_reply: bool) -> Value {
    let mut schema = voice_tool_definitions(can_end_call)[0]["function"]["parameters"].clone();
    if require_spoken_reply {
        if let Some(speech) = schema
            .get_mut("properties")
            .and_then(|props| props.get_mut("speech"))
            .and_then(Value::as_object_mut)
        {
            speech.insert("minLength".to_string(), json!(2));
        }
    }
    schema
}

#[must_use]
pub fn voice_tool_definitions(can_end_call: bool) -> Value {
    let mut decisions = vec!["wait_silently", "send_dtmf"];
    if can_end_call {
        decisions.push("end_call");
    }
    json!([
        {
            "type": "function",
            "function": {
                "name": "phone_turn",
                "description": "Speak an appropriate reply and choose what happens next. Listen after questions or exploring alternatives. End only after explicit resolution, recipient refusal, or farewell, never just because you cannot authorize a request.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "decision": {
                            "type": "string",
                            "enum": decisions,
                            "description": "wait_silently to listen, send_dtmf for an IVR menu, end_call only after a spoken closing and explicit recipient resolution or refusal. While held, resume_call only when a live person addresses you again."
                        },
                        "speech": {
                            "type": "string",
                            "description": "Words the recipient should hear, including caller and purpose on the opening turn. Always empty while on hold or resuming a held call. Otherwise, whenever the recipient speaks understandable words, a greeting, or a question, reply briefly in speech rather than leaving speech empty. Acknowledge distress or frustration sincerely before closing; do not use a generic cheerful goodbye."
                        },
                        "digits": {
                            "type": "string",
                            "description": "DTMF symbols for send_dtmf (0-9, *, #, A-D), otherwise empty."
                        },
                        "reason": {
                            "type": "string",
                            "description": "Very short 2-5 word private note for the chosen action."
                        },
                        "on_hold": {
                            "type": "boolean",
                            "description": "True only when asked to hold or wait for a person; false for ordinary listening, incomplete sentences, or IVR menus."
                        },
                        "outcome_summary": {
                            "type": "string",
                            "description": "For end_call, summarize only what actually happened and any unresolved details. Otherwise empty."
                        }
                    },
                    "required": ["decision", "speech", "digits", "reason", "on_hold", "outcome_summary"],
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

    #[must_use]
    pub fn is_realtime_s2s(&self) -> bool {
        self.is_realtime_s2s_in(&super::realtime::registry::RealtimeStrategyRegistry::default())
    }

    #[must_use]
    pub(crate) fn is_realtime_s2s_in(
        &self,
        registry: &super::realtime::registry::RealtimeStrategyRegistry,
    ) -> bool {
        registry.resolve_for_client(self).is_some()
    }

    #[must_use]
    pub fn llm_base_url(&self) -> &Url {
        &self.endpoints.llm_base
    }

    #[must_use]
    pub fn tts_base_url(&self) -> &Url {
        &self.endpoints.tts_base
    }

    #[must_use]
    pub fn llm_model(&self) -> &str {
        self.config.llm_model.trim()
    }

    #[must_use]
    pub fn http_client(&self) -> &reqwest::Client {
        &self.http
    }

    pub async fn preload_models(&self, cancel: &CancellationToken) -> Result<(), VoiceError> {
        self.preload_models_with_registry(
            &super::realtime::registry::RealtimeStrategyRegistry::default(),
            cancel,
        )
        .await
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(crate) async fn preload_models_with_registry(
        &self,
        registry: &super::realtime::registry::RealtimeStrategyRegistry,
        cancel: &CancellationToken,
    ) -> Result<(), VoiceError> {
        if cancel.is_cancelled() {
            return Err(VoiceError::Cancelled);
        }
        if let Some(strategy) = registry.resolve_for_client(self) {
            return strategy.check_readiness(self, cancel).await;
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

        let mut preloads: Vec<((String, String), bool)> = Vec::with_capacity(candidates.len());
        for (index, (url, model)) in candidates.into_iter().enumerate() {
            let key = (url.as_str().to_string(), model.to_string());
            let prepared = match preloads.iter().find(|(cached_key, _)| cached_key == &key) {
                Some((_, prepared)) => *prepared,
                None => {
                    let prepared = self.preload_single_model(&url, model, cancel).await?;
                    preloads.push((key, prepared));
                    prepared
                }
            };
            if index == 0 && !prepared {
                let samples = vec![
                    0;
                    usize::try_from(super::audio::TELEPHONY_SAMPLE_RATE_HZ)
                        .expect("8 kHz sample rate fits usize")
                ];
                let wav = super::audio::encode_wav_8k_mono(&samples);
                if self.transcribe_wav(&wav, "", cancel).await?.is_some() {
                    eprintln!("Voice recognition warm-up produced text for synthetic silence; it was not added to the call");
                }
            } else if index == 1 && !prepared {
                let probe = VoiceConversation::new(VoiceCallPromptParams {
                    user_display_name: "the user".to_string(),
                    callee_name: None,
                    objective: "Check that the dialogue service is ready. Stay silent and choose wait_silently.".to_string(),
                    first_message: Some("Stay silent and choose wait_silently.".to_string()),
                    context: None,
                });
                tokio::time::timeout(
                    Duration::from_secs(PRELOAD_REQUEST_TIMEOUT_SECS),
                    self.stream_assistant_turn(&probe, cancel, |_| {}),
                )
                .await
                .map_err(|_| VoiceError::InvalidResponse {
                    endpoint: append_endpoint_path(&self.endpoints.llm_base, "chat/completions")
                        .to_string(),
                    reason: "dialogue warm-up did not complete before its deadline".to_string(),
                })??;
            } else if index == 2 && !prepared {
                tokio::time::timeout(
                    Duration::from_secs(PRELOAD_REQUEST_TIMEOUT_SECS),
                    self.synthesize_speech_pcm24k("Ready.", cancel, |_| {}),
                )
                .await
                .map_err(|_| VoiceError::InvalidResponse {
                    endpoint: append_endpoint_path(&self.endpoints.tts_base, "audio/speech")
                        .to_string(),
                    reason: "speech warm-up did not complete before its deadline".to_string(),
                })??;
            }
        }

        Ok(())
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn preload_single_model(
        &self,
        api_chat_url: &Url,
        model: &str,
        cancel: &CancellationToken,
    ) -> Result<bool, VoiceError> {
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
        if status.is_success() {
            let mut body = response.bytes_stream();
            loop {
                let chunk = tokio::select! {
                    biased;
                    () = cancel.cancelled() => return Err(VoiceError::Cancelled),
                    chunk = body.next() => chunk,
                };
                let Some(chunk) = chunk else { break };
                chunk.map_err(|source| VoiceError::Transport {
                    endpoint: api_chat_url.to_string(),
                    source,
                })?;
            }
            return Ok(true);
        }
        if matches!(
            status,
            StatusCode::BAD_REQUEST
                | StatusCode::NOT_FOUND
                | StatusCode::METHOD_NOT_ALLOWED
                | StatusCode::UNPROCESSABLE_ENTITY
                | StatusCode::NOT_IMPLEMENTED,
        ) {
            return Ok(false);
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

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
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

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::excessive_nesting,
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub async fn stream_assistant_turn<OnClause>(
        &self,
        conversation: &VoiceConversation,
        cancel: &CancellationToken,
        mut on_clause: OnClause,
    ) -> Result<AssistantTurnOutput, VoiceError>
    where
        OnClause: FnMut(String) + Send,
    {
        if cancel.is_cancelled() {
            return Err(VoiceError::Cancelled);
        }

        let endpoint = append_endpoint_path(&self.endpoints.llm_base, "chat/completions");
        let mut request_messages = conversation.build_request_messages();
        let held = conversation.is_on_hold();
        if held {
            let latest_recipient = conversation
                .messages
                .iter()
                .rev()
                .find(|message| message.role == MessageRole::User)
                .and_then(|message| message.content.as_deref())
                .unwrap_or("There is no new recipient speech. Continue waiting.");
            let mut latest_input = format!("Recipient: {latest_recipient}");
            for (_, steer) in &conversation.pending_steers {
                latest_input.push_str("\nPrivate instruction (not recipient speech): ");
                latest_input.push_str(steer);
            }
            request_messages = vec![
                ChatMessage::system(
                    "Classify the latest recipient speech and pending private live instructions for a phone call that is ON HOLD. Return only JSON with one key, decision. Choose wait_silently for silence, music, recorded queue announcements, or requests to keep waiting. Choose resume_call when a live person directly addresses you again, including asking if you are still there. A private live instruction from the user via the mobile app may explicitly request speech; that also permits resume_call even alongside a queue announcement. Apply private instructions oldest to newest; the latest conflicting instruction takes priority. Do not carry out the call objective, write a spoken reply, or add other JSON fields.",
                ),
                ChatMessage::user(latest_input),
            ];
        } else {
            request_messages.push(ChatMessage::system(format!(
                "You are the caller's representative, not the recipient's employee.\n{}\nFor this reply, address the latest recipient message as a whole: briefly acknowledge any news or problem they shared, then answer their question from the caller request above, never ask them to supply those same facts. If the recipient spoke understandable words, a greeting, or a question, reply briefly in speech instead of returning empty speech. Use later corrections or live instructions if the request changed. If they explicitly ask to stop or cannot continue, close kindly and choose end_call; if they offer to check alternatives, keep listening. Return the complete phone_turn JSON, including outcome_summary.",
                conversation.caller_request,
            )));
        }
        let payload = ChatCompletionStreamRequest {
            model: self.config.llm_model.trim(),
            messages: &request_messages,
            stream: true,
            reasoning_effort: if self.config.llm_model.trim().starts_with("gpt-oss:") {
                "low"
            } else {
                "none"
            },
            temperature: 0.3,
            response_format: Some(if held {
                json!({
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
                })
            } else {
                json!({
                    "type": "json_schema",
                    "json_schema": {
                        "name": "phone_turn",
                        "strict": true,
                        "schema": phone_turn_response_schema(
                            conversation.can_end_call(),
                            conversation.requires_spoken_reply(),
                        )
                    }
                })
            }),
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
        let mut structured_response = false;
        // Content cannot be spoken until we know whether native tool speech supersedes it.
        let mut emit_clause = |_| {};

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
            structured_response = true;
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
        } else if !held && tool_accumulators.is_empty() {
            structured_response = true;
            let _: PhoneTurnArgs =
                serde_json::from_str(&full_text).map_err(|err| VoiceError::InvalidResponse {
                    endpoint: endpoint.to_string(),
                    reason: format!("invalid structured phone turn: {err}"),
                })?;
            tool_accumulators.insert(
                0,
                ToolCallAccumulator {
                    id: format!("turn_{}", Uuid::new_v4()),
                    name: "phone_turn".to_string(),
                    arguments: std::mem::take(&mut full_text),
                },
            );
            clauses.clear();
        }
        let (tool_calls, mut raw_tool_calls) = finalize_tool_calls(tool_accumulators)?;
        let native_turn = raw_tool_calls
            .iter()
            .any(|call| call.function.name == "phone_turn");
        if !held
            && !native_turn
            && !raw_tool_calls.is_empty()
            && full_text.trim_start().starts_with(['{', '['])
        {
            return Err(VoiceError::InvalidResponse {
                endpoint: endpoint.to_string(),
                reason: "structured content cannot be combined with legacy phone actions"
                    .to_string(),
            });
        }
        if native_turn && raw_tool_calls.len() != 1 {
            return Err(VoiceError::InvalidToolCall {
                tool_name: "phone_turn".to_string(),
                reason: "a native phone turn must contain exactly one action".to_string(),
            });
        }
        if held {
            full_text.clear();
            clauses.clear();
        } else if native_turn || full_text.trim().is_empty() {
            if native_turn && !full_text.trim().is_empty() {
                eprintln!("Voice model returned competing assistant content; using native phone turn speech");
            }
            full_text.clear();
            clauses.clear();
            chunker = ClauseChunker::new();
            for call in &raw_tool_calls {
                let args: SpokenToolArgs =
                    serde_json::from_str(&call.function.arguments).map_err(|err| {
                        VoiceError::InvalidToolCall {
                            tool_name: call.function.name.clone(),
                            reason: format!("invalid speech argument: {err}"),
                        }
                    })?;
                if let Some(speech) = args.speech.filter(|speech| !speech.trim().is_empty()) {
                    if !full_text.is_empty() {
                        full_text.push(' ');
                    }
                    full_text.push_str(speech.trim());
                }
            }
            for clause in chunker.push_str(&full_text) {
                clauses.push(clause);
            }
            if let Some(clause) = chunker.finish() {
                clauses.push(clause);
            }
        }
        if structured_response {
            raw_tool_calls.clear();
        }
        if tool_calls
            .iter()
            .any(|tool| matches!(tool, VoiceToolCall::EndCall { .. }))
            && !full_text.trim().is_empty()
            && clauses.is_empty()
        {
            return Err(VoiceError::InvalidToolCall {
                tool_name: "end_call".to_string(),
                reason: "a closing requires speakable words, not just punctuation".to_string(),
            });
        }
        for clause in &clauses {
            if cancel.is_cancelled() {
                return Err(VoiceError::Cancelled);
            }
            on_clause(clause.clone());
        }
        if cancel.is_cancelled() {
            return Err(VoiceError::Cancelled);
        }

        Ok(AssistantTurnOutput {
            full_text,
            clauses,
            tool_calls,
            raw_tool_calls,
        })
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub async fn synthesize_speech_pcm24k<OnSamples>(
        &self,
        clause: &str,
        cancel: &CancellationToken,
        mut on_samples: OnSamples,
    ) -> Result<usize, VoiceError>
    where
        OnSamples: FnMut(&[i16]) + Send,
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
        let mut has_nonzero_sample = false;

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
                has_nonzero_sample |= samples_buf.iter().any(|&sample| sample != 0);
                on_samples(&samples_buf);
            }
        }

        if total_samples == 0 || carry_byte.is_some() {
            return Err(VoiceError::InvalidResponse {
                endpoint: endpoint.to_string(),
                reason: "speech response contained empty or incomplete 16-bit PCM".to_string(),
            });
        }
        if !has_nonzero_sample {
            return Err(VoiceError::InvalidResponse {
                endpoint: endpoint.to_string(),
                reason: "speech response contained only silent PCM".to_string(),
            });
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
    temperature: f32,
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
#[serde(deny_unknown_fields)]
struct PhoneTurnArgs {
    decision: PhoneTurnAction,
    speech: String,
    digits: String,
    #[serde(default)]
    reason: String,
    on_hold: bool,
    outcome_summary: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PhoneTurnAction {
    WaitSilently,
    SendDtmf,
    EndCall,
    ResumeCall,
}

#[derive(Debug, Deserialize)]
struct SpokenToolArgs {
    #[serde(default)]
    speech: Option<String>,
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        perfectionist::overly_long_function,
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn process_sse_line<OnClause>(
    line_bytes: &[u8],
    endpoint: &Url,
    full_text: &mut String,
    chunker: &mut ClauseChunker,
    clauses: &mut Vec<String>,
    tool_accumulators: &mut BTreeMap<usize, ToolCallAccumulator>,
    on_clause: &mut OnClause,
) -> Result<bool, VoiceError>
where
    OnClause: FnMut(String),
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
            if let Some(id) = tc_delta.id.filter(|value| !value.is_empty()) {
                if entry.id.is_empty() {
                    entry.id = id;
                } else {
                    entry.id.push_str(&id);
                }
            }
            if let Some(func) = tc_delta.function {
                if let Some(name) = func.name.filter(|value| !value.is_empty()) {
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn parse_single_tool_call(
    call_id: &str,
    tool_name: &str,
    raw_arguments: &str,
) -> Result<VoiceToolCall, VoiceError> {
    match tool_name {
        "phone_turn" => {
            let args: PhoneTurnArgs =
                serde_json::from_str(raw_arguments).map_err(|err| VoiceError::InvalidToolCall {
                    tool_name: tool_name.to_string(),
                    reason: format!("invalid phone turn arguments: {err}"),
                })?;
            let (action, arguments) = match args.decision {
                PhoneTurnAction::WaitSilently => (
                    "wait_silently",
                    json!({"reason": args.reason, "on_hold": args.on_hold}),
                ),
                PhoneTurnAction::SendDtmf => ("send_dtmf", json!({"digits": args.digits})),
                PhoneTurnAction::EndCall => {
                    if args.speech.trim().is_empty() || args.outcome_summary.trim().is_empty() {
                        return Err(VoiceError::InvalidToolCall {
                            tool_name: tool_name.to_string(),
                            reason: "end_call requires a spoken closing and an outcome summary"
                                .to_string(),
                        });
                    }
                    (
                        "end_call",
                        json!({"reason": args.reason, "outcome_summary": args.outcome_summary}),
                    )
                }
                PhoneTurnAction::ResumeCall => ("resume_call", json!({})),
            };
            parse_single_tool_call(call_id, action, &arguments.to_string())
        }
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
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            let summary = args
                .outcome_summary
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
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
                .filter(|value| !value.is_empty())
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
    append_multipart_text_field(&mut body, &boundary, "response_format", "json");
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

const STT_META_HALLUCINATION_PREFIXES: &[&str] = &[
    "follow these specific instructions",
    "please follow these specific instructions",
    "transcribe the audio",
    "transcribe the following audio",
    "please transcribe the audio",
    "please transcribe the following audio",
    "here is the transcription",
    "here's the transcription",
    "the transcription is",
    "audio transcription",
    "there is no speech in",
    "the audio contains no speech",
    "the audio is silent",
    "no speech detected",
    "no speech was detected",
    "i cannot hear any speech",
    "unable to transcribe",
    "please provide the audio",
    "as an ai",
    "i am an ai language model",
];

const STT_META_HALLUCINATION_SUBSTRINGS: &[&str] = &[
    "specific instructions for formatting the answer",
    "no speech in the audio",
    "transcribe the audio verbatim",
];

pub(super) fn clean_transcription_text(raw: &str) -> Option<String> {
    let without_brackets = strip_non_speech_annotations(raw);
    let collapsed = collapse_whitespace(&without_brackets);
    if !contains_speakable_char(&collapsed)
        || is_stt_meta_hallucination(&collapsed)
        || is_repetitive_stt_hallucination(&collapsed)
    {
        return None;
    }
    Some(collapsed)
}

fn is_repetitive_stt_hallucination(text: &str) -> bool {
    let mut prev: Option<String> = None;
    let mut run = 0usize;
    let mut total = 0usize;
    for raw in text.split_whitespace() {
        let token = raw
            .trim_matches(|ch: char| !ch.is_alphanumeric())
            .to_ascii_lowercase();
        if token.is_empty() {
            continue;
        }
        total += 1;
        if prev.as_deref() == Some(token.as_str()) {
            run += 1;
            if run >= 4 {
                return true;
            }
        } else {
            prev = Some(token);
            run = 1;
        }
    }
    total >= 4 && run >= 4
}

fn is_stt_meta_hallucination(text: &str) -> bool {
    let normalized = text
        .trim_matches(|ch: char| !ch.is_alphanumeric())
        .to_ascii_lowercase()
        .replace('’', "'");
    let matches_prefix = STT_META_HALLUCINATION_PREFIXES.iter().any(|prefix| {
        normalized == *prefix
            || normalized
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with(|ch: char| !ch.is_alphanumeric()))
    });
    matches_prefix
        || STT_META_HALLUCINATION_SUBSTRINGS
            .iter()
            .any(|phrase| normalized.contains(phrase))
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
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

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
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
#[path = "voice_tests.rs"]
mod tests;
