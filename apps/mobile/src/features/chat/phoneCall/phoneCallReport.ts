import type { ChatMessage } from '@bridge/types/types';
import { getMessageText } from '@bridge/messages';
import { parseCalleeDisplay, type CalleeDisplay } from './formatPhoneNumber';
import { parseCallTranscript, type CallTimelineItem } from './phoneCallTimeline';

const REPORT_ENDED_HEADING = '[Outbound phone call ended]';
const REPORT_FAILED_HEADING = '[Outbound phone call failed]';

export interface PhoneCallRecord {
  callId: string | null;
  status: 'completed' | 'failed' | 'cancelled' | 'ended';
  callee: CalleeDisplay;
  durationLabel: string | null;
  endReason: string | null;
  outcomeSummary: string | null;
  objective: string | null;
  timeline: CallTimelineItem[];
}

export function isPhoneCallReportText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith(REPORT_ENDED_HEADING) || trimmed.startsWith(REPORT_FAILED_HEADING);
}

function parseReportHeaderFields(headerBlock: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = headerBlock.split('\n').slice(1);
  let lastKey: string | null = null;
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z ]+):\s*(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined) {
      const key = match[1].trim();
      fields.set(key, match[2].trim());
      lastKey = key;
    } else if (lastKey && line.trim()) {
      fields.set(lastKey, `${fields.get(lastKey) ?? ''}\n${line.trim()}`);
    }
  }
  return fields;
}

function resolveReportStatus(
  rawStatus: string,
  isFailedHeading: boolean,
): PhoneCallRecord['status'] {
  if (rawStatus === 'failed' || isFailedHeading) {
    return 'failed';
  }
  if (rawStatus === 'completed' || rawStatus === 'cancelled') {
    return rawStatus;
  }
  return 'ended';
}

/**
 * Parses the bridge's post-call report message (`build_post_call_report_content`) into a
 * structured inline call record for the chat transcript timeline.
 */
export function parsePhoneCallReportMessage(raw: string): PhoneCallRecord | null {
  const trimmed = raw.trim();
  const isFailedHeading = trimmed.startsWith(REPORT_FAILED_HEADING);
  if (!isFailedHeading && !trimmed.startsWith(REPORT_ENDED_HEADING)) {
    return null;
  }

  const transcriptMarker = '\n\nTranscript:\n';
  const markerIndex = trimmed.indexOf(transcriptMarker);
  const headerBlock = markerIndex >= 0 ? trimmed.slice(0, markerIndex) : trimmed;
  const transcriptBlock =
    markerIndex >= 0 ? trimmed.slice(markerIndex + transcriptMarker.length) : '';
  const fields = parseReportHeaderFields(headerBlock);
  const durationLabel =
    (fields.get('Duration') ?? '').replace(/\s*\(\d+s\)\s*$/, '').trim() || null;

  const callee = parseCalleeDisplay(fields.get('To') ?? 'Phone call');

  return {
    callId: fields.get('Call ID') || null,
    status: resolveReportStatus((fields.get('Status') ?? '').toLowerCase(), isFailedHeading),
    callee,
    durationLabel,
    endReason: formatFriendlyEndReason(fields.get('End reason') ?? null),
    outcomeSummary: fields.get('Outcome summary') || null,
    objective: fields.get('Objective') || null,
    timeline: parseCallTranscript(transcriptBlock, 'plain', callee.name),
  };
}

/** Collects call IDs that already have an inline post-call report in the chat transcript. */
export function collectReportedPhoneCallIds(messages: readonly ChatMessage[]): Set<string> {
  const reported = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const text = getMessageText(message);
    if (!isPhoneCallReportText(text)) {
      continue;
    }
    const parsed = parsePhoneCallReportMessage(text);
    if (parsed?.callId) {
      reported.add(parsed.callId);
    }
  }
  return reported;
}

function formatFriendlyEndReason(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  switch (raw.trim()) {
    case 'mobile_hangup':
      return 'You hung up';
    case 'agent_hangup':
      return 'Call ended by agent';
    case 'remote_bye':
      return 'Recipient hung up';
    case 'max_duration_reached':
      return 'Maximum call duration reached';
    case 'cancelled_before_connect':
      return 'Cancelled before connecting';
    default:
      return raw.trim();
  }
}
