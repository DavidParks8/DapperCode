import type { AppTheme } from '@shared/theme';

export const createMainScreenAgentStyles = (theme: AppTheme) => {
  return {
    modelChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      minHeight: 48,
      paddingHorizontal: theme.spacing.sm,
      flexShrink: 0,
    },
    modeChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      minHeight: 48,
      paddingHorizontal: theme.spacing.sm,
      flexShrink: 0,
    },
    fastChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      minHeight: 48,
      paddingHorizontal: theme.spacing.sm,
      flexShrink: 0,
    },
    fastChipEnabled: {},
    modelChipPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
      borderRadius: theme.radius.sm,
    },
    sessionMetaChipDisabled: { opacity: 0.5 },
    modelChipText: {
      ...theme.typography.metadata,
      color: theme.colors.textSecondary,
      fontWeight: '600',
    },
    fastChipTextEnabled: { color: theme.colors.userBubbleOnSurface },
  } as const;
};
