import {
  interruptedCreationRetryId,
  isPendingChatId,
  mergeRecoveredDraft,
  readInterruptedChatCreation,
} from './interruptedChatCreation';
import type { Chat } from '@bridge/types/types';

it('recognizes only local placeholder IDs', () => {
  expect(isPendingChatId('pending-submission')).toBe(true);
  expect(isPendingChatId('v1.YWdlbnQ.cGVuZGluZy1zZXNzaW9u')).toBe(false);
  expect(isPendingChatId(null)).toBe(false);
});

it('keeps saved edits and recovers text idempotently', () => {
  expect(mergeRecoveredDraft('Original', 'Edited')).toBe('Original\n\nEdited');
  expect(mergeRecoveredDraft('Original', 'Original\n\nEdited')).toBe('Original\n\nEdited');
  expect(mergeRecoveredDraft('Original\n\nEdited', 'Edited')).toBe('Original\n\nEdited');
  expect(mergeRecoveredDraft('Original', ' Original ')).toBe('Original');
});

it('reuses the original identity only for an unchanged same-profile text retry', () => {
  const recovery = {
    submissionId: 'original',
    pendingChatId: 'pending-original',
    draft: 'Recover',
    cwd: undefined,
    agentId: 'agent',
    hadAttachments: false,
  };
  expect(interruptedCreationRetryId(recovery, 'Recover', [], [], true, 'agent', null)).toBe(
    'original',
  );
  expect(
    interruptedCreationRetryId(recovery, 'Changed', [], [], true, 'agent', null),
  ).toBeUndefined();
  expect(
    interruptedCreationRetryId(recovery, 'Recover', ['/file'], [], true, 'agent', null),
  ).toBeUndefined();
  expect(
    interruptedCreationRetryId(recovery, 'Recover', [], ['/image'], true, 'agent', null),
  ).toBeUndefined();
  expect(
    interruptedCreationRetryId(recovery, 'Recover', [], [], false, 'agent', null),
  ).toBeUndefined();
  expect(
    interruptedCreationRetryId(
      { ...recovery, agentId: 'agent', cwd: '/one' },
      'Recover',
      [],
      [],
      true,
      'other',
      '/one',
    ),
  ).toBeUndefined();
  expect(
    interruptedCreationRetryId(
      { ...recovery, agentId: 'agent', cwd: '/one' },
      'Recover',
      [],
      [],
      true,
      'agent',
      '/other',
    ),
  ).toBeUndefined();
  expect(
    interruptedCreationRetryId(
      { ...recovery, hadAttachments: true },
      'Recover',
      [],
      [],
      true,
      'agent',
      null,
    ),
  ).toBeUndefined();
  expect(
    interruptedCreationRetryId(
      { ...recovery, agentId: undefined },
      'Recover',
      [],
      [],
      true,
      'agent',
      null,
    ),
  ).toBeUndefined();
});

it('recovers legacy attachment prompts as plain text without reusing their identity', () => {
  const at = new Date().toISOString();
  const chat: Chat = {
    id: 'pending-legacy',
    title: '',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    statusUpdatedAt: at,
    lastMessagePreview: 'Inspect this',
    messages: [
      {
        id: 'message',
        role: 'user',
        content: 'Inspect this\n[file: /tmp/report.txt]\n[local image: /tmp/image.png]',
        createdAt: at,
      },
    ],
  };
  expect(readInterruptedChatCreation(chat)).toMatchObject({
    submissionId: 'legacy',
    draft: 'Inspect this',
    hadAttachments: true,
  });
});
