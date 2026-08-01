import { useAtomValue } from 'jotai';
import { Redirect } from 'expo-router';

import { routes } from '../navigation/routes';
import { bridgeProfilesAtom } from '../state/appState/atoms';
import { activeBridgeProfileAtom } from '../state/bridge/atoms';
import { chatSnapshotCacheAtom } from '../state/chat/atoms';

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
