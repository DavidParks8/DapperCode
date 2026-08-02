import { requireTestValue } from '../testing/requireTestValue';
import type { ChatMessage, ChatToolMeta } from '../api/types';
import { buildToolInvocations, toolKindIcon } from './toolInvocationModel';

function toolMessage(
  id: string,
  content: string,
  toolMeta?: ChatToolMeta,
  toolCallId = id,
): ChatMessage {
  return {
    id,
    role: 'tool',
    toolCallId,
    content,
    createdAt: '2026-05-01T00:00:00.000Z',
    ...(toolMeta ? { toolMeta } : {}),
  };
}

function meta(overrides: Partial<ChatToolMeta> = {}): ChatToolMeta {
  return {
    toolCallId: 'call-1',
    kind: 'other',
    status: 'completed',
    title: 'Tool',
    ...overrides,
  };
}

describe('buildToolInvocations', () => {
  it('merges the call, metadata, and result of one tool into a single row', () => {
    const messages: ChatMessage[] = [
      {
        id: 'tool-call:call-1',
        role: 'assistant',
        content: '',
        createdAt: '2026-05-01T00:00:00.000Z',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
        toolMeta: meta({ kind: 'read', status: 'in_progress', title: 'Read package.json' }),
      },
      toolMessage(
        'tool-result:call-1',
        'name dappercode',
        meta({
          kind: 'read',
          status: 'completed',
          title: 'Read package.json',
          locations: [{ path: 'package.json', line: 2 }],
        }),
        'call-1',
      ),
    ];

    const invocations = buildToolInvocations(messages);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      id: 'call-1',
      kind: 'read',
      status: 'completed',
      title: 'Read package.json',
      monospaceTitle: false,
      isError: false,
      locations: [{ path: 'package.json', line: 2 }],
      textLines: ['name dappercode'],
      empty: false,
    });
  });

  it('lifts diffs, terminals, and images out of structured content', () => {
    const invocations = buildToolInvocations([
      toolMessage(
        'tool-result:call-1',
        '[diff: src/app.ts]\nold\nnew\n[terminal: term-1]\nboot\n[image: https://example.test/a.png]\nleftover',
        meta({
          kind: 'edit',
          title: 'Edit src/app.ts',
          truncated: true,
          content: [
            { type: 'diff', path: 'src/app.ts', oldText: 'old', newText: 'new' },
            {
              type: 'terminal',
              terminalId: 'term-1',
              output: [{ type: 'text', text: 'boot' }],
            },
            { type: 'image', data: 'AAA', mimeType: 'image/png' },
            { type: 'content', content: { type: 'image', url: 'https://example.test/a.png' } },
          ],
        }),
        'call-1',
      ),
    ]);

    expect(requireTestValue(invocations[0], 'indexed test value').diffs).toEqual([
      { path: 'src/app.ts', oldText: 'old', newText: 'new' },
    ]);
    expect(requireTestValue(invocations[0], 'indexed test value').terminals).toEqual([
      { terminalId: 'term-1', output: 'boot' },
    ]);
    expect(requireTestValue(invocations[0], 'indexed test value').images).toEqual([
      'data:image/png;base64,AAA',
      'https://example.test/a.png',
    ]);
    expect(requireTestValue(invocations[0], 'indexed test value').textLines).toEqual(['leftover']);
    expect(requireTestValue(invocations[0], 'indexed test value').truncated).toBe(true);
  });

  it('marks a failed invocation and keeps execute titles monospaced', () => {
    const invocations = buildToolInvocations([
      toolMessage(
        'tool-result:call-1',
        '',
        meta({ kind: 'execute', status: 'failed', title: 'npm test' }),
        'call-1',
      ),
    ]);

    expect(invocations[0]).toMatchObject({
      isError: true,
      monospaceTitle: true,
      status: 'failed',
      empty: true,
    });
  });

  it('reads structured locations and defaults unnamed diff paths', () => {
    const invocations = buildToolInvocations([
      toolMessage(
        'tool-result:call-1',
        '',
        meta({
          title: 'Search',
          content: [{ type: 'diff', new_text: 'body' }],
          locations: [{ path: 'a.ts' }, { line: 3 }, 'nope'],
        }),
        'call-1',
      ),
    ]);

    expect(requireTestValue(invocations[0], 'indexed test value').locations).toEqual([
      { path: 'a.ts' },
    ]);
    expect(requireTestValue(invocations[0], 'indexed test value').diffs).toEqual([
      { path: 'file', oldText: null, newText: 'body' },
    ]);
  });

  it('falls back to legacy timeline text when no metadata arrives', () => {
    const invocations = buildToolInvocations([
      toolMessage('t1', '• Ran `pwd`\n  └ /repo'),
      {
        id: 's1',
        role: 'system',
        content: '• Tool failed `build`\n  └ boom\n• Reading src/app.ts',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ]);

    expect(invocations.map((invocation) => invocation.title)).toEqual([
      'Ran `pwd`',
      'Tool failed `build`',
      'Reading src/app.ts',
    ]);
    expect(invocations[0]).toMatchObject({ monospaceTitle: true, textLines: ['/repo'] });
    expect(invocations[1]).toMatchObject({ isError: true, textLines: ['boom'] });
  });

  it('titles a metadata-less tool call from its synthetic timeline line', () => {
    const invocations = buildToolInvocations([
      {
        id: 'tool-call:call-9',
        role: 'assistant',
        content: '',
        createdAt: '2026-05-01T00:00:00.000Z',
        toolCalls: [
          {
            id: 'call-9',
            type: 'function',
            function: { name: 'grep', arguments: '{"q":"x"}' },
          },
        ],
      },
    ]);

    expect(invocations[0]).toMatchObject({
      id: 'call-9',
      title: 'Called tool `grep`',
      textLines: ['  {"q":"x"}'],
    });
  });

  it('keeps every entry when a legacy tool message holds several timeline rows', () => {
    const invocations = buildToolInvocations([
      toolMessage('t1', '• Ran `pwd`\n  └ /repo\n• Ran `ls`\n  └ a.txt'),
    ]);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      title: 'Ran `pwd`',
      textLines: ['/repo', 'Ran `ls`', 'a.txt'],
    });
  });

  it('collects terminal output from plain strings and nested wrappers', () => {
    const invocations = buildToolInvocations([
      toolMessage(
        't1',
        '',
        meta({
          kind: 'execute',
          title: 'npm test',
          content: [
            { type: 'terminal', terminalId: 'plain', output: 'ran 3 tests' },
            {
              type: 'terminal',
              terminalId: 'nested',
              output: { chunks: [{ type: 'text', text: 'compiling' }, { note: 'linking' }] },
            },
          ],
        }),
      ),
    ]);

    expect(requireTestValue(invocations[0], 'indexed test value').terminals).toEqual([
      { terminalId: 'plain', output: 'ran 3 tests' },
      { terminalId: 'nested', output: 'compiling\nlinking' },
    ]);
  });

  it('builds a data URL for inline images and skips ones missing a mime type', () => {
    const invocations = buildToolInvocations([
      toolMessage(
        't1',
        '',
        meta({
          title: 'Screenshot',
          content: [
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            { type: 'image', data: 'BBBB' },
          ],
        }),
      ),
    ]);

    expect(requireTestValue(invocations[0], 'indexed test value').images).toEqual([
      'data:image/png;base64,AAAA',
    ]);
  });

  it('uses the first output line as a title when nothing else names the tool', () => {
    const invocations = buildToolInvocations([
      toolMessage('t1', 'raw output\nsecond line'),
      toolMessage('t2', '   '),
      { id: 'plain', role: 'assistant', content: 'hello', createdAt: '' },
    ]);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      title: 'raw output',
      textLines: ['second line'],
    });
  });
});

describe('toolKindIcon', () => {
  it('maps every kind and falls back for unknown values', () => {
    expect(toolKindIcon('execute')).toBe('terminal-outline');
    expect(toolKindIcon('switch_mode')).toBe('swap-horizontal-outline');
    expect(toolKindIcon('nope' as 'other')).toBe('construct-outline');
  });
});
