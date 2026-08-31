import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';

export type MermaidDiagramStyles = ReturnType<typeof createMermaidDiagramStyles>;

export const createMermaidDiagramStyles = (theme: AppTheme) =>
  StyleSheet.create({
    surface: {
      width: '100%',
      maxWidth: '100%',
      marginVertical: theme.spacing.sm,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.bgElevated,
    },
    header: {
      minHeight: theme.touchTarget.minimum,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingLeft: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
    },
    headerTitleGroup: {
      minWidth: 0,
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    languageLabel: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.35,
      flexShrink: 1,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    headerButton: {
      minHeight: theme.touchTarget.minimum,
      paddingHorizontal: theme.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    iconButton: {
      width: theme.touchTarget.minimum,
      height: theme.touchTarget.minimum,
      alignItems: 'center',
      justifyContent: 'center',
    },
    copyLabel: {
      ...theme.typography.label,
      color: theme.colors.textSecondary,
    },
    copyLabelError: {
      color: theme.colors.error,
    },
    buttonPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    buttonDisabled: {
      opacity: 0.38,
    },
    preview: {
      position: 'relative',
      width: '100%',
      overflow: 'hidden',
      backgroundColor: theme.colors.bgElevated,
    },
    previewPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    loadingText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    fallback: {
      backgroundColor: theme.colors.bgElevated,
    },
    errorSummary: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.md,
    },
    errorIcon: {
      color: theme.colors.error,
      marginTop: 1,
    },
    errorCopy: {
      flex: 1,
      gap: theme.spacing.xs,
    },
    errorTitle: {
      ...theme.typography.label,
      color: theme.colors.textPrimary,
    },
    errorDetail: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    sourceScroll: {
      width: '100%',
      maxWidth: '100%',
    },
    sourceScrollContent: {
      minWidth: '100%',
      alignItems: 'flex-start',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
    },
    sourceCode: {
      ...theme.typography.mono,
      color: theme.colors.inlineCodeText,
      alignSelf: 'flex-start',
      flexShrink: 0,
    },
    viewerRoot: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    viewerHeader: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgMain,
    },
    viewerHeaderButton: {
      width: 48,
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: theme.radius.full,
    },
    viewerTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      flex: 1,
      textAlign: 'center',
    },
    viewerCanvas: {
      flex: 1,
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: theme.colors.bgElevated,
    },
    viewerStatus: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.xxl,
      backgroundColor: theme.colors.bgElevated,
    },
    viewerButtonPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    zoomDock: {
      position: 'absolute',
      alignSelf: 'center',
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.bgInput,
      boxShadow: theme.isDark
        ? '0 8px 24px rgba(0, 0, 0, 0.36)'
        : '0 8px 24px rgba(15, 31, 54, 0.18)',
    },
    zoomButton: {
      width: 48,
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
    },
    zoomResetButton: {
      minWidth: 64,
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.sm,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
    },
    zoomLabel: {
      ...theme.typography.label,
      color: theme.colors.textSecondary,
      fontVariant: ['tabular-nums'],
    },
  });
