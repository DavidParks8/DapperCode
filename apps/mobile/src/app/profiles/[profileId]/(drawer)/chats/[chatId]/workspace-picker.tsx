import { WorkspacePickerScreen } from '../../../../../../features/workspace/picker/Screen';
import { useDisableDrawerSwipe } from '@shell/navigation/useDrawerSwipe';
import { ProfileRouteContent } from '@shell/navigation/ProfileRouteBoundary';

export default function WorkspacePickerRoute() {
  useDisableDrawerSwipe();
  return (
    <ProfileRouteContent>
      <WorkspacePickerScreen />
    </ProfileRouteContent>
  );
}
