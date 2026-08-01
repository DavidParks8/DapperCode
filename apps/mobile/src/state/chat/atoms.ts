import { atom } from 'jotai';

import type { Chat } from '../../api/types';
import type { ChatSnapshotCache } from '../../chatSnapshotCache';

export const selectedChatIdAtom = atom<string | null>(null);

export const activeChatAtom = atom<Chat | null>(null);

export const gitChatAtom = atom<Chat | null>(null);

export const mainOpeningChatIdAtom = atom<string | null>(null);

export const pendingMainChatIdAtom = atom<string | null>(null);

export const pendingMainChatSnapshotAtom = atom<Chat | null>(null);

// `undefined` means startup restoration is still in progress; `null` means it completed empty.
export const chatSnapshotCacheAtom = atom<ChatSnapshotCache | null | undefined>(undefined);
