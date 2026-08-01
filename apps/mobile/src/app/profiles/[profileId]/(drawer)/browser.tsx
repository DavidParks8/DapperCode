import { BrowserScreen } from '../../../../screens/browser/BrowserScreen';
import { ProfileRouteContent } from '../../../../navigation/ProfileRouteBoundary';

export default function BrowserRoute() {
  return (
    <ProfileRouteContent>
      <BrowserScreen />
    </ProfileRouteContent>
  );
}
