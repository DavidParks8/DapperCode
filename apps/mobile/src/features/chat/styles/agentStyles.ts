import { StyleSheet, type TextStyle } from 'react-native';

import type { AppTheme } from '@shared/theme';

import { SESSION_META_CHIP_HEIGHT } from './sessionMetaChip';

export const createMainScreenAgentStyles = (theme: AppTheme) => {
  return {
    modelChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      minHeight: SESSION_META_CHIP_HEIGHT,
      paddingHorizontal: theme.spacing.sm,
      flexShrink: 0,
    },
    modeChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      minHeight: SESSION_META_CHIP_HEIGHT,
      paddingHorizontal: theme.spacing.sm,
      flexShrink: 0,
    },
    fastChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      minHeight: SESSION_META_CHIP_HEIGHT,
      paddingHorizontal: theme.spacing.sm,
      flexShrink: 0,
    },
    tokenUsageChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      minHeight: SESSION_META_CHIP_HEIGHT,
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
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    fastChipTextEnabled: { color: theme.colors.textPrimary },
    tokenSheetHeader: { gap: theme.spacing.xs },
    tokenSheetTitle: {
      ...theme.typography.title,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    tokenSheetSubtitle: { ...theme.typography.caption, color: theme.colors.textSecondary },
    tokenSheetGroup: {
      gap: theme.spacing.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.bgItem,
      padding: theme.spacing.md,
    },
    tokenSheetGroupHeader: { gap: 2 },
    tokenSheetGroupTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    tokenSheetGroupTitle: {
      ...theme.typography.label,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    tokenSheetGroupSubtitle: { ...theme.typography.metadata, color: theme.colors.textMuted },
    tokenSheetSubtotal: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      fontWeight: '700',
      fontVariant: ['tabular-nums'] as TextStyle['fontVariant'],
    },
    tokenSheetRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    tokenSheetRowLabel: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      flex: 1,
    },
    tokenSheetRowValue: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
      fontVariant: ['tabular-nums'] as TextStyle['fontVariant'],
    },
    tokenSheetFooter: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
      paddingHorizontal: theme.spacing.xs,
    },
    tokenSheetFooterLabel: { ...theme.typography.caption, color: theme.colors.textSecondary },
    tokenSheetFooterValue: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      fontVariant: ['tabular-nums'] as TextStyle['fontVariant'],
    },
    tokenSheetCost: { ...theme.typography.caption, color: theme.colors.textMuted },
  } as const;
};
