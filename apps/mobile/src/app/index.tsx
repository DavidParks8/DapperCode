import { useAtomValue } from 'jotai';
import { Redirect } from 'expo-router';

import { routes } from '@shell/navigation/routes';
import { bridgeProfilesAtom } from '@shell/state/appState/atoms';
import { activeBridgeProfileAtom } from '@shell/state/bridge/atoms';
import { chatSnapshotCacheAtom } from '@shell/state/chat/atoms';

export default function IndexRoute() {
  const profileId = useAtomValue(activeBridgeProfileAtom)?.id ?? null;
  const fallbackProfileId = useAtomValue(bridgeProfilesAtom)[0]?.id ?? null;
  const selectedChatId = useAtomValue(chatSnapshotCacheAtom)?.selectedChatId ?? 'new';
  const resolvedProfileId = profileId ?? fallbackProfileId;
  return (
    <Redirect
      href={resolvedProfileId ? routes.chat(resolvedProfileId, selectedChatId) : routes.onboarding}
    />
  );
}
