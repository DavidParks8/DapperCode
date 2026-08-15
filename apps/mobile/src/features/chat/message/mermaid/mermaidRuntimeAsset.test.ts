import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import { JSDOM, VirtualConsole } from 'jsdom';

describe('generated Mermaid runtime asset', () => {
  const mobileRoot = path.resolve(__dirname, '../../../../..');
  const runtime = readFileSync(
    path.join(mobileRoot, 'assets/generated/mermaid-renderer.html'),
    'utf8',
  );

  it('is self-contained and blocks network-backed content', () => {
    expect(runtime).toContain(`default-src 'none'`);
    expect(runtime).toContain(`img-src data: blob:`);
    expect(runtime).not.toMatch(/<script[^>]+\bsrc=/iu);
    expect(runtime).toContain("securityLevel: 'strict'");
    expect(runtime).toContain(
      "querySelectorAll('script, iframe, object, embed, foreignObject, audio, video, link')",
    );
  });

  it('enforces source and SVG limits and exposes render/display commands', () => {
    expect(runtime).toContain('const MAX_SOURCE_BYTES = 65536');
    expect(runtime).toContain('const MAX_SVG_BYTES = 2097152');
    expect(runtime).toContain("payload.type === 'render'");
    expect(runtime).toContain("payload.type === 'display'");
    expect(runtime).toContain("type: 'viewState'");
  });

  it('contains the pinned Mermaid version marker', () => {
    expect(runtime).toMatch(/dappercode-mermaid-runtime 11\.16\.1 [a-f0-9]{64}/u);
  });

  it('executes the packaged runtime and returns a sanitized SVG for a valid diagram', async () => {
    const { dom, messages, runtimeErrors } = createRuntimeHarness(runtime);

    try {
      await waitForRuntimeMessage(messages, (message) => message['type'] === 'ready');
      dom.window.dispatchEvent(
        new dom.window.MessageEvent('message', {
          data: JSON.stringify({
            type: 'render',
            id: 'smoke-1',
            source: 'graph TD\n  A --> B',
            theme: {},
          }),
        }),
      );
      const result = await waitForRuntimeMessage(
        messages,
        (message) =>
          message['id'] === 'smoke-1' &&
          (message['type'] === 'rendered' || message['type'] === 'error'),
      );

      expect(result['type']).toBe('rendered');
      expect(result['svg']).toEqual(expect.stringContaining('<svg'));
      expect(result['svg']).toEqual(expect.stringContaining('<style'));
      expect(result['svg']).not.toMatch(/\b(?:href|src)=["']https?:/iu);
      expect(runtimeErrors).toEqual([]);
    } finally {
      dom.window.close();
    }
  }, 15_000);

  it('rejects escaped URL and image-set CSS references before displaying cached SVG', async () => {
    const { dom, messages } = createRuntimeHarness(runtime);
    const payloads = [
      {
        id: 'escaped-url',
        svg: `<svg viewBox="0 0 10 10"><style>.node { fill: u\\72l(https://example.test/a); }</style><rect class="node" width="10" height="10"/></svg>`,
      },
      {
        id: 'image-set',
        svg: `<svg viewBox="0 0 10 10"><style>.node { background-image: image-set("https://example.test/a.png" 1x); }</style><rect class="node" width="10" height="10"/></svg>`,
      },
      {
        id: 'root-style',
        svg: `<svg viewBox="0 0 10 10" style="background-image:u\\72l(https://example.test/root)"><rect width="10" height="10"/></svg>`,
      },
    ];

    try {
      await waitForRuntimeMessage(messages, (message) => message['type'] === 'ready');
      for (const payload of payloads) {
        dom.window.dispatchEvent(
          new dom.window.MessageEvent('message', {
            data: JSON.stringify({
              type: 'display',
              id: payload.id,
              svg: payload.svg,
              width: 10,
              height: 10,
            }),
          }),
        );
        const result = await waitForRuntimeMessage(
          messages,
          (message) => message['id'] === payload.id,
        );
        expect(result).toMatchObject({
          type: 'error',
          message: 'This Mermaid diagram contains unsupported external styling.',
        });
      }
    } finally {
      dom.window.close();
    }
  });
});

function createRuntimeHarness(runtime: string): {
  dom: JSDOM;
  messages: Record<string, unknown>[];
  runtimeErrors: Error[];
} {
  const messages: Record<string, unknown>[] = [];
  const runtimeErrors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error));
  const dom = new JSDOM(runtime, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) => {
      Object.defineProperties(window, {
        TextEncoder: { value: TextEncoder },
        TextDecoder: { value: TextDecoder },
        ReactNativeWebView: {
          value: {
            postMessage: (message: string) => {
              messages.push(JSON.parse(message) as Record<string, unknown>);
            },
          },
        },
      });
      Object.defineProperties(window.SVGElement.prototype, {
        getBBox: {
          value: () => ({ x: 0, y: 0, width: 320, height: 180 }),
        },
        getComputedTextLength: { value: () => 80 },
      });
    },
  });
  return { dom, messages, runtimeErrors };
}

async function waitForRuntimeMessage(
  messages: Record<string, unknown>[],
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = messages.find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for Mermaid runtime message: ${JSON.stringify(messages)}`);
}
