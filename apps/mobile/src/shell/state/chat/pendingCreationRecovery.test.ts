jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  readAsStringAsync: jest.fn(),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
}));

import type { Chat } from '@bridge/types/types';
import { createTestStore } from '@shell/state/testing';
import { createDefaultAppStateData } from '@shell/state/appState';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import * as FileSystem from 'expo-file-system/legacy';
import {
  createEmptyChatSnapshotCache,
  parseChatSnapshotCache,
  updateChatSnapshotCache,
} from '@shell/session/chatSnapshotCache';
import {
  applyRestoredChatSnapshotAtom,
  consumeInterruptedChatCreationAtom,
  discardInterruptedChatCreationAtom,
  linkInterruptedChatCreationAtom,
  persistPendingChatCreationAtom,
  replaceInterruptedChatSubmissionAtom,
} from './actions';
import {
  activeChatAtom,
  chatSnapshotCacheAtom,
  interruptedChatCreationAtom,
  pendingMainChatIdAtom,
  selectedChatIdAtom,
} from './atoms';

it('does not restore an interrupted local placeholder as a bridge chat', async () => {
  const at = new Date().toISOString();
  const pending: Chat = {
    id: 'pending-submission-interrupted',
    title: '',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    statusUpdatedAt: at,
    lastMessagePreview: 'The message that has not reached an agent',
    cwd: '/workspace',
    agentId: 'local-primary',
    activeTurnId: null,
    messages: [
      {
        id: 'msg-interrupted',
        role: 'user',
        content: 'The message that has not reached an agent',
        createdAt: at,
      },
    ],
  };
  const saved = updateChatSnapshotCache(
    createEmptyChatSnapshotCache('profile'),
    pending.id,
    pending,
  );
  const restored = parseChatSnapshotCache(JSON.stringify(saved), 'profile');
  const selected = restored.entries.find(({ chat }) => chat.id === restored.selectedChatId)?.chat;
  if (!selected) {
    throw new Error('Expected the pending snapshot to be selected.');
  }
  expect(selected.messages).toEqual(pending.messages);

  const store = createTestStore();
  store.set(chatSnapshotCacheAtom, restored);
  store.set(applyRestoredChatSnapshotAtom, selected);

  expect(store.get(selectedChatIdAtom)).toBeNull();
  expect(store.get(activeChatAtom)).toBeNull();
  expect(store.get(pendingMainChatIdAtom)).toBeNull();
  expect(store.get(interruptedChatCreationAtom)).toEqual({
    submissionId: 'submission-interrupted',
    pendingChatId: pending.id,
    draft: 'The message that has not reached an agent',
    cwd: pending.cwd,
    agentId: pending.agentId,
    hadAttachments: false,
  });
  expect(restored.entries[0]!.chat.messages).toEqual(pending.messages);

  await store.set(consumeInterruptedChatCreationAtom, {
    expectedPendingChatId: 'pending-stale-callback',
  });
  expect(store.get(interruptedChatCreationAtom)).toMatchObject({ pendingChatId: pending.id });
  expect(store.get(chatSnapshotCacheAtom)).toMatchObject({ selectedChatId: pending.id });
  await store.set(linkInterruptedChatCreationAtom, {
    profileId: 'profile',
    expectedPendingChatId: 'pending-stale-callback',
    createdChat: { ...pending, id: 'thread-wrong' },
  });
  expect(store.get(interruptedChatCreationAtom)).toMatchObject({
    createdChatId: undefined,
  });
  await store.set(linkInterruptedChatCreationAtom, {
    profileId: 'profile',
    expectedPendingChatId: pending.id,
    createdChat: { ...pending, id: 'thread-created' },
  });
  expect(store.get(interruptedChatCreationAtom)).toMatchObject({
    createdChatId: 'thread-created',
  });
  const linkedCache = store.get(chatSnapshotCacheAtom);
  if (!linkedCache) {
    throw new Error('Expected linked pending cache.');
  }
  expect(linkedCache.entries[0]!.chat.localPendingCreation).toMatchObject({
    createdChatId: 'thread-created',
  });
  const linkedSnapshot = linkedCache.entries[0]!.chat;
  store.set(applyRestoredChatSnapshotAtom, linkedSnapshot);
  expect(store.get(selectedChatIdAtom)).toBe('thread-created');
  expect(store.get(pendingMainChatIdAtom)).toBe('thread-created');
  expect(store.get(interruptedChatCreationAtom)).toMatchObject({
    createdChatId: 'thread-created',
  });

  await store.set(consumeInterruptedChatCreationAtom, {
    expectedPendingChatId: pending.id,
  });
  expect(store.get(interruptedChatCreationAtom)).toBeNull();
  expect(store.get(chatSnapshotCacheAtom)).toMatchObject({
    selectedChatId: null,
    entries: [],
  });
});

it('durably anchors a fresh pending creation before its first send', async () => {
  const at = new Date().toISOString();
  const pending: Chat = {
    id: 'pending-fresh-submission',
    title: '',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    statusUpdatedAt: at,
    lastMessagePreview: 'Fresh request',
    agentId: 'local-primary',
    cwd: '/workspace',
    localPendingCreation: {
      draft: '  Fresh request  ',
      hadAttachments: false,
      agentId: 'local-primary',
      cwd: '/workspace',
    },
    messages: [
      {
        id: 'msg-fresh',
        role: 'user',
        content: 'Fresh request',
        createdAt: at,
      },
    ],
  };
  const store = createTestStore();
  await store.set(linkInterruptedChatCreationAtom, {
    profileId: 'profile',
    expectedPendingChatId: pending.id,
    createdChat: {
      ...pending,
      id: 'thread-created',
      agentId: 'resolved-agent',
      cwd: '/resolved/workspace',
    },
    pendingChat: pending,
  });
  expect(store.get(interruptedChatCreationAtom)).toMatchObject({
    submissionId: 'fresh-submission',
    draft: '  Fresh request  ',
    createdChatId: 'thread-created',
    agentId: 'resolved-agent',
    cwd: '/resolved/workspace',
  });
  expect(store.get(chatSnapshotCacheAtom)).toMatchObject({
    profileId: 'profile',
    selectedChatId: pending.id,
  });
  expect(
    store.get(chatSnapshotCacheAtom)?.entries[0]?.chat.localPendingCreation?.createdChatId,
  ).toBe('thread-created');
});

it('persists a fresh pending identity before create dispatch', async () => {
  const at = new Date().toISOString();
  const pending: Chat = {
    id: 'pending-before-create',
    title: '',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    statusUpdatedAt: at,
    lastMessagePreview: 'Before create',
    agentId: 'local-primary',
    cwd: '/workspace',
    localPendingCreation: {
      profileId: 'profile',
      draft: 'Before create',
      hadAttachments: false,
      agentId: 'local-primary',
      cwd: '/workspace',
    },
    messages: [
      {
        id: 'msg-before-create',
        role: 'user',
        content: 'Before create',
        createdAt: at,
      },
    ],
  };
  const store = createTestStore();
  const persisted = await store.set(persistPendingChatCreationAtom, {
    profileId: 'profile',
    pendingChat: pending,
  });
  expect(persisted).toMatchObject({
    pendingChatId: pending.id,
    submissionId: 'before-create',
    profileId: 'profile',
  });
  expect(store.get(chatSnapshotCacheAtom)?.entries.map((entry) => entry.chat.id)).toEqual([
    pending.id,
  ]);
});

it('replaces a linked retry identity before sending changed content', async () => {
  const at = new Date().toISOString();
  const pending: Chat = {
    id: 'pending-original',
    title: '',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    statusUpdatedAt: at,
    lastMessagePreview: 'Original',
    agentId: 'local-primary',
    cwd: '/workspace',
    localPendingCreation: {
      profileId: 'profile',
      draft: 'Original',
      hadAttachments: false,
      agentId: 'local-primary',
      cwd: '/workspace',
      createdChatId: 'thread-created',
    },
    messages: [
      {
        id: 'msg-original',
        role: 'user',
        content: 'Original',
        createdAt: at,
      },
    ],
  };
  const store = createTestStore();
  store.set(
    chatSnapshotCacheAtom,
    updateChatSnapshotCache(createEmptyChatSnapshotCache('profile'), pending.id, pending),
  );
  store.set(applyRestoredChatSnapshotAtom, pending);
  const replaced = await store.set(replaceInterruptedChatSubmissionAtom, {
    profileId: 'profile',
    expectedPendingChatId: pending.id,
    submissionId: 'replacement',
    draft: 'Changed',
    hadAttachments: true,
    agentId: 'local-primary',
    cwd: '/workspace',
  });
  expect(replaced).toMatchObject({
    pendingChatId: 'pending-replacement',
    submissionId: 'replacement',
    draft: 'Changed',
    hadAttachments: true,
  });
  expect(store.get(chatSnapshotCacheAtom)?.entries.map((entry) => entry.chat.id)).toEqual([
    'pending-replacement',
  ]);
});

it('does not publish a completed cache write into a newly active profile', async () => {
  const data = createDefaultAppStateData();
  data.bridgeProfiles = {
    activeProfileId: 'profile-old',
    profiles: [
      {
        id: 'profile-old',
        name: 'Old',
        bridgeUrl: 'https://old.test',
        bridgeToken: 'old',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'profile-new',
        name: 'New',
        bridgeUrl: 'https://new.test',
        bridgeToken: 'new',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
  };
  const store = createTestStore({ data });
  const at = new Date().toISOString();
  const pending: Chat = {
    id: 'pending-old-profile',
    title: '',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    statusUpdatedAt: at,
    lastMessagePreview: 'Old profile',
    messages: [],
  };
  const oldCache = updateChatSnapshotCache(
    createEmptyChatSnapshotCache('profile-old'),
    pending.id,
    pending,
  );
  store.set(chatSnapshotCacheAtom, oldCache);
  store.set(applyRestoredChatSnapshotAtom, pending);
  let resolveWrite: (() => void) | undefined;
  jest.mocked(FileSystem.writeAsStringAsync).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        resolveWrite = resolve;
      }),
  );
  const consume = store.set(consumeInterruptedChatCreationAtom, {
    expectedPendingChatId: pending.id,
    profileId: 'profile-old',
  });
  for (let index = 0; index < 20 && !resolveWrite; index += 1) {
    await Promise.resolve();
  }
  expect(resolveWrite).toBeDefined();
  const snapshot = store.get(appStateSnapshotAtom);
  store.set(appStateSnapshotAtom, {
    ...snapshot,
    data: {
      ...snapshot.data,
      bridgeProfiles: {
        ...snapshot.data.bridgeProfiles,
        activeProfileId: 'profile-new',
      },
    },
  });
  const newCache = createEmptyChatSnapshotCache('profile-new');
  store.set(interruptedChatCreationAtom, null);
  store.set(chatSnapshotCacheAtom, newCache);
  resolveWrite?.();
  await consume;
  expect(store.get(interruptedChatCreationAtom)).toBeNull();
  expect(store.get(chatSnapshotCacheAtom)).toBe(newCache);
});

it('serializes replacement identities and publishes only the durable winner', async () => {
  const at = new Date().toISOString();
  const pending: Chat = {
    id: 'pending-chain-original',
    title: '',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    statusUpdatedAt: at,
    lastMessagePreview: 'Original',
    localPendingCreation: {
      profileId: 'profile-chain',
      draft: 'Original',
      hadAttachments: false,
      agentId: 'codex',
      cwd: '/workspace',
      createdChatId: 'thread-created',
    },
    messages: [],
  };
  const store = createTestStore();
  store.set(
    chatSnapshotCacheAtom,
    updateChatSnapshotCache(createEmptyChatSnapshotCache('profile-chain'), pending.id, pending),
  );
  store.set(applyRestoredChatSnapshotAtom, pending);
  let resolveWrite: (() => void) | undefined;
  jest
    .mocked(FileSystem.writeAsStringAsync)
    .mockClear()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const first = store.set(replaceInterruptedChatSubmissionAtom, {
    profileId: 'profile-chain',
    expectedPendingChatId: pending.id,
    submissionId: 'first',
    draft: 'First',
    hadAttachments: false,
    agentId: 'codex',
    cwd: '/workspace',
  });
  for (let index = 0; index < 20 && !resolveWrite; index += 1) {
    await Promise.resolve();
  }
  expect(resolveWrite).toBeDefined();
  expect(store.get(interruptedChatCreationAtom)?.pendingChatId).toBe(pending.id);
  const second = store.set(replaceInterruptedChatSubmissionAtom, {
    profileId: 'profile-chain',
    expectedPendingChatId: pending.id,
    submissionId: 'second',
    draft: 'Second',
    hadAttachments: false,
    agentId: 'codex',
    cwd: '/workspace',
  });
  resolveWrite?.();
  await expect(first).resolves.toMatchObject({ pendingChatId: 'pending-first' });
  await expect(second).resolves.toBeNull();
  expect(store.get(interruptedChatCreationAtom)?.pendingChatId).toBe('pending-first');
  expect(jest.mocked(FileSystem.writeAsStringAsync)).toHaveBeenCalledTimes(1);
});

it('does not publish a replacement identity until a failed write is retried', async () => {
  const at = new Date().toISOString();
  const pending: Chat = {
    id: 'pending-retry-original',
    title: '',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    statusUpdatedAt: at,
    lastMessagePreview: 'Original',
    localPendingCreation: {
      profileId: 'profile-retry',
      draft: 'Original',
      hadAttachments: false,
      agentId: 'codex',
      cwd: '/workspace',
      createdChatId: 'thread-created',
    },
    messages: [],
  };
  const store = createTestStore();
  store.set(
    chatSnapshotCacheAtom,
    updateChatSnapshotCache(createEmptyChatSnapshotCache('profile-retry'), pending.id, pending),
  );
  store.set(applyRestoredChatSnapshotAtom, pending);
  jest
    .mocked(FileSystem.writeAsStringAsync)
    .mockClear()
    .mockRejectedValueOnce(new Error('disk full'))
    .mockResolvedValue(undefined);
  const options = {
    profileId: 'profile-retry',
    expectedPendingChatId: pending.id,
    submissionId: 'replacement',
    draft: 'Replacement',
    hadAttachments: false,
    agentId: 'codex',
    cwd: '/workspace',
  };
  await expect(store.set(replaceInterruptedChatSubmissionAtom, options)).rejects.toThrow(
    'disk full',
  );
  expect(store.get(interruptedChatCreationAtom)?.pendingChatId).toBe(pending.id);
  await expect(store.set(replaceInterruptedChatSubmissionAtom, options)).resolves.toMatchObject({
    pendingChatId: 'pending-replacement',
  });
});

it('does not let stale consumption erase an in-flight replacement identity', async () => {
  const at = new Date().toISOString();
  const pending: Chat = {
    id: 'pending-consume-race',
    title: '',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    statusUpdatedAt: at,
    lastMessagePreview: 'Original',
    localPendingCreation: {
      profileId: 'profile-consume-race',
      draft: 'Original',
      hadAttachments: false,
      agentId: 'codex',
      cwd: '/workspace',
      createdChatId: 'thread-created',
    },
    messages: [],
  };
  const real = { ...pending, id: 'thread-created', localPendingCreation: undefined };
  const store = createTestStore();
  store.set(
    chatSnapshotCacheAtom,
    updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-consume-race'),
      pending.id,
      pending,
    ),
  );
  store.set(applyRestoredChatSnapshotAtom, pending);
  let resolveWrite: (() => void) | undefined;
  jest
    .mocked(FileSystem.writeAsStringAsync)
    .mockClear()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const replacement = store.set(replaceInterruptedChatSubmissionAtom, {
    profileId: 'profile-consume-race',
    expectedPendingChatId: pending.id,
    submissionId: 'replacement',
    draft: 'Changed',
    hadAttachments: false,
    agentId: 'codex',
    cwd: '/workspace',
  });
  for (let index = 0; index < 20 && !resolveWrite; index += 1) {
    await Promise.resolve();
  }
  const consumption = store.set(consumeInterruptedChatCreationAtom, {
    profileId: 'profile-consume-race',
    expectedPendingChatId: pending.id,
    replacement: real,
  });
  resolveWrite?.();
  await replacement;
  await consumption;
  expect(store.get(interruptedChatCreationAtom)?.pendingChatId).toBe('pending-replacement');
  expect(store.get(chatSnapshotCacheAtom)?.entries.map((entry) => entry.chat.id)).toEqual([
    'pending-replacement',
  ]);
  expect(jest.mocked(FileSystem.writeAsStringAsync)).toHaveBeenCalledTimes(1);
});

it('retries a failed discard with the current cache instead of erasing a newer pending chat', async () => {
  jest.useFakeTimers();
  const at = new Date().toISOString();
  const original: Chat = {
    id: 'pending-discard-original',
    title: '',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    statusUpdatedAt: at,
    lastMessagePreview: 'Original',
    messages: [],
  };
  const replacement: Chat = {
    ...original,
    id: 'pending-discard-replacement',
    lastMessagePreview: 'Replacement',
    localPendingCreation: {
      profileId: 'profile-discard',
      draft: 'Replacement',
      originalDraft: 'Replacement',
      hadAttachments: false,
      agentId: 'codex',
      cwd: '/workspace',
      createdChatId: 'thread-created',
    },
  };
  const store = createTestStore();
  store.set(
    chatSnapshotCacheAtom,
    updateChatSnapshotCache(createEmptyChatSnapshotCache('profile-discard'), original.id, original),
  );
  store.set(applyRestoredChatSnapshotAtom, original);
  jest
    .mocked(FileSystem.writeAsStringAsync)
    .mockClear()
    .mockRejectedValueOnce(new Error('first discard write failed'))
    .mockResolvedValue(undefined);
  store.set(discardInterruptedChatCreationAtom, {
    profileId: 'profile-discard',
    expectedPendingChatId: original.id,
  });
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
  await store.set(persistPendingChatCreationAtom, {
    profileId: 'profile-discard',
    pendingChat: replacement,
  });
  let resolveReplacementWrite: (() => void) | undefined;
  jest
    .mocked(FileSystem.writeAsStringAsync)
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveReplacementWrite = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const replacementWrite = store.set(replaceInterruptedChatSubmissionAtom, {
    profileId: 'profile-discard',
    expectedPendingChatId: replacement.id,
    submissionId: 'discard-winner',
    draft: 'Winner',
    hadAttachments: false,
    agentId: 'codex',
    cwd: '/workspace',
  });
  for (let index = 0; index < 20 && !resolveReplacementWrite; index += 1) {
    await Promise.resolve();
  }
  await jest.advanceTimersByTimeAsync(1000);
  resolveReplacementWrite?.();
  await replacementWrite;
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
  const lastWrite = jest.mocked(FileSystem.writeAsStringAsync).mock.lastCall?.[1] ?? '';
  expect(lastWrite).toContain('pending-discard-winner');
  jest.useRealTimers();
});
