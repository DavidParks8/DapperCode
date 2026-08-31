import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';

import { AtomGlyph } from '../screen/AtomGlyph';
import { motionDuration, motionEasing } from '@shared/ui/motion';
import { useAppTheme, type AppTheme } from '@shared/theme';
import type { ActivityTone } from '../state/runtime';
import {
  formatActivityElapsedAccessibilityLabel,
  formatActivityElapsedTime,
} from './activityDuration';

export type { ActivityTone } from '../state/runtime';

interface ActivityEventProps {
  title: string;
  detail?: string | null;
  tone: ActivityTone;
  elapsedMs?: number | null;
  animationActive?: boolean;
}

const ICON_BY_TONE: Record<ActivityTone, keyof typeof Ionicons.glyphMap> = {
  running: 'sparkles-outline',
  complete: 'checkmark-circle-outline',
  error: 'close-circle-outline',
  idle: 'ellipse-outline',
};

/**
 * How long "Turn completed" and its checkmark stay readable before they dissolve. The row itself
 * stays put until the next turn starts so the finished turn keeps its duration onscreen, but the
 * verdict has said all it has to say by then and would otherwise sit on the transcript as
 * permanent chrome.
 */
export const COMPLETED_TITLE_HOLD_MS = 2_400;

const VERDICT_FADE_EASING = Easing.bezier(...motionEasing.standard);

/**
 * The current activity rendered as the newest event in the transcript rather than floating above
 * the composer.
 */
export function ActivityEvent({
  title,
  detail,
  tone,
  elapsedMs = null,
  animationActive = true,
}: ActivityEventProps) {
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
  const elapsedText = elapsedMs == null ? null : formatActivityElapsedTime(elapsedMs);
  const accessibilityLabel = [
    titleText,
    hasDetail ? normalizedDetail : null,
    elapsedMs == null ? null : `Elapsed ${formatActivityElapsedAccessibilityLabel(elapsedMs)}`,
  ]
    .filter(Boolean)
    .join(', ');
  // Only a completed turn that still has a duration to show can afford to lose its verdict; every
  // other tone would fade to an empty row.
  const verdictCanFade = tone === 'complete' && elapsedText !== null;
  const [verdictFaded, setVerdictFaded] = useState(false);

  useEffect(() => {
    if (!verdictCanFade) {
      setVerdictFaded(false);
      return undefined;
    }
    const timer = setTimeout(() => setVerdictFaded(true), COMPLETED_TITLE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [verdictCanFade, titleText, normalizedDetail]);

  // The checkmark and the title say the same thing, so they leave together and hand the row over
  // to the duration.
  const verdictStyle = useAnimatedStyle(() => ({
    opacity: withTiming(verdictFaded ? 0 : 1, {
      duration: motionDuration.layout,
      easing: VERDICT_FADE_EASING,
      reduceMotion: ReduceMotion.System,
    }),
  }));

  return (
    <Animated.View
      entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
      style={[styles.row, error && styles.errorSurface]}
      testID={error ? 'activity-error-surface' : 'transcript-activity-event'}
      accessible
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.rule} />
      <Animated.View style={[styles.iconWrap, verdictStyle]} testID="transcript-activity-icon">
        {running ? (
          <AtomGlyph color={color} active={animationActive} />
        ) : (
          <Ionicons name={ICON_BY_TONE[tone]} size={14} color={color} />
        )}
      </Animated.View>
      <Animated.Text
        style={[styles.titleText, verdictStyle]}
        numberOfLines={2}
        testID="transcript-activity-title"
      >
        {titleText}
        {hasDetail ? <Text style={styles.detailText}>{` · ${normalizedDetail}`}</Text> : null}
      </Animated.Text>
      {elapsedText ? (
        <Text style={styles.elapsedText} testID="activity-elapsed-time">
          {elapsedText}
        </Text>
      ) : null}
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
    elapsedText: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      fontVariant: ['tabular-nums'],
      textAlign: 'right',
    },
  });
