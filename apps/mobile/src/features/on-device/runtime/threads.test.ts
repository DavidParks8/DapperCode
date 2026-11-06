import { randomUUID } from 'expo-crypto';
import { storedLocalThread } from './testing';
import { recoverLocalThread, threadDocument } from './threadCodec';
import {
  RUNTIME_DOCUMENT_MAX_BYTES,
  THREAD_COMPACT_SEGMENTS,
  THREAD_SEGMENT_MAX_BYTES,
  threadSegmentDocument,
  utf8Bytes,
} from './threadJournal';
import { LocalThreadRepository, type LocalDocumentPort } from './threads';
import type { LocalMessage, LocalThread } from './types';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));

const ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  let sequence = 0;
  jest
    .mocked(randomUUID)
    .mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
});

function storage(documents: Map<string, string>) {
  return {
    readRuntimeDocument: jest.fn(async (name: string) => documents.get(name) ?? null),
    writeRuntimeDocument: jest.fn(async (name: string, value: string) => {
      if (utf8Bytes(value) > RUNTIME_DOCUMENT_MAX_BYTES) {
        throw new Error('The local runtime document exceeds 8 MiB.');
      }
      documents.set(name, value);
    }),
    listRuntimeDocuments: jest.fn(async (prefix: string) =>
      [...documents.keys()].filter((key) => key.startsWith(prefix)).sort(),
    ),
    removeRuntimeDocument: jest.fn(async (name: string) => {
      documents.delete(name);
    }),
  } satisfies LocalDocumentPort;
}

async function open(documents = new Map<string, string>()) {
  const port = storage(documents);
  // Progress writes are flushed explicitly so every write in a test is deliberate.
  const threads = new LocalThreadRepository(port, jest.fn(), 60_000);
  await threads.initialize();
  return { documents, port, threads };
}

function names(documents: Map<string, string>, prefix: string): string[] {
  return [...documents.keys()].filter((name) => name.startsWith(prefix)).sort();
}

function userMessage(id: string, content = id): LocalMessage {
  return { id, role: 'user', content, createdAt: '2026-01-01T00:00:00.000Z' };
}

function toolCallMessage(id: string, callId: string): LocalMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    toolCalls: [
      { id: callId, type: 'function', function: { name: 'write_file', arguments: '{}' } },
    ],
  };
}

function pendingTool(id: string, callId: string): LocalMessage {
  return {
    id,
    role: 'tool',
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    tool: {
      callId,
      name: 'write_file',
      status: 'pending',
      startedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

async function append(threads: LocalThreadRepository, id: string, ...messages: LocalMessage[]) {
  threads.change(id, (thread) => ({ ...thread, messages: [...thread.messages, ...messages] }));
  await threads.save(id);
}

/** Journals a user turn and a tool's intent the way the agent loop does before executing it. */
async function journalToolIntent(threads: LocalThreadRepository, id: string) {
  threads.change(id, (thread) => ({ ...thread, status: 'running', activeTurnId: 'turn-1' }));
  await append(threads, id, userMessage('user-1', 'Change main.txt'));
  await append(threads, id, toolCallMessage('assistant-1', 'call-1'));
  await append(threads, id, pendingTool('tool-1', 'call-1'));
}

function legacyThread(title: string, messages: LocalMessage[]): LocalThread {
  return {
    version: 1,
    id: ID,
    title,
    workspaceId: 'workspace',
    modelId: 'model',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'complete',
    activeTurnId: null,
    lastSubmissionId: 'submission',
    lastError: null,
    messages,
  };
}

test.each(['segment', 'base'])(
  'rollback after an unacknowledged %s write replaces actual durable state',
  async (kind) => {
    const h = await open();
    const original = await h.threads.create('workspace', 'model-a');
    const write = h.port.writeRuntimeDocument.getMockImplementation()!;
    h.port.writeRuntimeDocument.mockImplementationOnce(async (name, contents) => {
      await write(name, contents);
      throw new Error('Thread write acknowledgment failed.');
    });
    h.threads.change(original.id, (thread) => ({
      ...thread,
      modelId: 'model-b',
      messages:
        kind === 'base'
          ? [userMessage('unconfirmed', 'x'.repeat(THREAD_SEGMENT_MAX_BYTES))]
          : thread.messages,
    }));
    await expect(h.threads.save(original.id)).rejects.toThrow('acknowledgment failed');
    expect(h.threads.persistenceFailures().has(original.id)).toBe(true);
    const uncertain = h.port.writeRuntimeDocument.mock.calls.at(-1)!;
    expect(uncertain[0]).toBe(
      kind === 'base' ? threadDocument(original.id) : threadSegmentDocument(original.id, 1),
    );
    const writes = h.port.writeRuntimeDocument.mock.calls.length;
    h.threads.change(original.id, () => original);
    await h.threads.save(original.id);
    expect(h.port.writeRuntimeDocument.mock.calls.length).toBeGreaterThan(writes);
    expect(h.threads.persistenceFailures().size).toBe(0);
    const restored = await open(new Map(h.documents));
    expect(restored.threads.get(original.id)).toEqual(original);
    h.threads.change(original.id, (thread) => ({ ...thread, title: 'After recovery' }));
    await h.threads.save(original.id);
    const later = await open(new Map(h.documents));
    expect(later.threads.get(original.id)).toEqual({ ...original, title: 'After recovery' });
  },
);

test.each(['segment', 'base'])(
  'failed recovery of an uncertain %s remains visible until an actual repair succeeds',
  async (kind) => {
    const h = await open();
    const original = await h.threads.create('workspace', 'model-a');
    const write = h.port.writeRuntimeDocument.getMockImplementation()!;
    h.port.writeRuntimeDocument
      .mockImplementationOnce(async (name, contents) => {
        await write(name, contents);
        throw new Error('Uncertain thread write.');
      })
      .mockRejectedValueOnce(new Error('Recovery write failed.'));
    h.threads.change(original.id, (thread) => ({
      ...thread,
      modelId: 'model-b',
      messages:
        kind === 'base'
          ? [userMessage('unconfirmed', 'x'.repeat(THREAD_SEGMENT_MAX_BYTES))]
          : thread.messages,
    }));
    await expect(h.threads.save(original.id)).rejects.toThrow('Uncertain thread write.');
    h.threads.change(original.id, () => original);
    await expect(h.threads.save(original.id)).rejects.toThrow('Recovery write failed.');
    expect(h.threads.persistenceFailures().get(original.id)?.message).toBe(
      'Recovery write failed.',
    );
    await h.threads.retryPersistence();
    expect(h.threads.persistenceFailures().size).toBe(0);
    const restored = await open(new Map(h.documents));
    expect(restored.threads.get(original.id)).toEqual(original);
  },
);

test.each([
  ['segment', 'rejected'],
  ['segment', 'written-then-rejected'],
  ['base', 'rejected'],
  ['base', 'written-then-rejected'],
])(
  'deleting a conversation during a failing %s write (%s) and its rollback save stays deleted',
  async (kind, failure) => {
    const h = await open();
    const original = await h.threads.create('workspace', 'model-a');
    const write = h.port.writeRuntimeDocument.getMockImplementation()!;
    let reject!: (error: Error) => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.port.writeRuntimeDocument.mockImplementationOnce(async (name, contents) => {
      if (failure === 'written-then-rejected') {
        await write(name, contents);
      }
      started();
      await new Promise<void>((_resolve, rejectWrite) => {
        reject = rejectWrite;
      });
    });
    h.threads.change(original.id, (thread) => ({
      ...thread,
      modelId: 'model-b',
      messages:
        kind === 'base'
          ? [userMessage('unconfirmed', 'x'.repeat(THREAD_SEGMENT_MAX_BYTES))]
          : thread.messages,
    }));
    // Mirrors the model-selection rollback: a failed choice restores and re-saves the chat.
    const choosing = h.threads.save(original.id).catch(async () => {
      h.threads.change(original.id, () => original);
      await h.threads.save(original.id);
    });
    await writing;
    const removing = h.threads.remove(original.id);
    reject(new Error('Thread write failed.'));
    await Promise.allSettled([choosing, removing]);
    await removing;
    expect(h.threads.find(original.id)).toBeNull();
    expect([...h.documents.keys()].filter((name) => name.includes(original.id))).toEqual([]);
    const restored = await open(new Map(h.documents));
    expect(restored.threads.find(original.id)).toBeNull();
    expect(restored.threads.list()).toEqual([]);
  },
);

test('older whole-conversation documents are read as the base and positioned before any segment', async () => {
  const legacy = legacyThread('Legacy conversation', [
    userMessage('user-legacy', 'Hello from an older build'),
  ]);
  const raw = JSON.stringify(legacy);
  const { documents, port, threads } = await open(new Map([[threadDocument(ID), raw]]));
  expect(threads.get(ID)).toEqual(legacy);
  expect(threads.recovery().setAside).toBe(0);
  expect(port.writeRuntimeDocument).not.toHaveBeenCalled();

  // The first save rewrites it once as a positioned base, so no segment ever follows a legacy base.
  threads.change(ID, (thread) => ({ ...thread, title: 'Renamed' }));
  await threads.save(ID);
  expect(port.writeRuntimeDocument.mock.calls.map(([name]) => name)).toEqual([threadDocument(ID)]);
  expect(JSON.parse(documents.get(threadDocument(ID)) ?? '{}')).toMatchObject({
    segment: 0,
    title: 'Renamed',
  });
  threads.change(ID, (thread) => ({ ...thread, title: 'Renamed again' }));
  await threads.save(ID);
  expect(JSON.parse(documents.get(threadSegmentDocument(ID, 1)) ?? '{}')).toEqual({
    version: 1,
    thread: ID,
    sequence: 1,
    set: { title: 'Renamed again' },
    remove: [],
    messages: [],
  });

  const restored = await open(documents);
  expect(restored.threads.get(ID)).toEqual({ ...legacy, title: 'Renamed again' });
});

test('after a downgrade rewrote the base, newer base content wins and older segments are set aside', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  await append(live.threads, ID, userMessage('user-1', 'First'));
  live.threads.change(ID, (thread) => ({ ...thread, title: 'Journaled title' }));
  await live.threads.save(ID);
  await append(live.threads, ID, userMessage('user-2', 'Second'));
  const segments = names(live.documents, 'threadseg-');
  expect(segments).toHaveLength(3);
  const segmentBytes = segments.map((name) => live.documents.get(name)).sort();

  // An older build ignores segments: it reads the base, then rewrites it without a position.
  const documents = new Map(live.documents);
  const downgraded = legacyThread('Newer title from the older build', [
    userMessage('older-1', 'Written by the older build'),
  ]);
  documents.set(threadDocument(ID), JSON.stringify(downgraded));

  const restored = await open(documents);
  expect(restored.threads.get(ID)).toEqual(downgraded);
  expect(restored.threads.recovery()).toEqual({ setAside: 1, leftInPlace: 0, ids: new Set([ID]) });
  expect(names(documents, 'threadseg-')).toEqual([]);
  expect(
    names(documents, 'quarantine-')
      .map((name) => documents.get(name))
      .sort(),
  ).toEqual(segmentBytes);
  // The base is positioned past the set-aside segments, and later segments apply on top of it.
  expect(JSON.parse(documents.get(threadDocument(ID)) ?? '{}')).toMatchObject({ segment: 3 });
  restored.threads.change(ID, (thread) => ({ ...thread, title: 'Upgraded again' }));
  await restored.threads.save(ID);
  expect(names(documents, 'threadseg-')).toEqual([threadSegmentDocument(ID, 4)]);
  expect((await open(new Map(documents))).threads.get(ID)).toEqual({
    ...downgraded,
    title: 'Upgraded again',
  });
});

test('an out-of-order segment that cannot be set aside is never deleted as folded', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  for (const title of ['One', 'Two', 'Three']) {
    live.threads.change(ID, (thread) => ({ ...thread, title }));
    await live.threads.save(ID);
  }
  const documents = new Map(live.documents);
  const third = documents.get(threadSegmentDocument(ID, 3));
  // A gap: the second segment is missing, so the valid third one must not be applied.
  documents.delete(threadSegmentDocument(ID, 2));
  const failingQuarantine = () => {
    const port = storage(documents);
    port.writeRuntimeDocument.mockImplementation(async (name, value) => {
      if (name.startsWith('quarantine-')) {
        throw new Error('Disk full');
      }
      documents.set(name, value);
    });
    return port;
  };

  for (let restart = 0; restart < 3; restart += 1) {
    const threads = new LocalThreadRepository(failingQuarantine(), jest.fn(), 60_000);
    await threads.initialize();
    expect(threads.get(ID).title).toBe('One');
    expect(threads.recovery()).toMatchObject({ leftInPlace: 1 });
    expect(documents.get(threadSegmentDocument(ID, 3))).toBe(third);
    expect(JSON.parse(documents.get(threadDocument(ID)) ?? '{}')).toMatchObject({
      segment: 3,
      skipped: [3],
      title: 'One',
    });
    threads.close();
  }

  // Once it can be moved, its bytes are set aside and the base stops tracking it.
  const restored = await open(documents);
  expect(restored.threads.get(ID).title).toBe('One');
  expect(documents.has(threadSegmentDocument(ID, 3))).toBe(false);
  expect(names(documents, 'quarantine-').map((name) => documents.get(name))).toEqual([third]);
  restored.threads.change(ID, (thread) => ({ ...thread, title: 'Four' }));
  await restored.threads.save(ID);
  expect(names(documents, 'threadseg-')).toEqual([threadSegmentDocument(ID, 4)]);
});

test('a crash after journaling tool intent replays the segments, interrupts the tool, and never replays it', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  live.port.writeRuntimeDocument.mockClear();
  await journalToolIntent(live.threads, ID);
  // Each journal save appends one segment and leaves the base alone.
  expect(live.port.writeRuntimeDocument.mock.calls.map(([name]) => name)).toEqual([
    threadSegmentDocument(ID, 1),
    threadSegmentDocument(ID, 2),
    threadSegmentDocument(ID, 3),
  ]);
  expect(storedLocalThread(live.documents, ID)).toEqual(live.threads.get(ID));

  const crashed = new Map(live.documents);
  const first = await open(crashed);
  const recovered = first.threads.get(ID);
  expect(recovered).toEqual(recoverLocalThread(live.threads.get(ID)));
  expect(recovered.status).toBe('interrupted');
  expect(recovered.messages.find((message) => message.id === 'tool-1')?.tool?.status).toBe(
    'interrupted',
  );
  // Recovery is journaled as the next segment after the replayed ones; the base is untouched.
  expect(first.port.writeRuntimeDocument.mock.calls.map(([name]) => name)).toEqual([
    threadSegmentDocument(ID, 4),
  ]);
  expect(JSON.parse(crashed.get(threadSegmentDocument(ID, 4)) ?? '{}')).toMatchObject({
    set: { status: 'interrupted', activeTurnId: null },
  });
  expect(storedLocalThread(crashed, ID)).toEqual(recovered);

  const second = await open(crashed);
  expect(second.threads.get(ID)).toEqual(recovered);
  expect(second.port.writeRuntimeDocument).not.toHaveBeenCalled();
});

test('a crash between compaction and segment removal discards the already-applied segments', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  await journalToolIntent(live.threads, ID);
  live.port.removeRuntimeDocument.mockRejectedValue(new Error('Crashed before removal'));
  // A final answer too large for a segment compacts the journal into a new base.
  live.threads.change(ID, (thread) => {
    const settled = recoverLocalThread(thread);
    return {
      ...settled,
      status: 'complete',
      activeTurnId: null,
      lastError: null,
      messages: [
        ...settled.messages,
        {
          id: 'assistant-2',
          role: 'assistant',
          content: 'x'.repeat(THREAD_SEGMENT_MAX_BYTES),
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
  });
  await live.threads.save(ID);
  await live.threads.flush();
  expect(JSON.parse(live.documents.get(threadDocument(ID)) ?? '{}')).toMatchObject({
    segment: 3,
    status: 'complete',
  });
  expect(names(live.documents, 'threadseg-')).toHaveLength(3);

  const restored = await open(new Map(live.documents));
  expect(restored.threads.get(ID)).toEqual(live.threads.get(ID));
  expect(names(restored.documents, 'threadseg-')).toEqual([]);
  expect(names(restored.documents, 'quarantine-')).toEqual([]);
  expect(restored.threads.recovery()).toMatchObject({ setAside: 0, leftInPlace: 0 });
  expect(restored.port.writeRuntimeDocument).not.toHaveBeenCalled();

  // Later segments continue after the compacted position.
  await restored.threads.save(ID);
  restored.threads.change(ID, (thread) => ({ ...thread, title: 'Next' }));
  await restored.threads.save(ID);
  expect(names(restored.documents, 'threadseg-')).toEqual([threadSegmentDocument(ID, 4)]);
});

test('a damaged segment and every later one are set aside with their bytes preserved', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  for (const title of ['One', 'Two', 'Three']) {
    live.threads.change(ID, (thread) => ({ ...thread, title }));
    await live.threads.save(ID);
  }
  const documents = new Map(live.documents);
  const third = documents.get(threadSegmentDocument(ID, 3)) ?? '';
  documents.set(threadSegmentDocument(ID, 2), '{"version":1,"thread"');

  const restored = await open(documents);
  expect(restored.threads.get(ID).title).toBe('One');
  expect(restored.threads.recovery()).toEqual({ setAside: 1, leftInPlace: 0, ids: new Set([ID]) });
  const setAside = names(documents, 'quarantine-').map((name) => documents.get(name));
  expect(setAside.sort()).toEqual(['{"version":1,"thread"', third].sort());
  // The next write is a base past every set-aside position, so their names are never reused.
  expect(names(documents, 'threadseg-')).toEqual([]);
  expect(JSON.parse(documents.get(threadDocument(ID)) ?? '{}')).toMatchObject({
    segment: 3,
    title: 'One',
  });
  restored.threads.change(ID, (thread) => ({ ...thread, title: 'Four' }));
  await restored.threads.save(ID);
  expect(names(documents, 'threadseg-')).toEqual([threadSegmentDocument(ID, 4)]);
  expect((await open(new Map(documents))).threads.get(ID).title).toBe('Four');
});

test('a damaged trailing segment that cannot be moved is left in place and never overwritten', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  live.threads.change(ID, (thread) => ({ ...thread, title: 'Kept' }));
  await live.threads.save(ID);
  live.threads.change(ID, (thread) => ({ ...thread, title: 'Lost' }));
  await live.threads.save(ID);
  const documents = new Map(live.documents);
  documents.set(threadSegmentDocument(ID, 2), 'damaged');
  const port = storage(documents);
  port.writeRuntimeDocument.mockImplementation(async (name, value) => {
    if (name.startsWith('quarantine-')) {
      throw new Error('Disk full');
    }
    documents.set(name, value);
  });
  const threads = new LocalThreadRepository(port, jest.fn(), 60_000);
  await threads.initialize();
  expect(threads.get(ID).title).toBe('Kept');
  expect(threads.recovery()).toMatchObject({ setAside: 0, leftInPlace: 1 });
  expect(documents.get(threadSegmentDocument(ID, 2))).toBe('damaged');
  threads.change(ID, (thread) => ({ ...thread, title: 'After' }));
  await threads.save(ID);
  expect(documents.get(threadSegmentDocument(ID, 2))).toBe('damaged');
  expect(names(documents, 'threadseg-')).toEqual([
    threadSegmentDocument(ID, 2),
    threadSegmentDocument(ID, 3),
  ]);
});

test('a damaged base is set aside together with its segments', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  live.threads.change(ID, (thread) => ({ ...thread, title: 'Edited' }));
  await live.threads.save(ID);
  const documents = new Map(live.documents);
  const segment = documents.get(threadSegmentDocument(ID, 1));
  documents.set(threadDocument(ID), '{not json');
  const restored = await open(documents);
  expect(restored.threads.list()).toEqual([]);
  expect(restored.threads.recovery()).toEqual({ setAside: 1, leftInPlace: 0, ids: new Set([ID]) });
  expect(
    names(documents, 'quarantine-')
      .map((name) => documents.get(name))
      .sort(),
  ).toEqual([segment, '{not json'].sort());
  expect(names(documents, 'thread')).toEqual([]);
});

test('a damaged base stays in place while its segments cannot be set aside', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  live.threads.change(ID, (thread) => ({ ...thread, title: 'Edited' }));
  await live.threads.save(ID);
  const documents = new Map(live.documents);
  const segment = documents.get(threadSegmentDocument(ID, 1));
  documents.set(threadDocument(ID), '{not json');
  for (let restart = 0; restart < 2; restart += 1) {
    const port = storage(documents);
    port.writeRuntimeDocument.mockImplementation(async (name, value) => {
      if (name.includes('threadseg-')) {
        throw new Error('Disk full');
      }
      documents.set(name, value);
    });
    const threads = new LocalThreadRepository(port, jest.fn(), 60_000);
    await threads.initialize();
    expect(threads.list()).toEqual([]);
    expect(threads.recovery()).toMatchObject({ leftInPlace: 1 });
    // The segment is never treated as an orphan of an interrupted delete.
    expect(documents.get(threadSegmentDocument(ID, 1))).toBe(segment);
    expect(documents.get(threadDocument(ID))).toBe('{not json');
  }
});

test('deleting a conversation removes every segment, and an interrupted delete stays deleted', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  for (const title of ['One', 'Two']) {
    live.threads.change(ID, (thread) => ({ ...thread, title }));
    await live.threads.save(ID);
  }
  const interrupted = new Map(live.documents);
  expect(names(live.documents, 'threadseg-')).toHaveLength(2);
  await live.threads.remove(ID);
  expect([...live.documents.keys()].filter((name) => name.includes(ID))).toEqual([]);

  // The base is removed first; a crash before the segments go leaves them without a base.
  interrupted.delete(threadDocument(ID));
  const restored = await open(interrupted);
  expect(restored.threads.list()).toEqual([]);
  expect([...interrupted.keys()].filter((name) => name.includes(ID))).toEqual([]);
  expect(names(interrupted, 'quarantine-')).toEqual([]);
});

test('segments stay small and bounded: large changes and long journals are compacted', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  live.port.writeRuntimeDocument.mockClear();
  await append(live.threads, ID, userMessage('large', 'x'.repeat(THREAD_SEGMENT_MAX_BYTES)));
  expect(live.port.writeRuntimeDocument.mock.calls.map(([name]) => name)).toEqual([
    threadDocument(ID),
  ]);

  live.port.writeRuntimeDocument.mockClear();
  for (let index = 0; index <= THREAD_COMPACT_SEGMENTS; index += 1) {
    live.threads.change(ID, (thread) => ({ ...thread, title: `Title ${index}` }));
    await live.threads.save(ID);
  }
  const written = live.port.writeRuntimeDocument.mock.calls;
  expect(written.slice(0, -1).every(([name]) => name.startsWith('threadseg-'))).toBe(true);
  expect(written.at(-1)?.[0]).toBe(threadDocument(ID));
  expect(Math.max(...written.map(([, value]) => utf8Bytes(value)))).toBeLessThan(
    RUNTIME_DOCUMENT_MAX_BYTES,
  );
  expect(names(live.documents, 'threadseg-')).toEqual([]);
  expect((await open(new Map(live.documents))).threads.get(ID)).toEqual(live.threads.get(ID));
});

test('a failed segment write is retried at the same position with every pending change', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  live.port.writeRuntimeDocument.mockRejectedValueOnce(new Error('Disk full'));
  live.threads.change(ID, (thread) => ({ ...thread, title: 'First' }));
  await expect(live.threads.save(ID)).rejects.toThrow('Disk full');
  await append(live.threads, ID, userMessage('user-1'));
  expect(live.threads.persistenceError()).toBeNull();
  expect(names(live.documents, 'threadseg-')).toEqual([threadSegmentDocument(ID, 1)]);
  expect((await open(new Map(live.documents))).threads.get(ID)).toEqual(live.threads.get(ID));
});

function historyMessages(count: number): LocalMessage[] {
  return Array.from({ length: count }, (_, index) =>
    userMessage(`history-${String(index).padStart(4, '0')}`, 'x'.repeat(1024)),
  );
}

test('a save after changing one message serializes only that message', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  const history = historyMessages(200);
  await append(live.threads, ID, ...history);
  const changed = userMessage('history-0100', 'edited');
  const stringify = jest.spyOn(JSON, 'stringify');
  try {
    live.threads.change(ID, (thread) => ({
      ...thread,
      messages: thread.messages.map((message) => (message.id === changed.id ? changed : message)),
    }));
    await live.threads.save(ID);
    const unchanged = new Set<unknown>(history.filter((message) => message.id !== changed.id));
    expect(stringify.mock.calls.some(([value]) => unchanged.has(value))).toBe(false);
    const serialized = stringify.mock.results.reduce(
      (sum, result) => sum + (typeof result.value === 'string' ? result.value.length : 0),
      0,
    );
    expect(serialized).toBeLessThan(1024);
  } finally {
    stringify.mockRestore();
  }
  expect(names(live.documents, 'threadseg-')).toEqual([
    threadSegmentDocument(ID, 1),
    threadSegmentDocument(ID, 2),
  ]);
  expect(JSON.parse(live.documents.get(threadSegmentDocument(ID, 2)) ?? '{}')).toEqual({
    version: 1,
    thread: ID,
    sequence: 2,
    set: {},
    remove: [],
    messages: [changed],
  });
  expect((await open(new Map(live.documents))).threads.get(ID)).toEqual(live.threads.get(ID));
});

test('a progress save during a run only inspects the messages that changed', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  await journalToolIntent(live.threads, ID);
  let reads = 0;
  const history = historyMessages(50).map((message) => {
    const calls: LocalMessage['toolCalls'] = [];
    return Object.defineProperty({ ...message }, 'toolCalls', {
      enumerable: true,
      get: () => {
        reads += 1;
        return calls;
      },
    });
  });
  await append(live.threads, ID, ...history, toolCallMessage('assistant-2', 'call-2'));
  live.port.writeRuntimeDocument.mockClear();
  reads = 0;
  // Streaming into the last assistant message is progress: it is coalesced, not journaled.
  live.threads.change(ID, (thread) => ({
    ...thread,
    messages: thread.messages.map((message) =>
      message.id === 'assistant-2' ? { ...message, content: 'streamed' } : message,
    ),
  }));
  await live.threads.save(ID);
  expect(live.port.writeRuntimeDocument).not.toHaveBeenCalled();
  expect(reads).toBe(0);

  // A new tool call is still journal intent and is written before the save resolves.
  live.threads.change(ID, (thread) => ({
    ...thread,
    messages: thread.messages.map((message) =>
      message.id === 'assistant-2' ? toolCallMessage('assistant-2', 'call-3') : message,
    ),
  }));
  await live.threads.save(ID);
  expect(live.port.writeRuntimeDocument.mock.calls.map(([name]) => name)).toEqual([
    threadSegmentDocument(ID, 5),
  ]);
  expect(reads).toBe(0);
});

test('settling a run appends a segment, and a crash replays to the settled conversation', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  const base = live.documents.get(threadDocument(ID));
  await journalToolIntent(live.threads, ID);
  live.port.writeRuntimeDocument.mockClear();
  live.threads.change(ID, (thread) => ({
    ...thread,
    status: 'complete',
    activeTurnId: null,
    lastError: null,
    updatedAt: '2026-01-02T00:00:00.000Z',
    messages: [
      ...thread.messages.map((message) =>
        message.id === 'tool-1' && message.tool
          ? {
              ...message,
              content: '{"ok":true}',
              tool: { ...message.tool, status: 'completed' as const },
            }
          : message,
      ),
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'Done',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ],
  }));
  await live.threads.save(ID);
  await live.threads.flush();
  expect(live.port.writeRuntimeDocument.mock.calls.map(([name]) => name)).toEqual([
    threadSegmentDocument(ID, 4),
  ]);
  expect(live.port.removeRuntimeDocument).not.toHaveBeenCalled();
  expect(live.documents.get(threadDocument(ID))).toBe(base);
  const settled = live.threads.get(ID);
  expect(JSON.parse(live.documents.get(threadSegmentDocument(ID, 4)) ?? '{}')).toEqual({
    version: 1,
    thread: ID,
    sequence: 4,
    set: { updatedAt: '2026-01-02T00:00:00.000Z', status: 'complete', activeTurnId: null },
    remove: [],
    messages: settled.messages.slice(-2),
  });

  // A crash after settlement replays base + running segments + settlement, with nothing to recover.
  const crashed = await open(new Map(live.documents));
  expect(crashed.threads.get(ID)).toEqual(settled);
  expect(crashed.threads.recovery()).toMatchObject({ setAside: 0, leftInPlace: 0 });
  expect(crashed.port.writeRuntimeDocument).not.toHaveBeenCalled();

  // An interrupted second run on top of the settled journal is still recovered.
  await journalToolIntentAgain(crashed.threads);
  const interrupted = await open(new Map(crashed.documents));
  const recovered = interrupted.threads.get(ID);
  expect(recovered).toEqual(recoverLocalThread(crashed.threads.get(ID)));
  expect(recovered.status).toBe('interrupted');
  expect(recovered.messages.slice(0, settled.messages.length)).toEqual(settled.messages);
  expect(recovered.messages.find((message) => message.id === 'tool-2')?.tool?.status).toBe(
    'interrupted',
  );
  expect(storedLocalThread(interrupted.documents, ID)).toEqual(recovered);
});

async function journalToolIntentAgain(threads: LocalThreadRepository) {
  threads.change(ID, (thread) => ({ ...thread, status: 'running', activeTurnId: 'turn-2' }));
  await append(threads, ID, userMessage('user-2', 'Change it again'));
  await append(threads, ID, toolCallMessage('assistant-3', 'call-2'));
  await append(threads, ID, pendingTool('tool-2', 'call-2'));
}

test('settling a run compacts only when the journal reaches its limits', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  live.threads.change(ID, (thread) => ({ ...thread, status: 'running', activeTurnId: 'turn-1' }));
  await live.threads.save(ID);
  for (let index = 1; index < THREAD_COMPACT_SEGMENTS; index += 1) {
    await append(live.threads, ID, userMessage(`user-${index}`));
  }
  expect(names(live.documents, 'threadseg-')).toHaveLength(THREAD_COMPACT_SEGMENTS);
  live.port.writeRuntimeDocument.mockClear();
  live.threads.change(ID, (thread) => ({ ...thread, status: 'complete', activeTurnId: null }));
  await live.threads.save(ID);
  await live.threads.flush();
  expect(live.port.writeRuntimeDocument.mock.calls.map(([name]) => name)).toEqual([
    threadDocument(ID),
  ]);
  expect(names(live.documents, 'threadseg-')).toEqual([]);
  expect((await open(new Map(live.documents))).threads.get(ID)).toEqual(live.threads.get(ID));
});

test('a base and segments written by earlier builds still load, and new segments keep the format', async () => {
  const documents = new Map([
    [
      threadDocument(ID),
      `{"version":1,"id":"${ID}","title":"Stored","workspaceId":"workspace","modelId":"model","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","status":"idle","activeTurnId":null,"lastSubmissionId":null,"lastError":null,"messages":[{"id":"user-1","role":"user","content":"Hello","createdAt":"2026-01-01T00:00:00.000Z"}],"segment":2}`,
    ],
    [
      threadSegmentDocument(ID, 3),
      `{"version":1,"thread":"${ID}","sequence":3,"set":{"updatedAt":"2026-01-01T00:00:01.000Z","status":"running","activeTurnId":"turn-1"},"remove":[],"messages":[{"id":"assistant-1","role":"assistant","content":"","createdAt":"2026-01-01T00:00:01.000Z","toolCalls":[{"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{}"}}]}]}`,
    ],
    [
      threadSegmentDocument(ID, 4),
      `{"version":1,"thread":"${ID}","sequence":4,"set":{"status":"complete","activeTurnId":null},"remove":[],"messages":[{"id":"assistant-1","role":"assistant","content":"Hi","createdAt":"2026-01-01T00:00:01.000Z","reasoning":"","toolCalls":[]}]}`,
    ],
  ]);
  const { port, threads } = await open(documents);
  expect(port.writeRuntimeDocument).not.toHaveBeenCalled();
  expect(threads.get(ID)).toEqual({
    version: 1,
    id: ID,
    title: 'Stored',
    workspaceId: 'workspace',
    modelId: 'model',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    status: 'complete',
    activeTurnId: null,
    lastSubmissionId: null,
    lastError: null,
    messages: [
      { id: 'user-1', role: 'user', content: 'Hello', createdAt: '2026-01-01T00:00:00.000Z' },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Hi',
        createdAt: '2026-01-01T00:00:01.000Z',
        reasoning: '',
        toolCalls: [],
      },
    ],
  });
  threads.change(ID, (thread) => ({ ...thread, title: 'Renamed' }));
  await threads.save(ID);
  expect(documents.get(threadSegmentDocument(ID, 5))).toBe(
    `{"version":1,"thread":"${ID}","sequence":5,"set":{"title":"Renamed"},"remove":[],"messages":[]}`,
  );
});

test('list() orders by most recent update with stable ties and is not re-sorted while unchanged', async () => {
  const { threads } = await open();
  const created = [];
  for (let index = 0; index < 4; index += 1) {
    created.push((await threads.create('workspace', 'model')).id);
  }
  const stamp = [
    '2026-01-02T00:00:00.000Z',
    '2026-01-03T00:00:00.000Z',
    '2026-01-02T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  ];
  created.forEach((id, index) => {
    threads.change(id, (thread) => ({ ...thread, updatedAt: stamp[index] ?? '' }));
  });
  const first = threads.list();
  // Ties keep insertion order, exactly as the stable localeCompare sort did.
  expect(first.map((thread) => thread.id)).toEqual([
    created[1],
    created[0],
    created[2],
    created[3],
  ]);
  expect(first).toEqual([...first].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  const sort = jest.spyOn(Array.prototype, 'sort');
  try {
    expect(threads.list()).toBe(first);
    expect(threads.list()).toBe(first);
    expect(sort).not.toHaveBeenCalled();
  } finally {
    sort.mockRestore();
  }
  expect(Object.isFrozen(first)).toBe(true);

  threads.change(created[3] ?? '', (thread) => ({
    ...thread,
    updatedAt: '2026-01-04T00:00:00.000Z',
  }));
  const second = threads.list();
  expect(second).not.toBe(first);
  expect(second.map((thread) => thread.id)).toEqual([
    created[3],
    created[1],
    created[0],
    created[2],
  ]);
  await threads.remove(created[1] ?? '');
  expect(threads.list().map((thread) => thread.id)).toEqual([created[3], created[0], created[2]]);
});
