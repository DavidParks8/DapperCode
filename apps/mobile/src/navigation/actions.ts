import { atom, type Getter } from 'jotai';
import { router } from 'expo-router';

import type { Chat } from '../api/types';
import { routes } from './routes';
import { pendingBrowserTargetUrlAtom } from '../state/browser';
import { activeBridgeProfileAtom } from '../state/bridge/atoms';
import {
  activeChatAtom,
  gitChatAtom,
  mainOpeningChatIdAtom,
  pendingMainChatIdAtom,
  pendingMainChatSnapshotAtom,
  selectedChatIdAtom,
} from '../state/chat/atoms';
import { cancelChatTransitionAtom, openChatWithTransitionAtom } from '../state/chat/actions';
import { mainScreenCommandsAtom } from '../state/commands';
import { closeDrawerAtom } from '../state/drawer/atoms';
import { agentRootThreadIdAtom } from '../state/mainScreen/workspace';
import type { DrawerScreen } from './drawerContentTypes';
import { navigateRoot, replaceRoot } from './routeNavigation';

function activeProfileId(get: Getter): string | null {
  return get(activeBridgeProfileAtom)?.id ?? null;
}

function activeChatId(get: Getter): string {
  return get(activeChatAtom)?.id ?? get(selectedChatIdAtom) ?? 'new';
}

export const navigateAtom = atom(null, (get, set, screen: DrawerScreen): void => {
  const profileId = activeProfileId(get);
  if (!profileId) {
    replaceRoot(routes.onboarding);
    return;
  }
  if (screen !== 'Main') {
    set(cancelChatTransitionAtom);
  }
  set(closeDrawerAtom);
  switch (screen) {
    case 'Browser':
      navigateRoot(routes.browser(profileId));
      break;
    case 'Settings':
      navigateRoot(routes.settings(profileId));
      break;
    case 'Main':
    default:
      navigateRoot(routes.chat(profileId, activeChatId(get)));
      break;
  }
});

export const selectChatAtom = atom(null, (get, set, id: string): void => {
  const profileId = activeProfileId(get);
  if (!profileId) {
    replaceRoot(routes.onboarding);
    return;
  }
  const currentChatId = get(activeChatAtom)?.id ?? get(selectedChatIdAtom);
  set(closeDrawerAtom);
  if (currentChatId === id) {
    navigateRoot(routes.chat(profileId, id));
    return;
  }
  set(openChatWithTransitionAtom, id);
  navigateRoot(routes.chat(profileId, id));
});

export const startNewChatAtom = atom(null, (get, set): void => {
  const profileId = activeProfileId(get);
  set(cancelChatTransitionAtom);
  set(pendingMainChatIdAtom, null);
  set(pendingMainChatSnapshotAtom, null);
  set(selectedChatIdAtom, null);
  set(activeChatAtom, null);
  set(gitChatAtom, null);
  get(mainScreenCommandsAtom)?.startNewChat();
  set(closeDrawerAtom);
  navigateRoot(profileId ? routes.newChat(profileId) : routes.onboarding);
});

export const openBrowserAtom = atom(null, (get, set, targetUrl?: string | null): void => {
  const profileId = activeProfileId(get);
  if (!profileId) {
    replaceRoot(routes.onboarding);
    return;
  }
  if (typeof targetUrl === 'string' && targetUrl.trim().length > 0) {
    set(pendingBrowserTargetUrlAtom, targetUrl.trim());
  }
  set(cancelChatTransitionAtom);
  set(closeDrawerAtom);
  navigateRoot(routes.browser(profileId));
});

/**
 * Opens the Settings-owned connection editor directly from the drawer's connection footer, so
 * an offline/disconnected bridge is one tap from a fix without routing through a specific chat
 * (there may not be one selected) or leaking the profile's secrets into a chat-scoped URL.
 *
 * This intentionally pushes with `withAnchor: true` instead of using `navigateRoot`. The
 * connection modal is not yet a route in any navigator's history the first time it's opened —
 * whether the drawer footer is tapped from Settings itself or from a chat screen — and
 * `navigateRoot`'s `dismissTo` (`POP_TO`) replaces the current route with the destination
 * instead of no-op'ing when the destination isn't already present, which would silently drop
 * Settings' own `index` route out of its stack. Pushing with an anchor instead adds the
 * connection screen on top while forcing Settings' `index` to load beneath it, so cancelling
 * always lands back on Settings and the screen the drawer was opened from is left untouched.
 */
export const openBridgeConnectionAtom = atom(null, (get, set): void => {
  const profileId = activeProfileId(get);
  if (!profileId) {
    replaceRoot(routes.onboarding);
    return;
  }
  set(cancelChatTransitionAtom);
  set(closeDrawerAtom);
  router.push(routes.settingsConnection(profileId, 'edit'), { withAnchor: true });
});

export const openChatGitAtom = atom(null, (get, set, chat: Chat): void => {
  const profileId = activeProfileId(get);
  if (!profileId) {
    replaceRoot(routes.onboarding);
    return;
  }
  set(cancelChatTransitionAtom);
  set(gitChatAtom, chat);
  set(selectedChatIdAtom, chat.id);
  router.push(routes.git(profileId, chat.id));
});

export const openSubAgentAtom = atom(null, (get, set, threadId: string): void => {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) {
    return;
  }
  set(cancelChatTransitionAtom);
  const profileId = activeProfileId(get);
  const chatId = activeChatId(get);
  if (!profileId) {
    replaceRoot(routes.onboarding);
    return;
  }
  if (normalizedThreadId === get(agentRootThreadIdAtom)) {
    router.dismissTo(routes.chat(profileId, chatId));
    return;
  }
  router.push(routes.agent(profileId, chatId, normalizedThreadId));
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

export const closeGitAtom = atom(null, (get, set): void => {
  set(cancelChatTransitionAtom);
  const chatId = get(gitChatAtom)?.id ?? activeChatId(get);
  set(gitChatAtom, null);
  const profileId = activeProfileId(get);
  if (profileId) {
    router.dismissTo(routes.chat(profileId, chatId));
  }
});
