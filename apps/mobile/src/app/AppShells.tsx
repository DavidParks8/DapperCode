import { useAtomValue, useSetAtom } from 'jotai';
import { ActivityIndicator, Pressable, StatusBar, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { env } from '../config';
import { retryPersistenceAtom } from '../state/appState/actions';
import { appStatePersistenceErrorAtom } from '../state/appState/atoms';
import { cancelOnboardingAtom, saveBridgeProfileAtom } from '../state/bridge/actions';
import { activeBridgeProfileAtom, bridgeUrlAtom } from '../state/bridge/atoms';
import { onboardingModeAtom } from '../state/navigation/atoms';
import { OnboardingScreen, type OnboardingMode } from '../screens/OnboardingScreen';
import { AppThemeProvider, type AppTheme } from '../theme';
import type { AppStyles } from './appStyles';

interface ShellFrameProps {
  theme: AppTheme;
  styles: AppStyles;
  children: React.ReactNode;
}

export function AppShellFrame({ theme, styles, children }: ShellFrameProps) {
  return (
    <AppThemeProvider theme={theme}>
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <StatusBar barStyle={theme.statusBarStyle} backgroundColor={theme.colors.bgMain} />
          {children}
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </AppThemeProvider>
  );
}

interface ShellProps {
  theme: AppTheme;
  styles: AppStyles;
}

export function LoadingShell({ theme, styles }: ShellProps) {
  return (
    <AppShellFrame theme={theme} styles={styles}>
      <View
        style={styles.loadingRoot}
        accessibilityRole="progressbar"
        accessibilityLabel="Loading DapperCode"
      >
        <ActivityIndicator size="large" color={theme.colors.textMuted} />
      </View>
    </AppShellFrame>
  );
}

export function PersistenceRecoveryShell({ theme, styles }: ShellProps) {
  const persistenceError = useAtomValue(appStatePersistenceErrorAtom);
  const retryPersistence = useSetAtom(retryPersistenceAtom);

  return (
    <AppShellFrame theme={theme} styles={styles}>
      <View
        style={styles.persistenceRecoveryRoot}
        accessibilityRole="alert"
        accessibilityLiveRegion="assertive"
      >
        <Text style={styles.persistenceRecoveryTitle}>Could not load saved app state</Text>
        <Text selectable style={styles.persistenceRecoveryMessage}>
          {persistenceError?.message}
        </Text>
        <Pressable
          onPress={() => void retryPersistence()}
          style={({ pressed }) => [
            styles.persistenceRecoveryButton,
            pressed && styles.persistenceRecoveryButtonPressed,
          ]}
          accessibilityRole="button"
        >
          <Text style={styles.persistenceRecoveryButtonText}>Retry</Text>
        </Pressable>
      </View>
    </AppShellFrame>
  );
}

export function OnboardingShell({ theme, styles }: ShellProps) {
  const bridgeUrl = useAtomValue(bridgeUrlAtom);
  const activeBridgeProfile = useAtomValue(activeBridgeProfileAtom);
  const savedMode = useAtomValue(onboardingModeAtom);
  const saveBridgeProfile = useSetAtom(saveBridgeProfileAtom);
  const cancelOnboarding = useSetAtom(cancelOnboardingAtom);

  const mode: OnboardingMode = bridgeUrl ? savedMode : 'initial';
  const shouldUseSavedBridgeCredentials = mode === 'edit' || mode === 'reconnect';
  const initialUrl = shouldUseSavedBridgeCredentials
    ? activeBridgeProfile?.bridgeUrl ?? ''
    : mode === 'add'
      ? ''
      : env.legacyHostBridgeUrl ?? '';
  const initialToken = shouldUseSavedBridgeCredentials
    ? activeBridgeProfile?.bridgeToken ?? ''
    : mode === 'add'
      ? ''
      : env.hostBridgeToken ?? '';

  return (
    <AppShellFrame theme={theme} styles={styles}>
      <OnboardingScreen
        mode={mode}
        initialBridgeUrl={initialUrl}
        initialBridgeToken={initialToken}
        allowInsecureRemoteBridge={env.allowInsecureRemoteBridge}
        allowQueryTokenAuth={env.allowWsQueryTokenAuth}
        onSave={saveBridgeProfile}
        onCancel={mode !== 'initial' && activeBridgeProfile ? cancelOnboarding : undefined}
      />
    </AppShellFrame>
  );
}
