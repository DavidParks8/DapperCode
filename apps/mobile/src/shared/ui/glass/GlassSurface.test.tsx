import { Text, View } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  getRenderedGlassViewProps,
  setMockGlassEffectAPIAvailable,
  setMockLiquidGlassAvailable,
} from '@shared/testing/glassEffectMock';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';

function renderSurface(node: React.ReactNode, theme = createAppTheme('light')): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<AppThemeProvider theme={theme}>{node}</AppThemeProvider>);
  });
  if (!tree) {
    throw new Error('Glass surface did not render');
  }
  return tree;
}

function latestGlassViewProps() {
  const props = getRenderedGlassViewProps().at(-1);
  if (!props) {
    throw new Error('GlassView was not rendered');
  }
  return props;
}

describe('GlassSurface', () => {
  it('uses a solid surface and disables the effect when glass is unavailable', () => {
    const theme = createAppTheme('light');
    const tree = renderSurface(
      <GlassSurface role="chrome" testID="glass-surface" style={{ borderWidth: 1 }}>
        <Text>Chrome</Text>
      </GlassSurface>,
      theme,
    );

    const props = latestGlassViewProps();
    expect(props.glassEffectStyle).toBe('none');
    expect(props.tintColor).toBeUndefined();
    expect(props.colorScheme).toBe('light');
    expect(props.style).toEqual([
      {},
      {
        backgroundColor: theme.glass.chrome.fallbackBackgroundColor,
        borderColor: theme.glass.chrome.fallbackBorderColor,
        borderWidth: 1,
      },
    ]);
    expect(tree.root.findByProps({ testID: 'glass-surface' })).toBeTruthy();
    expect(tree.root.findByType(Text).props['children']).toBe('Chrome');
  });

  it('uses the native material without a fallback background when glass is available', () => {
    setMockLiquidGlassAvailable(true);
    setMockGlassEffectAPIAvailable(true);
    const theme = createAppTheme('dark');

    renderSurface(<GlassSurface role="capsule" testID="glass-surface" />, theme);

    const props = latestGlassViewProps();
    expect(props.glassEffectStyle).toBe(theme.glass.capsule.glassEffectStyle);
    expect(props.tintColor).toBe(theme.glass.capsule.tintColor);
    expect(props.colorScheme).toBe('dark');
    expect(props.style).toEqual([{}, undefined]);
  });

  it('does not allow a caller background to flatten the native material', () => {
    setMockLiquidGlassAvailable(true);
    setMockGlassEffectAPIAvailable(true);
    const warn = jest.spyOn(console, 'warn').mockImplementation();

    renderSurface(
      <GlassSurface
        role="chrome"
        style={{ backgroundColor: '#ff00ff', borderColor: '#ff00ff', borderWidth: 4 }}
      />,
    );

    const props = latestGlassViewProps();
    expect(props.style).toEqual([{}, undefined]);
    expect(warn).toHaveBeenCalledWith(
      'GlassSurface owns backgroundColor and borderColor. Remove those properties from the calling style instead.',
    );
    warn.mockRestore();
  });

  it('forwards layout, accessibility, and interactive props in both modes', () => {
    const tree = renderSurface(
      <GlassSurface
        accessibilityLabel="Composer"
        accessibilityRole="button"
        isInteractive
        role="capsule"
        style={{ borderRadius: 22, minHeight: 44 }}
        testID="glass-surface"
      >
        <View testID="glass-child" />
      </GlassSurface>,
    );

    const props = latestGlassViewProps();
    expect(props.isInteractive).toBe(true);
    expect(props.accessibilityLabel).toBe('Composer');
    expect(props.accessibilityRole).toBe('button');
    expect(props.style).toEqual([{ borderRadius: 22, minHeight: 44 }, expect.any(Object)]);
    expect(tree.root.findByProps({ testID: 'glass-child' })).toBeTruthy();
  });
});
