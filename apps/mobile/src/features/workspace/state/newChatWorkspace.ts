import { atom } from 'jotai';
import type { ChatWorkspace } from '@bridge/types/types';
import { activeBridgeProfileAtom } from '@shell/state/bridge/atoms';
import { defaultStartCwdAtom } from '@shell/state/appState/settings';

const choicesAtom = atom<Record<string, ChatWorkspace>>({});
const identityAtom = atom((get) =>
  JSON.stringify([get(activeBridgeProfileAtom)?.id, get(defaultStartCwdAtom)]),
);

/** The source workspace remains selected; generated checkout paths belong only to created chats. */
export const newChatWorkspaceAtom = atom(
  (get): ChatWorkspace => get(choicesAtom)[get(identityAtom)] ?? { mode: 'local', branch: 'HEAD' },
  (get, set, choice: ChatWorkspace) =>
    set(choicesAtom, (choices) => ({ ...choices, [get(identityAtom)]: choice })),
);
