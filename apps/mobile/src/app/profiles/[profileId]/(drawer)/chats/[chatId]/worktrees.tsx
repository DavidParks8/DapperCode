import { ManagedWorktreesScreen } from '../../../../../../features/workspace/worktrees/Screen';
import { useDisableDrawerSwipe } from '@shell/navigation/useDrawerSwipe';
import { ProfileRouteContent } from '@shell/navigation/ProfileRouteBoundary';

export default function WorktreesRoute() {
  useDisableDrawerSwipe();
  return (
    <ProfileRouteContent>
      <ManagedWorktreesScreen />
    </ProfileRouteContent>
  );
}
