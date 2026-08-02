import { StyleSheet } from 'react-native';
import type { AppTheme } from '../theme';

export function createDrawerContentWorkspaceRowStyles(theme: AppTheme) {
  return StyleSheet.create({
    laneHeader: {
      minHeight: theme.touchTarget.minimum,
      paddingHorizontal: theme.spacing.xs,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    laneHeaderPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    laneDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
    },
    laneDotAttention: {
      backgroundColor: theme.colors.warning,
    },
    laneDotWorking: {
      backgroundColor: theme.colors.statusRunning,
    },
    laneDotRecent: {
      backgroundColor: theme.colors.statusIdle,
    },
    laneTitle: {
      ...theme.typography.label,
      flex: 1,
      color: theme.colors.textSecondary,
      fontWeight: '700',
    },
    laneCount: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      fontVariant: ['tabular-nums'],
    },
    laneFooter: {
      height: theme.spacing.sm,
    },
    chatItemFrame: {
      marginHorizontal: theme.spacing.xs,
    },
    chatItem: {
      minHeight: 68,
      paddingVertical: 10,
      paddingHorizontal: theme.spacing.xs,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
    },
    chatItemLast: {
      marginBottom: 0,
    },
    chatItemSelected: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    chatItemPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    chatItemTextBlock: {
      flex: 1,
      minWidth: 0,
    },
    chatTitle: {
      ...theme.typography.subheadline,
      color: theme.colors.textSecondary,
    },
    chatTitleSelected: {
      color: theme.colors.textPrimary,
    },
    chatContext: {
      ...theme.typography.metadata,
      marginTop: 5,
      color: theme.colors.textMuted,
    },
    chatItemMeta: {
      maxWidth: 104,
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: 7,
      flexShrink: 0,
    },
    chatAge: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      fontVariant: ['tabular-nums'],
    },
    chatState: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 5,
    },
    chatStateDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      flexShrink: 0,
    },
    chatStateDotAttention: {
      backgroundColor: theme.colors.warning,
    },
    chatStateDotWorking: {
      backgroundColor: theme.colors.statusRunning,
    },
    chatStateDotRecent: {
      backgroundColor: theme.colors.statusIdle,
    },
    chatStateDotError: {
      backgroundColor: theme.colors.statusError,
    },
    chatStateText: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      flexShrink: 1,
      textAlign: 'right',
    },
    chatStateTextError: {
      color: theme.colors.textSecondary,
    },
  });
}
