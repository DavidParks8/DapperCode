import { createRef } from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { MermaidCanvas, type MermaidCanvasHandle } from './MermaidCanvas';
import { MERMAID_FRAME_STARTUP_TIMEOUT_MS } from './mermaidProtocol';

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

function invokeFrame(name: 'onMessage' | 'onProcessTerminated', value?: unknown) {
  const callback = mockFrameProps?.[name];
  if (typeof callback !== 'function') {
    throw new Error(`Expected ${name}`);
  }
  (callback as (input?: unknown) => void)(value);
}

function markFrameReady() {
  invokeFrame('onMessage', JSON.stringify({ type: 'ready' }));
}

function readCommands(): Array<Record<string, unknown>> {
  return mockPostMessage.mock.calls.map(([raw]) => JSON.parse(raw));
}

describe('MermaidCanvas', () => {
  beforeEach(() => {
    mockFrameProps = null;
    mockPostMessage.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('displays the cached SVG and routes zoom controls to the same viewer request', async () => {
    const ref = createRef<MermaidCanvasHandle>();
    const onRendered = jest.fn();
    const onError = jest.fn();
    const onZoomChange = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <MermaidCanvas
          ref={ref}
          svg='<svg viewBox="0 0 600 300"/>'
          width={600}
          height={300}
          onLoading={jest.fn()}
          onRendered={onRendered}
          onError={onError}
          onZoomChange={onZoomChange}
        />,
      );
    });
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    const display = readCommands()[0];
    expect(display).toMatchObject({
      type: 'display',
      svg: '<svg viewBox="0 0 600 300"/>',
      width: 600,
      height: 300,
    });

    act(() => {
      invokeFrame(
        'onMessage',
        JSON.stringify({
          type: 'rendered',
          id: display?.['id'],
          width: 600,
          height: 300,
        }),
      );
      invokeFrame('onMessage', JSON.stringify({ type: 'viewState', id: display?.['id'], zoom: 2 }));
      tree?.update(
        <MermaidCanvas
          ref={ref}
          svg='<svg viewBox="0 0 600 300"/>'
          width={600}
          height={300}
          onLoading={() => undefined}
          onRendered={() => undefined}
          onError={() => undefined}
          onZoomChange={() => undefined}
        />,
      );
    });
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    act(() => {
      ref.current?.zoomIn();
      ref.current?.zoomOut();
      ref.current?.reset();
    });

    expect(onRendered).toHaveBeenCalledTimes(1);
    expect(onZoomChange).toHaveBeenCalledWith(2);
    expect(readCommands().slice(1)).toEqual([
      { type: 'zoomIn', id: display?.['id'] },
      { type: 'zoomOut', id: display?.['id'] },
      { type: 'reset', id: display?.['id'] },
    ]);
    expect(onError).not.toHaveBeenCalled();
    act(() => tree?.unmount());
  });

  it('ignores stale messages and surfaces the active viewer error', async () => {
    const onError = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <MermaidCanvas
          svg="<svg/>"
          width={10}
          height={10}
          onLoading={jest.fn()}
          onRendered={jest.fn()}
          onError={onError}
        />,
      );
    });
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    const display = readCommands()[0];
    act(() => {
      invokeFrame(
        'onMessage',
        JSON.stringify({ type: 'error', id: 'stale', message: 'ignore me' }),
      );
      invokeFrame(
        'onMessage',
        JSON.stringify({ type: 'error', id: display?.['id'], message: 'viewer failed' }),
      );
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('viewer failed');
    act(() => tree?.unmount());
  });

  it('returns to loading while a terminated viewer process is replaced', async () => {
    const onLoading = jest.fn();
    const onRendered = jest.fn();
    const onError = jest.fn();
    const ref = createRef<MermaidCanvasHandle>();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <MermaidCanvas
          ref={ref}
          svg="<svg/>"
          width={10}
          height={10}
          onLoading={onLoading}
          onRendered={onRendered}
          onError={onError}
        />,
      );
    });
    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    const display = readCommands()[0];
    act(() => {
      invokeFrame(
        'onMessage',
        JSON.stringify({
          type: 'rendered',
          id: display?.['id'],
          width: 10,
          height: 10,
        }),
      );
      invokeFrame('onProcessTerminated');
    });
    act(() => ref.current?.zoomIn());

    expect(onRendered).toHaveBeenCalledTimes(1);
    expect(onLoading).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    await act(async () => {
      markFrameReady();
      await Promise.resolve();
    });
    expect(readCommands().at(-1)).toMatchObject({ type: 'display', id: display?.['id'] });
    act(() => invokeFrame('onProcessTerminated'));
    expect(onLoading).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith('The Mermaid renderer stopped unexpectedly.');
    act(() => tree?.unmount());
  });

  it('fails explicitly when the viewer frame never signals readiness', () => {
    jest.useFakeTimers();
    const onError = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <MermaidCanvas
          svg="<svg/>"
          width={10}
          height={10}
          onLoading={jest.fn()}
          onRendered={jest.fn()}
          onError={onError}
        />,
      );
    });
    act(() => {
      jest.advanceTimersByTime(MERMAID_FRAME_STARTUP_TIMEOUT_MS);
    });

    expect(onError).toHaveBeenCalledWith('The Mermaid viewer took too long to start.');
    act(() => tree?.unmount());
  });
});
