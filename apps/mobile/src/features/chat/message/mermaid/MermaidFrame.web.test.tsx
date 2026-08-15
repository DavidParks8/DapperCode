/** @jest-environment jsdom */

import { createRef } from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { MermaidFrame } from './MermaidFrame.web';
import type { MermaidFrameHandle } from './MermaidFrame';

let mockIframeProps: Record<string, unknown> | null = null;
let mockFrameNode: { contentWindow: { postMessage: jest.Mock } | null };

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => {
      if (type === 'iframe') {
        mockIframeProps = props;
        const frameRef = props['ref'] as { current: typeof mockFrameNode } | undefined;
        if (frameRef) {
          frameRef.current = mockFrameNode;
        }
        const hostProps = { ...props };
        delete hostProps['ref'];
        return actual.createElement('mock-iframe', hostProps, ...children);
      }
      return actual.createElement(type, props, ...children);
    },
  };
});

function requireIframeProps(): Record<string, unknown> {
  if (!mockIframeProps) {
    throw new Error('Expected Mermaid iframe props');
  }
  return mockIframeProps;
}

describe('MermaidFrame web', () => {
  beforeEach(() => {
    mockIframeProps = null;
    mockFrameNode = { contentWindow: { postMessage: jest.fn() } };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sandboxes the runtime and accepts messages only from its own frame', () => {
    let messageHandler: ((event: MessageEvent<unknown>) => void) | null = null;
    const addEventListener = jest
      .spyOn(window, 'addEventListener')
      .mockImplementation((type, listener) => {
        if (type === 'message') {
          messageHandler = listener as (event: MessageEvent<unknown>) => void;
        }
      });
    const removeEventListener = jest.spyOn(window, 'removeEventListener').mockImplementation();
    const onMessage = jest.fn();
    const onError = jest.fn();
    const ref = createRef<MermaidFrameHandle>();
    let tree: ReactTestRenderer | undefined;

    act(() => {
      tree = renderer.create(
        <MermaidFrame
          ref={ref}
          testID="mermaid-render-host"
          onMessage={onMessage}
          onError={onError}
        />,
      );
    });
    const iframe = requireIframeProps();
    expect(iframe).toMatchObject({
      title: 'Mermaid renderer',
      sandbox: 'allow-scripts',
      referrerPolicy: 'no-referrer',
    });
    expect(iframe['src']).toEqual(expect.stringMatching(/^file:/u));
    expect(addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(ref.current?.postMessage('display')).toBe(true);
    expect(mockFrameNode.contentWindow?.postMessage).toHaveBeenCalledWith('display', '*');

    act(() => {
      messageHandler?.({ source: {}, data: 'ignore' } as MessageEvent<unknown>);
      messageHandler?.({
        source: mockFrameNode.contentWindow,
        data: '{"type":"ready"}',
      } as MessageEvent<unknown>);
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith('{"type":"ready"}');

    const onIframeError = iframe['onError'];
    if (typeof onIframeError !== 'function') {
      throw new Error('Expected iframe error handler');
    }
    act(() => (onIframeError as () => void)());
    expect(onError).toHaveBeenCalledWith('The Mermaid renderer could not load.');

    mockFrameNode.contentWindow = null;
    expect(ref.current?.postMessage('display')).toBe(false);
    act(() => tree?.unmount());
    expect(removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('labels the visible iframe as a full-screen diagram', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <MermaidFrame testID="mermaid-canvas-viewer" onMessage={jest.fn()} onError={jest.fn()} />,
      );
    });
    expect(requireIframeProps()['title']).toBe('Full-screen Mermaid diagram');
    act(() => tree?.unmount());
  });
});
