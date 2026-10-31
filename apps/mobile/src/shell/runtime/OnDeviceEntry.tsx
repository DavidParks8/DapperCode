import { useAtomValue } from 'jotai';

import { ChoiceAction } from '../../features/onboarding/ChoiceAction';
import { routes } from '@shell/navigation/routes';
import { replaceRoot } from '@shell/navigation/routeNavigation';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { LOCAL_PROFILE_ID, LOCAL_PROFILE_NAME } from '@shell/state/localProfile';

export const ON_DEVICE_ENTRY_META = 'Private, offline models with file and Git tools';

/** Onboarding choice that opens the built-in local profile in the regular chat shell. */
export function OnDeviceEntry() {
  return (
    <ChoiceAction
      title={LOCAL_PROFILE_NAME}
      meta={ON_DEVICE_ENTRY_META}
      iconName="phone-portrait-outline"
      accessibilityHint="Opens a new chat that runs on this iPhone. Setup downloads a model first."
      testID="onboarding-choice-local"
      onPress={() => replaceRoot(routes.newChat(LOCAL_PROFILE_ID))}
    />
  );
}

/** The local onboarding choice, or nothing where this build cannot run the local agent. */
export function useOnDeviceEntry() {
  return useAtomValue(localProfileAvailableAtom) ? <OnDeviceEntry /> : undefined;
}
