import type { AppTheme } from '@shared/theme';

import { SESSION_META_CHIP_HEIGHT } from './sessionMetaChip';

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
    bodyShell: {
      flex: 1,
    },
    topChromeOverlay: {
      position: 'absolute',
      top: 0,
      right: 0,
      left: 0,
      zIndex: 5,
    },
    topChromeGlass: {
      overflow: 'hidden',
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
      minHeight: SESSION_META_CHIP_HEIGHT,
      // The header row is 48pt tall because of its circular buttons, which leaves dead space
      // under the title. Pulling the selector row up into that band tightens the gap above the
      // chips without eating the breathing room below them.
      marginTop: -theme.spacing.sm,
      // Extends the glass plane past the chips rather than moving them, so the material has a
      // settled edge instead of ending on the chip text.
      marginBottom: theme.spacing.xs,
    },
    sessionMetaRowContent: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      minHeight: SESSION_META_CHIP_HEIGHT,
      paddingHorizontal: theme.spacing.md,
    },
    topCardsRow: {
      backgroundColor: theme.colors.bgMain,
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.sm,
      gap: theme.spacing.sm,
      zIndex: 2,
    },
  }) as const;
