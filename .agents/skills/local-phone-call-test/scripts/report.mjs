// Generates structured transcript.json and analysis-ready transcript.md artifacts
// from a completed local phone-call test run.

import fs from 'node:fs';
import path from 'node:path';

function formatSeconds(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'n/a';
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatDbfs(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(1)} dBFS`
    : 'silent';
}

function speakerLabel(speaker, calleeName) {
  switch (speaker) {
    case 'assistant':
      return 'AI';
    case 'recipient':
    case 'callee':
      return calleeName || 'User';
    case 'user':
    case 'steer':
      return 'Steer (Private)';
    case 'system':
      return 'System';
    default:
      return String(speaker || 'Unknown');
  }
}

export function extractTranscriptFromCardMarkdown(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return [];
  const entries = [];
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    const match = line.match(/^\*\*([^*]+):\*\*\s*(.+)$/);
    if (!match) continue;
    const rawSpeaker = match[1].trim();
    const text = match[2].trim();
    const lower = rawSpeaker.toLowerCase();
    const speaker =
      lower === 'assistant' || lower === 'ai' || lower === 'agent'
        ? 'assistant'
        : lower === 'you' || lower === 'instruction' || lower === 'steer'
          ? 'steer'
          : 'recipient';
    entries.push({ speaker, speakerLabel: rawSpeaker, text });
  }
  return entries;
}

export function buildCallReportBundle({
  metadata,
  timings,
  audioSummary,
  driverReport,
  observedTranscript,
  events,
}) {
  const finalReport = driverReport?.finalReport || null;
  const authoritativeTranscript =
    Array.isArray(finalReport?.transcript) && finalReport.transcript.length > 0
      ? finalReport.transcript.map((entry, index) => ({
          index: index + 1,
          speaker: entry.speaker,
          text: entry.text,
          timestamp: entry.timestamp || null,
        }))
      : (observedTranscript || []).map((entry, index) => ({
          index: index + 1,
          speaker: entry.speaker,
          text: entry.text,
          timestamp: entry.observedAt || null,
        }));

  const status = finalReport?.status || metadata.lastStatus || 'unknown';
  const endReason = finalReport?.endReason || metadata.lastEndReason || null;
  const durationSeconds =
    typeof finalReport?.durationSeconds === 'number'
      ? finalReport.durationSeconds
      : (audioSummary?.durationSec ?? null);

  const bundle = {
    schemaVersion: 1,
    metadata: {
      ...metadata,
      status,
      endReason,
      durationSeconds,
      outcomeSummary: finalReport?.outcomeSummary || null,
      callId: driverReport?.callId || metadata.callId || null,
    },
    timings,
    audio: audioSummary || null,
    steers: driverReport?.steered || [],
    transcript: authoritativeTranscript,
    callReport: finalReport,
    driverError: driverReport?.error || driverReport?.pollError || null,
    eventCount: Array.isArray(events) ? events.length : 0,
  };

  return bundle;
}

export function renderTranscriptMarkdown(bundle) {
  const { metadata, timings, audio, steers, transcript, driverError } = bundle;
  const lines = [];

  lines.push(`# Local Phone Call Test Report`);
  lines.push('');
  lines.push(`- **Run ID:** \`${metadata.runId}\``);
  lines.push(`- **Recorded At:** ${metadata.startedAt}`);
  lines.push(
    `- **Status:** \`${metadata.status}\`${metadata.endReason ? ` (${metadata.endReason})` : ''}`,
  );
  if (metadata.durationSeconds !== null && metadata.durationSeconds !== undefined) {
    lines.push(`- **Call Duration:** ${metadata.durationSeconds}s`);
  }
  if (metadata.gitCommit) {
    lines.push(`- **Git Revision:** \`${metadata.gitBranch || 'detached'}@${metadata.gitCommit}\``);
  }
  lines.push('');

  lines.push(`## Call Prompt & Voice Configuration`);
  lines.push('');
  lines.push(`- **Objective:** ${metadata.objective}`);
  if (metadata.firstMessage) {
    lines.push(`- **First Message Guidance:** ${metadata.firstMessage}`);
  }
  if (metadata.context) {
    lines.push(`- **Context:** ${metadata.context}`);
  }
  lines.push(`- **STT:** \`${metadata.voice.sttModel}\` (${metadata.voice.sttBaseUrl})`);
  lines.push(`- **LLM:** \`${metadata.voice.llmModel}\` (${metadata.voice.llmBaseUrl})`);
  lines.push(
    `- **TTS:** \`${metadata.voice.ttsModel}\` / voice \`${metadata.voice.ttsVoice}\` (${metadata.voice.ttsBaseUrl})`,
  );
  lines.push('');

  lines.push(`## Phase Timings`);
  lines.push('');
  lines.push(`- **Approval Latency:** ${formatSeconds(timings.approvalMs)}`);
  lines.push(`- **Model Warm-up + Dial to Connect:** ${formatSeconds(timings.dialToConnectMs)}`);
  lines.push(`- **First RTP Packet:** ${formatSeconds(timings.firstRtpMs)}`);
  lines.push(`- **Total Run Wall Time:** ${formatSeconds(timings.totalMs)}`);
  lines.push('');

  if (audio) {
    lines.push(`## Audio Recording & Signal Summary`);
    lines.push('');
    lines.push(
      `- **Sample Rate:** ${audio.sampleRateHz} Hz (16-bit PCM WAV, decoded from G.711 PCMU)`,
    );
    lines.push(`- **Recorded Duration:** ${audio.durationSec}s`);
    lines.push(
      `- **AI Track:** ${audio.tracks.ai.packets} RTP packets, peak ${formatDbfs(audio.tracks.ai.peakDbfs)}, RMS ${formatDbfs(audio.tracks.ai.rmsDbfs)}, active ${(audio.tracks.ai.nonSilentRatio * 100).toFixed(1)}%, clipped ${audio.tracks.ai.clippedSamples} samples`,
    );
    lines.push(
      `- **User Track:** ${audio.tracks.user.packets} RTP packets, peak ${formatDbfs(audio.tracks.user.peakDbfs)}, RMS ${formatDbfs(audio.tracks.user.rmsDbfs)}, active ${(audio.tracks.user.nonSilentRatio * 100).toFixed(1)}%, clipped ${audio.tracks.user.clippedSamples} samples`,
    );
    lines.push(`- **Files:**`);
    lines.push(`  - Mixed (mono): \`${audio.files.mixed}\``);
    lines.push(`  - Stereo (L=AI, R=User): \`${audio.files.stereo}\``);
    lines.push(`  - AI only: \`${audio.files.ai}\``);
    lines.push(`  - User only: \`${audio.files.user}\``);
    lines.push('');
  } else {
    lines.push(`## Audio Recording`);
    lines.push('');
    lines.push(`No RTP audio packets were recorded for this run.`);
    lines.push('');
  }

  lines.push(`## Transcript`);
  lines.push('');
  if (transcript.length === 0) {
    lines.push(`_(No transcript entries captured.)_`);
  } else {
    for (const entry of transcript) {
      const ts = entry.timestamp ? `[${entry.timestamp}] ` : '';
      const label = speakerLabel(entry.speaker, metadata.calleeName);
      lines.push(`${entry.index}. ${ts}**${label}:** ${entry.text}`);
    }
  }
  lines.push('');

  if (Array.isArray(steers) && steers.length > 0) {
    lines.push(`## Live Steer Instructions`);
    lines.push('');
    for (const steer of steers) {
      lines.push(
        `- [${steer.at}] ${steer.instruction}${steer.error ? ` _(error: ${steer.error})_` : ''}`,
      );
    }
    lines.push('');
  }

  if (metadata.outcomeSummary) {
    lines.push(`## Outcome Summary`);
    lines.push('');
    lines.push(metadata.outcomeSummary);
    lines.push('');
  }

  if (driverError) {
    lines.push(`## Errors`);
    lines.push('');
    lines.push(`- Driver error: \`${driverError}\``);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export function writeCallArtifacts(outDir, bundle) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'transcript.json');
  const mdPath = path.join(outDir, 'transcript.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, renderTranscriptMarkdown(bundle), 'utf8');
  return { jsonPath, mdPath };
}
