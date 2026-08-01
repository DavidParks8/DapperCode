import { SettingsScreen } from '../../../../../screens/settings/SettingsScreen';
import { ProfileRouteContent } from '../../../../../navigation/ProfileRouteBoundary';

export default function SettingsRoute() {
  return (
    <ProfileRouteContent>
      <SettingsScreen />
    </ProfileRouteContent>
  );
}
