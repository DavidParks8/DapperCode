import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import type { AppTheme } from '@shared/theme';
import type { WorkspacePickerStyles } from './styles';

export function WorkspacePickerFooter({
  styles,
  theme,
  footerPath,
  footerTitle,
  footerSubtitle,
  footerIsFavorite,
  onToggleFavorite,
  onSelectPath,
}: {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  footerPath: string | null;
  footerTitle: string;
  footerSubtitle: string;
  footerIsFavorite: boolean;
  onToggleFavorite?: (path: string | null) => void;
  onSelectPath: (path: string | null) => void;
}) {
  return (
    <View style={styles.footer}>
      <View style={styles.selectionSummary}>
        <Text style={styles.selectionLabel}>Workspace</Text>
        <Text style={styles.selectionTitle} numberOfLines={1} ellipsizeMode="tail">
          {footerTitle}
        </Text>
        <Text style={styles.selectionPath} numberOfLines={2} ellipsizeMode="middle">
          {footerSubtitle}
        </Text>
      </View>
      <Pressable
        onPress={() => footerPath && onToggleFavorite?.(footerPath)}
        disabled={!footerPath || !onToggleFavorite}
        style={({ pressed }) => [
          styles.footerFavoriteButton,
          footerIsFavorite && styles.footerFavoriteButtonActive,
          (!footerPath || !onToggleFavorite) && styles.buttonDisabled,
          pressed && footerPath && onToggleFavorite && styles.footerFavoriteButtonPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={footerIsFavorite ? `Unpin ${footerTitle}` : `Pin ${footerTitle}`}
        accessibilityState={controlAccessibilityState({
          disabled: !footerPath || !onToggleFavorite,
          selected: footerIsFavorite,
        })}
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name={footerIsFavorite ? 'star' : 'star-outline'}
          size={17}
          color={footerIsFavorite ? theme.colors.textPrimary : theme.colors.textSecondary}
        />
      </Pressable>
      <Pressable
        onPress={() => footerPath && onSelectPath(footerPath)}
        disabled={!footerPath}
        style={({ pressed }) => [
          styles.footerUseButton,
          !footerPath && styles.buttonDisabled,
          pressed && Boolean(footerPath) && styles.footerUseButtonPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Use ${footerTitle} workspace`}
        accessibilityState={controlAccessibilityState({ disabled: !footerPath })}
      >
        <Text style={styles.footerUseButtonText}>Use</Text>
      </Pressable>
    </View>
  );
}
