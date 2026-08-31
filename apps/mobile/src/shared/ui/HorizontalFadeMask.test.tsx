import MaskedView from '@react-native-masked-view/masked-view';
import { Text } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { HorizontalFadeMask } from './HorizontalFadeMask';

type Queryable = ReactTestInstance & {
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByProps(props: Record<string, unknown>): Queryable[];
  findAllByType(type: unknown): Queryable[];
};
type QueryableRenderer = ReactTestRenderer & { root: Queryable };

const MASK_CLEAR = 'rgba(0, 0, 0, 0)';
const MASK_OPAQUE = 'rgba(0, 0, 0, 1)';
const theme = createAppTheme('dark');

function render(props: {
  active: boolean;
  fadeStart: boolean;
  fadeEnd: boolean;
}): QueryableRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={theme}>
        <HorizontalFadeMask {...props} testID="fade">
          <Text>content</Text>
        </HorizontalFadeMask>
      </AppThemeProvider>,
    );
  });
  if (!tree) {
    throw new Error('Expected a rendered mask');
  }
  return tree as QueryableRenderer;
}

function edge(tree: QueryableRenderer, testID: string) {
  return tree.root.findAllByProps({ testID })[0];
}

describe('HorizontalFadeMask', () => {
  it('renders a plain container while the content fits', () => {
    const tree = render({ active: false, fadeStart: false, fadeEnd: false });

    expect(tree.root.findAllByType(MaskedView)).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'fade-fade-start' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'fade-fade-end' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'fade' }).length).toBeGreaterThan(0);

    act(() => tree.unmount());
  });

  it('masks the content with alpha ramps rather than painting over it', () => {
    const tree = render({ active: true, fadeStart: true, fadeEnd: true });

    expect(tree.root.findAllByType(MaskedView)).toHaveLength(1);
    expect(edge(tree, 'fade-fade-start')?.props['colors']).toEqual([MASK_CLEAR, MASK_OPAQUE]);
    expect(edge(tree, 'fade-fade-end')?.props['colors']).toEqual([MASK_OPAQUE, MASK_CLEAR]);
    for (const testID of ['fade-fade-start', 'fade-fade-end']) {
      expect(edge(tree, testID)?.props['style']).toMatchObject({ width: theme.spacing.xl });
    }
    expect(tree.root.findAllByType(Text)).toHaveLength(1);

    act(() => tree.unmount());
  });

  it('only fades the edge that can still be scrolled toward', () => {
    const tree = render({ active: true, fadeStart: false, fadeEnd: true });

    expect(tree.root.findAllByProps({ testID: 'fade-fade-start' })).toHaveLength(0);
    expect(edge(tree, 'fade-fade-end')?.props['colors']).toEqual([MASK_OPAQUE, MASK_CLEAR]);

    act(() => tree.unmount());
  });

  it('masks without test identifiers when none are supplied', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <AppThemeProvider theme={theme}>
          <HorizontalFadeMask active fadeStart fadeEnd>
            <Text>content</Text>
          </HorizontalFadeMask>
        </AppThemeProvider>,
      );
    });
    const masked = (tree as QueryableRenderer).root.findAllByType(MaskedView)[0];
    expect(masked?.props['testID']).toBeUndefined();
    expect(
      (tree as QueryableRenderer).root.findAll(
        (node) => Array.isArray(node.props['colors']) && node.props['testID'] !== undefined,
      ),
    ).toHaveLength(0);

    act(() => tree?.unmount());
  });
});
