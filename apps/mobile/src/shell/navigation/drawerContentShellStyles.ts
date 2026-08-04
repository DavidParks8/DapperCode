import { StyleSheet } from 'react-native';
import type { AppTheme } from '@shared/theme';

export function createDrawerContentShellStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
    },
    safeArea: {
      flex: 1,
    },
    mainContent: {
      flex: 1,
      minHeight: 0,
    },
    header: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
    },
    titleRow: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    titleCopy: {
      flex: 1,
      minWidth: 0,
    },
    title: {
      ...theme.typography.largeTitle,
      color: theme.colors.textPrimary,
      letterSpacing: -0.5,
    },
    subtitle: {
      ...theme.typography.metadata,
      marginTop: 3,
      color: theme.colors.textMuted,
    },
    headerIconButton: {
      width: theme.touchTarget.minimum,
      height: theme.touchTarget.minimum,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerIconButtonPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    statusSummary: {
      minHeight: 30,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },
    statusSummaryAttention: {
      ...theme.typography.metadata,
      color: theme.colors.textSecondary,
      fontWeight: '600',
    },
    statusSummaryText: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
    },
    statusSummarySeparator: {
      width: 3,
      height: 3,
      borderRadius: 2,
      backgroundColor: theme.colors.borderHighlight,
    },
    folderFilter: {
      minHeight: theme.touchTarget.minimum,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
    },
    folderFilterPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    folderFilterLabel: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
    },
    folderFilterValue: {
      ...theme.typography.label,
      flex: 1,
      minWidth: 0,
      color: theme.colors.accent,
      textAlign: 'right',
    },
    searchField: {
      minHeight: theme.touchTarget.minimum,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingHorizontal: theme.spacing.sm,
      marginBottom: theme.spacing.xs,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    searchInput: {
      ...theme.typography.body,
      flex: 1,
      minWidth: 0,
      paddingVertical: theme.spacing.xs,
      color: theme.colors.textPrimary,
    },
    searchClearButton: {
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: theme.radius.full,
    },
    searchClearButtonPressed: {
      backgroundColor: theme.colors.borderLight,
    },
    searchResultSummary: {
      ...theme.typography.metadata,
      marginBottom: theme.spacing.xs,
      color: theme.colors.textMuted,
    },
    footer: {
      minHeight: 56,
      paddingHorizontal: theme.spacing.md,
      paddingTop: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.borderLight,
    },
    connectionStatus: {
      minWidth: 0,
      minHeight: theme.touchTarget.minimum,
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingLeft: theme.spacing.xs,
      borderRadius: theme.radius.md,
    },
    connectionStatusPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    connectionDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    connectionDotConnected: {
      backgroundColor: theme.colors.success,
    },
    connectionDotDisconnected: {
      backgroundColor: theme.colors.warning,
    },
    connectionCopy: {
      minWidth: 0,
      flex: 1,
    },
    connectionTitle: {
      ...theme.typography.metadata,
      color: theme.colors.textSecondary,
      fontWeight: '600',
    },
    connectionMeta: {
      ...theme.typography.metadata,
      marginTop: 2,
      color: theme.colors.textMuted,
    },
    footerBrowserButton: {
      minWidth: 78,
      height: theme.touchTarget.minimum,
      paddingHorizontal: 7,
      borderRadius: theme.radius.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
    },
    footerBrowserText: {
      ...theme.typography.metadata,
      color: theme.colors.accent,
      fontWeight: '600',
    },
    footerIconButton: {
      width: theme.touchTarget.minimum,
      height: theme.touchTarget.minimum,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    footerActionPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
  });
}
