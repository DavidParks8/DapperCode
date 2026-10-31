import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { getOnDeviceNativeServices } from '../native/services';
import { LocalAction, LocalPage, LocalText } from '../screens/ui';
import { createExpoNetwork } from './expoNetwork';
import { OnDeviceRuntime } from './runtime';
import type {
  LocalThread,
  OnDeviceIssue,
  OnDeviceReachability,
  OnDeviceRuntimeSlice,
} from './types';

const RuntimeContext = createContext<OnDeviceRuntime | null>(null);

/** Disposal of the previous owner; a new runtime is never constructed before it settles. */
let settling: Promise<unknown> = Promise.resolve();

function useRuntimeOwner(): OnDeviceRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) {
    throw new Error('On-device screens require their own runtime provider.');
  }
  return runtime;
}

/**
 * Returns the runtime and re-renders when any of `slices` changes. Omitting `slices` subscribes
 * to everything (download progress and token streams included), so prefer the narrowest set or
 * `useOnDeviceSelector`.
 */
export function useOnDeviceRuntime(slices?: readonly OnDeviceRuntimeSlice[]): OnDeviceRuntime {
  const runtime = useRuntimeOwner();
  const key = slices?.join(',');
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribe(listener, key?.split(',') as typeof slices),
    [runtime, key],
  );
  const version = useCallback(
    () => runtime.version(key?.split(',') as typeof slices),
    [runtime, key],
  );
  useSyncExternalStore(subscribe, version, version);
  return runtime;
}

/**
 * Re-renders only when the selected value changes (`Object.is`). The selector must return a
 * stable reference for unchanged state, such as a thread or snapshot object.
 */
export function useOnDeviceSelector<T>(
  selector: (runtime: OnDeviceRuntime) => T,
  slices?: readonly OnDeviceRuntimeSlice[],
): T {
  const runtime = useRuntimeOwner();
  const key = slices?.join(',');
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribe(listener, key?.split(',') as typeof slices),
    [runtime, key],
  );
  const select = () => selector(runtime);
  return useSyncExternalStore(subscribe, select, select);
}

const THREAD_SLICES: readonly OnDeviceRuntimeSlice[] = ['threads'];
const ISSUE_SLICES: readonly OnDeviceRuntimeSlice[] = ['issues'];
const NETWORK_SLICES: readonly OnDeviceRuntimeSlice[] = ['network'];

export function useOnDeviceThread(id: string): LocalThread | null {
  return useOnDeviceSelector((runtime) => runtime.threads.find(id), THREAD_SLICES);
}

export function useOnDeviceIssues(): readonly OnDeviceIssue[] {
  return useOnDeviceSelector((runtime) => runtime.issues(), ISSUE_SLICES);
}

export function useOnDeviceNetwork(): OnDeviceReachability {
  return useOnDeviceSelector((runtime) => runtime.network(), NETWORK_SLICES);
}

function message(failure: unknown, fallback: string): string {
  return failure instanceof Error ? failure.message : fallback;
}

export function OnDeviceProvider({
  children,
  recoveryAction,
}: PropsWithChildren<{ recoveryAction?: ReactNode }>) {
  const [owner, setOwner] = useState<OnDeviceRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let mounted = true;
    let runtime: OnDeviceRuntime | null = null;
    let removeLifecycle: (() => void) | undefined;
    setError(null);
    setOwner(null);
    const start = async () => {
      await settling;
      if (!mounted) {
        return;
      }
      let next: OnDeviceRuntime;
      try {
        next = new OnDeviceRuntime(getOnDeviceNativeServices(), { network: createExpoNetwork() });
      } catch (failure) {
        setError(message(failure, 'Native on-device services are unavailable.'));
        return;
      }
      runtime = next;
      try {
        await next.initialize();
      } catch (failure) {
        if (mounted) {
          setError(message(failure, 'The local runtime could not start.'));
        }
        return;
      }
      if (!mounted) {
        return;
      }
      // Only `background` suspends: `inactive` (Control Center, app switcher, calls, Face ID,
      // system alerts) is transient and must not stop a turn or unload the model.
      let backgrounded = AppState.currentState === 'background';
      const changes = AppState.addEventListener('change', (state) => {
        if (state === 'background' && !backgrounded) {
          backgrounded = true;
          void next.background().catch((failure: unknown) => next.report(failure));
        } else if (state === 'active' && backgrounded) {
          backgrounded = false;
          void next.foreground().catch((failure: unknown) => next.report(failure));
        }
      });
      const memory = AppState.addEventListener('memoryWarning', () => {
        void next.relieveMemory().catch((failure: unknown) => next.report(failure));
      });
      removeLifecycle = () => {
        changes.remove();
        memory.remove();
      };
      if (backgrounded) {
        await next.background().catch((failure: unknown) => next.report(failure));
      }
      if (mounted) {
        setOwner(next);
      }
    };
    void start();
    return () => {
      mounted = false;
      removeLifecycle?.();
      const previous = settling;
      settling = Promise.resolve().then(async () => {
        await previous;
        if (runtime) {
          await runtime
            .dispose()
            .catch((failure: unknown) =>
              console.error('Could not settle the on-device runtime:', failure),
            );
        }
      });
    };
  }, [attempt]);
  if (!owner) {
    return (
      <LocalPage title="On this iPhone" busy={!error} error={error}>
        <LocalText>Your local models, files, and conversations stay on this device.</LocalText>
        {error ? (
          <LocalAction
            title="Retry without resetting storage"
            onPress={() => setAttempt((value) => value + 1)}
          />
        ) : null}
        {error ? recoveryAction : null}
      </LocalPage>
    );
  }
  return <RuntimeContext.Provider value={owner}>{children}</RuntimeContext.Provider>;
}
