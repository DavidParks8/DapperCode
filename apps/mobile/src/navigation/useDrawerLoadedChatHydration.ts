import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { HostBridgeApiClient } from '../api/client';
import type { ChatSummary } from '../api/types';

const LOADED_SESSION_HYDRATION_DIAGNOSTIC = 'Some loaded sessions could not be refreshed.';

interface DrawerLoadedChatHydrationOptions {
  activeRef: { current: boolean };
  api: HostBridgeApiClient;
  applyChats: (chats: ChatSummary[], cacheLimit?: number) => void;
  setDiagnostics: Dispatch<SetStateAction<string[]>>;
}

export function useDrawerLoadedChatHydration({
  activeRef,
  api,
  applyChats,
  setDiagnostics,
}: DrawerLoadedChatHydrationOptions) {
  return useCallback(
    async (listedChats: ChatSummary[], cacheLimit?: number) => {
      const updateDiagnostic = (show: boolean) => {
        setDiagnostics((previous) => {
          const remaining = previous.filter(
            (message) => message !== LOADED_SESSION_HYDRATION_DIAGNOSTIC,
          );
          return show ? [...remaining, LOADED_SESSION_HYDRATION_DIAGNOSTIC] : remaining;
        });
      };
      try {
        const listedChatIds = new Set(listedChats.map((chat) => chat.id));
        const loadedIds = await api.listLoadedChatIds();
        // Dedupe before filtering so a bridge response with repeated ids (or
        // overlap across successive hydration calls) doesn't grow the missing
        // list and redundantly re-fetch/re-apply the same chat summaries.
        const uniqueLoadedIds = Array.from(new Set(loadedIds));
        const missingIds = uniqueLoadedIds.filter((threadId) => !listedChatIds.has(threadId));
        if (missingIds.length === 0) {
          updateDiagnostic(false);
          return;
        }

        const loadedChats = await api.getChatSummaries(missingIds);
        if (!activeRef.current) {
          return;
        }
        if (loadedChats.length > 0) {
          applyChats([...listedChats, ...loadedChats], cacheLimit);
        }
        const hydratedIds = new Set(loadedChats.map((chat) => chat.id));
        updateDiagnostic(missingIds.some((threadId) => !hydratedIds.has(threadId)));
      } catch {
        if (activeRef.current) {
          updateDiagnostic(true);
        }
      }
    },
    [activeRef, api, applyChats, setDiagnostics],
  );
}
