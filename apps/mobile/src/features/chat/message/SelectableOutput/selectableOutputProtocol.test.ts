import { createAppTheme } from '@shared/theme';
import {
  SELECTABLE_OUTPUT_LINE_HEIGHT,
  createSelectableOutputHtml,
  createSelectableOutputSetTextCommand,
  escapeHtmlText,
  estimateSelectableOutputHeight,
  parseSelectableOutputFrameMessage,
  selectableOutputHtmlStyle,
  stripTrailingLineBreak,
} from './selectableOutputProtocol';

describe('selectableOutputProtocol', () => {
  it('escapes HTML text so output never changes the document structure', () => {
    expect(escapeHtmlText('a < b > "c" & \'d\'')).toBe(
      'a &lt; b &gt; &quot;c&quot; &amp; &#39;d&#39;',
    );
  });

  it('strips exactly one trailing line break to match the previous line list', () => {
    expect(stripTrailingLineBreak('one\ntwo\n')).toBe('one\ntwo');
    expect(stripTrailingLineBreak('one\ntwo')).toBe('one\ntwo');
    expect(stripTrailingLineBreak('one\n\n')).toBe('one\n');
  });

  it('estimates a stable height from the line count', () => {
    expect(estimateSelectableOutputHeight('', 18)).toBe(18);
    expect(estimateSelectableOutputHeight('one\ntwo', 18)).toBe(36);
    expect(estimateSelectableOutputHeight('one\ntwo', 18)).toBe(36);
  });

  it('derives an HTML style from the theme mono output look', () => {
    const style = selectableOutputHtmlStyle(createAppTheme('dark'));
    expect(style).toMatchObject({
      fontSize: 13,
      lineHeight: SELECTABLE_OUTPUT_LINE_HEIGHT,
      color: createAppTheme('dark').colors.textSecondary,
    });
  });

  it('builds a locked-down selectable document with escaped output', () => {
    const html = createSelectableOutputHtml('a & <b> "x"\n</pre></script>', {
      fontFamily: 'Menlo',
      fontSize: 13,
      lineHeight: 18,
      color: '#D0D5DF',
    });

    expect(html).toContain('user-select: text');
    expect(html).toContain(
      "content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'\"",
    );
    expect(html).toContain('a &amp; &lt;b&gt; &quot;x&quot;');
    expect(html).toContain('&lt;/pre&gt;&lt;/script&gt;');
    expect(html).toMatch(/<script>/gu);
    expect(html.match(/<script>/gu)).toHaveLength(1);
    expect(html.match(/<\/script>/gu)).toHaveLength(1);
    expect(html).toContain('content.textContent = raw;');
    expect(html).toContain('window.ReactNativeWebView.postMessage');
    expect(html).toContain("window.parent.postMessage(raw, '*')");
  });

  it('round-trips the imperative setText command', () => {
    const command = createSelectableOutputSetTextCommand('streamed\noutput');
    expect(JSON.parse(command)).toEqual({ type: 'setText', text: 'streamed\noutput' });
  });

  it('parses only well-formed frame messages', () => {
    expect(parseSelectableOutputFrameMessage('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(parseSelectableOutputFrameMessage('{"type":"height","height":120}')).toEqual({
      type: 'height',
      height: 120,
    });
    expect(parseSelectableOutputFrameMessage('{"type":"height","height":120.5}')).toEqual({
      type: 'height',
      height: 121,
    });
    expect(parseSelectableOutputFrameMessage('not json')).toBeNull();
    expect(parseSelectableOutputFrameMessage(42)).toBeNull();
    expect(parseSelectableOutputFrameMessage('{"type":"height","height":0}')).toBeNull();
    expect(parseSelectableOutputFrameMessage('{"type":"height","height":-3}')).toBeNull();
    expect(parseSelectableOutputFrameMessage('{"type":"height","height":"120"}')).toBeNull();
    expect(parseSelectableOutputFrameMessage('{"type":"setText","text":"x"}')).toBeNull();
    expect(parseSelectableOutputFrameMessage('[]')).toBeNull();
  });
});
