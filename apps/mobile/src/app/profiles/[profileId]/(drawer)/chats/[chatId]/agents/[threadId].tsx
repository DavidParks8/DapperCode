import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Keyboard } from 'react-native';

import { SubAgentDetailView } from '../../../../../../../screens/main/SubAgentDetailView';
import { useDisableDrawerSwipe } from '../../../../../../../navigation/useDrawerSwipe';
import { ProfileRouteContent } from '../../../../../../../navigation/ProfileRouteBoundary';

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
