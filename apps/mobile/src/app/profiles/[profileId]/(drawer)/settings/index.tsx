import { SettingsScreen } from '../../../../../features/settings/SettingsScreen';
import { ProfileRouteContent } from '@shell/navigation/ProfileRouteBoundary';
import { OnDeviceEntry } from '@shell/runtime/OnDeviceEntry';

export default function SettingsRoute() {
  return (
    <ProfileRouteContent>
      <SettingsScreen executionTargets={<OnDeviceEntry />} />
    </ProfileRouteContent>
  );
}
