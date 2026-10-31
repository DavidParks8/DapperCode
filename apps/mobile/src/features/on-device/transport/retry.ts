import type { LocalThread } from '../runtime/types';
import { failure, LOCAL_RPC_ERROR, LocalRpcError } from './errors';
import type { LocalAgentPort } from './port';

/**
 * Local-only method behind the shell's Retry action (the `turnRetry` profile feature): continues
 * the last failed or interrupted turn without resending the user message or replaying tools.
 */
export const LOCAL_TURN_RETRY_METHOD = 'bridge/turn/retry';

/** Starts a retry and resolves with its turn id once it runs, or rejects if it could not start. */
export function startLocalRetry(port: LocalAgentPort, thread: LocalThread): Promise<string> {
  const run = port.run();
  if (run.phase !== 'idle') {
    return Promise.reject(
      new LocalRpcError(
        LOCAL_RPC_ERROR.serverError,
        run.threadId === thread.id
          ? 'This chat is already running.'
          : 'Another chat is running on this iPhone. Stop it or wait for it to finish.',
        { error: 'on_device_busy', threadId: run.threadId },
      ),
    );
  }
  if (thread.status !== 'failed' && thread.status !== 'interrupted') {
    return Promise.reject(
      new LocalRpcError(LOCAL_RPC_ERROR.invalidParams, 'There is no failed turn to retry.', {
        error: 'on_device_failed',
      }),
    );
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (action: () => void) => {
      if (!settled) {
        settled = true;
        unsubscribe();
        action();
      }
    };
    const started = () => {
      const latest = port.thread(thread.id);
      if (latest?.status === 'running' && latest.activeTurnId) {
        const turnId = latest.activeTurnId;
        finish(() => resolve(turnId));
      }
    };
    unsubscribe = port.subscribe(started);
    port.retryTurn(thread.id).then(
      (latest) => finish(() => resolve(latest.activeTurnId ?? `retry-${thread.id}`)),
      (error: unknown) => finish(() => reject(failure(error))),
    );
    started();
  });
}
