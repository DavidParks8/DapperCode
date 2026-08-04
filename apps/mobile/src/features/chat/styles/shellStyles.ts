import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';

export const createMainScreenShellStyles = (theme: AppTheme) =>
  ({
    container: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    bodyContainer: {
      flex: 1,
      position: 'relative',
    },
    keyboardAvoiding: {
      flex: 1,
    },
    topChromeOverlay: {
      position: 'absolute',
      top: 0,
      right: 0,
      left: 0,
      zIndex: 5,
    },
    composerContainer: {
      backgroundColor: theme.colors.transparent,
    },
    composerContainerOverlay: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 6,
    },
    composerContainerResting: {
      marginBottom: 0,
    },
    queuedMessageDock: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.xs,
      paddingBottom: theme.spacing.xs / 2,
    },
    sessionMetaRow: {
      backgroundColor: theme.colors.bgMain,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
      paddingVertical: theme.spacing.xs + 2,
    },
    sessionMetaRowContent: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs + 2,
      paddingHorizontal: theme.spacing.lg,
    },
    topCardsRow: {
      backgroundColor: theme.colors.bgMain,
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.sm,
      gap: theme.spacing.sm,
      zIndex: 2,
    },
  }) as const;
