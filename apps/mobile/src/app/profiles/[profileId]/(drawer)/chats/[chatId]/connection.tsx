import { useLocalSearchParams } from 'expo-router';

import { ConnectionScreen } from '@shell/boot/AppShells';
import { ProfileRouteContent } from '@shell/navigation/ProfileRouteBoundary';
import type { ConnectionMode } from '@shell/navigation/routes';

const MODES = new Set<ConnectionMode>(['add', 'edit', 'reconnect']);

export default function ConnectionRoute() {
  const { mode, profileId } = useLocalSearchParams<{
    mode?: string;
    profileId: string;
  }>();
  const resolvedMode: ConnectionMode =
    mode && MODES.has(mode as ConnectionMode) ? (mode as ConnectionMode) : 'edit';

  return (
    <ProfileRouteContent>
      <ConnectionScreen mode={resolvedMode} profileId={profileId} />
    </ProfileRouteContent>
  );
}
