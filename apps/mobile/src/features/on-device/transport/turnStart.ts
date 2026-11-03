import type { LocalThread } from '../runtime/types';
import { failure, interruptedBeforeStart, LOCAL_RPC_ERROR, LocalRpcError } from './errors';
import type { LocalAgentPort } from './port';

/**
 * Starts a local turn and resolves with its turn id once the user message is part of the thread;
 * the run then continues and reports through events. Rejects if the turn never started, including
 * a run stopped while its model was still loading.
 */
export function startLocalTurn(
  port: LocalAgentPort,
  thread: LocalThread,
  content: string,
  submissionId: string,
): Promise<string> {
  if (!content.trim()) {
    return Promise.reject(
      new LocalRpcError(LOCAL_RPC_ERROR.invalidParams, 'Enter a message.', {
        error: 'on_device_failed',
      }),
    );
  }
  const userMessageId = `user-${submissionId}`;
  if (thread.messages.some((message) => message.id === userMessageId)) {
    return Promise.resolve(
      thread.activeTurnId ?? `submission-${thread.lastSubmissionId ?? submissionId}`,
    );
  }
  const run = port.run();
  if (run.phase !== 'idle' && run.threadId !== thread.id) {
    return Promise.reject(
      new LocalRpcError(
        LOCAL_RPC_ERROR.serverError,
        'Another chat is running on this iPhone. Stop it or wait for it to finish.',
        { error: 'on_device_busy', threadId: run.threadId },
      ),
    );
  }
  return new Promise<string>((resolve, reject) => {
    let accepted = false;
    const accept = () => {
      if (accepted) {
        return;
      }
      accepted = true;
      const latest = port.thread(thread.id);
      resolve(latest?.activeTurnId ?? port.run().turnId ?? `submission-${submissionId}`);
    };
    port.send(thread.id, content, submissionId, accept).then(
      () => {
        // A run stopped while its model loaded ends without recording the message.
        const recorded = port
          .thread(thread.id)
          ?.messages.some((message) => message.id === userMessageId);
        if (recorded) {
          accept();
        } else if (!accepted) {
          reject(interruptedBeforeStart());
        }
      },
      (error: unknown) => {
        // After acceptance a failure reaches the shell as a RUN_ERROR event instead.
        if (!accepted) {
          reject(failure(error));
        }
      },
    );
  });
}
