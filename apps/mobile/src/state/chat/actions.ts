import { atom } from 'jotai';

import type { Chat } from '../../api/types';
import { apiClientAtom } from '../bridge/atoms';
import {
  activeChatAtom,
  chatSnapshotCacheAtom,
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
  set(mainOpeningChatIdAtom, null);
  set(pendingMainChatIdAtom, null);
  set(pendingMainChatSnapshotAtom, null);
  set(chatSnapshotCacheAtom, null);
});

export const cancelChatTransitionAtom = atom(null, (_get, set): void => {
  set(mainOpeningChatIdAtom, null);
});

export const openChatWithTransitionAtom = atom(
  null,
  (get, set, id: string, snapshot?: Chat | null): void => {
    const api = get(apiClientAtom);
    const nextSnapshot =
      snapshot && snapshot.id === id ? snapshot : (api?.peekChatShell(id) ?? null);
    const hasHydratedSnapshot = Boolean(nextSnapshot && nextSnapshot.messages.length > 0);

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
  set(selectedChatIdAtom, snapshot?.id ?? null);
  set(activeChatAtom, snapshot);
  set(pendingMainChatIdAtom, snapshot?.id ?? null);
  set(pendingMainChatSnapshotAtom, snapshot);
});
