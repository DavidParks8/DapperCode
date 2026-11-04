import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';
import type { ChangeTone } from '../screen/utils';

/** Styles for host-extension affordances: sync, discard, branch creation, and repository setup. */
export function createGitScreenHostStyles(theme: AppTheme) {
  return StyleSheet.create({
    changeBadge: {
      borderRadius: theme.radius.sm,
      paddingHorizontal: 6,
      paddingVertical: 1,
      minWidth: 64,
      alignItems: 'center',
    },
    changeBadgeText: {
      ...theme.typography.metadata,
      fontWeight: '600',
    },
    syncRow: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    syncButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
      minHeight: theme.touchTarget.minimum,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
    },
    syncButtonText: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    reasonText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    noticeText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    branchCreateRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    branchCreateInput: {
      ...theme.typography.body,
      flex: 1,
      minHeight: theme.touchTarget.minimum,
      backgroundColor: theme.colors.bgInput,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      color: theme.colors.textPrimary,
    },
    branchCreateButton: {
      minHeight: theme.touchTarget.minimum,
      justifyContent: 'center',
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      backgroundColor: theme.colors.accent,
    },
    branchCreateButtonText: {
      ...theme.typography.body,
      color: theme.colors.accentText,
      fontWeight: '600',
    },
    holdButton: {
      borderRadius: theme.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.errorBorder,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 7,
      overflow: 'hidden',
    },
    holdButtonFill: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: theme.colors.errorBg,
    },
    holdButtonText: {
      ...theme.typography.caption,
      color: theme.colors.error,
      fontWeight: '600',
    },
    setupCard: {
      alignItems: 'stretch',
    },
    setupTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    setupBody: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
    },
    commitInput: {
      minHeight: 88,
      maxHeight: 200,
      textAlignVertical: 'top',
    },
    workspaceValue: {
      ...theme.typography.body,
      flex: 1,
      color: theme.colors.textPrimary,
    },
    workspaceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    workspaceFilesButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      minHeight: theme.touchTarget.minimum,
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.radius.full,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
    },
  });
}

export function changeToneColors(
  theme: AppTheme,
  tone: ChangeTone,
): { backgroundColor: string; color: string } {
  switch (tone) {
    case 'added':
      return { backgroundColor: theme.colors.successBg, color: theme.colors.success };
    case 'deleted':
    case 'conflict':
      return { backgroundColor: theme.colors.errorBg, color: theme.colors.error };
    case 'renamed':
      return { backgroundColor: theme.colors.warningBg, color: theme.colors.warning };
    default:
      return { backgroundColor: theme.colors.bgInput, color: theme.colors.textSecondary };
  }
}
