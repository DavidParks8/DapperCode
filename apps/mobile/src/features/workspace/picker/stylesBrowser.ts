import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';
import { ENTRY_ROW_HEIGHT } from './helpers';

const ROW_ICON_SIZE = 24;
/** Separators start at the text column, matching UIKit's inset separators. */
const ROW_SEPARATOR_INSET = 16 + ROW_ICON_SIZE + 12;
const USE_BUTTON_HEIGHT = 50;
const STATUS_ROW_HEIGHT = 132;
const ROW_VALUE_MAX_WIDTH = 132;

export const createWorkspacePickerBrowserStyles = (theme: AppTheme) => ({
  list: { flex: 1 },
  listContent: { paddingBottom: theme.spacing.lg },

  groupedRow: {
    minHeight: ENTRY_ROW_HEIGHT,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: theme.spacing.lg,
    gap: theme.spacing.md,
    backgroundColor: theme.colors.bgItem,
  },
  groupedRowPressed: { backgroundColor: theme.colors.bgInput },
  groupedRowIcon: { width: ROW_ICON_SIZE, textAlign: 'center' as const },
  groupedRowCopy: { flex: 1, minWidth: 0 },
  groupedRowTitle: { ...theme.typography.headline, fontWeight: '400' as const },
  groupedRowSubtitle: { ...theme.typography.caption, color: theme.colors.textMuted },
  groupedRowValue: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    maxWidth: ROW_VALUE_MAX_WIDTH,
  },
  groupedRowSeparator: {
    position: 'absolute' as const,
    left: ROW_SEPARATOR_INSET,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderLight,
  },

  listFooter: {
    marginHorizontal: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  errorText: { ...theme.typography.caption, color: theme.colors.error },
  footerNote: { ...theme.typography.caption, color: theme.colors.textMuted },

  toolbar: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgMain,
  },
  toolbarPath: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    textAlign: 'center' as const,
  },
  useButton: {
    height: USE_BUTTON_HEIGHT,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.lg,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: theme.colors.accent,
  },
  useButtonPressed: { backgroundColor: theme.colors.accentPressed },
  useButtonText: {
    ...theme.typography.headline,
    color: theme.colors.accentText,
    fontWeight: '600' as const,
  },

  statusRow: {
    minHeight: STATUS_ROW_HEIGHT,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  statusText: {
    ...theme.typography.caption,
    textAlign: 'center' as const,
    color: theme.colors.textMuted,
  },
});
