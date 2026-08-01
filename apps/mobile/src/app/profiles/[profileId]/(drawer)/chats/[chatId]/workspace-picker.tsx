import { WorkspacePickerScreen } from '../../../../../../screens/workspacePicker/WorkspacePickerScreen';
import { useDisableDrawerSwipe } from '../../../../../../navigation/useDrawerSwipe';
import { ProfileRouteContent } from '../../../../../../navigation/ProfileRouteBoundary';

export default function WorkspacePickerRoute() {
  useDisableDrawerSwipe();
  return (
    <ProfileRouteContent>
      <WorkspacePickerScreen />
    </ProfileRouteContent>
  );
}
