import * as Clipboard from 'expo-clipboard';
import { Modal, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { createMermaidAccessibilityLabel } from './mermaidAccessibility';
import { MermaidDiagram, resolveMermaidPreviewHeight } from './MermaidDiagram';
import { createMermaidDiagramStyles } from './mermaidDiagramStyles';

let mockRenderState:
  | {
      status: 'loading';
      result: null;
      error: null;
    }
  | {
      status: 'ready';
      result: { svg: string; width: number; height: number };
      error: null;
    }
  | {
      status: 'error';
      result: null;
      error: string;
    };
let mockCanvasProps: Record<string, unknown> | null = null;
const mockZoomIn = jest.fn();
const mockZoomOut = jest.fn();
const mockReset = jest.fn();

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));
jest.mock('react-native-svg/css', () => ({
  SvgCss: (props: Record<string, unknown>) => {
    const React = jest.requireActual('react');
    const ReactNative = jest.requireActual('react-native');
    return React.createElement(ReactNative.View, props);
  },
}));
jest.mock('./MermaidRenderProvider', () => ({
  useMermaidRender: () => mockRenderState,
}));
jest.mock('./MermaidCanvas', () => {
  const React = jest.requireActual('react');
  const ReactNative = jest.requireActual('react-native');
  return {
    MermaidCanvas: React.forwardRef(
      (props: Record<string, unknown>, ref: React.ForwardedRef<Record<string, unknown>>) => {
        mockCanvasProps = props;
        React.useImperativeHandle(ref, () => ({
          zoomIn: mockZoomIn,
          zoomOut: mockZoomOut,
          reset: mockReset,
        }));
        return React.createElement(ReactNative.View, { testID: 'mock-mermaid-canvas' });
      },
    ),
  };
});

type QueryableInstance = ReactTestInstance & {
  type: unknown;
  findAllByType(type: unknown): QueryableInstance[];
  findAllByProps(props: Record<string, unknown>): QueryableInstance[];
};
type QueryableRenderer = ReactTestRenderer & { root: QueryableInstance };

const readyResult = {
  svg: '<svg viewBox="0 0 600 300"><text>Diagram</text></svg>',
  width: 600,
  height: 300,
};

function renderDiagram(source = 'graph TD\n  A --> B'): QueryableRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 59, right: 0, bottom: 34, left: 0 },
        }}
      >
        <AppThemeProvider theme={createAppTheme('dark')}>
          <MermaidDiagram source={source} />
        </AppThemeProvider>
      </SafeAreaProvider>,
    );
  });
  if (!tree) {
    throw new Error('Expected Mermaid diagram tree');
  }
  return tree as QueryableRenderer;
}

function press(node: ReactTestInstance): void {
  const onPress = node.props['onPress'];
  if (typeof onPress !== 'function') {
    throw new Error('Expected press handler');
  }
  onPress();
}

function hasText(root: QueryableInstance, expected: string): boolean {
  return root
    .findAllByType(Text)
    .some((node: QueryableInstance) => flattenText(node.props['children']).includes(expected));
}

function flattenText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(flattenText).join('');
  }
  return '';
}

describe('MermaidDiagram', () => {
  beforeEach(() => {
    mockRenderState = { status: 'ready', result: readyResult, error: null };
    mockCanvasProps = null;
    mockZoomIn.mockClear();
    mockZoomOut.mockClear();
    mockReset.mockClear();
    jest.mocked(Clipboard.setStringAsync).mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('copies exact source and opens the rendered SVG in the full-screen viewer', async () => {
    const source = 'sequenceDiagram\n  Alice->>Bob: Hello';
    const tree = renderDiagram(source);
    const modal = tree.root.findByType(Modal);
    expect(modal.props['visible']).toBe(false);
    expect(tree.root.findByProps({ testID: 'mermaid-diagram' }).props).toMatchObject({
      accessibilityElementsHidden: false,
      importantForAccessibility: 'auto',
    });
    expect(tree.root.findByProps({ testID: 'mermaid-preview-svg' }).props['xml']).toBe(
      readyResult.svg,
    );
    expect(
      tree.root.findByProps({
        accessibilityLabel: 'Mermaid diagram. Source preview: sequenceDiagram Alice->>Bob: Hello.',
      }),
    ).toBeTruthy();

    await act(async () => {
      press(tree.root.findByProps({ testID: 'mermaid-copy-source' }));
      await Promise.resolve();
    });
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(source);
    expect(tree.root.findByProps({ accessibilityLabel: 'Mermaid source copied' })).toBeTruthy();

    act(() => press(tree.root.findByProps({ testID: 'mermaid-preview-open' })));
    expect(tree.root.findByType(Modal).props['visible']).toBe(true);
    expect(tree.root.findByProps({ testID: 'mermaid-diagram' }).props).toMatchObject({
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
    const zoomDockStyle = StyleSheet.flatten(
      tree.root.findByProps({ testID: 'mermaid-zoom-dock' }).props['style'] as StyleProp<ViewStyle>,
    );
    expect(zoomDockStyle?.bottom).toBeGreaterThan(34);
    expect(mockCanvasProps).toMatchObject({
      svg: readyResult.svg,
      width: readyResult.width,
      height: readyResult.height,
    });

    act(() => {
      const onRendered = mockCanvasProps?.['onRendered'];
      const onZoomChange = mockCanvasProps?.['onZoomChange'];
      if (typeof onRendered !== 'function' || typeof onZoomChange !== 'function') {
        throw new Error('Expected viewer callbacks');
      }
      onRendered();
      onZoomChange(2);
    });
    expect(hasText(tree.root, '200%')).toBe(true);
    expect(
      tree.root.findByProps({
        accessibilityLabel: 'Diagram zoom 200 percent. Reset to fit',
      }),
    ).toBeTruthy();
    expect(
      tree.root.findByProps({
        accessibilityRole: 'image',
        accessibilityLabel: 'Mermaid diagram. Source preview: sequenceDiagram Alice->>Bob: Hello.',
      }),
    ).toBeTruthy();

    act(() => {
      press(tree.root.findByProps({ testID: 'mermaid-zoom-in' }));
      press(tree.root.findByProps({ testID: 'mermaid-zoom-out' }));
      press(tree.root.findByProps({ testID: 'mermaid-zoom-reset' }));
    });
    expect(mockZoomIn).toHaveBeenCalledTimes(1);
    expect(mockZoomOut).toHaveBeenCalledTimes(1);
    expect(mockReset).toHaveBeenCalledTimes(1);

    act(() => {
      const onLoading = mockCanvasProps?.['onLoading'];
      if (typeof onLoading !== 'function') {
        throw new Error('Expected viewer loading callback');
      }
      onLoading();
    });
    expect(
      tree.root.findByProps({
        accessibilityLabel: 'Preparing full-screen Mermaid diagram',
      }),
    ).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'mermaid-zoom-in' }).props['disabled']).toBe(true);
    expect(tree.root.findByProps({ testID: 'mermaid-zoom-out' }).props['disabled']).toBe(true);

    act(() => {
      const onRequestClose = tree.root.findByType(Modal).props['onRequestClose'];
      if (typeof onRequestClose !== 'function') {
        throw new Error('Expected modal back handler');
      }
      onRequestClose();
    });
    expect(tree.root.findByType(Modal).props['visible']).toBe(false);
    act(() => tree.unmount());
  });

  it('shows explicit loading and renderer-error states without hiding the raw source', () => {
    mockRenderState = { status: 'loading', result: null, error: null };
    const loadingTree = renderDiagram();
    expect(
      loadingTree.root.findByProps({ accessibilityLabel: 'Rendering Mermaid diagram' }),
    ).toBeTruthy();
    expect(loadingTree.root.findByProps({ testID: 'mermaid-expand' }).props['disabled']).toBe(true);
    act(() => press(loadingTree.root.findByProps({ testID: 'mermaid-expand' })));
    expect(loadingTree.root.findAllByType(Modal)).toHaveLength(0);
    act(() => loadingTree.unmount());

    const source = 'graph TD\n  broken -->';
    mockRenderState = {
      status: 'error',
      result: null,
      error: 'Parse error on line 2',
    };
    const errorTree = renderDiagram(source);
    expect(hasText(errorTree.root, 'Couldn’t render this diagram')).toBe(true);
    expect(hasText(errorTree.root, 'Parse error on line 2')).toBe(true);
    expect(hasText(errorTree.root, source)).toBe(true);
    expect(
      errorTree.root
        .findAllByProps({ accessibilityRole: 'alert' })
        .filter((node) => node.type === View),
    ).toHaveLength(1);
    act(() => errorTree.unmount());
  });

  it('surfaces viewer failure and keeps zoom controls disabled', () => {
    const tree = renderDiagram();
    act(() => press(tree.root.findByProps({ testID: 'mermaid-expand' })));
    act(() => {
      const onError = mockCanvasProps?.['onError'];
      if (typeof onError !== 'function') {
        throw new Error('Expected viewer error callback');
      }
      onError('The renderer stopped unexpectedly.');
    });
    expect(hasText(tree.root, 'Couldn’t open the diagram')).toBe(true);
    expect(tree.root.findByProps({ testID: 'mermaid-zoom-in' }).props['disabled']).toBe(true);
    expect(tree.root.findByProps({ testID: 'mermaid-zoom-out' }).props['disabled']).toBe(true);
    act(() => tree.unmount());
  });

  it('clamps inline previews for very wide and very tall diagrams', () => {
    expect(resolveMermaidPreviewHeight(300, { width: 600, height: 300 })).toBe(150);
    expect(resolveMermaidPreviewHeight(300, { width: 3000, height: 100 })).toBe(148);
    expect(resolveMermaidPreviewHeight(300, { width: 100, height: 3000 })).toBe(320);
    expect(resolveMermaidPreviewHeight(0, readyResult)).toBe(196);
    expect(resolveMermaidPreviewHeight(300, null)).toBe(196);
  });

  it('updates preview geometry only for valid measured widths', () => {
    const tree = renderDiagram();
    const onLayout = tree.root.findByProps({ testID: 'mermaid-preview' }).props['onLayout'];
    if (typeof onLayout !== 'function') {
      throw new Error('Expected preview layout handler');
    }
    act(() => {
      onLayout({ nativeEvent: { layout: { width: 300 } } });
    });
    expect(
      StyleSheet.flatten(
        tree.root.findByProps({ testID: 'mermaid-preview' }).props['style'] as StyleProp<ViewStyle>,
      )?.height,
    ).toBe(150);
    act(() => {
      onLayout({ nativeEvent: { layout: { width: Number.NaN } } });
    });
    expect(
      StyleSheet.flatten(
        tree.root.findByProps({ testID: 'mermaid-preview' }).props['style'] as StyleProp<ViewStyle>,
      )?.height,
    ).toBe(150);
    act(() => tree.unmount());
  });

  it('surfaces copy failure, supports retry, and resets copied feedback', async () => {
    jest.useFakeTimers();
    jest.mocked(Clipboard.setStringAsync).mockRejectedValueOnce(new Error('clipboard unavailable'));
    const tree = renderDiagram();

    await act(async () => {
      press(tree.root.findByProps({ testID: 'mermaid-copy-source' }));
      await Promise.resolve();
    });
    expect(
      tree.root.findByProps({
        accessibilityLabel: 'Copy Mermaid source failed. Try again',
      }),
    ).toBeTruthy();
    expect(hasText(tree.root, 'Retry')).toBe(true);

    jest.mocked(Clipboard.setStringAsync).mockResolvedValueOnce(true);
    await act(async () => {
      press(tree.root.findByProps({ testID: 'mermaid-copy-source' }));
      await Promise.resolve();
    });
    expect(tree.root.findByProps({ accessibilityLabel: 'Mermaid source copied' })).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(1_600);
    });
    expect(tree.root.findByProps({ accessibilityLabel: 'Copy Mermaid source' })).toBeTruthy();
    act(() => tree.unmount());
  });

  it('keeps accessibility descriptions concise for empty and long source', () => {
    expect(createMermaidAccessibilityLabel('')).toBe('Empty Mermaid diagram.');
    const label = createMermaidAccessibilityLabel(`graph TD\n${'A-->B;'.repeat(100)}`);
    expect(label).toContain('Source preview truncated.');
    expect(label.length).toBeLessThanOrEqual(220);
  });

  it('uses theme-appropriate viewer dock shadows', () => {
    const darkShadow = StyleSheet.flatten(
      createMermaidDiagramStyles(createAppTheme('dark')).zoomDock,
    )?.boxShadow;
    const lightShadow = StyleSheet.flatten(
      createMermaidDiagramStyles(createAppTheme('light')).zoomDock,
    )?.boxShadow;
    expect(darkShadow).not.toBe(lightShadow);
  });
});
