import { Platform, Text, View } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  getRenderedGlassContainerProps,
  setMockGlassEffectAPIAvailable,
  setMockLiquidGlassAvailable,
} from '@shared/testing/glassEffectMock';
import { GlassGroup } from '@shared/ui/glass/GlassGroup';

function setPlatformOs(value: typeof Platform.OS): void {
  Object.defineProperty(Platform, 'OS', { configurable: true, value });
}

function renderGroup(): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <GlassGroup spacing={8} testID="glass-group">
        <Text>Grouped control</Text>
      </GlassGroup>,
    );
  });
  if (!tree) {
    throw new Error('Glass group did not render');
  }
  return tree;
}

describe('GlassGroup', () => {
  const originalPlatformOs = Platform.OS;

  beforeEach(() => setPlatformOs('ios'));
  afterEach(() => setPlatformOs(originalPlatformOs));

  it('uses a plain view fallback without forwarding native-only spacing', () => {
    const tree = renderGroup();

    expect(getRenderedGlassContainerProps()).toHaveLength(0);
    expect(tree.root.findByType(View).props['spacing']).toBeUndefined();
    act(() => tree.unmount());
  });

  it('forwards spacing to the native glass container when available', () => {
    setMockLiquidGlassAvailable(true);
    setMockGlassEffectAPIAvailable(true);
    const tree = renderGroup();

    expect(getRenderedGlassContainerProps().at(-1)?.spacing).toBe(8);
    act(() => tree.unmount());
  });
});
