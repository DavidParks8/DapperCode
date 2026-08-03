import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';

export const createMarkdownStyles = (theme: AppTheme) =>
  StyleSheet.create({
    body: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
    },
    heading1: {
      ...theme.typography.headline,
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.xs,
      flexDirection: 'row',
      flexWrap: 'wrap',
    },
    heading2: {
      ...theme.typography.body,
      fontWeight: '600',
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.xs,
      flexDirection: 'row',
      flexWrap: 'wrap',
    },
    heading3: {
      ...theme.typography.subheadline,
      color: theme.colors.textPrimary,
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.xs,
      flexDirection: 'row',
      flexWrap: 'wrap',
    },
    heading4: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.xs,
      flexDirection: 'row',
      flexWrap: 'wrap',
    },
    heading5: {
      ...theme.typography.label,
      color: theme.colors.textPrimary,
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.xs,
      flexDirection: 'row',
      flexWrap: 'wrap',
    },
    heading6: {
      ...theme.typography.metadata,
      color: theme.colors.textSecondary,
      fontWeight: '600',
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.xs,
      flexDirection: 'row',
      flexWrap: 'wrap',
    },
    code_inline: {
      ...theme.typography.mono,
      color: theme.colors.inlineCodeText,
      backgroundColor: theme.colors.inlineCodeBg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.inlineCodeBorder,
      borderRadius: 4,
      paddingHorizontal: 5,
      paddingVertical: 2,
    },
    code_block: {
      ...theme.typography.mono,
      backgroundColor: theme.colors.bgInput,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      borderRadius: theme.radius.sm,
      padding: theme.spacing.md,
      marginVertical: theme.spacing.sm,
    },
    fence: {
      ...theme.typography.mono,
      backgroundColor: theme.colors.bgInput,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      borderRadius: theme.radius.sm,
      padding: theme.spacing.md,
      marginVertical: theme.spacing.sm,
    },
    // The library defaults paint a near-white blockquote and a black rule, so every property it
    // sets has to be restated here or it survives the shallow per-key style merge.
    blockquote: {
      backgroundColor: 'transparent',
      borderColor: theme.colors.borderHighlight,
      borderLeftColor: theme.colors.borderHighlight,
      borderLeftWidth: 3,
      marginLeft: 0,
      marginVertical: theme.spacing.xs,
      paddingHorizontal: 0,
      paddingLeft: theme.spacing.sm,
    },
    hr: {
      backgroundColor: theme.colors.borderLight,
      height: StyleSheet.hairlineWidth,
      marginVertical: theme.spacing.sm,
    },
    link: {
      color: theme.colors.accent,
      textDecorationLine: 'underline',
    },
    paragraph: {
      marginTop: theme.spacing.xs,
      marginBottom: theme.spacing.xs,
    },
    bullet_list: {
      marginVertical: theme.spacing.xs,
    },
    ordered_list: {
      marginVertical: theme.spacing.xs,
    },
    list_item: {
      marginVertical: 2,
    },
    table_scroll: {
      maxWidth: '100%',
      marginVertical: theme.spacing.sm,
    },
    table_scroll_content: {
      paddingBottom: theme.spacing.xs,
    },
    table: {
      minWidth: 560,
      alignSelf: 'flex-start',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      borderRadius: theme.radius.sm,
      overflow: 'hidden',
      backgroundColor: theme.colors.bgElevated,
    },
    thead: {
      backgroundColor: theme.colors.bgItem,
    },
    tbody: {
      backgroundColor: theme.colors.bgElevated,
    },
    tr: {
      flexDirection: 'row',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
    },
    th: {
      flex: 0,
      width: 176,
      minWidth: 176,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
    td: {
      flex: 0,
      width: 176,
      minWidth: 176,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
    strong: {
      fontWeight: '700',
      color: theme.colors.textPrimary,
    },
    em: {
      fontStyle: 'italic',
    },
  });

export const createReasoningMarkdownStyles = (theme: AppTheme) =>
  StyleSheet.create({
    body: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      lineHeight: 17,
    },
    paragraph: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      lineHeight: 17,
      marginTop: 0,
      marginBottom: theme.spacing.xs,
    },
    heading1: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      marginTop: theme.spacing.xs,
      marginBottom: theme.spacing.xs,
    },
    heading2: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      marginTop: theme.spacing.xs,
      marginBottom: theme.spacing.xs,
    },
    heading3: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      marginTop: theme.spacing.xs,
      marginBottom: theme.spacing.xs,
    },
    heading4: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      marginTop: theme.spacing.xs,
      marginBottom: theme.spacing.xs,
    },
    heading5: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      marginTop: theme.spacing.xs,
      marginBottom: theme.spacing.xs,
    },
    heading6: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      marginTop: theme.spacing.xs,
      marginBottom: theme.spacing.xs,
    },
    bullet_list: {
      marginTop: 0,
      marginBottom: theme.spacing.xs,
    },
    ordered_list: {
      marginTop: 0,
      marginBottom: theme.spacing.xs,
    },
    list_item: {
      marginTop: 0,
      marginBottom: theme.spacing.xs / 2,
    },
    strong: {
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    em: {
      color: theme.colors.textSecondary,
      fontStyle: 'italic',
    },
    code_inline: {
      ...theme.typography.mono,
      backgroundColor: theme.colors.inlineCodeBg,
      color: theme.colors.inlineCodeText,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.inlineCodeBorder,
      borderRadius: theme.radius.sm,
      paddingHorizontal: 5,
      paddingVertical: 2,
    },
    code_block: {
      ...theme.typography.mono,
      backgroundColor: theme.colors.bgInput,
      color: theme.colors.textPrimary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      borderRadius: theme.radius.sm,
      padding: theme.spacing.md,
      marginVertical: theme.spacing.xs,
    },
    fence: {
      ...theme.typography.mono,
      backgroundColor: theme.colors.bgInput,
      color: theme.colors.textPrimary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      borderRadius: theme.radius.sm,
      padding: theme.spacing.md,
      marginVertical: theme.spacing.xs,
    },
    // The library defaults paint a near-white blockquote and a black rule, so every property it
    // sets has to be restated here or it survives the shallow per-key style merge.
    blockquote: {
      backgroundColor: 'transparent',
      borderColor: theme.colors.borderHighlight,
      borderLeftColor: theme.colors.borderHighlight,
      borderLeftWidth: 2,
      marginLeft: 0,
      marginVertical: theme.spacing.xs,
      paddingHorizontal: 0,
      paddingLeft: theme.spacing.sm,
    },
    hr: {
      backgroundColor: theme.colors.borderLight,
      height: StyleSheet.hairlineWidth,
      marginVertical: theme.spacing.xs,
    },
    link: {
      color: theme.colors.accent,
      textDecorationLine: 'underline',
    },
    table_scroll: {
      maxWidth: '100%',
      marginVertical: theme.spacing.xs,
    },
    table_scroll_content: {
      paddingBottom: theme.spacing.xs,
    },
    table: {
      minWidth: 560,
      alignSelf: 'flex-start',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      borderRadius: theme.radius.sm,
      overflow: 'hidden',
      backgroundColor: theme.colors.bgElevated,
    },
    thead: {
      backgroundColor: theme.colors.bgItem,
    },
    tbody: {
      backgroundColor: theme.colors.bgElevated,
    },
    tr: {
      flexDirection: 'row',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
    },
    th: {
      flex: 0,
      width: 176,
      minWidth: 176,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
    td: {
      flex: 0,
      width: 176,
      minWidth: 176,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
  });
