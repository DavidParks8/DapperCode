import { atom } from 'jotai';

import type { Chat } from '../../api/types';
import {
  activeChatAtom,
  gitChatAtom,
  mainOpeningChatIdAtom,
  pendingMainChatIdAtom,
  pendingMainChatSnapshotAtom,
  selectedChatIdAtom,
} from '../chat/atoms';
import { cancelChatTransitionAtom, openChatWithTransitionAtom } from '../chat/actions';
import { mainScreenCommandsAtom } from '../commands';
import { closeDrawerAtom } from '../drawer/atoms';
import {
  currentScreenAtom,
  pendingBrowserTargetUrlAtom,
  popNavigationRouteAtom,
  pushNavigationRouteAtom,
  type NavigationScreen,
} from './atoms';

export const navigateAtom = atom(null, (get, set, screen: NavigationScreen): void => {
  if (screen !== 'Main') {
    set(cancelChatTransitionAtom);
  }
  set(currentScreenAtom, screen);
  set(closeDrawerAtom);
});

export const selectChatAtom = atom(null, (get, set, id: string): void => {
  const currentChatId = get(activeChatAtom)?.id ?? get(selectedChatIdAtom);
  set(closeDrawerAtom);
  if (get(currentScreenAtom) === 'Main' && currentChatId === id) {
    return;
  }
  void set(openChatWithTransitionAtom, id, null, { immediate: true });
});

export const startNewChatAtom = atom(null, (get, set): void => {
  set(cancelChatTransitionAtom);
  set(pendingMainChatIdAtom, null);
  set(pendingMainChatSnapshotAtom, null);
  set(selectedChatIdAtom, null);
  set(activeChatAtom, null);
  set(gitChatAtom, null);
  set(currentScreenAtom, 'Main');
  get(mainScreenCommandsAtom)?.startNewChat();
  set(closeDrawerAtom);
});

export const openBrowserAtom = atom(null, (get, set, targetUrl?: string | null): void => {
  if (typeof targetUrl === 'string' && targetUrl.trim().length > 0) {
    set(pendingBrowserTargetUrlAtom, targetUrl.trim());
  }
  set(cancelChatTransitionAtom);
  set(pushNavigationRouteAtom, { screen: 'Browser' });
  set(closeDrawerAtom);
});

export const openChatGitAtom = atom(null, (get, set, chat: Chat): void => {
  set(cancelChatTransitionAtom);
  set(gitChatAtom, chat);
  set(selectedChatIdAtom, chat.id);
  set(pushNavigationRouteAtom, { screen: 'ChatGit' });
});

export const chatContextChangedAtom = atom(null, (get, set, chat: Chat | null): void => {
  set(activeChatAtom, chat);
  if (chat?.id) {
    set(selectedChatIdAtom, chat.id);
    return;
  }
  if (!get(mainOpeningChatIdAtom)) {
    set(selectedChatIdAtom, null);
  }
});

export const gitChatUpdatedAtom = atom(null, (get, set, chat: Chat): void => {
  set(gitChatAtom, chat);
  const activeChat = get(activeChatAtom);
  if (activeChat?.id === chat.id) {
    set(activeChatAtom, chat);
  }
});

export const closeGitAtom = atom(null, (_get, set): void => {
  // MainScreen stays mounted beneath Git, so returning only needs to pop the pushed screen.
  set(cancelChatTransitionAtom);
  set(popNavigationRouteAtom);
  set(gitChatAtom, null);
});

export const openLegalScreenAtom = atom(null, (get, set, screen: 'Privacy' | 'Terms'): void => {
  set(cancelChatTransitionAtom);
  set(pushNavigationRouteAtom, { screen });
});
