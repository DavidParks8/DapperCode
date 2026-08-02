import { SubmissionController, submissionScopeKey } from './submissionController';
import type { SubmissionIdempotencyStore } from './submissionIdempotencyCache';
import * as Crypto from 'expo-crypto';

/** A minimal in-memory stand-in for the persisted `SubmissionIdempotencyCache`, so tests can
 * simulate the store surviving a restart while the `SubmissionController` (and its in-session
 * `failed` map) is thrown away and rebuilt from scratch. */
function fakeIdempotencyStore(): SubmissionIdempotencyStore & {
  entries: Map<string, string>;
} {
  const entries = new Map<string, string>();
  return {
    entries,
    lookup: jest.fn(
      (scopeKey: string, requestHash: string) =>
        entries.get(`${scopeKey}\u0000${requestHash}`) ?? null,
    ),
    record: jest.fn((scopeKey: string, requestHash: string, submissionId: string) => {
      entries.set(`${scopeKey}\u0000${requestHash}`, submissionId);
    }),
    clear: jest.fn((scopeKey: string, requestHash: string) => {
      entries.delete(`${scopeKey}\u0000${requestHash}`);
    }),
  };
}

describe('submissionController', () => {
  it('supports its default id factory', () => {
    expect(
      new SubmissionController().begin(
        { scopeKey: 'scope', value: '', revision: 0 },
        { mentions: [], localImages: [] },
      ).id,
    ).toMatch(/^submission-/);
  });

  it('falls back when Expo Crypto randomUUID is unavailable', () => {
    jest.spyOn(Crypto, 'randomUUID').mockImplementationOnce(() => {
      throw new TypeError('randomUUID unavailable');
    });
    expect(
      new SubmissionController().begin(
        { scopeKey: 'scope', value: 'web', revision: 0 },
        { mentions: [], localImages: [] },
      ).id,
    ).toMatch(/^submission-.+-1$/);
  });

  it('restores only the unchanged draft in the original profile and thread scope', () => {
    const controller = new SubmissionController(() => 'submission-1');
    const scopeKey = submissionScopeKey({ profileId: 'profile-a', threadId: 'thread-1' });
    const submission = controller.begin(
      { scopeKey, value: 'hello', revision: 2 },
      { mentions: ['/repo/a.ts'], localImages: ['/repo/a.png'] },
    );
    controller.markCleared(submission, 3);

    expect(controller.fail(submission, { scopeKey, value: '', revision: 3 })).toBe(true);
    expect(controller.fail(submission, { scopeKey, value: 'newer edit', revision: 4 })).toBe(false);
    expect(
      controller.fail(submission, {
        scopeKey: submissionScopeKey({ profileId: 'profile-b', threadId: 'thread-1' }),
        value: '',
        revision: 3,
      }),
    ).toBe(false);
  });

  it('reuses a failed submission id for an exact retry including attachments', () => {
    const controller = new SubmissionController(() => 'submission-1');
    const snapshot = { scopeKey: 'scope', value: 'hello', revision: 1 };
    const attachments = { mentions: ['/a'], localImages: ['/b'] };
    const first = controller.begin(snapshot, attachments);
    controller.markCleared(first, 2);
    controller.fail(first, { ...snapshot, value: '', revision: 2 });

    expect(controller.begin(snapshot, attachments).id).toBe('submission-1');
  });

  it('normalizes scopes and generates an id when the injected id is blank', () => {
    expect(submissionScopeKey({ profileId: ' profile ', threadId: '  ' })).toBe(
      JSON.stringify(['profile', null]),
    );
    const submission = new SubmissionController(() => ' ').begin(
      { scopeKey: 'scope', value: 'draft', revision: 0 },
      { mentions: [], localImages: [] },
    );
    expect(submission.id).toMatch(/^submission-.+-1$/);
  });

  it('does not restore uncleared or changed drafts and forgets successful failures', () => {
    const controller = new SubmissionController(() => 'id');
    const snapshot = { scopeKey: 'scope', value: 'draft', revision: 1 };
    const attachments = { mentions: [], localImages: [] };
    const submission = controller.begin(snapshot, attachments);
    expect(controller.fail(submission, { ...snapshot, value: '', revision: 1 })).toBe(false);
    expect(controller.begin(snapshot, attachments)).toBe(submission);
    controller.succeed(submission);
    expect(controller.begin(snapshot, attachments)).not.toBe(submission);
  });

  it('bounds retained failed submissions', () => {
    let id = 0;
    const controller = new SubmissionController(() => `id-${++id}`);
    for (let index = 0; index < 34; index += 1) {
      const submission = controller.begin(
        { scopeKey: 'scope', value: `draft-${index}`, revision: index },
        { mentions: [], localImages: [] },
      );
      controller.fail(submission, { scopeKey: 'scope', value: 'changed', revision: index });
    }
    expect(
      controller.begin(
        { scopeKey: 'scope', value: 'draft-0', revision: 0 },
        { mentions: [], localImages: [] },
      ).id,
    ).not.toBe('id-1');
  });

  describe('cross-restart idempotency store', () => {
    it('lets a user-initiated retry after restart reuse the same submission id', () => {
      const store = fakeIdempotencyStore();
      const scopeKey = submissionScopeKey({ profileId: 'profile-a', threadId: 'thread-1' });
      const snapshot = { scopeKey, value: 'ship it', revision: 1 };
      const attachments = { mentions: ['/a.ts'], localImages: [] };

      const beforeRestart = new SubmissionController(() => 'id-1', store);
      const submission = beforeRestart.begin(snapshot, attachments);
      beforeRestart.markCleared(submission, 2);
      beforeRestart.fail(submission, { ...snapshot, value: '', revision: 2 });

      // A fresh controller with an empty in-memory `failed` map stands in for the app restarting;
      // only the persisted store carries state across it.
      const afterRestart = new SubmissionController(() => 'id-2', store);
      const retry = afterRestart.begin(snapshot, attachments);

      expect(retry.id).toBe('id-1');
    });

    it('never reuses a submission id on its own — only when begin() is called with matching content', () => {
      const store = fakeIdempotencyStore();
      const scopeKey = submissionScopeKey({ profileId: 'profile-a', threadId: 'thread-1' });
      const snapshot = { scopeKey, value: 'ship it', revision: 1 };
      const attachments = { mentions: [], localImages: [] };

      const beforeRestart = new SubmissionController(() => 'id-1', store);
      const submission = beforeRestart.begin(snapshot, attachments);
      beforeRestart.markCleared(submission, 2);
      beforeRestart.fail(submission, { ...snapshot, value: '', revision: 2 });

      // Simulating a restart by constructing a new controller against the same store must not,
      // by itself, read from or write to the store (no auto-replay outbox).
      jest.clearAllMocks();
      new SubmissionController(() => 'id-2', store);
      expect(store.lookup).not.toHaveBeenCalled();
      expect(store.record).not.toHaveBeenCalled();
      expect(store.clear).not.toHaveBeenCalled();
    });

    it('does not reuse the persisted id after restart when the draft changed', () => {
      const store = fakeIdempotencyStore();
      const scopeKey = submissionScopeKey({ profileId: 'profile-a', threadId: 'thread-1' });
      const attachments = { mentions: [], localImages: [] };

      const beforeRestart = new SubmissionController(() => 'id-1', store);
      const submission = beforeRestart.begin(
        { scopeKey, value: 'original draft', revision: 1 },
        attachments,
      );
      beforeRestart.markCleared(submission, 2);
      beforeRestart.fail(submission, { scopeKey, value: '', revision: 2 });

      const afterRestart = new SubmissionController(() => 'id-2', store);
      const retry = afterRestart.begin(
        { scopeKey, value: 'edited draft', revision: 0 },
        attachments,
      );

      expect(retry.id).toBe('id-2');
    });

    it('clears the persisted mapping on successful settlement so it is never reused after restart', () => {
      const store = fakeIdempotencyStore();
      const scopeKey = submissionScopeKey({ profileId: 'profile-a', threadId: 'thread-1' });
      const snapshot = { scopeKey, value: 'ship it', revision: 1 };
      const attachments = { mentions: [], localImages: [] };

      const beforeRestart = new SubmissionController(() => 'id-1', store);
      const submission = beforeRestart.begin(snapshot, attachments);
      beforeRestart.markCleared(submission, 2);
      beforeRestart.fail(submission, { ...snapshot, value: '', revision: 2 });
      beforeRestart.succeed(submission);

      const afterRestart = new SubmissionController(() => 'id-2', store);
      const retry = afterRestart.begin(snapshot, attachments);

      expect(retry.id).toBe('id-2');
    });

    it('scopes persisted reuse by profile and thread so other scopes never collide', () => {
      const store = fakeIdempotencyStore();
      const attachments = { mentions: [], localImages: [] };
      const scopeA = submissionScopeKey({ profileId: 'profile-a', threadId: 'thread-1' });
      const scopeB = submissionScopeKey({ profileId: 'profile-b', threadId: 'thread-1' });
      const scopeAOtherThread = submissionScopeKey({
        profileId: 'profile-a',
        threadId: 'thread-2',
      });

      const beforeRestart = new SubmissionController(() => 'id-1', store);
      const submission = beforeRestart.begin(
        { scopeKey: scopeA, value: 'ship it', revision: 1 },
        attachments,
      );
      beforeRestart.markCleared(submission, 2);
      beforeRestart.fail(submission, { scopeKey: scopeA, value: '', revision: 2 });

      const afterRestart = new SubmissionController(() => 'id-2', store);
      expect(
        afterRestart.begin({ scopeKey: scopeB, value: 'ship it', revision: 1 }, attachments).id,
      ).toBe('id-2');
      expect(
        afterRestart.begin(
          { scopeKey: scopeAOtherThread, value: 'ship it', revision: 1 },
          attachments,
        ).id,
      ).toBe('id-2');
      expect(
        afterRestart.begin({ scopeKey: scopeA, value: 'ship it', revision: 1 }, attachments).id,
      ).toBe('id-1');
    });
  });
});
