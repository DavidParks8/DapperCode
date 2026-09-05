import type { Chat, ChatMessage, ChatSummary } from '@bridge/types/types';
import { toRecord } from '@shared/runtimeValidation';

const CHAT_SUMMARY_IDENTITY_FIELDS = [
  'id',
  'title',
  'status',
  'createdAt',
  'updatedAt',
  'statusUpdatedAt',
  'timestampsSynthesized',
  'lastMessagePreview',
  'cwd',
  'lastError',
] as const satisfies readonly (keyof ChatSummary)[];
const CHAT_SUMMARY_AGENT_FIELDS = [
  'agentId',
  'modelProvider',
  'agentNickname',
  'agentRole',
  'sourceKind',
  'parentThreadId',
  'subAgentDepth',
] as const satisfies readonly (keyof ChatSummary)[];
const CHAT_SUMMARY_RUN_FIELDS = [
  'lastRunStartedAt',
  'lastRunFinishedAt',
  'lastRunDurationMs',
  'lastRunExitCode',
  'lastRunTimedOut',
] as const satisfies readonly (keyof ChatSummary)[];

export function areChatStatusMapsEquivalent(
  previous: ReadonlyMap<string, Chat['status']>,
  next: ReadonlyMap<string, Chat['status']>,
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.size !== next.size) {
    return false;
  }

  for (const [key, value] of previous) {
    if (next.get(key) !== value) {
      return false;
    }
  }

  return true;
}

export function areChatsEquivalent(previous: Chat | null, next: Chat | null): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return previous === next;
  }

  return (
    areChatSummariesEquivalent(previous, next) &&
    areChatPlansEquivalent(previous.latestPlan, next.latestPlan) &&
    areChatPlansEquivalent(previous.latestTurnPlan, next.latestTurnPlan) &&
    previous.latestTurnStatus === next.latestTurnStatus &&
    areChatRuntimeFieldsEquivalent(previous, next) &&
    areContextUsagesEquivalent(previous.acpUsage, next.acpUsage) &&
    areTokenTotalsEquivalent(previous.tokenTotals, next.tokenTotals) &&
    areChatMessagesEquivalent(previous.messages, next.messages) &&
    // Snapshot revisions/cursors and raw payloads drive subsequent replay and history merges.
    areChatPayloadsEquivalent(previous.acpSnapshot, next.acpSnapshot)
  );
}

function areChatRuntimeFieldsEquivalent(previous: Chat, next: Chat): boolean {
  return (
    previous.activeTurnId === next.activeTurnId &&
    previous.acpMode === next.acpMode &&
    areChatPayloadsEquivalent(previous.acpActive, next.acpActive) &&
    areChatPayloadsEquivalent(previous.acpConfig, next.acpConfig) &&
    areChatPayloadsEquivalent(previous.acpCommands, next.acpCommands)
  );
}

export function areChatSummaryListsEquivalent(
  previous: ChatSummary[],
  next: ChatSummary[],
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.length !== next.length) {
    return false;
  }

  for (let index = 0; index < previous.length; index += 1) {
    const previousSummary = previous[index];
    const nextSummary = next[index];
    if (
      !previousSummary ||
      !nextSummary ||
      !areChatSummariesEquivalent(previousSummary, nextSummary)
    ) {
      return false;
    }
  }

  return true;
}

function areChatSummariesEquivalent(
  previous: ChatSummary | null,
  next: ChatSummary | null,
): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return previous === next;
  }

  return (
    areChatSummaryFieldsEquivalent(previous, next, CHAT_SUMMARY_IDENTITY_FIELDS) &&
    areChatSummaryFieldsEquivalent(previous, next, CHAT_SUMMARY_AGENT_FIELDS) &&
    areChatSummaryFieldsEquivalent(previous, next, CHAT_SUMMARY_RUN_FIELDS)
  );
}

function areChatSummaryFieldsEquivalent(
  previous: ChatSummary,
  next: ChatSummary,
  fields: readonly (keyof ChatSummary)[],
): boolean {
  for (const field of fields) {
    if (previous[field] !== next[field]) {
      return false;
    }
  }
  return true;
}

function areChatPlansEquivalent(previous: Chat['latestPlan'], next: Chat['latestPlan']): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return !previous && !next;
  }
  if (
    previous.threadId !== next.threadId ||
    previous.turnId !== next.turnId ||
    previous.explanation !== next.explanation ||
    previous.steps.length !== next.steps.length
  ) {
    return false;
  }

  for (let index = 0; index < previous.steps.length; index += 1) {
    const previousStep = previous.steps[index];
    const nextStep = next.steps[index];
    if (!previousStep || !nextStep) {
      return false;
    }
    if (previousStep.step !== nextStep.step || previousStep.status !== nextStep.status) {
      return false;
    }
  }

  return true;
}

function areChatMessagesEquivalent(previous: ChatMessage[], next: ChatMessage[]): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.length !== next.length) {
    return false;
  }

  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (!left || !right) {
      return false;
    }
    if (left === right) {
      continue;
    }
    const { usage: leftUsage, ...leftPayload } = left;
    const { usage: rightUsage, ...rightPayload } = right;
    if (
      !areMessageUsagesEquivalent(leftUsage, rightUsage) ||
      !areChatPayloadsEquivalent(leftPayload, rightPayload)
    ) {
      return false;
    }
  }

  return true;
}

function areChatPayloadsEquivalent(previous: unknown, next: unknown): boolean {
  return (
    previous === next ||
    JSON.stringify(previous, sortedPayloadKeys) === JSON.stringify(next, sortedPayloadKeys)
  );
}

function sortedPayloadKeys(_key: string, value: unknown): unknown {
  const record = toRecord(value);
  // JSON objects are unordered; arrays (parts, tool calls, timeline entries) are not.
  return record
    ? Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, record[key]]),
      )
    : value;
}

function areMessageUsagesEquivalent(
  previous: ChatMessage['usage'],
  next: ChatMessage['usage'],
): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return !previous && !next;
  }
  return (
    previous.inputTokens === next.inputTokens &&
    previous.outputTokens === next.outputTokens &&
    previous.reasoningTokens === next.reasoningTokens &&
    previous.cachedReadTokens === next.cachedReadTokens &&
    previous.cachedWriteTokens === next.cachedWriteTokens &&
    previous.totalTokens === next.totalTokens &&
    previous.model === next.model
  );
}

function areContextUsagesEquivalent(previous: Chat['acpUsage'], next: Chat['acpUsage']): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return !previous && !next;
  }
  return previous.used === next.used && previous.size === next.size && previous.cost === next.cost;
}

function areTokenTotalsEquivalent(
  previous: Chat['tokenTotals'],
  next: Chat['tokenTotals'],
): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return !previous && !next;
  }
  return (
    previous.turns === next.turns &&
    previous.inputTokens === next.inputTokens &&
    previous.outputTokens === next.outputTokens &&
    previous.reasoningTokens === next.reasoningTokens &&
    previous.cachedReadTokens === next.cachedReadTokens &&
    previous.cachedWriteTokens === next.cachedWriteTokens &&
    previous.totalTokens === next.totalTokens
  );
}
