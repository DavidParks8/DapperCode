import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostBridgeApiClient } from '../api/client';
import type { ChatSummary } from '../api/types';
import {
  deletePersistedChatSummary,
  getChatSummaryCacheGeneration,
  loadChatSummaryCache,
  persistChatSummaries,
  reconcilePersistedChatSummaries,
} from '../chatSummaryCache';
import {
  areDrawerChatListsEquivalent,
  dedupeChatsById,
  mergeDrawerChatBatch,
  sortChats,
} from './drawerContentHelpers';
import {
  reconcileDrawerRunIndicatorsWithChats,
  type DrawerRunIndicatorMap,
} from './drawerRuntimeIndicators';

export const DRAWER_CHAT_SUMMARY_PERSIST_DEBOUNCE_MS = 1000;

export function useDrawerChatCollection(
  api: HostBridgeApiClient,
  profileId: string | null,
  onChatsApplied: () => void,
) {
  const [chatState, setChatState] = useState<{ profileId: string | null; chats: ChatSummary[] }>({
    profileId,
    chats: [],
  });
  const [runIndicatorsByThread, setRunIndicatorsByThread] = useState<DrawerRunIndicatorMap>({});
  const chatsRef = useRef<ChatSummary[]>([]);
  const hasHydratedOnceRef = useRef(false);
  const deletedChatIdsRef = useRef(new Set<string>());
  const hasAppliedAuthoritativeListRef = useRef(false);
  const lastLoadedAtRef = useRef(0);
  const pendingPersistenceRef = useRef<{
    profileId: string;
    summaries: ChatSummary[];
    generation: number;
  } | null>(null);
  const persistenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const profileIdRef = useRef(profileId);
  if (profileIdRef.current !== profileId) {
    profileIdRef.current = profileId;
    chatsRef.current = [];
    hasHydratedOnceRef.current = false;
    deletedChatIdsRef.current.clear();
    hasAppliedAuthoritativeListRef.current = false;
    lastLoadedAtRef.current = 0;
  }
  const chats = chatState.profileId === profileId ? chatState.chats : [];

  const flushPendingPersistence = useCallback(() => {
    if (persistenceTimerRef.current) {
      clearTimeout(persistenceTimerRef.current);
      persistenceTimerRef.current = null;
    }
    const pending = pendingPersistenceRef.current;
    pendingPersistenceRef.current = null;
    if (pending) {
      // Pass along the generation captured when this batch was scheduled
      // (not the generation as of this flush): if a bridge-profile purge or
      // in-place identity edit bumped the barrier in between, the write is
      // stale and persistChatSummaries drops it instead of resurrecting
      // data the purge already removed.
      void persistChatSummaries(
        pending.profileId,
        pending.summaries,
        undefined,
        pending.generation,
      ).catch(() => {});
    }
  }, []);

  const schedulePersistence = useCallback(
    (summaries: ChatSummary[]) => {
      if (!profileId) {
        return;
      }
      if (pendingPersistenceRef.current && pendingPersistenceRef.current.profileId !== profileId) {
        flushPendingPersistence();
      }
      const pending = pendingPersistenceRef.current;
      // Capture the barrier once so the carry-forward check and the stamped
      // generation agree: if a purge or in-place identity edit bumped the
      // generation since `pending` was buffered, its summaries are stale and
      // must be dropped instead of being merged forward and stamped with the
      // new (current) generation - that would smuggle purged data past the
      // barrier check that runs at flush time.
      const generation = getChatSummaryCacheGeneration(profileId);
      const canCarryForwardPending =
        pending?.profileId === profileId && pending.generation === generation;
      pendingPersistenceRef.current = {
        profileId,
        summaries: mergeDrawerChatBatch(canCarryForwardPending ? pending.summaries : [], summaries),
        generation,
      };
      if (persistenceTimerRef.current) {
        clearTimeout(persistenceTimerRef.current);
      }
      persistenceTimerRef.current = setTimeout(
        flushPendingPersistence,
        DRAWER_CHAT_SUMMARY_PERSIST_DEBOUNCE_MS,
      );
    },
    [flushPendingPersistence, profileId],
  );

  const applyChats = useCallback(
    (rawChats: ChatSummary[], cacheLimit?: number, persist = true, authoritative = false) => {
      if (profileIdRef.current !== profileId) {
        return;
      }
      const incomingChats = sortChats(
        dedupeChatsById(rawChats).filter((chat) => !deletedChatIdsRef.current.has(chat.id)),
      );
      const shouldPreserveExisting =
        hasHydratedOnceRef.current || chatsRef.current.length > incomingChats.length;
      if (authoritative) {
        hasAppliedAuthoritativeListRef.current = true;
      }
      const nextChats = authoritative
        ? incomingChats
        : shouldPreserveExisting
          ? mergeDrawerChatBatch(chatsRef.current, incomingChats)
          : incomingChats;
      chatsRef.current = nextChats;
      setChatState((previous) => {
        const previousChats = previous.profileId === profileId ? previous.chats : [];
        return areDrawerChatListsEquivalent(previousChats, nextChats)
          ? previous
          : { profileId, chats: nextChats };
      });
      if (cacheLimit) {
        const cacheKeyLimit = Math.max(cacheLimit, Math.min(nextChats.length, 200));
        api.rememberChats(nextChats, { includeSubAgents: true, limit: cacheKeyLimit });
      }
      if (persist && profileId) {
        if (authoritative) {
          if (persistenceTimerRef.current) {
            clearTimeout(persistenceTimerRef.current);
            persistenceTimerRef.current = null;
          }
          pendingPersistenceRef.current = null;
          void reconcilePersistedChatSummaries(profileId, incomingChats).catch(() => {});
        } else {
          schedulePersistence(incomingChats);
        }
      }
      hasHydratedOnceRef.current = true;
      lastLoadedAtRef.current = Date.now();
      onChatsApplied();
      setRunIndicatorsByThread((previous) =>
        reconcileDrawerRunIndicatorsWithChats(previous, nextChats),
      );
    },
    [api, onChatsApplied, profileId, schedulePersistence],
  );

  const hydratePersistedChats = useCallback(async () => {
    if (!profileId) {
      onChatsApplied();
      return;
    }
    // Capture the barrier before the (async) load so a purge or in-place
    // identity edit that lands while the read is in flight can be detected
    // afterward - the stale read is discarded instead of hydrating the UI
    // (and re-persisting, via later applyChats calls) with old-identity data.
    const generation = getChatSummaryCacheGeneration(profileId);
    const cache = await loadChatSummaryCache(profileId);
    if (
      profileIdRef.current !== profileId ||
      hasAppliedAuthoritativeListRef.current ||
      cache.entries.length === 0 ||
      getChatSummaryCacheGeneration(profileId) !== generation
    ) {
      return;
    }
    applyChats(
      cache.entries.map((entry) => entry.summary),
      undefined,
      false,
    );
  }, [applyChats, onChatsApplied, profileId]);

  const removeChat = useCallback(
    (chatId: string) => {
      const pending = pendingPersistenceRef.current;
      if (pending) {
        pendingPersistenceRef.current = {
          ...pending,
          summaries: pending.summaries.filter((summary) => summary.id !== chatId),
        };
      }
      const nextChats = chatsRef.current.filter((chat) => chat.id !== chatId);
      deletedChatIdsRef.current.add(chatId);
      if (nextChats.length === chatsRef.current.length) {
        if (profileId) {
          void deletePersistedChatSummary(profileId, chatId).catch(() => {});
        }
        return;
      }
      chatsRef.current = nextChats;
      setChatState({ profileId, chats: nextChats });
      if (profileId) {
        void deletePersistedChatSummary(profileId, chatId).catch(() => {});
      }
      setRunIndicatorsByThread((previous) =>
        reconcileDrawerRunIndicatorsWithChats(previous, nextChats),
      );
    },
    [profileId],
  );

  const restoreChat = useCallback(
    (chat: ChatSummary) => {
      if (chatsRef.current.some((existing) => existing.id === chat.id)) {
        return;
      }
      deletedChatIdsRef.current.delete(chat.id);
      const nextChats = sortChats([...chatsRef.current, chat]);
      chatsRef.current = nextChats;
      setChatState({ profileId, chats: nextChats });
      if (profileId) {
        schedulePersistence([chat]);
      }
    },
    [profileId, schedulePersistence],
  );

  useEffect(() => flushPendingPersistence, [flushPendingPersistence, profileId]);

  return {
    applyChats,
    chats,
    chatsRef,
    hasHydratedOnceRef,
    hydratePersistedChats,
    lastLoadedAtRef,
    removeChat,
    restoreChat,
    runIndicatorsByThread,
    setRunIndicatorsByThread,
  };
}
