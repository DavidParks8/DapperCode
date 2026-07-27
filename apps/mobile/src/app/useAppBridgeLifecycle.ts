import { useAtomValue, useStore } from 'jotai';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import {
  createEmptyChatSnapshotCache,
  loadChatSnapshotCache,
  saveChatSnapshotCache,
  updateChatSnapshotCache,
} from '../chatSnapshotCache';
import { bindAppWebSocketLifecycle } from '../appWebSocketLifecycle';
import { env } from '../config';
import { syncPushRegistration } from '../pushController';
import { getActiveUsableBridgeProfile } from '../bridgeProfiles';
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
import { currentScreenAtom } from '../state/navigation/atoms';
import {
  APP_PREFETCH_CHAT_LIMIT,
  APP_PREFETCH_DELAY_MS,
  CHAT_SNAPSHOT_PERSIST_DELAY_MS,
} from './appConstants';

export function useAppBridgeLifecycle(): void {
  const store = useStore();
  const ws = useAtomValue(wsClientAtom);
  const api = useAtomValue(apiClientAtom);
  const currentScreen = useAtomValue(currentScreenAtom);
  const activeBridgeProfileId = useAtomValue(activeBridgeProfileAtom)?.id ?? null;
  const settingsLoaded = useAtomValue(appStateLoadedAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const activeChat = useAtomValue(activeChatAtom);
  const chatSnapshotCache = useAtomValue(chatSnapshotCacheAtom);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!ws) {
      store.set(bridgeConnectedAtom, false);
      return;
    }

    return bindAppWebSocketLifecycle(ws);
  }, [store, ws]);

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
    if (!api || !ws || !activeBridgeProfileId || currentScreen === 'Onboarding') {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;
    const attempt = () => {
      if (cancelled || inFlight || !ws.isConnected) return;
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
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [activeBridgeProfileId, api, currentScreen, store, ws]);

  useEffect(() => {
    if (!api || !ws || currentScreen === 'Onboarding') {
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
  }, [api, currentScreen, ws]);

  useEffect(() => {
    let cancelled = false;

    const loadSettings = async () => {
      try {
        await store.set(initializeAppStateAtom);
        if (cancelled) {
          return;
        }
        const activeProfile = getActiveUsableBridgeProfile(
          store.get(bridgeProfileStoreAtom),
          Platform.OS === 'web' ? 'web' : 'native',
          env.hostBridgeToken,
          env.legacyHostBridgeUrl,
        );
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

  useEffect(() => {
    if (!activeBridgeProfileId || !settingsLoaded || chatSnapshotCache === undefined) {
      return;
    }

    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      const previous = store.get(chatSnapshotCacheAtom);
      const base =
        previous?.profileId === activeBridgeProfileId
          ? previous
          : createEmptyChatSnapshotCache(activeBridgeProfileId);
      const next = updateChatSnapshotCache(base, selectedChatId, activeChat);
      void saveChatSnapshotCache(next).catch(() => {});
      store.set(chatSnapshotCacheAtom, next);
    }, CHAT_SNAPSHOT_PERSIST_DELAY_MS);

    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [activeBridgeProfileId, activeChat, selectedChatId, settingsLoaded, store]);
}
