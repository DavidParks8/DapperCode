import 'react-native-gesture-handler';

import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useAtomValue, useSetAtom } from 'jotai';
import { Stack } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { StatusBar, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { WindowLayoutObserver } from '@shell/layout/WindowLayoutObserver';
import { createStackScreenOptions } from '@shell/navigation/stackScreenOptions';
import {
  appStateLoadedAtom,
  appStatePersistenceErrorAtom,
  bridgeProfilesAtom,
} from '@shell/state/appState/atoms';
import { chatSnapshotCacheAtom } from '@shell/state/chat/atoms';
import { systemColorSchemeAtom, themeAtom } from '@shell/state/theme';
import { AppThemeProvider, type AppTheme } from '@shared/theme';
import { createStyles, type AppStyles } from '@shell/boot/appStyles';
import { LoadingShell, PersistenceRecoveryShell } from '@shell/boot/AppShells';
import { useAppBridgeLifecycle } from '@shell/boot/useAppBridgeLifecycle';
import { useAppStoreReview } from '@shell/boot/useAppStoreReview';
import { usePushNotificationsLifecycle } from '@shell/boot/usePushNotificationsLifecycle';
import { useAppStateBootstrap } from './useAppStateBootstrap';
import { LocalRuntimeHost } from '@shell/runtime/LocalRuntimeHost';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';

export function RootLayout() {
  const systemColorScheme = useColorScheme();
  const setSystemColorScheme = useSetAtom(systemColorSchemeAtom);
  const theme = useAtomValue(themeAtom);
  const styles = useMemo(() => createStyles(theme), [theme]);

  useEffect(() => {
    setSystemColorScheme(systemColorScheme);
  }, [setSystemColorScheme, systemColorScheme]);

  return (
    <AppThemeProvider theme={theme}>
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <BottomSheetModalProvider>
            <StatusBar barStyle={theme.statusBarStyle} backgroundColor={theme.colors.bgMain} />
            <WindowLayoutObserver />
            <RootNavigator theme={theme} styles={styles} />
          </BottomSheetModalProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </AppThemeProvider>
  );
}

function RootNavigator({ theme, styles }: { theme: AppTheme; styles: AppStyles }) {
  const settingsLoaded = useAtomValue(appStateLoadedAtom);
  const persistenceError = useAtomValue(appStatePersistenceErrorAtom);
  const chatSnapshotCache = useAtomValue(chatSnapshotCacheAtom);
  const bridgeProfiles = useAtomValue(bridgeProfilesAtom);
  const localProfileAvailable = useAtomValue(localProfileAvailableAtom);

  useAppStateBootstrap();
  useAppStoreReview();

  if (!settingsLoaded || chatSnapshotCache === undefined) {
    return <LoadingShell theme={theme} styles={styles} />;
  }

  if (persistenceError && persistenceError.operation !== 'write') {
    return <PersistenceRecoveryShell theme={theme} styles={styles} />;
  }

  const hasBridgeProfiles = bridgeProfiles.length > 0;
  return (
    <>
      <BridgeRuntimeEffects />
      <Stack screenOptions={createStackScreenOptions(theme)}>
        <Stack.Screen name="index" />
        <Stack.Screen name="on-device" />
        <Stack.Protected guard={hasBridgeProfiles || localProfileAvailable}>
          <Stack.Screen name="profiles/[profileId]" />
        </Stack.Protected>
        <Stack.Protected guard={!hasBridgeProfiles}>
          <Stack.Screen name="onboarding" />
        </Stack.Protected>
        <Stack.Screen name="+not-found" />
      </Stack>
      <LocalRuntimeHost />
    </>
  );
}

/**
 * Profile-scoped lifecycles. They run for every profile; bridge-only work (push registration,
 * presence, socket foreground/background) is skipped inside them while the local profile is open.
 */
function BridgeRuntimeEffects() {
  usePushNotificationsLifecycle();
  useAppBridgeLifecycle();
  return null;
}
