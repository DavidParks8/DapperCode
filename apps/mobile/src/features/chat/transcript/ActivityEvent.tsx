import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';

import { AtomGlyph } from '../screen/AtomGlyph';
import { motionDuration } from '@shared/ui/motion';
import { useAppTheme, type AppTheme } from '@shared/theme';
import type { ActivityTone } from '../state/runtime';

export type { ActivityTone } from '../state/runtime';

interface ActivityEventProps {
  title: string;
  detail?: string | null;
  tone: ActivityTone;
}

const ICON_BY_TONE: Record<ActivityTone, keyof typeof Ionicons.glyphMap> = {
  running: 'sparkles-outline',
  complete: 'checkmark-circle-outline',
  error: 'close-circle-outline',
  idle: 'ellipse-outline',
};

/**
 * The current activity rendered as the newest event in the transcript rather than floating above
 * the composer.
 */
export function ActivityEvent({ title, detail, tone }: ActivityEventProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const colorByTone: Record<ActivityTone, string> = {
    running: theme.colors.statusRunning,
    complete: theme.colors.statusComplete,
    error: theme.colors.statusError,
    idle: theme.colors.statusIdle,
  };
  const color = colorByTone[tone];
  const normalizedDetail = detail?.trim() ?? '';
  const hasDetail = normalizedDetail.length > 0;
  const normalizedTitle = title.trim();
  const titleText = normalizedTitle || title;
  const running = tone === 'running';
  const error = tone === 'error';

  return (
    <Animated.View
      entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
      style={[styles.row, error && styles.errorSurface]}
      testID={error ? 'activity-error-surface' : 'transcript-activity-event'}
    >
      <View style={styles.rule} />
      <View style={styles.iconWrap}>
        {running ? (
          <AtomGlyph color={color} />
        ) : (
          <Ionicons name={ICON_BY_TONE[tone]} size={14} color={color} />
        )}
      </View>
      <Text style={styles.titleText} numberOfLines={2}>
        {titleText}
        {hasDetail ? <Text style={styles.detailText}>{` · ${normalizedDetail}`}</Text> : null}
      </Text>
    </Animated.View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
    },
    errorSurface: {
      backgroundColor: theme.colors.bgElevated,
      borderColor: theme.colors.errorBorder,
      borderWidth: StyleSheet.hairlineWidth,
      boxShadow: theme.isDark
        ? '0 8px 20px rgba(0, 0, 0, 0.28)'
        : '0 8px 18px rgba(15, 31, 54, 0.12)',
    },
    rule: {
      width: theme.spacing.xl,
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.borderHighlight,
    },
    iconWrap: {
      width: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    titleText: {
      ...theme.typography.label,
      color: theme.colors.textPrimary,
      fontWeight: '600',
      flex: 1,
    },
    detailText: {
      color: theme.colors.textPrimary,
      fontWeight: '400',
    },
  });
