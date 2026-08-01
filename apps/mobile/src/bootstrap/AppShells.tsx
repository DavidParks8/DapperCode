import { useAtomValue, useSetAtom } from 'jotai';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { env } from '../config';
import { routes, type ConnectionMode } from '../navigation/routes';
import { replaceRoot } from '../navigation/routeNavigation';
import { retryPersistenceAtom } from '../state/appState/actions';
import { appStatePersistenceErrorAtom } from '../state/appState/atoms';
import { saveBridgeProfileAtom } from '../state/bridge/actions';
import { activeBridgeProfileAtom } from '../state/bridge/atoms';
import { OnboardingScreen } from '../screens/onboarding/OnboardingScreen';
import type { AppTheme } from '../theme';
import type { AppStyles } from './appStyles';

interface ShellProps {
  theme: AppTheme;
  styles: AppStyles;
}
export function LoadingShell({ theme, styles }: ShellProps) {
  return (
    <View
      style={styles.loadingRoot}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading DapperCode"
    >
      <ActivityIndicator size="large" color={theme.colors.textMuted} />
    </View>
  );
}

export function PersistenceRecoveryShell({ styles }: ShellProps) {
  const persistenceError = useAtomValue(appStatePersistenceErrorAtom);
  const retryPersistence = useSetAtom(retryPersistenceAtom);

  return (
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
  );
}

interface ConnectionScreenProps {
  mode: ConnectionMode | 'initial';
  profileId?: string | null;
}

export function ConnectionScreen({ mode, profileId = null }: ConnectionScreenProps) {
  const router = useRouter();
  const activeBridgeProfile = useAtomValue(activeBridgeProfileAtom);
  const saveBridgeProfile = useSetAtom(saveBridgeProfileAtom);
  const shouldUseSavedBridgeCredentials = mode === 'edit' || mode === 'reconnect';
  const initialUrl = shouldUseSavedBridgeCredentials
    ? (activeBridgeProfile?.bridgeUrl ?? '')
    : mode === 'add'
      ? ''
      : (env.legacyHostBridgeUrl ?? '');
  const initialToken = shouldUseSavedBridgeCredentials
    ? (activeBridgeProfile?.bridgeToken ?? '')
    : mode === 'add'
      ? ''
      : (env.hostBridgeToken ?? '');

  return (
    <OnboardingScreen
      mode={mode}
      initialBridgeUrl={initialUrl}
      initialBridgeToken={initialToken}
      allowInsecureRemoteBridge={env.allowInsecureRemoteBridge}
      allowQueryTokenAuth={env.allowWsQueryTokenAuth}
      onSave={async (draft) => {
        const nextProfileId = await saveBridgeProfile({ draft, mode, profileId });
        if (mode !== 'initial') {
          replaceRoot(routes.newChat(nextProfileId));
        }
      }}
      onCancel={
        mode !== 'initial' && activeBridgeProfile
          ? () => {
              if (router.canGoBack()) {
                router.back();
              } else {
                router.replace(routes.settings(activeBridgeProfile.id));
              }
            }
          : undefined
      }
    />
  );
}
