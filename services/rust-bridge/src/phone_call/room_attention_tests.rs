use super::{AttentionDecision, RoomAttentionTracker, UtteranceAcoustics};
use crate::phone_call::audio::RTP_FRAME_SAMPLES;
use std::time::{Duration, Instant};

fn synthetic_pcm(amplitude: i16, frames: usize) -> Vec<i16> {
    vec![amplitude; frames * RTP_FRAME_SAMPLES]
}

#[test]
fn acoustics_extracts_active_percentiles_and_peak() {
    let mut samples = synthetic_pcm(0, 10);
    samples.extend(synthetic_pcm(600, 10));
    samples.extend(synthetic_pcm(1_400, 10));
    let acoustics = UtteranceAcoustics::from_pcm_8k(&samples);
    assert_eq!(acoustics.active_frames, 20);
    assert_eq!(acoustics.active_p90_mean, 1_400);
    assert_eq!(acoustics.peak_abs, 1_400);
}

#[test]
fn temporal_reference_and_volume_distinguish_quiet_reply_from_distant_idle_chatter() {
    let mut tracker = RoomAttentionTracker::new("David Parks");
    let t0 = Instant::now();
    let near_loud = UtteranceAcoustics::from_pcm_8k(&synthetic_pcm(1_400, 20));
    let quiet_speech = UtteranceAcoustics::from_pcm_8k(&synthetic_pcm(500, 20));
    let far_quiet = UtteranceAcoustics::from_pcm_8k(&synthetic_pcm(400, 20));

    // Calibrate primary near-field speaker over two turns.
    assert_eq!(
        tracker.classify_transcribed_utterance("Tell me about Minecraft.", &near_loud, t0),
        AttentionDecision::DirectedAtAssistant,
    );
    tracker.note_assistant_turn_finished("Sure, what about it?", t0 + Duration::from_secs(3));
    assert_eq!(
        tracker.classify_transcribed_utterance(
            "How many end cities are there?",
            &near_loud,
            t0 + Duration::from_secs(5),
        ),
        AttentionDecision::DirectedAtAssistant,
    );
    tracker.note_assistant_turn_finished(
        "They spawn across the outer islands.",
        t0 + Duration::from_secs(9),
    );

    // Same quiet voice 3 seconds after Lily spoke is temporally anchored to her turn -> ACCEPTED.
    assert_eq!(
        tracker.classify_transcribed_utterance(
            "Well then look harder.",
            &quiet_speech,
            t0 + Duration::from_secs(12),
        ),
        AttentionDecision::DirectedAtAssistant,
    );
    tracker.note_assistant_turn_finished("Okay, checking again.", t0 + Duration::from_secs(15));

    // Same quiet voice 20 seconds later during an idle lull -> distant room chatter -> IGNORED.
    let idle_t = t0 + Duration::from_secs(35);
    assert!(tracker.should_drop_before_asr(&far_quiet, idle_t));
    assert!(tracker.should_precheck_for_side_talk(&quiet_speech, idle_t));
    assert_eq!(
        tracker.classify_transcribed_utterance("Honey practices?", &quiet_speech, idle_t),
        AttentionDecision::SideConversation,
    );

    // Speaking at near-field volume or addressing Lily directly re-engages immediately.
    assert_eq!(
        tracker.classify_transcribed_utterance(
            "Lily, what's the weather?",
            &quiet_speech,
            idle_t + Duration::from_secs(2),
        ),
        AttentionDecision::DirectedAtAssistant,
    );
}

#[test]
fn vocative_position_caller_name_and_cooldown_filter_side_conversations() {
    let mut tracker = RoomAttentionTracker::new("David Parks");
    let t0 = Instant::now();
    let near_loud = UtteranceAcoustics::from_pcm_8k(&synthetic_pcm(1_400, 20));
    let medium_side = UtteranceAcoustics::from_pcm_8k(&synthetic_pcm(650, 20));

    // Calibrate primary speaker.
    tracker.note_directed_user_turn(&near_loud, t0);
    tracker.note_directed_user_turn(&near_loud, t0 + Duration::from_secs(2));

    // Household side talk addressing family or the human caller by name at boundary position.
    for side in [
        "I love you, daddy.",
        "Bye, daddy!",
        "Mommy, look at this!",
        "What do you want for dinner, Dave?",
        "David, come look at this.",
    ] {
        assert_eq!(
            tracker.classify_transcribed_utterance(side, &near_loud, t0 + Duration::from_secs(5)),
            AttentionDecision::SideConversation,
            "expected side conversation for {side:?}",
        );
    }

    // During the 8s side-conversation cooldown, quieter follow-up chatter without "Lily" is
    // also suppressed, while loud near-field speech breaks back into the call.
    assert_eq!(
        tracker.classify_transcribed_utterance(
            "Do you want dinner?",
            &medium_side,
            t0 + Duration::from_secs(7),
        ),
        AttentionDecision::SideConversation,
    );
    assert_eq!(
        tracker.classify_transcribed_utterance(
            "You choose what we have for dinner.",
            &near_loud,
            t0 + Duration::from_secs(8),
        ),
        AttentionDecision::DirectedAtAssistant,
    );

    // Possessive/non-vocative mentions and explicit "Lily" address remain directed at Lily.
    for directed in [
        "What's a good gift for my dad?",
        "My mom makes great soup.",
        "Can you call mom for me?",
        "Hi, I'm David.",
        "Lily, say hi to daddy.",
    ] {
        assert_eq!(
            tracker.classify_transcribed_utterance(
                directed,
                &near_loud,
                t0 + Duration::from_secs(20),
            ),
            AttentionDecision::DirectedAtAssistant,
            "must not filter speech directed at Lily: {directed:?}",
        );
    }
}
