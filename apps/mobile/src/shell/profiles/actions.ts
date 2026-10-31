import { atom } from 'jotai';
import { router } from 'expo-router';

import { routes } from '@shell/navigation/routes';
import { replaceRoot } from '@shell/navigation/routeNavigation';
import { activeProfileIdAtom } from '@shell/state/bridge/atoms';
import { closeDrawerAtom } from '@shell/state/drawer/atoms';

/** Opens a new chat in another profile; the profile route boundary activates it. */
export const openProfileAtom = atom(null, (get, set, profileId: string): void => {
  set(closeDrawerAtom);
  if (get(activeProfileIdAtom) === profileId) {
    return;
  }
  replaceRoot(routes.newChat(profileId));
});

/** Starts pairing another bridge from wherever profiles are listed. */
export const addBridgeProfileAtom = atom(null, (get, set): void => {
  const profileId = get(activeProfileIdAtom);
  set(closeDrawerAtom);
  if (!profileId) {
    replaceRoot(routes.onboarding);
    return;
  }
  // Anchored so cancelling lands on Settings rather than dropping its index route.
  router.push(routes.settingsConnection(profileId, 'add'), { withAnchor: true });
});
