#![forbid(unsafe_code)]

use super::state::RealtimeLoopState;
use crate::phone_call::room_attention::RoomAttentionTracker;
use crate::phone_call::voice::AssistantTurnOutput;
use crate::phone_call::{
    publish_in_call_card_update, sync_shared_transcript, ConnectedCallContext, PendingCallEnd,
    END_CALL_QUIET_GRACE,
};
use std::time::Instant;

pub(super) async fn record_cancelled_speech(
    ctx: &ConnectedCallContext,
    state: &mut RealtimeLoopState,
    spoken_text: &str,
) {
    if spoken_text.is_empty() {
        return;
    }
    let now = Instant::now();
    state
        .audio
        .echo_tracker
        .record_assistant_speech(spoken_text, now);
    state
        .dialog
        .attention
        .note_assistant_turn_finished(spoken_text, now);
    state
        .dialog
        .conversation
        .record_active_assistant_interrupted(spoken_text);
    sync_shared_transcript(&ctx.slot, state.dialog.conversation.transcript());
    publish_in_call_card_update(ctx, state.dialog.conversation.transcript()).await;
}

pub(super) async fn record_completed_speech(
    ctx: &ConnectedCallContext,
    state: &mut RealtimeLoopState,
    spoken_text: &str,
) {
    if spoken_text.is_empty() {
        return;
    }
    let now = Instant::now();
    state
        .audio
        .echo_tracker
        .note_completed_speech(spoken_text, now);
    state
        .dialog
        .attention
        .note_assistant_turn_finished(spoken_text, now);
    state
        .dialog
        .conversation
        .record_assistant_turn(&AssistantTurnOutput {
            full_text: spoken_text.to_string(),
            clauses: vec![spoken_text.to_string()],
            tool_calls: Vec::new(),
            raw_tool_calls: Vec::new(),
        });
    sync_shared_transcript(&ctx.slot, state.dialog.conversation.transcript());
    publish_in_call_card_update(ctx, state.dialog.conversation.transcript()).await;
    if let Some(end) = &mut state.pending_end {
        end.deadline = tokio::time::Instant::now() + END_CALL_QUIET_GRACE;
    }
}

pub(super) fn maybe_arm_mutual_farewell(
    state: &mut RealtimeLoopState,
    had_tools: bool,
    spoken_text: &str,
) {
    if had_tools || state.pending_end.is_some() {
        return;
    }
    let last_callee = state.dialog.last_callee_text.as_deref();
    if last_callee.is_some_and(|text| state.dialog.attention.is_other_person_address(text)) {
        return;
    }
    if is_mutual_farewell(last_callee, spoken_text) {
        state.pending_end = Some(PendingCallEnd {
            reason: "callee_goodbye".to_string(),
            summary: "Recipient said goodbye and the call wrapped up.".to_string(),
            deadline: tokio::time::Instant::now() + END_CALL_QUIET_GRACE,
        });
    }
}

#[must_use]
pub fn is_mutual_farewell(callee_text: Option<&str>, assistant_text: &str) -> bool {
    let Some(callee) = callee_text else {
        return false;
    };
    !RoomAttentionTracker::new("").is_other_person_address(callee)
        && is_explicit_farewell(callee)
        && is_assistant_farewell(assistant_text)
}

fn is_explicit_farewell(text: &str) -> bool {
    let normalized = normalize_farewell_text(text);
    let words: Vec<&str> = normalized.split_whitespace().collect();
    if words.is_empty() || words.len() > 8 {
        return false;
    }
    const PHRASES: &[&str] = &[
        "goodbye",
        "good bye",
        "bye",
        "bye bye",
        "see ya",
        "see you later",
        "hang up",
        "end the call",
        "end call",
        "gotta go",
    ];
    PHRASES.iter().any(|phrase| {
        normalized == *phrase
            || normalized.ends_with(&format!(" {phrase}"))
            || normalized.starts_with(&format!("{phrase} "))
    })
}

fn is_assistant_farewell(text: &str) -> bool {
    let normalized = normalize_farewell_text(text);
    const PHRASES: &[&str] = &[
        "goodbye",
        "good bye",
        "bye",
        "have a great day",
        "have a good day",
        "have a nice day",
        "talk to you later",
        "take care",
    ];
    PHRASES.iter().any(|phrase| normalized.contains(phrase))
}

fn normalize_farewell_text(text: &str) -> String {
    text.chars()
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
        .join(" ")
}
