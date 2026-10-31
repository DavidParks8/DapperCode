import { render, screen } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { SettingsButtonRow } from './localSettingsUi';

type Rgb = [number, number, number];

function parse(color: string): { rgb: Rgb; alpha: number } {
  const rgba = /^rgba?\(([^)]+)\)$/u.exec(color);
  if (rgba) {
    const [r = 0, g = 0, b = 0, alpha = 1] = rgba[1]!.split(',').map(Number);
    return { rgb: [r, g, b], alpha };
  }
  const hex = color.replace('#', '');
  return {
    rgb: [0, 2, 4].map((start) => parseInt(hex.slice(start, start + 2), 16)) as Rgb,
    alpha: 1,
  };
}

function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast of a (possibly translucent) text color drawn on an opaque background. */
function contrast(text: string, background: string): number {
  const fg = parse(text);
  const bg = parse(background).rgb;
  const blended = fg.rgb.map((channel, index) =>
    Math.round(channel * fg.alpha + bg[index]! * (1 - fg.alpha)),
  ) as Rgb;
  const [light, dark] = [luminance(blended), luminance(bg)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

function renderRow(theme: ReturnType<typeof createAppTheme>, disabled: boolean) {
  const view = render(
    <AppThemeProvider theme={theme}>
      <SettingsButtonRow label="Commit staged changes" disabled={disabled} onPress={jest.fn()} />
    </AppThemeProvider>,
  );
  const label = StyleSheet.flatten(
    screen.getByText('Commit staged changes').props['style'] as StyleProp<TextStyle>,
  );
  const row = screen.getByRole('button', { name: 'Commit staged changes' });
  const result = {
    color: String(label.color),
    opacity: StyleSheet.flatten(row.props['style'] as StyleProp<ViewStyle>)?.opacity ?? 1,
    state: row.props['accessibilityState'],
  };
  view.unmount();
  return result;
}

describe('SettingsButtonRow contrast', () => {
  it.each(['light', 'dark'] as const)(
    'keeps enabled and disabled actions legible in %s mode without fading the row',
    (mode) => {
      const theme = createAppTheme(mode);
      for (const disabled of [false, true]) {
        const row = renderRow(theme, disabled);
        expect(contrast(row.color, theme.colors.bgItem)).toBeGreaterThanOrEqual(4.5);
        expect(row.opacity).toBe(1);
        expect(row.state).toMatchObject({ disabled });
      }
    },
  );
});
