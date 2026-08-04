import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';

import { AtomGlyph } from './AtomGlyph';
import { motionDuration } from '@shared/ui/motion';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import type { ActivityTone } from '../state/runtime';

export type { ActivityTone } from '../state/runtime';

interface ActivityBarProps {
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
 * A single quiet caption line that keeps its own native-glass backing while transcript content
 * passes beneath it.
 */
export function ActivityBar({ title, detail, tone }: ActivityBarProps) {
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
  const stacked = hasDetail && tone !== 'running';
  const running = tone === 'running';
  const labelStyle = [styles.titleText, tone === 'error' ? styles.titleTextError : null];
  const content = (
    <Animated.View
      entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
      style={[styles.row, stacked ? styles.rowStacked : null]}
    >
      <View
        style={[
          styles.iconWrap,
          running ? styles.iconWrapRunning : null,
          stacked ? styles.iconWrapStacked : null,
        ]}
      >
        {running ? (
          <AtomGlyph color={color} />
        ) : (
          <Ionicons name={ICON_BY_TONE[tone]} size={12} color={color} />
        )}
      </View>
      {stacked ? (
        <View style={styles.textColumn}>
          <Text style={labelStyle} numberOfLines={1}>
            {titleText}
          </Text>
          <Text style={styles.detailText} numberOfLines={1}>
            {normalizedDetail}
          </Text>
        </View>
      ) : (
        <Text style={[...labelStyle, styles.titleTextInline]} numberOfLines={1}>
          {hasDetail ? normalizedDetail : titleText}
        </Text>
      )}
    </Animated.View>
  );

  if (tone === 'error') {
    return (
      <View style={[styles.surface, styles.errorSurface]} testID="activity-error-surface">
        {content}
      </View>
    );
  }

  return (
    <GlassSurface role="chrome" style={styles.surface} testID="activity-glass-surface">
      {content}
    </GlassSurface>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    surface: {
      alignSelf: 'stretch',
      borderCurve: 'continuous',
      borderRadius: theme.radius.lg,
      marginHorizontal: theme.spacing.lg,
    },
    errorSurface: {
      backgroundColor: theme.colors.bgElevated,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.errorBorder,
      boxShadow: theme.isDark
        ? '0 8px 20px rgba(0, 0, 0, 0.28)'
        : '0 8px 18px rgba(15, 31, 54, 0.12)',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.xs,
    },
    rowStacked: {
      alignItems: 'flex-start',
    },
    iconWrap: {
      width: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // The atom is a 20pt square glyph, so the running row gets a wider slot than the icon rows.
    iconWrapRunning: {
      width: 20,
    },
    iconWrapStacked: {
      paddingTop: 2,
    },
    textColumn: {
      flex: 1,
      minWidth: 0,
    },
    titleText: {
      ...theme.typography.metadata,
      fontWeight: '600',
    },
    titleTextInline: {
      flex: 1,
    },
    titleTextError: {
      color: theme.colors.statusError,
    },
    detailText: {
      ...theme.typography.metadata,
      fontWeight: '500',
      opacity: 0.75,
    },
  });
