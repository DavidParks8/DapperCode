import type { PropsWithChildren } from 'react';
import { Text, View } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  MERMAID_MAX_SOURCE_BYTES,
  MERMAID_MAX_SVG_BYTES,
  MERMAID_FRAME_STARTUP_TIMEOUT_MS,
  MERMAID_RENDER_TIMEOUT_MS,
  type MermaidThemePayload,
} from './mermaidProtocol';
import {
  clearMermaidRenderCacheForTests,
  MermaidRenderProvider,
  useMermaidRender,
} from './MermaidRenderProvider';

let mockFrameProps: Record<string, unknown> | null = null;
const mockPostMessage = jest.fn<boolean, [string]>(() => true);

jest.mock('./MermaidFrame', () => {
  const React = jest.requireActual('react');
  const ReactNative = jest.requireActual('react-native');
  return {
    MermaidFrame: React.forwardRef(
      (props: Record<string, unknown>, ref: React.ForwardedRef<Record<string, unknown>>) => {
        mockFrameProps = props;
        React.useImperativeHandle(ref, () => ({ postMessage: mockPostMessage }));
        return React.createElement(ReactNative.View, {
          testID: props['testID'],
        });
      },
    ),
  };
});

const theme: MermaidThemePayload = {
  background: '#000000',
  primaryTextColor: '#ffffff',
};

function Consumer({ source, testID }: { source: string; testID: string }) {
  const state = useMermaidRender(source, theme);
  return (
    <View testID={testID}>
      <Text>
        {state.status === 'ready'
          ? state.result.svg
          : state.status === 'error'
            ? state.error
            : 'loading'}
      </Text>
    </View>
  );
}

function Tree({ children }: PropsWithChildren): React.ReactElement {
  return <MermaidRenderProvider>{children}</MermaidRenderProvider>;
}

function requireFrameProps(): Record<string, unknown> {
  if (!mockFrameProps) {
    throw new Error('Expected the Mermaid render host');
  }
  return mockFrameProps;
}

function invokeFrame(name: 'onMessage' | 'onProcessTerminated', value?: unknown) {
  const callback = requireFrameProps()[name];
  if (typeof callback !== 'function') {
    throw new Error(`Expected ${name}`);
  }
  (callback as (input?: unknown) => void)(value);
}

function markFrameReady() {
  invokeFrame('onMessage', JSON.stringify({ type: 'ready' }));
}

function latestCommand(): Record<string, unknown> {
  const call = mockPostMessage.mock.calls.at(-1)?.[0];
  if (typeof call !== 'string') {
    throw new Error('Expected a renderer command');
  }
  return JSON.parse(call) as Record<string, unknown>;
}

function readConsumerText(tree: ReactTestRenderer | undefined, testID: string): string {
  const node = tree?.root.findByProps({ testID });
  if (!node) {
    throw new Error(`Expected consumer ${testID}`);
  }
  const flatten = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map(flatten).join('');
    }
    if (typeof value === 'object' && value !== null && 'children' in value) {
      return flatten(value.children);
    }
    return '';
  };
  return flatten(node.findByType(Text).props['children']);
}

describe('MermaidRenderProvider', () => {
  beforeEach(() => {
    clearMermaidRenderCacheForTests();
    mockFrameProps = null;
    mockPostMessage.mockClear();
    mockPostMessage.mockReturnValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('deduplicates concurrent renders and serves later consumers from its bounded cache', async () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <Tree>
          <Consumer source="graph TD; A-->B" testID="first" />
          <Consumer source="graph TD; A-->B" testID="second" />
        </Tree>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockPostMessage).not.toHaveBeenCalled();

    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const command = latestCommand();
    expect(command).toMatchObject({
      type: 'render',
      source: 'graph TD; A-->B',
      theme,
    });

    await act(async () => {
      invokeFrame(
        'onMessage',
        JSON.stringify({
          type: 'rendered',
          id: command['id'],
          width: 400,
          height: 200,
          svg: '<svg viewBox="0 0 400 200"/>',
        }),
      );
      await Promise.resolve();
    });
    expect(readConsumerText(tree, 'first')).toContain('<svg');
    expect(readConsumerText(tree, 'second')).toContain('<svg');

    await act(async () => {
      tree?.update(
        <Tree>
          <Consumer source="graph TD; A-->B" testID="first" />
          <Consumer source="graph TD; A-->B" testID="second" />
          <Consumer source="graph TD; A-->B" testID="third" />
        </Tree>,
      );
      await Promise.resolve();
    });
    expect(readConsumerText(tree, 'third')).toContain('<svg');
    expect(mockPostMessage).toHaveBeenCalledTimes(1);

    act(() => tree?.unmount());
  });

  it('restores a rendered diagram after its provider unmounts during a session switch', async () => {
    const source = 'sequenceDiagram\n  Client->>Server: Cached session';
    let firstTree: ReactTestRenderer | undefined;
    act(() => {
      firstTree = renderer.create(
        <Tree>
          <Consumer source={source} testID="result" />
        </Tree>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      markFrameReady();
      await Promise.resolve();
    });
    const command = latestCommand();
    await act(async () => {
      invokeFrame(
        'onMessage',
        JSON.stringify({
          type: 'rendered',
          id: command['id'],
          width: 400,
          height: 200,
          svg: '<svg viewBox="0 0 400 200"><text>Cached session</text></svg>',
        }),
      );
      await Promise.resolve();
    });
    expect(readConsumerText(firstTree, 'result')).toContain('Cached session');
    act(() => firstTree?.unmount());

    mockFrameProps = null;
    mockPostMessage.mockClear();
    let restoredTree: ReactTestRenderer | undefined;
    act(() => {
      restoredTree = renderer.create(
        <Tree>
          <Consumer source={source} testID="result" />
        </Tree>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readConsumerText(restoredTree, 'result')).toContain('Cached session');
    expect(mockFrameProps).toBeNull();
    expect(mockPostMessage).not.toHaveBeenCalled();
    act(() => restoredTree?.unmount());
  });

  it('ignores malformed and stale responses before surfacing the active renderer error', async () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <Tree>
          <Consumer source="not a diagram" testID="result" />
        </Tree>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    const command = latestCommand();

    await act(async () => {
      invokeFrame('onMessage', 'bad-json');
      invokeFrame(
        'onMessage',
        JSON.stringify({
          type: 'rendered',
          id: 'stale-request',
          width: 1,
          height: 1,
          svg: '<svg/>',
        }),
      );
      await Promise.resolve();
    });
    expect(readConsumerText(tree, 'result')).toBe('loading');

    await act(async () => {
      invokeFrame(
        'onMessage',
        JSON.stringify({
          type: 'error',
          id: command['id'],
          message: 'Parse error on line 1',
        }),
      );
      await Promise.resolve();
    });
    expect(readConsumerText(tree, 'result')).toBe('Parse error on line 1');
    act(() => tree?.unmount());
  });

  it('rejects oversized source and SVG output at the service boundary', async () => {
    let sourceTree: ReactTestRenderer | undefined;
    act(() => {
      sourceTree = renderer.create(
        <Tree>
          <Consumer source={'🙂'.repeat(MERMAID_MAX_SOURCE_BYTES)} testID="source-limit" />
        </Tree>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(readConsumerText(sourceTree, 'source-limit')).toContain('too large');
    expect(mockPostMessage).not.toHaveBeenCalled();
    act(() => sourceTree?.unmount());

    mockFrameProps = null;
    let svgTree: ReactTestRenderer | undefined;
    act(() => {
      svgTree = renderer.create(
        <Tree>
          <Consumer source="graph TD; A-->B" testID="svg-limit" />
        </Tree>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    const command = latestCommand();
    await act(async () => {
      invokeFrame(
        'onMessage',
        JSON.stringify({
          type: 'rendered',
          id: command['id'],
          width: 10,
          height: 10,
          svg: `<svg>${'x'.repeat(MERMAID_MAX_SVG_BYTES)}</svg>`,
        }),
      );
      await Promise.resolve();
    });
    expect(readConsumerText(svgTree, 'svg-limit')).toContain('too complex');
    act(() => svgTree?.unmount());
  });

  it('times out the active request, recycles the host, and accepts the next diagram', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <Tree>
          <Consumer source="graph TD; A-->B" testID="result" />
        </Tree>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    expect(latestCommand()['source']).toBe('graph TD; A-->B');

    await act(async () => {
      jest.advanceTimersByTime(MERMAID_RENDER_TIMEOUT_MS);
      await Promise.resolve();
    });
    expect(readConsumerText(tree, 'result')).toContain('too long');

    await act(async () => {
      tree?.update(
        <Tree>
          <Consumer source="sequenceDiagram; A->>B: Hi" testID="result" />
        </Tree>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    expect(latestCommand()['source']).toBe('sequenceDiagram; A->>B: Hi');
    act(() => tree?.unmount());
  });

  it('surfaces renderer startup and postMessage failures instead of loading forever', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <Tree>
          <Consumer source="graph TD; A-->B" testID="result" />
        </Tree>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(MERMAID_FRAME_STARTUP_TIMEOUT_MS);
      await Promise.resolve();
    });
    expect(readConsumerText(tree, 'result')).toContain('too long to start');
    act(() => tree?.unmount());

    jest.useRealTimers();
    mockPostMessage.mockReturnValue(false);
    act(() => {
      tree = renderer.create(
        <Tree>
          <Consumer source="sequenceDiagram; A->>B: Hi" testID="result" />
        </Tree>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      markFrameReady();
      await Promise.resolve();
    });
    expect(readConsumerText(tree, 'result')).toContain('could not accept');
    act(() => tree?.unmount());
  });

  it('rejects a render when the native renderer process terminates and recovers its host', async () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <Tree>
          <Consumer source="graph TD; A-->B" testID="result" />
        </Tree>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      markFrameReady();
      await Promise.resolve();
    });
    expect(latestCommand()['source']).toBe('graph TD; A-->B');

    await act(async () => {
      invokeFrame('onProcessTerminated');
      await Promise.resolve();
    });
    expect(readConsumerText(tree, 'result')).toContain('stopped unexpectedly');

    await act(async () => {
      tree?.update(
        <Tree>
          <Consumer source="stateDiagram-v2; A --> B" testID="result" />
        </Tree>,
      );
      await Promise.resolve();
      markFrameReady();
      await Promise.resolve();
    });
    expect(latestCommand()['source']).toBe('stateDiagram-v2; A --> B');
    act(() => tree?.unmount());
  });
});
