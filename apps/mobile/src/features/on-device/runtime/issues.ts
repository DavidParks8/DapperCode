import type { OnDeviceIssue } from './types';

const MAX_OPERATION_ISSUES = 5;

export function persistenceFailures(
  preferences: Error | null,
  drafts: Error | null,
  threads: ReadonlyMap<string, Error>,
): PersistenceFailure[] {
  return [
    ...(preferences ? [{ id: 'persistence:preferences', error: preferences, threadId: null }] : []),
    ...(drafts ? [{ id: 'persistence:drafts', error: drafts, threadId: null }] : []),
    ...[...threads].map(([threadId, error]) => ({
      id: `persistence:thread:${threadId}`,
      error,
      threadId,
    })),
  ];
}

/** Rethrows the first failure after every settled step has had a chance to run. */
export function throwFirstRejection(results: readonly PromiseSettledResult<unknown>[]): void {
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    throw failed.reason;
  }
}

interface SkippedDocuments {
  setAside: number;
  leftInPlace: number;
}

function plural(count: number, singular: string, many: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${many}`;
}

/** User-facing notices for documents startup skipped instead of failing closed. */
export function recoveryNotices(threads: SkippedDocuments, drafts: SkippedDocuments): string[] {
  const notices: string[] = [];
  if (threads.setAside > 0) {
    notices.push(
      `${plural(threads.setAside, 'damaged local conversation was', 'damaged local conversations were')} set aside with ${threads.setAside === 1 ? 'its' : 'their'} data preserved.`,
    );
  }
  if (threads.leftInPlace > 0) {
    notices.push(
      `${plural(threads.leftInPlace, 'local conversation could not be opened and was', 'local conversations could not be opened and were')} left in place.`,
    );
  }
  const draftCount = drafts.setAside + drafts.leftInPlace;
  if (draftCount > 0) {
    notices.push(
      `${plural(draftCount, 'damaged draft was', 'damaged drafts were')} skipped. ${draftCount === 1 ? 'Its' : 'Their'} data was preserved.`,
    );
  }
  return notices;
}

export interface PersistenceFailure {
  id: string;
  error: Error;
  threadId: string | null;
}

/**
 * Typed, dismissible runtime problems. Persistence failures are derived from their stores and
 * disappear when a write succeeds; operation and recovery notices remain until dismissed.
 */
export class RuntimeIssueLog {
  private operation: OnDeviceIssue[] = [];
  private recovery: OnDeviceIssue[] = [];
  private readonly dismissed = new Map<string, Error>();
  private cache: readonly OnDeviceIssue[] | null = null;
  private sequence = 0;

  constructor(
    private readonly persistence: () => PersistenceFailure[],
    private readonly changed: () => void,
  ) {}

  list(): readonly OnDeviceIssue[] {
    this.cache ??= [
      ...this.persistence()
        .filter((failure) => this.dismissed.get(failure.id) !== failure.error)
        .map((failure): OnDeviceIssue => ({
          id: failure.id,
          kind: 'persistence',
          message: failure.error.message,
          threadId: failure.threadId,
          retryable: true,
        })),
      ...this.recovery,
      ...this.operation,
    ];
    return this.cache;
  }

  invalidate(): void {
    this.cache = null;
    this.changed();
  }

  report(error: unknown, threadId: string | null): void {
    const message = error instanceof Error ? error.message : 'The on-device operation failed.';
    this.operation = [
      ...this.operation.filter((issue) => issue.message !== message || issue.threadId !== threadId),
      {
        id: `operation:${++this.sequence}`,
        kind: 'operation' as const,
        message,
        threadId,
        retryable: false,
      },
    ].slice(-MAX_OPERATION_ISSUES);
    this.invalidate();
  }

  recover(message: string): void {
    this.recovery = [
      ...this.recovery,
      {
        id: `recovery:${++this.sequence}`,
        kind: 'recovery',
        message,
        threadId: null,
        retryable: false,
      },
    ];
    this.invalidate();
  }

  /** A dismissed persistence failure reappears if a later write fails again. */
  dismiss(id: string): void {
    const failure = this.persistence().find((entry) => entry.id === id);
    if (failure) {
      this.dismissed.set(id, failure.error);
    }
    this.operation = this.operation.filter((issue) => issue.id !== id);
    this.recovery = this.recovery.filter((issue) => issue.id !== id);
    this.invalidate();
  }

  dismissTransient(): void {
    this.operation = [];
    this.recovery = [];
    this.invalidate();
  }

  dismissThread(threadId: string): void {
    this.operation = this.operation.filter((issue) => issue.threadId !== threadId);
    this.invalidate();
  }

  restoreDismissed(): void {
    this.dismissed.clear();
    this.invalidate();
  }
}
