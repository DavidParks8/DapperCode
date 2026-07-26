import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '../../accessibility';
import type { GitSectionCommonProps } from './gitScreenSectionTypes';

interface GitScreenHeaderSectionProps extends GitSectionCommonProps {
  onBack: () => void;
}

export function GitScreenHeaderSection({
  controller,
  styles,
  theme,
  onBack,
}: GitScreenHeaderSectionProps) {
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onBack}
        hitSlop={8}
        style={styles.backBtn}
        accessibilityRole="button"
        accessibilityLabel="Back to chat"
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name="chevron-back"
          size={22}
          color={theme.colors.textPrimary}
        />
      </Pressable>
      <View style={styles.headerTitles}>
        <Text style={styles.headerTitle}>Git</Text>
        <Text style={styles.headerSubtitle} numberOfLines={1}>
          {controller.activeChat.title || 'Untitled chat'}
        </Text>
      </View>
      <Pressable
        onPress={() => void controller.refresh()}
        hitSlop={8}
        style={({ pressed }) => [
          styles.refreshBtn,
          pressed && styles.refreshBtnPressed,
          controller.loading && styles.refreshBtnDisabled,
        ]}
        disabled={controller.loading}
        accessibilityRole="button"
        accessibilityLabel="Refresh Git status"
        accessibilityState={controlAccessibilityState({
          disabled: controller.loading,
          busy: controller.loading,
        })}
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name="refresh"
          size={16}
          color={theme.colors.textMuted}
        />
      </Pressable>
    </View>
  );
}
