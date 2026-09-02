import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { Easing, FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { decorativeAccessibilityProps, useAccessibilityAnnouncement } from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import {
  gitCheckoutCloningAtom,
  gitCheckoutDirectoryNameAtom,
  gitCheckoutErrorAtom,
  gitCheckoutParentPathAtom,
  gitCheckoutRepoUrlAtom,
} from '../state/gitCheckout';
import { workspaceBridgeRootAtom } from '../state/workspace';
import {
  changeGitCheckoutDirectoryNameAtom,
  changeGitCheckoutRepoUrlAtom,
  closeGitCheckoutAtom,
  openGitCheckoutDestinationPickerAtom,
  submitGitCheckoutAtom,
} from '../state/workspaceActions';
import { motion, useAppTheme } from '@shared/theme';
import { joinWorkspacePath, normalizeCloneDirectoryName } from '../../chat/helpers/helpers';
import { createGitCheckoutScreenStyles } from './styles';

export function GitCheckoutScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createGitCheckoutScreenStyles(theme), [theme]);
  const repoUrl = useAtomValue(gitCheckoutRepoUrlAtom);
  const parentPath = useAtomValue(gitCheckoutParentPathAtom);
  const directoryName = useAtomValue(gitCheckoutDirectoryNameAtom);
  const error = useAtomValue(gitCheckoutErrorAtom);
  const cloning = useAtomValue(gitCheckoutCloningAtom);
  const bridgeRoot = useAtomValue(workspaceBridgeRootAtom);
  const changeRepoUrl = useSetAtom(changeGitCheckoutRepoUrlAtom);
  const changeDirectoryName = useSetAtom(changeGitCheckoutDirectoryNameAtom);
  const openDestinationPicker = useSetAtom(openGitCheckoutDestinationPickerAtom);
  const submit = useSetAtom(submitGitCheckoutAtom);
  const close = useSetAtom(closeGitCheckoutAtom);

  const normalizedDirectoryName = normalizeCloneDirectoryName(directoryName);
  const destinationLabel = parentPath ?? bridgeRoot ?? 'Bridge default workspace';
  const targetPath =
    parentPath && normalizedDirectoryName
      ? joinWorkspacePath(parentPath, normalizedDirectoryName)
      : null;
  const submitDisabled = !repoUrl.trim() || !normalizedDirectoryName || cloning;
  usePreventRemove(cloning, () => undefined);

  // Announce loading state to screen readers, mirroring the GitScreen pattern.
  useAccessibilityAnnouncement(cloning ? 'Cloning repository' : null);

  // Fire semantic haptics once when the clone operation settles, without double-firing on
  // re-renders. Uses a ref to detect the cloning→idle edge.
  const prevCloningRef = useRef(false);
  useEffect(() => {
    const wasCloning = prevCloningRef.current;
    prevCloningRef.current = cloning;
    if (wasCloning && !cloning) {
      if (error) {
        void feedback.error();
      } else {
        void feedback.success();
      }
    }
  }, [cloning, error]);

  // 36×36 visual button + 6px hitSlop on each side = 48×48 effective touch area,
  // meeting both iOS (44pt) and Android (48dp) minimum touch targets.
  const backButtonHitSlop = { top: 6, bottom: 6, left: 6, right: 6 };

  const routineEnter = FadeIn.duration(motion.duration.routine)
    .easing(Easing.bezier(...motion.easing.decelerate))
    .reduceMotion(ReduceMotion.System);
  const routineExit = FadeOut.duration(motion.duration.routine)
    .easing(Easing.bezier(...motion.easing.accelerate))
    .reduceMotion(ReduceMotion.System);

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Stack.Screen options={{ gestureEnabled: !cloning }} />
      <KeyboardAvoidingView
        style={styles.keyboardLayer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <Pressable
            onPress={() => close()}
            disabled={cloning}
            hitSlop={backButtonHitSlop}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="chevron-back"
              size={20}
              color={theme.colors.textSecondary}
            />
          </Pressable>
          <Text accessibilityRole="header" style={styles.title}>
            Git checkout
          </Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.hint}>
            Paste an SSH or HTTPS repository URL, choose where to clone it, then start the new chat
            in that workspace.
          </Text>
          <TextInput
            value={repoUrl}
            onChangeText={changeRepoUrl}
            keyboardAppearance={theme.keyboardAppearance}
            placeholder="git@github.com:org/repo.git"
            placeholderTextColor={theme.colors.textMuted}
            style={styles.input}
            accessibilityLabel="Repository URL"
            autoFocus
            editable={!cloning}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
          />
          <Pressable
            onPress={() => openDestinationPicker()}
            style={({ pressed }) => [styles.pathButton, pressed && styles.pressed]}
            disabled={cloning}
            accessibilityRole="button"
            accessibilityLabel={`Clone into ${destinationLabel}`}
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="folder-open-outline"
              size={16}
              color={theme.colors.textMuted}
            />
            <View style={styles.pathCopy}>
              <Text style={styles.pathLabel}>Clone into</Text>
              <Text style={styles.pathValue} numberOfLines={1}>
                {destinationLabel}
              </Text>
            </View>
            <Ionicons
              {...decorativeAccessibilityProps}
              name="chevron-forward"
              size={14}
              color={theme.colors.textMuted}
            />
          </Pressable>
          <TextInput
            value={directoryName}
            onChangeText={changeDirectoryName}
            keyboardAppearance={theme.keyboardAppearance}
            placeholder="repo-folder"
            placeholderTextColor={theme.colors.textMuted}
            style={styles.input}
            accessibilityLabel="Clone directory name"
            editable={!cloning}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
          />
          {targetPath ? (
            <Text style={styles.summary} numberOfLines={2}>
              {`Will clone into ${targetPath}`}
            </Text>
          ) : null}
          {cloning ? (
            <Animated.View entering={routineEnter} exiting={routineExit} style={styles.cloningRow}>
              <ActivityIndicator
                accessibilityRole="progressbar"
                accessibilityLabel="Cloning repository"
                color={theme.colors.accent}
                size="small"
              />
              <Text style={styles.cloningText}>Cloning repository…</Text>
            </Animated.View>
          ) : null}
          {error ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={styles.errorText}
            >
              {error}
            </Text>
          ) : null}
        </ScrollView>

        <View style={styles.actions}>
          <Pressable
            onPress={() => close()}
            style={({ pressed }) => [
              styles.button,
              styles.buttonSecondary,
              pressed && styles.pressed,
            ]}
            disabled={cloning}
            accessibilityRole="button"
            accessibilityLabel="Cancel git checkout"
          >
            <Text style={styles.buttonSecondaryText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={() => void submit()}
            style={({ pressed }) => [
              styles.button,
              styles.buttonPrimary,
              pressed && styles.pressed,
              submitDisabled && styles.buttonDisabled,
            ]}
            disabled={submitDisabled}
            accessibilityRole="button"
            accessibilityLabel="Clone repository"
          >
            <Text style={styles.buttonPrimaryText}>{cloning ? 'Cloning...' : 'Clone and use'}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
