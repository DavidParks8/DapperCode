import { Ionicons } from '@expo/vector-icons';
import { useMemo, type ComponentProps } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import type { WorkspaceSummary } from '../api/types';
import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';
import { useAppTheme } from '../theme';
import {
  formatWorkspaceMeta,
  showWorkspacePinAction,
  toPathBasename,
} from './workspacePickerHelpers';
import { workspacePickerMotion } from './workspacePickerMotion';
import { createWorkspacePickerStyles } from './workspacePickerStyles';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

export function WorkspaceTile({
  workspace,
  iconName,
  selected,
  onPress,
  isPinned,
  onPinAction,
}: {
  workspace: WorkspaceSummary;
  iconName: IoniconName;
  selected: boolean;
  onPress: () => void;
  isPinned: boolean;
  onPinAction: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createWorkspacePickerStyles(theme), [theme]);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={() => showWorkspacePinAction(isPinned, onPinAction)}
      style={[styles.workspaceTile, selected && styles.workspaceTileSelected]}
      accessibilityRole="button"
      accessibilityLabel={`${toPathBasename(workspace.path)}, ${formatWorkspaceMeta(workspace)}`}
      accessibilityHint="Opens this workspace. Long press to pin or unpin."
      accessibilityState={controlAccessibilityState({ selected })}
    >
      {({ pressed }) => (
        <View style={[styles.workspaceTileContent, pressed && styles.pressed]}>
          {selected ? (
            <Animated.View
              entering={FadeIn.duration(workspacePickerMotion.duration.routine).reduceMotion(
                ReduceMotion.System,
              )}
              exiting={FadeOut.duration(workspacePickerMotion.duration.routine).reduceMotion(
                ReduceMotion.System,
              )}
              style={styles.workspaceTileSelectedOverlay}
              pointerEvents="none"
            />
          ) : null}
          <View style={styles.workspaceTileHeader}>
            <Ionicons
              {...decorativeAccessibilityProps}
              name={iconName}
              size={13}
              color={theme.colors.textSecondary}
            />
            <Text style={styles.workspaceTileMeta} numberOfLines={1} ellipsizeMode="tail">
              {formatWorkspaceMeta(workspace)}
            </Text>
          </View>
          <Text style={styles.workspaceTileTitle} numberOfLines={2} ellipsizeMode="tail">
            {toPathBasename(workspace.path)}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

export function LoadingRow({ label }: { label: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createWorkspacePickerStyles(theme), [theme]);
  return (
    <Animated.View
      entering={FadeIn.duration(workspacePickerMotion.duration.routine).reduceMotion(
        ReduceMotion.System,
      )}
      style={styles.statusRow}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
    >
      <ActivityIndicator color={theme.colors.textPrimary} />
      <Text style={styles.statusText}>{label}</Text>
    </Animated.View>
  );
}

export function EmptyRow({ label }: { label: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createWorkspacePickerStyles(theme), [theme]);
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusText}>{label}</Text>
    </View>
  );
}
