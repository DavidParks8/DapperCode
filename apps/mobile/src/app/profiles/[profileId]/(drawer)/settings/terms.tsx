import { useRouter } from 'expo-router';

import { env } from '@shared/config';
import { TermsScreen } from '../../../../../features/legal/TermsScreen';
import { useDisableDrawerSwipe } from '@shell/navigation/useDrawerSwipe';
import { ProfileRouteContent } from '@shell/navigation/ProfileRouteBoundary';

export default function TermsRoute() {
  const router = useRouter();
  useDisableDrawerSwipe();
  return (
    <ProfileRouteContent>
      <TermsScreen termsUrl={env.termsOfServiceUrl} onBack={() => router.back()} />
    </ProfileRouteContent>
  );
}
