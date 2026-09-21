import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useAtomValue, useSetAtom } from 'jotai';
import { randomUUID } from 'expo-crypto';

import type { HostBridgeApiClient } from '@bridge/client/client';
import type { CreateManagedWorktree, ManagedWorktree } from '@bridge/types/types';
import {
  activeBridgeProfileAtom,
  apiClientAtom,
  bridgeConnectedAtom,
} from '@shell/state/bridge/atoms';
import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import { routes } from '@shell/navigation/routes';
import { useAppTheme } from '@shared/theme';
import { createGitCheckoutScreenStyles } from '../checkout/styles';

export function ManagedWorktreesScreen() {
  const api = useAtomValue(apiClientAtom);
  const profile = useAtomValue(activeBridgeProfileAtom);
  const connected = useAtomValue(bridgeConnectedAtom);
  const { cwd } = useLocalSearchParams<{ cwd?: string }>();
  if (!api || !profile) {
    return null;
  }
  return (
    <WorktreesForm
      key={`${profile.id}:${profile.updatedAt}:${profile.bridgeUrl}:${cwd ?? ''}`}
      api={api}
      cwd={cwd ?? null}
      profileId={profile.id}
      connected={connected}
    />
  );
}

export function WorktreesForm({
  api,
  cwd,
  profileId,
  connected,
}: {
  api: HostBridgeApiClient;
  cwd: string | null;
  profileId: string;
  connected: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createGitCheckoutScreenStyles(theme), [theme]);
  const setWorkspace = useSetAtom(defaultStartCwdAtom);
  const [worktrees, setWorktrees] = useState<ManagedWorktree[]>([]);
  const [branch, setBranch] = useState('');
  const [baseRef, setBaseRef] = useState('HEAD');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);
  const request = useRef<CreateManagedWorktree | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  usePreventRemove(busy, () => undefined);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const capabilities = await api.readBridgeCapabilities();
      if (!mounted.current) {
        return;
      }
      if (!capabilities.supports.managedWorktrees) {
        setError('Update the desktop app to use managed worktrees.');
        return;
      }
      setSupported(true);
      const response = await api.listManagedWorktrees();
      if (mounted.current) {
        setWorktrees(response.worktrees);
      }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  }, [api]);
  useEffect(() => {
    if (connected) {
      void refresh();
    }
  }, [refresh, connected]);

  const selectWorktree = (worktree: ManagedWorktree) => {
    setWorkspace(worktree.path);
    router.dismissTo(routes.newChat(profileId));
  };
  const run = async (operation: () => Promise<void>) => {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      pending.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  };
  const create = (retry?: ManagedWorktree) =>
    run(async () => {
      const next = retry
        ? { id: retry.id, cwd: retry.repository, branch: retry.branch, baseRef: retry.baseRef }
        : (request.current ?? {
            id: randomUUID(),
            cwd,
            branch: branch.trim(),
            baseRef: baseRef.trim(),
          });
      request.current = next;
      const result = await api.createManagedWorktree(next);
      if (!mounted.current) {
        return;
      }
      request.current = null;
      setWorktrees((current) => [
        ...current.filter((item) => item.id !== result.worktree.id),
        result.worktree,
      ]);
      setBranch('');
      // Stay on this screen until the operation settles; navigation is a separate explicit action.
    });
  const remove = (worktree: ManagedWorktree) =>
    run(async () => {
      await api.removeManagedWorktree(worktree.id);
      if (mounted.current) {
        setWorktrees((current) => current.filter((item) => item.id !== worktree.id));
      }
    });
  const confirmRemove = (worktree: ManagedWorktree) =>
    Alert.alert(
      'Remove worktree?',
      `Remove the checkout for ${worktree.branch}? The Git branch is kept. Chats using it and modified, untracked, or ignored files must be removed first.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void remove(worktree) },
      ],
    );
  const disabled = busy || loading || !supported || !connected;
  const createDisabled = disabled || !branch.trim() || !baseRef.trim();
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Stack.Screen options={{ gestureEnabled: !busy }} />
      <KeyboardAvoidingView
        style={styles.keyboardLayer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            disabled={busy}
            onPress={() => router.back()}
            style={styles.button}
          >
            <Text style={styles.buttonSecondaryText}>Back</Text>
          </Pressable>
          <Text accessibilityRole="header" style={styles.title}>
            Worktrees
          </Text>
          <View style={styles.headerSpacer} />
        </View>
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          testID="managed-worktrees-screen"
        >
          <Text style={styles.hint}>
            Create a separate checkout on a new branch. Your current workspace stays in place.
            Choose Use worktree below to start a chat there.
          </Text>
          <Text style={styles.summary} selectable>
            {cwd}
          </Text>
          <Text style={styles.pathLabel}>New branch</Text>
          <TextInput
            accessibilityLabel="Worktree branch"
            testID="worktree-branch"
            value={branch}
            onChangeText={(value) => {
              setBranch(value);
              request.current = null;
            }}
            editable={!disabled}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="feature/my-task"
            placeholderTextColor={theme.colors.textMuted}
            keyboardAppearance={theme.keyboardAppearance}
            style={styles.input}
          />
          <Text style={styles.pathLabel}>Start from</Text>
          <TextInput
            accessibilityLabel="Worktree base reference"
            testID="worktree-base"
            value={baseRef}
            onChangeText={(value) => {
              setBaseRef(value);
              request.current = null;
            }}
            editable={!disabled}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="HEAD or main"
            placeholderTextColor={theme.colors.textMuted}
            keyboardAppearance={theme.keyboardAppearance}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create worktree"
            testID="worktree-create"
            disabled={createDisabled}
            onPress={() => void create()}
            style={[styles.button, styles.buttonPrimary, createDisabled && styles.buttonDisabled]}
          >
            <Text style={styles.buttonPrimaryText}>Create worktree</Text>
          </Pressable>
          {loading || busy ? (
            <ActivityIndicator
              accessibilityRole="progressbar"
              accessibilityLabel={busy ? 'Updating worktrees' : 'Loading worktrees'}
              color={theme.colors.accent}
            />
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
          ) : null}
          <Text accessibilityRole="header" style={styles.pathValue}>
            Managed checkouts
          </Text>
          {!loading && !worktrees.length ? (
            <Text style={styles.hint}>No managed worktrees yet.</Text>
          ) : null}
          {worktrees.map((worktree) => (
            <View key={worktree.id} style={styles.body}>
              <Text style={styles.pathValue}>{worktree.branch}</Text>
              <Text style={styles.summary} selectable>
                {worktree.path}
              </Text>
              <Text style={styles.hint}>
                From {worktree.baseRef}
                {worktree.status === 'creating' ? ' · Creation needs retry' : ''}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Use worktree ${worktree.branch}`}
                disabled={disabled || worktree.status !== 'ready'}
                onPress={() => selectWorktree(worktree)}
                style={[styles.button, styles.buttonSecondary]}
              >
                <Text style={styles.buttonSecondaryText}>Use worktree</Text>
              </Pressable>
              {worktree.status === 'creating' ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Retry worktree ${worktree.branch}`}
                  disabled={disabled}
                  onPress={() => void create(worktree)}
                  style={styles.button}
                >
                  <Text style={styles.buttonSecondaryText}>Retry creation</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove worktree ${worktree.branch}`}
                disabled={disabled}
                onPress={() => confirmRemove(worktree)}
                style={styles.button}
              >
                <Text style={styles.buttonSecondaryText}>Remove checkout</Text>
              </Pressable>
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh worktrees"
            disabled={busy || loading}
            onPress={() => void refresh()}
            style={styles.button}
          >
            <Text style={styles.buttonSecondaryText}>Refresh</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
