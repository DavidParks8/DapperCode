#![forbid(unsafe_code)]
#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "audio_tests.rs"]
pub(super) mod tests;

use std::collections::VecDeque;

pub const TELEPHONY_SAMPLE_RATE_HZ: u32 = 8_000;
pub const RTP_FRAME_SAMPLES: usize = 160;
pub const MULAW_SILENCE: u8 = 0xFF;

/// Q15 headroom scale factor (`8192 / 32768 = 0.25`, `-12.04 dBFS`) applied to hot neural TTS PCM
/// so full-scale speech never clips harshly when quantized to G.711 mu-law.
pub const TTS_HEADROOM_GAIN_Q15: i32 = 8_192;

const MULAW_BIAS: i32 = 0x84;
const MULAW_CLIP: i32 = 32_635;

pub const FIR_TAPS: usize = 48;
pub const DECIMATION_FACTOR: usize = 3;

/// Precomputed symmetric 48-tap Q15 Hamming-windowed sinc low-pass FIR filter
/// (`fc = 3400 Hz` at `fs = 24000 Hz`, exact DC gain `sum = 32768`).
pub const FIR_24K_TO_8K_Q15: [i16; FIR_TAPS] = [
    31, 36, 13, -34, -77, -69, 17, 144, 202, 90, -175, -408, -365, 48, 611, 862, 418, -640, -1640,
    -1617, 74, 3220, 6687, 8956, 8956, 6687, 3220, 74, -1617, -1640, -640, 418, 862, 611, 48, -365,
    -408, -175, 90, 202, 144, 17, -69, -77, -34, 13, 36, 31,
];

pub const WAV_HEADER_BYTES: usize = 44;

pub const VAD_PREROLL_FRAMES: usize = 15;
pub const VAD_SPEECH_ONSET_FRAMES: usize = 7;
pub const VAD_BARGE_IN_ONSET_FRAMES: usize = 8;
pub const VAD_DEFAULT_HANGOVER_FRAMES: usize = 40;
pub const VAD_IVR_HANGOVER_FRAMES: usize = 55;
pub const VAD_MAX_UTTERANCE_SAMPLES: usize = 200_000;
pub const VAD_ECHO_MARGIN: u32 = 1_400;
pub const VAD_ECHO_TAIL_FRAMES: usize = 35;

const VAD_INITIAL_NOISE_FLOOR: u32 = 80;
const VAD_MIN_NOISE_FLOOR_I64: i64 = 40;
const VAD_MAX_NOISE_FLOOR_I64: i64 = 1_200;
const VAD_BASE_SPEECH_MARGIN: u32 = 120;

pub const RFC4733_DEFAULT_VOLUME: u8 = 10;
pub const RFC4733_END_FLAG: u8 = 0x80;
pub const RFC4733_DEFAULT_HOLD_PACKETS: u8 = 5;
pub const RFC4733_END_RETRANSMIT_COUNT: usize = 3;
pub const DTMF_TONE_FRAMES: usize = 5;
pub const DTMF_INTER_DIGIT_SILENCE_FRAMES: usize = 3;

const DTMF_LOW_GROUP_GAIN: i32 = 6_500;
const DTMF_HIGH_GROUP_GAIN: i32 = 8_200;

/// Full-wave 256-entry Q15 sine lookup table (`round(32767 * sin(2 * pi * i / 256))`).
const SINE_TABLE_256_Q15: [i16; 256] = [
    0, 804, 1608, 2410, 3212, 4011, 4808, 5602, 6393, 7179, 7962, 8739, 9512, 10278, 11039, 11793,
    12539, 13279, 14010, 14732, 15446, 16151, 16846, 17530, 18204, 18868, 19519, 20159, 20787,
    21403, 22005, 22594, 23170, 23731, 24279, 24811, 25329, 25832, 26319, 26790, 27245, 27683,
    28105, 28510, 28898, 29268, 29621, 29956, 30273, 30571, 30852, 31113, 31356, 31580, 31785,
    31971, 32137, 32285, 32412, 32521, 32609, 32678, 32728, 32757, 32767, 32757, 32728, 32678,
    32609, 32521, 32412, 32285, 32137, 31971, 31785, 31580, 31356, 31113, 30852, 30571, 30273,
    29956, 29621, 29268, 28898, 28510, 28105, 27683, 27245, 26790, 26319, 25832, 25329, 24811,
    24279, 23731, 23170, 22594, 22005, 21403, 20787, 20159, 19519, 18868, 18204, 17530, 16846,
    16151, 15446, 14732, 14010, 13279, 12539, 11793, 11039, 10278, 9512, 8739, 7962, 7179, 6393,
    5602, 4808, 4011, 3212, 2410, 1608, 804, 0, -804, -1608, -2410, -3212, -4011, -4808, -5602,
    -6393, -7179, -7962, -8739, -9512, -10278, -11039, -11793, -12539, -13279, -14010, -14732,
    -15446, -16151, -16846, -17530, -18204, -18868, -19519, -20159, -20787, -21403, -22005, -22594,
    -23170, -23731, -24279, -24811, -25329, -25832, -26319, -26790, -27245, -27683, -28105, -28510,
    -28898, -29268, -29621, -29956, -30273, -30571, -30852, -31113, -31356, -31580, -31785, -31971,
    -32137, -32285, -32412, -32521, -32609, -32678, -32728, -32757, -32767, -32757, -32728, -32678,
    -32609, -32521, -32412, -32285, -32137, -31971, -31785, -31580, -31356, -31113, -30852, -30571,
    -30273, -29956, -29621, -29268, -28898, -28510, -28105, -27683, -27245, -26790, -26319, -25832,
    -25329, -24811, -24279, -23731, -23170, -22594, -22005, -21403, -20787, -20159, -19519, -18868,
    -18204, -17530, -16846, -16151, -15446, -14732, -14010, -13279, -12539, -11793, -11039, -10278,
    -9512, -8739, -7962, -7179, -6393, -5602, -4808, -4011, -3212, -2410, -1608, -804,
];

#[inline]
fn saturate_i32_to_i16(value: i32) -> i16 {
    let clamped = value.clamp(i32::from(i16::MIN), i32::from(i16::MAX));
    i16::try_from(clamped).unwrap_or(0)
}

#[inline]
fn saturate_i64_to_i16(value: i64) -> i16 {
    let clamped = value.clamp(i64::from(i16::MIN), i64::from(i16::MAX));
    i16::try_from(clamped).unwrap_or(0)
}

/// Decodes a single ITU-T G.711 mu-law byte into signed 16-bit linear PCM.
#[inline]
pub fn decode_mulaw(byte: u8) -> i16 {
    let ulaw = !byte;
    let sign_negative = (ulaw & 0x80) != 0;
    let exponent = u32::from((ulaw >> 4) & 0x07);
    let mantissa = i32::from(ulaw & 0x0F);
    let magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
    let signed = if sign_negative { -magnitude } else { magnitude };
    saturate_i32_to_i16(signed)
}

/// Decodes a 20 ms (`160`-byte) G.711 mu-law RTP payload into 16-bit linear PCM samples.
pub fn decode_mulaw_frame(input: &[u8; RTP_FRAME_SAMPLES]) -> [i16; RTP_FRAME_SAMPLES] {
    let mut out = [0_i16; RTP_FRAME_SAMPLES];
    for (dst, &src) in out.iter_mut().zip(input.iter()) {
        *dst = decode_mulaw(src);
    }
    out
}

/// Encodes a signed 16-bit linear PCM sample into an ITU-T G.711 mu-law byte.
#[inline]
pub fn encode_mulaw(sample: i16) -> u8 {
    let sample_i32 = i32::from(sample);
    let (sign_mask, mut pcm_val) = if sample_i32 < 0 {
        (0x80_u8, -sample_i32)
    } else {
        (0x00_u8, sample_i32)
    };
    if pcm_val > MULAW_CLIP {
        pcm_val = MULAW_CLIP;
    }
    pcm_val += MULAW_BIAS;

    // pcm_val is guaranteed to be in 132..=32767 (0x0084..=0x7FFF).
    let biased_u16 = u16::try_from(pcm_val).unwrap_or(u16::MAX >> 1);
    let exponent = 8_u32.saturating_sub(biased_u16.leading_zeros()).min(7);
    let mantissa = (pcm_val >> (exponent + 3)) & 0x0F;

    let exp_byte = exponent.to_le_bytes()[0] << 4;
    let man_byte = mantissa.to_le_bytes()[0] & 0x0F;
    !(sign_mask | exp_byte | man_byte)
}

/// Scales a hot neural TTS PCM sample down by `-12.04 dBFS` ([`TTS_HEADROOM_GAIN_Q15`]) in Q15
/// integer math before encoding to ITU-T G.711 mu-law.
#[inline]
pub fn encode_mulaw_with_headroom(sample: i16) -> u8 {
    let scaled = (i32::from(sample) * TTS_HEADROOM_GAIN_Q15) / 32_768;
    encode_mulaw(saturate_i32_to_i16(scaled))
}

/// Encodes a 20 ms (`160`-sample) 8 kHz TTS PCM frame into G.711 mu-law with headroom scaling.
pub fn encode_mulaw_frame_with_headroom(
    input: &[i16; RTP_FRAME_SAMPLES],
) -> [u8; RTP_FRAME_SAMPLES] {
    let mut out = [MULAW_SILENCE; RTP_FRAME_SAMPLES];
    for (dst, &src) in out.iter_mut().zip(input.iter()) {
        *dst = encode_mulaw_with_headroom(src);
    }
    out
}

/// Computes the mean absolute amplitude (`0..=32768`) of a 16-bit PCM slice.
pub fn mean_abs_pcm(samples: &[i16]) -> u32 {
    if samples.is_empty() {
        return 0;
    }
    let mut sum: u64 = 0;
    for &sample in samples {
        sum += u64::from(sample.unsigned_abs());
    }
    let count = u64::try_from(samples.len()).unwrap_or(1);
    u32::try_from(sum / count).unwrap_or(u32::MAX)
}

/// Computes the linear-PCM mean absolute amplitude of a 160-byte mu-law RTP frame.
pub fn mulaw_frame_mean_abs(frame: &[u8; RTP_FRAME_SAMPLES]) -> u32 {
    let mut sum: u32 = 0;
    for &byte in frame {
        sum += u32::from(decode_mulaw(byte).unsigned_abs());
    }
    let count = u32::try_from(RTP_FRAME_SAMPLES).unwrap_or(160);
    sum / count
}

/// Stateful 3:1 low-pass Q15 FIR decimator converting streaming 24 kHz 16-bit PCM into 8 kHz PCM.
#[derive(Debug, Clone)]
pub struct Downsampler24kTo8k {
    history: [i16; FIR_TAPS],
    write_pos: usize,
    phase: u8,
    #[cfg(test)]
    pending_low_byte: Option<u8>,
}

impl Default for Downsampler24kTo8k {
    fn default() -> Self {
        Self::new()
    }
}

impl Downsampler24kTo8k {
    pub fn new() -> Self {
        Self {
            history: [0_i16; FIR_TAPS],
            write_pos: 0,
            phase: 0,
            #[cfg(test)]
            pending_low_byte: None,
        }
    }

    #[cfg(test)]
    pub fn reset(&mut self) {
        self.history.fill(0);
        self.write_pos = 0;
        self.phase = 0;
        self.pending_low_byte = None;
    }

    #[cfg(test)]
    pub fn has_pending_byte(&self) -> bool {
        self.pending_low_byte.is_some()
    }

    #[inline]
    fn push_one_sample(&mut self, sample: i16, out_8k: &mut Vec<i16>) {
        self.history[self.write_pos] = sample;
        self.write_pos += 1;
        if self.write_pos == FIR_TAPS {
            self.write_pos = 0;
        }

        self.phase += 1;
        if usize::from(self.phase) < DECIMATION_FACTOR {
            return;
        }
        self.phase = 0;

        // Fold symmetric tap pairs around the center of the 48-sample ring buffer.
        // Right after incrementing write_pos, history[write_pos] is the oldest sample.
        let mut acc: i64 = 0;
        for (tap_idx, &tap_q15) in FIR_24K_TO_8K_Q15[..(FIR_TAPS / 2)].iter().enumerate() {
            let oldest_idx = (self.write_pos + tap_idx) % FIR_TAPS;
            let newest_idx = (self.write_pos + FIR_TAPS - 1 - tap_idx) % FIR_TAPS;
            let pair_sum =
                i64::from(self.history[oldest_idx]) + i64::from(self.history[newest_idx]);
            let coeff = i64::from(tap_q15);
            acc += coeff * pair_sum;
        }

        let filtered = (acc + 16_384) >> 15;
        out_8k.push(saturate_i64_to_i16(filtered));
    }

    /// Pushes 24 kHz 16-bit signed PCM samples and appends decimated 8 kHz samples to `out_8k`.
    pub fn push_pcm24k_samples(&mut self, samples: &[i16], out_8k: &mut Vec<i16>) {
        out_8k.reserve(samples.len() / DECIMATION_FACTOR + 1);
        for &sample in samples {
            self.push_one_sample(sample, out_8k);
        }
    }

    /// Pushes arbitrary byte chunks of 24 kHz 16-bit little-endian PCM, carrying any split odd byte
    /// and decimation phase seamlessly across calls.
    #[cfg(test)]
    pub fn push_pcm24k_le_bytes(&mut self, bytes: &[u8], out_8k: &mut Vec<i16>) {
        if bytes.is_empty() {
            return;
        }
        out_8k.reserve(bytes.len() / (2 * DECIMATION_FACTOR) + 1);

        let rest = if let Some(low_byte) = self.pending_low_byte.take() {
            let sample = i16::from_le_bytes([low_byte, bytes[0]]);
            self.push_one_sample(sample, out_8k);
            &bytes[1..]
        } else {
            bytes
        };

        let chunks = rest.chunks_exact(2);
        let remainder = chunks.remainder();
        for pair in chunks {
            let sample = i16::from_le_bytes([pair[0], pair[1]]);
            self.push_one_sample(sample, out_8k);
        }

        if let Some(&leftover) = remainder.first() {
            self.pending_low_byte = Some(leftover);
        }
    }
}

/// Encodes 8 kHz mono 16-bit linear PCM samples into a complete RIFF/WAVE container.
pub fn encode_wav_8k_mono(samples: &[i16]) -> Vec<u8> {
    let max_samples = usize::try_from((u32::MAX - 36) / 2).unwrap_or(usize::MAX);
    let bounded = &samples[..samples.len().min(max_samples)];
    let data_bytes_u32 = u32::try_from(bounded.len())
        .unwrap_or(u32::MAX / 2)
        .saturating_mul(2);
    let riff_chunk_size = 36_u32.saturating_add(data_bytes_u32);
    let byte_rate = TELEPHONY_SAMPLE_RATE_HZ.saturating_mul(2);

    let mut out =
        Vec::with_capacity(WAV_HEADER_BYTES.saturating_add(bounded.len().saturating_mul(2)));
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_chunk_size.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16_u32.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&TELEPHONY_SAMPLE_RATE_HZ.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&2_u16.to_le_bytes());
    out.extend_from_slice(&16_u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_bytes_u32.to_le_bytes());

    for &sample in bounded {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VadEvent {
    BargeIn,
    UtteranceComplete(Vec<i16>),
}

#[derive(Debug, Clone)]
struct EchoEnvelopeTracker {
    outbound_energy_history: VecDeque<u32>,
    outbound_tail_frames: usize,
    last_echo_guard_active: bool,
}

impl EchoEnvelopeTracker {
    fn new() -> Self {
        Self {
            outbound_energy_history: VecDeque::with_capacity(VAD_ECHO_TAIL_FRAMES),
            outbound_tail_frames: 0,
            last_echo_guard_active: false,
        }
    }

    #[cfg(test)]
    fn reset(&mut self) {
        self.outbound_energy_history.clear();
        self.outbound_tail_frames = 0;
        self.last_echo_guard_active = false;
    }

    fn recent_peak(&self) -> u32 {
        self.outbound_energy_history
            .iter()
            .copied()
            .max()
            .unwrap_or(0)
    }

    fn is_guard_active(&self, outbound_playing: bool, outbound_mean_abs: u32) -> bool {
        outbound_playing || outbound_mean_abs > 0 || self.outbound_tail_frames > 0
    }

    fn echo_threshold(&self, outbound_mean_abs: u32) -> u32 {
        let effective_outbound_energy = outbound_mean_abs.max(self.recent_peak());
        (effective_outbound_energy / 4).saturating_add(VAD_ECHO_MARGIN)
    }

    fn record_frame(&mut self, outbound_playing: bool, outbound_mean_abs: u32) {
        if self.outbound_energy_history.len() >= VAD_ECHO_TAIL_FRAMES {
            let _ = self.outbound_energy_history.pop_front();
        }
        self.outbound_energy_history.push_back(outbound_mean_abs);
        if outbound_playing || outbound_mean_abs > 0 {
            self.outbound_tail_frames = VAD_ECHO_TAIL_FRAMES;
        } else {
            self.outbound_tail_frames = self.outbound_tail_frames.saturating_sub(1);
        }
    }

    fn update_guard_transition(&mut self, echo_guard_active: bool) -> bool {
        let changed = echo_guard_active != self.last_echo_guard_active;
        self.last_echo_guard_active = echo_guard_active;
        changed
    }
}

/// Echo-aware integer EMA voice activity and barge-in detector for 8 kHz 20 ms telephony frames.
#[derive(Debug, Clone)]
pub struct TelephonyVad {
    noise_floor_q8: i64,
    preroll: VecDeque<[i16; RTP_FRAME_SAMPLES]>,
    utterance_buf: Vec<i16>,
    in_speech: bool,
    speech_streak: usize,
    silence_frames: usize,
    barge_in_emitted: bool,
    echo_envelope: EchoEnvelopeTracker,
    ivr_mode: bool,
}

impl Default for TelephonyVad {
    fn default() -> Self {
        Self::new()
    }
}

impl TelephonyVad {
    pub fn new() -> Self {
        Self {
            noise_floor_q8: i64::from(VAD_INITIAL_NOISE_FLOOR) << 8,
            preroll: VecDeque::with_capacity(VAD_PREROLL_FRAMES),
            utterance_buf: Vec::new(),
            in_speech: false,
            speech_streak: 0,
            silence_frames: 0,
            barge_in_emitted: false,
            echo_envelope: EchoEnvelopeTracker::new(),
            ivr_mode: false,
        }
    }

    #[cfg(test)]
    pub fn reset(&mut self) {
        self.noise_floor_q8 = i64::from(VAD_INITIAL_NOISE_FLOOR) << 8;
        self.preroll.clear();
        self.utterance_buf.clear();
        self.in_speech = false;
        self.speech_streak = 0;
        self.silence_frames = 0;
        self.barge_in_emitted = false;
        self.echo_envelope.reset();
    }

    pub fn set_ivr_mode(&mut self, enabled: bool) {
        self.ivr_mode = enabled;
    }

    #[cfg(test)]
    pub fn is_ivr_mode(&self) -> bool {
        self.ivr_mode
    }

    pub fn hangover_frames(&self) -> usize {
        if self.ivr_mode {
            VAD_IVR_HANGOVER_FRAMES
        } else {
            VAD_DEFAULT_HANGOVER_FRAMES
        }
    }

    #[cfg(test)]
    pub fn is_in_speech(&self) -> bool {
        self.in_speech
    }

    pub fn has_pending_speech(&self) -> bool {
        self.in_speech || self.speech_streak > 0
    }

    pub fn noise_floor(&self) -> u32 {
        u32::try_from(self.noise_floor_q8 >> 8).unwrap_or(VAD_INITIAL_NOISE_FLOOR)
    }

    /// Computes the active speech detection threshold for the current 20 ms frame.
    pub fn speech_threshold(&self, outbound_playing: bool, outbound_mean_abs: u32) -> u32 {
        let noise_threshold = self
            .noise_floor()
            .saturating_mul(2)
            .saturating_add(VAD_BASE_SPEECH_MARGIN);
        if self
            .echo_envelope
            .is_guard_active(outbound_playing, outbound_mean_abs)
        {
            noise_threshold.max(self.echo_envelope.echo_threshold(outbound_mean_abs))
        } else {
            noise_threshold
        }
    }

    fn push_preroll(&mut self, frame: &[i16; RTP_FRAME_SAMPLES]) {
        if self.preroll.len() >= VAD_PREROLL_FRAMES {
            let _ = self.preroll.pop_front();
        }
        self.preroll.push_back(*frame);
    }

    fn append_utterance_frame(&mut self, frame: &[i16; RTP_FRAME_SAMPLES]) {
        let remaining = VAD_MAX_UTTERANCE_SAMPLES.saturating_sub(self.utterance_buf.len());
        if remaining > 0 {
            let count = remaining.min(frame.len());
            self.utterance_buf.extend_from_slice(&frame[..count]);
        }
    }

    fn update_noise_floor(&mut self, frame_energy: u32) {
        let target_q8 = i64::from(frame_energy) << 8;
        let delta = target_q8 - self.noise_floor_q8;
        let step = if delta < 0 { delta / 8 } else { delta / 32 };
        let updated = self.noise_floor_q8 + step;
        self.noise_floor_q8 =
            updated.clamp(VAD_MIN_NOISE_FLOOR_I64 << 8, VAD_MAX_NOISE_FLOOR_I64 << 8);
    }

    fn finish_utterance(&mut self) -> VadEvent {
        self.in_speech = false;
        self.speech_streak = 0;
        self.silence_frames = 0;
        self.barge_in_emitted = false;
        self.preroll.clear();
        VadEvent::UtteranceComplete(std::mem::take(&mut self.utterance_buf))
    }

    pub fn finish_after_media_quiet(&mut self) -> Option<VadEvent> {
        if self.in_speech {
            Some(self.finish_utterance())
        } else {
            self.speech_streak = 0;
            None
        }
    }

    /// Processes one 20 ms (`160`-sample) inbound 8 kHz PCM frame.
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::excessive_nesting,
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub fn process_frame(
        &mut self,
        frame: &[i16; RTP_FRAME_SAMPLES],
        outbound_playing: bool,
        outbound_mean_abs: u32,
    ) -> Option<VadEvent> {
        let frame_energy = mean_abs_pcm(frame);
        let echo_guard_active = self
            .echo_envelope
            .is_guard_active(outbound_playing, outbound_mean_abs);
        let threshold = self.speech_threshold(outbound_playing, outbound_mean_abs);
        self.echo_envelope
            .record_frame(outbound_playing, outbound_mean_abs);

        if self
            .echo_envelope
            .update_guard_transition(echo_guard_active)
            && !self.in_speech
        {
            self.speech_streak = 0;
        }
        if !outbound_playing {
            self.barge_in_emitted = false;
        }

        if !self.in_speech {
            if frame_energy >= threshold {
                self.speech_streak = self.speech_streak.saturating_add(1);
                let required_frames = if outbound_playing {
                    VAD_BARGE_IN_ONSET_FRAMES
                } else {
                    VAD_SPEECH_ONSET_FRAMES
                };
                if self.speech_streak >= required_frames {
                    self.in_speech = true;
                    self.speech_streak = 0;
                    self.silence_frames = 0;
                    self.utterance_buf.clear();
                    while let Some(prev) = self.preroll.pop_front() {
                        self.append_utterance_frame(&prev);
                    }
                    self.append_utterance_frame(frame);

                    if outbound_playing {
                        self.barge_in_emitted = true;
                        return Some(VadEvent::BargeIn);
                    }
                    return None;
                }

                self.push_preroll(frame);
                return None;
            }

            if outbound_playing {
                self.speech_streak = self.speech_streak.saturating_sub(1);
                if self.speech_streak == 0 {
                    self.preroll.clear();
                } else {
                    self.push_preroll(frame);
                }
            } else {
                self.speech_streak = 0;
                if echo_guard_active {
                    self.preroll.clear();
                } else {
                    self.update_noise_floor(frame_energy);
                    self.push_preroll(frame);
                }
            }
            return None;
        }

        // Active speech accumulation state.
        if outbound_playing && !self.barge_in_emitted {
            if frame_energy >= threshold {
                self.silence_frames = 0;
                self.speech_streak = self.speech_streak.saturating_add(1);
                self.append_utterance_frame(frame);
                if self.speech_streak >= VAD_BARGE_IN_ONSET_FRAMES {
                    self.barge_in_emitted = true;
                    self.speech_streak = 0;
                    return Some(VadEvent::BargeIn);
                }
                if self.utterance_buf.len() >= VAD_MAX_UTTERANCE_SAMPLES {
                    return Some(self.finish_utterance());
                }
                return None;
            }

            // Do not accumulate echo frames while outbound TTS plays and barge-in has not triggered.
            self.speech_streak = self.speech_streak.saturating_sub(1);
            self.silence_frames = self.silence_frames.saturating_add(1);
            if self.silence_frames >= self.hangover_frames() {
                return Some(self.finish_utterance());
            }
            return None;
        }

        self.append_utterance_frame(frame);
        if frame_energy >= threshold {
            self.silence_frames = 0;
        } else {
            self.silence_frames = self.silence_frames.saturating_add(1);
            if self.silence_frames >= self.hangover_frames() {
                return Some(self.finish_utterance());
            }
        }

        if self.utterance_buf.len() >= VAD_MAX_UTTERANCE_SAMPLES {
            return Some(self.finish_utterance());
        }
        None
    }

    /// Convenience wrapper decoding a 20 ms G.711 mu-law RTP frame before running VAD.
    pub fn process_mulaw_frame(
        &mut self,
        mulaw_frame: &[u8; RTP_FRAME_SAMPLES],
        outbound_playing: bool,
        outbound_mean_abs: u32,
    ) -> Option<VadEvent> {
        let pcm = decode_mulaw_frame(mulaw_frame);
        self.process_frame(&pcm, outbound_playing, outbound_mean_abs)
    }
}

/// Structured representation of a 4-byte RFC 4733 `telephone-event` RTP payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rfc4733DtmfPacket {
    pub event: u8,
    pub end_of_event: bool,
    pub volume: u8,
    pub duration: u16,
}

impl Rfc4733DtmfPacket {
    pub const fn new(event: u8, end_of_event: bool, volume: u8, duration: u16) -> Self {
        Self {
            event,
            end_of_event,
            volume: volume & 0x3F,
            duration,
        }
    }

    pub const fn to_bytes(self) -> [u8; 4] {
        let e_bit = if self.end_of_event {
            RFC4733_END_FLAG
        } else {
            0
        };
        let e_r_volume = e_bit | (self.volume & 0x3F);
        let [dur_hi, dur_lo] = self.duration.to_be_bytes();
        [self.event, e_r_volume, dur_hi, dur_lo]
    }

    #[cfg(test)]
    pub const fn from_bytes(bytes: [u8; 4]) -> Self {
        Self {
            event: bytes[0],
            end_of_event: (bytes[1] & RFC4733_END_FLAG) != 0,
            volume: bytes[1] & 0x3F,
            duration: u16::from_be_bytes([bytes[2], bytes[3]]),
        }
    }
}

/// Maps an ASCII DTMF character to its RFC 4733 event code (`0..=15`).
pub const fn parse_dtmf_digit(ch: char) -> Option<u8> {
    match ch {
        '0' => Some(0),
        '1' => Some(1),
        '2' => Some(2),
        '3' => Some(3),
        '4' => Some(4),
        '5' => Some(5),
        '6' => Some(6),
        '7' => Some(7),
        '8' => Some(8),
        '9' => Some(9),
        '*' => Some(10),
        '#' => Some(11),
        'A' | 'a' => Some(12),
        'B' | 'b' => Some(13),
        'C' | 'c' => Some(14),
        'D' | 'd' => Some(15),
        _ => None,
    }
}

/// Returns the ITU-T Q.23 low-group and high-group frequencies in Hz for a DTMF code (`0..=15`).
pub const fn dtmf_frequencies_hz(digit_code: u8) -> Option<(u16, u16)> {
    match digit_code {
        0 => Some((941, 1_336)),
        1 => Some((697, 1_209)),
        2 => Some((697, 1_336)),
        3 => Some((697, 1_477)),
        4 => Some((770, 1_209)),
        5 => Some((770, 1_336)),
        6 => Some((770, 1_477)),
        7 => Some((852, 1_209)),
        8 => Some((852, 1_336)),
        9 => Some((852, 1_477)),
        10 => Some((941, 1_209)),
        11 => Some((941, 1_477)),
        12 => Some((697, 1_633)),
        13 => Some((770, 1_633)),
        14 => Some((852, 1_633)),
        15 => Some((941, 1_633)),
        _ => None,
    }
}

/// Builds the 4-byte RFC 4733 `telephone-event` packet sequence for a single DTMF digit,
/// repeating the final packet 3 times with the `E` (`0x80`) end-of-event bit set.
pub fn build_rfc4733_digit_packets(
    digit_code: u8,
    step_samples: u16,
    hold_packets: u8,
) -> Vec<[u8; 4]> {
    let effective_hold = u16::from(hold_packets.max(1));
    let effective_step = step_samples.max(1);
    let non_end_count = usize::from(effective_hold.saturating_sub(1));
    let mut packets = Vec::with_capacity(non_end_count + RFC4733_END_RETRANSMIT_COUNT);

    for packet_idx in 1..effective_hold {
        let duration = packet_idx.saturating_mul(effective_step);
        packets.push(
            Rfc4733DtmfPacket::new(digit_code, false, RFC4733_DEFAULT_VOLUME, duration).to_bytes(),
        );
    }

    let final_duration = effective_hold.saturating_mul(effective_step);
    let end_bytes =
        Rfc4733DtmfPacket::new(digit_code, true, RFC4733_DEFAULT_VOLUME, final_duration).to_bytes();
    for _ in 0..RFC4733_END_RETRANSMIT_COUNT {
        packets.push(end_bytes);
    }
    packets
}

/// Computes the 32-bit wrap-around phase increment (`round(freq_hz * 2^32 / sample_rate_hz)`).
pub const fn phase_step_for_hz(freq_hz: u32, sample_rate_hz: u32) -> u32 {
    if sample_rate_hz == 0 {
        return 0;
    }
    let [f0, f1, f2, f3] = freq_hz.to_le_bytes();
    let [r0, r1, r2, r3] = sample_rate_hz.to_le_bytes();
    let freq_u64 = u64::from_le_bytes([f0, f1, f2, f3, 0, 0, 0, 0]);
    let rate_u64 = u64::from_le_bytes([r0, r1, r2, r3, 0, 0, 0, 0]);
    let quotient = ((freq_u64 << 32) + (rate_u64 / 2)) / rate_u64;
    let [q0, q1, q2, q3, _, _, _, _] = quotient.to_le_bytes();
    u32::from_le_bytes([q0, q1, q2, q3])
}

/// Evaluates `sin(phase)` in Q15 (`-32767..=32767`) using the 256-entry lookup table and
/// 8-bit integer linear interpolation.
#[inline]
pub fn sin_q15_from_phase(phase: u32) -> i16 {
    let idx = usize::from((phase >> 24).to_le_bytes()[0]);
    let next_idx = (idx + 1) & 0xFF;
    let frac = i32::from(((phase >> 16) & 0xFF).to_le_bytes()[0]);
    let s0 = i32::from(SINE_TABLE_256_Q15[idx]);
    let s1 = i32::from(SINE_TABLE_256_Q15[next_idx]);
    let interpolated = s0 + ((s1 - s0) * frac) / 256;
    saturate_i32_to_i16(interpolated)
}

/// Synthesizes in-band G.711 mu-law DTMF audio (`100 ms` dual-tone + `60 ms` silence per digit)
/// using a pure-integer Q15 dual-sine phase accumulator.
pub fn synthesize_inband_dtmf_mulaw(digits: &str) -> Result<Vec<[u8; RTP_FRAME_SAMPLES]>, String> {
    if digits.is_empty() {
        return Err("DTMF digits must not be empty".to_string());
    }

    let frames_per_digit = DTMF_TONE_FRAMES + DTMF_INTER_DIGIT_SILENCE_FRAMES;
    let mut frames = Vec::with_capacity(digits.len().saturating_mul(frames_per_digit));

    for ch in digits.chars() {
        let digit_code =
            parse_dtmf_digit(ch).ok_or_else(|| format!("unsupported DTMF character: '{ch}'"))?;
        let (low_hz, high_hz) = dtmf_frequencies_hz(digit_code)
            .ok_or_else(|| format!("unsupported DTMF event code: {digit_code}"))?;

        let low_step = phase_step_for_hz(u32::from(low_hz), TELEPHONY_SAMPLE_RATE_HZ);
        let high_step = phase_step_for_hz(u32::from(high_hz), TELEPHONY_SAMPLE_RATE_HZ);
        let mut low_phase: u32 = 0;
        let mut high_phase: u32 = 0;

        for _ in 0..DTMF_TONE_FRAMES {
            let mut frame = [MULAW_SILENCE; RTP_FRAME_SAMPLES];
            for slot in &mut frame {
                let low_sin = i32::from(sin_q15_from_phase(low_phase));
                let high_sin = i32::from(sin_q15_from_phase(high_phase));
                let mixed =
                    (low_sin * DTMF_LOW_GROUP_GAIN + high_sin * DTMF_HIGH_GROUP_GAIN) / 32_768;
                *slot = encode_mulaw(saturate_i32_to_i16(mixed));
                low_phase = low_phase.wrapping_add(low_step);
                high_phase = high_phase.wrapping_add(high_step);
            }
            frames.push(frame);
        }

        for _ in 0..DTMF_INTER_DIGIT_SILENCE_FRAMES {
            frames.push([MULAW_SILENCE; RTP_FRAME_SAMPLES]);
        }
    }

    Ok(frames)
}
