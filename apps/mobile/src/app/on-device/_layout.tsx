import { Stack } from 'expo-router';
import { OnDeviceProvider } from '../../features/on-device/runtime/OnDeviceProvider';
import { ReturnToDesktop } from '@shell/runtime/ReturnToDesktop';

export default function OnDeviceLayout() {
  return (
    <OnDeviceProvider recoveryAction={<ReturnToDesktop />}>
      <Stack screenOptions={{ headerShown: false }} />
    </OnDeviceProvider>
  );
}
