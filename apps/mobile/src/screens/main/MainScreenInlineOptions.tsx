import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { controlAccessibilityState, decorativeAccessibilityProps } from '../../accessibility';
import type { SelectionSheetOption } from '../../components/SelectionSheet';
import { useAppTheme } from '../../theme';
import { createStyles } from './mainScreenStyles';

export function InlineOptionsGroup({
  title,
  options,
  loading = false,
  loadingLabel = 'Loading options...',
  onClose,
}: {
  title: string;
  options: SelectionSheetOption[];
  loading?: boolean;
  loadingLabel?: string;
  onClose: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.inlineOptionsGroup} accessibilityRole="menu" accessibilityLabel={title}>
      <View style={styles.inlineOptionsHeader}>
        <Text style={styles.inlineOptionsTitle}>{title}</Text>
        <Pressable
          onPress={onClose}
          style={styles.inlineOptionsClose}
          accessibilityRole="button"
          accessibilityLabel={`Close ${title}`}
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="close"
            size={16}
            color={theme.colors.textMuted}
          />
        </Pressable>
      </View>
      {loading ? (
        <View style={styles.inlineOptionsLoading} accessibilityRole="progressbar">
          <ActivityIndicator size="small" color={theme.colors.textPrimary} />
          <Text style={styles.inlineOptionsDescription}>{loadingLabel}</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.inlineOptionsScroll}
          contentContainerStyle={styles.inlineOptionsContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {options.map((option) => (
            <Pressable
              key={option.key}
              onPress={option.onPress}
              disabled={option.disabled}
              style={({ pressed }) => [
                styles.inlineOption,
                option.selected && styles.inlineOptionSelected,
                option.disabled && styles.inlineOptionDisabled,
                pressed && !option.disabled && styles.inlineOptionPressed,
              ]}
              accessibilityRole="menuitem"
              accessibilityLabel={option.title}
              accessibilityHint={option.description}
              accessibilityState={controlAccessibilityState({
                disabled: option.disabled,
                selected: option.selected,
              })}
            >
              {option.icon ? (
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name={option.icon}
                  size={15}
                  color={option.selected ? theme.colors.textPrimary : theme.colors.textMuted}
                />
              ) : null}
              <View style={styles.inlineOptionCopy}>
                <Text style={styles.inlineOptionTitle}>{option.title}</Text>
                {option.description ? (
                  <Text style={styles.inlineOptionsDescription}>{option.description}</Text>
                ) : null}
              </View>
              {option.selected ? (
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name="checkmark"
                  size={16}
                  color={theme.colors.textPrimary}
                />
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
