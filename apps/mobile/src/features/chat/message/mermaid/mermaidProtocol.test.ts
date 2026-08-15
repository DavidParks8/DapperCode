import { createAppTheme } from '@shared/theme';
import {
  MERMAID_MAX_SOURCE_BYTES,
  createMermaidTheme,
  parseMermaidFrameMessage,
  utf8ByteLength,
} from './mermaidProtocol';

describe('Mermaid renderer protocol', () => {
  it('counts UTF-8 bytes instead of JavaScript code units for source limits', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('🙂')).toBe(4);
    expect(utf8ByteLength('x'.repeat(MERMAID_MAX_SOURCE_BYTES))).toBe(MERMAID_MAX_SOURCE_BYTES);
  });

  it('parses only typed renderer messages and preserves sanitized SVG results', () => {
    expect(parseMermaidFrameMessage('not-json')).toBeNull();
    expect(parseMermaidFrameMessage(null)).toBeNull();
    expect(parseMermaidFrameMessage('null')).toBeNull();
    expect(parseMermaidFrameMessage(JSON.stringify({ type: 'error', id: 1 }))).toBeNull();
    expect(parseMermaidFrameMessage(JSON.stringify({ type: 'ready' }))).toEqual({
      type: 'ready',
    });
    expect(
      parseMermaidFrameMessage(
        JSON.stringify({
          type: 'rendered',
          id: 'render-1',
          width: 640,
          height: 360,
          svg: '<svg viewBox="0 0 640 360"/>',
        }),
      ),
    ).toEqual({
      type: 'rendered',
      id: 'render-1',
      width: 640,
      height: 360,
      svg: '<svg viewBox="0 0 640 360"/>',
    });
    expect(
      parseMermaidFrameMessage(
        JSON.stringify({ type: 'rendered', id: 'render-1', width: 0, height: 10 }),
      ),
    ).toBeNull();
    expect(
      parseMermaidFrameMessage(JSON.stringify({ type: 'viewState', id: 'viewer-1', zoom: 99 })),
    ).toEqual({ type: 'viewState', id: 'viewer-1', zoom: 5 });
    expect(
      parseMermaidFrameMessage(JSON.stringify({ type: 'open', id: 'removed-message' })),
    ).toBeNull();
  });

  it('maps both app themes to explicit Mermaid colors', () => {
    const dark = createMermaidTheme(createAppTheme('dark'));
    const light = createMermaidTheme(createAppTheme('light'));

    expect(dark['background']).toBe(createAppTheme('dark').colors.bgElevated);
    expect(light['background']).toBe(createAppTheme('light').colors.bgElevated);
    expect(dark['primaryTextColor']).not.toBe(light['primaryTextColor']);
    expect(dark['fontFamily']).toContain('-apple-system');
  });
});
