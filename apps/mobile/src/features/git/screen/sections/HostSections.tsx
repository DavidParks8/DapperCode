import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated as NativeAnimated,
  Easing as NativeEasing,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import { changeToneColors } from '../../styles/hostActions';
import type { GitSectionCommonProps } from '../sectionTypes';
import { describeChange, type ChangedFileEntry } from '../utils';

/** How long "Discard all" must be held; long enough that a stray tap never loses work. */
export const DISCARD_ALL_HOLD_MS = 1200;

export function GitChangeBadge({
  entry,
  styles,
  theme,
}: Omit<GitSectionCommonProps, 'controller'> & {
  entry: Pick<ChangedFileEntry, 'code' | 'untracked'>;
}) {
  const change = describeChange(entry);
  const colors = changeToneColors(theme, change.tone);
  return (
    <View style={[styles.changeBadge, { backgroundColor: colors.backgroundColor }]}>
      <Text style={[styles.changeBadgeText, { color: colors.color }]} numberOfLines={1}>
        {change.label}
      </Text>
    </View>
  );
}

export function GitNotice({ controller, styles }: Omit<GitSectionCommonProps, 'theme'>) {
  if (!controller.notice || controller.error) {
    return null;
  }
  return (
    <Text accessibilityLiveRegion="polite" style={styles.noticeText}>
      {controller.notice}
    </Text>
  );
}

function SyncButton({
  label,
  icon,
  busy,
  disabled,
  onPress,
  styles,
  theme,
}: Omit<GitSectionCommonProps, 'controller'> & {
  label: string;
  icon: 'cloud-download-outline' | 'arrow-down-circle-outline';
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.syncButton,
        pressed && styles.fileActionBtnPressed,
        disabled && styles.fileActionBtnDisabled,
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={controlAccessibilityState({ disabled, busy })}
    >
      {busy ? (
        <ActivityIndicator {...decorativeAccessibilityProps} size="small" />
      ) : (
        <Ionicons
          {...decorativeAccessibilityProps}
          name={icon}
          size={16}
          color={theme.colors.textPrimary}
        />
      )}
      <Text style={styles.syncButtonText}>{label}</Text>
    </Pressable>
  );
}

/** Origin, fetch, and pull for hosts that report remote state and support syncing. */
export function GitRemoteSyncBlock({ controller, styles, theme }: GitSectionCommonProps) {
  const { derived } = controller;
  if (!controller.features.gitSync || !derived.remote) {
    return null;
  }
  const busy = controller.syncing !== null || controller.pushing || controller.committing;
  const reason = derived.fetchBlockedReason ?? derived.pullBlockedReason;
  return (
    <>
      {derived.originDisplay ? (
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Origin</Text>
          <Text style={styles.infoValue} numberOfLines={1} ellipsizeMode="middle">
            {derived.originDisplay}
          </Text>
        </View>
      ) : null}
      <View style={styles.syncRow}>
        <SyncButton
          label={controller.syncing === 'fetch' ? 'Fetching…' : 'Fetch'}
          icon="cloud-download-outline"
          busy={controller.syncing === 'fetch'}
          disabled={busy || controller.loading || Boolean(derived.fetchBlockedReason)}
          onPress={() => void controller.fetch()}
          styles={styles}
          theme={theme}
        />
        <SyncButton
          label={
            controller.syncing === 'pull'
              ? 'Pulling…'
              : derived.behindCount > 0
                ? `Pull (${String(derived.behindCount)})`
                : 'Pull'
          }
          icon="arrow-down-circle-outline"
          busy={controller.syncing === 'pull'}
          disabled={busy || controller.loading || Boolean(derived.pullBlockedReason)}
          onPress={() => void controller.pull()}
          styles={styles}
          theme={theme}
        />
      </View>
      {reason ? <Text style={styles.reasonText}>{reason}</Text> : null}
    </>
  );
}

export function GitBranchCreateRow({ controller, styles, theme }: GitSectionCommonProps) {
  if (!controller.features.gitBranchCreate) {
    return null;
  }
  const name = controller.newBranchName.trim();
  const disabled = !name || controller.creatingBranch || controller.switchingBranch;
  return (
    <View style={styles.branchCreateRow}>
      <TextInput
        value={controller.newBranchName}
        onChangeText={controller.setNewBranchName}
        placeholder="New branch name"
        placeholderTextColor={theme.colors.textMuted}
        keyboardAppearance={theme.keyboardAppearance}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        onSubmitEditing={() => void controller.createBranch()}
        editable={!controller.creatingBranch}
        style={styles.branchCreateInput}
        accessibilityLabel="New branch name"
      />
      <Pressable
        onPress={() => void controller.createBranch()}
        disabled={disabled}
        style={({ pressed }) => [
          styles.branchCreateButton,
          pressed && styles.actionBtnPressed,
          disabled && styles.actionBtnDisabled,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Create branch"
        accessibilityHint="Creates the branch from the current commit and switches to it"
        accessibilityState={controlAccessibilityState({
          disabled,
          busy: controller.creatingBranch,
        })}
      >
        <Text style={[styles.branchCreateButtonText, disabled && styles.actionBtnTextDisabled]}>
          {controller.creatingBranch ? 'Creating…' : 'Create'}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * "Discard all" commits only after a deliberate press and hold. A tap explains what it does, and
 * the fill shows how long is left, so nothing is lost by accident and no dialog interrupts.
 */
export function GitDiscardAllButton({
  controller,
  styles,
  disabled,
}: Omit<GitSectionCommonProps, 'theme'> & { disabled: boolean }) {
  const progress = useRef(new NativeAnimated.Value(0)).current;
  const [explained, setExplained] = useState(false);
  useEffect(() => () => progress.stopAnimation(), [progress]);
  if (!controller.features.gitDiscard || !controller.derived.hasUnstagedFiles) {
    return null;
  }
  const busy = controller.discardingAll;
  const blocked = disabled || busy || controller.discardingPath !== null;
  const reset = () => {
    NativeAnimated.timing(progress, {
      toValue: 0,
      duration: 150,
      useNativeDriver: false,
    }).start();
  };
  return (
    <>
      <Pressable
        onPressIn={() => {
          NativeAnimated.timing(progress, {
            toValue: 1,
            duration: DISCARD_ALL_HOLD_MS,
            easing: NativeEasing.linear,
            useNativeDriver: false,
          }).start();
        }}
        onPressOut={reset}
        onPress={() => setExplained(true)}
        onLongPress={() => {
          setExplained(false);
          void feedback.warning();
          void controller.discardAll();
        }}
        delayLongPress={DISCARD_ALL_HOLD_MS}
        disabled={blocked}
        hitSlop={8}
        style={[styles.holdButton, blocked && styles.fileActionBtnDisabled]}
        accessibilityRole="button"
        accessibilityLabel="Discard all unstaged changes"
        accessibilityHint="Double-tap and hold. Restores tracked files and deletes untracked files. Staged changes are kept."
        accessibilityState={controlAccessibilityState({ disabled: blocked, busy })}
        testID="git-discard-all"
      >
        <NativeAnimated.View
          pointerEvents="none"
          style={[
            styles.holdButtonFill,
            {
              transform: [{ scaleX: progress }],
              transformOrigin: 'left',
            },
          ]}
        />
        <Text style={styles.holdButtonText}>{busy ? 'Discarding…' : 'Hold to discard all'}</Text>
      </Pressable>
      {explained ? (
        <Text accessibilityLiveRegion="polite" style={styles.reasonText}>
          Touch and hold to discard every unstaged change and delete untracked files. Staged changes
          are kept.
        </Text>
      ) : null}
    </>
  );
}

/** Shown instead of status when the workspace has no repository. */
export function GitRepositorySetupSection({ controller, styles, theme }: GitSectionCommonProps) {
  const canInit = controller.features.gitInit;
  const busy = controller.initializing;
  const disabled = busy || Boolean(controller.initOriginError);
  return (
    <View style={[styles.card, styles.setupCard]} testID="git-repository-setup">
      <Text accessibilityRole="header" style={styles.setupTitle}>
        This workspace doesn't use Git yet
      </Text>
      <Text style={styles.setupBody}>
        {canInit
          ? 'Initialize Git to track changes, review diffs, and commit. Add an HTTPS remote now if you want to push later.'
          : 'Initialize a repository in this folder on your computer to review and commit changes here.'}
      </Text>
      {canInit ? (
        <>
          <TextInput
            value={controller.initOrigin}
            onChangeText={controller.setInitOrigin}
            placeholder="https://github.com/owner/repository.git (optional)"
            placeholderTextColor={theme.colors.textMuted}
            keyboardAppearance={theme.keyboardAppearance}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            style={styles.branchCreateInput}
            accessibilityLabel="Remote URL, optional"
          />
          {controller.initOriginError ? (
            <Text style={styles.errorText}>{controller.initOriginError}</Text>
          ) : null}
          <Pressable
            onPress={() => void controller.initializeRepository()}
            disabled={disabled}
            style={({ pressed }) => [
              styles.actionBtn,
              pressed && styles.actionBtnPressed,
              disabled && styles.actionBtnDisabled,
            ]}
            accessibilityRole="button"
            accessibilityState={controlAccessibilityState({ disabled, busy })}
            testID="git-initialize"
          >
            <Text style={[styles.actionBtnText, disabled && styles.actionBtnTextDisabled]}>
              {busy ? 'Initializing…' : 'Initialize Git'}
            </Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}
