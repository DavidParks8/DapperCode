import type { ComponentProps } from 'react';
import type { Ionicons } from '@expo/vector-icons';

import type { ChatSummary } from '@bridge/types/types';
import type { ActivityTone } from '../state/runtime';
import { colors } from '@shared/theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const AGENT_ACCENT_PALETTE = [
  '#F5A524',
  '#4CC9F0',
  '#7ED957',
  '#FF8A65',
  '#F472B6',
  '#8BD3DD',
] as const;

const RUNNING_STATUS_COLOR = '#7EE787';
const WAITING_STATUS_COLOR = '#F5A524';
const COMPLETE_STATUS_COLOR = '#93C5FD';

export interface AgentThreadRuntimeSnapshotLike {
  activity?: {
    tone: ActivityTone;
    title: string;
    detail?: string;
  };
  activeCommands?: unknown[];
  pendingApproval?: unknown;
  pendingUserInputRequest?: unknown;
  activeTurnId?: string | null;
  runWatchdogUntil?: number;
  updatedAtMs?: number;
}

export interface AgentThreadDisplayState {
  icon: IoniconName;
  label: string;
  detail: string | null;
  tone: ActivityTone;
  accentColor: string;
  statusColor: string;
  statusSurfaceColor: string;
  statusBorderColor: string;
  isActive: boolean;
}

interface AgentRuntimeStatusContext {
  chat: ChatSummary;
  activityTitle: string | null;
  activityDetail: string | null;
  activityTone: ActivityTone | undefined;
  hasActiveTurn: boolean;
  watchdogActive: boolean;
  hasActiveCommands: boolean;
  needsApproval: boolean;
  needsInput: boolean;
}

type AgentRuntimeStatus = Omit<AgentThreadDisplayState, 'accentColor'>;

export function buildAgentThreadDisplayState(
  chat: ChatSummary,
  snapshot: AgentThreadRuntimeSnapshotLike | null | undefined,
  nowMs = Date.now(),
): AgentThreadDisplayState {
  const accentColor = getAgentThreadAccentColor(chat.id);
  const status = resolveAgentRuntimeStatus(chat, snapshot, nowMs);

  return {
    ...status,
    accentColor,
  };
}

export function getAgentThreadAccentColor(threadId: string): string {
  let hash = 0;
  for (let index = 0; index < threadId.length; index += 1) {
    hash = (hash * 33 + threadId.charCodeAt(index)) >>> 0;
  }

  const accentColor = AGENT_ACCENT_PALETTE[hash % AGENT_ACCENT_PALETTE.length];
  if (!accentColor) {
    throw new Error('Agent accent palette must not be empty');
  }
  return accentColor;
}

function resolveAgentRuntimeStatus(
  chat: ChatSummary,
  snapshot: AgentThreadRuntimeSnapshotLike | null | undefined,
  nowMs: number,
): AgentRuntimeStatus {
  return pickAgentRuntimeStatus(buildAgentRuntimeStatusContext(chat, snapshot, nowMs));
}

function buildAgentRuntimeStatusContext(
  chat: ChatSummary,
  snapshot: AgentThreadRuntimeSnapshotLike | null | undefined,
  nowMs: number,
): AgentRuntimeStatusContext {
  const activity = snapshot?.activity;
  return {
    chat,
    activityTitle: normalizeValue(activity?.title),
    activityDetail: normalizeValue(activity?.detail),
    activityTone: activity?.tone,
    hasActiveTurn: Boolean(snapshot?.activeTurnId),
    watchdogActive:
      typeof snapshot?.runWatchdogUntil === 'number' && snapshot.runWatchdogUntil > nowMs,
    hasActiveCommands: (snapshot?.activeCommands?.length ?? 0) > 0,
    needsApproval: snapshot?.pendingApproval != null,
    needsInput: snapshot?.pendingUserInputRequest != null,
  };
}

function pickAgentRuntimeStatus(context: AgentRuntimeStatusContext): AgentRuntimeStatus {
  return (
    resolveErrorStatus(context) ??
    resolveApprovalStatus(context) ??
    resolveInputStatus(context) ??
    resolveRunningStatus(context) ??
    resolveCompleteStatus(context) ??
    resolveIdleStatus()
  );
}

function resolveErrorStatus(context: AgentRuntimeStatusContext): AgentRuntimeStatus | null {
  if (context.chat.status !== 'error' && context.activityTone !== 'error') {
    return null;
  }

  return {
    icon: 'alert-circle-outline',
    label: 'Error',
    detail:
      context.activityDetail ??
      normalizeErrorActivityTitle(context.activityTitle) ??
      normalizeValue(context.chat.lastError) ??
      null,
    tone: 'error',
    statusColor: colors.statusError,
    statusSurfaceColor: 'rgba(239, 68, 68, 0.16)',
    statusBorderColor: 'rgba(239, 68, 68, 0.42)',
    isActive: false,
  };
}

function resolveApprovalStatus(context: AgentRuntimeStatusContext): AgentRuntimeStatus | null {
  if (!context.needsApproval) {
    return null;
  }

  return {
    icon: 'hand-left-outline',
    label: 'Needs approval',
    detail: context.activityDetail ?? normalizeRunningDetail(context.activityTitle),
    tone: 'running',
    statusColor: WAITING_STATUS_COLOR,
    statusSurfaceColor: 'rgba(245, 165, 36, 0.16)',
    statusBorderColor: 'rgba(245, 165, 36, 0.4)',
    isActive: true,
  };
}

function resolveInputStatus(context: AgentRuntimeStatusContext): AgentRuntimeStatus | null {
  if (!context.needsInput) {
    return null;
  }

  return {
    icon: 'help-circle-outline',
    label: 'Needs input',
    detail: context.activityDetail ?? normalizeRunningDetail(context.activityTitle),
    tone: 'running',
    statusColor: WAITING_STATUS_COLOR,
    statusSurfaceColor: 'rgba(245, 165, 36, 0.16)',
    statusBorderColor: 'rgba(245, 165, 36, 0.4)',
    isActive: true,
  };
}

function resolveRunningStatus(context: AgentRuntimeStatusContext): AgentRuntimeStatus | null {
  if (!isRunningContext(context)) {
    return null;
  }

  const label = normalizeRunningLabel(context.activityTitle);
  return {
    icon: runningIconForLabel(label),
    label,
    detail: context.activityDetail,
    tone: 'running',
    statusColor: RUNNING_STATUS_COLOR,
    statusSurfaceColor: 'rgba(126, 231, 135, 0.14)',
    statusBorderColor: 'rgba(126, 231, 135, 0.34)',
    isActive: true,
  };
}

function resolveCompleteStatus(context: AgentRuntimeStatusContext): AgentRuntimeStatus | null {
  if (context.chat.status !== 'complete' && context.activityTone !== 'complete') {
    return null;
  }

  return {
    icon: 'checkmark-circle-outline',
    label: 'Complete',
    detail: context.activityDetail ?? normalizeCompleteActivityTitle(context.activityTitle) ?? null,
    tone: 'complete',
    statusColor: COMPLETE_STATUS_COLOR,
    statusSurfaceColor: 'rgba(147, 197, 253, 0.15)',
    statusBorderColor: 'rgba(147, 197, 253, 0.34)',
    isActive: false,
  };
}

function resolveIdleStatus(): AgentRuntimeStatus {
  return {
    icon: 'ellipse-outline',
    label: 'Idle',
    detail: null,
    tone: 'idle',
    statusColor: colors.statusIdle,
    statusSurfaceColor: 'rgba(180, 188, 203, 0.12)',
    statusBorderColor: 'rgba(180, 188, 203, 0.24)',
    isActive: false,
  };
}

function isRunningContext(context: AgentRuntimeStatusContext): boolean {
  return (
    context.activityTone === 'running' ||
    context.chat.status === 'running' ||
    context.hasActiveTurn ||
    context.watchdogActive ||
    context.hasActiveCommands
  );
}

function normalizeRunningLabel(activityTitle: string | null): string {
  const normalized = activityTitle?.trim().toLowerCase();
  if (!normalized || normalized === 'turn started' || normalized === 'ready') {
    return 'Working';
  }

  if (normalized === 'working') {
    return 'Working';
  }
  if (normalized === 'reasoning') {
    return 'Reasoning';
  }
  if (normalized === 'planning') {
    return 'Planning';
  }

  return activityTitle ?? 'Working';
}

function normalizeRunningDetail(activityTitle: string | null): string | null {
  if (!activityTitle) {
    return null;
  }

  const normalized = activityTitle.trim().toLowerCase();
  if (
    normalized === 'working' ||
    normalized === 'reasoning' ||
    normalized === 'planning' ||
    normalized === 'turn started' ||
    normalized === 'ready'
  ) {
    return null;
  }

  return activityTitle;
}

function normalizeCompleteActivityTitle(activityTitle: string | null): string | null {
  if (!activityTitle) {
    return null;
  }

  const normalized = activityTitle.trim().toLowerCase();
  if (normalized === 'turn completed' || normalized === 'ready') {
    return null;
  }

  return activityTitle;
}

function normalizeErrorActivityTitle(activityTitle: string | null): string | null {
  if (!activityTitle) {
    return null;
  }

  const normalized = activityTitle.trim().toLowerCase();
  if (normalized === 'turn failed' || normalized === 'turn interrupted' || normalized === 'error') {
    return null;
  }

  return activityTitle;
}

function runningIconForLabel(label: string): IoniconName {
  const normalized = label.trim().toLowerCase();
  if (normalized === 'planning') {
    return 'map-outline';
  }
  if (normalized === 'reasoning') {
    return 'sparkles-outline';
  }

  return 'sync-outline';
}

function normalizeValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Reads the mutable per-thread runtime snapshot store from inside a memo. Snapshots mutate in
 * place, so `revision` is the invalidation token that makes the memoized read recompute when
 * runtime state changes without the ref identity changing.
 */
export function readAgentThreadRuntimeSnapshots<T>(
  snapshotsRef: { readonly current: T },
  revision: number,
): T {
  void revision;
  return snapshotsRef.current;
}
