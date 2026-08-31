import { useAtomValue, useSetAtom } from 'jotai';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { env } from '@shared/config';
import { routes, type ConnectionMode } from '@shell/navigation/routes';
import { replaceRoot } from '@shell/navigation/routeNavigation';
import { retryPersistenceAtom } from '@shell/state/appState/actions';
import { appStatePersistenceErrorAtom } from '@shell/state/appState/atoms';
import { saveBridgeProfileAtom } from '@shell/state/bridge/actions';
import { activeBridgeProfileAtom } from '@shell/state/bridge/atoms';
import { OnboardingScreen } from '../../features/onboarding/screen/OnboardingScreen';
import type { AppTheme } from '@shared/theme';
import type { AppStyles } from '@shell/boot/appStyles';
import type { BridgeProfile } from '@shell/state/bridgeProfiles';

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
  /**
   * Called with the activated profile id in place of the default post-save root navigation
   * (`replaceRoot(routes.newChat(...))`). Route-owning screens that present this as a modal on
   * top of their own history (e.g. Settings' connection editor) use this to unwind that local
   * state first — see `app/.../settings/connection.tsx` — so a successful Save can't leave the
   * modal resident/focused beneath the new root screen. Without this, a later plain
   * `navigateRoot` back to that route finds its own `index` already present-but-not-focused in
   * that stack, and the vendored StackRouter's NAVIGATE handling pushes a duplicate `index`
   * instead of jumping back to it, leaving the just-saved editor reachable again via Back.
   */
  onSaved?: (nextProfileId: string) => void;
}

function initialWorkspaceIdForMode(
  mode: ConnectionScreenProps['mode'],
  profile: BridgeProfile | null,
): string | null {
  return mode === 'edit' || mode === 'reconnect' ? (profile?.workspaceId ?? null) : null;
}

export function ConnectionScreen({ mode, profileId = null, onSaved }: ConnectionScreenProps) {
  const router = useRouter();
  const activeBridgeProfile = useAtomValue(activeBridgeProfileAtom);
  const saveBridgeProfile = useSetAtom(saveBridgeProfileAtom);
  const shouldUseSavedBridgeCredentials = mode === 'edit' || mode === 'reconnect';
  const initialUrl = shouldUseSavedBridgeCredentials
    ? (activeBridgeProfile?.bridgeUrl ?? '')
    : mode === 'add'
      ? ''
      : (env.hostBridgeUrl ?? '');
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
      initialWorkspaceId={initialWorkspaceIdForMode(mode, activeBridgeProfile)}
      allowInsecureRemoteBridge={env.allowInsecureRemoteBridge}
      allowQueryTokenAuth={env.allowWsQueryTokenAuth}
      onSave={async (draft) => {
        const nextProfileId = await saveBridgeProfile({ draft, mode, profileId });
        if (mode === 'initial') {
          return;
        }
        if (onSaved) {
          onSaved(nextProfileId);
          return;
        }
        replaceRoot(routes.newChat(nextProfileId));
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
