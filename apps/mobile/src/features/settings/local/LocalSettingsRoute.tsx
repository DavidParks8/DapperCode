import { useAtomValue } from 'jotai';
import type { ReactNode } from 'react';

import { OnDeviceRuntimeScope } from '../../on-device/runtime/OnDeviceProvider';
import { RouteErrorScreen } from '@shell/navigation/RouteErrorScreen';
import { ProfileRouteContent } from '@shell/navigation/ProfileRouteBoundary';
import { useDisableDrawerSwipe } from '@shell/navigation/useDrawerSwipe';
import { activeProfileIsLocalAtom } from '@shell/state/bridge/atoms';
import { localRuntimeAtom } from '@shell/state/local/atoms';

/**
 * Hosts an On this iPhone Settings page on the runtime the shell's local runtime host owns. The
 * pages exist only for the local profile; the host shows startup and recovery while it starts.
 */
export function LocalSettingsRoute({ children }: { children: ReactNode }) {
  useDisableDrawerSwipe();
  const local = useAtomValue(activeProfileIsLocalAtom);
  const runtime = useAtomValue(localRuntimeAtom);
  return (
    <ProfileRouteContent>
      {!local ? (
        <RouteErrorScreen
          title="Only for On this iPhone"
          message="Model and GitHub settings belong to the On this iPhone profile. Your desktop profiles are unchanged."
        />
      ) : runtime ? (
        <OnDeviceRuntimeScope runtime={runtime}>{children}</OnDeviceRuntimeScope>
      ) : null}
    </ProfileRouteContent>
  );
}
