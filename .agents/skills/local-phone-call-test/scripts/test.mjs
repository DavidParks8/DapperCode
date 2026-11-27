import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createDriverLoop, McpHttpClient } from './acp-call-driver.mjs';
import {
  buildCallReportBundle,
  extractTranscriptFromCardMarkdown,
  renderTranscriptMarkdown,
  writeCallArtifacts,
} from './report.mjs';
import {
  DEFAULT_FIRST_MESSAGE,
  DEFAULT_OBJECTIVE,
  parseArgs,
  resolveVoiceConfig,
} from './run-call.mjs';
import {
  MULAW_TABLE,
  buildSipMessage,
  computeTrackStats,
  extractSdpAudioPort,
  parseRtpPayload,
  parseSipMessage,
  replaceSdpAudioPort,
  rewriteContactHeader,
  startSipRecorder,
} from './sip-recorder.mjs';

function makePcmuRtp(seq, ts, ssrc, ulawByte, payloadLen = 160) {
  const buf = Buffer.alloc(12 + payloadLen);
  buf[0] = 0x80;
  buf[1] = 0x00;
  buf.writeUInt16BE(seq, 2);
  buf.writeUInt32BE(ts, 4);
  buf.writeUInt32BE(ssrc, 8);
  buf.fill(ulawByte, 12);
  return buf;
}

test('sip-recorder relays SIP/SDP/RTP and writes synchronized WAV tracks with stats', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sip-recorder-test-'));
  const uasSip = dgram.createSocket('udp4');
  const uasRtp = dgram.createSocket('udp4');
  const uacSip = dgram.createSocket('udp4');
  const uacRtp = dgram.createSocket('udp4');
  let recorder = null;

  try {
    await Promise.all([
      new Promise((r) => uasSip.bind(0, '127.0.0.1', r)),
      new Promise((r) => uasRtp.bind(0, '127.0.0.1', r)),
      new Promise((r) => uacSip.bind(0, '127.0.0.1', r)),
      new Promise((r) => uacRtp.bind(0, '127.0.0.1', r)),
    ]);

    const seenEvents = [];
    recorder = await startSipRecorder({
      listenPort: 0,
      upstreamPort: uasSip.address().port,
      recordingsDir: tmpDir,
      filePrefix: '',
      onEvent: (ev) => seenEvents.push(ev),
    });

    let uasRtpCount = 0;
    let uacRtpCount = 0;
    uasRtp.on('message', () => {
      uasRtpCount += 1;
    });
    uacRtp.on('message', () => {
      uacRtpCount += 1;
    });

    let proxyRtpForUas = null;
    let proxyRtpForUac = null;
    let inviteCount = 0;

    uasSip.on('message', (msg, rinfo) => {
      const s = msg.toString('utf8');
      if (s.startsWith('INVITE ')) {
        inviteCount += 1;
        if (inviteCount === 1) {
          // Simulate SIP 401 auth challenge before 200 OK to ensure session stays alive.
          const unauth =
            'SIP/2.0 401 Unauthorized\r\n' +
            'Call-ID: unit-call-1\r\n' +
            'Content-Length: 0\r\n\r\n';
          uasSip.send(unauth, rinfo.port, rinfo.address);
          return;
        }
        proxyRtpForUas = extractSdpAudioPort(s);
        const sdp =
          `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n` +
          `m=audio ${uasRtp.address().port} RTP/AVP 0\r\n`;
        const ok =
          `SIP/2.0 200 OK\r\nCall-ID: unit-call-1\r\n` +
          `Contact: <sip:local@127.0.0.1:${uasSip.address().port}>\r\n` +
          `Content-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdp)}\r\n\r\n${sdp}`;
        uasSip.send(ok, rinfo.port, rinfo.address);
      } else if (s.startsWith('BYE ')) {
        const ok = 'SIP/2.0 200 OK\r\nCall-ID: unit-call-1\r\nContent-Length: 0\r\n\r\n';
        uasSip.send(ok, rinfo.port, rinfo.address);
      }
    });

    const got401 = new Promise((resolve) => {
      const onMsg = (msg) => {
        const s = msg.toString('utf8');
        if (s.startsWith('SIP/2.0 401 ')) {
          uacSip.off('message', onMsg);
          resolve();
        }
      };
      uacSip.on('message', onMsg);
    });

    const offerSdp =
      `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n` +
      `m=audio ${uacRtp.address().port} RTP/AVP 0\r\n`;
    const invite =
      `INVITE sip:+15550000002@127.0.0.1:${recorder.listenPort} SIP/2.0\r\n` +
      `Call-ID: unit-call-1\r\n` +
      `Contact: <sip:local@127.0.0.1:${uacSip.address().port}>\r\n` +
      `Content-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(offerSdp)}\r\n\r\n${offerSdp}`;

    uacSip.send(invite, recorder.listenPort, '127.0.0.1');
    await got401;

    const got200 = new Promise((resolve) => {
      const onMsg = (msg) => {
        const s = msg.toString('utf8');
        if (s.startsWith('SIP/2.0 200 OK') && s.includes('m=audio')) {
          uacSip.off('message', onMsg);
          proxyRtpForUac = extractSdpAudioPort(s);
          resolve(s);
        }
      };
      uacSip.on('message', onMsg);
    });

    uacSip.send(invite, recorder.listenPort, '127.0.0.1');
    const okText = await got200;
    assert.ok(
      okText.includes(`127.0.0.1:${recorder.listenPort}`),
      'Contact should be rewritten to proxy port',
    );
    assert.ok(proxyRtpForUac && proxyRtpForUas, 'Both RTP relay ports must be assigned');

    for (let i = 0; i < 8; i++) {
      uacRtp.send(makePcmuRtp(i, i * 160, 0x1111, 0x1e), proxyRtpForUac, '127.0.0.1');
      uasRtp.send(makePcmuRtp(i, i * 160, 0x2222, 0x9e), proxyRtpForUas, '127.0.0.1');
      await new Promise((r) => setTimeout(r, 15));
    }

    const bye =
      `BYE sip:local@127.0.0.1:${recorder.listenPort} SIP/2.0\r\n` +
      `Call-ID: unit-call-1\r\nContent-Length: 0\r\n\r\n`;
    uacSip.send(bye, recorder.listenPort, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 1200));

    const summary = recorder.stop();
    recorder = null;

    assert.equal(uasRtpCount, 8);
    assert.equal(uacRtpCount, 8);
    assert.ok(summary, 'Expected finalized recording summary');
    assert.equal(summary.tracks.ai.packets, 8);
    assert.equal(summary.tracks.user.packets, 8);
    assert.ok(summary.durationSec >= 0.15);

    for (const key of ['mixed', 'stereo', 'ai', 'user']) {
      const wavPath = summary.files[key];
      assert.ok(fs.existsSync(wavPath), `Missing ${key}.wav`);
      const buf = fs.readFileSync(wavPath);
      assert.equal(buf.subarray(0, 4).toString(), 'RIFF');
      assert.equal(buf.subarray(8, 12).toString(), 'WAVE');
      assert.equal(buf.readUInt32LE(24), 8000);
      assert.equal(buf.readUInt16LE(22), key === 'stereo' ? 2 : 1);
    }
    assert.ok(seenEvents.some((e) => e.type === 'rtp.started'));
    assert.ok(seenEvents.some((e) => e.type === 'recording.saved'));
  } finally {
    if (recorder) recorder.stop();
    uasSip.close();
    uasRtp.close();
    uacSip.close();
    uacRtp.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SIP/RTP helpers handle headers, SDP replacement, mu-law decoding, and track stats', () => {
  const sdp = 'v=0\r\nm=audio 40000 RTP/AVP 0 101\r\n';
  assert.equal(extractSdpAudioPort(sdp), 40000);
  assert.equal(replaceSdpAudioPort(sdp, 51234), 'v=0\r\nm=audio 51234 RTP/AVP 0 101\r\n');

  const rewritten = rewriteContactHeader(
    ['Via: SIP/2.0/UDP 127.0.0.1:4444', 'Contact: <sip:local@127.0.0.1:5062>'],
    5060,
  );
  assert.equal(rewritten[0], 'Via: SIP/2.0/UDP 127.0.0.1:4444');
  assert.equal(rewritten[1], 'Contact: <sip:local@127.0.0.1:5060>');

  const built = buildSipMessage(
    'INVITE sip:a@127.0.0.1 SIP/2.0',
    ['Call-ID: c1'],
    Buffer.from('abc'),
  );
  const parsed = parseSipMessage(built);
  assert.equal(parsed.callId, 'c1');
  assert.equal(parsed.body.toString('utf8'), 'abc');
  assert.ok(parsed.headers.includes('Content-Length: 3'));

  const rtp = parseRtpPayload(makePcmuRtp(7, 320, 0xabcd, 0xff, 160));
  assert.equal(rtp.payloadType, 0);
  assert.equal(rtp.sequenceNumber, 7);
  assert.equal(rtp.timestamp, 320);
  assert.equal(rtp.payload.length, 160);
  assert.equal(MULAW_TABLE[0xff], 0);

  const stats = computeTrackStats(new Int16Array([0, 1000, -1000, 32767]), 1);
  assert.equal(stats.clippedSamples, 1);
  assert.equal(stats.peakAbs, 32767);
});

test('McpHttpClient performs Streamable HTTP handshake and parses SSE or JSON tool results', async () => {
  const seenMethods = [];
  const authToken = crypto.randomBytes(12).toString('hex');
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seenMethods.push(body.method);
      if (body.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'sess-123',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-03-26' },
          }),
        );
        return;
      }
      if (body.method === 'notifications/initialized') {
        res.writeHead(202, { 'Mcp-Session-Id': 'sess-123' });
        res.end();
        return;
      }
      if (body.method === 'tools/call') {
        assert.equal(req.headers['mcp-session-id'], 'sess-123');
        assert.equal(req.headers.authorization, `Bearer ${authToken}`);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const payload = {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [
              { type: 'text', text: JSON.stringify({ callId: 'call-42', status: 'completed' }) },
            ],
          },
        };
        res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const client = new McpHttpClient(url, [
      { name: 'Authorization', value: `Bearer ${authToken}` },
    ]);
    await client.initialize();
    const res = await client.callTool('start_phone_call', {
      phoneNumber: '+15550000002',
      objective: 'Test',
    });
    assert.deepEqual(seenMethods, ['initialize', 'notifications/initialized', 'tools/call']);
    assert.deepEqual(res, { callId: 'call-42', status: 'completed' });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('report.mjs builds transcript.json and transcript.md with timings, audio stats, and turns', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'));
  try {
    const parsedCard = extractTranscriptFromCardMarkdown(
      '**Agent:** Hi! What would you like to talk about?\n**User:** Let us talk about coffee.',
    );
    assert.equal(parsedCard.length, 2);
    assert.equal(parsedCard[0].speaker, 'assistant');
    assert.equal(parsedCard[1].speaker, 'recipient');

    const bundle = buildCallReportBundle({
      metadata: {
        runId: 'call-test-01',
        startedAt: '2026-11-27T02:30:00.000Z',
        objective: DEFAULT_OBJECTIVE,
        firstMessage: DEFAULT_FIRST_MESSAGE,
        calleeName: 'User',
        context: null,
        voice: {
          sttBaseUrl: 'http://127.0.0.1:11434/v1',
          sttModel: 'gemma4:e4b',
          llmBaseUrl: 'http://127.0.0.1:11434/v1',
          llmModel: 'gemma4:e4b',
          ttsBaseUrl: 'http://127.0.0.1:11434/v1',
          ttsModel: 'phonon',
          ttsVoice: 'default',
        },
        gitCommit: 'abc1234',
        gitBranch: 'main',
      },
      timings: { approvalMs: 12, dialToConnectMs: 2400, firstRtpMs: 2500, totalMs: 12000 },
      audioSummary: {
        sampleRateHz: 8000,
        durationSec: 8.5,
        files: {
          mixed: path.join(tmpDir, 'mixed.wav'),
          stereo: path.join(tmpDir, 'stereo.wav'),
          ai: path.join(tmpDir, 'ai.wav'),
          user: path.join(tmpDir, 'user.wav'),
        },
        tracks: {
          ai: {
            packets: 425,
            peakDbfs: -3.2,
            rmsDbfs: -18.5,
            nonSilentRatio: 0.45,
            clippedSamples: 0,
          },
          user: {
            packets: 420,
            peakDbfs: -6.1,
            rmsDbfs: -24.0,
            nonSilentRatio: 0.35,
            clippedSamples: 0,
          },
        },
      },
      driverReport: {
        callId: 'call-99',
        steered: [{ at: '2026-11-27T02:30:05.000Z', instruction: 'Ask a follow-up question' }],
        finalReport: {
          status: 'completed',
          endReason: 'mobile_hangup',
          durationSeconds: 8,
          outcomeSummary: 'Friendly chat about coffee.',
          transcript: [
            {
              speaker: 'assistant',
              text: 'Hi! What do you want to talk about?',
              timestamp: '2026-11-27T02:30:02Z',
            },
            {
              speaker: 'recipient',
              text: 'Coffee brewing methods.',
              timestamp: '2026-11-27T02:30:04Z',
            },
          ],
        },
      },
      observedTranscript: parsedCard,
      events: [{ type: 'bridge.ready' }],
    });

    const md = renderTranscriptMarkdown(bundle);
    assert.ok(md.includes('Local Phone Call Test Report'));
    assert.ok(md.includes('**AI:** Hi! What do you want to talk about?'));
    assert.ok(md.includes('**User:** Coffee brewing methods.'));
    assert.ok(md.includes('Ask a follow-up question'));

    const { jsonPath, mdPath } = writeCallArtifacts(tmpDir, bundle);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(fs.existsSync(mdPath));
    const reloaded = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(reloaded.metadata.callId, 'call-99');
    assert.equal(reloaded.transcript.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('run-call CLI parsing and voice config resolution apply overrides over saved defaults', () => {
  const opts = parseArgs([
    '--llm-model',
    'gemma4:12b',
    '--tts-voice',
    'conversational-female',
    '--answer-delay',
    '2',
    '--no-interactive',
  ]);
  assert.equal(opts.objective, DEFAULT_OBJECTIVE);
  assert.equal(opts.firstMessage, DEFAULT_FIRST_MESSAGE);
  assert.equal(opts.answerDelay, 2);
  assert.equal(opts.noInteractive, true);

  const voice = resolveVoiceConfig(opts, {
    userDisplayName: 'David Parks',
    sttBaseUrl: 'http://127.0.0.1:11434/v1',
    sttModel: 'gemma4:e4b',
    llmBaseUrl: 'http://127.0.0.1:11434/v1',
    llmModel: 'gpt-oss:20b',
    ttsBaseUrl: 'http://127.0.0.1:11434/v1',
    ttsModel: 'phonon',
    ttsVoice: 'default',
  });
  assert.equal(voice.displayName, 'David Parks');
  assert.equal(voice.sttModel, 'gemma4:e4b');
  assert.equal(voice.llmModel, 'gemma4:12b');
  assert.equal(voice.ttsVoice, 'conversational-female');
});

test('createDriverLoop starts exactly one phone call and ignores follow-up session/prompt turns', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-loop-test-'));
  const reportPath = path.join(tmpDir, 'call-report.json');
  const specPath = path.join(tmpDir, 'call-spec.json');
  let startCallCount = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'drv-1' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-03-26' },
          }),
        );
        return;
      }
      if (body.method === 'notifications/initialized') {
        res.writeHead(202, { 'Mcp-Session-Id': 'drv-1' });
        res.end();
        return;
      }
      if (body.method === 'tools/call') {
        const toolName = body.params?.name;
        if (toolName === 'start_phone_call') {
          startCallCount += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      callId: 'call-once',
                      status: 'completed',
                      endReason: 'remote_hangup',
                      durationSeconds: 3,
                      transcript: [{ speaker: 'assistant', text: 'Hello!' }],
                    }),
                  },
                ],
              },
            }),
          );
        }
      }
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origSpecEnv = process.env.DAPPERCODE_CALL_TEST_SPEC;
  const responses = [];
  try {
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        phoneNumber: '+15550000002',
        objective: DEFAULT_OBJECTIVE,
        firstMessage: DEFAULT_FIRST_MESSAGE,
        reportPath,
      }),
    );
    process.env.DAPPERCODE_CALL_TEST_SPEC = specPath;

    const driver = createDriverLoop({ write: (msg) => responses.push(msg) });
    await driver.handleMessage({ id: 1, method: 'initialize', params: {} });
    await driver.handleMessage({
      id: 2,
      method: 'session/new',
      params: {
        mcpServers: [
          {
            name: 'dappercode-agent-messaging',
            url: `http://127.0.0.1:${server.address().port}/mcp`,
            headers: [],
          },
        ],
      },
    });
    const sessionId = responses.find((r) => r.id === 2).result.sessionId;
    await driver.handleMessage({ id: 3, method: 'session/prompt', params: { sessionId } });
    // Second prompt simulates post-call report delivery from dappercode-bridge.
    await driver.handleMessage({ id: 4, method: 'session/prompt', params: { sessionId } });

    assert.equal(startCallCount, 1);
    assert.equal(responses.find((r) => r.id === 4).result.stopReason, 'end_turn');
    const saved = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(saved.settled, true);
    assert.equal(saved.finalReport.status, 'completed');
  } finally {
    if (origSpecEnv === undefined) delete process.env.DAPPERCODE_CALL_TEST_SPEC;
    else process.env.DAPPERCODE_CALL_TEST_SPEC = origSpecEnv;
    await new Promise((r) => server.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
