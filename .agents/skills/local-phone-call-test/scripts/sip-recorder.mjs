#!/usr/bin/env node
// Transparent local SIP/RTP recording proxy for DapperCode local phone-call tests.
// Relays UDP SIP and G.711 PCMU (PT=0) RTP between dappercode-bridge and a local SIP
// softphone (e.g. baresip), recording synchronized 8 kHz PCM16 WAV tracks (mixed, stereo,
// ai-only, user-only) plus per-track audio level statistics.

import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SAMPLE_RATE = 8000;
const MAX_CALL_SECONDS = 30 * 60;
const MAX_SAMPLES = SAMPLE_RATE * MAX_CALL_SECONDS;
const FLUSH_INTERVAL_MS = 3000;
const IDLE_FINALIZE_MS = 8000;

// Standard ITU-T G.711 mu-law decoding table (256 entries -> signed 16-bit PCM).
export const MULAW_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  MULAW_TABLE[i] = sign ? -sample : sample;
}

export function parseSipMessage(buf) {
  const sepIdx = buf.indexOf('\r\n\r\n');
  if (sepIdx === -1) return null;
  const headerStr = buf.subarray(0, sepIdx).toString('utf8');
  const body = buf.subarray(sepIdx + 4);
  const lines = headerStr.split('\r\n');
  const startLine = lines[0] || '';
  const headers = lines.slice(1);
  let callId = null;
  for (const line of headers) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name === 'call-id' || name === 'i') {
      callId = line.slice(colon + 1).trim();
      break;
    }
  }
  return { startLine, headers, body, callId };
}

export function buildSipMessage(startLine, headers, bodyBuf) {
  let hasContentLength = false;
  const updated = headers.map((line) => {
    const colon = line.indexOf(':');
    if (colon !== -1) {
      const name = line.slice(0, colon).trim().toLowerCase();
      if (name === 'content-length' || name === 'l') {
        hasContentLength = true;
        return `Content-Length: ${bodyBuf.length}`;
      }
    }
    return line;
  });
  if (!hasContentLength) {
    updated.push(`Content-Length: ${bodyBuf.length}`);
  }
  const headBuf = Buffer.from(`${startLine}\r\n${updated.join('\r\n')}\r\n\r\n`, 'utf8');
  return Buffer.concat([headBuf, bodyBuf]);
}

export function extractSdpAudioPort(sdpStr) {
  const match = sdpStr.match(/^m=audio\s+(\d+)\s+/m);
  return match ? Number(match[1]) : null;
}

export function replaceSdpAudioPort(sdpStr, newPort) {
  return sdpStr.replace(/^(m=audio\s+)\d+(\s+)/m, `$1${newPort}$2`);
}

export function rewriteContactHeader(headers, targetPort) {
  return headers.map((line) => {
    const colon = line.indexOf(':');
    if (colon === -1) return line;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name !== 'contact' && name !== 'm') return line;
    return line.replace(/127\.0\.0\.1:\d+/g, `127.0.0.1:${targetPort}`);
  });
}

export function parseRtpPayload(packet) {
  if (packet.length < 12) return null;
  const version = (packet[0] >> 6) & 0x03;
  if (version !== 2) return null;
  const padding = (packet[0] >> 5) & 0x01;
  const extension = (packet[0] >> 4) & 0x01;
  const csrcCount = packet[0] & 0x0f;
  const payloadType = packet[1] & 0x7f;
  const sequenceNumber = packet.readUInt16BE(2);
  const timestamp = packet.readUInt32BE(4);
  const ssrc = packet.readUInt32BE(8);
  let offset = 12 + csrcCount * 4;
  if (extension) {
    if (packet.length < offset + 4) return null;
    const extWords = packet.readUInt16BE(offset + 2);
    offset += 4 + extWords * 4;
  }
  let end = packet.length;
  if (padding && end > offset) {
    const padLen = packet[end - 1];
    end = Math.max(offset, end - padLen);
  }
  if (offset >= end) return null;
  return { payloadType, sequenceNumber, timestamp, ssrc, payload: packet.subarray(offset, end) };
}

export function computeTrackStats(samples, packetCount) {
  if (samples.length === 0) {
    return {
      packets: packetCount,
      samples: 0,
      durationSec: 0,
      peakAbs: 0,
      peakDbfs: null,
      rmsDbfs: null,
      clippedSamples: 0,
      nonSilentRatio: 0,
    };
  }
  let peakAbs = 0;
  let sumSq = 0;
  let clippedSamples = 0;
  let nonSilent = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const abs = s < 0 ? -s : s;
    if (abs > peakAbs) peakAbs = abs;
    if (abs >= 32760) clippedSamples += 1;
    if (abs >= 120) nonSilent += 1;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  const toDbfs = (v) => (v > 0 ? Number((20 * Math.log10(v / 32768)).toFixed(2)) : null);
  return {
    packets: packetCount,
    samples: samples.length,
    durationSec: Number((samples.length / SAMPLE_RATE).toFixed(3)),
    peakAbs,
    peakDbfs: toDbfs(peakAbs),
    rmsDbfs: toDbfs(rms),
    clippedSamples,
    nonSilentRatio: Number((nonSilent / samples.length).toFixed(4)),
  };
}

export function writeWavFile(filePath, channels, sampleRate, interleavedInt16) {
  const dataBytes = interleavedInt16.byteLength;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  const pcmBuf = Buffer.from(
    interleavedInt16.buffer,
    interleavedInt16.byteOffset,
    interleavedInt16.byteLength,
  );
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, Buffer.concat([header, pcmBuf]));
  fs.renameSync(tmpPath, filePath);
}

class TrackBuffer {
  constructor() {
    this.chunks = [];
    this.lastSsrc = null;
    this.lastTs = null;
    this.nextSample = 0;
    this.maxSample = 0;
    this.packetCount = 0;
  }

  append(nowMs, callStartMs, ssrc, rtpTs, payload) {
    if (payload.length === 0) return;
    const samples = new Int16Array(payload.length);
    for (let i = 0; i < payload.length; i++) {
      samples[i] = MULAW_TABLE[payload[i]];
    }
    const wallSample = Math.max(0, Math.round(((nowMs - callStartMs) * SAMPLE_RATE) / 1000));
    let startSample;
    if (this.lastSsrc === null || this.lastSsrc !== ssrc) {
      startSample = Math.max(this.nextSample, wallSample);
    } else {
      const tsDelta = (rtpTs - this.lastTs) >>> 0;
      if (tsDelta > 0 && tsDelta < SAMPLE_RATE * 30) {
        startSample = this.nextSample + (tsDelta - payload.length);
        if (Math.abs(startSample - wallSample) > SAMPLE_RATE * 1.5) {
          startSample = wallSample;
        }
        if (startSample < 0) startSample = 0;
      } else if (tsDelta === 0) {
        startSample = this.nextSample;
      } else {
        startSample = wallSample;
      }
    }
    if (startSample >= MAX_SAMPLES) return;
    const usableLen = Math.min(samples.length, MAX_SAMPLES - startSample);
    const clipped = usableLen === samples.length ? samples : samples.subarray(0, usableLen);
    this.chunks.push({ startSample, samples: clipped });
    this.lastSsrc = ssrc;
    this.lastTs = rtpTs;
    this.nextSample = startSample + clipped.length;
    if (this.nextSample > this.maxSample) this.maxSample = this.nextSample;
    this.packetCount += 1;
  }

  render(totalSamples) {
    const out = new Int16Array(totalSamples);
    for (const chunk of this.chunks) {
      const end = Math.min(totalSamples, chunk.startSample + chunk.samples.length);
      for (let i = chunk.startSample, j = 0; i < end; i++, j++) {
        out[i] = chunk.samples[j];
      }
    }
    return out;
  }
}

function formatStamp(date) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Starts a local UDP SIP/RTP transparent recording proxy.
 *
 * When `filePrefix` is provided (e.g. `""` for flat `mixed.wav`/`stereo.wav`/`ai.wav`/`user.wav`
 * inside a per-call directory), files are named `<prefix>mixed.wav`, etc.
 * When `filePrefix` is null/undefined, each call gets a timestamped prefix `call-<stamp>-NN-`.
 */
export async function startSipRecorder({
  listenHost = '127.0.0.1',
  listenPort = 0,
  upstreamHost = '127.0.0.1',
  upstreamPort,
  recordingsDir,
  filePrefix = null,
  onEvent = null,
}) {
  if (!upstreamPort) throw new Error('upstreamPort is required');
  if (!recordingsDir) throw new Error('recordingsDir is required');
  fs.mkdirSync(recordingsDir, { recursive: true });

  const emit = (type, payload) => {
    if (typeof onEvent === 'function') {
      onEvent({ type, at: new Date().toISOString(), ...payload });
    }
  };

  const calls = new Map();
  const completedSummaries = [];
  let callCounter = 0;

  class CallSession {
    constructor(callId, bridgeSipAddr, bridgeSipPort) {
      this.callId = callId;
      this.bridgeSipAddr = bridgeSipAddr;
      this.bridgeSipPort = bridgeSipPort;
      this.bridgeRtpPort = null;
      this.baresipRtpPort = null;
      this.startedAt = new Date();
      callCounter += 1;
      this.prefix =
        filePrefix !== null
          ? filePrefix
          : `call-${formatStamp(this.startedAt)}-${String(callCounter).padStart(2, '0')}-`;
      this.firstRtpMs = null;
      this.lastRtpMs = null;
      this.aiTrack = new TrackBuffer();
      this.userTrack = new TrackBuffer();
      this.closed = false;
      this.dirty = false;
      this.endedSignal = false;
      this.lastSummary = null;

      this.rtpForBridge = dgram.createSocket('udp4');
      this.rtpForBaresip = dgram.createSocket('udp4');

      this.rtpForBridge.on('message', (msg) => {
        if (this.baresipRtpPort) {
          this.rtpForBaresip.send(msg, this.baresipRtpPort, upstreamHost);
        }
        this.capture('ai', msg);
      });

      this.rtpForBaresip.on('message', (msg) => {
        if (this.bridgeRtpPort) {
          this.rtpForBridge.send(msg, this.bridgeRtpPort, this.bridgeSipAddr);
        }
        this.capture('user', msg);
      });

      this.ready = Promise.all([
        new Promise((resolve) => this.rtpForBridge.bind(0, listenHost, resolve)),
        new Promise((resolve) => this.rtpForBaresip.bind(0, listenHost, resolve)),
      ]).then(() => {
        this.rtpForBridgePort = this.rtpForBridge.address().port;
        this.rtpForBaresipPort = this.rtpForBaresip.address().port;
      });

      this.flushTimer = setInterval(() => {
        if (this.dirty) this.flush('periodic');
        if (this.lastRtpMs && Date.now() - this.lastRtpMs > IDLE_FINALIZE_MS && this.endedSignal) {
          this.finalize('idle-after-bye');
        }
      }, FLUSH_INTERVAL_MS);
    }

    capture(side, msg) {
      const rtp = parseRtpPayload(msg);
      if (!rtp || rtp.payloadType !== 0) return;
      const now = Date.now();
      if (this.firstRtpMs === null) {
        this.firstRtpMs = now;
        emit('rtp.started', { callId: this.callId, firstRtpAt: new Date(now).toISOString() });
      }
      this.lastRtpMs = now;
      const track = side === 'ai' ? this.aiTrack : this.userTrack;
      track.append(now, this.firstRtpMs, rtp.ssrc, rtp.timestamp, rtp.payload);
      this.dirty = true;
    }

    flush(reason) {
      const totalSamples = Math.max(this.aiTrack.maxSample, this.userTrack.maxSample);
      if (totalSamples === 0) return null;
      const ai = this.aiTrack.render(totalSamples);
      const user = this.userTrack.render(totalSamples);

      const mixed = new Int16Array(totalSamples);
      const stereo = new Int16Array(totalSamples * 2);
      for (let i = 0; i < totalSamples; i++) {
        let sum = ai[i] + user[i];
        if (sum > 32767) sum = 32767;
        else if (sum < -32768) sum = -32768;
        mixed[i] = sum;
        stereo[i * 2] = ai[i];
        stereo[i * 2 + 1] = user[i];
      }

      const files = {
        mixed: path.join(recordingsDir, `${this.prefix}mixed.wav`),
        stereo: path.join(recordingsDir, `${this.prefix}stereo.wav`),
        ai: path.join(recordingsDir, `${this.prefix}ai.wav`),
        user: path.join(recordingsDir, `${this.prefix}user.wav`),
      };

      writeWavFile(files.mixed, 1, SAMPLE_RATE, mixed);
      writeWavFile(files.stereo, 2, SAMPLE_RATE, stereo);
      writeWavFile(files.ai, 1, SAMPLE_RATE, ai);
      writeWavFile(files.user, 1, SAMPLE_RATE, user);

      this.dirty = false;
      const summary = {
        callId: this.callId,
        sampleRateHz: SAMPLE_RATE,
        durationSec: Number((totalSamples / SAMPLE_RATE).toFixed(3)),
        files,
        tracks: {
          ai: computeTrackStats(ai, this.aiTrack.packetCount),
          user: computeTrackStats(user, this.userTrack.packetCount),
          mixed: computeTrackStats(mixed, this.aiTrack.packetCount + this.userTrack.packetCount),
        },
        reason,
      };
      this.lastSummary = summary;
      if (reason !== 'periodic') {
        emit('recording.saved', summary);
      }
      return summary;
    }

    finalize(reason) {
      if (this.closed) return this.lastSummary;
      this.closed = true;
      clearInterval(this.flushTimer);
      const summary = this.flush(reason);
      if (summary) completedSummaries.push(summary);
      try {
        this.rtpForBridge.close();
      } catch {}
      try {
        this.rtpForBaresip.close();
      } catch {}
      calls.delete(this.callId);
      return summary;
    }
  }

  const sipFront = dgram.createSocket('udp4');
  const sipBack = dgram.createSocket('udp4');

  let lastBridgeAddr = listenHost;
  let lastBridgePort = null;
  let boundListenPort = listenPort;

  sipFront.on('message', async (msg, rinfo) => {
    lastBridgeAddr = rinfo.address;
    lastBridgePort = rinfo.port;

    const parsed = parseSipMessage(msg);
    if (!parsed || !parsed.callId) {
      sipBack.send(msg, upstreamPort, upstreamHost);
      return;
    }

    let session = calls.get(parsed.callId);
    if (!session) {
      session = new CallSession(parsed.callId, rinfo.address, rinfo.port);
      calls.set(parsed.callId, session);
    } else {
      session.bridgeSipAddr = rinfo.address;
      session.bridgeSipPort = rinfo.port;
    }
    await session.ready;

    const backPort = sipBack.address().port;
    const headers = rewriteContactHeader(parsed.headers, backPort);
    let body = parsed.body;
    const sdpStr = body.toString('utf8');
    const bridgeRtpPort = extractSdpAudioPort(sdpStr);
    if (bridgeRtpPort) {
      session.bridgeRtpPort = bridgeRtpPort;
      body = Buffer.from(replaceSdpAudioPort(sdpStr, session.rtpForBaresipPort), 'utf8');
    }

    const out = buildSipMessage(parsed.startLine, headers, body);
    sipBack.send(out, upstreamPort, upstreamHost);
    emit('sip.tx', {
      direction: 'bridge->callee',
      startLine: parsed.startLine,
      callId: parsed.callId,
    });

    if (/^(BYE|CANCEL)\s/i.test(parsed.startLine)) {
      session.endedSignal = true;
      setTimeout(() => session.finalize('bridge-bye'), 1000).unref();
    }
  });

  sipBack.on('message', async (msg) => {
    const parsed = parseSipMessage(msg);
    if (!parsed) {
      if (lastBridgePort) sipFront.send(msg, lastBridgePort, lastBridgeAddr);
      return;
    }

    const session = parsed.callId ? calls.get(parsed.callId) : null;
    const targetAddr = session ? session.bridgeSipAddr : lastBridgeAddr;
    const targetPort = session ? session.bridgeSipPort : lastBridgePort;
    if (!targetPort) return;

    const headers = rewriteContactHeader(parsed.headers, boundListenPort);
    let body = parsed.body;
    if (session) {
      await session.ready;
      const sdpStr = body.toString('utf8');
      const baresipRtpPort = extractSdpAudioPort(sdpStr);
      if (baresipRtpPort) {
        session.baresipRtpPort = baresipRtpPort;
        body = Buffer.from(replaceSdpAudioPort(sdpStr, session.rtpForBridgePort), 'utf8');
      }
    }

    const out = buildSipMessage(parsed.startLine, headers, body);
    sipFront.send(out, targetPort, targetAddr);
    emit('sip.rx', {
      direction: 'callee->bridge',
      startLine: parsed.startLine,
      callId: parsed.callId,
    });

    if (
      session &&
      (/^BYE\s/i.test(parsed.startLine) || /^SIP\/2\.0\s+[456]\d\d\s/i.test(parsed.startLine))
    ) {
      if (/^BYE\s/i.test(parsed.startLine) || !/^SIP\/2\.0\s+(401|407)\s/i.test(parsed.startLine)) {
        session.endedSignal = true;
        setTimeout(() => session.finalize('upstream-end'), 1000).unref();
      }
    }
  });

  await Promise.all([
    new Promise((resolve) => sipFront.bind(listenPort, listenHost, resolve)),
    new Promise((resolve) => sipBack.bind(0, listenHost, resolve)),
  ]);
  boundListenPort = sipFront.address().port;

  return {
    listenHost,
    listenPort: boundListenPort,
    upstreamHost,
    upstreamPort,
    recordingsDir,
    getLatestSummary() {
      for (const session of calls.values()) {
        if (session.dirty) session.flush('snapshot');
        if (session.lastSummary) return session.lastSummary;
      }
      return completedSummaries.at(-1) || null;
    },
    stop() {
      for (const session of [...calls.values()]) {
        session.finalize('shutdown');
      }
      try {
        sipFront.close();
      } catch {}
      try {
        sipBack.close();
      } catch {}
      return completedSummaries.at(-1) || null;
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const listenPort = Number(process.env.SIP_RECORDER_PORT || 5060);
  const upstreamHost = process.env.SIP_UPSTREAM_HOST || '127.0.0.1';
  const upstreamPort = Number(process.env.SIP_UPSTREAM_PORT || 5062);
  const recordingsDir =
    process.env.SIP_RECORDINGS_DIR || path.join(process.cwd(), 'phone-call-recordings');
  const recorder = await startSipRecorder({
    listenPort,
    upstreamHost,
    upstreamPort,
    recordingsDir,
    onEvent: (event) => {
      if (event.type === 'rtp.started') {
        console.log(`[recorder] Recording started (Call-ID: ${event.callId})`);
      } else if (event.type === 'recording.saved') {
        console.log(
          `[recorder] Saved ${event.durationSec}s (ai=${event.tracks.ai.packets}pkts, user=${event.tracks.user.packets}pkts) -> ${event.files.mixed}`,
        );
      }
    },
  });
  console.log(
    `[recorder] SIP/RTP proxy listening on udp://${recorder.listenHost}:${recorder.listenPort} -> ${upstreamHost}:${upstreamPort}`,
  );
  console.log(`[recorder] Recordings directory: ${recordingsDir}`);
  const onExit = () => {
    recorder.stop();
    process.exit(0);
  };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);
}
