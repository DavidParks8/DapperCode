import { useAtomValue, useSetAtom } from 'jotai';

import { SettingsButtonRow } from '../../features/settings/local/localSettingsUi';
import { SettingsGroup } from '../../features/settings/SettingsList';
import { routes } from '@shell/navigation/routes';
import { replaceRoot } from '@shell/navigation/routeNavigation';
import { bridgeProfilesAtom } from '@shell/state/appState/atoms';
import { closeActiveProfileAtom } from '@shell/state/bridge/actions';

/**
 * Recovery actions shown when the local runtime cannot start.
 *
 * Leaving "On this iPhone" is ordinary profile switching. Opening another profile unmounts the
 * local runtime host, whose disposal settles local work (stop, unload, pause downloads, cancel
 * sign-in). With no desktop profile the local profile is closed first, so neither the runtime host
 * nor the next cold start returns to the local chat.
 */
export function LocalProfileExit() {
  const profiles = useAtomValue(bridgeProfilesAtom);
  const closeActiveProfile = useSetAtom(closeActiveProfileAtom);
  return (
    <SettingsGroup title="Use another profile">
      {profiles.map((profile) => (
        <SettingsButtonRow
          key={profile.id}
          label={`Open ${profile.name}`}
          onPress={() => replaceRoot(routes.newChat(profile.id))}
        />
      ))}
      {profiles.length === 0 ? (
        <SettingsButtonRow
          label="Connect a desktop instead"
          onPress={() => void closeActiveProfile().then(() => replaceRoot(routes.onboarding))}
        />
      ) : null}
    </SettingsGroup>
  );
}
