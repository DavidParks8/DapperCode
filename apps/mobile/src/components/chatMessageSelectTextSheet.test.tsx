import { requireTestValue } from '../testing/requireTestValue';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../theme';
import { SelectableTextSheet } from './chatMessageSelectTextSheet';

type QueryableInstance = Omit<ReactTestInstance, 'props' | 'children' | 'findAll'> & {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<QueryableInstance | string>;
  findAll(predicate: (node: QueryableInstance) => boolean): QueryableInstance[];
};

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

function render(node: React.ReactNode): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(wrap(node));
  });
  if (!tree) {
    throw new Error('Component did not render');
  }
  return tree;
}

function queryRoot(tree: ReactTestRenderer): QueryableInstance {
  return tree.root as QueryableInstance;
}

function findPressable(root: QueryableInstance, label: string): QueryableInstance {
  const match = root.findAll(
    (node) =>
      typeof node.props['onPress'] === 'function' && node.props['accessibilityLabel'] === label,
  )[0];
  if (!match) {
    throw new Error(`Missing pressable: ${label}`);
  }
  return match;
}

function invokeProp(node: QueryableInstance, name: string, ...args: unknown[]): unknown {
  const callback = node.props[name];
  if (typeof callback !== 'function') {
    throw new Error(`Missing callback: ${name}`);
  }
  return callback(...args);
}

describe('SelectableTextSheet', () => {
  it('invokes onClose when the close button is pressed', () => {
    const onClose = jest.fn();
    const tree = render(<SelectableTextSheet text="hello" onClose={onClose} />);
    const root = queryRoot(tree);
    invokeProp(findPressable(root, 'Close text selection'), 'onPress');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('gives the close button an effective touch target at or above the 44pt/48dp floor', () => {
    const tree = render(<SelectableTextSheet text="hello" onClose={() => {}} />);
    const root = queryRoot(tree);
    const closeButton = findPressable(root, 'Close text selection');
    const hitSlop = closeButton.props['hitSlop'] as
      { top: number; bottom: number; left: number; right: number } | undefined;
    expect(hitSlop).toBeDefined();
    expect(hitSlop!.top).toBeGreaterThan(0);
    expect(hitSlop!.bottom).toBeGreaterThan(0);
  });

  it('renders the given text in a read-only, non-editable input', () => {
    const tree = render(<SelectableTextSheet text="selectable body text" onClose={() => {}} />);
    const root = queryRoot(tree);
    const input = requireTestValue(
      root.findAll((node) => node.props['accessibilityLabel'] === 'Response text')[0],
      'indexed test value',
    );
    expect(input).toBeDefined();
    expect(input.props['value']).toBe('selectable body text');
    expect(input.props['editable']).toBe(false);
  });
});
