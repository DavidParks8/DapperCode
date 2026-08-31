import { createRef } from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { MermaidFrame, resolveMermaidRuntimeUri, type MermaidFrameHandle } from './MermaidFrame';

describe('MermaidFrame', () => {
  it('maps Android release resource identifiers to loadable raw-resource URLs', () => {
    expect(resolveMermaidRuntimeUri('assets_generated_mermaidrenderer', 'android')).toBe(
      'file:///android_res/raw/assets_generated_mermaidrenderer.html',
    );
    expect(resolveMermaidRuntimeUri('https://localhost/mermaid-renderer.html', 'android')).toBe(
      'https://localhost/mermaid-renderer.html',
    );
    expect(resolveMermaidRuntimeUri('assets/generated/mermaid-renderer.html', 'ios')).toBe(
      'assets/generated/mermaid-renderer.html',
    );
    expect(() => resolveMermaidRuntimeUri('../renderer', 'android')).toThrow(
      'invalid Android resource identifier',
    );
  });

  it('loads only its packaged asset and reports native WebView failures', () => {
    const onMessage = jest.fn();
    const onError = jest.fn();
    const onProcessTerminated = jest.fn();
    const ref = createRef<MermaidFrameHandle>();
    let tree: ReactTestRenderer | undefined;

    act(() => {
      tree = renderer.create(
        <MermaidFrame
          ref={ref}
          testID="mermaid-frame"
          onMessage={onMessage}
          onError={onError}
          onProcessTerminated={onProcessTerminated}
        />,
      );
    });

    const webView = tree?.root.findByType('mock-web-view');
    if (!webView) {
      throw new Error('Expected the mocked Mermaid WebView');
    }
    const source = webView.props['source'] as { uri: string };
    const shouldStart = webView.props['onShouldStartLoadWithRequest'] as (request: {
      url: string;
    }) => boolean;

    expect(shouldStart({ url: source.uri })).toBe(true);
    expect(shouldStart({ url: 'about:blank' })).toBe(true);
    expect(shouldStart({ url: 'https://example.com/diagram.svg' })).toBe(false);
    expect(shouldStart({ url: 'file:///private/etc/passwd' })).toBe(false);
    expect(shouldStart({ url: 'data:text/html,<script>alert(1)</script>' })).toBe(false);
    expect(webView.props['allowUniversalAccessFromFileURLs']).toBe(false);
    expect(webView.props['javaScriptCanOpenWindowsAutomatically']).toBe(false);
    expect(webView.props['mixedContentMode']).toBe('never');
    expect(webView.props['onLoadEnd']).toBeUndefined();
    const onWebViewMessage = webView.props['onMessage'] as (event: {
      nativeEvent: { data: string };
    }) => void;
    const onWebViewError = webView.props['onError'] as (event: {
      nativeEvent: { description: string };
    }) => void;
    const onContentProcessDidTerminate = webView.props[
      'onContentProcessDidTerminate'
    ] as () => void;
    const onRenderProcessGone = webView.props['onRenderProcessGone'] as () => void;

    act(() => {
      onWebViewMessage({ nativeEvent: { data: '{"type":"ready"}' } });
      onWebViewError({ nativeEvent: { description: 'Renderer load failed' } });
      onWebViewError({ nativeEvent: { description: '' } });
      onContentProcessDidTerminate();
      onRenderProcessGone();
    });

    expect(onMessage).toHaveBeenCalledWith('{"type":"ready"}');
    expect(onError).toHaveBeenCalledWith('Renderer load failed');
    expect(onError).toHaveBeenCalledWith('The Mermaid renderer could not load.');
    expect(onProcessTerminated).toHaveBeenCalledTimes(2);
    expect(ref.current?.postMessage('{"type":"reset"}')).toBe(true);

    act(() => tree?.unmount());
  });
});
