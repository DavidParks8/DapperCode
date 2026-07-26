import { StyleSheet } from 'react-native';
import type { AppTheme } from '../theme';

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
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontSize: 14,
      lineHeight: 18,
      fontWeight: '600',
      textAlign: 'center',
    },
    emptyHint: {
      ...theme.typography.caption,
      maxWidth: 250,
      color: theme.colors.textMuted,
      fontSize: 11,
      lineHeight: 15,
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
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      fontSize: 11.5,
      lineHeight: 15,
      fontWeight: '600',
    },
    noticeMessage: {
      ...theme.typography.caption,
      marginTop: 2,
      color: theme.colors.textMuted,
      fontSize: 9.5,
      lineHeight: 13,
    },
    noticeAction: {
      ...theme.typography.caption,
      color: theme.colors.accent,
      fontSize: 10.5,
      lineHeight: 14,
      fontWeight: '600',
    },
  });
}
