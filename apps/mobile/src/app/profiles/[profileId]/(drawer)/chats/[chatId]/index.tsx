import { useAtomValue } from 'jotai';
import { useLocalSearchParams } from 'expo-router';

import { usePromoteNewChatRoute } from '../../../../../../navigation/usePromoteNewChatRoute';
import {
  ProfileRouteContent,
  useProfileRouteReady,
} from '../../../../../../navigation/ProfileRouteBoundary';
import { MainScreen } from '../../../../../../screens/main/MainScreen';
import { selectedChatIdAtom } from '../../../../../../state/chat/atoms';

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
