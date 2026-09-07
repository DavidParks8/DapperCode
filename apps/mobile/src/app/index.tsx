import { useAtomValue } from 'jotai';
import { Redirect } from 'expo-router';

import { routes } from '@shell/navigation/routes';
import { bridgeProfilesAtom } from '@shell/state/appState/atoms';
import { activeBridgeProfileAtom } from '@shell/state/bridge/atoms';
import { chatSnapshotCacheAtom } from '@shell/state/chat/atoms';
import {
  isPendingChatId,
  readInterruptedChatCreation,
} from '@shell/session/interruptedChatCreation';

export default function IndexRoute() {
  const profileId = useAtomValue(activeBridgeProfileAtom)?.id ?? null;
  const fallbackProfileId = useAtomValue(bridgeProfilesAtom)[0]?.id ?? null;
  const cache = useAtomValue(chatSnapshotCacheAtom);
  const selectedChatId = cache?.selectedChatId ?? 'new';
  const selectedSnapshot =
    cache?.entries.find((entry) => entry.chat.id === selectedChatId)?.chat ?? null;
  const interrupted = readInterruptedChatCreation(selectedSnapshot);
  const routeChatId =
    interrupted?.createdChatId ?? (isPendingChatId(selectedChatId) ? 'new' : selectedChatId);
  const resolvedProfileId = profileId ?? fallbackProfileId;
  return (
    <Redirect
      href={resolvedProfileId ? routes.chat(resolvedProfileId, routeChatId) : routes.onboarding}
    />
  );
}
