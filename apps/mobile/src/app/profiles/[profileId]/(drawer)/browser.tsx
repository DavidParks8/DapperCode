import { BrowserScreen } from '../../../../features/browser/screen/BrowserScreen';
import { ProfileRouteContent } from '@shell/navigation/ProfileRouteBoundary';

export default function BrowserRoute() {
  return (
    <ProfileRouteContent>
      <BrowserScreen />
    </ProfileRouteContent>
  );
}
