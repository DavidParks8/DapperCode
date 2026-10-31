import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useAtom, useSetAtom } from 'jotai';
import { useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { SettingsGroup, SettingsRow } from '../../features/settings/SettingsList';
import { openWorkspaceModalAtom } from '../../features/workspace/state/workspaceActions';
import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import { SelectionSheet } from '@shared/ui/SelectionSheet';
import { localSetupDismissedAtom } from '@shell/state/appState/settings';
import { LOCAL_PROFILE_NAME } from '@shell/state/localProfile';
import {
  LOCAL_SETUP_DESTINATIONS,
  useLocalSetup,
  type LocalSetupState,
  type LocalSetupStepStatus,
} from './localSetup';
import { profileSummary } from './profilePresentation';
import { useProfileChoices, type ProfileChoices } from './useProfileChoices';

export const PROFILE_SWITCHER_TITLE = 'Where agents run';

function ProfileSwitcherSheet({
  choices,
  visible,
  onClose,
}: {
  choices: ProfileChoices;
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <SelectionSheet
      visible={visible}
      eyebrow="Profiles"
      title={PROFILE_SWITCHER_TITLE}
      subtitle="Each profile keeps its own chats. Switching opens a new chat there."
      options={choices.options(onClose)}
      onClose={onClose}
    />
  );
}

function switcherLabel(choices: ProfileChoices): string {
  const name = choices.active?.name ?? 'No profile';
  const summary = choices.activePresentation ? profileSummary(choices.activePresentation) : '';
  return [PROFILE_SWITCHER_TITLE, name, summary].filter(Boolean).join(', ');
}

export interface DrawerProfileRowStyles {
  row: StyleProp<ViewStyle>;
  rowPressed: StyleProp<ViewStyle>;
  label: StyleProp<TextStyle>;
  value: StyleProp<TextStyle>;
}

/**
 * Drawer row naming the open profile; it opens the profile switcher. It borrows the drawer's
 * folder-filter row styles so both pickers read as one family.
 */
export function DrawerProfileRow({ styles }: { styles: DrawerProfileRowStyles }) {
  const theme = useAppTheme();
  const choices = useProfileChoices();
  const [visible, setVisible] = useState(false);
  if (!choices.offerChoice) {
    return null;
  }
  return (
    <>
      <Pressable
        accessibilityLabel={switcherLabel(choices)}
        accessibilityHint="Switches between this iPhone and your paired computers."
        accessibilityRole="button"
        accessibilityState={controlAccessibilityState({ expanded: visible })}
        onPress={() => setVisible(true)}
        // The folder row below draws the shared hairline.
        style={({ pressed }) => [
          styles.row,
          { borderBottomWidth: 0 },
          pressed && styles.rowPressed,
        ]}
        testID="drawer-profile-switcher"
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name={choices.activePresentation?.icon ?? 'swap-horizontal-outline'}
          size={16}
          color={theme.colors.textMuted}
        />
        <Text style={styles.label}>Runs on</Text>
        <Text style={styles.value} numberOfLines={1}>
          {choices.active?.name ?? 'Choose'}
        </Text>
        <Ionicons
          {...decorativeAccessibilityProps}
          name="chevron-down"
          size={14}
          color={theme.colors.userBubble}
        />
      </Pressable>
      <ProfileSwitcherSheet choices={choices} visible={visible} onClose={() => setVisible(false)} />
    </>
  );
}

const STEP_VALUE: Record<LocalSetupStepStatus, string> = {
  done: 'Done',
  'in-progress': 'Downloading',
  todo: 'Required',
  recommended: 'Recommended',
};

function setupFooter(setup: LocalSetupState): string {
  if (setup.readiness.reason) {
    return setup.readiness.reason;
  }
  return setup.author === 'done'
    ? 'Type a message below to start your first chat.'
    : 'Type a message below to start your first chat. Add a Git author before the agent commits.';
}

/**
 * First-run checklist for the built-in profile: download a model, add a workspace, set a Git
 * author, and start a chat. Only the model and workspace are required; the guide never blocks a
 * chat and stays until the first local chat has a message or the user hides it.
 */
export function LocalSetupGuide() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const setup = useLocalSetup();
  const [dismissed, setDismissed] = useAtom(localSetupDismissedAtom);
  const openWorkspacePicker = useSetAtom(openWorkspaceModalAtom);
  if (!setup || setup.chatStarted || dismissed) {
    return null;
  }
  return (
    <View style={styles.guide} testID="local-setup-guide">
      <SettingsGroup title={`Set up ${LOCAL_PROFILE_NAME}`} footer={setupFooter(setup)}>
        <SettingsRow
          label="1. Download a model"
          value={STEP_VALUE[setup.model]}
          accessory="chevron"
          onPress={() => router.push(LOCAL_SETUP_DESTINATIONS.models)}
        />
        <SettingsRow
          label="2. Clone or create a workspace"
          value={STEP_VALUE[setup.workspace]}
          accessory="chevron"
          onPress={() => openWorkspacePicker()}
        />
        <SettingsRow
          label="3. Add a Git author"
          value={STEP_VALUE[setup.author]}
          accessory="chevron"
          onPress={() => router.push(LOCAL_SETUP_DESTINATIONS.author)}
        />
        <SettingsRow
          label="4. Start your first chat"
          value={setup.readiness.canStart ? 'Ready' : 'After steps 1 and 2'}
        />
        <SettingsRow label="Hide setup guide" tone="accent" onPress={() => setDismissed(true)} />
      </SettingsGroup>
    </View>
  );
}

/**
 * New-chat controls for choosing where the chat runs, plus first-run setup when the local
 * profile is not ready yet. Renders nothing when there is no choice to make.
 */
export function NewChatRunTarget() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const choices = useProfileChoices();
  const [visible, setVisible] = useState(false);
  if (!choices.offerChoice) {
    return null;
  }
  return (
    <>
      <Pressable
        accessibilityLabel={switcherLabel(choices)}
        accessibilityHint="Chooses where this new chat runs."
        accessibilityRole="button"
        accessibilityState={controlAccessibilityState({ expanded: visible })}
        onPress={() => setVisible(true)}
        style={({ pressed }) => [styles.capsule, pressed && styles.capsulePressed]}
        testID="new-chat-profile-switcher"
      >
        <GlassSurface pointerEvents="none" role="capsule" style={styles.capsuleGlass}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name={choices.activePresentation?.icon ?? 'swap-horizontal-outline'}
            size={15}
            color={theme.colors.textSecondary}
          />
          <Text style={styles.capsuleLabel} numberOfLines={1}>
            {choices.active?.name ?? 'Choose where to run'}
          </Text>
          {choices.activePresentation?.status ? (
            <Text style={styles.capsuleStatus} numberOfLines={1}>
              {choices.activePresentation.status}
            </Text>
          ) : null}
          <Ionicons
            {...decorativeAccessibilityProps}
            name="chevron-down"
            size={12}
            color={theme.colors.textSecondary}
          />
        </GlassSurface>
      </Pressable>
      <LocalSetupGuide />
      <ProfileSwitcherSheet choices={choices} visible={visible} onClose={() => setVisible(false)} />
    </>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    capsule: { maxWidth: '100%', marginBottom: theme.spacing.md },
    capsulePressed: { transform: [{ scale: 0.97 }] },
    capsuleGlass: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      borderCurve: 'continuous',
      borderRadius: theme.radius.full,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.xs,
      minHeight: theme.touchTarget.minimum,
    },
    capsuleLabel: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
      flexShrink: 1,
    },
    capsuleStatus: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    guide: {
      alignSelf: 'stretch',
      width: '100%',
      maxWidth: 480,
      marginBottom: theme.spacing.xl,
    },
  });
}
