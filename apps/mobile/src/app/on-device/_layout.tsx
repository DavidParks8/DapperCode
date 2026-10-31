import { useAtomValue } from 'jotai';
import { Stack } from 'expo-router';

import { OnDeviceRuntimeScope } from '../../features/on-device/runtime/OnDeviceProvider';
import { RouteErrorScreen } from '@shell/navigation/RouteErrorScreen';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { localRuntimeAtom } from '@shell/state/local/atoms';

/**
 * Legacy on-device screens (model library, workspaces, account, files) that the unified shell does
 * not replace yet. They share the runtime owned by the shell's local runtime host, which shows the
 * loading and recovery page while that runtime starts.
 */
export default function OnDeviceLayout() {
  const available = useAtomValue(localProfileAvailableAtom);
  const runtime = useAtomValue(localRuntimeAtom);
  if (!available) {
    return (
      <RouteErrorScreen
        title="On this iPhone is unavailable"
        message="Local models need the DapperCode iPhone app. Your desktop profiles are unchanged."
      />
    );
  }
  if (!runtime) {
    return null;
  }
  return (
    <OnDeviceRuntimeScope runtime={runtime}>
      <Stack screenOptions={{ headerShown: false }} />
    </OnDeviceRuntimeScope>
  );
}
