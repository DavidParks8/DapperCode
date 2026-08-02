import { StyleSheet } from 'react-native';

import type { AppTheme } from '../../theme';
import type { OnboardingStyleTokens } from './onboardingScreenStyleTokens';

export const createOnboardingBaseStyles = (theme: AppTheme, tokens: OnboardingStyleTokens) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    safeArea: {
      flex: 1,
    },
    keyboardAvoiding: {
      flex: 1,
    },
    ambientCanvas: {
      ...StyleSheet.absoluteFill,
      overflow: 'hidden',
    },
    ambientOrbPrimary: {
      position: 'absolute',
      top: -110,
      right: -70,
      width: 280,
      height: 280,
      borderRadius: 140,
    },
    ambientOrbSecondary: {
      position: 'absolute',
      bottom: 110,
      left: -90,
      width: 220,
      height: 220,
      borderRadius: 110,
    },
    introRoot: {
      flex: 1,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.xxl,
      gap: theme.spacing.md,
      justifyContent: 'space-between',
    },
    introHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    introBrandRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    introBrandName: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      letterSpacing: 0,
    },
    introBody: {
      flex: 1,
      justifyContent: 'center',
    },
    introHero: {
      alignItems: 'center',
      gap: theme.spacing.md,
      paddingHorizontal: theme.spacing.sm,
    },
    introHeroArt: {
      alignItems: 'center',
      marginBottom: theme.spacing.sm,
    },
    introHeroAgentCloud: {
      width: 236,
      height: 158,
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
    },
    introHeroAgentCard: {
      position: 'absolute',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.76)',
      boxShadow: theme.isDark
        ? '0px 12px 24px rgba(0, 0, 0, 0.22)'
        : '0px 10px 20px rgba(15, 31, 54, 0.10)',
    },
    introHeroAgentCardPrimary: {
      top: 4,
      left: 82,
      width: 72,
      height: 72,
      borderRadius: 24,
      borderColor: theme.colors.borderHighlight,
      backgroundColor: theme.isDark ? 'rgba(181, 189, 204, 0.16)' : 'rgba(255,255,255,0.86)',
    },
    introHeroAgentCardSecondary: {
      right: 12,
      top: 88,
      width: 94,
      height: 58,
      borderRadius: 20,
      transform: [{ rotate: '7deg' }],
    },
    introHeroAgentCardLogo: {
      width: 38,
      height: 38,
    },
    introHeroAgentCardLogoWide: {
      width: 64,
      height: 36,
    },
    introHeroTitleWrap: {
      width: '100%',
      maxWidth: 340,
      minHeight: 82,
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    introHeroAgentWord: {
      minWidth: 160,
      maxWidth: 260,
      height: 42,
      alignItems: 'center',
      justifyContent: 'center',
    },
    introHeroAgentLabel: {
      ...theme.typography.largeTitle,
      flexShrink: 1,
      // Tighter than largeTitle's own lineHeight to keep both stacked words inside the fixed
      // 42px agent-word row.
      lineHeight: 32,
      letterSpacing: 0,
      textAlign: 'center',
      color: theme.colors.textPrimary,
    },
    introHeroTitleTail: {
      ...theme.typography.largeTitle,
      lineHeight: 32,
      letterSpacing: 0,
      textAlign: 'center',
      color: theme.colors.textPrimary,
    },
    introHeroDescription: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      maxWidth: 280,
    },
    stepperDock: {
      borderRadius: theme.radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      backgroundColor: tokens.glassDockBackground,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
      overflow: 'hidden',
    },
    stepperDockRow: {
      flexDirection: 'row',
      gap: theme.spacing.xs,
    },
    stepperPill: {
      flex: 1,
      minHeight: 36,
      borderRadius: theme.radius.full,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 6,
      gap: 6,
      backgroundColor: tokens.glassSubtleBackground,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
    },
    stepperPillActive: {
      backgroundColor: tokens.glassSelectedBackground,
      borderColor: theme.colors.borderHighlight,
    },
    stepperPillComplete: {
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.08)' : 'rgba(14, 159, 110, 0.10)',
      borderColor: theme.isDark ? 'rgba(198, 205, 217, 0.22)' : 'rgba(14, 159, 110, 0.22)',
    },
    stepperPillIndex: {
      width: 18,
      height: 18,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgInput,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
    },
    stepperPillIndexActive: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    stepperPillIndexComplete: {
      backgroundColor: theme.colors.statusComplete,
      borderColor: theme.colors.statusComplete,
    },
    stepperPillIndexText: {
      ...theme.typography.metadata,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    stepperPillIndexTextActive: {
      color: theme.colors.accentText,
    },
    stepperPillTitle: {
      ...theme.typography.metadata,
      color: theme.colors.textSecondary,
      fontWeight: '600',
    },
    stepperPillTitleActive: {
      color: theme.colors.textPrimary,
    },
    stepperPillTitleComplete: {
      color: theme.colors.textPrimary,
    },
    introSectionHeader: {
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.xs,
    },
    introSectionTitle: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0,
    },
    introSectionSubtitle: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
    },
    introFeatureGrid: {
      gap: theme.spacing.sm,
    },
    introFeatureCard: {
      flexDirection: 'row',
      gap: theme.spacing.md,
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: tokens.glassFeatureBackground,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
    },
    introFeatureIconWrap: {
      width: 36,
      height: 36,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tokens.glassFeatureIcon,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
    },
    introFeatureTextWrap: {
      flex: 1,
      gap: 2,
    },
    introFeatureTitle: {
      ...theme.typography.headline,
    },
    introFeatureDescription: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    introContextCard: {
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      backgroundColor: tokens.glassDockBackground,
      padding: theme.spacing.lg,
      gap: theme.spacing.sm,
      overflow: 'hidden',
    },
    introContextTitle: {
      ...theme.typography.headline,
    },
    introContextText: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
    },
    introContextPillRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xs,
    },
    introFooter: {
      gap: theme.spacing.sm,
    },
  });
