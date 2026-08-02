import { ScrollView, View } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../theme';
import { ScrollableRowText, withTransparentAlpha } from './chatMessagePrimitives';

jest.mock('expo-linear-gradient', () => {
  const { View } = jest.requireActual('react-native');
  return { LinearGradient: (props: Record<string, unknown>) => <View {...props} /> };
});

type Queryable = ReactTestInstance & {
  type: unknown;
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

function renderRow(backgroundColor: string): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={createAppTheme('light')}>
        <ScrollableRowText style={{}} backgroundColor={backgroundColor} numberOfLines={1}>
          A command that is intentionally wider than its viewport
        </ScrollableRowText>
      </AppThemeProvider>,
    );
  });
  if (!tree) {
    throw new Error('Expected scrollable row');
  }
  return tree;
}

function gradients(root: Queryable): Queryable[] {
  return root.findAll(
    (node) =>
      Array.isArray(node.props['colors']) &&
      node.props['pointerEvents'] === 'none' &&
      node.type === View,
  );
}

describe('ScrollableRowText', () => {
  it('fades overflowing text horizontally into the exact parent surface', () => {
    const backgroundColor = '#E3E0F7';
    const tree = renderRow(backgroundColor);
    const root = tree.root as Queryable;
    const scrollView = root.findAll((node) => node.type === ScrollView)[0];
    if (!scrollView) {
      throw new Error('Expected horizontal scroll view');
    }

    act(() => {
      (scrollView.props['onLayout'] as (event: unknown) => void)({
        nativeEvent: { layout: { width: 100 } },
      });
      (scrollView.props['onContentSizeChange'] as (width: number, height: number) => void)(240, 18);
    });

    const rightFade = gradients(root)[0];
    expect(rightFade?.props['colors']).toEqual(['#E3E0F700', backgroundColor]);
    expect(rightFade?.props['start']).toEqual({ x: 0, y: 0.5 });
    expect(rightFade?.props['end']).toEqual({ x: 1, y: 0.5 });

    act(() => {
      (scrollView.props['onScroll'] as (event: unknown) => void)({
        nativeEvent: { contentOffset: { x: 40 } },
      });
    });

    const [leftFade, scrolledRightFade] = gradients(root);
    expect(leftFade?.props['colors']).toEqual([backgroundColor, '#E3E0F700']);
    expect(scrolledRightFade?.props['colors']).toEqual(['#E3E0F700', backgroundColor]);
    expect(leftFade?.props['start']).toEqual({ x: 0, y: 0.5 });
    expect(leftFade?.props['end']).toEqual({ x: 1, y: 0.5 });

    act(() => tree.unmount());
  });

  it('preserves the surface RGB while removing alpha for dark and translucent themes', () => {
    expect(withTransparentAlpha('#17152B')).toBe('#17152B00');
    expect(withTransparentAlpha('#abc')).toBe('#aabbcc00');
    expect(withTransparentAlpha('rgba(239, 68, 68, 0.15)')).toBe('rgba(239, 68, 68, 0)');
  });
});
