import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Keyboard } from 'react-native';

import { SubAgentDetailView } from '../../../../../../../features/chat/agents/SubAgentDetailView';
import { useDisableDrawerSwipe } from '@shell/navigation/useDrawerSwipe';
import { ProfileRouteContent } from '@shell/navigation/ProfileRouteBoundary';

export default function AgentRoute() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  useDisableDrawerSwipe();
  useEffect(() => {
    Keyboard.dismiss();
  }, []);
  return (
    <ProfileRouteContent>
      <SubAgentDetailView threadId={threadId} />
    </ProfileRouteContent>
  );
}
