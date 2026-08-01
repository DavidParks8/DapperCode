import { useRouter } from 'expo-router';

import { env } from '../../../../../config';
import { PrivacyScreen } from '../../../../../screens/legal/PrivacyScreen';
import { useDisableDrawerSwipe } from '../../../../../navigation/useDrawerSwipe';
import { ProfileRouteContent } from '../../../../../navigation/ProfileRouteBoundary';

export default function PrivacyRoute() {
  const router = useRouter();
  useDisableDrawerSwipe();
  return (
    <ProfileRouteContent>
      <PrivacyScreen policyUrl={env.privacyPolicyUrl} onBack={() => router.back()} />
    </ProfileRouteContent>
  );
}
