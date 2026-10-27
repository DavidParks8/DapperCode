import { useStore } from 'jotai';
import { useEffect } from 'react';

import { loadChatSnapshotCache } from '@shell/session/chatSnapshotCache';
import { initializeAppStateAtom } from '@shell/state/appState/actions';
import { bridgeProfileStoreAtom } from '@shell/state/appState/atoms';
import { getActiveBridgeProfile } from '@shell/state/bridgeProfiles';
import { applyRestoredChatSnapshotAtom } from '@shell/state/chat/actions';
import { chatSnapshotCacheAtom } from '@shell/state/chat/atoms';

export function useAppStateBootstrap(): void {
  const store = useStore();
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        await store.set(initializeAppStateAtom);
        if (cancelled) {
          return;
        }
        const activeProfile = getActiveBridgeProfile(store.get(bridgeProfileStoreAtom));
        const cache = activeProfile ? await loadChatSnapshotCache(activeProfile.id) : null;
        if (cancelled) {
          return;
        }
        const selected =
          cache?.entries.find((entry) => entry.chat.id === cache.selectedChatId)?.chat ?? null;
        store.set(chatSnapshotCacheAtom, cache);
        store.set(applyRestoredChatSnapshotAtom, selected);
      } catch {
        // The typed persistence error remains available in the app-state atoms.
      } finally {
        if (!cancelled && store.get(chatSnapshotCacheAtom) === undefined) {
          store.set(chatSnapshotCacheAtom, null);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [store]);
}
