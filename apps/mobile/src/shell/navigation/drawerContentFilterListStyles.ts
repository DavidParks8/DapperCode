import { StyleSheet } from 'react-native';
import type { AppTheme } from '@shared/theme';

export function createDrawerContentFilterListStyles(theme: AppTheme) {
  return StyleSheet.create({
    list: {
      flex: 1,
    },
    listContent: {
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.xs,
      paddingBottom: theme.spacing.lg,
    },
    emptyListContent: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.xs,
      paddingBottom: theme.spacing.lg,
    },
    loader: {
      marginBottom: theme.spacing.xs,
    },
    loadingMoreFooter: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.lg,
    },
    emptyState: {
      flex: 1,
      paddingHorizontal: theme.spacing.xl,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
    },
    emptyTitle: {
      ...theme.typography.subheadline,
      color: theme.colors.textPrimary,
      textAlign: 'center',
    },
    emptyHint: {
      ...theme.typography.metadata,
      maxWidth: 250,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    notice: {
      minHeight: 58,
      marginBottom: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.xs,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
    },
    noticePressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    noticeCopy: {
      flex: 1,
      minWidth: 0,
    },
    noticeTitle: {
      ...theme.typography.metadata,
      color: theme.colors.textSecondary,
      fontWeight: '600',
    },
    noticeMessage: {
      ...theme.typography.metadata,
      marginTop: 2,
      color: theme.colors.textMuted,
    },
    noticeAction: {
      ...theme.typography.metadata,
      color: theme.colors.accent,
      fontWeight: '600',
    },
  });
}
