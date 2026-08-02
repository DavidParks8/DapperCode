import { router, useLocalSearchParams } from 'expo-router';

import { ConnectionScreen } from '../../../../../bootstrap/AppShells';
import { replaceRoot } from '../../../../../navigation/routeNavigation';
import { ProfileRouteContent } from '../../../../../navigation/ProfileRouteBoundary';
import { routes, type ConnectionMode } from '../../../../../navigation/routes';

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
      <ConnectionScreen
        mode={resolvedMode}
        profileId={profileId}
        onSaved={(nextProfileId) => {
          // Unwind this Settings-owned connection modal out of Settings' own nested Stack
          // before replaceRoot switches the Drawer to the new chat root. Otherwise the modal
          // stays resident/focused underneath the new root, and a later plain
          // `navigateRoot(routes.settings(...))` finds Settings' `index` already
          // present-but-not-focused in that stack — the vendored StackRouter's NAVIGATE
          // handling then pushes a duplicate `index` instead of jumping back to it, leaving
          // this just-saved editor reachable again via Back.
          router.dismissTo(routes.settings(profileId));
          replaceRoot(routes.newChat(nextProfileId));
        }}
      />
    </ProfileRouteContent>
  );
}
