import { GitCheckoutScreen } from '../../../../../../screens/gitCheckout/GitCheckoutScreen';
import { useDisableDrawerSwipe } from '../../../../../../navigation/useDrawerSwipe';
import { ProfileRouteContent } from '../../../../../../navigation/ProfileRouteBoundary';

export default function GitCheckoutRoute() {
  useDisableDrawerSwipe();
  return (
    <ProfileRouteContent>
      <GitCheckoutScreen />
    </ProfileRouteContent>
  );
}
