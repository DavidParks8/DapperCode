import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';

/** Leading inset of a hairline separator in a text-only grouped row. */
export const ROW_SEPARATOR_INSET = 16;
/** Leading inset for rows that carry a 28pt leading icon, so the hairline meets the text. */
export const ICON_ROW_SEPARATOR_INSET = 56;

export function createSettingsListStyles(theme: AppTheme) {
  const { colors } = theme;
  return StyleSheet.create({
    group: {},
    groupTitle: {
      ...theme.typography.caption,
      color: colors.textMuted,
      fontWeight: '600',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      paddingHorizontal: theme.spacing.lg,
      marginBottom: 7,
    },
    groupFooter: {
      ...theme.typography.caption,
      color: colors.textMuted,
      paddingHorizontal: theme.spacing.lg,
      marginTop: 7,
    },
    card: {
      backgroundColor: colors.bgItem,
      borderRadius: theme.radius.md,
      overflow: 'hidden',
    },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.borderLight,
    },
    row: {
      minHeight: theme.touchTarget.minimum,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 11,
      backgroundColor: colors.bgItem,
    },
    rowPressed: { backgroundColor: colors.bgInput },
    rowLabel: { ...theme.typography.headline, fontWeight: '400', flexShrink: 1 },
    rowLabelAccent: { color: colors.accent },
    rowTrailing: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      flexShrink: 1,
    },
    rowValue: {
      ...theme.typography.body,
      color: colors.textMuted,
      textAlign: 'right',
      flexShrink: 1,
    },
    rowChevron: { opacity: 0.5 },
    note: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    noteText: { ...theme.typography.headline, fontWeight: '400', color: colors.textMuted },
    notice: {
      backgroundColor: colors.errorBg,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.errorBorder,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      gap: theme.spacing.xs,
    },
    noticeText: { ...theme.typography.caption, color: colors.error },
    noticeAction: {
      minHeight: theme.touchTarget.minimum,
      justifyContent: 'center',
    },
    noticeActionText: { ...theme.typography.headline, color: colors.accent, fontWeight: '600' },
  });
}
