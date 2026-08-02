import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';

export const createMainScreenAgentStyles = (theme: AppTheme) => {
  return {
    modelChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      borderRadius: theme.radius.full,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
      minHeight: 28,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 5,
      flexShrink: 0,
    },
    modeChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      borderRadius: theme.radius.full,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
      minHeight: 28,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 5,
      flexShrink: 0,
    },
    fastChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      borderRadius: theme.radius.full,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
      minHeight: 28,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 5,
      flexShrink: 0,
    },
    fastChipEnabled: {
      borderColor: theme.colors.successBorder,
      backgroundColor: theme.colors.successBg,
    },
    modelChipPressed: { opacity: 0.86 },
    sessionMetaChipDisabled: { opacity: 0.5 },
    modelChipText: {
      ...theme.typography.metadata,
      color: theme.colors.textSecondary,
      fontWeight: '600',
    },
    fastChipTextEnabled: { color: theme.colors.textPrimary },
  } as const;
};
