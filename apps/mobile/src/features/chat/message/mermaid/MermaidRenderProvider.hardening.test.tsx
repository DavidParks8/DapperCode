import type { PropsWithChildren } from 'react';
import { Text, View } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  MERMAID_MAX_QUEUED_RENDERS,
  MERMAID_MAX_QUEUED_SOURCE_BYTES,
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
        return React.createElement(ReactNative.View, { testID: props['testID'] });
      },
    ),
  };
});

const theme = { background: '#000000', primaryTextColor: '#ffffff' };

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

function Tree({ children }: PropsWithChildren) {
  return <MermaidRenderProvider>{children}</MermaidRenderProvider>;
}

function invokeFrame(name: 'onError' | 'onMessage' | 'onProcessTerminated', value?: unknown) {
  const callback = mockFrameProps?.[name];
  if (typeof callback !== 'function') {
    throw new Error(`Expected ${name}`);
  }
  (callback as (input?: unknown) => void)(value);
}

function markFrameReady() {
  invokeFrame('onMessage', JSON.stringify({ type: 'ready' }));
}

function latestCommand(): Record<string, unknown> {
  const raw = mockPostMessage.mock.calls.at(-1)?.[0];
  if (!raw) {
    throw new Error('Expected a renderer command');
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function readText(tree: ReactTestRenderer | undefined, testID: string): string {
  const value = tree?.root.findByProps({ testID }).findByType(Text).props['children'];
  return typeof value === 'string' ? value : '';
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('MermaidRenderProvider hardening', () => {
  beforeEach(() => {
    mockFrameProps = null;
    mockPostMessage.mockClear();
  });

  it('cancels queued work when its consumer changes before rendering', async () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <Tree>
          <Consumer source="graph TD; Cancelled-->Work" testID="result" />
        </Tree>,
      );
    });
    await flushEffects();

    act(() => {
      tree?.update(
        <Tree>
          <Consumer source="graph TD; Current-->Work" testID="result" />
        </Tree>,
      );
    });
    await flushEffects();
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(latestCommand()['source']).toBe('graph TD; Current-->Work');
    act(() => tree?.unmount());
  });

  it('bounds queued diagrams by both count and combined source bytes', async () => {
    const countSources = Array.from(
      { length: MERMAID_MAX_QUEUED_RENDERS + 1 },
      (_, index) => `graph TD; Count${String(index)}-->Limit`,
    );
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <Tree>
          {countSources.map((source, index) => (
            <Consumer key={source} source={source} testID={`count-${String(index)}`} />
          ))}
        </Tree>,
      );
    });
    await flushEffects();
    expect(readText(tree, `count-${String(MERMAID_MAX_QUEUED_RENDERS)}`)).toContain(
      'Too many Mermaid diagrams',
    );
    act(() => tree?.unmount());

    mockFrameProps = null;
    const payload = 'x'.repeat(58 * 1024);
    const byteSourceCount = Math.floor(MERMAID_MAX_QUEUED_SOURCE_BYTES / (58 * 1024)) + 1;
    const byteSources = Array.from(
      { length: byteSourceCount },
      (_, index) => `graph TD; Byte${String(index)}["${payload}"]`,
    );
    act(() => {
      tree = renderer.create(
        <Tree>
          {byteSources.map((source, index) => (
            <Consumer key={source} source={source} testID={`bytes-${String(index)}`} />
          ))}
        </Tree>,
      );
    });
    await flushEffects();
    expect(readText(tree, `bytes-${String(byteSourceCount - 1)}`)).toContain(
      'queued Mermaid source is too large',
    );
    act(() => tree?.unmount());
  });

  it('serves a successful cached result after the renderer becomes fatal', async () => {
    const cachedSource = 'graph TD; Cached-->Diagram';
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <Tree>
          <Consumer source={cachedSource} testID="result" />
        </Tree>,
      );
    });
    await flushEffects();
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    const cachedCommand = latestCommand();
    await act(async () => {
      invokeFrame(
        'onMessage',
        JSON.stringify({
          type: 'rendered',
          id: cachedCommand['id'],
          width: 20,
          height: 10,
          svg: '<svg viewBox="0 0 20 10"/>',
        }),
      );
      await Promise.resolve();
    });

    for (const source of ['graph TD; Fail1-->X', 'graph TD; Fail2-->X', 'graph TD; Fail3-->X']) {
      act(() => {
        tree?.update(
          <Tree>
            <Consumer source={source} testID="result" />
          </Tree>,
        );
      });
      await flushEffects();
      if (latestCommand()['source'] !== source) {
        await act(async () => {
          markFrameReady();
          await Promise.resolve();
        });
      }
      expect(latestCommand()['source']).toBe(source);
      await act(async () => {
        invokeFrame('onProcessTerminated');
        await Promise.resolve();
      });
    }

    act(() => {
      tree?.update(
        <Tree>
          <Consumer source={cachedSource} testID="result" />
        </Tree>,
      );
    });
    await flushEffects();
    expect(readText(tree, 'result')).toContain('<svg');

    const recoveredSource = 'stateDiagram-v2; Recovered --> Renderer';
    act(() => {
      tree?.update(
        <Tree>
          <Consumer source={recoveredSource} testID="result" />
        </Tree>,
      );
    });
    await flushEffects();
    expect(readText(tree, 'result')).toBe('loading');
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    expect(latestCommand()['source']).toBe(recoveredSource);
    act(() => tree?.unmount());
  });

  it('surfaces host failures before readiness and while rendering', async () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <Tree>
          <Consumer source="graph TD; Waiting-->Host" testID="result" />
        </Tree>,
      );
    });
    await flushEffects();
    await act(async () => {
      invokeFrame('onError', 'Host load failed');
      await Promise.resolve();
    });
    expect(readText(tree, 'result')).toBe('Host load failed');

    act(() => {
      tree?.update(
        <Tree>
          <Consumer source="graph TD; Waiting-->Process" testID="result" />
        </Tree>,
      );
    });
    await flushEffects();
    await act(async () => {
      invokeFrame('onProcessTerminated');
      await Promise.resolve();
    });
    expect(readText(tree, 'result')).toContain('stopped unexpectedly');
    act(() => tree?.unmount());

    mockFrameProps = null;
    act(() => {
      tree = renderer.create(
        <Tree>
          <Consumer source="graph TD; Active-->Host" testID="result" />
        </Tree>,
      );
    });
    await flushEffects();
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
      invokeFrame('onError', 'Host crashed');
      await Promise.resolve();
    });
    expect(readText(tree, 'result')).toBe('Host crashed');
    act(() => tree?.unmount());
  });

  it('distinguishes missing SVG and unexpected active responses', async () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <Tree>
          <Consumer source="graph TD; Missing-->Svg" testID="result" />
        </Tree>,
      );
    });
    await flushEffects();
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    const missingSvgCommand = latestCommand();
    await act(async () => {
      invokeFrame(
        'onMessage',
        JSON.stringify({
          type: 'rendered',
          id: missingSvgCommand['id'],
          width: 20,
          height: 10,
        }),
      );
      await Promise.resolve();
    });
    expect(readText(tree, 'result')).toContain('no displayable SVG');

    act(() => {
      tree?.update(
        <Tree>
          <Consumer source="graph TD; Unexpected-->Response" testID="result" />
        </Tree>,
      );
    });
    await flushEffects();
    const unexpectedCommand = latestCommand();
    await act(async () => {
      invokeFrame(
        'onMessage',
        JSON.stringify({ type: 'viewState', id: unexpectedCommand['id'], zoom: 2 }),
      );
      await Promise.resolve();
    });
    expect(readText(tree, 'result')).toContain('unexpected response');
    act(() => tree?.unmount());
  });

  it('evicts least-recently-used results by entry and byte budgets', async () => {
    const sources = Array.from({ length: 9 }, (_, index) => `graph TD; Cache${String(index)}-->X`);
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <Tree>
          <Consumer source={sources[0] ?? ''} testID="result" />
        </Tree>,
      );
    });
    await flushEffects();
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    for (const source of sources) {
      if (latestCommand()['source'] !== source) {
        act(() => {
          tree?.update(
            <Tree>
              <Consumer source={source} testID="result" />
            </Tree>,
          );
        });
        await flushEffects();
      }
      const command = latestCommand();
      await act(async () => {
        invokeFrame(
          'onMessage',
          JSON.stringify({
            type: 'rendered',
            id: command['id'],
            width: 20,
            height: 10,
            svg: `<svg id="${source}"/>`,
          }),
        );
        await Promise.resolve();
      });
    }
    const callsAfterEntryFill = mockPostMessage.mock.calls.length;
    act(() => {
      tree?.update(
        <Tree>
          <Consumer source={sources[0] ?? ''} testID="result" />
        </Tree>,
      );
    });
    await flushEffects();
    expect(mockPostMessage).toHaveBeenCalledTimes(callsAfterEntryFill + 1);
    act(() => tree?.unmount());

    mockFrameProps = null;
    mockPostMessage.mockClear();
    const byteSources = Array.from(
      { length: 5 },
      (_, index) => `graph TD; Bytes${String(index)}-->X`,
    );
    const largeSvg = `<svg>${'x'.repeat(1_750_000)}</svg>`;
    act(() => {
      tree = renderer.create(
        <Tree>
          <Consumer source={byteSources[0] ?? ''} testID="result" />
        </Tree>,
      );
    });
    await flushEffects();
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    for (const source of byteSources) {
      if (latestCommand()['source'] !== source) {
        act(() => {
          tree?.update(
            <Tree>
              <Consumer source={source} testID="result" />
            </Tree>,
          );
        });
        await flushEffects();
      }
      const command = latestCommand();
      await act(async () => {
        invokeFrame(
          'onMessage',
          JSON.stringify({
            type: 'rendered',
            id: command['id'],
            width: 20,
            height: 10,
            svg: largeSvg,
          }),
        );
        await Promise.resolve();
      });
    }
    const callsAfterByteFill = mockPostMessage.mock.calls.length;
    act(() => {
      tree?.update(
        <Tree>
          <Consumer source={byteSources[0] ?? ''} testID="result" />
        </Tree>,
      );
    });
    await flushEffects();
    expect(mockPostMessage).toHaveBeenCalledTimes(callsAfterByteFill + 1);
    act(() => tree?.unmount());
  });
});
