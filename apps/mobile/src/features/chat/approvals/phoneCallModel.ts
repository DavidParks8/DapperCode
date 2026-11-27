import type { BridgeUiAction, BridgeUiSurface } from '@bridge/types/types';

export type PhoneCallPhase = 'connecting' | 'live' | 'held' | 'ended' | 'failed';

export interface PhoneCallModel {
  callee: string;
  status: string;
  phase: PhoneCallPhase;
  durationSeconds: number | null;
  objective: string | null;
  outcome: { label: string; value: string } | null;
  /** The bridge's raw cause behind a failure, kept secondary to the plain-language outcome. */
  details: string | null;
  transcriptMarkdown: string | null;
  hangupAction: BridgeUiAction | null;
}

const TITLE_PREFIX = 'Phone call · ';
const TRANSCRIPT_HEADING = /^\*\*Live transcript\*\*\s*/;

export function isPhoneCallSurface(surface: BridgeUiSurface): boolean {
  return (
    surface.presentation === 'workflowCard' &&
    (surface.kind === 'phone-call' || (!surface.kind && surface.id.startsWith('phone-call-live:')))
  );
}

function isActivePhoneCall(surface: BridgeUiSurface): boolean {
  return surface.actions.some((action) => action.id === 'hangup');
}

/**
 * The composer dock shows the active call, or else only the most recent result: settled calls stay
 * in the chat history instead of stacking up over the conversation. Older results are superseded,
 * so dismissing the docked result retires them too rather than resurfacing them one by one.
 */
export function selectDockedPhoneCalls(surfaces: BridgeUiSurface[]): {
  docked: BridgeUiSurface[];
  superseded: BridgeUiSurface[];
} {
  const active = surfaces.filter(isActivePhoneCall);
  const settled = surfaces.filter((surface) => !isActivePhoneCall(surface));
  if (active.length > 0) {
    return { docked: active, superseded: settled };
  }
  const latest = settled.reduce<BridgeUiSurface | null>(
    (newest, surface) =>
      !newest || (surface.createdAt ?? '') >= (newest.createdAt ?? '') ? surface : newest,
    null,
  );
  return latest
    ? { docked: [latest], superseded: settled.filter((surface) => surface !== latest) }
    : { docked: [], superseded: [] };
}

/** Reads the bridge's phone-call card (docs/bridge-ui-surfaces.md) into what the call bar shows. */
export function phoneCallModel(surface: BridgeUiSurface): PhoneCallModel {
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

  const hangupAction = surface.actions.find((action) => action.id === 'hangup') ?? null;
  const status = values.get('Status') ?? surface.subtitle?.trim() ?? '';

  return {
    callee: values.get('To') ?? calleeFromTitle(surface.title),
    status,
    phase: resolvePhase(status, hangupAction, surface),
    durationSeconds: parseDuration(values.get('Duration')),
    objective: values.get('Objective') ?? null,
    outcome: resolveOutcome(values),
    details: values.get('Details') ?? null,
    transcriptMarkdown,
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
    case 'live':
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
