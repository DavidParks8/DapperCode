import type { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import type { Chat, ChatSummary, CollaborationMode, ReasoningEffort } from '../../api/types';
import { getMessageText } from '../../api/messages';
import type {
  ActivityState,
  ActivePlanState,
  PendingPlanImplementationPrompt,
  SlashCommandAvailability,
  SlashCommandDefinition,
  ThreadRuntimeSnapshot,
} from './mainScreenHelperTypes';
import {
  CHAT_INITIAL_VISIBLE_MESSAGE_WINDOW,
  LARGE_CHAT_MESSAGE_COUNT_THRESHOLD,
  SLASH_COMMANDS,
} from './mainScreenHelperTypes';

export function formatCollaborationModeLabel(mode: CollaborationMode): string {
  if (mode === 'plan') {
    return 'Plan mode';
  }
  return 'Default mode';
}

export function isBridgeConnectionErrorMessage(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return (
    normalized.includes('bridge websocket') ||
    normalized.includes('unable to connect to bridge websocket')
  );
}

export function isBridgeRecoveryActivity(activity: ActivityState | null | undefined): boolean {
  if (!activity) {
    return false;
  }

  const normalizedTitle = activity.title.trim().toLowerCase();
  if (normalizedTitle === 'disconnected' || normalizedTitle === 'bridge disconnected') {
    return true;
  }

  return (
    isBridgeConnectionErrorMessage(activity.title) ||
    isBridgeConnectionErrorMessage(activity.detail)
  );
}

export function getInitialVisibleMessageStartIndex(totalMessageCount: number): number {
  if (totalMessageCount <= LARGE_CHAT_MESSAGE_COUNT_THRESHOLD) {
    return 0;
  }

  return Math.max(0, totalMessageCount - CHAT_INITIAL_VISIBLE_MESSAGE_WINDOW);
}

export function resolveSnapshotCollaborationMode(
  snapshot: ThreadRuntimeSnapshot | null | undefined,
  supportsPlanMode = true,
): CollaborationMode {
  if (!snapshot) {
    return 'default';
  }

  // A published plan is just a to-do list for most agents, so it must not imply
  // plan mode unless the agent actually has one.
  const hasActivePlanSnapshot =
    supportsPlanMode &&
    Boolean(snapshot.plan) &&
    (Boolean(snapshot.activeTurnId) || snapshot.activity?.title === 'Planning');
  return snapshot.pendingUserInputRequest || hasActivePlanSnapshot ? 'plan' : 'default';
}

export function resolveDisplayedThreadPlan(
  snapshotPlan: ActivePlanState | null,
  persistedPlan: ActivePlanState | null,
  snapshot: ThreadRuntimeSnapshot | null | undefined,
): ActivePlanState | null {
  if (!persistedPlan) {
    return snapshotPlan;
  }

  if (!snapshotPlan) {
    return persistedPlan;
  }

  if (snapshotPlan.turnId === persistedPlan.turnId) {
    return {
      ...snapshotPlan,
      explanation: snapshotPlan.explanation ?? persistedPlan.explanation,
      steps: snapshotPlan.steps.length > 0 ? snapshotPlan.steps : persistedPlan.steps,
      updatedAt:
        snapshotPlan.updatedAt > persistedPlan.updatedAt
          ? snapshotPlan.updatedAt
          : persistedPlan.updatedAt,
    };
  }

  const hasActivePlanningSnapshot =
    Boolean(snapshot?.activeTurnId) || snapshot?.activity?.title === 'Planning';
  return hasActivePlanningSnapshot ? snapshotPlan : persistedPlan;
}

export function mergePersistedPlanSnapshots(
  persistedSnapshots: Record<string, ActivePlanState>,
  liveSnapshots: Record<string, ThreadRuntimeSnapshot>,
): Record<string, ActivePlanState> {
  const merged: Record<string, ActivePlanState> = { ...persistedSnapshots };
  for (const [threadId, snapshot] of Object.entries(liveSnapshots)) {
    // A snapshot whose `plan` key was never set means no live plan event has
    // reached this thread yet, so a persisted value (if any) is still
    // authoritative.
    if (!snapshot || !('plan' in snapshot)) {
      continue;
    }

    if (snapshot.plan) {
      // A live update already landed for this thread while the persisted
      // snapshots were still loading from disk; it is newer than anything on
      // disk and must win.
      merged[threadId] = snapshot.plan;
    } else {
      // The plan was explicitly cleared/settled live (for example when a new
      // turn starts or a plan is implemented); don't resurrect a stale
      // persisted snapshot for it.
      delete merged[threadId];
    }
  }
  return merged;
}

export function toPersistedActivePlanState(
  plan: Chat['latestPlan'],
  fallbackUpdatedAt: string | null | undefined,
): ActivePlanState | null {
  if (!plan) {
    return null;
  }

  return {
    threadId: plan.threadId,
    turnId: plan.turnId,
    explanation: plan.explanation,
    steps: plan.steps,
    deltaText: '',
    updatedAt: fallbackUpdatedAt ?? new Date(0).toISOString(),
  };
}

export function resolveUndismissedPlanImplementationPrompt(
  prompt: PendingPlanImplementationPrompt | null | undefined,
  dismissedTurnId: string | null | undefined,
): PendingPlanImplementationPrompt | null {
  if (!prompt) {
    return null;
  }

  return dismissedTurnId && dismissedTurnId === prompt.turnId ? null : prompt;
}

export function resolvePersistedPlanImplementationPrompt(
  chat: Chat | null | undefined,
  dismissedTurnId: string | null | undefined,
): PendingPlanImplementationPrompt | null {
  if (!chat?.latestTurnPlan) {
    return null;
  }

  if (dismissedTurnId && dismissedTurnId === chat.latestTurnPlan.turnId) {
    return null;
  }

  return isCompletedPlanTurnStatus(chat.latestTurnStatus)
    ? {
        threadId: chat.id,
        turnId: chat.latestTurnPlan.turnId,
      }
    : null;
}

export function normalizePlanTurnStatus(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

export function isCompletedPlanTurnStatus(value: string | null | undefined): boolean {
  const normalized = normalizePlanTurnStatus(value);
  return (
    normalized === 'completed' ||
    normalized === 'complete' ||
    normalized === 'success' ||
    normalized === 'succeeded'
  );
}

export function formatReasoningEffort(effort: ReasoningEffort): string {
  if (effort === 'xhigh') {
    return 'X-High';
  }

  if (effort === 'max') {
    return 'Max';
  }

  if (effort === 'none') {
    return 'None';
  }

  if (effort === 'minimal') {
    return 'Minimal';
  }

  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function shouldAutoEnablePlanModeFromChat(chat: Chat, supportsPlanMode = true): boolean {
  // Agents without a plan mode still publish plan/to-do updates, so the composer
  // must never switch itself into a mode they cannot run.
  if (!supportsPlanMode) {
    return false;
  }

  if (chat.latestTurnPlan) {
    return true;
  }

  const latestAssistantMessage = [...chat.messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  if (!latestAssistantMessage) {
    return false;
  }

  const normalized = getMessageText(latestAssistantMessage).toLowerCase();
  return (
    normalized.includes('request_user_input is unavailable in default mode') ||
    (normalized.includes('request_user_input') &&
      normalized.includes('default mode') &&
      normalized.includes('plan mode') &&
      normalized.includes('unavailable'))
  );
}

export function parseSlashCommand(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  if (trimmed === '/') {
    return {
      name: 'help',
      args: '',
    };
  }

  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)\s*(.*)$/);
  if (!match) {
    return null;
  }

  return {
    name: match[1].toLowerCase(),
    args: match[2] ?? '',
  };
}

export function parseSlashQuery(input: string): string | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  if (trimmed === '/') {
    return '';
  }

  const afterSlash = trimmed.slice(1);
  const token = afterSlash.split(/\s+/)[0] ?? '';
  return token.toLowerCase();
}

export function findSlashCommandDefinition(name: string): SlashCommandDefinition | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return (
    SLASH_COMMANDS.find((command) => {
      if (command.name.toLowerCase() === normalized) {
        return true;
      }

      return command.aliases?.some((alias) => alias.toLowerCase() === normalized) ?? false;
    }) ?? null
  );
}

export function filterSlashCommands(
  query: string,
  commands: SlashCommandDefinition[] = SLASH_COMMANDS,
): SlashCommandDefinition[] {
  const normalized = query.trim().toLowerCase();
  const dedupedCommands = dedupeSlashCommandsByName(commands);
  if (!normalized) {
    return dedupedCommands;
  }

  return dedupedCommands.filter((command) => {
    const byName = command.name.toLowerCase().includes(normalized);
    const bySummary = command.summary.toLowerCase().includes(normalized);
    const byAlias =
      command.aliases?.some((alias) => alias.toLowerCase().includes(normalized)) ?? false;
    return byName || bySummary || byAlias;
  });
}

export function isSlashCommandAvailable(
  command: SlashCommandDefinition,
  availability: SlashCommandAvailability,
): boolean {
  if (!command.mobileSupported || (command.requiresOpenChat && !availability.hasOpenChat)) {
    return false;
  }

  if (command.name === 'goal') {
    return availability.supportsGoal;
  }
  if (command.name === 'plan') {
    return availability.supportsPlanMode;
  }
  if (command.name === 'review') {
    return availability.supportsReview;
  }

  return true;
}

export function dedupeSlashCommandsByName(
  commands: SlashCommandDefinition[],
): SlashCommandDefinition[] {
  const seen = new Set<string>();
  const result: SlashCommandDefinition[] = [];

  for (const command of commands) {
    const key = command.name.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(command);
  }

  return result;
}

export function formatAgentThreadOptionTitle(
  chat: ChatSummary,
  rootThreadId: string | null,
  ordinal: number | null,
): string {
  const trimmedTitle = chat.title.trim();
  if (rootThreadId && chat.id === rootThreadId) {
    return trimmedTitle || 'Main thread';
  }
  const nickname = chat.agentNickname?.trim();
  if (nickname) {
    return nickname;
  }
  if (ordinal !== null) {
    return `Sub-agent ${String(ordinal)}`;
  }
  return 'Sub-agent';
}

export function iconForAgentThread(
  chat: ChatSummary,
  rootThreadId: string | null,
): ComponentProps<typeof Ionicons>['name'] {
  if (rootThreadId && chat.id === rootThreadId) {
    return 'chatbubble-ellipses-outline';
  }

  switch (chat.sourceKind) {
    case 'subAgentReview':
      return 'shield-checkmark-outline';
    case 'subAgentCompact':
      return 'layers-outline';
    default:
      return chat.status === 'running' ? 'sparkles-outline' : 'git-branch-outline';
  }
}
