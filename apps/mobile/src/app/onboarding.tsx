import { ConnectionScreen } from '@shell/boot/AppShells';
import { OnDeviceEntry } from '@shell/runtime/OnDeviceEntry';

export default function OnboardingRoute() {
  return <ConnectionScreen mode="initial" introAction={<OnDeviceEntry />} />;
}
