import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { MermaidDiagram } from './MermaidDiagram';
import { clearMermaidRenderCacheForTests, MermaidRenderProvider } from './MermaidRenderProvider';
import { MermaidLoadingCanvas } from './MermaidStreamingPlaceholder';

type QueryableInstance = ReactTestInstance & {
  findAllByType(type: unknown): QueryableInstance[];
};
type QueryableRenderer = ReactTestRenderer & { root: QueryableInstance };

let mockFrameProps: Record<string, unknown> | null = null;
const mockPostMessage = jest.fn<boolean, [string]>(() => true);

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
jest.mock('@expo/vector-icons', () => {
  const React = jest.requireActual('react');
  const ReactNative = jest.requireActual('react-native');
  return {
    Ionicons: (props: Record<string, unknown>) => React.createElement(ReactNative.View, props),
  };
});
jest.mock('react-native-svg/css', () => ({
  SvgCss: (props: Record<string, unknown>) => {
    const React = jest.requireActual('react');
    const ReactNative = jest.requireActual('react-native');
    return React.createElement(ReactNative.View, props);
  },
}));
jest.mock('./MermaidFrame', () => {
  const React = jest.requireActual('react');
  const ReactNative = jest.requireActual('react-native');
  return {
    MermaidFrame: React.forwardRef(
      (props: Record<string, unknown>, ref: React.ForwardedRef<Record<string, unknown>>) => {
        mockFrameProps = props;
        React.useImperativeHandle(ref, () => ({ postMessage: mockPostMessage }));
        return React.createElement(ReactNative.View, { testID: props['testID'] });
      },
    ),
  };
});

const source = 'sequenceDiagram\n  Client->>Server: Restore cached diagram';

function element() {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 59, right: 0, bottom: 34, left: 0 },
      }}
    >
      <AppThemeProvider theme={createAppTheme('dark')}>
        <MermaidRenderProvider>
          <MermaidDiagram source={source} />
        </MermaidRenderProvider>
      </AppThemeProvider>
    </SafeAreaProvider>
  );
}

function invokeFrameMessage(message: Record<string, unknown>): void {
  const onMessage = mockFrameProps?.['onMessage'];
  if (typeof onMessage !== 'function') {
    throw new Error('Expected Mermaid frame message handler');
  }
  onMessage(JSON.stringify(message));
}

function latestCommand(): Record<string, unknown> {
  const raw = mockPostMessage.mock.calls.at(-1)?.[0];
  if (!raw) {
    throw new Error('Expected Mermaid render command');
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Mermaid session restoration', () => {
  beforeEach(() => {
    clearMermaidRenderCacheForTests();
    mockFrameProps = null;
    mockPostMessage.mockClear();
  });

  afterEach(() => {
    clearMermaidRenderCacheForTests();
  });

  it('restores the SVG and controls after switching away and back', async () => {
    let firstTree: QueryableRenderer | undefined;
    act(() => {
      firstTree = renderer.create(element()) as QueryableRenderer;
    });
    await flushEffects();
    expect(firstTree?.root.findByProps({ testID: 'mermaid-render-loading' })).toBeTruthy();
    expect(firstTree?.root.findByProps({ testID: 'mermaid-expand' }).props['disabled']).toBe(true);

    await act(async () => {
      invokeFrameMessage({ type: 'ready' });
      await Promise.resolve();
    });
    const command = latestCommand();
    await act(async () => {
      invokeFrameMessage({
        type: 'rendered',
        id: command['id'],
        width: 400,
        height: 200,
        svg: '<svg viewBox="0 0 400 200"><text>Restore cached diagram</text></svg>',
      });
      await Promise.resolve();
    });

    expect(firstTree?.root.findAllByType(MermaidLoadingCanvas)).toHaveLength(0);
    expect(firstTree?.root.findByProps({ testID: 'mermaid-preview-svg' })).toBeTruthy();
    expect(firstTree?.root.findByProps({ testID: 'mermaid-expand' }).props['disabled']).toBe(false);
    act(() => firstTree?.unmount());

    mockFrameProps = null;
    mockPostMessage.mockClear();
    let restoredTree: QueryableRenderer | undefined;
    act(() => {
      restoredTree = renderer.create(element()) as QueryableRenderer;
    });
    await flushEffects();

    expect(restoredTree?.root.findAllByType(MermaidLoadingCanvas)).toHaveLength(0);
    expect(restoredTree?.root.findByProps({ testID: 'mermaid-preview-svg' })).toBeTruthy();
    expect(restoredTree?.root.findByProps({ testID: 'mermaid-expand' }).props['disabled']).toBe(
      false,
    );
    expect(mockFrameProps).toBeNull();
    expect(mockPostMessage).not.toHaveBeenCalled();

    act(() => restoredTree?.unmount());
  });
});
