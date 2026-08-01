import { StyleSheet } from 'react-native';

import type { AppTheme } from '../../theme';

export const createOnboardingLayoutStyles = (theme: AppTheme) =>
  StyleSheet.create({
    connectHeaderRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    heroTopRowLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    heroTopRowRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    heroIconWrap: {
      width: 32,
      height: 32,
      borderRadius: theme.radius.lg,
      backgroundColor: 'rgba(255, 255, 255, 0.08)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelBtn: {
      width: 30,
      height: 30,
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgMain,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelBtnPressed: {
      opacity: 0.75,
    },
    connectTopButton: {
      minHeight: 48,
      borderRadius: theme.radius.full,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.isDark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.66)',
      paddingHorizontal: theme.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    connectTopButtonText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.lg,
      gap: theme.spacing.md,
    },
    connectRoot: {
      flex: 1,
    },
    connectAnimatedRoot: {
      flex: 1,
    },
    connectFooter: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.xxl,
    },
  });
