import { createContext, createElement, useContext, type PropsWithChildren } from 'react';
import type { GlassStyle } from 'expo-glass-effect';
import { Platform, type ColorSchemeName, type TextStyle } from 'react-native';

import { SYSTEM_FONT_FAMILIES, type AppFontFamilies } from '@shared/fonts';

export type ThemeMode = 'light' | 'dark';

export interface AppColors {
  bgMain: string;
  bgSidebar: string;
  bgItem: string;
  bgInput: string;
  bgElevated: string;
  bgCanvasAccent: string;
  border: string;
  borderLight: string;
  borderHighlight: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentPressed: string;
  accentText: string;
  userBubble: string;
  userBubbleOnSurface: string;
  userBubbleBorder: string;
  userBubbleText: string;
  userBubbleSecondaryText: string;
  userBubbleInset: string;
  assistantBubbleBg: string;
  assistantBubbleBorder: string;
  inlineCodeBg: string;
  inlineCodeBorder: string;
  inlineCodeText: string;
  codeSyntaxComment: string;
  codeSyntaxKeyword: string;
  codeSyntaxString: string;
  codeSyntaxNumber: string;
  codeSyntaxFunction: string;
  codeSyntaxProperty: string;
  codeSyntaxOperator: string;
  toolBlockBg: string;
  toolBlockBorder: string;
  subAgentAccent: string;
  subAgentBg: string;
  subAgentBorder: string;
  diffAddedText: string;
  diffAddedBg: string;
  diffRemovedText: string;
  diffRemovedBg: string;
  statusRunning: string;
  statusComplete: string;
  statusError: string;
  statusIdle: string;
  success: string;
  successBg: string;
  successBorder: string;
  warning: string;
  warningBg: string;
  warningBorder: string;
  error: string;
  errorBg: string;
  errorBorder: string;
  shadow: string;
  overlayBackdrop: string;
  white: string;
  black: string;
  transparent: string;
}

export type AppTypography = {
  /** Screen/hero titles. */
  largeTitle: TextStyle;
  /** Section/nav-bar titles, one step down from largeTitle. */
  title: TextStyle;
  /** Card/list-row primary headings. */
  headline: TextStyle;
  /** Secondary heading beneath a headline. */
  subheadline: TextStyle;
  /** Default reading copy. */
  body: TextStyle;
  /** Supporting copy, helper text. */
  caption: TextStyle;
  /** Compact semibold labels: form labels, tags, buttons. */
  label: TextStyle;
  /** Smallest role: timestamps, footnotes, fine print. Floor of the type scale. */
  metadata: TextStyle;
  /** Monospace text for code/terminal-style content. */
  mono: TextStyle;
};

export type GlassSurfaceRole = 'chrome' | 'capsule' | 'drawer' | 'prominent';

export interface AppGlassSurface {
  glassEffectStyle: GlassStyle;
  tintColor?: string;
  fallbackBackgroundColor: string;
  fallbackBorderColor: string;
}

export type AppGlass = Record<GlassSurfaceRole, AppGlassSurface>;

export interface AppTheme {
  mode: ThemeMode;
  isDark: boolean;
  fonts: AppFontFamilies;
  colors: AppColors;
  glass: AppGlass;
  spacing: typeof spacing;
  radius: typeof radius;
  shadow: typeof shadow;
  typography: AppTypography;
  motion: typeof motion;
  touchTarget: { minimum: number };
  keyboardAppearance: 'light' | 'dark';
  blurTint: 'light' | 'dark';
  statusBarStyle: 'dark-content' | 'light-content';
}

/** Deep OLED-friendly dark palette. */
const darkClassicColors: AppColors = {
  bgMain: '#000000',
  bgSidebar: '#0C0D10',
  bgItem: '#1B1D21',
  bgInput: '#23262B',
  bgElevated: '#0E1116',
  bgCanvasAccent: 'rgba(255, 255, 255, 0.04)',
  border: 'rgba(255, 255, 255, 0.18)',
  borderLight: 'rgba(255, 255, 255, 0.12)',
  borderHighlight: 'rgba(255, 255, 255, 0.28)',
  textPrimary: '#F3F4F8',
  textSecondary: '#D0D5DF',
  textMuted: 'rgba(232, 236, 244, 0.74)',
  accent: '#C7BFFF',
  accentPressed: '#AFA0FF',
  accentText: '#000000',
  userBubble: '#006FE6',
  userBubbleOnSurface: '#4DA3FF',
  userBubbleBorder: 'transparent',
  userBubbleText: '#FFFFFF',
  userBubbleSecondaryText: 'rgba(255, 255, 255, 0.82)',
  userBubbleInset: 'rgba(255, 255, 255, 0.16)',
  assistantBubbleBg: 'transparent',
  assistantBubbleBorder: 'transparent',
  inlineCodeBg: '#2A303A',
  inlineCodeBorder: 'rgba(197, 206, 223, 0.42)',
  inlineCodeText: '#EEF2FB',
  codeSyntaxComment: '#AAB3C2',
  codeSyntaxKeyword: '#D2A8FF',
  codeSyntaxString: '#E6C07B',
  codeSyntaxNumber: '#8FC8C2',
  codeSyntaxFunction: '#FFA657',
  codeSyntaxProperty: '#E3A4D7',
  codeSyntaxOperator: '#D0D5DF',
  toolBlockBg: 'rgba(255, 255, 255, 0.09)',
  toolBlockBorder: '#5A6376',
  subAgentAccent: '#B8AEFF',
  subAgentBg: '#17152B',
  subAgentBorder: '#413A73',
  diffAddedText: '#57A6FF',
  diffAddedBg: 'rgba(87, 166, 255, 0.14)',
  diffRemovedText: '#FF7B72',
  diffRemovedBg: 'rgba(255, 123, 114, 0.14)',
  statusRunning: '#C2C9D8',
  statusComplete: '#34C759',
  statusError: '#EF4444',
  statusIdle: '#B4BCCB',
  success: '#34C759',
  successBg: 'rgba(52, 199, 89, 0.12)',
  successBorder: 'rgba(52, 199, 89, 0.32)',
  warning: '#F7D27E',
  warningBg: 'rgba(247, 210, 126, 0.08)',
  warningBorder: 'rgba(247, 210, 126, 0.24)',
  error: '#EF4444',
  errorBg: 'rgba(239, 68, 68, 0.15)',
  errorBorder: 'rgba(239, 68, 68, 0.30)',
  shadow: '#000000',
  overlayBackdrop: 'rgba(0, 0, 0, 0.52)',
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
};

const lightColors: AppColors = {
  bgMain: '#DDE7F0',
  bgSidebar: '#D2DCE7',
  bgItem: '#F3F7FB',
  bgInput: '#EAF0F6',
  bgElevated: '#F6F9FC',
  bgCanvasAccent: 'rgba(41, 58, 84, 0.09)',
  border: 'rgba(44, 62, 88, 0.22)',
  borderLight: 'rgba(44, 62, 88, 0.16)',
  borderHighlight: 'rgba(67, 96, 126, 0.34)',
  textPrimary: '#102030',
  textSecondary: '#203A55',
  textMuted: 'rgba(44, 62, 88, 0.82)',
  accent: '#4C3FCB',
  accentPressed: '#3C2FB0',
  accentText: '#FFFFFF',
  userBubble: '#006FE6',
  userBubbleOnSurface: '#0057B8',
  userBubbleBorder: 'transparent',
  userBubbleText: '#FFFFFF',
  userBubbleSecondaryText: 'rgba(255, 255, 255, 0.82)',
  userBubbleInset: 'rgba(255, 255, 255, 0.16)',
  assistantBubbleBg: 'transparent',
  assistantBubbleBorder: 'transparent',
  inlineCodeBg: '#DFE8F2',
  inlineCodeBorder: 'rgba(70, 96, 126, 0.30)',
  inlineCodeText: '#102030',
  codeSyntaxComment: '#43505B',
  codeSyntaxKeyword: '#59369A',
  codeSyntaxString: '#654000',
  codeSyntaxNumber: '#18565A',
  codeSyntaxFunction: '#7A2E00',
  codeSyntaxProperty: '#7A316F',
  codeSyntaxOperator: '#25384C',
  toolBlockBg: 'rgba(67, 96, 126, 0.12)',
  toolBlockBorder: '#7289A4',
  subAgentAccent: '#5848C7',
  subAgentBg: '#E3E0F7',
  subAgentBorder: '#B8B0E5',
  diffAddedText: '#04408B',
  diffAddedBg: 'rgba(4, 64, 139, 0.12)',
  diffRemovedText: '#8C0C20',
  diffRemovedBg: 'rgba(140, 12, 32, 0.12)',
  statusRunning: '#3C5674',
  statusComplete: '#0E9F6E',
  statusError: '#D92D20',
  statusIdle: '#566C87',
  success: '#0E9F6E',
  successBg: 'rgba(14, 159, 110, 0.10)',
  successBorder: 'rgba(14, 159, 110, 0.24)',
  warning: '#C56A12',
  warningBg: 'rgba(197, 106, 18, 0.14)',
  warningBorder: 'rgba(197, 106, 18, 0.24)',
  error: '#D92D20',
  errorBg: 'rgba(217, 45, 32, 0.10)',
  errorBorder: 'rgba(217, 45, 32, 0.24)',
  shadow: '#0F1F36',
  overlayBackdrop: 'rgba(15, 31, 54, 0.20)',
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
};

function createGlass(colors: AppColors, isDark: boolean): AppGlass {
  const chromeTint = isDark ? 'rgba(0, 111, 230, 0.26)' : 'rgba(0, 111, 230, 0.10)';
  const capsuleTint = isDark ? 'rgba(0, 111, 230, 0.34)' : 'rgba(0, 111, 230, 0.15)';
  const drawerTint = isDark ? 'rgba(0, 111, 230, 0.24)' : 'rgba(0, 111, 230, 0.12)';

  return {
    chrome: {
      glassEffectStyle: 'regular',
      tintColor: chromeTint,
      fallbackBackgroundColor: colors.bgMain,
      fallbackBorderColor: colors.borderLight,
    },
    capsule: {
      glassEffectStyle: 'regular',
      tintColor: capsuleTint,
      fallbackBackgroundColor: colors.bgInput,
      fallbackBorderColor: colors.borderHighlight,
    },
    drawer: {
      glassEffectStyle: 'regular',
      tintColor: drawerTint,
      fallbackBackgroundColor: colors.bgSidebar,
      fallbackBorderColor: colors.borderLight,
    },
    prominent: {
      glassEffectStyle: 'regular',
      tintColor: colors.userBubble,
      fallbackBackgroundColor: colors.userBubble,
      fallbackBorderColor: colors.userBubbleBorder,
    },
  };
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
};

export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 999,
};

export const shadow = {
  sm: {
    boxShadow: '0px 2px 6px rgba(0, 0, 0, 0.3)',
  },
} as const;

/**
 * Motion tokens shared across the app: durations in milliseconds, easing as cubic-bezier
 * control points matching Reanimated's `Easing.bezier(x1, y1, x2, y2)`.
 */
export const motion = {
  duration: {
    /** Instant acknowledgements: button press states, toggle flips. */
    immediate: 120,
    /** Everyday transitions: sheet content swaps, fades. */
    routine: 200,
    /** Layout-affecting moves: card enter/exit, expand/collapse reflows. */
    layout: 280,
  },
  easing: {
    standard: [0.4, 0, 0.2, 1] as const,
    decelerate: [0, 0, 0.2, 1] as const,
    accelerate: [0.4, 0, 1, 1] as const,
  },
} as const;

/**
 * Platform-effective minimum touch target sizes, matching Apple's Human Interface Guidelines
 * (44pt), Android's Material accessibility guidance (48dp), and a 44px default for web.
 */
export const touchTarget = {
  ios44: 44,
  android48: 48,
  web44: 44,
} as const;

export function resolveMinimumTouchTarget(platformOS: string = Platform.OS): number {
  if (platformOS === 'android') {
    return touchTarget.android48;
  }
  if (platformOS === 'web') {
    return touchTarget.web44;
  }
  return touchTarget.ios44;
}

function createTypography(colors: AppColors, fonts: AppFontFamilies): AppTypography {
  return {
    largeTitle: {
      fontSize: 28,
      lineHeight: 34,
      color: colors.textPrimary,
      fontWeight: '700',
    },
    title: {
      fontSize: 22,
      lineHeight: 28,
      color: colors.textPrimary,
      fontWeight: '700',
    },
    headline: {
      fontSize: 17,
      lineHeight: 22,
      color: colors.textPrimary,
      fontWeight: '600',
    },
    subheadline: {
      fontSize: 15,
      lineHeight: 20,
      color: colors.textSecondary,
      fontWeight: '600',
    },
    body: {
      fontSize: 16,
      lineHeight: 22,
      color: colors.textPrimary,
      fontWeight: '400',
    },
    caption: {
      fontSize: 13,
      lineHeight: 18,
      color: colors.textMuted,
      fontWeight: '400',
    },
    label: {
      fontSize: 12,
      lineHeight: 16,
      color: colors.textSecondary,
      fontWeight: '600',
    },
    metadata: {
      fontSize: 11,
      lineHeight: 14,
      color: colors.textMuted,
      fontWeight: '500',
    },
    mono: {
      fontSize: 13,
      lineHeight: 19,
      fontFamily: fonts.monoRegular,
      color: colors.textPrimary,
    },
  };
}

export function resolveThemeMode(systemScheme: ColorSchemeName): ThemeMode {
  return systemScheme === 'light' ? 'light' : 'dark';
}

export function createAppTheme(mode: ThemeMode): AppTheme {
  const colors = mode === 'light' ? lightColors : darkClassicColors;
  const isDark = mode === 'dark';
  const fonts = SYSTEM_FONT_FAMILIES;
  return {
    mode,
    isDark,
    fonts,
    colors,
    glass: createGlass(colors, isDark),
    spacing,
    radius,
    shadow,
    typography: createTypography(colors, fonts),
    motion,
    touchTarget: { minimum: resolveMinimumTouchTarget() },
    keyboardAppearance: isDark ? 'dark' : 'light',
    blurTint: isDark ? 'dark' : 'light',
    statusBarStyle: isDark ? 'light-content' : 'dark-content',
  };
}

const fallbackTheme = createAppTheme('dark');
export const colors: AppColors = { ...fallbackTheme.colors };
export const typography: AppTypography = { ...fallbackTheme.typography };

const AppThemeContext = createContext<AppTheme>(fallbackTheme);

export function AppThemeProvider({ theme, children }: PropsWithChildren<{ theme: AppTheme }>) {
  Object.assign(colors, theme.colors);
  Object.assign(typography, theme.typography);
  return createElement(AppThemeContext.Provider, { value: theme }, children);
}

export function useAppTheme(): AppTheme {
  return useContext(AppThemeContext);
}
