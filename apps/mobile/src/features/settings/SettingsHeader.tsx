import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, withTiming } from 'react-native-reanimated';

import { motion, useAppTheme, type AppTheme } from '@shared/theme';

/**
 * Scroll distance after which the large title has passed under the bar and the inline title takes
 * over, matching iOS' large-title collapse.
 */
export const LARGE_TITLE_COLLAPSE_OFFSET = 20;

const COLLAPSE_TIMING = {
  duration: motion.duration.routine,
  easing: Easing.bezier(...motion.easing.standard),
};

interface SettingsHeaderProps {
  title: string;
  collapsed: boolean;
  onMenuPress?: (() => void) | undefined;
}

export function SettingsHeader({ title, collapsed, onMenuPress }: SettingsHeaderProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const titleStyle = useAnimatedStyle(() => ({
    opacity: withTiming(collapsed ? 1 : 0, COLLAPSE_TIMING),
  }));
  const separatorStyle = useAnimatedStyle(() => ({
    opacity: withTiming(collapsed ? 1 : 0, COLLAPSE_TIMING),
  }));

  return (
    <View style={styles.bar}>
      <View style={styles.barRow}>
        <View style={styles.barSide}>
          {onMenuPress ? (
            <Pressable
              accessibilityLabel="Open navigation drawer"
              accessibilityRole="button"
              onPress={onMenuPress}
              style={styles.barButton}
            >
              <Ionicons name="menu" size={24} color={theme.colors.textPrimary} />
            </Pressable>
          ) : null}
        </View>
        <Animated.Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          numberOfLines={1}
          style={[styles.barTitle, titleStyle]}
          testID="settings-inline-title"
        >
          {title}
        </Animated.Text>
        <View style={styles.barSide} />
      </View>
      <Animated.View
        style={[styles.barSeparator, separatorStyle]}
        testID="settings-bar-separator"
      />
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    bar: { backgroundColor: theme.colors.bgMain },
    barRow: {
      height: 44,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.xs,
    },
    barSide: { width: theme.touchTarget.minimum },
    barButton: {
      width: theme.touchTarget.minimum,
      height: theme.touchTarget.minimum,
      alignItems: 'center',
      justifyContent: 'center',
    },
    barTitle: {
      ...theme.typography.headline,
      flex: 1,
      textAlign: 'center',
    },
    barSeparator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.borderLight,
    },
  });
}
