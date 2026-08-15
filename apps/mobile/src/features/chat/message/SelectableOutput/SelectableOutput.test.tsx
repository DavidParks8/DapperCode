import { StyleSheet } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { SelectableOutput } from './SelectableOutput';
import { estimateSelectableOutputHeight } from './selectableOutputProtocol';

type Queryable = ReactTestInstance & {
  children: Array<Queryable | string | number>;
  props: Record<string, unknown>;
  type: unknown;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByProps(props: Record<string, unknown>): Queryable[];
  findAllByType(type: unknown): Queryable[];
};
type QueryableRenderer = ReactTestRenderer & { root: Queryable; toJSON(): unknown };

const theme = createAppTheme('dark');

function renderOutput(text: string): QueryableRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={theme}>
        <SelectableOutput text={text} testID="selectable-output-test" />
      </AppThemeProvider>,
    );
  });
  if (!tree) {
    throw new Error('Expected a rendered SelectableOutput');
  }
  return tree as QueryableRenderer;
}

function webView(tree: QueryableRenderer) {
  const node = tree.root.findByType('mock-web-view');
  if (!node) {
    throw new Error('Expected the mocked output WebView');
  }
  return node;
}

describe('SelectableOutput', () => {
  it('renders tool output in a locked-down, user-selectable WebView surface', () => {
    const tree = renderOutput('alpha\nbeta & <gamma>');
    const frame = webView(tree);
    const source = frame.props['source'] as { html: string };

    expect(source.html).toContain('user-select: text');
    expect(source.html).toContain('alpha\nbeta &amp; &lt;gamma&gt;');
    expect(source.html).toContain('Content-Security-Policy');
    expect(frame.props['javaScriptEnabled']).toBe(true);
    expect(frame.props['domStorageEnabled']).toBe(false);
    expect(frame.props['allowFileAccess']).toBe(false);
    expect(frame.props['allowFileAccessFromFileURLs']).toBe(false);
    expect(frame.props['allowUniversalAccessFromFileURLs']).toBe(false);
    expect(frame.props['mixedContentMode']).toBe('never');
    expect(frame.props['cacheEnabled']).toBe(false);
    expect(frame.props['scrollEnabled']).toBe(false);
    expect(frame.props['importantForAccessibility']).toBe('no-hide-descendants');

    const shouldStart = frame.props['onShouldStartLoadWithRequest'] as (request: {
      url: string;
    }) => boolean;
    expect(shouldStart({ url: 'about:blank' })).toBe(true);
    expect(shouldStart({ url: '' })).toBe(true);
    expect(shouldStart({ url: 'https://example.com/output' })).toBe(false);
    expect(shouldStart({ url: 'data:text/html,<script>alert(1)</script>' })).toBe(false);

    expect(
      tree.root.findAllByProps({ accessibilityLabel: 'alpha\nbeta & <gamma>' }),
    ).not.toHaveLength(0);
    act(() => tree.unmount());
  });

  it('sizes from the reported height and keeps a stable source across text updates', () => {
    const tree = renderOutput('one\ntwo');
    let frame = webView(tree);
    const initialSource = frame.props['source'];
    const estimatedHeight = estimateSelectableOutputHeight('one\ntwo', 18);
    expect(StyleSheet.flatten(frame.props['containerStyle'] as object)).toMatchObject({
      height: estimatedHeight,
    });

    act(() => {
      const onMessage = frame.props['onMessage'] as (event: {
        nativeEvent: { data: string };
      }) => void;
      onMessage({ nativeEvent: { data: '{"type":"height","height":120}' } });
    });
    expect(StyleSheet.flatten(webView(tree).props['containerStyle'] as object)).toMatchObject({
      height: 120,
    });

    act(() => {
      tree.update(
        <AppThemeProvider theme={theme}>
          <SelectableOutput text="one\ntwo\nthree" testID="selectable-output-test" />
        </AppThemeProvider>,
      );
    });
    frame = webView(tree);
    expect(frame.props['source']).toBe(initialSource);
    expect((frame.props['source'] as { html: string }).html).toContain('one\ntwo');
    act(() => tree.unmount());
  });

  it('accepts the ready handshake without losing the current text', () => {
    const tree = renderOutput('streamed');
    act(() => {
      const onMessage = webView(tree).props['onMessage'] as (event: {
        nativeEvent: { data: string };
      }) => void;
      onMessage({ nativeEvent: { data: '{"type":"ready"}' } });
      onMessage({ nativeEvent: { data: 'not json' } });
    });
    expect(webView(tree).props['source']).toBeDefined();
    act(() => tree.unmount());
  });

  it('falls back to native selectable text when the WebView fails to load', () => {
    const tree = renderOutput('fallback line');
    act(() => {
      const onError = webView(tree).props['onError'] as () => void;
      onError();
    });
    expect(tree.root.findAllByType('mock-web-view')).toHaveLength(0);
    const fallbacks = tree.root.findAll(
      (node) => node.type === 'Text' && node.props['selectable'] === true,
    );
    expect(fallbacks[0]?.children[0]).toBe('fallback line');
    act(() => tree.unmount());
  });

  it('renders nothing for empty output', () => {
    const tree = renderOutput('');
    expect(tree.root.findAllByType('mock-web-view')).toHaveLength(0);
    expect(tree.toJSON()).toBeNull();
    act(() => tree.unmount());
  });
});
