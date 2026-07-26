import type { AppTheme } from '../../theme';

export interface OnboardingStyleTokens {
  glassDockBackground: string;
  glassSubtleBackground: string;
  glassFeatureBackground: string;
  glassFeatureIcon: string;
  glassSelectedBackground: string;
  glassSelectedStrong: string;
  scannerSheetBackground: string;
}

export function createOnboardingStyleTokens(theme: AppTheme): OnboardingStyleTokens {
  return {
    glassDockBackground: theme.isDark ? 'rgba(12, 14, 18, 0.76)' : 'rgba(246, 249, 252, 0.90)',
    glassSubtleBackground: theme.isDark ? 'rgba(255,255,255,0.03)' : theme.colors.bgInput,
    glassFeatureBackground: theme.isDark ? 'rgba(7, 9, 12, 0.72)' : 'rgba(243, 247, 251, 0.88)',
    glassFeatureIcon: theme.isDark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.84)',
    glassSelectedBackground: theme.isDark ? 'rgba(181, 189, 204, 0.10)' : 'rgba(56, 79, 106, 0.12)',
    glassSelectedStrong: theme.isDark ? 'rgba(181, 189, 204, 0.16)' : 'rgba(56, 79, 106, 0.18)',
    scannerSheetBackground: theme.isDark ? '#07090C' : theme.colors.bgElevated,
  };
}
