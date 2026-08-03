import { createContext, createElement, useContext, type PropsWithChildren } from 'react';
import { Platform, type ColorSchemeName, type TextStyle } from 'react-native';

import { SYSTEM_FONT_FAMILIES, type AppFontFamilies } from '@shared/fonts';

export type AppearancePreference = 'system' | 'light' | 'dark';
export type ThemeMode = 'light' | 'dark';
/** Colors used only when the resolved appearance is dark (System+dark or Dark). */
export type DarkUiPalette = 'classic' | 'grey';

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

export interface AppTheme {
  mode: ThemeMode;
  isDark: boolean;
  fonts: AppFontFamilies;
  colors: AppColors;
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
  codeSyntaxString: '#A5D6FF',
  codeSyntaxNumber: '#79C0FF',
  codeSyntaxFunction: '#FFA657',
  codeSyntaxProperty: '#FF9492',
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

/** IDE-style charcoal dark (lifted grays, VS Code–like neutrals). */
const darkGreyColors: AppColors = {
  bgMain: '#1e1e1e',
  bgSidebar: '#252526',
  bgItem: '#2d2d30',
  bgInput: '#3c3c3c',
  bgElevated: '#252526',
  bgCanvasAccent: 'rgba(255, 255, 255, 0.05)',
  border: 'rgba(255, 255, 255, 0.12)',
  borderLight: 'rgba(255, 255, 255, 0.08)',
  borderHighlight: 'rgba(255, 255, 255, 0.16)',
  textPrimary: '#e8e8e8',
  textSecondary: '#cccccc',
  textMuted: '#9d9d9d',
  accent: '#C7BFFF',
  accentPressed: '#AFA0FF',
  accentText: '#1e1e1e',
  userBubble: '#006FE6',
  userBubbleBorder: 'transparent',
  userBubbleText: '#FFFFFF',
  userBubbleSecondaryText: 'rgba(255, 255, 255, 0.82)',
  userBubbleInset: 'rgba(255, 255, 255, 0.16)',
  assistantBubbleBg: 'transparent',
  assistantBubbleBorder: 'transparent',
  inlineCodeBg: '#1e1e1e',
  inlineCodeBorder: 'rgba(255, 255, 255, 0.14)',
  inlineCodeText: '#e8e8e8',
  codeSyntaxComment: '#A7A7A7',
  codeSyntaxKeyword: '#DCDCAA',
  codeSyntaxString: '#CE9178',
  codeSyntaxNumber: '#B5CEA8',
  codeSyntaxFunction: '#DCDCAA',
  codeSyntaxProperty: '#9CDCFE',
  codeSyntaxOperator: '#D4D4D4',
  toolBlockBg: 'rgba(255, 255, 255, 0.06)',
  toolBlockBorder: 'rgba(255, 255, 255, 0.14)',
  subAgentAccent: '#C1B8FF',
  subAgentBg: '#2B2940',
  subAgentBorder: '#514A7F',
  diffAddedText: '#57A6FF',
  diffAddedBg: 'rgba(87, 166, 255, 0.14)',
  diffRemovedText: '#FF7B72',
  diffRemovedBg: 'rgba(255, 123, 114, 0.14)',
  statusRunning: '#89d185',
  statusComplete: '#89d185',
  statusError: '#f14c4c',
  statusIdle: '#858585',
  success: '#89d185',
  successBg: 'rgba(137, 209, 133, 0.12)',
  successBorder: 'rgba(137, 209, 133, 0.28)',
  warning: '#cca700',
  warningBg: 'rgba(204, 167, 0, 0.12)',
  warningBorder: 'rgba(204, 167, 0, 0.28)',
  error: '#f14c4c',
  errorBg: 'rgba(241, 76, 76, 0.14)',
  errorBorder: 'rgba(241, 76, 76, 0.30)',
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
  userBubbleBorder: 'transparent',
  userBubbleText: '#FFFFFF',
  userBubbleSecondaryText: 'rgba(255, 255, 255, 0.82)',
  userBubbleInset: 'rgba(255, 255, 255, 0.16)',
  assistantBubbleBg: 'transparent',
  assistantBubbleBorder: 'transparent',
  inlineCodeBg: '#DFE8F2',
  inlineCodeBorder: 'rgba(70, 96, 126, 0.30)',
  inlineCodeText: '#102030',
  codeSyntaxComment: '#59636E',
  codeSyntaxKeyword: '#6F42C1',
  codeSyntaxString: '#116329',
  codeSyntaxNumber: '#0550AE',
  codeSyntaxFunction: '#953800',
  codeSyntaxProperty: '#A40E26',
  codeSyntaxOperator: '#203A55',
  toolBlockBg: 'rgba(67, 96, 126, 0.12)',
  toolBlockBorder: '#7289A4',
  subAgentAccent: '#5848C7',
  subAgentBg: '#E3E0F7',
  subAgentBorder: '#B8B0E5',
  diffAddedText: '#0550AE',
  diffAddedBg: 'rgba(5, 80, 174, 0.12)',
  diffRemovedText: '#A40E26',
  diffRemovedBg: 'rgba(164, 14, 38, 0.12)',
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

export function resolveThemeMode(
  preference: AppearancePreference,
  systemScheme: ColorSchemeName,
): ThemeMode {
  if (preference === 'light' || preference === 'dark') {
    return preference;
  }

  return systemScheme === 'light' ? 'light' : 'dark';
}

export function createAppTheme(
  mode: ThemeMode,
  darkUiPalette: DarkUiPalette = 'classic',
): AppTheme {
  const colors =
    mode === 'light' ? lightColors : darkUiPalette === 'grey' ? darkGreyColors : darkClassicColors;
  const isDark = mode === 'dark';
  const fonts = SYSTEM_FONT_FAMILIES;
  return {
    mode,
    isDark,
    fonts,
    colors,
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

const fallbackTheme = createAppTheme('dark', 'classic');
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
