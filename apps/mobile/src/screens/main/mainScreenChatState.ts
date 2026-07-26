import { getSubAgentMeta } from '../../api/messages';
import type { AcpConfigOption, Chat, ChatMessage, ChatSummary, ModelOption } from '../../api/types';
import {
  countUserMessages,
  hasRecentUnansweredUserTurn,
  normalizeModelId,
  normalizeReasoningEffort,
} from './mainScreenHelpers';

const EMPTY_MODEL_OPTIONS: ModelOption[] = [];

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

export function resolveEquivalentChat(previous: Chat, next: Chat): Chat {
  const stabilizedNext = preserveRecentUserTurnTranscript(previous, next);
  return areChatsEquivalent(previous, stabilizedNext) ? previous : stabilizedNext;
}

export function mergeChatSummaryPreservingMessages(previous: Chat, summary: ChatSummary): Chat {
  const next = {
    ...previous,
    ...summary,
    messages: previous.messages,
  };
  return areChatsEquivalent(previous, next) ? previous : next;
}

function preserveRecentUserTurnTranscript(previous: Chat, next: Chat): Chat {
  if (previous.id !== next.id) {
    return next;
  }

  const previousUserCount = countUserMessages(previous.messages);
  const nextUserCount = countUserMessages(next.messages);
  if (nextUserCount >= previousUserCount) {
    return next;
  }

  const shouldPreserveTranscript =
    hasRecentUnansweredUserTurn(previous) ||
    previous.status === 'running' ||
    next.status === 'running';
  if (!shouldPreserveTranscript) {
    return next;
  }

  return {
    ...next,
    lastMessagePreview: previous.lastMessagePreview,
    messages: previous.messages,
  };
}

function areChatsEquivalent(previous: Chat | null, next: Chat | null): boolean {
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
    areChatMessagesEquivalent(previous.messages, next.messages)
  );
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
    previous.id === next.id &&
    previous.title === next.title &&
    previous.status === next.status &&
    previous.createdAt === next.createdAt &&
    previous.updatedAt === next.updatedAt &&
    previous.statusUpdatedAt === next.statusUpdatedAt &&
    previous.lastMessagePreview === next.lastMessagePreview &&
    previous.cwd === next.cwd &&
    previous.agentId === next.agentId &&
    previous.modelProvider === next.modelProvider &&
    previous.agentNickname === next.agentNickname &&
    previous.agentRole === next.agentRole &&
    previous.sourceKind === next.sourceKind &&
    previous.parentThreadId === next.parentThreadId &&
    previous.subAgentDepth === next.subAgentDepth &&
    previous.lastRunStartedAt === next.lastRunStartedAt &&
    previous.lastRunFinishedAt === next.lastRunFinishedAt &&
    previous.lastRunDurationMs === next.lastRunDurationMs &&
    previous.lastRunExitCode === next.lastRunExitCode &&
    previous.lastRunTimedOut === next.lastRunTimedOut &&
    previous.lastError === next.lastError
  );
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
    if (previousStep.step !== nextStep.step || previousStep.status !== nextStep.status) {
      return false;
    }
  }

  return true;
}

export function modelOptionsFromAcpConfig(config: AcpConfigOption[]): ModelOption[] {
  const model = config.find((option) => option.category === 'model');
  const effort = config.find((option) => option.category === 'thought_level');
  if (!model?.options?.length) {
    return EMPTY_MODEL_OPTIONS;
  }
  const selectedId = normalizeModelId(model.value);
  const reasoningEffort = (effort?.options ?? [])
    .map((option) => {
      const normalized = normalizeReasoningEffort(option.value);
      return normalized
        ? { effort: normalized, description: option.description ?? option.name }
        : null;
    })
    .filter((option): option is NonNullable<typeof option> => option !== null);
  const defaultReasoningEffort = normalizeReasoningEffort(effort?.value);
  return model.options.map((option) => {
    const [providerId, ...modelParts] = option.value.split('/');
    const displayName = option.name.includes('/')
      ? (option.name.split('/').at(-1) ?? option.name)
      : option.name;
    return {
      id: option.value,
      displayName,
      description: option.description,
      providerId: modelParts.length > 0 ? providerId : undefined,
      providerName: modelParts.length > 0 ? option.name.split('/')[0] : undefined,
      isDefault: option.value === selectedId,
      defaultReasoningEffort: defaultReasoningEffort ?? undefined,
      reasoningEffort: reasoningEffort.length > 0 ? reasoningEffort : undefined,
    } satisfies ModelOption;
  });
}

export function mergeModelOptions(
  catalog: ModelOption[] | null | undefined,
  configured: ModelOption[],
): ModelOption[] {
  const safeCatalog = catalog ?? EMPTY_MODEL_OPTIONS;
  const catalogById = new Map(safeCatalog.map((model) => [model.id, model]));
  const mergedConfigured = configured.map((model) => {
    const catalogEntry = catalogById.get(model.id);
    return {
      ...catalogEntry,
      ...model,
      contextWindow: catalogEntry?.contextWindow ?? model.contextWindow,
      reasoningEffort: model.reasoningEffort ?? catalogEntry?.reasoningEffort,
    };
  });
  const configuredIds = new Set(configured.map((model) => model.id));
  return [...mergedConfigured, ...safeCatalog.filter((model) => !configuredIds.has(model.id))];
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
    if (
      left.id !== right.id ||
      left.role !== right.role ||
      JSON.stringify(left.content) !== JSON.stringify(right.content) ||
      left.createdAt !== right.createdAt ||
      (left.role === 'activity' &&
        right.role === 'activity' &&
        left.activityType !== right.activityType) ||
      !areChatMessageSubAgentMetaEquivalent(getSubAgentMeta(left), getSubAgentMeta(right))
    ) {
      return false;
    }
  }

  return true;
}

function areChatMessageSubAgentMetaEquivalent(
  previous: ReturnType<typeof getSubAgentMeta>,
  next: ReturnType<typeof getSubAgentMeta>,
): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return !previous && !next;
  }
  if (
    previous.tool !== next.tool ||
    previous.prompt !== next.prompt ||
    previous.senderThreadId !== next.senderThreadId ||
    previous.agentStatus !== next.agentStatus
  ) {
    return false;
  }

  const previousReceiverThreadIds = previous.receiverThreadIds ?? [];
  const nextReceiverThreadIds = next.receiverThreadIds ?? [];
  if (previousReceiverThreadIds.length !== nextReceiverThreadIds.length) {
    return false;
  }

  for (let index = 0; index < previousReceiverThreadIds.length; index += 1) {
    if (previousReceiverThreadIds[index] !== nextReceiverThreadIds[index]) {
      return false;
    }
  }

  return true;
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
    if (!areChatSummariesEquivalent(previous[index], next[index])) {
      return false;
    }
  }

  return true;
}
