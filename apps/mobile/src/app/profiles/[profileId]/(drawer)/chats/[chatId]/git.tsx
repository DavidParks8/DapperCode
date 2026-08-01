import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Keyboard } from 'react-native';

import { ChatGitRoute } from '../../../../../../navigation/ChatGitRoute';
import { useDisableDrawerSwipe } from '../../../../../../navigation/useDrawerSwipe';
import { ProfileRouteContent } from '../../../../../../navigation/ProfileRouteBoundary';

export default function GitRoute() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  useDisableDrawerSwipe();
  useEffect(() => {
    Keyboard.dismiss();
  }, []);
  return (
    <ProfileRouteContent>
      <ChatGitRoute chatId={chatId} />
    </ProfileRouteContent>
  );
}
