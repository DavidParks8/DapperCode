import {
  createContext,
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
import { OnDeviceRuntime } from './runtime';

const RuntimeContext = createContext<OnDeviceRuntime | null>(null);

export function useOnDeviceRuntime(): OnDeviceRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) {
    throw new Error('On-device screens require their own runtime provider.');
  }
  useSyncExternalStore(runtime.subscribe, runtime.version, runtime.version);
  return runtime;
}

/**
 * Exposes a runtime owned elsewhere (the shell's local runtime host) to screens that read it
 * through `useOnDeviceRuntime`, so every on-device surface shares one runtime.
 */
export function OnDeviceRuntimeScope({
  runtime,
  children,
}: PropsWithChildren<{ runtime: OnDeviceRuntime }>) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
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
    try {
      const next = new OnDeviceRuntime(getOnDeviceNativeServices());
      runtime = next;
      void next
        .initialize()
        .then(async () => {
          if (!mounted) {
            return;
          }
          let previous = AppState.currentState;
          const changes = AppState.addEventListener('change', (state) => {
            if (state !== 'active' && previous === 'active') {
              void next.background().catch((failure: unknown) => next.report(failure));
            }
            previous = state;
          });
          const memory = AppState.addEventListener('memoryWarning', () => {
            void next.background().catch((failure: unknown) => next.report(failure));
          });
          removeLifecycle = () => {
            changes.remove();
            memory.remove();
          };
          if (previous !== 'active') {
            await next.background();
          }
          if (mounted) {
            setOwner(next);
          }
        })
        .catch((failure: unknown) => {
          if (mounted) {
            setError(
              failure instanceof Error ? failure.message : 'The local runtime could not start.',
            );
          }
        });
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Native on-device services are unavailable.',
      );
    }
    return () => {
      mounted = false;
      removeLifecycle?.();
      if (runtime) {
        void runtime
          .dispose()
          .catch((failure: unknown) =>
            console.error('Could not settle the on-device runtime:', failure),
          );
      }
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
