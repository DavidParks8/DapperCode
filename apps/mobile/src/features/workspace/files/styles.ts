import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';

export function createWorkspaceFilesStyles(theme: AppTheme) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    screenBody: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      minHeight: 52,
    },
    headerButton: {
      minWidth: theme.touchTarget.minimum,
      minHeight: theme.touchTarget.minimum,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTitles: {
      flex: 1,
      minWidth: 0,
    },
    headerTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    headerSubtitle: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    headerTextButton: {
      ...theme.typography.headline,
      color: theme.colors.accent,
    },
    headerTextButtonDisabled: {
      color: theme.colors.textMuted,
    },
    banner: {
      marginHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      padding: theme.spacing.md,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
      gap: theme.spacing.sm,
    },
    bannerWarning: {
      borderColor: theme.colors.warningBorder,
      backgroundColor: theme.colors.warningBg,
    },
    bannerText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    bannerActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    bannerButton: {
      minHeight: 36,
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.radius.full,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
    },
    bannerButtonPrimary: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    bannerButtonText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    bannerButtonTextPrimary: {
      color: theme.colors.accentText,
    },
    editor: {
      ...theme.typography.mono,
      flex: 1,
      marginHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      padding: theme.spacing.md,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
      color: theme.colors.textPrimary,
      textAlignVertical: 'top',
    },
    dirtyDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.colors.warning,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    editorToolbar: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.sm,
    },
    errorText: {
      ...theme.typography.caption,
      color: theme.colors.error,
      marginHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
    },
    noticeText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      marginHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: theme.spacing.xl,
      gap: theme.spacing.sm,
    },
    centeredTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      textAlign: 'center',
    },
    centeredBody: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
  });
}

export type WorkspaceFilesStyles = ReturnType<typeof createWorkspaceFilesStyles>;
