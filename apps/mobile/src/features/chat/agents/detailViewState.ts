import type { useRouter } from 'expo-router';

import type { Chat, ChatSummary, RpcNotification } from '@bridge/types/types';
import type { useBridgeApi } from '@shell/state/bridge/hooks';
import { routes } from '@shell/navigation/routes';
import { extractNotificationThreadId } from '../helpers/helpers';
import { areChatStatusMapsEquivalent, resolveEquivalentChat } from '../state/chatState';
import { projectTranscript } from '../transcript/controllers/projectionController';
import type { ChatTranscriptViewProps } from '../transcript/ChatTranscriptView';
import type { buildAgentThreadDisplayState } from './threadDisplay';

export interface SubAgentDetailState {
  chat: Chat | null;
  parentChat: Chat | null;
  loading: boolean;
  error: string | null;
}

function resolveLoadedDetailChat(currentChat: Chat | null, chat: Chat): Chat {
  return currentChat?.id === chat.id ? resolveEquivalentChat(currentChat, chat) : chat;
}

export function resolveHydratedDetailState(
  current: SubAgentDetailState,
  chat: Chat,
  parentChat: Chat | null,
): SubAgentDetailState {
  const resolvedChat = resolveLoadedDetailChat(current.chat, chat);
  if (
    resolvedChat === current.chat &&
    parentChat === current.parentChat &&
    !current.loading &&
    current.error === null
  ) {
    return current;
  }

  return {
    chat: resolvedChat,
    parentChat,
    loading: false,
    error: null,
  };
}

export function resolveHydrationErrorState(
  current: SubAgentDetailState,
  showLoading: boolean,
  error: unknown,
): SubAgentDetailState {
  return {
    ...current,
    loading: false,
    error: !showLoading && current.chat ? current.error : (error as Error).message,
  };
}

export function resolveRefreshModeForEvent(options: {
  event: RpcNotification;
  threadId: string;
  detailChat: Chat | null;
  hydrationFailed: boolean;
  foregroundHydration: boolean;
}): boolean | null {
  const { event, threadId, detailChat, hydrationFailed, foregroundHydration } = options;
  if (event.method === 'bridge/events/snapshotRequired') {
    return foregroundHydration ? null : false;
  }

  const isAdoptedThread =
    event.method === 'thread/subagent/adopted' &&
    extractNotificationThreadId(event.params) === threadId;
  return isAdoptedThread && (!detailChat || hydrationFailed) ? true : null;
}

export function resolveRememberedDetailState(
  current: SubAgentDetailState,
  remembered: Chat,
): SubAgentDetailState {
  const chat = resolveLoadedDetailChat(current.chat, remembered);
  return chat === current.chat ? current : { ...current, chat };
}

export function resolveSubAgentSummary(options: {
  relatedAgentThreads: ChatSummary[];
  api: ReturnType<typeof useBridgeApi>;
  threadId: string;
  detailChat: Chat | null;
  revision: number;
}): ChatSummary | null {
  const { relatedAgentThreads, api, threadId, detailChat, revision } = options;
  void revision;
  return (
    relatedAgentThreads.find((candidate) => candidate.id === threadId) ??
    api.peekChatSummary(threadId) ??
    detailChat
  );
}

export function mergeSummaryIntoChat(
  detailChat: Chat | null,
  summary: ChatSummary | null,
): Chat | null {
  if (!detailChat || !summary || summary === detailChat) {
    return detailChat;
  }

  if (
    detailChat.status === summary.status &&
    detailChat.statusUpdatedAt === summary.statusUpdatedAt &&
    detailChat.lastError === summary.lastError
  ) {
    return detailChat;
  }

  return {
    ...detailChat,
    status: summary.status,
    statusUpdatedAt: summary.statusUpdatedAt,
    lastError: summary.lastError,
  };
}

export function resolveAgentThreadStatusById(
  previousStatuses: ReadonlyMap<string, Chat['status']>,
  relatedAgentThreads: ChatSummary[],
  chat: Chat | null,
): ReadonlyMap<string, Chat['status']> {
  const statuses = new Map(
    relatedAgentThreads.map((candidate) => [candidate.id, candidate.status] as const),
  );
  if (chat) {
    statuses.set(chat.id, chat.status);
  }
  return areChatStatusMapsEquivalent(previousStatuses, statuses) ? previousStatuses : statuses;
}

export function countProjectedMessages(options: {
  chat: Chat | null;
  parentChat: Chat | null;
  showToolCalls: boolean;
  threadStatuses: ReadonlyMap<string, Chat['status']>;
  liveMessageState: ChatTranscriptViewProps['liveMessageState'];
}): number {
  const { chat, parentChat, showToolCalls, threadStatuses, liveMessageState } = options;
  if (!chat) {
    return 0;
  }

  return projectTranscript({
    chat,
    parentChat,
    showToolCalls,
    threadStatuses,
    liveMessageState,
  }).messages.length;
}

function resolveActivityDetail(
  display: ReturnType<typeof buildAgentThreadDisplayState> | null,
  runtime: { latestCommand?: { detail?: string | null } | null } | null,
  summary: ChatSummary | null,
): string | null {
  return display?.detail ?? runtime?.latestCommand?.detail ?? summary?.agentRole?.trim() ?? null;
}

function resolveTranscriptVisibility(options: {
  summary: ChatSummary | null;
  chat: Chat | null;
  loading: boolean;
  projectedMessageCount: number;
}) {
  const { summary, chat, loading, projectedMessageCount } = options;
  const hasSummaryHistory = Boolean(summary?.lastMessagePreview.trim());
  const isKnownEmpty = Boolean(summary) && projectedMessageCount === 0 && !hasSummaryHistory;
  const hasNoVisibleTranscript =
    isKnownEmpty || (Boolean(chat) && !loading && projectedMessageCount === 0);
  const isStarting = hasNoVisibleTranscript && summary?.status === 'running';
  return {
    isKnownEmpty,
    isStarting,
    isEmpty: hasNoVisibleTranscript && !isStarting,
  };
}

export function resolveTranscriptState(options: {
  summary: ChatSummary | null;
  chat: Chat | null;
  loading: boolean;
  projectedMessageCount: number;
  display: ReturnType<typeof buildAgentThreadDisplayState> | null;
  runtime: { latestCommand?: { detail?: string | null } | null } | null;
}): {
  activityDetail: string | null;
  isStarting: boolean;
  isEmpty: boolean;
  isHydratingTranscript: boolean;
} {
  const { summary, chat, loading, projectedMessageCount, display, runtime } = options;
  const { isKnownEmpty, isStarting, isEmpty } = resolveTranscriptVisibility({
    summary,
    chat,
    loading,
    projectedMessageCount,
  });

  return {
    activityDetail: resolveActivityDetail(display, runtime, summary),
    isStarting,
    isEmpty,
    isHydratingTranscript: loading && projectedMessageCount === 0 && !isKnownEmpty,
  };
}

export function navigateBackFromSubAgent(
  router: ReturnType<typeof useRouter>,
  profileId?: string,
  chatId?: string,
) {
  if (router.canGoBack()) {
    router.back();
    return;
  }

  if (profileId && chatId) {
    router.dismissTo(routes.chat(profileId, chatId));
  }
}
