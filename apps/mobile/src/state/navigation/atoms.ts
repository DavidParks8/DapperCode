import { atom } from 'jotai';

import type { Screen } from '../../app/appConstants';
import type { OnboardingMode } from '../../screens/onboarding/OnboardingScreen';

export type NavigationScreen = Exclude<Screen, 'SubAgent'>;
export type NavigationRoute =
  { screen: NavigationScreen } | { screen: 'SubAgent'; threadId: string };
export type PushNavigationRoute =
  { screen: Exclude<NavigationScreen, 'Main'> } | { screen: 'SubAgent'; threadId: string };

const mainRoute: NavigationRoute = { screen: 'Main' };

function routesEqual(left: NavigationRoute, right: NavigationRoute): boolean {
  if (left.screen !== right.screen) {
    return false;
  }
  if (left.screen === 'SubAgent' && right.screen === 'SubAgent') {
    return left.threadId === right.threadId;
  }
  return true;
}

function canonicalStackForScreen(screen: NavigationScreen): NavigationRoute[] {
  switch (screen) {
    case 'Onboarding':
      return [{ screen }];
    case 'Main':
      return [mainRoute];
    case 'Privacy':
    case 'Terms':
      return [mainRoute, { screen: 'Settings' }, { screen }];
    default:
      return [mainRoute, { screen }];
  }
}

const navigationStackStateAtom = atom<NavigationRoute[]>([mainRoute]);

export const navigationStackAtom = atom((get) => get(navigationStackStateAtom));

export const currentNavigationRouteAtom = atom<NavigationRoute>(
  (get) => get(navigationStackStateAtom).at(-1) ?? mainRoute,
);

export const resetNavigationAtom = atom(null, (_get, set, screen: NavigationScreen): void => {
  set(navigationStackStateAtom, canonicalStackForScreen(screen));
});

export const currentScreenAtom = atom(
  (get) => get(currentNavigationRouteAtom).screen,
  (_get, set, screen: NavigationScreen): void => {
    set(resetNavigationAtom, screen);
  },
);

export const navigationCanGoBackAtom = atom((get) => get(navigationStackStateAtom).length > 1);

export const pushNavigationRouteAtom = atom(null, (get, set, route: PushNavigationRoute): void => {
  const stack = get(navigationStackStateAtom);
  const current = stack.at(-1);
  if (current && routesEqual(current, route)) {
    return;
  }
  set(navigationStackStateAtom, [...stack, route]);
});

export const popNavigationRouteAtom = atom(null, (get, set): void => {
  const stack = get(navigationStackStateAtom);
  if (stack.length > 1) {
    set(navigationStackStateAtom, stack.slice(0, -1));
  }
});

export const onboardingModeAtom = atom<OnboardingMode>('initial');

export const pendingBrowserTargetUrlAtom = atom<string | null>(null);

export const settingsAllowsDrawerGestureAtom = atom(true);

/** Incremented whenever an in-flight chat transition should be abandoned. */
export const chatTransitionRequestIdAtom = atom(0);

/**
 * Commands registered by the screen-transition controller so that the hardware-back handler can
 * trigger the same animated-pop as the edge-swipe gesture.  `null` when no controller is mounted.
 */
export const screenNavigationCommandsAtom = atom<{
  triggerAnimatedPop: (() => void) | null;
}>({ triggerAnimatedPop: null });
