import { useAtomValue, useSetAtom } from 'jotai';
import { useRouter } from 'expo-router';

import { bridgeProfilesAtom } from '@shell/state/appState/atoms';
import { dispatchDurableAppStateAtom } from '@shell/state/appState/actions';
import { routes } from '@shell/navigation/routes';
import { useOnDeviceRuntime } from '../../features/on-device/runtime/OnDeviceProvider';
import {
  LocalAction,
  LocalCard,
  LocalError,
  LocalText,
  useLocalOperation,
} from '../../features/on-device/screens/ui';

export function OnDeviceTargets() {
  const profiles = useAtomValue(bridgeProfilesAtom);
  const dispatch = useSetAtom(dispatchDurableAppStateAtom);
  const router = useRouter();
  const runtime = useOnDeviceRuntime();
  const operation = useLocalOperation();
  const leave = (profileId?: string) =>
    operation.run(async () => {
      runtime.authentication.cancelSignIn();
      await runtime.background();
      await dispatch({ type: 'settings/update', patch: { preferredExecutionTarget: 'bridge' } });
      router.replace(profileId ? routes.newChat(profileId) : routes.onboarding);
    });
  return (
    <LocalCard>
      <LocalText title>Execution target</LocalText>
      <LocalText>
        On this iPhone is selected. Switching targets settles local work first. Your desktop
        profiles and conversations are preserved.
      </LocalText>
      <LocalError message={operation.error} />
      {profiles.map((profile) => (
        <LocalAction
          key={profile.id}
          title={`Connect to ${profile.name}`}
          disabled={operation.busy}
          onPress={() => leave(profile.id)}
        />
      ))}
      {profiles.length === 0 ? (
        <LocalAction
          title="Connect a desktop instead"
          disabled={operation.busy}
          onPress={() => leave()}
        />
      ) : null}
    </LocalCard>
  );
}
