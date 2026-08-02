import { getSubAgentMeta } from '@bridge/messages';
import type {
  AcpConfigOption,
  Chat,
  ChatMessage,
  ChatSummary,
  ModelOption,
} from '@bridge/types/types';
import {
  countUserMessages,
  hasRecentUnansweredUserTurn,
  normalizeReasoningEffort,
} from '../helpers/helpers';

const EMPTY_MODEL_OPTIONS: ModelOption[] = [];
const LOCAL_TRANSCRIPT_MESSAGE_PREFIXES = [
  'local-command-',
  'local-assistant-',
  'local-system-',
] as const;
const CHAT_SUMMARY_IDENTITY_FIELDS = [
  'id',
  'title',
  'status',
  'createdAt',
  'updatedAt',
  'statusUpdatedAt',
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
  // Merge client-only entries first so later stale-transcript protection cannot discard them.
  const withLocalTranscript = preserveLocalTranscript(previous, next);
  const stabilizedNext = preserveRecentUserTurnTranscript(previous, withLocalTranscript);
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

  // A summary-only bridge fallback has no turns and must not erase already-hydrated history.
  if (previous.messages.length > 0 && next.messages.length === 0) {
    return withPreviousTranscript(previous, next);
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

  return withPreviousTranscript(previous, next);
}

function withPreviousTranscript(previous: Chat, next: Chat): Chat {
  return {
    ...next,
    lastMessagePreview: previous.lastMessagePreview,
    messages: previous.messages,
  };
}

function preserveLocalTranscript(previous: Chat, next: Chat): Chat {
  if (
    previous.id !== next.id ||
    !previous.messages.some((message) => isLocalTranscriptMessage(message))
  ) {
    return next;
  }

  const nextMessagesById = new Map(next.messages.map((message) => [message.id, message]));
  const messages = previous.messages.map((message) => nextMessagesById.get(message.id) ?? message);
  const mergedMessageIds = new Set(messages.map((message) => message.id));

  for (const message of next.messages) {
    if (mergedMessageIds.has(message.id)) {
      continue;
    }
    insertMessageByTimestamp(messages, message);
    mergedMessageIds.add(message.id);
  }

  const lastMessage = messages[messages.length - 1];
  return {
    ...next,
    lastMessagePreview: isLocalTranscriptMessage(lastMessage)
      ? previous.lastMessagePreview
      : next.lastMessagePreview,
    messages,
  };
}

function isLocalTranscriptMessage(message: ChatMessage | undefined): boolean {
  return Boolean(
    message && LOCAL_TRANSCRIPT_MESSAGE_PREFIXES.some((prefix) => message.id.startsWith(prefix)),
  );
}

function insertMessageByTimestamp(messages: ChatMessage[], message: ChatMessage): void {
  const createdAtMs = Date.parse(message.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    messages.push(message);
    return;
  }

  const insertionIndex = messages.findIndex((candidate) => {
    const candidateCreatedAtMs = Date.parse(candidate.createdAt);
    return Number.isFinite(candidateCreatedAtMs) && candidateCreatedAtMs > createdAtMs;
  });
  if (insertionIndex < 0) {
    messages.push(message);
  } else {
    messages.splice(insertionIndex, 0, message);
  }
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
    areChatSummaryFieldsEquivalent(previous, next, CHAT_SUMMARY_IDENTITY_FIELDS) &&
    areChatSummaryFieldsEquivalent(previous, next, CHAT_SUMMARY_AGENT_FIELDS) &&
    areChatSummaryFieldsEquivalent(previous, next, CHAT_SUMMARY_RUN_FIELDS)
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
    if (!previousStep || !nextStep) {
      return false;
    }
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
    if (!left || !right) {
      return false;
    }
    if (
      left.id !== right.id ||
      left.role !== right.role ||
      JSON.stringify(left.content) !== JSON.stringify(right.content) ||
      left.createdAt !== right.createdAt ||
      left.pending !== right.pending ||
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
