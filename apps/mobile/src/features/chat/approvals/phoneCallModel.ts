import type { BridgeUiAction, BridgeUiSurface } from '@bridge/types/types';
import {
  formatPhoneNumber,
  parseCalleeDisplay,
  type CalleeDisplay,
} from '../phoneCall/formatPhoneNumber';
import { parseCallTranscript, type CallTimelineItem } from '../phoneCall/phoneCallTimeline';

export type PhoneCallPhase = 'connecting' | 'live' | 'held' | 'ended' | 'failed';
export type PhoneCallActivityKind =
  | 'dialing'
  | 'ringing'
  | 'listening'
  | 'agent_speaking'
  | 'recipient_speaking'
  | 'on_hold'
  | 'running_tool'
  | 'ended'
  | 'failed';

export interface PhoneCallModel {
  callId: string;
  callee: string;
  calleeDisplay: CalleeDisplay;
  callerIdFormatted: string | null;
  status: string;
  phase: PhoneCallPhase;
  activityKind: PhoneCallActivityKind;
  activityLabel: string | null;
  durationSeconds: number | null;
  objective: string | null;
  outcome: { label: string; value: string } | null;
  /** The bridge's raw cause behind a failure, kept secondary to the plain-language outcome. */
  details: string | null;
  transcriptMarkdown: string | null;
  timeline: CallTimelineItem[];
  hangupAction: BridgeUiAction | null;
}

const LIVE_SURFACE_PREFIX = 'phone-call-live:';
const TITLE_PREFIX = 'Phone call · ';
const TRANSCRIPT_HEADING = /^\*\*Live transcript\*\*\s*/;

export function phoneCallIdFromSurface(surface: BridgeUiSurface): string {
  return surface.id.startsWith(LIVE_SURFACE_PREFIX)
    ? surface.id.slice(LIVE_SURFACE_PREFIX.length)
    : surface.id;
}

export function isPhoneCallSurface(surface: BridgeUiSurface): boolean {
  return (
    surface.presentation === 'workflowCard' &&
    (surface.kind === 'phone-call' || (!surface.kind && surface.id.startsWith(LIVE_SURFACE_PREFIX)))
  );
}

export function isActivePhoneCallSurface(surface: BridgeUiSurface): boolean {
  return surface.actions.some((action) => action.id === 'hangup');
}

/**
 * The composer dock shows the active call, or else only the most recent unsettled/unreported
 * result: settled calls whose post-call report is already in the transcript retire from live
 * chrome so calls live chronologically in the conversation instead of lingering above the input.
 */
export function selectDockedPhoneCalls(
  surfaces: BridgeUiSurface[],
  reportedCallIds?: ReadonlySet<string>,
): {
  docked: BridgeUiSurface[];
  superseded: BridgeUiSurface[];
} {
  const active = surfaces.filter(isActivePhoneCallSurface);
  const settled = surfaces.filter((surface) => !isActivePhoneCallSurface(surface));
  if (active.length > 0) {
    return { docked: active, superseded: settled };
  }
  const unreportedSettled = reportedCallIds
    ? settled.filter((surface) => !reportedCallIds.has(phoneCallIdFromSurface(surface)))
    : settled;
  const latest = unreportedSettled.reduce<BridgeUiSurface | null>(
    (newest, surface) =>
      !newest || (surface.createdAt ?? '') >= (newest.createdAt ?? '') ? surface : newest,
    null,
  );
  return latest
    ? { docked: [latest], superseded: settled.filter((surface) => surface !== latest) }
    : { docked: [], superseded: settled };
}

function extractCallSurfaceBlocks(surface: BridgeUiSurface) {
  const values = new Map<string, string>();
  let transcriptMarkdown: string | null = null;
  for (const block of surface.blocks) {
    if (block.type === 'keyValue') {
      for (const item of block.items) {
        values.set(item.label, item.value);
      }
    } else if (block.type === 'markdown') {
      transcriptMarkdown = block.markdown.replace(TRANSCRIPT_HEADING, '').trim() || null;
    }
  }
  return { values, transcriptMarkdown };
}

/** Reads the bridge's phone-call card (docs/bridge-ui-surfaces.md) into what the call bar & stage show. */
export function phoneCallModel(surface: BridgeUiSurface): PhoneCallModel {
  const { values, transcriptMarkdown } = extractCallSurfaceBlocks(surface);
  const hangupAction = surface.actions.find((action) => action.id === 'hangup') ?? null;
  const status = values.get('Status') ?? surface.subtitle?.trim() ?? '';
  const phase = resolvePhase(status, hangupAction, surface);
  const { activityKind, activityLabel } = resolveActivity(
    phase,
    status,
    values.get('Activity')?.trim() ?? null,
  );
  const rawCallee = values.get('To') ?? calleeFromTitle(surface.title);
  const callerRaw = values.get('From') ?? null;

  return {
    callId: phoneCallIdFromSurface(surface),
    callee: rawCallee,
    calleeDisplay: parseCalleeDisplay(rawCallee),
    callerIdFormatted: callerRaw && callerRaw !== '+unknown' ? formatPhoneNumber(callerRaw) : null,
    status,
    phase,
    activityKind,
    activityLabel,
    durationSeconds: parseDuration(values.get('Duration')),
    objective: values.get('Objective') ?? null,
    outcome: resolveOutcome(values),
    details: values.get('Details') ?? null,
    transcriptMarkdown,
    timeline: parseCallTranscript(transcriptMarkdown, 'markdown'),
    hangupAction,
  };
}

// Settled cards retitle themselves ("Phone call ended"), so the To row is preferred.
function calleeFromTitle(title: string): string {
  return title.startsWith(TITLE_PREFIX) ? title.slice(TITLE_PREFIX.length) : title;
}

function resolveOutcome(values: Map<string, string>): PhoneCallModel['outcome'] {
  const summary = values.get('Summary');
  if (summary) {
    return { label: 'Summary', value: summary };
  }
  const reason = values.get('Reason');
  return reason ? { label: 'Reason', value: reason } : null;
}

function resolvePhase(
  status: string,
  hangupAction: BridgeUiAction | null,
  surface: BridgeUiSurface,
): PhoneCallPhase {
  if (!hangupAction) {
    return surface.tone === 'error' ? 'failed' : 'ended';
  }
  if (status === 'On hold') {
    return 'held';
  }
  return status === 'In call' ? 'live' : 'connecting';
}

const LIVE_ACTIVITY_MAP: Record<
  string,
  { activityKind: PhoneCallActivityKind; activityLabel: string | null }
> = {
  'on hold': { activityKind: 'on_hold', activityLabel: 'On hold' },
  'agent speaking': { activityKind: 'agent_speaking', activityLabel: 'Agent speaking' },
  'recipient speaking': { activityKind: 'recipient_speaking', activityLabel: 'Recipient speaking' },
  listening: { activityKind: 'listening', activityLabel: null },
  'in call': { activityKind: 'listening', activityLabel: null },
};

function resolveActivity(
  phase: PhoneCallPhase,
  status: string,
  rawActivity: string | null,
): { activityKind: PhoneCallActivityKind; activityLabel: string | null } {
  if (phase === 'ended' || phase === 'failed') {
    return { activityKind: phase, activityLabel: null };
  }
  if (phase === 'held') {
    return { activityKind: 'on_hold', activityLabel: 'On hold' };
  }
  const normalized = rawActivity?.toLowerCase() ?? '';
  if (phase === 'connecting') {
    return normalized === 'ringing' || status.toLowerCase() === 'ringing'
      ? { activityKind: 'ringing', activityLabel: 'Ringing' }
      : { activityKind: 'dialing', activityLabel: rawActivity || status || 'Connecting' };
  }
  if (!rawActivity) {
    return { activityKind: 'listening', activityLabel: null };
  }
  return (
    LIVE_ACTIVITY_MAP[normalized] ?? { activityKind: 'running_tool', activityLabel: rawActivity }
  );
}

function parseDuration(value: string | undefined): number | null {
  const match = value ? /^(\d+):(\d{2})$/.exec(value.trim()) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function formatCallElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${String(minutes)}:${rest}`;
}

export type HangupState = 'idle' | 'pending' | 'failed';

/** One glanceable line: what the call is doing now, and how long or how it ended. */
export function phoneCallStatusLine(
  model: PhoneCallModel,
  elapsedSeconds: number | null,
  hangup: HangupState,
): string {
  if (model.hangupAction && hangup === 'pending') {
    return 'Hanging up…';
  }
  if (model.hangupAction && hangup === 'failed') {
    return 'Couldn’t hang up. Try again.';
  }
  const elapsed = elapsedSeconds === null ? null : formatCallElapsed(elapsedSeconds);
  switch (model.phase) {
    case 'connecting':
      return `${model.status || 'Connecting'}…`;
    case 'live': {
      const lead = model.activityLabel ?? model.status;
      return elapsed ? `${lead} · ${elapsed}` : lead;
    }
    case 'held':
      return elapsed ? `${model.status} · ${elapsed}` : model.status;
    case 'ended':
    case 'failed':
      return settledStatusLine(model, elapsed);
  }
}

function settledStatusLine(model: PhoneCallModel, elapsed: string | null): string {
  const status = model.status || 'Ended';
  const detail = model.outcome?.value ?? elapsed;
  return detail ? `${status} · ${detail}` : status;
}
