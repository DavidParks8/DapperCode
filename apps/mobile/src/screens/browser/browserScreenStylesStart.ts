import type { ViewStyle, TextStyle } from 'react-native';

import type { AppTheme } from '../../theme';

type BrowserScreenStyleRecord = Record<string, ViewStyle | TextStyle>;

export function createBrowserScreenStartStyles(theme: AppTheme): BrowserScreenStyleRecord {
  return {
    startPage: {
      flex: 1,
    },
    startPageContent: {
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.xxl,
      paddingBottom: theme.spacing.xxl,
      gap: theme.spacing.xl,
    },
    startHero: {
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.lg,
    },
    startHeroIcon: {
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
    },
    startHeroTitle: {
      ...theme.typography.largeTitle,
      color: theme.colors.textPrimary,
      fontSize: 22,
    },
    startHeroSubtitle: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      maxWidth: 280,
    },
    quickSection: {
      gap: theme.spacing.md,
    },
    sectionHeader: {
      gap: 2,
      paddingHorizontal: theme.spacing.xs,
    },
    sectionTitle: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0,
    },
    sectionSubtitle: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    loadingInline: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.xs,
    },
    loadingInlineText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    tileGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    quickTile: {
      flexBasis: '47%',
      flexGrow: 1,
      minHeight: 108,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    quickTilePressed: {
      backgroundColor: theme.colors.bgInput,
    },
    quickTileIcon: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgItem,
    },
    quickTileTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    quickTileSubtitle: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    emptyStateText: {
      ...theme.typography.body,
      color: theme.colors.textMuted,
      paddingHorizontal: theme.spacing.xs,
    },
  };
}
