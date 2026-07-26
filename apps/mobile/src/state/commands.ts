import { atom } from 'jotai';

import type { Chat } from '../api/types';

/**
 * Imperative entry points a screen registers while mounted. They replace the
 * `MainScreenHandle` / `BrowserScreenHandle` refs that used to be threaded through props.
 */
export interface MainScreenCommands {
  openChat: (id: string, optimisticChat?: Chat | null) => void;
  startNewChat: () => void;
}

export interface BrowserScreenCommands {
  handleHardwareBackPress: () => boolean;
}

export const mainScreenCommandsAtom = atom<MainScreenCommands | null>(null);

export const browserScreenCommandsAtom = atom<BrowserScreenCommands | null>(null);
