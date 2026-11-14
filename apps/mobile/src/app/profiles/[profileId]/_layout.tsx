import { Slot, useLocalSearchParams } from 'expo-router';

import { ProfileRouteBoundary } from '@shell/navigation/ProfileRouteBoundary';

export default function ProfileLayout() {
  // This route's own segment: global params still name the previous profile while a switch renders.
  const { profileId } = useLocalSearchParams<{ profileId: string }>();

  return (
    <ProfileRouteBoundary profileId={profileId}>
      <Slot />
    </ProfileRouteBoundary>
  );
}
