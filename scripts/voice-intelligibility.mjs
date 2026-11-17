import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SMALL_NUMBERS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

export function normalizeSpeech(text) {
  if (typeof text !== 'string') throw new TypeError('speech text must be a string');
  const tokens =
    text
      .normalize('NFKC')
      .toLowerCase()
      .replaceAll('\u2019', "'")
      .replaceAll('\u2212', '-')
      .replace(/([+-])\s+(?=\d)/gu, '$1')
      .match(/[+-]?(?:\d+(?:[.,:]\d+)*|\.\d+)|\p{L}+(?:'\p{L}+)*|[$€£%]/gu) ?? [];
  return tokens.flatMap((token) => {
    if (!/^[+-]?\d+$/.test(token)) return [token];
    const unsigned = token.replace(/^[+-]/, '');
    if (unsigned.length > 1 && unsigned.startsWith('0')) return [token];
    const number = Number(unsigned);
    if (number >= SMALL_NUMBERS.length) return [token];
    const sign = token.startsWith('-') ? ['minus'] : token.startsWith('+') ? ['plus'] : [];
    return [...sign, SMALL_NUMBERS[number]];
  });
}

function wordEdits(reference, actual) {
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (const [row, word] of reference.entries()) {
    const current = [row + 1];
    for (const [column, observed] of actual.entries()) {
      current.push(
        Math.min(
          previous[column + 1] + 1,
          current[column] + 1,
          previous[column] + Number(word !== observed),
        ),
      );
    }
    previous = current;
  }
  return previous[actual.length];
}

export function inspectSpeechWav(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('audio must be a WAV Buffer');
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    throw new Error('incomplete or invalid RIFF WAV');
  }
  let format, channels, rate, bits, data;
  let offset = 12;
  for (; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) throw new Error('truncated WAV chunk');
    const kind = bytes.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ') {
      if (format !== undefined || size < 16) throw new Error('invalid WAV format chunk');
      format = bytes.readUInt16LE(start);
      channels = bytes.readUInt16LE(start + 2);
      rate = bytes.readUInt32LE(start + 4);
      bits = bytes.readUInt16LE(start + 14);
    } else if (kind === 'data') {
      if (data !== undefined) throw new Error('multiple WAV data chunks');
      data = bytes.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (offset !== bytes.length) throw new Error('incomplete WAV chunk header or padding');
  if (
    !data ||
    channels !== 1 ||
    ![8000, 16000, 24000, 48000].includes(rate) ||
    !((format === 1 && bits === 16) || (format === 3 && bits === 32)) ||
    data.length === 0 ||
    data.length % (bits / 8) !== 0
  ) {
    throw new Error('expected nonempty mono PCM16 or float32 WAV with complete samples');
  }
  let nonzero = false;
  for (let offset = 0; offset < data.length; offset += bits / 8) {
    const value = format === 1 ? data.readInt16LE(offset) : data.readFloatLE(offset);
    if (!Number.isFinite(value)) throw new Error('non-finite PCM sample');
    nonzero ||= Math.abs(value) > (format === 1 ? 0 : 1 / 32768);
  }
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sampleRate: rate,
    samples: data.length / (bits / 8),
    durationSeconds: data.length / (bits / 8) / rate,
    nonzero,
  };
}

export function evaluateSpeechIntelligibility({ reference, audio, recognition, completion }) {
  const expected = normalizeSpeech(reference);
  if (expected.length === 0) throw new Error('reference must contain spoken words');
  const waveform = inspectSpeechWav(audio);
  if (
    !recognition ||
    recognition.status !== 'ok' ||
    typeof recognition.text !== 'string' ||
    typeof recognition.model !== 'string' ||
    !recognition.model ||
    recognition.audioSha256 !== waveform.sha256 ||
    recognition.prompted !== false
  ) {
    throw new Error('successful independent, unprompted ASR of this exact waveform is required');
  }
  const observed = normalizeSpeech(recognition.text);
  const edits = wordEdits(expected, observed);
  const failures = [];
  if (!completion || completion.verified !== true || !completion.reason?.trim()) {
    failures.push('audio-completion-unverified');
  }
  if (!waveform.nonzero) failures.push('no-nonsilent-pcm');
  if (observed.length === 0) failures.push('empty-recognition');
  if (edits !== 0) failures.push('transcript-mismatch');
  return {
    passed: failures.length === 0,
    failures,
    reference,
    recognizedText: recognition.text,
    normalizedReference: expected.join(' '),
    normalizedRecognition: observed.join(' '),
    wordEdits: edits,
    referenceWords: expected.length,
    wordErrorRate: edits / expected.length,
    waveform,
    recognizer: recognition.model,
    completion,
    listeningQuality: 'unverified',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestPath = path.resolve(process.argv[2] ?? '');
  if (!process.argv[2])
    throw new Error('usage: node scripts/voice-intelligibility.mjs <manifest.json>');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    !Number.isSafeInteger(manifest.expectedSamples) ||
    manifest.expectedSamples < 1 ||
    !Array.isArray(manifest.samples) ||
    manifest.samples.length !== manifest.expectedSamples
  ) {
    throw new Error('manifest must contain exactly expectedSamples entries');
  }
  const ids = new Set();
  const results = manifest.samples.map((sample) => {
    if (typeof sample.id !== 'string' || !sample.id || ids.has(sample.id)) {
      throw new Error('every sample must have a unique nonempty id');
    }
    ids.add(sample.id);
    return {
      id: sample.id,
      ...evaluateSpeechIntelligibility({
        ...sample,
        audio: readFileSync(path.resolve(path.dirname(manifestPath), sample.audioFile)),
      }),
    };
  });
  const passed = results.every((result) => result.passed);
  console.log(JSON.stringify({ passed, expectedSamples: manifest.expectedSamples, results }));
  if (!passed) process.exitCode = 1;
}
