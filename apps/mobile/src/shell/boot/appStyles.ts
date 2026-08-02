import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';

export function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    loadingRoot: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgMain,
    },
    persistenceRecoveryRoot: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.md,
      padding: theme.spacing.xl,
      backgroundColor: theme.colors.bgMain,
    },
    persistenceRecoveryTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      textAlign: 'center',
    },
    persistenceRecoveryMessage: {
      ...theme.typography.body,
      maxWidth: 440,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
    persistenceRecoveryButton: {
      minWidth: 120,
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.accent,
    },
    persistenceRecoveryButtonPressed: {
      backgroundColor: theme.colors.accentPressed,
    },
    persistenceRecoveryButtonText: {
      ...theme.typography.body,
      color: theme.colors.accentText,
      fontWeight: '700',
    },
  });
}

export type AppStyles = ReturnType<typeof createStyles>;
