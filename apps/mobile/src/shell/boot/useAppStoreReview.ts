import { atom, useAtomValue, useStore } from 'jotai';
import { usePathname } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  AUTO_STORE_REVIEW_THRESHOLD_MS,
  createDefaultAutoStoreReviewState,
  isAutoStoreReviewEligible,
  loadAutoStoreReviewState,
  requestNativeStoreReview,
  saveAutoStoreReviewState,
  type AutoStoreReviewState,
} from '@shell/storeReview';
import { appStateLoadedAtom } from '@shell/state/appState/atoms';
import { AUTO_STORE_REVIEW_RETRY_MS } from '@shell/boot/appConstants';
import {
  activeChatAtom,
  mainOpeningChatIdAtom,
  pendingMainChatSnapshotAtom,
} from '@shell/state/chat/atoms';
import { localAgentPresenceAtom } from '@shell/state/local/atoms';
import { storeReviewComposerOwnersAtom } from '@shell/state/storeReview';

const reviewInteractionPendingAtom = atom((get) => {
  const localPresence = get(localAgentPresenceAtom);
  return (
    get(storeReviewComposerOwnersAtom).size > 0 ||
    get(activeChatAtom)?.status === 'running' ||
    get(pendingMainChatSnapshotAtom)?.status === 'running' ||
    get(mainOpeningChatIdAtom) !== null ||
    (localPresence !== null && localPresence.status.kind !== 'ready')
  );
});

function isReviewRoute(pathname: string): boolean {
  return /\/chats\/[^/]+$/u.test(pathname);
}

export function useAppStoreReview(): void {
  const store = useStore();
  const settingsLoaded = useAtomValue(appStateLoadedAtom);
  const interactionPending = useAtomValue(reviewInteractionPendingAtom);
  const pathname = usePathname();
  const [appLifecycleState, setAppLifecycleState] = useState<AppStateStatus>(AppState.currentState);
  const [storeReviewStateLoaded, setStoreReviewStateLoaded] = useState(false);
  const [storeReviewState, setStoreReviewState] = useState<AutoStoreReviewState>(
    createDefaultAutoStoreReviewState,
  );
  const [automaticStoreReviewRetryAt, setAutomaticStoreReviewRetryAt] = useState<number | null>(
    null,
  );

  const appLifecycleStateRef = useRef(AppState.currentState);
  const activeUsageStartedAtRef = useRef<number | null>(null);
  const storeReviewStateRef = useRef<AutoStoreReviewState>(createDefaultAutoStoreReviewState());
  const automaticStoreReviewInFlightRef = useRef(false);
  const pathnameRef = useRef(pathname);

  useLayoutEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useLayoutEffect(() => {
    const currentState = AppState.currentState;
    appLifecycleStateRef.current = currentState;
    activeUsageStartedAtRef.current = currentState === 'active' ? Date.now() : null;
    setAppLifecycleState(currentState);
  }, []);

  const persistStoreReviewState = useCallback(async (nextState: AutoStoreReviewState) => {
    try {
      await saveAutoStoreReviewState(nextState);
    } catch {
      // Best effort persistence only.
    }
  }, []);

  const updateStoreReviewState = useCallback(
    (recipe: (previous: AutoStoreReviewState) => AutoStoreReviewState) => {
      setStoreReviewState((previous) => {
        const nextState = recipe(previous);
        if (
          previous.accumulatedForegroundMs === nextState.accumulatedForegroundMs &&
          previous.automaticRequestAt === nextState.automaticRequestAt
        ) {
          return previous;
        }

        storeReviewStateRef.current = nextState;
        void persistStoreReviewState(nextState);
        return nextState;
      });
    },
    [persistStoreReviewState],
  );

  const flushActiveUsageTime = useCallback(
    (now = Date.now(), keepActive = false) => {
      const activeUsageStartedAt = activeUsageStartedAtRef.current;
      if (appLifecycleStateRef.current !== 'active' || activeUsageStartedAt === null) {
        if (keepActive && appLifecycleStateRef.current === 'active') {
          activeUsageStartedAtRef.current = now;
        }
        return;
      }

      const elapsedMs = Math.max(0, now - activeUsageStartedAt);
      activeUsageStartedAtRef.current = keepActive ? now : null;
      if (elapsedMs <= 0) {
        return;
      }

      updateStoreReviewState((previous) => ({
        ...previous,
        accumulatedForegroundMs: previous.accumulatedForegroundMs + elapsedMs,
      }));
    },
    [updateStoreReviewState],
  );

  const getEffectiveForegroundUsageMs = useCallback(() => {
    const currentState = storeReviewStateRef.current;
    if (appLifecycleStateRef.current !== 'active' || activeUsageStartedAtRef.current === null) {
      return currentState.accumulatedForegroundMs;
    }

    return (
      currentState.accumulatedForegroundMs +
      Math.max(0, Date.now() - activeUsageStartedAtRef.current)
    );
  }, []);

  const canPresentAutomaticReview = useCallback(
    () =>
      appLifecycleStateRef.current === 'active' &&
      store.get(appStateLoadedAtom) &&
      !store.get(reviewInteractionPendingAtom) &&
      isReviewRoute(pathnameRef.current),
    [store],
  );

  const requestAutomaticStoreReview = useCallback(async () => {
    if (
      automaticStoreReviewInFlightRef.current ||
      !settingsLoaded ||
      !storeReviewStateLoaded ||
      !canPresentAutomaticReview() ||
      (automaticStoreReviewRetryAt !== null && automaticStoreReviewRetryAt > Date.now())
    ) {
      return;
    }

    const effectiveState: AutoStoreReviewState = {
      ...storeReviewStateRef.current,
      accumulatedForegroundMs: getEffectiveForegroundUsageMs(),
    };
    if (!isAutoStoreReviewEligible(effectiveState)) {
      return;
    }

    automaticStoreReviewInFlightRef.current = true;
    try {
      const now = Date.now();
      flushActiveUsageTime(now, true);
      const didRequest = await requestNativeStoreReview(canPresentAutomaticReview);
      if (!didRequest) {
        setAutomaticStoreReviewRetryAt(now + AUTO_STORE_REVIEW_RETRY_MS);
        return;
      }

      setAutomaticStoreReviewRetryAt(null);
      updateStoreReviewState((previous) => ({
        ...previous,
        automaticRequestAt: new Date(now).toISOString(),
      }));
    } catch (error) {
      setAutomaticStoreReviewRetryAt(Date.now() + AUTO_STORE_REVIEW_RETRY_MS);
      console.warn(
        `Automatic store review request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      automaticStoreReviewInFlightRef.current = false;
    }
  }, [
    automaticStoreReviewRetryAt,
    canPresentAutomaticReview,
    flushActiveUsageTime,
    getEffectiveForegroundUsageMs,
    settingsLoaded,
    storeReviewStateLoaded,
    updateStoreReviewState,
  ]);

  useEffect(() => {
    let cancelled = false;

    const loadStoreReviewPromptState = async () => {
      const nextState = await loadAutoStoreReviewState();
      if (cancelled) {
        return;
      }

      storeReviewStateRef.current = nextState;
      setStoreReviewState(nextState);
      setStoreReviewStateLoaded(true);
    };

    void loadStoreReviewPromptState();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const previousState = appLifecycleStateRef.current;
      if (previousState === 'active' && nextState !== 'active') {
        flushActiveUsageTime(Date.now(), false);
      }

      if (previousState !== 'active' && nextState === 'active') {
        activeUsageStartedAtRef.current = Date.now();
      }

      appLifecycleStateRef.current = nextState;
      setAppLifecycleState(nextState);
    });

    return () => {
      subscription.remove();
      flushActiveUsageTime(Date.now(), false);
    };
  }, [flushActiveUsageTime]);

  useEffect(() => {
    if (
      appLifecycleState !== 'active' ||
      !settingsLoaded ||
      !storeReviewStateLoaded ||
      interactionPending ||
      !isReviewRoute(pathname) ||
      storeReviewState.automaticRequestAt
    ) {
      return;
    }

    const thresholdRemainingMs = AUTO_STORE_REVIEW_THRESHOLD_MS - getEffectiveForegroundUsageMs();
    const retryRemainingMs =
      automaticStoreReviewRetryAt === null ? 0 : automaticStoreReviewRetryAt - Date.now();
    const remainingMs = Math.max(thresholdRemainingMs, retryRemainingMs);
    if (remainingMs <= 0) {
      void requestAutomaticStoreReview();
      return;
    }

    const timer = setTimeout(() => {
      void requestAutomaticStoreReview();
    }, remainingMs);

    return () => {
      clearTimeout(timer);
    };
  }, [
    appLifecycleState,
    automaticStoreReviewRetryAt,
    pathname,
    interactionPending,
    getEffectiveForegroundUsageMs,
    requestAutomaticStoreReview,
    settingsLoaded,
    storeReviewState.accumulatedForegroundMs,
    storeReviewState.automaticRequestAt,
    storeReviewStateLoaded,
  ]);
}
