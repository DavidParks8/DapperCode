import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { setMockReducedMotionEnabled } from '@shared/testing/reanimatedMock';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { MermaidLoadingCanvas, MermaidStreamingPlaceholder } from './MermaidStreamingPlaceholder';

jest.mock('@expo/vector-icons', () => {
  const React = jest.requireActual('react');
  const ReactNative = jest.requireActual('react-native');
  return {
    Ionicons: (props: Record<string, unknown>) => React.createElement(ReactNative.View, props),
  };
});

type QueryableRenderer = ReactTestRenderer & {
  root: {
    findByProps(props: Record<string, unknown>): {
      props: Record<string, unknown>;
    };
    findAllByType(type: unknown): Array<{ props: Record<string, unknown> }>;
  };
};

function renderWithTheme(children: ReactNode): QueryableRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={createAppTheme('dark')}>{children}</AppThemeProvider>,
    );
  });
  if (!tree) {
    throw new Error('Expected Mermaid loading tree');
  }
  return tree as QueryableRenderer;
}

describe('MermaidStreamingPlaceholder', () => {
  beforeEach(() => {
    setMockReducedMotionEnabled(false);
  });

  afterEach(() => {
    setMockReducedMotionEnabled(false);
  });

  it('presents an accessible diagram-shaped loading state without exposing partial source', () => {
    const tree = renderWithTheme(<MermaidStreamingPlaceholder />);

    expect(tree.root.findByProps({ testID: 'mermaid-streaming-placeholder' })).toBeTruthy();
    expect(
      tree.root.findByProps({
        accessibilityRole: 'progressbar',
        accessibilityLabel: 'Building Mermaid diagram',
      }).props['accessibilityState'],
    ).toEqual({ busy: true });
    expect(tree.root.findByProps({ testID: 'mermaid-loading-route-left' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'mermaid-loading-route-right' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'mermaid-loading-node-root' })).toBeTruthy();
    expect(
      tree.root.findAllByType(Text).some((node) => node.props['children'] === 'Building'),
    ).toBe(true);

    act(() => tree.unmount());
  });

  it('holds a completed graph frame when Reduce Motion is enabled', () => {
    setMockReducedMotionEnabled(true);
    const tree = renderWithTheme(
      <View style={StyleSheet.absoluteFill}>
        <MermaidLoadingCanvas
          testID="reduced-motion-canvas"
          accessibilityLabel="Building Mermaid diagram"
        />
      </View>,
    );

    expect(
      tree.root.findByProps({ testID: 'mermaid-loading-route-left' }).props['animatedProps'],
    ).toMatchObject({
      opacity: 1,
      strokeDashoffset: 0,
    });
    expect(
      tree.root.findByProps({ testID: 'mermaid-loading-route-right' }).props['animatedProps'],
    ).toMatchObject({
      opacity: 1,
      strokeDashoffset: 0,
    });

    act(() => tree.unmount());
  });
});
