import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { useCallback, useEffect } from 'react';
import { BackHandler } from 'react-native';

import { browserScreenCommandsAtom } from '../state/commands';
import { cancelOnboardingAtom } from '../state/bridge/actions';
import { activeBridgeProfileAtom } from '../state/bridge/atoms';
import {
  closeGitCheckoutAtom,
  closeWorkspacePickerAtom,
} from '../state/mainScreen/workspaceActions';
import { closeGitAtom } from '../state/navigation/actions';
import { closeDrawerAtom, drawerOpenAtom, drawerVisibleAtom } from '../state/drawer/atoms';
import {
  currentScreenAtom,
  navigationCanGoBackAtom,
  onboardingModeAtom,
  popNavigationRouteAtom,
  settingsAllowsDrawerGestureAtom,
} from '../state/navigation/atoms';

/**
 * Owns hardware/gesture back navigation. Returns the handler so the back-swipe gesture can
 * reuse the same resolution order.
 */
export function useAppBackHandler(): () => boolean {
  const store = useStore();
  const currentScreen = useAtomValue(currentScreenAtom);
  const setSettingsAllowsDrawerGesture = useSetAtom(settingsAllowsDrawerGestureAtom);

  useEffect(() => {
    if (currentScreen !== 'Settings') {
      setSettingsAllowsDrawerGesture(true);
    }
  }, [currentScreen, setSettingsAllowsDrawerGesture]);

  const handleHardwareBackPress = useCallback(() => {
    if (store.get(drawerVisibleAtom) || store.get(drawerOpenAtom)) {
      store.set(closeDrawerAtom);
      return true;
    }

    const screen = store.get(currentScreenAtom);
    if (screen === 'Onboarding') {
      if (store.get(onboardingModeAtom) !== 'initial' && store.get(activeBridgeProfileAtom)) {
        store.set(cancelOnboardingAtom);
        return true;
      }
      return false;
    }

    switch (screen) {
      case 'ChatGit':
        store.set(closeGitAtom);
        return true;
      case 'Browser':
        if (store.get(browserScreenCommandsAtom)?.handleHardwareBackPress()) {
          return true;
        }
        if (!store.get(navigationCanGoBackAtom)) {
          return false;
        }
        store.set(popNavigationRouteAtom);
        return true;
      case 'WorkspacePicker':
        store.set(closeWorkspacePickerAtom);
        return true;
      case 'GitCheckout':
        store.set(closeGitCheckoutAtom);
        return true;
      case 'Settings':
        if (store.get(navigationCanGoBackAtom)) {
          store.set(popNavigationRouteAtom);
        } else {
          store.set(currentScreenAtom, 'Main');
        }
        return true;
      case 'Privacy':
      case 'Terms':
      case 'SubAgent':
        store.set(popNavigationRouteAtom);
        return true;
      case 'Main':
      default:
        return false;
    }
  }, [store]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', handleHardwareBackPress);
    return () => subscription.remove();
  }, [handleHardwareBackPress]);

  return handleHardwareBackPress;
}
