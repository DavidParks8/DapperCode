import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';

export function createBrowserScreenStartStyles(theme: AppTheme) {
  return StyleSheet.create({
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
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
    },
    startHeroTitle: {
      ...theme.typography.largeTitle,
      color: theme.colors.textPrimary,
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
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
      overflow: 'hidden',
    },
    quickTileGlass: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
    },
    quickTilePressedOverlay: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    quickTileIcon: {
      width: 28,
      height: 28,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgCanvasAccent,
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
  });
}
