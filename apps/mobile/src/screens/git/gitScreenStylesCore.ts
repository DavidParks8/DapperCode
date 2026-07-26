import { StyleSheet } from 'react-native';

import type { AppTheme } from '../../theme';

export function createGitScreenCoreStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
    },
    backBtn: {
      padding: theme.spacing.xs,
    },
    headerTitles: {
      flex: 1,
    },
    headerTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    headerSubtitle: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    refreshBtn: {
      padding: theme.spacing.xs,
      borderRadius: theme.radius.full,
    },
    refreshBtnPressed: {
      backgroundColor: theme.colors.bgItem,
    },
    refreshBtnDisabled: {
      opacity: 0.4,
    },
    body: {
      flex: 1,
    },
    bodyContent: {
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
    },
    loader: {
      marginTop: theme.spacing.lg,
    },
    card: {
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      padding: theme.spacing.md,
      backgroundColor: theme.colors.bgItem,
      gap: theme.spacing.sm,
    },
    workspaceCard: {
      gap: theme.spacing.xs,
    },
    branchHeaderRow: {
      gap: theme.spacing.sm,
    },
    branchActionsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.sm,
    },
    branchBadge: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 7,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.bgInput,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
    },
    branchBadgeText: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      flex: 1,
      lineHeight: 21,
    },
    branchSwitchToggle: {
      minHeight: 34,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      borderRadius: theme.radius.full,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 7,
    },
    branchSwitchToggleActive: {
      borderColor: theme.colors.borderHighlight,
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    branchSwitchTogglePressed: {
      opacity: 0.82,
    },
    branchSwitchToggleText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    branchSwitchPanel: {
      gap: theme.spacing.sm,
    },
    branchPanelHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.sm,
    },
    branchPanelTitle: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0,
    },
    branchPanelSelected: {
      ...theme.typography.caption,
      flex: 1,
      minWidth: 0,
      textAlign: 'right',
      color: theme.colors.textSecondary,
    },
    branchSwitchButton: {
      minHeight: 46,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.accent,
      paddingHorizontal: theme.spacing.md,
    },
    branchSwitchButtonText: {
      ...theme.typography.headline,
      color: theme.colors.accentText,
      fontSize: 14,
    },
    branchList: {
      maxHeight: 260,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
    },
    branchListContent: {
      paddingVertical: theme.spacing.xs,
    },
    branchRow: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.borderLight,
    },
    branchRowSelected: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    branchRowPressed: {
      opacity: 0.8,
    },
    branchRowTextBlock: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    branchRowName: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    branchRowMeta: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    repoStateBadge: {
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 7,
      borderRadius: theme.radius.full,
    },
    repoStateBadgeClean: {
      backgroundColor: theme.colors.successBg,
    },
    repoStateBadgeDirty: {
      backgroundColor: theme.colors.errorBg,
    },
    repoStateBadgeText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      letterSpacing: 0,
      textTransform: 'uppercase',
    },
    statsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    statTile: {
      flexBasis: '48%',
      flexGrow: 0,
      backgroundColor: theme.colors.bgInput,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      gap: 2,
    },
    statTileLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0,
    },
    statTileValue: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      fontSize: 16,
    },
    sectionLabel: {
      ...theme.typography.caption,
      textTransform: 'uppercase',
      letterSpacing: 0,
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.xs,
    },
    sectionLabelResetMargin: {
      marginTop: 0,
      marginBottom: 0,
    },
    input: {
      backgroundColor: theme.colors.bgInput,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      color: theme.colors.textPrimary,
      fontSize: 15,
    },
    workspaceInput: {
      minHeight: 44,
      paddingTop: 7,
      paddingBottom: 7,
      fontSize: 14,
      lineHeight: 20,
      includeFontPadding: false,
    },
    actionBtn: {
      backgroundColor: theme.colors.accent,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      alignItems: 'center',
      marginTop: theme.spacing.sm,
    },
    actionBtnPressed: {
      backgroundColor: theme.colors.accentPressed,
    },
    actionBtnDisabled: {
      backgroundColor: theme.colors.bgInput,
      opacity: 0.6,
    },
    pushBtn: {
      marginTop: theme.spacing.xs,
    },
    actionBtnText: {
      ...theme.typography.headline,
      color: theme.colors.accentText,
      fontSize: 15,
    },
    actionBtnTextDisabled: {
      color: theme.colors.textMuted,
    },
    metaText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    warningText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    infoRow: {
      gap: 4,
      paddingVertical: theme.spacing.sm,
    },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.borderLight,
    },
    infoLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0,
    },
    infoValue: {
      ...theme.typography.body,
      fontWeight: '600',
      color: theme.colors.textPrimary,
      lineHeight: 22,
    },
    latestCommitBlock: {
      gap: 4,
    },
    latestCommitHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.sm,
    },
    latestCommitLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0,
    },
    latestCommitHash: {
      ...theme.typography.mono,
      color: theme.colors.textMuted,
      fontSize: 12,
    },
    latestCommitSubject: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    latestCommitMeta: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
  });
}
