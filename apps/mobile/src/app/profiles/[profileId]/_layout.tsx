import { Slot, useGlobalSearchParams } from 'expo-router';

import { ProfileRouteBoundary } from '@shell/navigation/ProfileRouteBoundary';

export default function ProfileLayout() {
  const { profileId } = useGlobalSearchParams<{ profileId: string }>();

  return (
    <ProfileRouteBoundary profileId={profileId}>
      <Slot />
    </ProfileRouteBoundary>
  );
}
