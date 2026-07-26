import 'react-native-gesture-handler';

import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useMemo } from 'react';
import { useColorScheme, useWindowDimensions } from 'react-native';
import { Easing, LinearTransition } from 'react-native-reanimated';

import { appStateLoadedAtom, appStatePersistenceErrorAtom } from '../state/appState/atoms';
import { bridgeUrlAtom } from '../state/bridge/atoms';
import { chatSnapshotCacheAtom } from '../state/chat/atoms';
import { currentScreenAtom } from '../state/navigation/atoms';
import { systemColorSchemeAtom, themeAtom } from '../state/theme';
import { TABLET_LAYOUT_MIN_WIDTH, TABLET_SIDEBAR_ANIMATION_MS } from './appConstants';
import { getDrawerWidth } from './appDrawerUtils';
import { createStyles } from './appStyles';
import { LoadingShell, OnboardingShell, PersistenceRecoveryShell } from './AppShells';
import { AppMainLayout } from './AppMainLayout';
import { useAppBackHandler } from './useAppBackHandler';
import { useAppBridgeLifecycle } from './useAppBridgeLifecycle';
import { useAppStoreReview } from './useAppStoreReview';
import { useDrawerController } from './useDrawerController';
import { usePushNotificationsLifecycle } from './usePushNotificationsLifecycle';

export function AppRoot() {
  const systemColorScheme = useColorScheme();
  const setSystemColorScheme = useSetAtom(systemColorSchemeAtom);

  useEffect(() => {
    setSystemColorScheme(systemColorScheme);
  }, [setSystemColorScheme, systemColorScheme]);

  const settingsLoaded = useAtomValue(appStateLoadedAtom);
  const persistenceError = useAtomValue(appStatePersistenceErrorAtom);
  const chatSnapshotCache = useAtomValue(chatSnapshotCacheAtom);
  const currentScreen = useAtomValue(currentScreenAtom);
  const bridgeUrl = useAtomValue(bridgeUrlAtom);
  const theme = useAtomValue(themeAtom);
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { width: screenWidth } = useWindowDimensions();
  const usesTabletLayout = screenWidth >= TABLET_LAYOUT_MIN_WIDTH;
  const drawerWidth = useMemo(() => getDrawerWidth(screenWidth), [screenWidth]);
  const tabletLayoutTransition = useMemo(
    () => LinearTransition.duration(TABLET_SIDEBAR_ANIMATION_MS).easing(Easing.out(Easing.cubic)),
    [],
  );

  const handleBackSwipe = useAppBackHandler();
  const drawer = useDrawerController({
    usesTabletLayout,
    drawerWidth,
    onBackSwipe: handleBackSwipe,
  });

  usePushNotificationsLifecycle();
  useAppBridgeLifecycle();
  useAppStoreReview();

  if (!settingsLoaded || chatSnapshotCache === undefined) {
    return <LoadingShell theme={theme} styles={styles} />;
  }

  if (persistenceError && persistenceError.operation !== 'write') {
    return <PersistenceRecoveryShell theme={theme} styles={styles} />;
  }

  if (!bridgeUrl || currentScreen === 'Onboarding') {
    return <OnboardingShell theme={theme} styles={styles} />;
  }

  return (
    <AppMainLayout
      theme={theme}
      styles={styles}
      usesTabletLayout={usesTabletLayout}
      tabletLayoutTransition={tabletLayoutTransition}
      screenWidth={screenWidth}
      drawerWidth={drawerWidth}
      drawer={drawer}
    />
  );
}
