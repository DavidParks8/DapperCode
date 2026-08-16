import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { HostBridgeApiClient } from '@bridge/client/client';
import type { ChatSummary, RpcNotification } from '@bridge/types/types';
import type { HostBridgeWsClient } from '@bridge/ws/ws';
import { parseAgUiEventNotification } from '@bridge/agui/agUi';
import type { DrawerRunIndicatorMap } from '@shell/navigation/drawerRuntimeIndicators';
import { EventType } from '@ag-ui/core';

export const DRAWER_REFRESH_CONNECTED_MS = 10_000;
export const DRAWER_REFRESH_DISCONNECTED_MS = 5_000;
export const DRAWER_EVENT_REFRESH_DEBOUNCE_MS = 250;
export const DRAWER_OPEN_STALE_REFRESH_MS = 15_000;
export const DRAWER_CHAT_CACHE_TTL_MS = 30_000;
export const DRAWER_FAST_CHAT_LIST_LIMIT = 5;
export const DRAWER_FULL_CHAT_LIST_LIMIT = 20;
export const DRAWER_STREAM_CHAT_LIST_LIMITS = [5, 20, 50];
export const DRAWER_STREAM_BATCH_DELAY_MS = 900;
export const DRAWER_DEEP_CHAT_PAGE_LIMIT = 50;
export const DRAWER_DEEP_LOAD_DELAY_MS = 2500;
export const DRAWER_DEEP_CHAT_CACHE_TTL_MS = Number.MAX_SAFE_INTEGER;

interface DrawerClientIdentity {
  api: HostBridgeApiClient;
  profileId: string | null;
  ws: HostBridgeWsClient;
}

export function createDrawerClientGenerationGuard(generationRef: {
  current: number;
}): () => boolean {
  const generation = generationRef.current;
  return () => generationRef.current === generation;
}

export function advanceDrawerClientGeneration(
  identityRef: { current: DrawerClientIdentity },
  generationRef: { current: number },
  next: DrawerClientIdentity,
): boolean {
  const previous = identityRef.current;
  const changed =
    previous.api !== next.api || previous.profileId !== next.profileId || previous.ws !== next.ws;
  if (changed) {
    identityRef.current = next;
    generationRef.current += 1;
  }
  return changed;
}

export interface DrawerChatLoadingState {
  chats: ChatSummary[];
  loading: boolean;
  loadingOlderChats: boolean;
  partialHistoryDiagnostics: string[];
  refreshing: boolean;
  runIndicatorsByThread: DrawerRunIndicatorMap;
  wsConnected: boolean;
  loadChats: (showRefresh?: boolean, forceRefresh?: boolean) => Promise<void>;
  removeChat: (chatId: string) => void;
  restoreChat: (chat: ChatSummary) => void;
  retryDeepChatListRef: RefObject<() => Promise<void>>;
  cancelChatListStream: () => void;
  scheduleLoadChats: (delay?: number, forceRefresh?: boolean) => void;
  resetPollTimer: (delay?: number, forceRefresh?: boolean) => void;
  setRunIndicatorsByThread: Dispatch<SetStateAction<DrawerRunIndicatorMap>>;
}

export function drawerEventRequiresRefresh(event: RpcNotification): boolean {
  const agUiEvent = parseAgUiEventNotification(event)?.event;
  return (
    event.method === 'thread/started' ||
    event.method === 'thread/name/updated' ||
    event.method === 'thread/deleted' ||
    event.method === 'thread/status/changed' ||
    agUiEvent?.type === EventType.RUN_STARTED ||
    agUiEvent?.type === EventType.RUN_FINISHED ||
    agUiEvent?.type === EventType.RUN_ERROR
  );
}

/**
 * Reads the thread id from a `thread/deleted` notification. The drawer merges list batches, so a
 * deleted session has to be dropped explicitly instead of waiting for it to fall out of a refresh.
 */
export function readDeletedThreadId(event: RpcNotification): string | null {
  if (event.method !== 'thread/deleted') {
    return null;
  }
  const threadId = event.params?.['threadId'];
  return typeof threadId === 'string' && threadId.trim() ? threadId.trim() : null;
}
