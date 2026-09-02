import { Ionicons } from '@expo/vector-icons';
import { useMemo, type ComponentProps, type Ref } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { motion, useAppTheme, type AppTheme } from '@shared/theme';
import { createWorkspacePickerStyles, type WorkspacePickerStyles } from './styles';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

export type GroupedRowAccessory = 'chevron' | 'check' | 'none';

export interface GroupedRowProps {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  icon: IoniconName;
  iconColor?: string;
  title: string;
  subtitle?: string;
  /** Right-aligned secondary text, matching the value column of an iOS settings row. */
  value?: string;
  accessory?: GroupedRowAccessory;
  selected?: boolean;
  /** Suppresses the separator so the last row meets the group's rounded corner cleanly. */
  last?: boolean;
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress: () => void;
  onLongPress?: () => void;
  rowRef?: Ref<View>;
}

/**
 * One line of an inset grouped list: leading glyph, stacked copy, optional value, trailing
 * accessory, and a separator inset to the text column the way UIKit insets its own.
 */
export function GroupedRow({
  styles,
  theme,
  icon,
  iconColor,
  title,
  subtitle,
  value,
  accessory = 'none',
  selected = false,
  last = false,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  onLongPress,
  rowRef,
}: GroupedRowProps) {
  return (
    <View ref={rowRef} collapsable={false}>
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={280}
        style={({ pressed }) => [styles.groupedRow, pressed && styles.groupedRowPressed]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={controlAccessibilityState({ selected })}
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name={icon}
          size={22}
          color={iconColor ?? theme.colors.accent}
          style={styles.groupedRowIcon}
        />
        <View style={styles.groupedRowCopy}>
          <Text style={styles.groupedRowTitle} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.groupedRowSubtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {value ? (
          <Text style={styles.groupedRowValue} numberOfLines={1} ellipsizeMode="middle">
            {value}
          </Text>
        ) : null}
        {accessory === 'check' && selected ? (
          <Ionicons
            {...decorativeAccessibilityProps}
            name="checkmark"
            size={18}
            color={theme.colors.accent}
          />
        ) : null}
        {accessory === 'chevron' ? (
          <Ionicons
            {...decorativeAccessibilityProps}
            name="chevron-forward"
            size={16}
            color={theme.colors.textMuted}
          />
        ) : null}
      </Pressable>
      {last ? null : <View style={styles.groupedRowSeparator} />}
    </View>
  );
}

export function LoadingRow({ label }: { label: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createWorkspacePickerStyles(theme), [theme]);
  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.routine).reduceMotion(ReduceMotion.System)}
      style={styles.statusRow}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
    >
      <ActivityIndicator color={theme.colors.textMuted} />
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
