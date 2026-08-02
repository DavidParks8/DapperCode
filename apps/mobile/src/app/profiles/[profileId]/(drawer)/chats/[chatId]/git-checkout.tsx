import { GitCheckoutScreen } from '../../../../../../features/workspace/checkout/Screen';
import { useDisableDrawerSwipe } from '@shell/navigation/useDrawerSwipe';
import { ProfileRouteContent } from '@shell/navigation/ProfileRouteBoundary';

export default function GitCheckoutRoute() {
  useDisableDrawerSwipe();
  return (
    <ProfileRouteContent>
      <GitCheckoutScreen />
    </ProfileRouteContent>
  );
}
