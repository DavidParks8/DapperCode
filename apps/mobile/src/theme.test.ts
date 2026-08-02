import { SYSTEM_FONT_FAMILIES } from './fonts';
import {
  AppThemeProvider,
  colors,
  createAppTheme,
  motion,
  radius,
  resolveMinimumTouchTarget,
  resolveThemeMode,
  touchTarget,
  typography,
  type AppTypography,
} from './theme';

/** WCAG 2.x relative luminance for an sRGB channel value in [0, 255]. */
function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a `#rrggbb` hex color. */
function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/** WCAG 2.x contrast ratio between two `#rrggbb` hex colors (1:1 to 21:1). */
function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_NORMAL_TEXT_CONTRAST = 4.5;

const TYPOGRAPHY_ROLES: (keyof AppTypography)[] = [
  'largeTitle',
  'title',
  'headline',
  'subheadline',
  'body',
  'caption',
  'label',
  'metadata',
  'mono',
];

describe('theme', () => {
  it('resolves system preference from the device scheme', () => {
    expect(resolveThemeMode('system', 'light')).toBe('light');
    expect(resolveThemeMode('system', 'dark')).toBe('dark');
  });

  it('honors explicit appearance preferences', () => {
    expect(resolveThemeMode('light', 'dark')).toBe('light');
    expect(resolveThemeMode('dark', 'light')).toBe('dark');
  });

  it('builds light-mode runtime properties', () => {
    const theme = createAppTheme('light');

    expect(theme.mode).toBe('light');
    expect(theme.isDark).toBe(false);
    expect(theme.keyboardAppearance).toBe('light');
    expect(theme.blurTint).toBe('light');
    expect(theme.statusBarStyle).toBe('dark-content');
    expect(theme.colors.bgMain).toBe('#DDE7F0');
    expect(theme.colors.accentText).toBe('#FFFFFF');
  });

  it('builds dark-mode runtime properties', () => {
    const theme = createAppTheme('dark');

    expect(theme.mode).toBe('dark');
    expect(theme.isDark).toBe(true);
    expect(theme.keyboardAppearance).toBe('dark');
    expect(theme.blurTint).toBe('dark');
    expect(theme.statusBarStyle).toBe('light-content');
    expect(theme.colors.bgMain).toBe('#000000');
    expect(theme.colors.accentText).toBe('#000000');
  });

  it('uses grey charcoal tokens when dark grey palette is selected', () => {
    const theme = createAppTheme('dark', 'grey');

    expect(theme.colors.bgMain).toBe('#1e1e1e');
    expect(theme.colors.accentText).toBe('#1e1e1e');
  });

  it('uses the platform font with numeric weights for all text styles', () => {
    const theme = createAppTheme('dark');

    expect(theme.fonts).toBe(SYSTEM_FONT_FAMILIES);
    expect(theme.typography.largeTitle).toMatchObject({ fontWeight: '700' });
    expect(theme.typography.headline).toMatchObject({ fontWeight: '600' });
    expect(theme.typography.body).toMatchObject({ fontWeight: '400' });
    expect(theme.typography.caption).toMatchObject({ fontWeight: '400' });
    expect(theme.typography.largeTitle.fontFamily).toBeUndefined();
    expect(theme.typography.body.fontFamily).toBeUndefined();
  });

  it('keeps a platform monospace family for code-style text', () => {
    const theme = createAppTheme('dark');

    expect(theme.typography.mono.fontFamily).toBe(SYSTEM_FONT_FAMILIES.monoRegular);
    expect(SYSTEM_FONT_FAMILIES.monoRegular).toBe('Menlo');
  });

  it('updates compatibility color and typography exports in the provider', () => {
    const theme = createAppTheme('light');
    const child = 'child';
    expect(AppThemeProvider({ theme, children: child })).toBeTruthy();
    expect(colors.bgMain).toBe(theme.colors.bgMain);
    expect(typography.body).toEqual(theme.typography.body);
  });

  it('uses a restrained signature blue-violet accent per palette', () => {
    const darkClassic = createAppTheme('dark', 'classic');
    const darkGrey = createAppTheme('dark', 'grey');
    const light = createAppTheme('light');

    expect(darkClassic.colors.accent).toBe('#C7BFFF');
    expect(darkClassic.colors.accentPressed).toBe('#AFA0FF');
    expect(darkClassic.colors.accentText).toBe('#000000');

    expect(darkGrey.colors.accent).toBe('#C7BFFF');
    expect(darkGrey.colors.accentPressed).toBe('#AFA0FF');
    expect(darkGrey.colors.accentText).toBe('#1e1e1e');

    expect(light.colors.accent).toBe('#4C3FCB');
    expect(light.colors.accentPressed).toBe('#3C2FB0');
    expect(light.colors.accentText).toBe('#FFFFFF');
  });

  it('preserves status colors across the accent palette change', () => {
    const theme = createAppTheme('dark', 'classic');
    expect(theme.colors.statusRunning).toBe('#C2C9D8');
    expect(theme.colors.statusComplete).toBe('#34C759');
    expect(theme.colors.statusError).toBe('#EF4444');
    expect(theme.colors.statusIdle).toBe('#B4BCCB');
  });

  it('meets WCAG AA contrast for accent/accentText and accentPressed/accentText pairs', () => {
    const palettes = [
      createAppTheme('dark', 'classic'),
      createAppTheme('dark', 'grey'),
      createAppTheme('light'),
    ];

    for (const theme of palettes) {
      expect(contrastRatio(theme.colors.accent, theme.colors.accentText)).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT_CONTRAST,
      );
      expect(
        contrastRatio(theme.colors.accentPressed, theme.colors.accentText),
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_CONTRAST);
    }
  });

  it('uses an accessible iMessage-style blue for user messages in every palette', () => {
    const palettes = [
      createAppTheme('dark', 'classic'),
      createAppTheme('dark', 'grey'),
      createAppTheme('light'),
    ];

    for (const theme of palettes) {
      expect(theme.colors.userBubble).toBe('#006FE6');
      expect(theme.colors.userBubbleText).toBe('#FFFFFF');
      expect(
        contrastRatio(theme.colors.userBubble, theme.colors.userBubbleText),
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_CONTRAST);
    }
  });

  it('uses a composed indigo-lavender surface for sub-agent work', () => {
    const darkClassic = createAppTheme('dark', 'classic');
    const darkGrey = createAppTheme('dark', 'grey');
    const light = createAppTheme('light');

    expect(darkClassic.colors.subAgentBg).toBe('#17152B');
    expect(darkClassic.colors.subAgentAccent).toBe('#B8AEFF');
    expect(darkGrey.colors.subAgentBg).toBe('#2B2940');
    expect(darkGrey.colors.subAgentAccent).toBe('#C1B8FF');
    expect(light.colors.subAgentBg).toBe('#E3E0F7');
    expect(light.colors.subAgentAccent).toBe('#5848C7');
  });

  it('exposes an expanded radius scale while preserving existing steps', () => {
    expect(radius.xs).toBe(4);
    expect(radius.sm).toBe(8);
    expect(radius.md).toBe(12);
    expect(radius.lg).toBe(16);
    expect(radius.xl).toBe(24);
    expect(radius.full).toBe(999);
  });

  it('exposes motion duration and easing tokens on the theme', () => {
    const theme = createAppTheme('dark');

    expect(theme.motion).toBe(motion);
    expect(motion.duration).toEqual({ immediate: 120, routine: 200, layout: 280 });
    expect(motion.easing.standard).toEqual([0.4, 0, 0.2, 1]);
    expect(motion.easing.decelerate).toEqual([0, 0, 0.2, 1]);
    expect(motion.easing.accelerate).toEqual([0.4, 0, 1, 1]);
  });

  it('resolves the platform-effective minimum touch target', () => {
    expect(resolveMinimumTouchTarget('ios')).toBe(touchTarget.ios44);
    expect(resolveMinimumTouchTarget('android')).toBe(touchTarget.android48);
    expect(resolveMinimumTouchTarget('web')).toBe(touchTarget.web44);
    expect(resolveMinimumTouchTarget('windows')).toBe(touchTarget.ios44);
  });

  it('exposes theme.touchTarget.minimum for the current Platform.OS', () => {
    const theme = createAppTheme('dark');
    expect(theme.touchTarget.minimum).toBe(resolveMinimumTouchTarget());
  });

  it('adds semantic typography roles while keeping every existing key', () => {
    const theme = createAppTheme('dark');

    expect(theme.typography.largeTitle).toMatchObject({ fontSize: 28, lineHeight: 34, fontWeight: '700' });
    expect(theme.typography.title).toMatchObject({ fontSize: 22, lineHeight: 28, fontWeight: '700' });
    expect(theme.typography.headline).toMatchObject({ fontSize: 17, lineHeight: 22, fontWeight: '600' });
    expect(theme.typography.subheadline).toMatchObject({
      fontSize: 15,
      lineHeight: 20,
      fontWeight: '600',
    });
    expect(theme.typography.body).toMatchObject({ fontSize: 16, lineHeight: 22, fontWeight: '400' });
    expect(theme.typography.caption).toMatchObject({ fontSize: 13, lineHeight: 18, fontWeight: '400' });
    expect(theme.typography.label).toMatchObject({ fontSize: 12, lineHeight: 16, fontWeight: '600' });
    expect(theme.typography.metadata).toMatchObject({
      fontSize: 11,
      lineHeight: 14,
      fontWeight: '500',
    });
    expect(theme.typography.mono).toMatchObject({ fontSize: 13, lineHeight: 19 });
  });

  it('keeps every typography role at or above the 11pt floor with a defined lineHeight', () => {
    const theme = createAppTheme('dark');

    for (const role of TYPOGRAPHY_ROLES) {
      const style = theme.typography[role];
      expect(style.fontSize).toBeDefined();
      expect(style.fontSize as number).toBeGreaterThanOrEqual(11);
      expect(style.lineHeight).toBeDefined();
      expect(style.lineHeight as number).toBeGreaterThan(style.fontSize as number);
    }
  });
});
