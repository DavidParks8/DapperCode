import 'react-native-gesture-handler';

import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useAtomValue, useSetAtom } from 'jotai';
import { Stack } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { StatusBar, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import {
  appStateLoadedAtom,
  appStatePersistenceErrorAtom,
  bridgeProfilesAtom,
} from '../state/appState/atoms';
import { chatSnapshotCacheAtom } from '../state/chat/atoms';
import { systemColorSchemeAtom, themeAtom } from '../state/theme';
import { AppThemeProvider, type AppTheme } from '../theme';
import { createStyles, type AppStyles } from './appStyles';
import { LoadingShell, PersistenceRecoveryShell } from './AppShells';
import { useAppBridgeLifecycle } from './useAppBridgeLifecycle';
import { useAppStoreReview } from './useAppStoreReview';
import { usePushNotificationsLifecycle } from './usePushNotificationsLifecycle';

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

  usePushNotificationsLifecycle();
  useAppBridgeLifecycle();
  useAppStoreReview();

  if (!settingsLoaded || chatSnapshotCache === undefined) {
    return <LoadingShell theme={theme} styles={styles} />;
  }

  if (persistenceError && persistenceError.operation !== 'write') {
    return <PersistenceRecoveryShell theme={theme} styles={styles} />;
  }

  const hasProfiles = bridgeProfiles.length > 0;
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Protected guard={hasProfiles}>
        <Stack.Screen name="profiles/[profileId]" />
      </Stack.Protected>
      <Stack.Protected guard={!hasProfiles}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
      <Stack.Screen name="+not-found" />
    </Stack>
  );
}
