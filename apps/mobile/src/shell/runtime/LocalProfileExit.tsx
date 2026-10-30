import { useAtomValue } from 'jotai';
import { StyleSheet, View } from 'react-native';

import { LocalAction } from '../../features/on-device/screens/ui';
import { routes } from '@shell/navigation/routes';
import { replaceRoot } from '@shell/navigation/routeNavigation';
import { bridgeProfilesAtom } from '@shell/state/appState/atoms';

/**
 * Leaving "On this iPhone" is ordinary profile switching. Opening another profile unmounts the
 * local runtime host, whose disposal settles local work (stop, unload, pause downloads, cancel
 * sign-in), so every exit path behaves the same.
 */
export function leaveLocalProfile(profileId?: string): void {
  replaceRoot(profileId ? routes.newChat(profileId) : routes.onboarding);
}

/** Recovery actions shown when the local runtime cannot start. */
export function LocalProfileExit() {
  const profiles = useAtomValue(bridgeProfilesAtom);
  return (
    <View style={styles.actions}>
      {profiles.map((profile) => (
        <LocalAction
          key={profile.id}
          title={`Open ${profile.name}`}
          onPress={() => leaveLocalProfile(profile.id)}
        />
      ))}
      {profiles.length === 0 ? (
        <LocalAction title="Connect a desktop instead" onPress={() => leaveLocalProfile()} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ actions: { gap: 8 } });
