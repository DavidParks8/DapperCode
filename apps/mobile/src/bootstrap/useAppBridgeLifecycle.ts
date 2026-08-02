import { useAtomValue, useStore } from 'jotai';
import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';

import {
  createEmptyChatSnapshotCache,
  getChatSnapshotCacheGeneration,
  loadChatSnapshotCache,
  saveChatSnapshotCache,
  updateChatSnapshotCache,
} from '../chatSnapshotCache';
import {
  bindChatSnapshotBackgroundFlush,
  createChatSnapshotPersistScheduler,
} from './chatSnapshotPersistLifecycle';
import { bindAppWebSocketLifecycle } from '../appWebSocketLifecycle';
import { syncPushRegistration } from '../pushController';
import { getActiveBridgeProfile } from '../bridgeProfiles';
import { appStateLoadedAtom, bridgeProfileStoreAtom } from '../state/appState/atoms';
import { initializeAppStateAtom } from '../state/appState/actions';
import { applyRestoredChatSnapshotAtom } from '../state/chat/actions';
import { activeChatAtom, chatSnapshotCacheAtom, selectedChatIdAtom } from '../state/chat/atoms';
import {
  activeBridgeProfileAtom,
  apiClientAtom,
  bridgeConnectedAtom,
  wsClientAtom,
} from '../state/bridge/atoms';
import {
  BRIDGE_CAPABILITIES_TTL_MS,
  revalidateBridgeCapabilitiesAtom,
} from '../state/bridge/capabilities';
import { bindBridgeCapabilitiesRevalidation } from '../state/bridge/capabilitiesLifecycle';
import {
  revalidateWorkspacePickerResourcesAtom,
  WORKSPACE_RESOURCES_TTL_MS,
} from '../state/mainScreen/workspaceActions';
import { bindWorkspaceResourcesRevalidation } from '../state/mainScreen/workspaceLifecycle';
import {
  APP_PREFETCH_CHAT_LIMIT,
  APP_PREFETCH_DELAY_MS,
  CHAT_SNAPSHOT_PERSIST_DELAY_MS,
} from './appConstants';

export function useAppBridgeLifecycle(): void {
  const store = useStore();
  const ws = useAtomValue(wsClientAtom);
  const api = useAtomValue(apiClientAtom);
  const pathname = usePathname();
  const isOnboarding = pathname === '/onboarding' || pathname.endsWith('/connection');
  const isWorkspacePicker = pathname.endsWith('/workspace-picker');
  const activeBridgeProfileId = useAtomValue(activeBridgeProfileAtom)?.id ?? null;
  const settingsLoaded = useAtomValue(appStateLoadedAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const activeChat = useAtomValue(activeChatAtom);
  const chatSnapshotCache = useAtomValue(chatSnapshotCacheAtom);
  const persistSchedulerRef = useRef<ReturnType<typeof createChatSnapshotPersistScheduler> | null>(
    null,
  );
  if (!persistSchedulerRef.current) {
    persistSchedulerRef.current = createChatSnapshotPersistScheduler();
  }
  const persistScheduler = persistSchedulerRef.current;

  useEffect(() => {
    if (!ws) {
      store.set(bridgeConnectedAtom, false);
      return;
    }

    return bindAppWebSocketLifecycle(ws);
  }, [store, ws]);

  useEffect(() => {
    if (!api || !ws || !activeBridgeProfileId) {
      return;
    }
    return bindBridgeCapabilitiesRevalidation(ws, () => {
      void store.set(revalidateBridgeCapabilitiesAtom, {
        ttlMs: BRIDGE_CAPABILITIES_TTL_MS,
      });
    });
  }, [activeBridgeProfileId, api, store, ws]);

  useEffect(() => {
    if (!api || !ws || !activeBridgeProfileId || !isWorkspacePicker) {
      return;
    }
    return bindWorkspaceResourcesRevalidation(ws, () => {
      void store.set(revalidateWorkspacePickerResourcesAtom, {
        ttlMs: WORKSPACE_RESOURCES_TTL_MS,
      });
    });
  }, [activeBridgeProfileId, api, isWorkspacePicker, store, ws]);

  useEffect(() => {
    if (!ws) {
      store.set(bridgeConnectedAtom, false);
      return;
    }

    store.set(bridgeConnectedAtom, ws.isConnected);
    return ws.onStatus((connected) => {
      store.set(bridgeConnectedAtom, connected);
    });
  }, [store, ws]);

  useEffect(() => {
    if (!api || !ws || !activeBridgeProfileId || isOnboarding) {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;
    const attempt = () => {
      if (cancelled || inFlight || !ws.isConnected) {
        return;
      }
      inFlight = true;
      void syncPushRegistration(api, store, activeBridgeProfileId)
        .then(() => {
          retryDelay = 1000;
        })
        .catch(() => {
          if (!cancelled) {
            retryTimer = setTimeout(attempt, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30_000);
          }
        })
        .finally(() => {
          inFlight = false;
        });
    };
    if (ws.isConnected) {
      attempt();
    }
    const unsubscribe = ws.onStatus((connected) => {
      if (connected) {
        attempt();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [activeBridgeProfileId, api, isOnboarding, store, ws]);

  useEffect(() => {
    if (!api || !ws || isOnboarding) {
      return;
    }

    let cancelled = false;
    let prefetchTimer: ReturnType<typeof setTimeout> | null = null;

    const runPrefetch = () => {
      if (cancelled) {
        return;
      }
      void api.primeChats({ limit: APP_PREFETCH_CHAT_LIMIT }).catch(() => {});
    };

    const schedulePrefetch = () => {
      if (prefetchTimer) {
        return;
      }

      prefetchTimer = setTimeout(() => {
        prefetchTimer = null;
        runPrefetch();
      }, APP_PREFETCH_DELAY_MS);
    };

    schedulePrefetch();
    const unsubscribeStatus = ws.onStatus((connected) => {
      if (connected) {
        schedulePrefetch();
      }
    });

    return () => {
      cancelled = true;
      if (prefetchTimer) {
        clearTimeout(prefetchTimer);
        prefetchTimer = null;
      }
      unsubscribeStatus();
    };
  }, [api, isOnboarding, ws]);

  useEffect(() => {
    let cancelled = false;

    const loadSettings = async () => {
      try {
        await store.set(initializeAppStateAtom);
        if (cancelled) {
          return;
        }
        const activeProfile = getActiveBridgeProfile(store.get(bridgeProfileStoreAtom));
        const snapshotCache = activeProfile ? await loadChatSnapshotCache(activeProfile.id) : null;
        if (cancelled) {
          return;
        }
        const selectedSnapshot =
          snapshotCache?.entries.find((entry) => entry.chat.id === snapshotCache.selectedChatId)
            ?.chat ?? null;

        store.set(chatSnapshotCacheAtom, snapshotCache);
        store.set(applyRestoredChatSnapshotAtom, selectedSnapshot);
      } catch {
        // The typed persistence error remains available in the app-state atoms.
      } finally {
        if (!cancelled && store.get(chatSnapshotCacheAtom) === undefined) {
          store.set(chatSnapshotCacheAtom, null);
        }
      }
    };

    void loadSettings();
    return () => {
      cancelled = true;
    };
  }, [store]);

  useEffect(() => {
    if (!api || !chatSnapshotCache || chatSnapshotCache.profileId !== activeBridgeProfileId) {
      return;
    }
    for (const entry of chatSnapshotCache.entries) {
      api.rememberChat(entry.chat);
    }
  }, [activeBridgeProfileId, api, chatSnapshotCache]);

  // Declared before the debounce-scheduling effect below so its cleanup runs
  // first on unmount (React runs effect cleanups in declaration order): the
  // newest pending snapshot is flushed to disk before the debounce effect's
  // own cleanup (which only cancels, to let a fresher reschedule replace it)
  // gets a chance to run. This is what guarantees the last transcript update
  // before backgrounding/unmount is never silently dropped.
  useEffect(() => {
    return bindChatSnapshotBackgroundFlush(persistScheduler);
  }, [persistScheduler]);

  // Only the hydration transition (undefined -> resolved) may gate persistence. Depending on the
  // cache value itself would re-run this effect for the write it just made and reschedule the
  // debounce forever.
  const chatSnapshotCacheHydrated = chatSnapshotCache !== undefined;

  useEffect(() => {
    if (!activeBridgeProfileId || !settingsLoaded || !chatSnapshotCacheHydrated) {
      return;
    }

    const generation = getChatSnapshotCacheGeneration(activeBridgeProfileId);
    persistScheduler.schedule(() => {
      const previous = store.get(chatSnapshotCacheAtom);
      const base =
        previous?.profileId === activeBridgeProfileId
          ? previous
          : createEmptyChatSnapshotCache(activeBridgeProfileId);
      const next = updateChatSnapshotCache(base, selectedChatId, activeChat);
      void saveChatSnapshotCache(next, generation).catch(() => {});
      store.set(chatSnapshotCacheAtom, next);
    }, CHAT_SNAPSHOT_PERSIST_DELAY_MS);

    // A dependency change re-runs this effect immediately with the fresher
    // selectedChatId/activeChat, so canceling here (rather than flushing) is
    // safe: the reschedule above replaces the canceled write in the same
    // synchronous pass. Only the background/unmount flush above needs to
    // guarantee execution.
    return () => {
      persistScheduler.cancel();
    };
  }, [
    activeBridgeProfileId,
    activeChat,
    chatSnapshotCacheHydrated,
    persistScheduler,
    selectedChatId,
    settingsLoaded,
    store,
  ]);
}
