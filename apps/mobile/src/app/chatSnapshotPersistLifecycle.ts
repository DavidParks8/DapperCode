import { AppState, type AppStateStatus } from 'react-native';

interface AppStateSource {
  addEventListener(
    type: 'change',
    listener: (state: AppStateStatus) => void,
  ): { remove: () => void };
}

export interface ChatSnapshotPersistScheduler {
  /**
   * Debounce a pending write, replacing whatever write was previously
   * scheduled (if it hasn't fired yet) with this newer one.
   */
  schedule(write: () => void, delayMs: number): void;
  /**
   * Cancel a pending write without running it. Only safe to call when a
   * fresher `schedule()` call is about to follow in the same synchronous
   * pass (e.g. a debounce effect re-running because its inputs changed) -
   * otherwise the pending write is lost.
   */
  cancel(): void;
  /**
   * Run the pending write immediately, if one is scheduled, then clear the
   * scheduler so it can't fire (or be flushed) twice for the same write.
   * Safe to call repeatedly or when nothing is pending - it's then a no-op.
   */
  flush(): void;
}

/**
 * Debounces a single "latest write wins" callback (used for persisting the
 * chat snapshot cache) while guaranteeing the newest scheduled write is
 * never silently discarded: `flush()` always runs it immediately instead of
 * just canceling the timer.
 */
export function createChatSnapshotPersistScheduler(): ChatSnapshotPersistScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => void) | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    schedule(write, delayMs) {
      clearTimer();
      pending = write;
      timer = setTimeout(() => {
        timer = null;
        const run = pending;
        pending = null;
        run?.();
      }, delayMs);
    },
    cancel() {
      clearTimer();
      pending = null;
    },
    flush() {
      clearTimer();
      const run = pending;
      pending = null;
      run?.();
    },
  };
}

/**
 * Guarantees a debounced chat-snapshot write scheduled on
 * `ChatSnapshotPersistScheduler` is flushed - never merely discarded - when
 * the app backgrounds or the owning hook cleans up/unmounts. Mirrors
 * `bindAppWebSocketLifecycle`/`bindWorkspaceResourcesRevalidation`: an
 * `AppState` listener triggers the same flush the returned cleanup performs,
 * so the newest scheduled snapshot survives both app suspension and unmount
 * without ever running twice for the same write.
 */
export function bindChatSnapshotBackgroundFlush(
  scheduler: ChatSnapshotPersistScheduler,
  appState: AppStateSource = AppState,
): () => void {
  const subscription = appState.addEventListener('change', (state) => {
    if (state !== 'active') {
      scheduler.flush();
    }
  });

  return () => {
    subscription.remove();
    scheduler.flush();
  };
}
