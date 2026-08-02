import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Keyboard } from 'react-native';

import { ChatGitRoute } from '@shell/navigation/ChatGitRoute';
import { useDisableDrawerSwipe } from '@shell/navigation/useDrawerSwipe';
import { ProfileRouteContent } from '@shell/navigation/ProfileRouteBoundary';

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
