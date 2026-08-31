import { useAtom, useAtomValue } from 'jotai';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { HostBridgeApiClient } from '@bridge/client/client';
import type { HostBridgeWsClient } from '@bridge/ws/ws';
import {
  advanceDrawerClientGeneration,
  createDrawerClientGenerationGuard,
  DRAWER_CHAT_CACHE_TTL_MS,
  DRAWER_DEEP_CHAT_CACHE_TTL_MS,
  DRAWER_DEEP_CHAT_PAGE_LIMIT,
  DRAWER_DEEP_LOAD_DELAY_MS,
  DRAWER_EVENT_REFRESH_DEBOUNCE_MS,
  DRAWER_FAST_CHAT_LIST_LIMIT,
  DRAWER_FULL_CHAT_LIST_LIMIT,
  DRAWER_OPEN_STALE_REFRESH_MS,
  DRAWER_STREAM_BATCH_DELAY_MS,
  DRAWER_STREAM_CHAT_LIST_LIMITS,
  type DrawerChatLoadingState,
} from '@shell/navigation/drawerChatLoadingConfig';
import { useDrawerPrioritySessionHydration } from '@shell/navigation/useDrawerPrioritySessionHydration';
import { useDrawerChatCollection } from '@shell/navigation/useDrawerChatCollection';
import { useDrawerLoadedChatHydration } from '@shell/navigation/useDrawerLoadedChatHydration';
import { useDrawerChatLiveSync } from '@shell/navigation/useDrawerChatLiveSync';
import {
  createDrawerContentAtoms,
  type DrawerContentAtoms,
} from '@shell/state/drawer/contentAtoms';

export function useDrawerChatLoading(
  api: HostBridgeApiClient,
  ws: HostBridgeWsClient,
  active: boolean,
  priorityThreadIds: readonly string[] = [],
  profileId: string | null = api.profileId,
  contentAtoms?: DrawerContentAtoms,
): DrawerChatLoadingState {
  const fallbackAtomsRef = useRef<{
    atoms: DrawerContentAtoms;
    profileId: string | null;
  } | null>(null);
  let atoms = contentAtoms;
  if (!atoms) {
    if (!fallbackAtomsRef.current || fallbackAtomsRef.current.profileId !== profileId) {
      fallbackAtomsRef.current = {
        atoms: createDrawerContentAtoms({ profileId, wsConnected: ws.isConnected }),
        profileId,
      };
    }
    atoms = fallbackAtomsRef.current.atoms;
  }
  const [loading, setLoading] = useAtom(atoms.loadingAtom);
  const [loadingOlderChats, setLoadingOlderChats] = useAtom(atoms.loadingOlderChatsAtom);
  const [, setDeepHistoryDiagnostics] = useAtom(atoms.deepHistoryDiagnosticsAtom);
  const [, setHydrationDiagnostics] = useAtom(atoms.hydrationDiagnosticsAtom);
  const [refreshing, setRefreshing] = useAtom(atoms.refreshingAtom);
  const [wsConnected, setWsConnected] = useAtom(atoms.wsConnectedAtom);
  const handleChatsApplied = useCallback(() => {
    setLoading(false);
  }, [setLoading]);
  const {
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
  } = useDrawerChatCollection(api, profileId, handleChatsApplied, atoms);
  const loadChatsInFlightRef = useRef<Promise<void> | null>(null);
  const latestLoadChatsRef = useRef<
    (showRefresh?: boolean, forceRefresh?: boolean) => Promise<void>
  >(async () => {});
  const queuedLoadChatsRef = useRef<{ showRefresh: boolean; forceRefresh: boolean } | null>(null);
  const scheduledLoadChatsRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduledLoadChatsForceRefreshRef = useRef(false);
  const scheduledDeepLoadChatsRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatListStreamRef = useRef<{ cancel: () => void } | null>(null);
  const deepLoadInFlightRef = useRef<Promise<void> | null>(null);
  const hasLoadedDeepChatListRef = useRef(false);
  const hasLoadedWhileActiveRef = useRef(false);
  const activeRef = useRef(active);
  const clientGenerationRef = useRef(0);
  const clientIdentityRef = useRef({ api, profileId, ws });
  const hydrateLoadedChats = useDrawerLoadedChatHydration({
    activeRef,
    api,
    applyChats,
    setDiagnostics: setHydrationDiagnostics,
  });
  const cancelChatListStream = useCallback(() => {
    chatListStreamRef.current?.cancel();
    chatListStreamRef.current = null;
    if (scheduledDeepLoadChatsRef.current) {
      clearTimeout(scheduledDeepLoadChatsRef.current);
      scheduledDeepLoadChatsRef.current = null;
    }
  }, []);

  const handleThreadDeleted = useCallback(
    (threadId: string) => {
      api.forgetChat(threadId);
      removeChat(threadId);
    },
    [api, removeChat],
  );

  const loadChatsNow = useCallback(
    async (showRefresh = false, forceRefresh = false) => {
      const isCurrentClient = createDrawerClientGenerationGuard(clientGenerationRef);
      if (showRefresh) {
        setRefreshing(true);
      }

      const applyCachedDeepChats = () => {
        if (!isCurrentClient()) {
          return false;
        }
        const cachedDeepChats = api.peekAllChats({ includeSubAgents: true });
        if (!cachedDeepChats) {
          return false;
        }

        hasLoadedDeepChatListRef.current = true;
        if (activeRef.current) {
          setLoadingOlderChats(false);
        }
        applyChats(cachedDeepChats, undefined, false);
        return true;
      };

      const loadDeepChatsOnce = async (forceDeepRefresh = false) => {
        if (!isCurrentClient() || hasLoadedDeepChatListRef.current || deepLoadInFlightRef.current) {
          return;
        }
        if (!forceDeepRefresh && applyCachedDeepChats()) {
          return;
        }

        const request = api
          .listAllChats({
            includeSubAgents: true,
            pageLimit: DRAWER_DEEP_CHAT_PAGE_LIMIT,
            cacheTtlMs: DRAWER_DEEP_CHAT_CACHE_TTL_MS,
            forceRefresh: forceDeepRefresh,
            onPage: (loadedChats) => {
              if (isCurrentClient() && activeRef.current) {
                applyChats(loadedChats);
              }
            },
          })
          .then((result) => {
            if (!isCurrentClient()) {
              return;
            }
            hasLoadedDeepChatListRef.current = true;
            if (activeRef.current) {
              applyChats(result.chats, undefined, true, !result.partial);
              void hydrateLoadedChats(result.chats);
              setDeepHistoryDiagnostics(result.partial ? result.diagnostics : []);
            }
          })
          .catch(() => {})
          .finally(() => {
            if (deepLoadInFlightRef.current === request) {
              deepLoadInFlightRef.current = null;
            }
            if (isCurrentClient() && activeRef.current) {
              setLoadingOlderChats(false);
            }
          });

        if (isCurrentClient() && activeRef.current) {
          setLoadingOlderChats(true);
        }
        deepLoadInFlightRef.current = request;
        await request;
      };

      const scheduleDeepLoadChatsOnce = () => {
        if (!isCurrentClient()) {
          return;
        }
        if (deepLoadInFlightRef.current) {
          if (activeRef.current) {
            setLoadingOlderChats(true);
          }
          return;
        }
        if (hasLoadedDeepChatListRef.current || scheduledDeepLoadChatsRef.current) {
          return;
        }
        if (applyCachedDeepChats()) {
          return;
        }

        scheduledDeepLoadChatsRef.current = setTimeout(() => {
          scheduledDeepLoadChatsRef.current = null;
          if (isCurrentClient() && activeRef.current) {
            void loadDeepChatsOnce();
          }
        }, DRAWER_DEEP_LOAD_DELAY_MS);
      };

      retryDeepChatListRef.current = async () => {
        if (!isCurrentClient()) {
          return;
        }
        hasLoadedDeepChatListRef.current = false;
        await loadDeepChatsOnce(true);
      };

      const primeHiddenDrawerChats = async () => {
        try {
          const primedChats = await api.listChats({
            includeSubAgents: true,
            limit: DRAWER_FAST_CHAT_LIST_LIMIT,
            cacheTtlMs: DRAWER_CHAT_CACHE_TTL_MS,
            forceRefresh,
          });
          if (isCurrentClient()) {
            applyChats(primedChats, DRAWER_FAST_CHAT_LIST_LIMIT);
          }
        } catch {
          // Hidden drawer priming is best effort.
        } finally {
          if (isCurrentClient()) {
            setLoading(false);
          }
        }
      };

      const refreshNewestChatsOnTopOfCache = async () => {
        try {
          const latestChats = await api.listChats({
            includeSubAgents: true,
            limit: showRefresh ? DRAWER_FULL_CHAT_LIST_LIMIT : DRAWER_FAST_CHAT_LIST_LIMIT,
            cacheTtlMs: DRAWER_CHAT_CACHE_TTL_MS,
            forceRefresh,
          });
          if (isCurrentClient() && activeRef.current) {
            applyChats(
              latestChats,
              showRefresh ? DRAWER_FULL_CHAT_LIST_LIMIT : DRAWER_FAST_CHAT_LIST_LIMIT,
            );
          }
        } catch {
          // The cached full list is already visible; newest-chat refresh is best effort.
        }
      };

      const seedListFromPeekedCache = () => {
        if (!isCurrentClient()) {
          return;
        }
        const cachedFullChats = api.peekChats({
          includeSubAgents: true,
          limit: DRAWER_FULL_CHAT_LIST_LIMIT,
        });
        const cachedFastChats = cachedFullChats
          ? null
          : api.peekChats({
              includeSubAgents: true,
              limit: DRAWER_FAST_CHAT_LIST_LIMIT,
            });
        if (cachedFullChats) {
          applyChats(cachedFullChats, DRAWER_FULL_CHAT_LIST_LIMIT, false);
        } else if (cachedFastChats) {
          applyChats(cachedFastChats, DRAWER_FAST_CHAT_LIST_LIMIT, false);
        }
      };

      const fallbackReloadChats = async () => {
        if (!isCurrentClient()) {
          return;
        }
        try {
          const fastListedChats = await api.listChats({
            includeSubAgents: true,
            limit: DRAWER_FAST_CHAT_LIST_LIMIT,
            cacheTtlMs: DRAWER_CHAT_CACHE_TTL_MS,
            forceRefresh,
          });
          if (isCurrentClient() && activeRef.current) {
            applyChats(fastListedChats, DRAWER_FAST_CHAT_LIST_LIMIT);
          }

          if (!isCurrentClient()) {
            return;
          }
          const fullListedChats = await api.listChats({
            includeSubAgents: true,
            limit: DRAWER_FULL_CHAT_LIST_LIMIT,
            cacheTtlMs: DRAWER_CHAT_CACHE_TTL_MS,
            forceRefresh,
          });
          if (isCurrentClient() && activeRef.current) {
            applyChats(fullListedChats, DRAWER_FULL_CHAT_LIST_LIMIT);
            void hydrateLoadedChats(fullListedChats, DRAWER_FULL_CHAT_LIST_LIMIT);
            scheduleDeepLoadChatsOnce();
          }
        } catch {
          // silently fail
        }
      };

      const shouldSkipVisibleLoad = async () => {
        if (!isCurrentClient()) {
          return true;
        }
        if (activeRef.current) {
          return false;
        }
        await primeHiddenDrawerChats();
        return true;
      };
      if (await shouldSkipVisibleLoad()) {
        return;
      }
      hasLoadedWhileActiveRef.current = true;

      let streamStarted = false;
      let streamFinished = false;

      try {
        const hasCachedDeepChats = applyCachedDeepChats();
        if (hasCachedDeepChats) {
          await refreshNewestChatsOnTopOfCache();
          return;
        }

        seedListFromPeekedCache();

        cancelChatListStream();
        const stream = await api.startChatListStream(
          {
            includeSubAgents: true,
            limits: DRAWER_STREAM_CHAT_LIST_LIMITS,
            delayMs: DRAWER_STREAM_BATCH_DELAY_MS,
          },
          (batch) => {
            if (!isCurrentClient()) {
              return;
            }
            if (batch.done) {
              streamFinished = true;
              chatListStreamRef.current = null;
            }
            if (!activeRef.current) {
              return;
            }
            const authoritative = batch.done && batch.chats.length < batch.limit;
            applyChats(batch.chats, batch.limit, true, authoritative);
            if (showRefresh) {
              setRefreshing(false);
            }
            if (batch.done) {
              void hydrateLoadedChats(batch.chats, batch.limit);
              scheduleDeepLoadChatsOnce();
            }
          },
          () => {
            if (!isCurrentClient()) {
              return;
            }
            streamFinished = true;
            chatListStreamRef.current = null;
            if (showRefresh) {
              setRefreshing(false);
            }
            setLoading(false);
          },
        );
        streamStarted = true;
        if (!isCurrentClient() || !activeRef.current) {
          stream.cancel();
          streamFinished = true;
          if (isCurrentClient()) {
            chatListStreamRef.current = null;
          }
          return;
        }
        if (!streamFinished) {
          chatListStreamRef.current = stream;
        }
      } catch {
        await fallbackReloadChats();
      } finally {
        if (isCurrentClient() && (!streamStarted || streamFinished)) {
          if (showRefresh) {
            setRefreshing(false);
          }
          setLoading(false);
        }
      }
    },
    [
      api,
      applyChats,
      cancelChatListStream,
      hydrateLoadedChats,
      setDeepHistoryDiagnostics,
      setLoading,
      setLoadingOlderChats,
      setRefreshing,
    ],
  );

  const loadChats = useCallback(
    (showRefresh = false, forceRefresh = false) => {
      if (!active && hasHydratedOnceRef.current) {
        return Promise.resolve();
      }

      if (chatListStreamRef.current && !showRefresh) {
        return Promise.resolve();
      }

      if (showRefresh && scheduledLoadChatsRef.current) {
        clearTimeout(scheduledLoadChatsRef.current);
        scheduledLoadChatsRef.current = null;
      }

      if (loadChatsInFlightRef.current) {
        queuedLoadChatsRef.current = {
          showRefresh: showRefresh || queuedLoadChatsRef.current?.showRefresh === true,
          forceRefresh: forceRefresh || queuedLoadChatsRef.current?.forceRefresh === true,
        };
        return loadChatsInFlightRef.current;
      }

      const promise = loadChatsNow(showRefresh, forceRefresh).finally(() => {
        loadChatsInFlightRef.current = null;
        const queuedRequest = queuedLoadChatsRef.current;
        queuedLoadChatsRef.current = null;
        if (queuedRequest && !(chatListStreamRef.current && !queuedRequest.showRefresh)) {
          void latestLoadChatsRef.current(queuedRequest.showRefresh, queuedRequest.forceRefresh);
        }
      });

      loadChatsInFlightRef.current = promise;
      return promise;
    },
    [active, hasHydratedOnceRef, loadChatsNow],
  );
  latestLoadChatsRef.current = loadChats;
  const retryDeepChatListRef = useRef<() => Promise<void>>(async () => {});

  useLayoutEffect(() => {
    activeRef.current = active;
    return () => {
      activeRef.current = false;
    };
  }, [active]);

  useEffect(() => {
    void hydratePersistedChats();
  }, [hydratePersistedChats]);

  useEffect(() => {
    chatsRef.current = chats;
  }, [chats, chatsRef]);

  useDrawerPrioritySessionHydration({
    active,
    api,
    applyChats,
    chats,
    chatsRef,
    priorityThreadIds,
    setDiagnostics: setHydrationDiagnostics,
  });

  const scheduleLoadChats = useCallback(
    (delay = DRAWER_EVENT_REFRESH_DEBOUNCE_MS, forceRefresh = false) => {
      if (!active) {
        return;
      }

      if (scheduledLoadChatsRef.current) {
        scheduledLoadChatsForceRefreshRef.current =
          scheduledLoadChatsForceRefreshRef.current || forceRefresh;
        return;
      }

      scheduledLoadChatsForceRefreshRef.current = forceRefresh;
      scheduledLoadChatsRef.current = setTimeout(() => {
        scheduledLoadChatsRef.current = null;
        const shouldForceRefresh = scheduledLoadChatsForceRefreshRef.current;
        scheduledLoadChatsForceRefreshRef.current = false;
        void loadChats(false, shouldForceRefresh);
      }, delay);
    },
    [active, loadChats],
  );
  const cancelMaintenanceWork = useCallback(() => {
    if (scheduledLoadChatsRef.current) {
      clearTimeout(scheduledLoadChatsRef.current);
      scheduledLoadChatsRef.current = null;
    }
    scheduledLoadChatsForceRefreshRef.current = false;
    cancelChatListStream();
    queuedLoadChatsRef.current = null;
    setRefreshing(false);
    setLoadingOlderChats(false);
  }, [cancelChatListStream, setLoadingOlderChats, setRefreshing]);

  useLayoutEffect(() => {
    const clientIdentityChanged = advanceDrawerClientGeneration(
      clientIdentityRef,
      clientGenerationRef,
      { api, profileId, ws },
    );
    if (clientIdentityChanged) {
      cancelMaintenanceWork();
      deepLoadInFlightRef.current = null;
      hasLoadedDeepChatListRef.current = false;
      hasLoadedWhileActiveRef.current = false;
    }

    setWsConnected(ws.isConnected);
    const shouldPrimeHiddenDrawer = !hasHydratedOnceRef.current;
    // Hidden priming only fetches the short list; opening still needs the full load.
    const shouldRefreshVisibleDrawer =
      active &&
      (clientIdentityChanged ||
        !hasLoadedWhileActiveRef.current ||
        Date.now() - lastLoadedAtRef.current > DRAWER_OPEN_STALE_REFRESH_MS);
    if (!shouldPrimeHiddenDrawer && !shouldRefreshVisibleDrawer) {
      return;
    }

    void loadChats(false, shouldRefreshVisibleDrawer);
  }, [
    active,
    api,
    cancelMaintenanceWork,
    hasHydratedOnceRef,
    lastLoadedAtRef,
    loadChats,
    profileId,
    setWsConnected,
    ws,
  ]);

  const { resetPollTimer } = useDrawerChatLiveSync({
    active,
    cancelMaintenanceWork,
    onThreadDeleted: handleThreadDeleted,
    scheduleLoadChats,
    setRunIndicators: setRunIndicatorsByThread,
    setWsConnected,
    ws,
    wsConnected,
  });

  useEffect(() => {
    if (active) {
      return;
    }

    cancelMaintenanceWork();
  }, [active, cancelMaintenanceWork]);

  useEffect(() => {
    return () => {
      if (scheduledLoadChatsRef.current) {
        clearTimeout(scheduledLoadChatsRef.current);
        scheduledLoadChatsRef.current = null;
      }
      cancelChatListStream();
    };
  }, [cancelChatListStream]);

  const partialHistoryDiagnostics = useAtomValue(atoms.partialHistoryDiagnosticsAtom);
  return {
    chats,
    loading,
    loadingOlderChats,
    partialHistoryDiagnostics,
    refreshing,
    runIndicatorsByThread,
    wsConnected,
    loadChats,
    removeChat,
    restoreChat,
    retryDeepChatListRef,
    cancelChatListStream,
    scheduleLoadChats,
    resetPollTimer,
    setRunIndicatorsByThread,
  };
}
