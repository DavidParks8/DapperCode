import { GitAuthenticationError } from './strategy';

export interface AuthorizationClock {
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new GitAuthenticationError('cancelled', 'GitHub sign-in was cancelled.');
  }
}

export const authorizationClock: AuthorizationClock = {
  now: () => Date.now(),
  wait: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new GitAuthenticationError('cancelled', 'GitHub sign-in was cancelled.'));
        return;
      }
      const cancel = () => {
        clearTimeout(timer);
        reject(new GitAuthenticationError('cancelled', 'GitHub sign-in was cancelled.'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, milliseconds);
      signal.addEventListener('abort', cancel, { once: true });
    }),
};
