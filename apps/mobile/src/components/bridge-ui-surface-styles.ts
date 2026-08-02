import { StyleSheet } from 'react-native';

import type { AppTheme } from '../theme';

export const createBridgeUiSurfaceStyles = (theme: AppTheme) =>
  StyleSheet.create({
    surfaceCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.bgItem,
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    workflowCard: {
      boxShadow: '0px 4px 10px rgba(0, 0, 0, 0.16)',
    },
    bannerCard: {
      marginBottom: theme.spacing.sm,
    },
    modalScroll: {
      maxHeight: 420,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.sm,
    },
    headerCompact: {
      alignItems: 'center',
    },
    headerPressable: {
      borderRadius: theme.radius.sm,
    },
    headerIcon: {
      width: 22,
      height: 22,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgMain,
    },
    headerCopy: {
      flex: 1,
      gap: 2,
      minWidth: 0,
    },
    title: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    subtitle: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    dismissButton: {
      width: 26,
      height: 26,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgMain,
    },
    pressed: {
      opacity: 0.84,
    },
    surfaceBody: {
      gap: theme.spacing.sm,
      paddingBottom: theme.spacing.xs,
    },
    bodyText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      lineHeight: 18,
    },
    detailText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      lineHeight: 16,
    },
    emptyText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontStyle: 'italic',
    },
    checklist: {
      gap: theme.spacing.xs,
    },
    checklistRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.sm,
    },
    checklistGlyph: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      width: 16,
      marginTop: 1,
    },
    checklistCopy: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    keyValueGrid: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.radius.sm,
      overflow: 'hidden',
    },
    keyValueGridCompact: {
      marginTop: -theme.spacing.xs,
    },
    keyValueRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
    },
    keyLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      flex: 1,
    },
    keyValue: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      flex: 1,
      textAlign: 'right',
      fontWeight: '600',
    },
    codeBlock: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.inlineCodeBorder,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.inlineCodeBg,
      padding: theme.spacing.sm,
      gap: theme.spacing.xs,
    },
    codeLanguage: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0,
    },
    codeText: {
      ...theme.typography.mono,
      color: theme.colors.inlineCodeText,
      fontSize: 12,
      lineHeight: 17,
    },
    progressBlock: {
      gap: theme.spacing.xs,
    },
    progressHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    progressTrack: {
      height: 6,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.bgMain,
      overflow: 'hidden',
    },
    progressFill: {
      height: 6,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.accent,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: theme.spacing.sm,
      flexWrap: 'wrap',
    },
    actionsCompact: {
      justifyContent: 'flex-start',
    },
    actionButton: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.bgMain,
      borderRadius: theme.radius.sm,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      minHeight: theme.touchTarget.minimum,
      justifyContent: 'center',
    },
    actionButtonPrimary: {
      borderColor: theme.colors.borderHighlight,
      backgroundColor: theme.colors.accent,
    },
    actionButtonDestructive: {
      borderColor: theme.colors.error,
      backgroundColor: theme.colors.errorBg,
    },
    actionLabel: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    actionLabelPrimary: {
      color: theme.colors.accentText,
    },
    actionLabelDestructive: {
      color: theme.colors.error,
    },
  });
