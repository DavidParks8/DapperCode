import { atom } from 'jotai';

import type { Chat } from '@bridge/types/types';
import type { ChatSnapshotCache } from '@shell/session/chatSnapshotCache';

export const selectedChatIdAtom = atom<string | null>(null);

export const activeChatAtom = atom<Chat | null>(null);

export const gitChatAtom = atom<Chat | null>(null);

export const mainOpeningChatIdAtom = atom<string | null>(null);
export const pendingMainChatIdAtom = atom<string | null>(null);
export const pendingMainChatSnapshotAtom = atom<Chat | null>(null);
// Prevents the mounted chat screen from treating the superseded route as a fresh deep link while
// navigation to `/new` is still settling.
export const newChatRoutePendingAtom = atom(false);

// `undefined` means startup restoration is still in progress; `null` means it completed empty.
export const chatSnapshotCacheAtom = atom<ChatSnapshotCache | null | undefined>(undefined);
