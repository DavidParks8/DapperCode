import { useRouter } from 'expo-router';

import { env } from '@shared/config';
import { PrivacyScreen } from '../../../../../features/legal/PrivacyScreen';
import { useDisableDrawerSwipe } from '@shell/navigation/useDrawerSwipe';
import { ProfileRouteContent } from '@shell/navigation/ProfileRouteBoundary';

export default function PrivacyRoute() {
  const router = useRouter();
  useDisableDrawerSwipe();
  return (
    <ProfileRouteContent>
      <PrivacyScreen policyUrl={env.privacyPolicyUrl} onBack={() => router.back()} />
    </ProfileRouteContent>
  );
}
