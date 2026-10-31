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
  // Recovery is compacted into a new base that records the replayed segments.
  expect(names(crashed, 'threadseg-')).toEqual([]);
  expect(JSON.parse(crashed.get(threadDocument(ID)) ?? '{}')).toMatchObject({
    segment: 3,
    status: 'interrupted',
  });

  const second = await open(crashed);
  expect(second.threads.get(ID)).toEqual(recovered);
  expect(second.port.writeRuntimeDocument).not.toHaveBeenCalled();
});

test('a crash between compaction and segment removal discards the already-applied segments', async () => {
  const live = await open();
  await live.threads.create('workspace', 'model');
  await journalToolIntent(live.threads, ID);
  live.port.removeRuntimeDocument.mockRejectedValue(new Error('Crashed before removal'));
  live.threads.change(ID, (thread) => ({
    ...recoverLocalThread(thread),
    status: 'complete',
    activeTurnId: null,
    lastError: null,
  }));
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
