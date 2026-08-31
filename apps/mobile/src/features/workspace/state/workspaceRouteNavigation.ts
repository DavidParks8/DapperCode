import { router } from 'expo-router';
import type { Getter } from 'jotai';

import { activeBridgeProfileAtom } from '@shell/state/bridge/atoms';
import { activeChatAtom, selectedChatIdAtom } from '@shell/state/chat/atoms';

export function getWorkspaceRouteIds(get: Getter) {
  const profileId = get(activeBridgeProfileAtom)?.id ?? null;
  const chatId = get(activeChatAtom)?.id ?? get(selectedChatIdAtom) ?? 'new';
  return { profileId, chatId };
}

export function returnToChat(): void {
  // The picker is always pushed over its anchored chat. Pop that route instead of resolving the
  // dynamic chat URL again, which can remount MainScreen and clear the pending new-chat settings.
  router.back();
}
