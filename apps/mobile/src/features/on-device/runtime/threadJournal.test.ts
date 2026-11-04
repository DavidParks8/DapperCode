import { LOCAL_THREAD_HEADER_KEYS, type LocalThreadHeader } from './threadCodec';
import {
  durableLocalThread,
  localThreadDelta,
  sameJson,
  utf8Bytes,
  type LocalThreadDelta,
} from './threadJournal';
import type { LocalMessage, LocalThread } from './types';

describe('utf8Bytes', () => {
  const cases: [string, string, number][] = [
    ['empty', '', 0],
    ['ASCII', 'hello {"a":1}\n', 14],
    ['2-byte characters', 'é ß ж', 8],
    ['3-byte characters', '€ 漢字', 10],
    ['4-byte characters (surrogate pairs)', '😀 𝄞', 9],
    ['a lone high surrogate at the end', 'a\ud83d', 4],
    ['a lone high surrogate before another character', '\ud83dx', 4],
    ['a lone low surrogate', '\ude00', 3],
    ['two high surrogates then a low one', '\ud83d\ud83d\ude00', 7],
    ['a reversed pair', '\ude00\ud83d', 6],
  ];

  test.each(cases)('counts %s as TextEncoder encodes them', (_name, value, bytes) => {
    expect(utf8Bytes(value)).toBe(bytes);
    expect(utf8Bytes(value)).toBe(new TextEncoder().encode(value).length);
  });

  test('counts without encoding a byte copy of the string', () => {
    const encode = jest.spyOn(TextEncoder.prototype, 'encode');
    try {
      expect(utf8Bytes('x'.repeat(1024) + '😀')).toBe(1028);
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });
});

describe('sameJson', () => {
  test('matches comparing JSON.stringify output', () => {
    const values: unknown[] = [
      null,
      'a',
      '',
      1,
      true,
      [],
      [1, 'a'],
      ['a', 1],
      {},
      { a: 1, b: 'x' },
      { b: 'x', a: 1 },
      { a: 1, b: 'x', c: undefined },
      { a: 1, b: 'x', c: null },
      { a: { b: [1, { c: 'd' }] } },
      { a: { b: [1, { c: 'e' }] } },
    ];
    for (const a of values) {
      for (const b of values) {
        expect([a, b, sameJson(a, b)]).toEqual([a, b, JSON.stringify(a) === JSON.stringify(b)]);
      }
    }
  });
});

/** The previous implementation: every message and header field serialized on every save. */
function serializedDelta(
  previous: LocalThread,
  next: LocalThread,
): LocalThreadDelta | null | 'rebase' {
  const serialize = (thread: LocalThread) => ({
    header: Object.fromEntries(
      LOCAL_THREAD_HEADER_KEYS.map((key) => [key, JSON.stringify(thread[key])]),
    ),
    ids: thread.messages.map((message) => message.id),
    messages: new Map(thread.messages.map((message) => [message.id, JSON.stringify(message)])),
  });
  const before = serialize(previous);
  const after = serialize(next);
  if (before.messages.size !== before.ids.length || after.messages.size !== after.ids.length) {
    return 'rebase';
  }
  const set: Partial<LocalThreadHeader> = {};
  for (const key of LOCAL_THREAD_HEADER_KEYS) {
    if (before.header[key] !== after.header[key]) {
      Object.assign(set, { [key]: next[key] });
    }
  }
  const remove = before.ids.filter((id) => !after.messages.has(id));
  const kept = before.ids.filter((id) => after.messages.has(id));
  const messages: LocalMessage[] = [];
  for (const [index, message] of next.messages.entries()) {
    if (index < kept.length) {
      if (kept[index] !== message.id) {
        return 'rebase';
      }
      if (before.messages.get(message.id) === after.messages.get(message.id)) {
        continue;
      }
    }
    messages.push(message);
  }
  if (Object.keys(set).length === 0 && remove.length === 0 && messages.length === 0) {
    return null;
  }
  return { set, remove, messages };
}

function message(id: string, content = id): LocalMessage {
  return { id, role: 'user', content, createdAt: '2026-01-01T00:00:00.000Z' };
}

test('the delta of a sequence of thread states is unchanged from serialized comparison', () => {
  const a = message('a');
  const b: LocalMessage = {
    id: 'b',
    role: 'assistant',
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    toolCalls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
  };
  const c = message('c');
  const start: LocalThread = {
    version: 1,
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Title',
    workspaceId: 'workspace',
    modelId: 'model',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'idle',
    activeTurnId: null,
    lastSubmissionId: null,
    lastError: null,
    messages: [a],
  };
  const states: LocalThread[] = [
    start,
    { ...start },
    { ...start, status: 'running', activeTurnId: 'turn', messages: [a, b] },
    // Equal copies, including an undefined field JSON omits, are not changes.
    {
      ...start,
      status: 'running',
      activeTurnId: 'turn',
      messages: [{ ...a }, { ...b, reasoning: undefined }],
    },
    { ...start, status: 'running', activeTurnId: 'turn', messages: [a, { ...b, content: 'x' }, c] },
    // Reordered keys serialize differently and are written, as before.
    {
      ...start,
      status: 'running',
      activeTurnId: 'turn',
      messages: [
        a,
        { ...b, content: 'x' },
        { content: 'c', id: 'c', role: 'user', createdAt: c.createdAt },
      ],
    },
    { ...start, status: 'complete', lastError: 'done', messages: [{ ...b, content: 'x' }, c] },
    { ...start, status: 'complete', lastError: 'done', messages: [c, { ...b, content: 'x' }] },
    { ...start, messages: [a, a] },
    { ...start, title: 'Renamed', messages: [] },
  ];
  for (let index = 1; index < states.length; index += 1) {
    const previous = states[index - 1] as LocalThread;
    const next = states[index] as LocalThread;
    expect([
      index,
      localThreadDelta(durableLocalThread(previous), next, durableLocalThread(next)),
    ]).toEqual([index, serializedDelta(previous, next)]);
  }
});
