import { SettingsScreen } from '../../../../../features/settings/SettingsScreen';
import { ProfileRouteContent } from '@shell/navigation/ProfileRouteBoundary';

export default function SettingsRoute() {
  return (
    <ProfileRouteContent>
      <SettingsScreen />
    </ProfileRouteContent>
  );
}
