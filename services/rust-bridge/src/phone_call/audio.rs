#![forbid(unsafe_code)]

use std::collections::VecDeque;

pub const TELEPHONY_SAMPLE_RATE_HZ: u32 = 8_000;
#[cfg(test)]
pub const TTS_PCM_SAMPLE_RATE_HZ: u32 = 24_000;
pub const RTP_FRAME_SAMPLES: usize = 160;
#[cfg(test)]
pub const RTP_FRAME_DURATION_MS: u32 = 20;
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
#[cfg(test)]
pub const VAD_PREROLL_SAMPLES: usize = VAD_PREROLL_FRAMES * RTP_FRAME_SAMPLES;
pub const VAD_SPEECH_ONSET_FRAMES: usize = 7;
pub const VAD_BARGE_IN_ONSET_FRAMES: usize = 12;
pub const VAD_DEFAULT_HANGOVER_FRAMES: usize = 30;
pub const VAD_IVR_HANGOVER_FRAMES: usize = 55;
pub const VAD_MAX_UTTERANCE_SAMPLES: usize = 200_000;
pub const VAD_ECHO_MARGIN: u32 = 500;

const VAD_INITIAL_NOISE_FLOOR: u32 = 80;
const VAD_MIN_NOISE_FLOOR_I64: i64 = 40;
const VAD_MAX_NOISE_FLOOR_I64: i64 = 1_200;
const VAD_BASE_SPEECH_MARGIN: u32 = 160;

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

/// Scales a hot neural TTS PCM sample down by `-12.04 dBFS` (`TTS_HEADROOM_GAIN_Q15`) in Q15
/// integer math before encoding to ITU-T G.711 mu-law.
#[inline]
pub fn encode_mulaw_with_headroom(sample: i16) -> u8 {
    let scaled = (i32::from(sample) * TTS_HEADROOM_GAIN_Q15) / 32_768;
    encode_mulaw(saturate_i32_to_i16(scaled))
}

/// Encodes a 20 ms (`160`-sample) 8 kHz PCM frame into G.711 mu-law without additional attenuation.
#[cfg(test)]
pub fn encode_mulaw_frame(input: &[i16; RTP_FRAME_SAMPLES]) -> [u8; RTP_FRAME_SAMPLES] {
    let mut out = [MULAW_SILENCE; RTP_FRAME_SAMPLES];
    for (dst, &src) in out.iter_mut().zip(input.iter()) {
        *dst = encode_mulaw(src);
    }
    out
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
    last_outbound_playing: bool,
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
            last_outbound_playing: false,
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
        self.last_outbound_playing = false;
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

    pub fn is_in_speech(&self) -> bool {
        self.in_speech
    }

    pub fn noise_floor(&self) -> u32 {
        u32::try_from(self.noise_floor_q8 >> 8).unwrap_or(VAD_INITIAL_NOISE_FLOOR)
    }

    /// Computes the active speech detection threshold for the current 20 ms frame.
    pub fn speech_threshold(&self, outbound_playing: bool, outbound_mean_abs: u32) -> u32 {
        let noise_threshold = self
            .noise_floor()
            .saturating_mul(3)
            .saturating_add(VAD_BASE_SPEECH_MARGIN);
        if outbound_playing {
            let echo_threshold = (outbound_mean_abs / 4).saturating_add(VAD_ECHO_MARGIN);
            noise_threshold.max(echo_threshold)
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

    /// Processes one 20 ms (`160`-sample) inbound 8 kHz PCM frame.
    pub fn process_frame(
        &mut self,
        frame: &[i16; RTP_FRAME_SAMPLES],
        outbound_playing: bool,
        outbound_mean_abs: u32,
    ) -> Option<VadEvent> {
        let frame_energy = mean_abs_pcm(frame);
        let threshold = self.speech_threshold(outbound_playing, outbound_mean_abs);

        if !self.in_speech && outbound_playing != self.last_outbound_playing {
            self.speech_streak = 0;
        }
        if !outbound_playing {
            self.barge_in_emitted = false;
        }
        self.last_outbound_playing = outbound_playing;

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

            self.speech_streak = 0;
            if !outbound_playing {
                self.update_noise_floor(frame_energy);
            }
            self.push_preroll(frame);
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
            self.speech_streak = 0;
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

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

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
            let s = (i32::from(sin_q15_from_phase(phase)) * i32::from(amplitude)) / 32_767;
            out.push(saturate_i32_to_i16(s));
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
                    "failed round-trip for codeword {byte:#04X}"
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
            "unexpected headroom decoded level: {pos_headroom}"
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
            "passband mean {pass_mean} drifted from input mean {in_mean}"
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
            "insufficient stopband attenuation: stop_mean={stop_mean}, stop_peak={stop_peak}, pass_mean={pass_mean}"
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
                "mismatch for odd byte chunk size {chunk_size}"
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
            36 + 10
        );
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes([wav[16], wav[17], wav[18], wav[19]]), 16);
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1);
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            TELEPHONY_SAMPLE_RATE_HZ
        );
        assert_eq!(
            u32::from_le_bytes([wav[28], wav[29], wav[30], wav[31]]),
            TELEPHONY_SAMPLE_RATE_HZ * 2
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

        // Feed 29 silence frames: still inside 30-frame (600 ms) hangover.
        let silence_frame = [0_i16; RTP_FRAME_SAMPLES];
        for _ in 0..(VAD_DEFAULT_HANGOVER_FRAMES - 1) {
            assert_eq!(vad.process_frame(&silence_frame, false, 0), None);
            assert!(vad.is_in_speech());
        }

        // 30th silence frame completes the utterance!
        let event = vad.process_frame(&silence_frame, false, 0);
        assert!(!vad.is_in_speech());
        let utterance = match event {
            Some(VadEvent::UtteranceComplete(buf)) => buf,
            other => panic!("expected UtteranceComplete, got {other:?}"),
        };

        // Pre-roll at onset (7th speech frame) held 9 pre-speech frames (markers 12..=20) + 6 speech frames,
        // followed by 4 remaining speech frames + 30 hangover silence frames = 49 frames = 7840 samples.
        assert_eq!(utterance.len(), 49 * RTP_FRAME_SAMPLES);
        // First frame of the utterance must be pre-speech frame marker 12 (9 frames = 180 ms before speech frame 1,
        // i.e. 15 frames = 300 ms before the 7th onset frame!).
        assert_eq!(utterance[0], 12);
        assert_eq!(utterance[8 * RTP_FRAME_SAMPLES], 20);
        assert_eq!(utterance[9 * RTP_FRAME_SAMPLES], 2_400);

        // Verify IVR mode extends hangover from 30 frames (600 ms) to 55 frames (1100 ms).
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
                None
            );
            assert!(!vad.is_in_speech());
        }

        // Brief loud spike (8 frames < 12 required frames) while TTS plays must ALSO be ignored.
        let loud_human_frame = [2_800_i16; RTP_FRAME_SAMPLES];
        for _ in 0..8 {
            assert_eq!(
                vad.process_frame(&loud_human_frame, true, outbound_mean_abs),
                None
            );
            assert!(!vad.is_in_speech());
        }
        // Drop back to echo resets the barge-in streak; trailing silence must NOT emit any echo utterance.
        assert_eq!(
            vad.process_frame(&echo_frame, true, outbound_mean_abs),
            None
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
                "premature barge-in at frame {step}"
            );
        }
        assert_eq!(
            vad.process_frame(&loud_human_frame, true, outbound_mean_abs),
            Some(VadEvent::BargeIn)
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
            4 * (DTMF_TONE_FRAMES + DTMF_INTER_DIGIT_SILENCE_FRAMES)
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
            0
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
            "expected raised noise floor between {initial_floor} and 180, got {raised_floor}"
        );

        let silence = [0_i16; RTP_FRAME_SAMPLES];
        for _ in 0..60 {
            assert_eq!(vad.process_frame(&silence, false, 0), None);
        }
        let lowered_floor = vad.noise_floor();
        assert!(
            lowered_floor < raised_floor && lowered_floor >= 40,
            "expected lowered noise floor >= 40 and < {raised_floor}, got {lowered_floor}"
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
            let s = i128::from(sample);
            re_acc += s * cos_q15;
            im_acc += s * sin_q15;
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
        let frames =
            synthesize_inband_dtmf_mulaw(all_digits).expect("synthesize all 16 DTMF digits");
        let stride = DTMF_TONE_FRAMES + DTMF_INTER_DIGIT_SILENCE_FRAMES;
        assert_eq!(frames.len(), all_digits.len() * stride);

        let row_group: [u16; 4] = [697, 770, 852, 941];
        let col_group: [u16; 4] = [1_209, 1_336, 1_477, 1_633];

        for (digit_idx, ch) in all_digits.chars().enumerate() {
            let code = parse_dtmf_digit(ch).expect("valid digit");
            let (expected_low, expected_high) =
                dtmf_frequencies_hz(code).expect("valid frequencies");

            let mut decoded_tone = Vec::with_capacity(DTMF_TONE_FRAMES * RTP_FRAME_SAMPLES);
            let base = digit_idx * stride;
            for frame in &frames[base..(base + DTMF_TONE_FRAMES)] {
                decoded_tone.extend_from_slice(&decode_mulaw_frame(frame));
            }

            let best_row = row_group
                .iter()
                .copied()
                .max_by_key(|&hz| {
                    correlate_frequency_power(
                        &decoded_tone,
                        u32::from(hz),
                        TELEPHONY_SAMPLE_RATE_HZ,
                    )
                })
                .expect("row group non-empty");
            let best_col = col_group
                .iter()
                .copied()
                .max_by_key(|&hz| {
                    correlate_frequency_power(
                        &decoded_tone,
                        u32::from(hz),
                        TELEPHONY_SAMPLE_RATE_HZ,
                    )
                })
                .expect("col group non-empty");

            assert_eq!(
                best_row, expected_low,
                "wrong low-group frequency for '{ch}'"
            );
            assert_eq!(
                best_col, expected_high,
                "wrong high-group frequency for '{ch}'"
            );
        }
    }

    #[test]
    fn end_to_end_24k_tts_to_mulaw_rtp_to_vad_wav_roundtrip() {
        assert_eq!(
            (TELEPHONY_SAMPLE_RATE_HZ * RTP_FRAME_DURATION_MS) / 1_000,
            u32::try_from(RTP_FRAME_SAMPLES).unwrap_or(0)
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
}
