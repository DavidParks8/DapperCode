import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import { JSDOM, VirtualConsole } from 'jsdom';

import { createAppTheme } from '@shared/theme';
import { createMermaidTheme } from './mermaidProtocol';

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

  it('inlines sequence-diagram colors for native SVG renderers', async () => {
    const { dom, messages, runtimeErrors } = createRuntimeHarness(runtime);
    const theme = createMermaidTheme(createAppTheme('dark'));

    try {
      await waitForRuntimeMessage(messages, (message) => message['type'] === 'ready');
      dom.window.dispatchEvent(
        new dom.window.MessageEvent('message', {
          data: JSON.stringify({
            type: 'render',
            id: 'sequence-colors',
            source: [
              'sequenceDiagram',
              '  participant C as Client',
              '  participant S as Server',
              '  participant D as DB',
              '  C->>S: POST /login',
              '  S->>D: Query user',
              '  D-->>S: User found',
              '  S-->>C: 200 OK + token',
              '  C->>S: GET /dashboard',
              '  S-->>C: 200 dashboard',
            ].join('\n'),
            theme,
          }),
        }),
      );
      const result = await waitForRuntimeMessage(
        messages,
        (message) =>
          message['id'] === 'sequence-colors' &&
          (message['type'] === 'rendered' || message['type'] === 'error'),
      );

      expect(result['type']).toBe('rendered');
      const rendered = new JSDOM(String(result['svg']), { contentType: 'image/svg+xml' });
      try {
        expect(
          rendered.window.document.querySelector('text.actor > tspan')?.getAttribute('fill'),
        ).toBe(theme['actorTextColor']);
        expect(
          rendered.window.document.querySelector('text.messageText')?.getAttribute('fill'),
        ).toBe(theme['signalTextColor']);
        expect(runtimeErrors).toEqual([]);
      } finally {
        rendered.window.close();
      }
    } finally {
      dom.window.close();
    }
  }, 15_000);

  it('rejects oversized rendered SVG before attaching it for style computation', async () => {
    const constrainedRuntime = runtime.replace(
      'const MAX_SVG_BYTES = 2097152;',
      'const MAX_SVG_BYTES = 128;',
    );
    const { dom, messages } = createRuntimeHarness(constrainedRuntime);
    const attachedNodes: Node[] = [];

    try {
      await waitForRuntimeMessage(messages, (message) => message['type'] === 'ready');
      const diagram = dom.window.document.getElementById('diagram');
      if (!diagram) {
        throw new Error('Expected Mermaid diagram host');
      }
      const observer = new dom.window.MutationObserver((records) => {
        records.forEach((record) => attachedNodes.push(...Array.from(record.addedNodes)));
      });
      observer.observe(diagram, { childList: true });
      dom.window.dispatchEvent(
        new dom.window.MessageEvent('message', {
          data: JSON.stringify({
            type: 'render',
            id: 'oversized-render',
            source: 'graph TD\n  A --> B',
            theme: {},
          }),
        }),
      );
      const result = await waitForRuntimeMessage(
        messages,
        (message) => message['id'] === 'oversized-render',
      );
      observer.disconnect();

      expect(result).toMatchObject({
        type: 'error',
        message: 'This Mermaid diagram is too complex to display safely.',
      });
      expect(attachedNodes).toHaveLength(0);
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
