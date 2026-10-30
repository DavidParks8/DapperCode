import { useAtomValue } from 'jotai';

import { ChoiceAction } from '../../features/onboarding/ChoiceAction';
import { routes } from '@shell/navigation/routes';
import { replaceRoot } from '@shell/navigation/routeNavigation';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';

/** Onboarding entry that opens the built-in local profile in the regular chat shell. */
export function OnDeviceEntry() {
  const available = useAtomValue(localProfileAvailableAtom);
  if (!available) {
    return null;
  }
  return (
    <ChoiceAction
      title="On this iPhone"
      meta="Offline models with file and Git tools"
      iconName="phone-portrait-outline"
      onPress={() => replaceRoot(routes.newChat(LOCAL_PROFILE_ID))}
    />
  );
}
