import { useAtomValue } from 'jotai';
import { useLocalSearchParams } from 'expo-router';

import { usePromoteNewChatRoute } from '@shell/navigation/usePromoteNewChatRoute';
import { ProfileRouteContent, useProfileRouteReady } from '@shell/navigation/ProfileRouteBoundary';
import { MainScreen } from '../../../../../../features/chat/screen/MainScreen';
import { selectedChatIdAtom } from '@shell/state/chat/atoms';

export default function ChatIndexRoute() {
  const { chatId, profileId } = useLocalSearchParams<{ chatId: string; profileId: string }>();
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const profileReady = useProfileRouteReady();

  usePromoteNewChatRoute(chatId, profileReady ? selectedChatId : null);

  return (
    <ProfileRouteContent>
      <MainScreen key={profileId} />
    </ProfileRouteContent>
  );
}
