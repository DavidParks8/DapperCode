import { atom } from 'jotai';

import type { Chat } from '../../api/types';
import { CHAT_TRANSITION_MIN_MS } from '../../app/appConstants';
import { apiClientAtom } from '../bridge/atoms';
import { currentScreenAtom, chatTransitionRequestIdAtom } from '../navigation/atoms';
import {
  activeChatAtom,
  chatSnapshotCacheAtom,
  chatTransitionChatIdAtom,
  gitChatAtom,
  mainOpeningChatIdAtom,
  pendingMainChatIdAtom,
  pendingMainChatSnapshotAtom,
  selectedChatIdAtom,
} from './atoms';

export const resetChatSessionStateAtom = atom(null, (get, set): void => {
  set(selectedChatIdAtom, null);
  set(activeChatAtom, null);
  set(gitChatAtom, null);
  set(chatTransitionChatIdAtom, null);
  set(mainOpeningChatIdAtom, null);
  set(pendingMainChatIdAtom, null);
  set(pendingMainChatSnapshotAtom, null);
  set(chatSnapshotCacheAtom, null);
});

export const cancelChatTransitionAtom = atom(null, (get, set): void => {
  set(chatTransitionRequestIdAtom, get(chatTransitionRequestIdAtom) + 1);
  set(chatTransitionChatIdAtom, null);
  set(mainOpeningChatIdAtom, null);
});

export interface OpenChatOptions {
  immediate?: boolean;
}

export const openChatWithTransitionAtom = atom(
  null,
  async (
    get,
    set,
    id: string,
    snapshot?: Chat | null,
    options?: OpenChatOptions
  ): Promise<void> => {
    const requestId = get(chatTransitionRequestIdAtom) + 1;
    set(chatTransitionRequestIdAtom, requestId);
    const startedAt = Date.now();
    const api = get(apiClientAtom);
    const nextSnapshot =
      snapshot && snapshot.id === id ? snapshot : api?.peekChatShell(id) ?? null;
    const hasHydratedSnapshot = Boolean(nextSnapshot && nextSnapshot.messages.length > 0);
    const shouldShowTransition = !hasHydratedSnapshot && !options?.immediate;

    set(chatTransitionChatIdAtom, shouldShowTransition ? id : null);
    set(mainOpeningChatIdAtom, hasHydratedSnapshot ? null : id);

    const remainingMs = shouldShowTransition
      ? Math.max(0, CHAT_TRANSITION_MIN_MS - (Date.now() - startedAt))
      : 0;
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingMs));
    }
    if (get(chatTransitionRequestIdAtom) !== requestId) {
      return;
    }

    set(selectedChatIdAtom, id);
    set(activeChatAtom, nextSnapshot);
    set(gitChatAtom, null);
    set(currentScreenAtom, 'Main');
    set(pendingMainChatIdAtom, id);
    set(pendingMainChatSnapshotAtom, hasHydratedSnapshot ? nextSnapshot : null);
    set(chatTransitionChatIdAtom, null);
    if (hasHydratedSnapshot) {
      set(mainOpeningChatIdAtom, null);
    }
  }
);

export const applyRestoredChatSnapshotAtom = atom(
  null,
  (get, set, snapshot: Chat | null): void => {
    set(selectedChatIdAtom, snapshot?.id ?? null);
    set(activeChatAtom, snapshot);
    set(pendingMainChatIdAtom, snapshot?.id ?? null);
    set(pendingMainChatSnapshotAtom, snapshot);
  }
);
