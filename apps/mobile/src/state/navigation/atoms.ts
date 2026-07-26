import { atom } from 'jotai';

import type { AppScreen, Screen } from '../../app/appConstants';
import type { OnboardingMode } from '../../screens/onboarding/OnboardingScreen';

export const currentScreenAtom = atom<Screen>('Main');

export const onboardingModeAtom = atom<OnboardingMode>('initial');

export const onboardingReturnScreenAtom = atom<AppScreen>('Settings');

export const browserReturnScreenAtom = atom<AppScreen>('Main');

export const pendingBrowserTargetUrlAtom = atom<string | null>(null);

export const settingsAllowsDrawerGestureAtom = atom(true);

/** Incremented whenever an in-flight chat transition should be abandoned. */
export const chatTransitionRequestIdAtom = atom(0);

export function toAppScreen(screen: Screen, fallback: AppScreen = 'Main'): AppScreen {
  return screen === 'Onboarding' ? fallback : screen;
}
