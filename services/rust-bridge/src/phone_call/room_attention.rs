#![forbid(unsafe_code)]

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "room_attention_tests.rs"]
pub(super) mod tests;

use super::audio::{mean_abs_pcm, RTP_FRAME_SAMPLES};
use std::time::{Duration, Instant};

const ACTIVE_FRAME_MIN_MEAN_ABS: u32 = 180;
const CALIBRATION_MIN_TURNS: usize = 2;
const CALIBRATION_MIN_PRIMARY_P90: u32 = 700;
const ACTIVE_REPLY_WINDOW: Duration = Duration::from_secs(8);
const QUESTION_REPLY_WINDOW: Duration = Duration::from_secs(12);
const IDLE_LULL_THRESHOLD: Duration = Duration::from_secs(12);
const SIDE_CONVO_COOLDOWN: Duration = Duration::from_secs(8);
const PRE_ASR_DISTANT_RATIO_PCT: u32 = 42;
const PRE_ASR_DISTANT_MAX_PEAK: u32 = 2_500;
const IDLE_DISTANT_RATIO_PCT: u32 = 55;
const PRECHECK_SUSPICIOUS_RATIO_PCT: u32 = 65;
const COOLDOWN_REENGAGE_RATIO_PCT: u32 = 75;
const COOLDOWN_REENGAGE_MIN_P90: u32 = 700;
const NEAR_FIELD_CALIBRATE_RATIO_PCT: u32 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AttentionDecision {
    DirectedAtAssistant,
    SideConversation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct UtteranceAcoustics {
    pub active_p50_mean: u32,
    pub active_p90_mean: u32,
    pub peak_abs: u32,
    pub active_frames: usize,
}

impl UtteranceAcoustics {
    #[must_use]
    pub(super) fn from_pcm_8k(samples_8k: &[i16]) -> Self {
        let mut active_means = Vec::new();
        let mut peak_abs: u32 = 0;
        for chunk in samples_8k.chunks_exact(RTP_FRAME_SAMPLES) {
            let mean = mean_abs_pcm(chunk);
            if mean >= ACTIVE_FRAME_MIN_MEAN_ABS {
                active_means.push(mean);
                for &sample in chunk {
                    peak_abs = peak_abs.max(u32::from(sample.unsigned_abs()));
                }
            }
        }
        if active_means.is_empty() {
            let mean = mean_abs_pcm(samples_8k);
            let peak = samples_8k
                .iter()
                .map(|sample| sample.unsigned_abs())
                .map(u32::from)
                .max()
                .unwrap_or(0);
            return Self {
                active_p50_mean: mean,
                active_p90_mean: mean,
                peak_abs: peak,
                active_frames: 0,
            };
        }
        active_means.sort_unstable();
        let len = active_means.len();
        let p50 = active_means[len / 2];
        let p90 = active_means[(len.saturating_mul(9)) / 10];
        Self {
            active_p50_mean: p50,
            active_p90_mean: p90,
            peak_abs,
            active_frames: len,
        }
    }
}

/// Tracks speaker loudness, acoustic proximity, word position, and temporal reference so Lily
/// ignores household side-chatter and far-field room speech while remaining responsive to the
/// primary caller.
#[derive(Debug, Clone)]
pub(super) struct RoomAttentionTracker {
    caller_aliases: Vec<String>,
    primary_speaker_p90: Option<u32>,
    calibrated_turns: usize,
    last_assistant_finished_at: Option<Instant>,
    last_assistant_asked_question: bool,
    last_directed_user_at: Option<Instant>,
    last_side_convo_at: Option<Instant>,
}

impl RoomAttentionTracker {
    #[must_use]
    pub(super) fn new(user_display_name: &str) -> Self {
        Self {
            caller_aliases: extract_caller_aliases(user_display_name),
            primary_speaker_p90: None,
            calibrated_turns: 0,
            last_assistant_finished_at: None,
            last_assistant_asked_question: false,
            last_directed_user_at: None,
            last_side_convo_at: None,
        }
    }

    pub(super) fn note_assistant_turn_finished(&mut self, spoken_text: &str, now: Instant) {
        let trimmed = spoken_text.trim();
        if trimmed.is_empty() {
            return;
        }
        self.last_assistant_finished_at = Some(now);
        self.last_assistant_asked_question = trimmed.ends_with('?');
    }

    pub(super) fn note_directed_user_turn(&mut self, acoustics: &UtteranceAcoustics, now: Instant) {
        self.last_directed_user_at = Some(now);
        self.last_side_convo_at = None;
        self.update_primary_baseline(acoustics);
    }

    /// Fast pre-ASR drop for unmistakable far-field quiet room chatter during an idle lull or
    /// active side-conversation cooldown once the primary speaker's near-field level is known.
    #[must_use]
    pub(super) fn should_drop_before_asr(
        &self,
        acoustics: &UtteranceAcoustics,
        now: Instant,
    ) -> bool {
        let Some(primary_p90) = self.calibrated_primary_p90() else {
            return false;
        };
        if !(self.is_idle_lull(now) || self.in_side_convo_cooldown(now)) {
            return false;
        }
        let ratio = relative_ratio_pct(acoustics.active_p90_mean, primary_p90);
        ratio < PRE_ASR_DISTANT_RATIO_PCT && acoustics.peak_abs < PRE_ASR_DISTANT_MAX_PEAK
    }

    /// Requests ASR pre-check on mid-length utterances (2-5 s) when acoustic loudness and timing
    /// suggest possible side-chatter or distant room speech.
    #[must_use]
    pub(super) fn should_precheck_for_side_talk(
        &self,
        acoustics: &UtteranceAcoustics,
        now: Instant,
    ) -> bool {
        if self.in_side_convo_cooldown(now) {
            return true;
        }
        if !self.is_idle_lull(now) {
            return false;
        }
        match self.calibrated_primary_p90() {
            Some(primary_p90) => {
                relative_ratio_pct(acoustics.active_p90_mean, primary_p90)
                    < PRECHECK_SUSPICIOUS_RATIO_PCT
            }
            None => false,
        }
    }

    /// Classifies a transcribed utterance using words, vocative position, relative volume, and
    /// temporal reference to Lily's last turn and any recent side conversation.
    pub(super) fn classify_transcribed_utterance(
        &mut self,
        text: &str,
        acoustics: &UtteranceAcoustics,
        now: Instant,
    ) -> AttentionDecision {
        let words = normalize_words(text);
        if words.is_empty() {
            return AttentionDecision::SideConversation;
        }
        if words.iter().any(|word| word == "lily") {
            self.note_directed_user_turn(acoustics, now);
            return AttentionDecision::DirectedAtAssistant;
        }
        if self.has_other_person_vocative_words(&words) {
            self.last_side_convo_at = Some(now);
            return AttentionDecision::SideConversation;
        }
        if self.is_quiet_during_cooldown(acoustics, now) {
            self.last_side_convo_at = Some(now);
            return AttentionDecision::SideConversation;
        }
        if self.is_distant_during_idle_lull(acoustics, now) {
            self.last_side_convo_at = Some(now);
            return AttentionDecision::SideConversation;
        }
        self.note_directed_user_turn(acoustics, now);
        AttentionDecision::DirectedAtAssistant
    }

    #[must_use]
    pub(super) fn is_other_person_address(&self, text: &str) -> bool {
        let words = normalize_words(text);
        !words.is_empty()
            && !words.iter().any(|word| word == "lily")
            && self.has_other_person_vocative_words(&words)
    }

    fn calibrated_primary_p90(&self) -> Option<u32> {
        if self.calibrated_turns < CALIBRATION_MIN_TURNS {
            return None;
        }
        self.primary_speaker_p90
            .filter(|&level| level >= CALIBRATION_MIN_PRIMARY_P90)
    }

    fn update_primary_baseline(&mut self, acoustics: &UtteranceAcoustics) {
        if acoustics.active_frames < 5 || acoustics.active_p90_mean < ACTIVE_FRAME_MIN_MEAN_ABS {
            return;
        }
        match self.primary_speaker_p90 {
            None => {
                self.primary_speaker_p90 = Some(acoustics.active_p90_mean);
                self.calibrated_turns = 1;
            }
            Some(prev) => {
                let ratio = relative_ratio_pct(acoustics.active_p90_mean, prev);
                if ratio >= NEAR_FIELD_CALIBRATE_RATIO_PCT
                    || self.calibrated_turns < CALIBRATION_MIN_TURNS
                {
                    let updated = (prev.saturating_mul(3) + acoustics.active_p90_mean) / 4;
                    self.primary_speaker_p90 = Some(updated);
                    self.calibrated_turns = self.calibrated_turns.saturating_add(1);
                }
            }
        }
    }

    fn is_in_active_reply_window(&self, now: Instant) -> bool {
        let window = if self.last_assistant_asked_question {
            QUESTION_REPLY_WINDOW
        } else {
            ACTIVE_REPLY_WINDOW
        };
        self.last_assistant_finished_at
            .is_some_and(|at| now.saturating_duration_since(at) <= window)
    }

    fn is_idle_lull(&self, now: Instant) -> bool {
        let idle_from_assistant = self
            .last_assistant_finished_at
            .is_some_and(|at| now.saturating_duration_since(at) > IDLE_LULL_THRESHOLD);
        let idle_from_user = self
            .last_directed_user_at
            .is_none_or(|at| now.saturating_duration_since(at) > IDLE_LULL_THRESHOLD);
        idle_from_assistant && idle_from_user
    }

    fn in_side_convo_cooldown(&self, now: Instant) -> bool {
        self.last_side_convo_at
            .is_some_and(|at| now.saturating_duration_since(at) <= SIDE_CONVO_COOLDOWN)
    }

    fn is_quiet_during_cooldown(&self, acoustics: &UtteranceAcoustics, now: Instant) -> bool {
        if !self.in_side_convo_cooldown(now) {
            return false;
        }
        let below_absolute = acoustics.active_p90_mean < COOLDOWN_REENGAGE_MIN_P90;
        let below_relative = self.calibrated_primary_p90().is_some_and(|primary_p90| {
            relative_ratio_pct(acoustics.active_p90_mean, primary_p90) < COOLDOWN_REENGAGE_RATIO_PCT
        });
        below_absolute || below_relative
    }

    fn is_distant_during_idle_lull(&self, acoustics: &UtteranceAcoustics, now: Instant) -> bool {
        if self.is_in_active_reply_window(now) || !self.is_idle_lull(now) {
            return false;
        }
        self.calibrated_primary_p90().is_some_and(|primary_p90| {
            relative_ratio_pct(acoustics.active_p90_mean, primary_p90) < IDLE_DISTANT_RATIO_PCT
        })
    }

    fn has_other_person_vocative_words(&self, words: &[String]) -> bool {
        if words.len() > 12 {
            return false;
        }
        const FAMILY_VOCATIVES: &[&str] = &["daddy", "mommy", "dad", "mom", "mama", "papa"];
        const NON_VOCATIVE_PREV: &[&str] = &[
            "my", "your", "our", "his", "her", "their", "a", "the", "for", "about", "with", "from",
            "to", "of", "like", "tell", "ask", "call", "im", "am", "is", "named", "called",
        ];
        words.iter().enumerate().any(|(idx, word)| {
            let is_family = FAMILY_VOCATIVES.contains(&word.as_str());
            let is_caller_boundary = (idx == 0 || idx + 1 == words.len())
                && self.caller_aliases.iter().any(|alias| alias == word);
            (is_family || is_caller_boundary)
                && idx
                    .checked_sub(1)
                    .and_then(|prev| words.get(prev))
                    .is_none_or(|prev| !NON_VOCATIVE_PREV.contains(&prev.as_str()))
        })
    }
}

fn relative_ratio_pct(value: u32, baseline: u32) -> u32 {
    if baseline == 0 {
        return 100;
    }
    value.saturating_mul(100) / baseline
}

fn normalize_words(text: &str) -> Vec<String> {
    text.chars()
        .filter(|ch| !matches!(*ch, '\'' | '’'))
        .map(|ch| {
            if ch.is_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

fn extract_caller_aliases(user_display_name: &str) -> Vec<String> {
    let Some(first) = normalize_words(user_display_name).into_iter().next() else {
        return Vec::new();
    };
    if first.len() < 3 || first == "local" || first == "user" || first == "lily" {
        return Vec::new();
    }
    let mut aliases = vec![first.clone()];
    if first == "david" {
        aliases.push("dave".to_string());
    }
    aliases
}
