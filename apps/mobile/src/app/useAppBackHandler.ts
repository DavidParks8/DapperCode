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
  screenNavigationCommandsAtom,
  settingsAllowsDrawerGestureAtom,
} from '../state/navigation/atoms';

type Store = ReturnType<typeof useStore>;

/**
 * Pure pop: performs the actual navigation change after an animated transition has already played.
 * Called by the back-swipe gesture (via `onBackSwipe`) once the spring settles, and by the
 * hardware-back handler after it triggers the animation.
 */
function popCurrentScreen(store: Store): void {
  const screen = store.get(currentScreenAtom);
  switch (screen) {
    case 'ChatGit':
      store.set(closeGitAtom);
      break;
    case 'WorkspacePicker':
      store.set(closeWorkspacePickerAtom);
      break;
    case 'GitCheckout':
      store.set(closeGitCheckoutAtom);
      break;
    case 'Settings':
      if (store.get(navigationCanGoBackAtom)) {
        store.set(popNavigationRouteAtom);
      } else {
        store.set(currentScreenAtom, 'Main');
      }
      break;
    default:
      if (store.get(navigationCanGoBackAtom)) {
        store.set(popNavigationRouteAtom);
      }
      break;
  }
}

/**
 * Owns hardware/gesture back navigation.
 *
 * Returns `popCurrentScreen` so the back-swipe gesture can call it after its own animation
 * settles — keeping programmatic and gesture-driven pops consistent.
 */
export function useAppBackHandler(): () => void {
  const store = useStore();
  const currentScreen = useAtomValue(currentScreenAtom);
  const setSettingsAllowsDrawerGesture = useSetAtom(settingsAllowsDrawerGestureAtom);

  useEffect(() => {
    if (currentScreen !== 'Settings') {
      setSettingsAllowsDrawerGesture(true);
    }
  }, [currentScreen, setSettingsAllowsDrawerGesture]);

  const handlePopCurrentScreen = useCallback(() => {
    popCurrentScreen(store);
  }, [store]);

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

    if (screen === 'Main') {
      return false;
    }

    // Browser: WebView-internal back takes priority over the app stack.
    if (screen === 'Browser') {
      if (store.get(browserScreenCommandsAtom)?.handleHardwareBackPress()) {
        return true;
      }
      if (!store.get(navigationCanGoBackAtom)) {
        return false;
      }
      // Fall through to animated pop below.
    }

    // SubAgent is rendered inside MainScreen; pop it immediately without a slide animation.
    if (screen === 'SubAgent') {
      store.set(popNavigationRouteAtom);
      return true;
    }

    // All other navigatable screens: trigger the slide-out animation if available, then pop.
    const commands = store.get(screenNavigationCommandsAtom);
    if (commands.triggerAnimatedPop) {
      commands.triggerAnimatedPop();
      return true;
    }

    // Fallback (controller not yet mounted): immediate pop.
    popCurrentScreen(store);
    return true;
  }, [store]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', handleHardwareBackPress);
    return () => subscription.remove();
  }, [handleHardwareBackPress]);

  return handlePopCurrentScreen;
}
