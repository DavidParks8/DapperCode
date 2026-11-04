import { useAtomValue, useSetAtom } from 'jotai';
import { useState } from 'react';
import { View } from 'react-native';

import { SettingsButtonRow } from '../../features/settings/local/localSettingsUi';
import { SettingsGroup, SettingsNotice } from '../../features/settings/SettingsList';
import { routes } from '@shell/navigation/routes';
import { replaceRoot } from '@shell/navigation/routeNavigation';
import { retryPersistenceAtom } from '@shell/state/appState/actions';
import { appStatePersistenceErrorAtom, bridgeProfilesAtom } from '@shell/state/appState/atoms';
import { closeActiveProfileAtom } from '@shell/state/bridge/actions';

/**
 * Recovery actions shown when the local runtime cannot start.
 *
 * Leaving "On this iPhone" is ordinary profile switching. Opening another profile unmounts the
 * local runtime host, whose disposal settles local work (stop, unload, pause downloads, cancel
 * sign-in). With no desktop profile the local profile is closed first, so neither the runtime host
 * nor the next cold start returns to the local chat. If saving that change fails, the profile stays
 * open and the failure is shown here with a retry.
 */
export function LocalProfileExit() {
  const profiles = useAtomValue(bridgeProfilesAtom);
  const closeActiveProfile = useSetAtom(closeActiveProfileAtom);
  const persistenceError = useAtomValue(appStatePersistenceErrorAtom);
  const retryPersistence = useSetAtom(retryPersistenceAtom);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const connectDesktop = () => {
    if (closing) {
      return;
    }
    setClosing(true);
    setCloseError(null);
    // A failed save blocks further durable changes until it is retried, so clear it first.
    (persistenceError ? retryPersistence() : Promise.resolve())
      .then(() => closeActiveProfile())
      .then(() => replaceRoot(routes.onboarding))
      .catch((error: unknown) => {
        setCloseError(
          error instanceof Error && error.message
            ? error.message
            : 'On this iPhone could not be closed. Please retry.',
        );
      })
      .finally(() => setClosing(false));
  };
  return (
    <>
      {closeError ? (
        <View accessible accessibilityRole="alert" accessibilityLiveRegion="assertive">
          <SettingsNotice text={closeError} />
        </View>
      ) : null}
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
            label={closeError ? 'Retry connecting a desktop' : 'Connect a desktop instead'}
            busy={closing}
            disabled={closing}
            onPress={connectDesktop}
          />
        ) : null}
      </SettingsGroup>
    </>
  );
}
