import { useLocalSearchParams } from 'expo-router';

import { ConnectionScreen } from '../../../../../../bootstrap/AppShells';
import { ProfileRouteContent } from '../../../../../../navigation/ProfileRouteBoundary';
import type { ConnectionMode } from '../../../../../../navigation/routes';

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
