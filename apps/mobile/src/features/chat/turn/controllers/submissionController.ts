import * as Crypto from 'expo-crypto';

import {
  hashSubmissionRequest,
  type SubmissionIdempotencyStore,
} from './submissionIdempotencyCache';

export interface SubmissionScope {
  profileId: string;
  threadId: string | null;
}

export interface SubmissionDraftSnapshot {
  scopeKey: string;
  value: string;
  revision: number;
}

export interface ComposerSubmission {
  id: string;
  scopeKey: string;
  draft: string;
  mentions: string[];
  localImages: string[];
  draftRevision: number;
  clearedDraft: string | null;
  clearedDraftEntries: Array<{ scopeKey: string; draft: string }>;
  clearedRevision: number | null;
  clearedScopeKey: string | null;
}

export interface ClearedDraftEntry {
  scopeKey: string;
  draft: string;
}

const FAILED_SUBMISSION_LIMIT = 32;

export function submissionScopeKey(scope: SubmissionScope): string {
  return JSON.stringify([scope.profileId.trim(), scope.threadId?.trim() || null]);
}

export class SubmissionController {
  private readonly failed = new Map<string, ComposerSubmission>();
  private counter = 0;

  constructor(
    private readonly createId: () => string = () => '',
    // Optional cross-restart idempotency store. Only ever consulted/updated for submissions that
    // have actually failed (see `fail`) — a submission that never fails, and this session's
    // in-memory retry map, are never persisted here. Nothing is read from it except in response to
    // a user-initiated `begin()` call, so a restart never causes an automatic resend.
    private readonly idempotencyStore?: SubmissionIdempotencyStore,
  ) {}

  begin(
    snapshot: SubmissionDraftSnapshot,
    attachments: { mentions: string[]; localImages: string[] },
    interruptedSubmissionId?: string,
    inheritClearedDraftsFromSubmissionId?: string,
    inheritedClearedDraftEntries: readonly ClearedDraftEntry[] = [],
  ): ComposerSubmission {
    const retryKey = this.retryKey(snapshot.scopeKey, snapshot.value, attachments);
    const interruptedId = interruptedSubmissionId?.trim() || null;
    const failedRetry = this.failed.get(retryKey);
    const retry = !interruptedId || failedRetry?.id === interruptedId ? failedRetry : undefined;
    if (retry) {
      this.failed.delete(retryKey);
      retry.draftRevision = snapshot.revision;
      retry.clearedDraft = null;
      retry.clearedRevision = null;
      retry.clearedScopeKey = null;
      return retry;
    }
    const inheritedClearedDrafts = [
      ...this.takeClearedDraftEntries(inheritClearedDraftsFromSubmissionId),
      ...inheritedClearedDraftEntries,
    ].filter(
      (entry, index, entries) =>
        entries.findIndex(
          (candidate) => candidate.scopeKey === entry.scopeKey && candidate.draft === entry.draft,
        ) === index,
    );

    const requestHash = hashSubmissionRequest(snapshot.value, attachments);
    const persistedId =
      interruptedId ?? this.idempotencyStore?.lookup(snapshot.scopeKey, requestHash) ?? null;
    if (persistedId) {
      return {
        id: persistedId,
        scopeKey: snapshot.scopeKey,
        draft: snapshot.value,
        mentions: [...attachments.mentions],
        localImages: [...attachments.localImages],
        draftRevision: snapshot.revision,
        clearedDraft: null,
        clearedDraftEntries: inheritedClearedDrafts,
        clearedRevision: null,
        clearedScopeKey: null,
      };
    }

    const generated = this.createId().trim();
    this.counter += 1;
    return {
      id: generated || `submission-${createSubmissionNonce()}-${this.counter.toString(36)}`,
      scopeKey: snapshot.scopeKey,
      draft: snapshot.value,
      mentions: [...attachments.mentions],
      localImages: [...attachments.localImages],
      draftRevision: snapshot.revision,
      clearedDraft: null,
      clearedDraftEntries: inheritedClearedDrafts,
      clearedRevision: null,
      clearedScopeKey: null,
    };
  }

  markCleared(
    submission: ComposerSubmission,
    scopeKeyOrRevision: string | number,
    revision?: number,
    draft = submission.draft,
  ): void {
    const clearedScopeKey =
      typeof scopeKeyOrRevision === 'string' ? scopeKeyOrRevision : submission.scopeKey;
    submission.clearedDraft = draft;
    if (
      !submission.clearedDraftEntries.some(
        (entry) => entry.scopeKey === clearedScopeKey && entry.draft === draft,
      )
    ) {
      submission.clearedDraftEntries.push({ scopeKey: clearedScopeKey, draft });
    }
    submission.clearedScopeKey = clearedScopeKey;
    submission.clearedRevision =
      typeof scopeKeyOrRevision === 'number' ? scopeKeyOrRevision : (revision ?? null);
  }

  fail(submission: ComposerSubmission, current: SubmissionDraftSnapshot): boolean {
    const key = this.retryKey(submission.scopeKey, submission.draft, submission);
    this.failed.delete(key);
    this.failed.set(key, submission);
    while (this.failed.size > FAILED_SUBMISSION_LIMIT) {
      const oldest = this.failed.keys().next().value;
      if (!oldest) {
        break;
      }
      this.failed.delete(oldest);
    }
    this.idempotencyStore?.record(
      submission.scopeKey,
      hashSubmissionRequest(submission.draft, submission),
      submission.id,
    );
    return (
      submission.clearedRevision !== null &&
      current.scopeKey === submission.clearedScopeKey &&
      current.revision === submission.clearedRevision &&
      current.value === ''
    );
  }

  succeed(submission: ComposerSubmission): void {
    this.failed.delete(this.retryKey(submission.scopeKey, submission.draft, submission));
    this.idempotencyStore?.clear(
      submission.scopeKey,
      hashSubmissionRequest(submission.draft, submission),
    );
  }

  private takeClearedDraftEntries(submissionId?: string): Array<{
    scopeKey: string;
    draft: string;
  }> {
    const normalizedId = submissionId?.trim();
    if (!normalizedId) {
      return [];
    }
    for (const [key, failed] of this.failed) {
      if (failed.id === normalizedId) {
        this.failed.delete(key);
        return failed.clearedDraftEntries.map((entry) => ({ ...entry }));
      }
    }
    return [];
  }

  private retryKey(
    scopeKey: string,
    draft: string,
    attachments: { mentions: readonly string[]; localImages: readonly string[] },
  ): string {
    return JSON.stringify([scopeKey, draft, attachments.mentions, attachments.localImages]);
  }
}

function createSubmissionNonce(): string {
  try {
    const expoUuid = Crypto.randomUUID();
    if (expoUuid.trim()) {
      return expoUuid;
    }
  } catch {
    // HTTP web contexts may not provide Web Crypto randomUUID.
  }

  try {
    const webUuid = globalThis.crypto?.randomUUID?.();
    if (webUuid?.trim()) {
      return webUuid;
    }
  } catch {
    // Fall through to a non-cryptographic idempotency nonce.
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
