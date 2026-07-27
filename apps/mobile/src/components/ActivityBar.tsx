import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { LoadingGlyph } from './LoadingGlyph';
import { useAppTheme, type AppTheme } from '../theme';

export type ActivityTone = 'running' | 'complete' | 'error' | 'idle';

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
 * A single quiet caption line, not a card: the agent's status sits directly on the
 * chat background above the composer so it reads as chrome-free supporting text.
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
  const labelStyle = [styles.titleText, tone === 'error' ? styles.titleTextError : null];

  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      style={[styles.row, stacked ? styles.rowStacked : null]}
    >
      <View style={[styles.iconWrap, stacked ? styles.iconWrapStacked : null]}>
        {tone === 'running' ? (
          <LoadingGlyph color={color} variant="bars" size="small" />
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
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 2,
    },
    rowStacked: {
      alignItems: 'flex-start',
    },
    iconWrap: {
      width: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconWrapStacked: {
      paddingTop: 2,
    },
    textColumn: {
      flex: 1,
      minWidth: 0,
    },
    titleText: {
      ...theme.typography.caption,
      fontSize: 11,
      lineHeight: 15,
      fontWeight: '600',
      color: theme.colors.textMuted,
    },
    titleTextInline: {
      flex: 1,
    },
    titleTextError: {
      color: theme.colors.statusError,
    },
    detailText: {
      ...theme.typography.caption,
      fontSize: 11,
      lineHeight: 14,
      fontWeight: '500',
      color: theme.colors.textMuted,
      opacity: 0.75,
    },
  });
