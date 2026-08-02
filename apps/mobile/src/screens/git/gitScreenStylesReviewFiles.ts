import { StyleSheet } from 'react-native';

import type { AppTheme } from '../../theme';

export function createGitScreenReviewFilesStyles(theme: AppTheme) {
  return StyleSheet.create({
    reviewCard: {
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      padding: theme.spacing.md,
      backgroundColor: theme.colors.bgItem,
      gap: theme.spacing.md,
    },
    reviewCardDirty: {
      borderColor: theme.colors.borderLight,
    },
    reviewHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    reviewIconWrap: {
      width: 34,
      height: 34,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgInput,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
    },
    reviewCopy: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    reviewTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    reviewDetail: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    reviewStatsRow: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    reviewStat: {
      flex: 1,
      minWidth: 0,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.bgInput,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 7,
      gap: 2,
    },
    reviewStatLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    reviewStatValue: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    reviewFiles: {
      gap: 6,
    },
    reviewActionRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    reviewFileRow: {
      minHeight: 26,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    reviewFileCode: {
      ...theme.typography.metadata,
      fontFamily: theme.typography.mono.fontFamily,
      width: 24,
      color: theme.colors.textMuted,
    },
    reviewFilePath: {
      ...theme.typography.caption,
      flex: 1,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    reviewFileStats: {
      ...theme.typography.metadata,
      fontFamily: theme.typography.mono.fontFamily,
      color: theme.colors.textMuted,
    },
    bulkActionBtn: {
      borderRadius: theme.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 7,
    },
    bulkActionBtnStage: {
      borderColor: theme.colors.successBorder,
      backgroundColor: theme.colors.successBg,
    },
    bulkActionBtnUnstage: {
      borderColor: theme.colors.errorBorder,
      backgroundColor: theme.colors.errorBg,
    },
    bulkActionText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    historyList: {
      gap: 0,
    },
    historyEntry: {
      paddingVertical: theme.spacing.sm,
      gap: theme.spacing.xs,
    },
    historyEntryBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
    },
    historyEntryHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: theme.spacing.sm,
    },
    historyEntrySubject: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '600',
      flex: 1,
    },
    historyEntryMeta: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    historyHashBadge: {
      paddingHorizontal: theme.spacing.xs,
      paddingVertical: 4,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.bgInput,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
    },
    historyHashBadgeText: {
      ...theme.typography.metadata,
      fontFamily: theme.typography.mono.fontFamily,
      color: theme.colors.textSecondary,
    },
    historyRefRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.xs,
    },
    historyRefChip: {
      paddingHorizontal: theme.spacing.xs,
      paddingVertical: 4,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.bgInput,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
    },
    historyRefChipHead: {
      borderColor: theme.colors.borderHighlight,
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    historyRefChipText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    filesCard: {
      backgroundColor: theme.colors.bgItem,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      overflow: 'hidden',
    },
    filesHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.sm,
      marginTop: theme.spacing.sm,
    },
    filesScroll: {
      minHeight: 56,
    },
    filesScrollContent: {
      paddingVertical: theme.spacing.xs,
    },
    fileRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.borderLight,
    },
    fileCode: {
      ...theme.typography.mono,
      color: theme.colors.textMuted,
      width: 24,
    },
    filePath: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      flex: 1,
      flexShrink: 1,
      lineHeight: 18,
    },
    filePathPressable: {
      flex: 1,
    },
    filePathInteractive: {
      color: theme.colors.textPrimary,
    },
    filePathDisabled: {
      opacity: 0.6,
    },
    fileStats: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      marginLeft: theme.spacing.sm,
    },
    fileActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      marginLeft: theme.spacing.sm,
    },
    fileActionBtn: {
      borderRadius: theme.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 6,
    },
    fileActionBtnStage: {
      borderColor: theme.colors.successBorder,
      backgroundColor: theme.colors.successBg,
    },
    fileActionBtnUnstage: {
      borderColor: theme.colors.errorBorder,
      backgroundColor: theme.colors.errorBg,
    },
    fileActionBtnPressed: {
      opacity: 0.8,
    },
    fileActionBtnDisabled: {
      opacity: 0.55,
    },
    fileActionText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    fileAdded: {
      ...theme.typography.mono,
      color: theme.colors.statusComplete,
    },
    fileRemoved: {
      ...theme.typography.mono,
      color: theme.colors.statusError,
    },
    emptyFilesText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    errorText: {
      ...theme.typography.caption,
      color: theme.colors.error,
      marginTop: theme.spacing.xs,
    },
  });
}
