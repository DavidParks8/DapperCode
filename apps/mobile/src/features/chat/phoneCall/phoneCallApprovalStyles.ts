import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';

export const createPhoneCallApprovalStyles = (theme: AppTheme) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.md,
      marginBottom: theme.spacing.md,
    },
    iconWrap: {
      width: 40,
      height: 40,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.warningBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerCopy: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    eyebrow: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
    },
    calleeTitle: {
      ...theme.typography.headline,
      fontSize: 18,
      lineHeight: 22,
      color: theme.colors.textPrimary,
    },
    calleeNumber: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      fontVariant: ['tabular-nums'],
    },
    bodyScroll: {
      maxHeight: 380,
    },
    bodyContent: {
      gap: theme.spacing.sm + 2,
      paddingBottom: theme.spacing.sm,
    },
    planCard: {
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    planHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.sm,
      minHeight: theme.touchTarget.minimum,
    },
    planHeading: {
      ...theme.typography.label,
      fontSize: 13,
      color: theme.colors.textPrimary,
    },
    planHeaderActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      minHeight: theme.touchTarget.minimum,
    },
    inlineButton: {
      paddingHorizontal: theme.spacing.xs,
      paddingVertical: 4,
      minHeight: 32,
      justifyContent: 'center',
    },
    inlineButtonLabel: {
      ...theme.typography.caption,
      color: theme.colors.accent,
      fontWeight: '700',
    },
    inlineButtonMuted: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontWeight: '600',
    },
    readFields: {
      gap: theme.spacing.sm + 2,
    },
    editFields: {
      gap: theme.spacing.sm + 2,
    },
    fieldGroup: {
      gap: 4,
    },
    fieldLabel: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
    },
    fieldValue: {
      ...theme.typography.body,
      fontSize: 14,
      lineHeight: 20,
      color: theme.colors.textPrimary,
    },
    textInput: {
      ...theme.typography.body,
      fontSize: 14,
      lineHeight: 20,
      color: theme.colors.textPrimary,
      backgroundColor: theme.colors.bgInput,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.radius.sm,
      paddingHorizontal: theme.spacing.sm + 2,
      paddingVertical: theme.spacing.sm,
      minHeight: 44,
    },
    footerMeta: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      textAlign: 'center',
      paddingHorizontal: theme.spacing.sm,
    },
    errorText: {
      ...theme.typography.caption,
      color: theme.colors.error,
      textAlign: 'center',
      marginTop: theme.spacing.xs,
    },
    actionsRow: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
      marginTop: theme.spacing.md,
    },
    button: {
      flex: 1,
      minHeight: Math.max(46, theme.touchTarget.minimum),
      borderRadius: theme.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
    },
    cancelButton: {
      backgroundColor: theme.colors.errorBg,
      borderColor: theme.colors.error,
    },
    cancelLabel: {
      ...theme.typography.label,
      color: theme.colors.error,
      fontWeight: '700',
    },
    approveButton: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.borderHighlight,
    },
    approveLabel: {
      ...theme.typography.label,
      color: theme.colors.accentText,
      fontWeight: '700',
    },
    pressed: {
      opacity: 0.78,
    },
  });
