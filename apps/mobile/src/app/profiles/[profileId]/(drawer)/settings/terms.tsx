import { useRouter } from 'expo-router';

import { env } from '../../../../../config';
import { TermsScreen } from '../../../../../screens/legal/TermsScreen';
import { useDisableDrawerSwipe } from '../../../../../navigation/useDrawerSwipe';
import { ProfileRouteContent } from '../../../../../navigation/ProfileRouteBoundary';

export default function TermsRoute() {
  const router = useRouter();
  useDisableDrawerSwipe();
  return (
    <ProfileRouteContent>
      <TermsScreen termsUrl={env.termsOfServiceUrl} onBack={() => router.back()} />
    </ProfileRouteContent>
  );
}
