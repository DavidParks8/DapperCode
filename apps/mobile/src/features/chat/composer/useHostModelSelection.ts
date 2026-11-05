import { useCallback, useLayoutEffect, useRef } from 'react';
import { setHostDefaultModel, type ModelHostTransport } from '@shared/hostModels';

export function useHostModelSelection(transport: ModelHostTransport, scope: string) {
  const pending = useRef<object | null>(null);
  useLayoutEffect(
    () => () => {
      pending.current = null;
    },
    [transport, scope],
  );

  return useCallback(
    (modelId: string, onApplied: () => void, onError: (error: Error) => void): boolean => {
      if (pending.current) {
        return false;
      }
      const request = {};
      pending.current = request;
      void (async () => {
        try {
          const result = await setHostDefaultModel(transport, modelId);
          if (pending.current !== request) {
            return;
          }
          if (result.modelId !== modelId) {
            throw new Error('The host did not confirm the selected model.');
          }
          onApplied();
        } catch (error) {
          if (pending.current === request) {
            onError(error instanceof Error ? error : new Error(String(error)));
          }
        } finally {
          if (pending.current === request) {
            pending.current = null;
          }
        }
      })();
      return true;
    },
    [transport],
  );
}
