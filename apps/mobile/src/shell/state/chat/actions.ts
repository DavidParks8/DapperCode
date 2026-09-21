import { atom, type Getter, type Setter } from 'jotai';

import type { Chat } from '@bridge/types/types';
import {
  readInterruptedChatCreation,
  type InterruptedChatCreation,
} from '@shell/session/interruptedChatCreation';
import {
  getChatSnapshotCacheGeneration,
  createEmptyChatSnapshotCache,
  removeChatSnapshotCacheEntry,
  saveChatSnapshotCache,
  updateChatSnapshotCache,
  type ChatSnapshotCache,
} from '@shell/session/chatSnapshotCache';
import { apiClientAtom } from '@shell/state/bridge/atoms';
import { activeBridgeProfileAtom } from '@shell/state/bridge/atoms';
import {
  activeChatAtom,
  interruptedChatCreationAtom,
  chatSnapshotCacheAtom,
  gitChatAtom,
  mainOpeningChatIdAtom,
  newChatRoutePendingAtom,
  pendingMainChatIdAtom,
  pendingMainChatSnapshotAtom,
  selectedChatIdAtom,
} from '@shell/state/chat/atoms';

interface PendingCreationLinkOptions {
  profileId: string;
  expectedPendingChatId: string;
  replacePendingChatId?: string;
  createdChat: Chat;
  pendingChat?: Chat;
}

function resolvePendingCreationLink(
  current: InterruptedChatCreation | null,
  options: PendingCreationLinkOptions,
): InterruptedChatCreation | null {
  if (
    current &&
    current.pendingChatId !== options.expectedPendingChatId &&
    current.pendingChatId !== options.replacePendingChatId
  ) {
    return null;
  }
  const pending = readInterruptedChatCreation(options.pendingChat ?? null);
  const source = pending?.pendingChatId === options.expectedPendingChatId ? pending : current;
  if (!source) {
    return null;
  }
  return {
    ...source,
    profileId: options.profileId,
    submissionId: options.expectedPendingChatId.slice('pending-'.length),
    pendingChatId: options.expectedPendingChatId,
    agentId:
      options.createdChat.agentId && options.createdChat.agentId !== 'unknown'
        ? options.createdChat.agentId
        : source.agentId,
    cwd: options.createdChat.cwd || source.cwd,
    createdChatId: options.createdChat.id,
  };
}

function linkedPendingChat(pendingChat: Chat, linked: InterruptedChatCreation): Chat {
  return {
    ...pendingChat,
    localPendingCreation: {
      draft: linked.draft,
      originalDraft: linked.originalDraft ?? linked.draft,
      profileId: linked.profileId,
      hadAttachments: linked.hadAttachments,
      agentId: linked.agentId ?? null,
      cwd: linked.cwd ?? null,
      createdChatId: linked.createdChatId,
    },
  };
}

function isActiveProfile(get: Getter, profileId: string): boolean {
  const activeProfileId = get(activeBridgeProfileAtom)?.id;
  return activeProfileId === undefined || activeProfileId === profileId;
}

function isActivePendingState(get: Getter, profileId: string, pendingChatId: string): boolean {
  return (
    isActiveProfile(get, profileId) &&
    get(interruptedChatCreationAtom)?.pendingChatId === pendingChatId
  );
}

function publishPendingState(
  get: Getter,
  set: Setter,
  profileId: string,
  interrupted: InterruptedChatCreation,
  cache: ChatSnapshotCache,
): void {
  if (!isActivePendingState(get, profileId, interrupted.pendingChatId)) {
    return;
  }
  set(interruptedChatCreationAtom, interrupted);
  set(chatSnapshotCacheAtom, cache);
}

interface ReplacementSubmissionOptions {
  profileId: string;
  expectedPendingChatId: string;
  submissionId: string;
  draft: string;
  hadAttachments: boolean;
  agentId: string | null;
  cwd: string | null;
}

const pendingMutationChains = new Map<string, Promise<void>>();

function enqueuePendingMutation<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
  const previous = pendingMutationChains.get(profileId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  pendingMutationChains.set(profileId, tail);
  void tail.finally(() => {
    if (pendingMutationChains.get(profileId) === tail) {
      pendingMutationChains.delete(profileId);
    }
  });
  return result;
}

function retryCurrentChatSnapshotCache(get: Getter, profileId: string): void {
  setTimeout(() => {
    void enqueuePendingMutation(profileId, async () => {
      const current = get(chatSnapshotCacheAtom);
      if (!current || current.profileId !== profileId || !isActiveProfile(get, profileId)) {
        throw new Error('Chat snapshot cache is not active.');
      }
      await saveChatSnapshotCache(current, getChatSnapshotCacheGeneration(profileId));
    }).catch(() => {
      retryCurrentChatSnapshotCache(get, profileId);
    });
  }, 1000);
}

function prepareReplacementSubmission(
  current: InterruptedChatCreation | null,
  cache: ChatSnapshotCache | null | undefined,
  options: ReplacementSubmissionOptions,
): { replacement: InterruptedChatCreation; next: ChatSnapshotCache } | null {
  if (
    !current ||
    current.pendingChatId !== options.expectedPendingChatId ||
    !current.createdChatId
  ) {
    return null;
  }

  if (!cache || cache.profileId !== options.profileId) {
    throw new Error('Pending chat recovery cache is unavailable.');
  }
  const pending = cache.entries.find(
    (entry) => entry.chat.id === options.expectedPendingChatId,
  )?.chat;
  if (!pending) {
    throw new Error('Pending chat recovery snapshot is unavailable.');
  }
  const pendingChatId = `pending-${options.submissionId}`;
  const replacement: InterruptedChatCreation = {
    ...current,
    profileId: options.profileId,
    submissionId: options.submissionId,
    pendingChatId,
    draft: options.draft,
    originalDraft: current.originalDraft ?? current.draft,
    hadAttachments: options.hadAttachments,
    agentId: options.agentId ?? undefined,
    cwd: options.cwd ?? undefined,
  };
  const nextPending = linkedPendingChat({ ...pending, id: pendingChatId }, replacement);
  return {
    replacement,
    next: updateChatSnapshotCache(
      removeChatSnapshotCacheEntry(cache, options.expectedPendingChatId),
      pendingChatId,
      nextPending,
    ),
  };
}

async function persistReplacementSubmission(
  get: Getter,
  set: Setter,
  options: ReplacementSubmissionOptions,
): Promise<InterruptedChatCreation | null> {
  const desiredPendingChatId = `pending-${options.submissionId}`;
  const current = get(interruptedChatCreationAtom);
  if (current?.pendingChatId === desiredPendingChatId) {
    return current;
  }
  const prepared = prepareReplacementSubmission(current, get(chatSnapshotCacheAtom), options);
  if (!prepared) {
    return null;
  }
  const { replacement, next } = prepared;
  await saveChatSnapshotCache(next, getChatSnapshotCacheGeneration(next.profileId));
  if (
    !isActiveProfile(get, options.profileId) ||
    get(interruptedChatCreationAtom)?.pendingChatId !== options.expectedPendingChatId
  ) {
    return null;
  }
  set(interruptedChatCreationAtom, replacement);
  set(chatSnapshotCacheAtom, next);
  return replacement;
}

export const persistPendingChatCreationAtom = atom(
  null,
  async (
    get,
    set,
    options: {
      profileId: string;
      pendingChat: Chat;
      replacePendingChatId?: string;
    },
  ) => {
    const interrupted = readInterruptedChatCreation(options.pendingChat);
    if (!interrupted) {
      throw new Error('Pending chat recovery metadata is invalid.');
    }
    const linked = { ...interrupted, profileId: options.profileId };
    const cached = get(chatSnapshotCacheAtom);
    const base =
      cached?.profileId === options.profileId
        ? cached
        : createEmptyChatSnapshotCache(options.profileId);
    const withoutReplaced =
      options.replacePendingChatId && options.replacePendingChatId !== options.pendingChat.id
        ? removeChatSnapshotCacheEntry(base, options.replacePendingChatId)
        : base;
    const next = updateChatSnapshotCache(
      withoutReplaced,
      options.pendingChat.id,
      options.pendingChat,
    );
    if (isActiveProfile(get, options.profileId)) {
      set(interruptedChatCreationAtom, linked);
    }
    publishPendingState(get, set, options.profileId, linked, next);
    await saveChatSnapshotCache(next, getChatSnapshotCacheGeneration(next.profileId));
    if (!isActivePendingState(get, options.profileId, linked.pendingChatId)) {
      throw new Error('Chat context changed while saving pending recovery.');
    }
    return linked;
  },
);

export const replaceInterruptedChatSubmissionAtom = atom(
  null,
  async (
    get,
    set,
    options: ReplacementSubmissionOptions,
  ): Promise<InterruptedChatCreation | null> => {
    return enqueuePendingMutation(options.profileId, () =>
      persistReplacementSubmission(get, set, options),
    );
  },
);

export const resetChatSessionStateAtom = atom(null, (get, set): void => {
  set(selectedChatIdAtom, null);
  set(activeChatAtom, null);
  set(interruptedChatCreationAtom, null);
  set(gitChatAtom, null);
  set(mainOpeningChatIdAtom, null);
  set(pendingMainChatIdAtom, null);
  set(pendingMainChatSnapshotAtom, null);
  set(newChatRoutePendingAtom, false);
  set(chatSnapshotCacheAtom, null);
});

export const cancelChatTransitionAtom = atom(null, (_get, set): void => {
  set(mainOpeningChatIdAtom, null);
  set(newChatRoutePendingAtom, false);
});

export const openChatWithTransitionAtom = atom(
  null,
  (get, set, id: string, snapshot?: Chat | null): void => {
    const api = get(apiClientAtom);
    const nextSnapshot =
      snapshot && snapshot.id === id ? snapshot : (api?.peekChatShell(id) ?? null);
    const hasHydratedSnapshot = Boolean(nextSnapshot && nextSnapshot.messages.length > 0);

    set(newChatRoutePendingAtom, false);
    set(mainOpeningChatIdAtom, hasHydratedSnapshot ? null : id);

    set(selectedChatIdAtom, id);
    set(activeChatAtom, nextSnapshot);
    set(gitChatAtom, null);
    set(pendingMainChatIdAtom, id);
    set(pendingMainChatSnapshotAtom, hasHydratedSnapshot ? nextSnapshot : null);
    if (hasHydratedSnapshot) {
      set(mainOpeningChatIdAtom, null);
    }
  },
);

export const applyRestoredChatSnapshotAtom = atom(null, (get, set, snapshot: Chat | null): void => {
  const interrupted = readInterruptedChatCreation(snapshot);
  set(interruptedChatCreationAtom, interrupted);
  const restored = interrupted ? null : snapshot;
  const restoredId = interrupted?.createdChatId ?? restored?.id ?? null;
  set(newChatRoutePendingAtom, false);
  set(selectedChatIdAtom, restoredId);
  set(activeChatAtom, restored);
  set(pendingMainChatIdAtom, restoredId);
  set(pendingMainChatSnapshotAtom, restored);
});

interface ConsumeInterruptedChatCreationOptions {
  expectedPendingChatId: string;
  profileId?: string;
  replacement?: Chat;
  requirePersistence?: boolean;
}

async function consumeInterruptedChatCreation(
  get: Getter,
  set: Setter,
  options: ConsumeInterruptedChatCreationOptions,
): Promise<void> {
  const interrupted = get(interruptedChatCreationAtom);
  if (!interrupted || interrupted.pendingChatId !== options.expectedPendingChatId) {
    return;
  }
  const cache = get(chatSnapshotCacheAtom);
  if (!cache) {
    if (options.requirePersistence) {
      throw new Error('Pending chat recovery cache is unavailable.');
    }
    set(interruptedChatCreationAtom, null);
    return;
  }
  const expectedProfileId = options.profileId ?? interrupted.profileId ?? cache.profileId;
  if (
    cache.profileId !== expectedProfileId ||
    !isActivePendingState(get, expectedProfileId, options.expectedPendingChatId)
  ) {
    return;
  }
  const withoutPending = removeChatSnapshotCacheEntry(cache, interrupted.pendingChatId);
  const next = options.replacement
    ? updateChatSnapshotCache(withoutPending, options.replacement.id, options.replacement)
    : withoutPending;
  if (next === cache) {
    if (options.requirePersistence) {
      throw new Error('Pending chat recovery entry is unavailable.');
    }
    set(interruptedChatCreationAtom, null);
    return;
  }
  await saveChatSnapshotCache(next, getChatSnapshotCacheGeneration(next.profileId));
  if (!isActivePendingState(get, expectedProfileId, options.expectedPendingChatId)) {
    return;
  }
  set(interruptedChatCreationAtom, null);
  set(chatSnapshotCacheAtom, next);
}

export const consumeInterruptedChatCreationAtom = atom(
  null,
  async (get, set, options: ConsumeInterruptedChatCreationOptions) => {
    const interrupted = get(interruptedChatCreationAtom);
    const cache = get(chatSnapshotCacheAtom);
    const profileId = options.profileId ?? interrupted?.profileId ?? cache?.profileId;
    if (!profileId) {
      return;
    }
    try {
      await enqueuePendingMutation(profileId, () =>
        consumeInterruptedChatCreation(get, set, options),
      );
    } catch (error) {
      if (options.requirePersistence) {
        throw error;
      }
      setTimeout(() => {
        void set(consumeInterruptedChatCreationAtom, options);
      }, 1000);
    }
  },
);

export const discardInterruptedChatCreationAtom = atom(
  null,
  (
    get,
    set,
    options: {
      expectedPendingChatId: string;
      profileId?: string;
    },
  ): void => {
    const interrupted = get(interruptedChatCreationAtom);
    const cache = get(chatSnapshotCacheAtom);
    const profileId = options.profileId ?? interrupted?.profileId ?? cache?.profileId;
    if (
      !interrupted ||
      interrupted.pendingChatId !== options.expectedPendingChatId ||
      !cache ||
      !profileId ||
      cache.profileId !== profileId ||
      !isActivePendingState(get, profileId, options.expectedPendingChatId)
    ) {
      return;
    }
    const next = removeChatSnapshotCacheEntry(cache, options.expectedPendingChatId);
    set(interruptedChatCreationAtom, null);
    set(chatSnapshotCacheAtom, next);
    const generation = getChatSnapshotCacheGeneration(next.profileId);
    void enqueuePendingMutation(profileId, () => saveChatSnapshotCache(next, generation)).catch(
      () => {
        retryCurrentChatSnapshotCache(get, profileId);
      },
    );
  },
);

export const linkInterruptedChatCreationAtom = atom(
  null,
  async (get, set, options: PendingCreationLinkOptions) => {
    const linked = resolvePendingCreationLink(get(interruptedChatCreationAtom), options);
    if (!linked) {
      return null;
    }
    const cached = get(chatSnapshotCacheAtom);
    const cache =
      cached?.profileId === options.profileId
        ? cached
        : createEmptyChatSnapshotCache(options.profileId);
    const pendingEntry = cache.entries.find(
      (entry) => entry.chat.id === options.expectedPendingChatId,
    );
    const pendingChat = pendingEntry?.chat ?? options.pendingChat;
    if (!pendingChat || pendingChat.id !== options.expectedPendingChatId) {
      throw new Error('Pending chat recovery snapshot is unavailable.');
    }
    const withoutReplaced =
      options.replacePendingChatId && options.replacePendingChatId !== options.expectedPendingChatId
        ? removeChatSnapshotCacheEntry(cache, options.replacePendingChatId)
        : cache;
    const next = updateChatSnapshotCache(
      withoutReplaced,
      options.expectedPendingChatId,
      linkedPendingChat(pendingChat, linked),
    );
    if (isActiveProfile(get, options.profileId)) {
      set(interruptedChatCreationAtom, linked);
    }
    publishPendingState(get, set, options.profileId, linked, next);
    await saveChatSnapshotCache(next, getChatSnapshotCacheGeneration(next.profileId));
    return linked;
  },
);
