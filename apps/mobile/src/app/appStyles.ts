import { StyleSheet } from 'react-native';

import { TABLET_SIDEBAR_WIDTH } from './appConstants';
import { type AppTheme } from '../theme';

export function createStyles(theme: AppTheme): ReturnType<typeof StyleSheet.create> {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    loadingRoot: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgMain,
    },
    persistenceRecoveryRoot: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.md,
      padding: theme.spacing.xl,
      backgroundColor: theme.colors.bgMain,
    },
    persistenceRecoveryTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      textAlign: 'center',
    },
    persistenceRecoveryMessage: {
      ...theme.typography.body,
      maxWidth: 440,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
    persistenceRecoveryButton: {
      minWidth: 120,
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.accent,
    },
    persistenceRecoveryButtonPressed: {
      backgroundColor: theme.colors.accentPressed,
    },
    persistenceRecoveryButtonText: {
      ...theme.typography.body,
      color: theme.colors.accentText,
      fontWeight: '700',
    },
    screen: {
      flex: 1,
    },
    tabletShell: {
      flexDirection: 'row',
      backgroundColor: theme.colors.bgMain,
    },
    tabletSidebarClip: {
      width: TABLET_SIDEBAR_WIDTH,
      overflow: 'hidden',
      backgroundColor: theme.colors.bgSidebar,
    },
    tabletSidebarContent: {
      width: TABLET_SIDEBAR_WIDTH,
      flex: 1,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgSidebar,
    },
    screenFrame: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
      overflow: 'hidden',
      borderCurve: 'continuous',
      shadowColor: theme.colors.shadow,
      shadowOffset: { width: 0, height: 16 },
    },
    tabletScreenFrame: {
      width: undefined,
      borderRadius: 0,
      shadowOpacity: 0,
      shadowRadius: 0,
      elevation: 0,
    },
    chatTransitionOverlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 5,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 28,
      backgroundColor: theme.colors.bgMain,
    },
    chatTransitionCard: {
      width: '100%',
      maxWidth: 320,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
      paddingHorizontal: 22,
      paddingVertical: 24,
      alignItems: 'center',
      gap: 10,
    },
    chatTransitionTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      textAlign: 'center',
    },
    overlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.colors.overlayBackdrop,
      zIndex: 10,
    },
    drawerLayer: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 10,
    },
    drawerGestureSurface: {
      ...StyleSheet.absoluteFillObject,
    },
    drawer: {
      position: 'absolute',
      top: 0,
      left: 0,
      bottom: 0,
      zIndex: 20,
    },
    drawerContentShell: {
      flex: 1,
    },
  });
}

export type AppStyles = ReturnType<typeof createStyles>;