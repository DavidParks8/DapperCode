import { StyleSheet } from 'react-native';

import type { AppTheme } from '../../theme';

export const createWorkflowMarkdownStyles = (theme: AppTheme) => StyleSheet.create({
  body: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
  },
  paragraph: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
    marginTop: 0,
    marginBottom: theme.spacing.xs,
  },
  heading1: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
    fontSize: 18,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  heading2: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
    fontSize: 16,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  heading3: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs / 2,
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  heading4: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs / 2,
  },
  heading5: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs / 2,
  },
  heading6: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs / 2,
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
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  fence: {
    ...theme.typography.mono,
    backgroundColor: theme.colors.bgInput,
    color: theme.colors.textPrimary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.borderHighlight,
    paddingLeft: theme.spacing.sm,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  link: {
    color: theme.colors.accent,
    textDecorationLine: 'underline',
  },
});