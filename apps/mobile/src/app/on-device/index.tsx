import { OnDeviceHomeScreen } from '../../features/on-device/screens/HomeScreen';
import { OnDeviceTargets } from '@shell/runtime/OnDeviceTargets';

export default function OnDeviceRoute() {
  return <OnDeviceHomeScreen executionTargets={<OnDeviceTargets />} />;
}
