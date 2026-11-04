import { ConnectionScreen } from '@shell/boot/AppShells';
import { useOnDeviceEntry } from '@shell/runtime/OnDeviceEntry';

export default function OnboardingRoute() {
  const localChoice = useOnDeviceEntry();
  return <ConnectionScreen mode="initial" introAction={localChoice} />;
}
