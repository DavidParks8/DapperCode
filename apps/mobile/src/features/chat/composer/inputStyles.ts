import { Platform, StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';

export const createChatInputStyles = (theme: AppTheme) =>
  StyleSheet.create({
    shell: {
      overflow: 'hidden',
    },
    container: {
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.xs + 2,
    },
    composerBar: {
      flex: 1,
      minWidth: 0,
      borderRadius: theme.radius.full,
      borderCurve: 'continuous',
      borderWidth: StyleSheet.hairlineWidth,
      minHeight: 48,
      paddingHorizontal: theme.spacing.xs,
      paddingVertical: 5,
      gap: theme.spacing.xs,
    },
    composerBarMultiline: {
      borderRadius: theme.radius.lg,
    },
    composerGroup: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: theme.spacing.sm,
    },
    composerInputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    footer: {
      alignItems: 'flex-start',
      marginTop: 1,
    },
    footerPlaceholder: {
      minHeight: 16,
    },
    attachmentList: {
      maxHeight: 34,
      marginHorizontal: 4,
      marginTop: 2,
    },
    attachmentListContent: {
      gap: theme.spacing.xs,
      paddingRight: theme.spacing.sm,
    },
    attachmentChip: {
      height: 28,
      borderRadius: theme.radius.full,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      backgroundColor: theme.colors.bgElevated,
      paddingHorizontal: theme.spacing.sm,
      alignItems: 'center',
      flexDirection: 'row',
      gap: theme.spacing.xs,
      maxWidth: 260,
    },
    attachmentChipPressed: {
      backgroundColor: theme.colors.bgItem,
    },
    attachmentChipText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      flexShrink: 1,
    },
    addButton: {
      width: 36,
      height: 36,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addButtonPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    actionButtonFrame: {
      width: 48,
      height: 48,
      borderRadius: theme.radius.full,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionButtonPressed: {
      transform: [{ scale: 0.96 }],
    },
    inputWrapper: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: theme.spacing.xs,
      paddingRight: 1,
      paddingVertical: 3,
      minHeight: 38,
      maxHeight: 120,
    },
    input: {
      ...theme.typography.body,
      flex: 1,
      color: theme.colors.textPrimary,
      lineHeight: 20,
      paddingVertical: Platform.OS === 'ios' ? 2 : 0,
      textAlignVertical: 'top',
    },
    inputMeasure: {
      position: 'absolute',
      opacity: 0,
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      left: 2,
      top: theme.spacing.xs,
    },
    actionButtonGlass: {
      width: 48,
      height: 48,
      borderRadius: theme.radius.full,
      borderCurve: 'continuous',
      alignItems: 'center',
      justifyContent: 'center',
    },
    stopButtonContent: {
      width: 24,
      height: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
