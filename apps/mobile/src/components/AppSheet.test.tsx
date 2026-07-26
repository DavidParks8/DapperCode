import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppSheet } from './AppSheet';
import { AppThemeProvider, createAppTheme } from '../theme';

const theme = createAppTheme('dark');
const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrap(node: React.ReactNode) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <AppThemeProvider theme={theme}>{node}</AppThemeProvider>
    </SafeAreaProvider>
  );
}

type Queryable = Omit<ReactTestInstance, 'props' | 'findAll'> & {
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

function textOf(tree: ReactTestRenderer): string {
  return JSON.stringify((tree as unknown as { toJSON: () => unknown }).toJSON() ?? null);
}

describe('AppSheet', () => {
  it('mounts content while visible and unmounts it when closed', () => {
    const onClose = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(
          <AppSheet visible={false} onClose={onClose} accessibilityLabel="Picker">
            <Text>Sheet body</Text>
          </AppSheet>,
        ),
      );
    });
    if (!tree) throw new Error('Expected sheet tree');
    expect(textOf(tree)).not.toContain('Sheet body');

    act(() => {
      tree?.update(
        wrap(
          <AppSheet visible onClose={onClose} accessibilityLabel="Picker">
            <Text>Sheet body</Text>
          </AppSheet>,
        ),
      );
    });
    expect(textOf(tree)).toContain('Sheet body');
    expect(onClose).not.toHaveBeenCalled();

    // Closing through the `visible` prop must not echo back into onClose.
    act(() => {
      tree?.update(
        wrap(
          <AppSheet visible={false} onClose={onClose} accessibilityLabel="Picker">
            <Text>Sheet body</Text>
          </AppSheet>,
        ),
      );
    });
    expect(textOf(tree)).not.toContain('Sheet body');
    expect(onClose).not.toHaveBeenCalled();
    act(() => tree?.unmount());
  });

  it('reports a user dismissal once, and only while visible', () => {
    const onClose = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(
          <AppSheet visible onClose={onClose} scrollable maxDynamicContentSize={400}>
            <Text>Scrollable body</Text>
          </AppSheet>,
        ),
      );
    });
    if (!tree) throw new Error('Expected sheet tree');
    expect(textOf(tree)).toContain('Scrollable body');

    const sheet = (tree.root as unknown as Queryable).findAll(
      (node) => typeof node.props.onDismiss === 'function',
    )[0];
    act(() => (sheet.props.onDismiss as () => void)());
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => tree?.unmount());
  });

  it('renders a non-dismissible sheet with fixed snap points', () => {
    const onClose = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(
          <AppSheet
            visible
            onClose={onClose}
            dismissible={false}
            snapPoints={['50%']}
            contentBottomInset={12}
          >
            <Text>Locked body</Text>
          </AppSheet>,
        ),
      );
    });
    if (!tree) throw new Error('Expected sheet tree');
    expect(textOf(tree)).toContain('Locked body');
    act(() => tree?.unmount());
  });
});
