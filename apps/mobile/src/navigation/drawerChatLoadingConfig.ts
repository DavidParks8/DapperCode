import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { ChatSummary, RpcNotification } from '../api/types';
import { parseAgUiEventNotification } from '../api/agUi';
import type { DrawerRunIndicatorMap } from './drawerRuntimeIndicators';

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

export interface DrawerChatLoadingState {
  chats: ChatSummary[];
  loading: boolean;
  loadingOlderChats: boolean;
  partialHistoryDiagnostics: string[];
  refreshing: boolean;
  runIndicatorsByThread: DrawerRunIndicatorMap;
  wsConnected: boolean;
  loadChats: (showRefresh?: boolean, forceRefresh?: boolean) => Promise<void>;
  retryDeepChatListRef: RefObject<() => Promise<void>>;
  cancelChatListStream: () => void;
  scheduleLoadChats: (delay?: number, forceRefresh?: boolean) => void;
  setRunIndicatorsByThread: Dispatch<SetStateAction<DrawerRunIndicatorMap>>;
}

export function drawerEventRequiresRefresh(event: RpcNotification): boolean {
  const agUiEvent = parseAgUiEventNotification(event)?.event;
  return (
    event.method === 'thread/started' ||
    event.method === 'thread/name/updated' ||
    event.method === 'thread/status/changed' ||
    agUiEvent?.type === 'RUN_STARTED' ||
    agUiEvent?.type === 'RUN_FINISHED' ||
    agUiEvent?.type === 'RUN_ERROR'
  );
}
