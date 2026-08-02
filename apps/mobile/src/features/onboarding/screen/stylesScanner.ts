import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';
import type { OnboardingStyleTokens } from './styleTokens';

export const createOnboardingScannerStyles = (theme: AppTheme, tokens: OnboardingStyleTokens) =>
  StyleSheet.create({
    scannerModalRoot: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.94)',
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.xl,
    },
    scannerSheet: {
      width: '100%',
      maxWidth: 480,
      maxHeight: '100%',
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      backgroundColor: tokens.scannerSheetBackground,
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
    },
    scannerHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    scannerTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    scannerCloseBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgMain,
      alignItems: 'center',
      justifyContent: 'center',
    },
    scannerCloseBtnPressed: {
      opacity: 0.75,
    },
    scannerCameraFrame: {
      width: '100%',
      aspectRatio: 1,
      borderRadius: 18,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
    },
    scannerCamera: {
      flex: 1,
    },
    scannerPermissionWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.lg,
    },
    scannerPermissionText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
    scannerHintText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    scannerCancelButton: {
      minHeight: 48,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
      alignItems: 'center',
      justifyContent: 'center',
    },
    scannerCancelButtonPressed: {
      opacity: 0.78,
    },
    scannerCancelButtonText: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
  });
