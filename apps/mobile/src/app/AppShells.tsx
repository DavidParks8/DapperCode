import { ActivityIndicator, Pressable, StatusBar, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { env } from '../config';
import type { AppStateSnapshot, AppStateStore } from '../appState';
import {
  OnboardingScreen,
  type OnboardingBridgeProfileDraft,
  type OnboardingMode,
} from '../screens/OnboardingScreen';
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

interface LoadingShellProps {
  theme: AppTheme;
  styles: AppStyles;
}

export function LoadingShell({ theme, styles }: LoadingShellProps) {
  return (
    <AppShellFrame theme={theme} styles={styles}>
      <View style={styles.loadingRoot} accessibilityRole="progressbar" accessibilityLabel="Loading DapperCode">
        <ActivityIndicator size="large" color={theme.colors.textMuted} />
      </View>
    </AppShellFrame>
  );
}

interface PersistenceRecoveryShellProps {
  theme: AppTheme;
  styles: AppStyles;
  appStateSnapshot: AppStateSnapshot;
  appStateStore: AppStateStore;
}

export function PersistenceRecoveryShell({
  theme,
  styles,
  appStateSnapshot,
  appStateStore,
}: PersistenceRecoveryShellProps) {
  return (
    <AppShellFrame theme={theme} styles={styles}>
      <View style={styles.persistenceRecoveryRoot} accessibilityRole="alert" accessibilityLiveRegion="assertive">
        <Text style={styles.persistenceRecoveryTitle}>Could not load saved app state</Text>
        <Text selectable style={styles.persistenceRecoveryMessage}>
          {appStateSnapshot.persistenceError?.message}
        </Text>
        <Pressable
          onPress={() => void appStateStore.retryPersistence()}
          style={({ pressed }) => [styles.persistenceRecoveryButton, pressed && styles.persistenceRecoveryButtonPressed]}
          accessibilityRole="button"
        >
          <Text style={styles.persistenceRecoveryButtonText}>Retry</Text>
        </Pressable>
      </View>
    </AppShellFrame>
  );
}

interface OnboardingShellProps {
  theme: AppTheme;
  styles: AppStyles;
  bridgeUrl: string | null;
  activeBridgeProfile: { bridgeUrl: string; bridgeToken: string; id: string } | null;
  onboardingMode: OnboardingMode;
  onSave: (draft: OnboardingBridgeProfileDraft) => Promise<void>;
  onCancel?: () => void;
}

export function OnboardingShell({
  theme,
  styles,
  bridgeUrl,
  activeBridgeProfile,
  onboardingMode,
  onSave,
  onCancel,
}: OnboardingShellProps) {
  const mode: OnboardingMode = bridgeUrl ? onboardingMode : 'initial';
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
        onSave={onSave}
        onCancel={onCancel}
      />
    </AppShellFrame>
  );
}