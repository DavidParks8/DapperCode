import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Animated, { type FadeIn, type FadeOut } from 'react-native-reanimated';

import type { AppTheme } from '@shared/theme';
import type { WorkspaceHostClient } from '../api/client';
import type { CloneProgressResponse } from '../api/protocol';
import { httpsRemoteError } from '../api/remoteUrl';
import type { createGitCheckoutScreenStyles } from './styles';

type CheckoutStyles = ReturnType<typeof createGitCheckoutScreenStyles>;

/** Copy for bridge checkouts (any URL, chosen folder) and app-managed clones (HTTPS workspace). */
export function checkoutCopy(managed: boolean) {
  return managed
    ? {
        title: 'Clone repository',
        hint: 'Paste an HTTPS repository URL. It is copied into a new workspace on this device, and new chats use it. Private repositories need a GitHub sign-in in Settings.',
        urlPlaceholder: 'https://github.com/owner/repository.git',
        namePlaceholder: 'Workspace name',
        nameLabel: 'Workspace name',
        urlKeyboard: 'url' as const,
        chooseDestination: false,
      }
    : {
        title: 'Git checkout',
        hint: 'Paste an SSH or HTTPS repository URL, choose where to clone it, then start the new chat in that workspace.',
        urlPlaceholder: 'git@github.com:org/repo.git',
        namePlaceholder: 'repo-folder',
        nameLabel: 'Clone directory name',
        urlKeyboard: 'default' as const,
        chooseDestination: true,
      };
}

/** Managed hosts only clone HTTPS remotes, so the URL is validated before submitting. */
export function checkoutUrlError(managed: boolean, url: string): string | null {
  return managed && url.trim() ? httpsRemoteError(url) : null;
}

export function CheckoutUrlError({
  error,
  styles,
}: {
  error: string | null;
  styles: CheckoutStyles;
}) {
  return error ? (
    <Text style={styles.errorText} testID="git-checkout-url-error">
      {error}
    </Text>
  ) : null;
}

export function checkoutSummary(
  managed: boolean,
  directoryName: string | null,
  targetPath: string | null,
): string | null {
  if (managed) {
    return directoryName ? `Creates the workspace “${directoryName}”` : null;
  }
  return targetPath ? `Will clone into ${targetPath}` : null;
}

/**
 * Follows the host's transfer progress while a managed clone runs. Progress arrives as host
 * notifications; one snapshot read covers progress made before the subscription, and is ignored
 * once a newer notification has arrived.
 */
export function useCloneProgress(
  host: WorkspaceHostClient | null,
  managed: boolean,
  cloning: boolean,
): CloneProgressResponse | null {
  const active = managed && cloning;
  const [progress, setProgress] = useState<CloneProgressResponse | null>(null);
  useEffect(() => {
    if (!active || !host) {
      setProgress(null);
      return;
    }
    let subscribed = true;
    let notified = false;
    const unsubscribe = host.onCloneProgress((next) => {
      notified = true;
      setProgress(next);
    });
    void host
      .cloneProgress()
      .then((snapshot) => {
        if (subscribed && !notified) {
          setProgress(snapshot);
        }
      })
      .catch(() => undefined);
    return () => {
      subscribed = false;
      unsubscribe();
    };
  }, [active, host]);
  return progress;
}

export function cloneProgressLabel(progress: CloneProgressResponse | null): string {
  if (progress?.cancelled) {
    return 'Stopping…';
  }
  if (!progress || progress.total <= 0) {
    return 'Connecting to the remote…';
  }
  return `Receiving files: ${String(progress.completed)} of ${String(progress.total)}`;
}

export function CloningRow({
  managed,
  progress,
  styles,
  theme,
  entering,
  exiting,
}: {
  managed: boolean;
  progress: CloneProgressResponse | null;
  styles: CheckoutStyles;
  theme: AppTheme;
  entering: ReturnType<typeof FadeIn.duration>;
  exiting: ReturnType<typeof FadeOut.duration>;
}) {
  const percent =
    progress && progress.total > 0
      ? Math.round(Math.min(1, progress.completed / progress.total) * 100)
      : null;
  return (
    <Animated.View entering={entering} exiting={exiting} style={styles.cloningRow}>
      <ActivityIndicator
        accessibilityRole="progressbar"
        accessibilityLabel="Cloning repository"
        color={theme.colors.accent}
        size="small"
      />
      <View style={styles.cloningCopy}>
        <Text style={styles.cloningText}>
          {managed ? cloneProgressLabel(progress) : 'Cloning repository…'}
        </Text>
        {percent !== null ? (
          <View
            style={styles.progressTrack}
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: percent }}
          >
            <View style={[styles.progressFill, { width: `${percent}%` }]} />
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

export function checkoutSubmitDisabled(
  repoUrl: string,
  directoryName: string | null,
  cloning: boolean,
  urlError: string | null,
): boolean {
  return !repoUrl.trim() || !directoryName || cloning || Boolean(urlError);
}

/**
 * Cancel leaves the screen; while a managed clone runs it becomes Stop, which asks the host to
 * cancel the transfer; a cancelled clone never appears as a workspace.
 */
export function CheckoutSecondaryButton({
  managed,
  cloning,
  host,
  progress,
  styles,
  onCancel,
}: {
  managed: boolean;
  cloning: boolean;
  host: WorkspaceHostClient | null;
  progress: CloneProgressResponse | null;
  styles: CheckoutStyles;
  onCancel: () => void;
}) {
  if (!managed || !cloning) {
    return (
      <Pressable
        onPress={onCancel}
        style={({ pressed }) => [styles.button, styles.buttonSecondary, pressed && styles.pressed]}
        disabled={cloning}
        accessibilityRole="button"
        accessibilityLabel="Cancel git checkout"
      >
        <Text style={styles.buttonSecondaryText}>Cancel</Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={() => void host?.cancelClone()}
      style={({ pressed }) => [styles.button, styles.buttonSecondary, pressed && styles.pressed]}
      disabled={progress?.cancelled === true}
      accessibilityRole="button"
      accessibilityLabel="Stop cloning"
      testID="git-checkout-stop"
    >
      <Text style={styles.buttonSecondaryText}>Stop</Text>
    </Pressable>
  );
}
