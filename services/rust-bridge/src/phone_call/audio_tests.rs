use super::{
    build_rfc4733_digit_packets, decode_mulaw, decode_mulaw_frame, dtmf_frequencies_hz,
    encode_mulaw, encode_mulaw_frame_with_headroom, encode_mulaw_with_headroom, encode_wav_8k_mono,
    mean_abs_pcm, mulaw_frame_mean_abs, parse_dtmf_digit, phase_step_for_hz, saturate_i32_to_i16,
    sin_q15_from_phase, synthesize_inband_dtmf_mulaw, Downsampler24kTo8k, Rfc4733DtmfPacket,
    TelephonyVad, VadEvent, DTMF_INTER_DIGIT_SILENCE_FRAMES, DTMF_TONE_FRAMES, FIR_24K_TO_8K_Q15,
    MULAW_SILENCE, RFC4733_DEFAULT_HOLD_PACKETS, RFC4733_DEFAULT_VOLUME, RFC4733_END_FLAG,
    RFC4733_END_RETRANSMIT_COUNT, RTP_FRAME_SAMPLES, TELEPHONY_SAMPLE_RATE_HZ,
    VAD_BARGE_IN_ONSET_FRAMES, VAD_DEFAULT_HANGOVER_FRAMES, VAD_ECHO_MARGIN,
    VAD_INITIAL_NOISE_FLOOR, VAD_IVR_HANGOVER_FRAMES, VAD_MAX_UTTERANCE_SAMPLES,
    VAD_PREROLL_FRAMES, VAD_SPEECH_ONSET_FRAMES, WAV_HEADER_BYTES,
};

const TTS_PCM_SAMPLE_RATE_HZ: u32 = 24_000;
const RTP_FRAME_DURATION_MS: u32 = 20;
const VAD_PREROLL_SAMPLES: usize = VAD_PREROLL_FRAMES * RTP_FRAME_SAMPLES;

pub(in crate::phone_call) fn encode_mulaw_frame(
    input: &[i16; RTP_FRAME_SAMPLES],
) -> [u8; RTP_FRAME_SAMPLES] {
    let mut out = [MULAW_SILENCE; RTP_FRAME_SAMPLES];
    for (dst, &src) in out.iter_mut().zip(input.iter()) {
        *dst = encode_mulaw(src);
    }
    out
}

fn generate_sine_pcm(
    freq_hz: u32,
    sample_rate_hz: u32,
    amplitude: i16,
    num_samples: usize,
) -> Vec<i16> {
    let step = phase_step_for_hz(freq_hz, sample_rate_hz);
    let mut phase: u32 = 0;
    let mut out = Vec::with_capacity(num_samples);
    for _ in 0..num_samples {
        let sample = (i32::from(sin_q15_from_phase(phase)) * i32::from(amplitude)) / 32_767;
        out.push(saturate_i32_to_i16(sample));
        phase = phase.wrapping_add(step);
    }
    out
}

#[test]
fn mulaw_silence_symmetry_and_bijective_codewords() {
    assert_eq!(decode_mulaw(MULAW_SILENCE), 0);
    assert_eq!(decode_mulaw(0x7F), 0);
    assert_eq!(encode_mulaw(0), MULAW_SILENCE);
    assert_eq!(encode_mulaw_with_headroom(0), MULAW_SILENCE);

    // Every canonical mu-law codeword (all 255 except negative-zero 0x7F) must round-trip bit-exact.
    for byte in 0_u8..=u8::MAX {
        let decoded = decode_mulaw(byte);
        let reencoded = encode_mulaw(decoded);
        if byte == 0x7F {
            assert_eq!(decoded, 0);
            assert_eq!(reencoded, MULAW_SILENCE);
        } else {
            assert_eq!(
                reencoded, byte,
                "failed round-trip for codeword {byte:#04X}",
            );
        }
    }

    // Odd symmetry: decode(~sign_flipped) == -decode(byte)
    for mag_bits in 0_u8..128_u8 {
        let pos_code = !mag_bits;
        let neg_code = !(mag_bits | 0x80);
        assert_eq!(decode_mulaw(neg_code), -decode_mulaw(pos_code));
    }
}

#[test]
fn mulaw_saturation_and_headroom_prevent_full_scale_clipping() {
    assert_eq!(encode_mulaw(i16::MAX), 0x80);
    assert_eq!(encode_mulaw(i16::MIN), 0x00);
    assert_eq!(decode_mulaw(0x80), 32_124);
    assert_eq!(decode_mulaw(0x00), -32_124);

    // Hot full-scale TTS PCM (+/-32767) scaled with headroom must land around -12 dBFS (~8191),
    // well below the 32124 mu-law saturation ceiling.
    let pos_headroom = decode_mulaw(encode_mulaw_with_headroom(i16::MAX));
    let neg_headroom = decode_mulaw(encode_mulaw_with_headroom(-i16::MAX));
    assert_eq!(pos_headroom, -neg_headroom);
    assert!(
        (7_500..=8_600).contains(&pos_headroom),
        "unexpected headroom decoded level: {pos_headroom}",
    );

    let full_frame = [20_000_i16; RTP_FRAME_SAMPLES];
    let raw_encoded = encode_mulaw_frame(&full_frame);
    let headroom_encoded = encode_mulaw_frame_with_headroom(&full_frame);
    let raw_decoded = decode_mulaw_frame(&raw_encoded);
    assert!(mean_abs_pcm(&raw_decoded) > 19_000);
    assert!(mulaw_frame_mean_abs(&headroom_encoded) < 5_500);
    assert!(mulaw_frame_mean_abs(&headroom_encoded) > 4_500);
}

#[test]
fn downsampler_preserves_1khz_passband_and_attenuates_8khz_stopband() {
    let tap_sum: i32 = FIR_24K_TO_8K_Q15.iter().map(|&t| i32::from(t)).sum();
    assert_eq!(tap_sum, 32_768);

    // 1 kHz tone (well inside 0..3.4 kHz passband) for 100 ms (2400 samples @ 24 kHz -> 800 @ 8 kHz).
    let passband_24k = generate_sine_pcm(1_000, TTS_PCM_SAMPLE_RATE_HZ, 16_000, 2_400);
    let mut downsampler = Downsampler24kTo8k::new();
    let mut passband_8k = Vec::new();
    downsampler.push_pcm24k_samples(&passband_24k, &mut passband_8k);
    assert_eq!(passband_8k.len(), 800);

    let steady_passband = &passband_8k[32..];
    let in_mean = mean_abs_pcm(&passband_24k[96..]);
    let pass_mean = mean_abs_pcm(steady_passband);
    // Passband gain at 1 kHz is ~0 dB: output mean_abs should stay within 5% of input mean_abs.
    assert!(
        pass_mean >= (in_mean * 95) / 100 && pass_mean <= (in_mean * 105) / 100,
        "passband mean {pass_mean} drifted from input mean {in_mean}",
    );

    // 8 kHz tone (above 4 kHz Nyquist of 8 kHz output) must be attenuated well beyond 20 dB (10x).
    downsampler.reset();
    let stopband_24k = generate_sine_pcm(8_000, TTS_PCM_SAMPLE_RATE_HZ, 16_000, 2_400);
    let mut stopband_8k = Vec::new();
    downsampler.push_pcm24k_samples(&stopband_24k, &mut stopband_8k);
    assert_eq!(stopband_8k.len(), 800);

    let steady_stopband = &stopband_8k[32..];
    let stop_mean = mean_abs_pcm(steady_stopband);
    let stop_peak = steady_stopband
        .iter()
        .map(|s| s.unsigned_abs())
        .max()
        .unwrap_or(0);
    // -20 dB relative to pass_mean (~10185) is ~1018; our 48-tap Hamming FIR achieves >60 dB (<20).
    assert!(
        stop_mean * 10 <= pass_mean && stop_peak < 100,
        "insufficient stopband attenuation: stop_mean={stop_mean}, stop_peak={stop_peak}, pass_mean={pass_mean}",
    );

    // Full-scale 1 kHz square wave (+/-32767..=-32768) exercises Gibbs overshoot saturation
    // without wrapping or panicking, while preserving fundamental energy.
    downsampler.reset();
    let mut full_scale_square_24k = Vec::with_capacity(2_400);
    for i in 0..2_400 {
        let val = if (i / 12) % 2 == 0 {
            i16::MAX
        } else {
            i16::MIN
        };
        full_scale_square_24k.push(val);
    }
    let mut square_8k = Vec::new();
    downsampler.push_pcm24k_samples(&full_scale_square_24k, &mut square_8k);
    assert_eq!(square_8k.len(), 800);
    assert!(mean_abs_pcm(&square_8k[32..]) > 20_000);
}

#[test]
fn downsampler_handles_arbitrary_odd_byte_chunk_splits_identically() {
    let pcm_24k = generate_sine_pcm(1_250, TTS_PCM_SAMPLE_RATE_HZ, 12_345, 1_443);
    let mut raw_bytes = Vec::with_capacity(pcm_24k.len() * 2);
    for &s in &pcm_24k {
        raw_bytes.extend_from_slice(&s.to_le_bytes());
    }

    let mut single_shot_ds = Downsampler24kTo8k::default();
    let mut expected = Vec::new();
    single_shot_ds.push_pcm24k_le_bytes(&raw_bytes, &mut expected);
    assert!(!single_shot_ds.has_pending_byte());
    assert_eq!(expected.len(), 1_443 / 3);

    for chunk_size in [1_usize, 3, 5, 7, 13, 31, 64] {
        let mut chunked_ds = Downsampler24kTo8k::new();
        let mut actual = Vec::new();
        chunked_ds.push_pcm24k_le_bytes(&[], &mut actual);
        for (idx, chunk) in raw_bytes.chunks(chunk_size).enumerate() {
            chunked_ds.push_pcm24k_le_bytes(chunk, &mut actual);
            if chunk_size == 1 {
                assert_eq!(chunked_ds.has_pending_byte(), idx % 2 == 0);
            }
        }
        assert!(!chunked_ds.has_pending_byte());
        assert_eq!(
            actual, expected,
            "mismatch for odd byte chunk size {chunk_size}",
        );
    }
}

#[test]
fn wav_encoder_writes_valid_8khz_mono_16bit_riff_header() {
    let samples = [0_i16, 1_024, -1_024, i16::MAX, i16::MIN];
    let wav = encode_wav_8k_mono(&samples);
    assert_eq!(wav.len(), WAV_HEADER_BYTES + samples.len() * 2);

    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(
        u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]),
        36 + 10,
    );
    assert_eq!(&wav[8..12], b"WAVE");
    assert_eq!(&wav[12..16], b"fmt ");
    assert_eq!(u32::from_le_bytes([wav[16], wav[17], wav[18], wav[19]]), 16);
    assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1);
    assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
    assert_eq!(
        u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
        TELEPHONY_SAMPLE_RATE_HZ,
    );
    assert_eq!(
        u32::from_le_bytes([wav[28], wav[29], wav[30], wav[31]]),
        TELEPHONY_SAMPLE_RATE_HZ * 2,
    );
    assert_eq!(u16::from_le_bytes([wav[32], wav[33]]), 2);
    assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
    assert_eq!(&wav[36..40], b"data");
    assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 10);

    for (i, &expected) in samples.iter().enumerate() {
        let offset = WAV_HEADER_BYTES + i * 2;
        let decoded = i16::from_le_bytes([wav[offset], wav[offset + 1]]);
        assert_eq!(decoded, expected);
    }
}

#[test]
fn vad_preserves_300ms_preroll_and_emits_after_hangover_in_normal_and_ivr_modes() {
    let mut vad = TelephonyVad::default();
    assert!(!vad.is_ivr_mode());
    assert_eq!(vad.hangover_frames(), VAD_DEFAULT_HANGOVER_FRAMES);

    // Feed 20 quiet pre-speech frames tagged with frame index (1..=20) well below speech threshold.
    for marker in 1_i16..=20_i16 {
        let quiet_frame = [marker; RTP_FRAME_SAMPLES];
        assert_eq!(vad.process_frame(&quiet_frame, false, 0), None);
        assert!(!vad.is_in_speech());
    }

    // Feed 10 loud speech frames (above threshold); onset must trigger on the 7th frame.
    let speech_frame = [2_400_i16; RTP_FRAME_SAMPLES];
    for idx in 0..10 {
        assert_eq!(vad.process_frame(&speech_frame, false, 0), None);
        if idx + 1 >= VAD_SPEECH_ONSET_FRAMES {
            assert!(vad.is_in_speech());
        } else {
            assert!(!vad.is_in_speech());
        }
    }

    // A full second of silence ends a normal turn.
    let silence_frame = [0_i16; RTP_FRAME_SAMPLES];
    for _ in 0..(VAD_DEFAULT_HANGOVER_FRAMES - 1) {
        assert_eq!(vad.process_frame(&silence_frame, false, 0), None);
        assert!(vad.is_in_speech());
    }

    let event = vad.process_frame(&silence_frame, false, 0);
    assert!(!vad.is_in_speech());
    let utterance = match event {
        Some(VadEvent::UtteranceComplete(buf)) => buf,
        other => panic!("expected UtteranceComplete, got {other:?}"),
    };

    // Pre-roll at onset (7th speech frame) held 9 pre-speech frames (markers 12..=20) + 6 speech frames,
    // followed by 4 remaining speech frames + 50 hangover silence frames = 69 frames.
    assert_eq!(utterance.len(), 69 * RTP_FRAME_SAMPLES);
    // First frame of the utterance must be pre-speech frame marker 12 (9 frames = 180 ms before speech frame 1,
    // i.e. 15 frames = 300 ms before the 7th onset frame!).
    assert_eq!(utterance[0], 12);
    assert_eq!(utterance[8 * RTP_FRAME_SAMPLES], 20);
    assert_eq!(utterance[9 * RTP_FRAME_SAMPLES], 2_400);

    for _ in 0..7 {
        assert_eq!(vad.process_frame(&speech_frame, false, 0), None);
    }
    for _ in 0..30 {
        assert_eq!(vad.process_frame(&silence_frame, false, 0), None);
    }
    assert!(
        vad.has_pending_speech(),
        "a 600 ms hesitation must not end the answer",
    );
    for _ in 0..7 {
        assert_eq!(vad.process_frame(&speech_frame, false, 0), None);
    }
    for _ in 0..49 {
        assert_eq!(vad.process_frame(&silence_frame, false, 0), None);
    }
    assert!(matches!(
        vad.process_frame(&silence_frame, false, 0),
        Some(VadEvent::UtteranceComplete(_))
    ));

    // IVR menus tolerate 1100 ms pauses.
    vad.set_ivr_mode(true);
    assert!(vad.is_ivr_mode());
    assert_eq!(vad.hangover_frames(), VAD_IVR_HANGOVER_FRAMES);
    for _ in 0..VAD_SPEECH_ONSET_FRAMES {
        assert_eq!(vad.process_frame(&speech_frame, false, 0), None);
    }
    for _ in 0..(VAD_IVR_HANGOVER_FRAMES - 1) {
        assert_eq!(vad.process_frame(&silence_frame, false, 0), None);
    }
    assert!(matches!(
        vad.process_frame(&silence_frame, false, 0),
        Some(VadEvent::UtteranceComplete(_))
    ));
}

#[test]
fn vad_rejects_outbound_echo_and_triggers_barge_in_on_sustained_loud_speech() {
    let mut vad = TelephonyVad::new();
    let outbound_mean_abs: u32 = 3_600;
    let active_thresh = vad.speech_threshold(true, outbound_mean_abs);
    assert_eq!(active_thresh, (outbound_mean_abs / 4) + VAD_ECHO_MARGIN);

    // Simulated acoustic/hybrid echo at 1000 (< 3600/4 + 500 = 1400) for 40 frames:
    // must never trigger BargeIn or speech accumulation.
    let echo_frame = [1_000_i16; RTP_FRAME_SAMPLES];
    for _ in 0..40 {
        assert_eq!(
            vad.process_frame(&echo_frame, true, outbound_mean_abs),
            None,
        );
        assert!(!vad.is_in_speech());
    }

    // Brief loud spike (8 frames < 12 required frames) while TTS plays must ALSO be ignored.
    let loud_human_frame = [2_800_i16; RTP_FRAME_SAMPLES];
    for _ in 0..8 {
        assert_eq!(
            vad.process_frame(&loud_human_frame, true, outbound_mean_abs),
            None,
        );
        assert!(!vad.is_in_speech());
    }
    // Drop back to echo resets the barge-in streak; trailing silence must NOT emit any echo utterance.
    assert_eq!(
        vad.process_frame(&echo_frame, true, outbound_mean_abs),
        None,
    );
    let silence = [0_i16; RTP_FRAME_SAMPLES];
    for _ in 0..40 {
        assert_eq!(vad.process_frame(&silence, false, 0), None);
    }

    // Now sustained human interruption for 12 frames (240 ms) while outbound TTS plays:
    for step in 0..(VAD_BARGE_IN_ONSET_FRAMES - 1) {
        assert_eq!(
            vad.process_frame(&loud_human_frame, true, outbound_mean_abs),
            None,
            "premature barge-in at frame {step}",
        );
    }
    assert_eq!(
        vad.process_frame(&loud_human_frame, true, outbound_mean_abs),
        Some(VadEvent::BargeIn),
    );
    assert!(vad.is_in_speech());

    // Caller flushes TTS (outbound_playing = false); human speaks 5 more frames then pauses.
    for _ in 0..5 {
        assert_eq!(vad.process_frame(&loud_human_frame, false, 0), None);
    }
    let mut completed = None;
    for _ in 0..VAD_DEFAULT_HANGOVER_FRAMES {
        completed = vad.process_frame(&silence, false, 0);
    }
    assert!(matches!(completed, Some(VadEvent::UtteranceComplete(ref s)) if !s.is_empty()));
}

#[test]
fn vad_enforces_hard_max_utterance_cap_on_continuous_hold_music() {
    let mut vad = TelephonyVad::new();
    let music_mulaw = encode_mulaw_frame(&[1_800_i16; RTP_FRAME_SAMPLES]);
    let max_frames = VAD_MAX_UTTERANCE_SAMPLES / RTP_FRAME_SAMPLES;

    let mut emitted = None;
    for _ in 0..max_frames {
        if let Some(ev) = vad.process_mulaw_frame(&music_mulaw, false, 0) {
            emitted = Some(ev);
            break;
        }
    }
    match emitted {
        Some(VadEvent::UtteranceComplete(samples)) => {
            assert_eq!(samples.len(), VAD_MAX_UTTERANCE_SAMPLES);
        }
        other => panic!("expected capped UtteranceComplete, got {other:?}"),
    }
    vad.reset();
    assert!(!vad.is_in_speech());
    assert_eq!(vad.noise_floor(), VAD_INITIAL_NOISE_FLOOR);
}

const LOUD_SPEECH_FRAME: [i16; RTP_FRAME_SAMPLES] = [2_800; RTP_FRAME_SAMPLES];
const PLAYBACK_MEAN_ABS: u32 = 3_600;

fn start_speech_before_playback(vad: &mut TelephonyVad) {
    for _ in 0..VAD_SPEECH_ONSET_FRAMES {
        assert_eq!(vad.process_frame(&LOUD_SPEECH_FRAME, false, 0), None);
    }
    assert!(vad.is_in_speech());
}

fn continue_speech_without_playback(vad: &mut TelephonyVad, frames: usize) {
    for _ in 0..frames {
        assert_eq!(vad.process_frame(&LOUD_SPEECH_FRAME, false, 0), None);
    }
}

#[test]
fn vad_playback_starting_mid_utterance_drops_echo_and_needs_sustained_speech_to_barge_in() {
    let mut vad = TelephonyVad::new();
    let echo_frame = [1_000_i16; RTP_FRAME_SAMPLES];
    assert!(
        mean_abs_pcm(&echo_frame) < vad.speech_threshold(true, PLAYBACK_MEAN_ABS)
            && mean_abs_pcm(&LOUD_SPEECH_FRAME) >= vad.speech_threshold(true, PLAYBACK_MEAN_ABS),
    );

    // Playback that begins while the caller is mid-utterance only contributes echo, which is
    // never captured and eventually closes the utterance after the normal hangover.
    start_speech_before_playback(&mut vad);
    for _ in 0..(VAD_DEFAULT_HANGOVER_FRAMES - 1) {
        assert_eq!(
            vad.process_frame(&echo_frame, true, PLAYBACK_MEAN_ABS),
            None,
        );
        assert!(vad.is_in_speech());
    }
    assert_eq!(
        vad.process_frame(&echo_frame, true, PLAYBACK_MEAN_ABS),
        Some(VadEvent::UtteranceComplete(vec![
            2_800;
            VAD_SPEECH_ONSET_FRAMES
                * RTP_FRAME_SAMPLES
        ])),
    );
    assert!(!vad.is_in_speech());

    // Loud speech that continues over playback must persist for the barge-in onset window.
    start_speech_before_playback(&mut vad);
    for step in 0..(VAD_BARGE_IN_ONSET_FRAMES - 1) {
        assert_eq!(
            vad.process_frame(&LOUD_SPEECH_FRAME, true, PLAYBACK_MEAN_ABS),
            None,
            "premature mid-utterance barge-in at frame {step}",
        );
    }
    assert_eq!(
        vad.process_frame(&LOUD_SPEECH_FRAME, true, PLAYBACK_MEAN_ABS),
        Some(VadEvent::BargeIn),
    );
    assert!(vad.is_in_speech());

    let silence = [0_i16; RTP_FRAME_SAMPLES];
    for _ in 0..(VAD_DEFAULT_HANGOVER_FRAMES - 1) {
        assert_eq!(vad.process_frame(&silence, false, 0), None);
    }
    match vad.process_frame(&silence, false, 0) {
        Some(VadEvent::UtteranceComplete(samples)) => {
            let speech_frames = VAD_SPEECH_ONSET_FRAMES + VAD_BARGE_IN_ONSET_FRAMES;
            assert_eq!(
                samples.len(),
                (speech_frames + VAD_DEFAULT_HANGOVER_FRAMES) * RTP_FRAME_SAMPLES,
            );
            assert!(samples[..speech_frames * RTP_FRAME_SAMPLES]
                .iter()
                .all(|&sample| sample == 2_800));
            assert!(samples[speech_frames * RTP_FRAME_SAMPLES..]
                .iter()
                .all(|&sample| sample == 0));
        }
        other => panic!("expected UtteranceComplete after barge-in hangover, got {other:?}"),
    }
}

#[test]
fn vad_caps_utterances_that_fill_during_playback_and_barge_in_capture() {
    let max_frames = VAD_MAX_UTTERANCE_SAMPLES / RTP_FRAME_SAMPLES;

    // The final frame that fills the buffer arrives while playback is active but before the
    // barge-in onset window is reached.
    let mut vad = TelephonyVad::new();
    start_speech_before_playback(&mut vad);
    continue_speech_without_playback(&mut vad, max_frames - VAD_SPEECH_ONSET_FRAMES - 1);
    match vad.process_frame(&LOUD_SPEECH_FRAME, true, PLAYBACK_MEAN_ABS) {
        Some(VadEvent::UtteranceComplete(samples)) => {
            assert_eq!(samples.len(), VAD_MAX_UTTERANCE_SAMPLES);
        }
        other => panic!("expected capped UtteranceComplete during playback, got {other:?}"),
    }
    assert!(!vad.is_in_speech());

    // A barge-in that lands exactly on the cap is reported first; the next frame is not
    // appended beyond the cap and completes the utterance.
    let mut vad = TelephonyVad::new();
    start_speech_before_playback(&mut vad);
    continue_speech_without_playback(
        &mut vad,
        max_frames - VAD_SPEECH_ONSET_FRAMES - VAD_BARGE_IN_ONSET_FRAMES,
    );
    for _ in 0..(VAD_BARGE_IN_ONSET_FRAMES - 1) {
        assert_eq!(
            vad.process_frame(&LOUD_SPEECH_FRAME, true, PLAYBACK_MEAN_ABS),
            None,
        );
    }
    assert_eq!(
        vad.process_frame(&LOUD_SPEECH_FRAME, true, PLAYBACK_MEAN_ABS),
        Some(VadEvent::BargeIn),
    );
    match vad.process_frame(&LOUD_SPEECH_FRAME, true, PLAYBACK_MEAN_ABS) {
        Some(VadEvent::UtteranceComplete(samples)) => {
            assert_eq!(samples.len(), VAD_MAX_UTTERANCE_SAMPLES);
        }
        other => panic!("expected capped UtteranceComplete after barge-in, got {other:?}"),
    }
    assert!(!vad.is_in_speech());
}

#[test]
fn rfc4733_packets_and_inband_dtmf_synthesis_cover_all_valid_and_invalid_digits() {
    for (ch, expected) in [
        ('0', 0_u8),
        ('1', 1),
        ('2', 2),
        ('3', 3),
        ('4', 4),
        ('5', 5),
        ('6', 6),
        ('7', 7),
        ('8', 8),
        ('9', 9),
        ('*', 10),
        ('#', 11),
        ('A', 12),
        ('a', 12),
        ('B', 13),
        ('b', 13),
        ('C', 14),
        ('c', 14),
        ('D', 15),
        ('d', 15),
    ] {
        assert_eq!(parse_dtmf_digit(ch), Some(expected));
    }
    for invalid in ['E', 'e', 'w', ',', ' ', '-', '?'] {
        assert_eq!(parse_dtmf_digit(invalid), None);
    }
    assert_eq!(dtmf_frequencies_hz(16), None);

    let raw_packets = build_rfc4733_digit_packets(11, 160, RFC4733_DEFAULT_HOLD_PACKETS);
    assert_eq!(raw_packets.len(), 7);

    let decoded_packets: Vec<Rfc4733DtmfPacket> = raw_packets
        .iter()
        .copied()
        .map(Rfc4733DtmfPacket::from_bytes)
        .collect();

    // First 4 packets: E=0, volume=10, strictly increasing durations 160, 320, 480, 640.
    for (idx, pkt) in decoded_packets[..4].iter().enumerate() {
        assert_eq!(pkt.event, 11);
        assert!(!pkt.end_of_event);
        assert_eq!(pkt.volume, RFC4733_DEFAULT_VOLUME);
        let expected_dur = u16::try_from((idx + 1) * 160).unwrap_or(0);
        assert_eq!(pkt.duration, expected_dur);
    }

    // Final 3 packets: E=1 (0x80 bit set), volume=10, duration=800 repeated 3 times.
    for (raw, pkt) in raw_packets[4..].iter().zip(decoded_packets[4..].iter()) {
        assert_eq!(raw[1] & RFC4733_END_FLAG, RFC4733_END_FLAG);
        assert_eq!(pkt.event, 11);
        assert!(pkt.end_of_event);
        assert_eq!(pkt.volume, RFC4733_DEFAULT_VOLUME);
        assert_eq!(pkt.duration, 800);
    }

    // Monotonic non-decreasing duration across the entire RFC 4733 sequence.
    for pair in decoded_packets.windows(2) {
        assert!(pair[1].duration >= pair[0].duration);
    }

    // In-band DTMF synthesis validation & invalid rejection.
    assert!(synthesize_inband_dtmf_mulaw("").is_err());
    assert!(synthesize_inband_dtmf_mulaw("12X4").is_err());

    let frames = synthesize_inband_dtmf_mulaw("1*#D").expect("valid DTMF sequence");
    assert_eq!(
        frames.len(),
        4 * (DTMF_TONE_FRAMES + DTMF_INTER_DIGIT_SILENCE_FRAMES),
    );
    // Each digit has 5 active tone frames + 3 silence frames.
    for digit_chunk in frames.chunks_exact(DTMF_TONE_FRAMES + DTMF_INTER_DIGIT_SILENCE_FRAMES) {
        for tone_frame in &digit_chunk[..DTMF_TONE_FRAMES] {
            assert!(mulaw_frame_mean_abs(tone_frame) > 4_000);
        }
        for silence_frame in &digit_chunk[DTMF_TONE_FRAMES..] {
            assert_eq!(silence_frame, &[MULAW_SILENCE; RTP_FRAME_SAMPLES]);
        }
    }
}

#[test]
fn ema_noise_floor_adaptation_and_degenerate_inputs_are_total() {
    assert_eq!(mean_abs_pcm(&[]), 0);
    assert_eq!(phase_step_for_hz(1_000, 0), 0);

    let empty_wav = encode_wav_8k_mono(&[]);
    assert_eq!(empty_wav.len(), WAV_HEADER_BYTES);
    assert_eq!(
        u32::from_le_bytes([empty_wav[40], empty_wav[41], empty_wav[42], empty_wav[43]]),
        0,
    );

    let min_packets = build_rfc4733_digit_packets(0, 0, 0);
    assert_eq!(min_packets.len(), RFC4733_END_RETRANSMIT_COUNT);
    for raw in min_packets {
        let pkt = Rfc4733DtmfPacket::from_bytes(raw);
        assert!(pkt.end_of_event);
        assert_eq!(pkt.duration, 1);
    }

    let mut vad = TelephonyVad::new();
    let initial_floor = vad.noise_floor();
    let ambient_hiss = [180_i16; RTP_FRAME_SAMPLES];
    for _ in 0..120 {
        assert_eq!(vad.process_frame(&ambient_hiss, false, 0), None);
    }
    let raised_floor = vad.noise_floor();
    assert!(
        raised_floor > initial_floor && raised_floor <= 180,
        "expected raised noise floor between {initial_floor} and 180, got {raised_floor}",
    );

    let silence = [0_i16; RTP_FRAME_SAMPLES];
    for _ in 0..60 {
        assert_eq!(vad.process_frame(&silence, false, 0), None);
    }
    let lowered_floor = vad.noise_floor();
    assert!(
        lowered_floor < raised_floor && lowered_floor >= 40,
        "expected lowered noise floor >= 40 and < {raised_floor}, got {lowered_floor}",
    );
}

fn correlate_frequency_power(samples: &[i16], freq_hz: u32, sample_rate_hz: u32) -> u128 {
    let step = phase_step_for_hz(freq_hz, sample_rate_hz);
    let quarter_turn: u32 = 1_u32 << 30;
    let mut phase: u32 = 0;
    let mut re_acc: i128 = 0;
    let mut im_acc: i128 = 0;
    for &sample in samples {
        let sin_q15 = i128::from(sin_q15_from_phase(phase));
        let cos_q15 = i128::from(sin_q15_from_phase(phase.wrapping_add(quarter_turn)));
        let sample_value = i128::from(sample);
        re_acc += sample_value * cos_q15;
        im_acc += sample_value * sin_q15;
        phase = phase.wrapping_add(step);
    }
    let count = i128::try_from(samples.len().max(1)).unwrap_or(1);
    let re = (re_acc >> 15) / count;
    let im = (im_acc >> 15) / count;
    (re * re + im * im).unsigned_abs()
}

#[test]
fn inband_dtmf_tones_match_exact_itu_q23_dual_frequencies() {
    let all_digits = "0123456789*#ABCD";
    let frames = synthesize_inband_dtmf_mulaw(all_digits).expect("synthesize all 16 DTMF digits");
    let stride = DTMF_TONE_FRAMES + DTMF_INTER_DIGIT_SILENCE_FRAMES;
    assert_eq!(frames.len(), all_digits.len() * stride);

    let row_group: [u16; 4] = [697, 770, 852, 941];
    let col_group: [u16; 4] = [1_209, 1_336, 1_477, 1_633];

    for (digit_idx, ch) in all_digits.chars().enumerate() {
        let code = parse_dtmf_digit(ch).expect("valid digit");
        let (expected_low, expected_high) = dtmf_frequencies_hz(code).expect("valid frequencies");

        let mut decoded_tone = Vec::with_capacity(DTMF_TONE_FRAMES * RTP_FRAME_SAMPLES);
        let base = digit_idx * stride;
        for frame in &frames[base..(base + DTMF_TONE_FRAMES)] {
            decoded_tone.extend_from_slice(&decode_mulaw_frame(frame));
        }

        let best_row = row_group
            .iter()
            .copied()
            .max_by_key(|&hz| {
                correlate_frequency_power(&decoded_tone, u32::from(hz), TELEPHONY_SAMPLE_RATE_HZ)
            })
            .expect("row group non-empty");
        let best_col = col_group
            .iter()
            .copied()
            .max_by_key(|&hz| {
                correlate_frequency_power(&decoded_tone, u32::from(hz), TELEPHONY_SAMPLE_RATE_HZ)
            })
            .expect("col group non-empty");

        assert_eq!(
            best_row, expected_low,
            "wrong low-group frequency for '{ch}'",
        );
        assert_eq!(
            best_col, expected_high,
            "wrong high-group frequency for '{ch}'",
        );
    }
}

#[test]
fn end_to_end_24k_tts_to_mulaw_rtp_to_vad_wav_roundtrip() {
    assert_eq!(
        (TELEPHONY_SAMPLE_RATE_HZ * RTP_FRAME_DURATION_MS) / 1_000,
        u32::try_from(RTP_FRAME_SAMPLES).unwrap_or(0),
    );
    assert_eq!(VAD_PREROLL_SAMPLES, 2_400);

    let step = phase_step_for_hz(900, TTS_PCM_SAMPLE_RATE_HZ);
    let mut phase: u32 = 0;
    let mut pcm_24k_bytes = Vec::with_capacity(5_760 * 2);
    for _ in 0..5_760 {
        let sample = sin_q15_from_phase(phase);
        pcm_24k_bytes.extend_from_slice(&sample.to_le_bytes());
        phase = phase.wrapping_add(step);
    }

    let mut downsampler = Downsampler24kTo8k::new();
    let mut pcm_8k = Vec::new();
    downsampler.push_pcm24k_le_bytes(&pcm_24k_bytes, &mut pcm_8k);
    assert_eq!(pcm_8k.len(), 12 * RTP_FRAME_SAMPLES);

    let mut vad = TelephonyVad::new();
    let silence_mulaw = [MULAW_SILENCE; RTP_FRAME_SAMPLES];
    for _ in 0..10 {
        assert_eq!(vad.process_mulaw_frame(&silence_mulaw, false, 0), None);
    }

    for chunk in pcm_8k.chunks_exact(RTP_FRAME_SAMPLES) {
        let mut frame = [0_i16; RTP_FRAME_SAMPLES];
        frame.copy_from_slice(chunk);
        let mulaw = encode_mulaw_frame_with_headroom(&frame);
        assert_eq!(vad.process_mulaw_frame(&mulaw, false, 0), None);
    }
    assert!(vad.is_in_speech());

    let mut completed = None;
    for _ in 0..VAD_DEFAULT_HANGOVER_FRAMES {
        completed = vad.process_mulaw_frame(&silence_mulaw, false, 0);
    }
    let utterance = match completed {
        Some(VadEvent::UtteranceComplete(samples)) => samples,
        other => panic!("expected UtteranceComplete, got {other:?}"),
    };
    let wav = encode_wav_8k_mono(&utterance);
    assert_eq!(wav.len(), WAV_HEADER_BYTES + utterance.len() * 2);
    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");
}
