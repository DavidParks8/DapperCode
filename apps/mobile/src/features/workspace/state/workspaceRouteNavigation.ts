import { router } from 'expo-router';
import type { Getter } from 'jotai';

import { routes } from '@shell/navigation/routes';
import { activeBridgeProfileAtom } from '@shell/state/bridge/atoms';
import { activeChatAtom, selectedChatIdAtom } from '@shell/state/chat/atoms';

export function getWorkspaceRouteIds(get: Getter) {
  const profileId = get(activeBridgeProfileAtom)?.id ?? null;
  const chatId = get(activeChatAtom)?.id ?? get(selectedChatIdAtom) ?? 'new';
  return { profileId, chatId };
}

export function returnToChat(get: Getter): void {
  const { profileId, chatId } = getWorkspaceRouteIds(get);
  if (profileId) {
    router.dismissTo(routes.chat(profileId, chatId));
  }
}
