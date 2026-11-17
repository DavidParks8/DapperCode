import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { evaluateSpeechIntelligibility, normalizeSpeech } from '../voice-intelligibility.mjs';

function fixture({ text = 'A table for six, not sixteen.', complete = true, silent = false } = {}) {
  const audio = Buffer.alloc(48);
  audio.write('RIFF');
  audio.writeUInt32LE(40, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24);
  audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(4, 40);
  audio.writeInt16LE(silent ? 0 : 1000, 44);
  return {
    reference: 'A table for six, not sixteen.',
    audio,
    recognition: {
      status: 'ok',
      text,
      model: 'independent-test-recognizer',
      audioSha256: createHash('sha256').update(audio).digest('hex'),
      prompted: false,
    },
    completion: { verified: complete, reason: 'observed final audio drain' },
  };
}

test('exact speech matching allows formatting but preserves negation, times and signs', () => {
  assert.equal(
    evaluateSpeechIntelligibility(fixture({ text: 'a table for 6 not 16' })).passed,
    true,
  );
  for (const [a, b] of [
    ['six', 'sixteen'],
    ['not six', 'six'],
    ['7 p m', '7 a m'],
    ['-6', '6'],
    ['\u22126', '6'],
    ['- 6', '6'],
    ['+ 6', '6'],
    ['.6', '6'],
    ['03', '3'],
    ['3.5', '35'],
    ["don't", 'do'],
  ]) {
    assert.notDeepEqual(normalizeSpeech(a), normalizeSpeech(b));
  }
});

test('nonzero PCM with wrong or empty recognized speech never qualifies', () => {
  for (const text of ['', 'A table for sixteen.', 'A table for six.', 'unrelated nonsense']) {
    const result = evaluateSpeechIntelligibility(fixture({ text }));
    assert.equal(result.passed, false);
    assert.ok(result.failures.includes('transcript-mismatch'));
  }
});

test('matching text cannot hide incomplete or silent audio', () => {
  assert.deepEqual(evaluateSpeechIntelligibility(fixture({ complete: false })).failures, [
    'audio-completion-unverified',
  ]);
  assert.deepEqual(evaluateSpeechIntelligibility(fixture({ silent: true })).failures, [
    'no-nonsilent-pcm',
  ]);
  const input = fixture();
  input.audio = input.audio.subarray(0, -1);
  assert.throws(() => evaluateSpeechIntelligibility(input), /incomplete|invalid/);
});

test('recognition must succeed without reference hints on the exact audio being evaluated', () => {
  for (const change of [
    { status: 'timeout' },
    { audioSha256: 'different-waveform' },
    { prompted: true },
    { text: undefined },
  ]) {
    const input = fixture();
    Object.assign(input.recognition, change);
    assert.throws(() => evaluateSpeechIntelligibility(input), /independent, unprompted ASR/);
  }
});

test('batch CLI cannot hide failed or missing utterances behind matching samples', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'speech-intelligibility-'));
  const manifestFile = path.join(directory, 'manifest.json');
  const checker = path.resolve(import.meta.dirname, '../voice-intelligibility.mjs');
  const makeSample = (id, text) => {
    const { audio, ...sample } = fixture({ text });
    writeFileSync(path.join(directory, `${id}.wav`), audio);
    return { ...sample, id, audioFile: `${id}.wav` };
  };
  try {
    const good = makeSample('good', 'A table for six, not sixteen.');
    const bad = makeSample('bad', 'A table for sixteen.');
    const run = (manifest) => {
      writeFileSync(manifestFile, JSON.stringify(manifest));
      return spawnSync(process.execPath, [checker, manifestFile], { encoding: 'utf8' });
    };
    const mixed = run({ expectedSamples: 2, samples: [good, bad] });
    assert.equal(mixed.status, 1, mixed.stderr);
    assert.equal(JSON.parse(mixed.stdout).results[1].passed, false);
    const missing = run({ expectedSamples: 2, samples: [good] });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /exactly expectedSamples/);
    const duplicate = run({ expectedSamples: 2, samples: [good, good] });
    assert.notEqual(duplicate.status, 0);
    const passing = run({ expectedSamples: 1, samples: [good] });
    assert.equal(passing.status, 0, passing.stderr);
    assert.equal(JSON.parse(passing.stdout).passed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
