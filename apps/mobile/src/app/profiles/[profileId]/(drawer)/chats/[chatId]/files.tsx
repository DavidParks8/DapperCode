import { useLocalSearchParams } from 'expo-router';

import { WorkspaceFilesScreen } from '../../../../../../features/workspace/files/Screen';
import { useDisableDrawerSwipe } from '@shell/navigation/useDrawerSwipe';
import { ProfileRouteContent } from '@shell/navigation/ProfileRouteBoundary';

export default function WorkspaceFilesRoute() {
  const { cwd } = useLocalSearchParams<{ cwd?: string }>();
  useDisableDrawerSwipe();
  return (
    <ProfileRouteContent>
      <WorkspaceFilesScreen cwd={typeof cwd === 'string' ? cwd : null} />
    </ProfileRouteContent>
  );
}
