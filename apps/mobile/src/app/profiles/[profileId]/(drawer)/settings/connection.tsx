import { useLocalSearchParams } from 'expo-router';

import { ConnectionScreen } from '../../../../../bootstrap/AppShells';
import { ProfileRouteContent } from '../../../../../navigation/ProfileRouteBoundary';
import type { ConnectionMode } from '../../../../../navigation/routes';

const MODES = new Set<ConnectionMode>(['add', 'edit']);

export default function SettingsConnectionRoute() {
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
