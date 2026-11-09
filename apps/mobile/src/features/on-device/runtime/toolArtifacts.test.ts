import { randomUUID } from 'expo-crypto';
import {
  LocalToolArtifacts,
  LocalArtifactStorageError,
  TOOL_ARTIFACT_MAX_BYTES,
  TOOL_ARTIFACT_MAX_COUNT,
  executeWithToolOutput,
} from './toolArtifacts';
import type { LocalDocumentPort } from './threads';
import { newLocalChild } from './delegation';
import type { LocalMessage } from './types';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
const thread = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
beforeEach(() => {
  let id = 100;
  jest
    .mocked(randomUUID)
    .mockImplementation(() => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`);
});

function harness() {
  const documents = new Map<string, string>();
  const port = {
    readRuntimeDocument: jest.fn((name: string) => Promise.resolve(documents.get(name) ?? null)),
    writeRuntimeDocument: jest.fn((name: string, value: string) => {
      documents.set(name, value);
      return Promise.resolve();
    }),
    listRuntimeDocuments: jest.fn((prefix: string) =>
      Promise.resolve([...documents.keys()].filter((name) => name.startsWith(prefix))),
    ),
    removeRuntimeDocument: jest.fn((name: string) => {
      documents.delete(name);
      return Promise.resolve();
    }),
  } satisfies LocalDocumentPort;
  return { documents, port, artifacts: new LocalToolArtifacts(port) };
}

test('offloads exact producer JSON, keeps honest truncation metadata, and retrieves after reload', async () => {
  const h = harness();
  const result = {
    path: 'large.ts',
    revision: 'a'.repeat(64),
    truncated: true,
    nextOffset: 12345,
    content: 'evidence🦙'.repeat(2000),
  };
  const saved = (await h.artifacts.offload(thread, 'workspace', 'read_file', result)) as {
    artifactId: string;
  };
  expect(saved).toMatchObject({
    offloaded: true,
    truncated: true,
    nextOffset: 12345,
    revision: result.revision,
  });
  expect(JSON.stringify(saved).length).toBeLessThan(1500);
  const reloaded = new LocalToolArtifacts(h.port);
  let recovered = '';
  let offset: number | null = 0;
  while (offset !== null) {
    const page = (await reloaded.retrieve(thread, 'workspace', 'read_tool_output', {
      artifactId: saved.artifactId,
      offset,
      limit: 4096,
    })) as { content: string; nextOffset: number | null };
    recovered += page.content;
    offset = page.nextOffset;
  }
  expect(JSON.parse(recovered)).toEqual(result);
});

test('literal search pages without regex execution or arbitrary runtime document access', async () => {
  const h = harness();
  const saved = (await h.artifacts.offload(thread, 'workspace', 'search_files', {
    content: 'lead [a+]+ needle tail\n'.repeat(400),
  })) as { artifactId: string };
  const first = (await h.artifacts.retrieve(thread, 'workspace', 'search_tool_output', {
    artifactId: saved.artifactId,
    query: '[a+]+',
  })) as { matches: unknown[]; nextOffset: number };
  expect(first.matches).toHaveLength(10);
  const second = await h.artifacts.retrieve(thread, 'workspace', 'search_tool_output', {
    artifactId: saved.artifactId,
    query: '[a+]+',
    offset: first.nextOffset,
  });
  expect(second).toMatchObject({
    matches: expect.arrayContaining([
      expect.objectContaining({ excerpt: expect.stringContaining('[a+]+') }),
    ]),
  });
  await expect(
    h.artifacts.retrieve(thread, 'workspace', 'read_tool_output', {
      artifactId: '../preferences.json',
    }),
  ).rejects.toThrow('artifactId');
  await expect(
    h.artifacts.retrieve(thread, 'workspace', 'read_tool_output', {
      artifactId: saved.artifactId,
      path: 'preferences.json',
    }),
  ).rejects.toThrow('unsupported');
  await expect(
    h.artifacts.retrieve(thread, 'workspace', 'read_tool_output', {
      artifactId: saved.artifactId,
      limit: 10000,
    }),
  ).rejects.toThrow('4096');
});

test('identities are isolated across threads/workspaces and deletion removes only the owner', async () => {
  const h = harness();
  const one = (await h.artifacts.offload(thread, 'one', 'read_file', {
    content: 'one'.repeat(2000),
  })) as { artifactId: string };
  const two = (await h.artifacts.offload(other, 'two', 'read_file', {
    content: 'two'.repeat(2000),
  })) as { artifactId: string };
  await expect(
    h.artifacts.retrieve(other, 'one', 'read_tool_output', { artifactId: one.artifactId }),
  ).rejects.toThrow('unavailable');
  await expect(
    h.artifacts.retrieve(thread, 'two', 'read_tool_output', { artifactId: one.artifactId }),
  ).rejects.toThrow('identity');
  await h.artifacts.removeThread(thread);
  await expect(
    h.artifacts.retrieve(thread, 'one', 'read_tool_output', { artifactId: one.artifactId }),
  ).rejects.toThrow('unavailable');
  await expect(
    h.artifacts.retrieve(other, 'two', 'read_tool_output', { artifactId: two.artifactId }),
  ).resolves.toMatchObject({ artifactId: two.artifactId });
});

test('hard caps and storage failures are explicit completed-operation errors, never silent clipping', async () => {
  const h = harness();
  await expect(
    h.artifacts.offload(thread, 'one', 'git_diff', { diff: 'x'.repeat(TOOL_ARTIFACT_MAX_BYTES) }),
  ).rejects.toThrow('2 MiB');
  expect(h.documents.size).toBe(0);
  h.port.writeRuntimeDocument.mockRejectedValueOnce(new Error('disk full'));
  await expect(
    h.artifacts.offload(thread, 'one', 'write_file', { content: 'x'.repeat(5000) }),
  ).rejects.toMatchObject({
    result: { outputStored: false, error: expect.stringContaining('Do not replay') },
  });
  await expect(
    h.artifacts.offload(thread, 'one', 'read_file', { content: 'x'.repeat(5000) }),
  ).resolves.toHaveProperty('artifactId');
});

test('per-conversation, total-byte and document-count quotas survive reload and serialize concurrent writes', async () => {
  const h = harness();
  const large = { content: 'x'.repeat(1024 * 1024) };
  for (let index = 0; index < 7; index += 1) {
    await h.artifacts.offload(thread, 'one', 'read_file', large);
  }
  await expect(
    new LocalToolArtifacts(h.port).offload(thread, 'one', 'read_file', large),
  ).rejects.toThrow('8 MiB');
  h.documents.clear();
  for (let index = 0; index < 33; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    h.documents.set(`toolartifact-${id}-${thread}.json`, 'x'.repeat(1024 * 1024));
  }
  await expect(h.artifacts.offload(thread, 'one', 'read_file', large)).rejects.toThrow('32 MiB');
  h.documents.clear();
  for (let index = 0; index < TOOL_ARTIFACT_MAX_COUNT - 1; index += 1) {
    h.documents.set(`toolartifact-unused-${index}`, '{}');
  }
  const concurrent = await Promise.allSettled([
    h.artifacts.offload(thread, 'one', 'read_file', large),
    h.artifacts.offload(thread, 'one', 'read_file', large),
  ]);
  expect(concurrent.map((entry) => entry.status)).toEqual(['fulfilled', 'rejected']);
  const failure = concurrent[1];
  if (failure?.status !== 'rejected') {
    throw new Error('Expected capacity failure');
  }
  expect(failure.reason).toBeInstanceOf(LocalArtifactStorageError);
  expect(h.documents.size).toBe(TOOL_ARTIFACT_MAX_COUNT);
});

test('orphan cleanup finishes interrupted deletions but preserves quarantine evidence', async () => {
  const h = harness();
  await h.artifacts.offload(thread, 'one', 'read_file', { content: 'x'.repeat(5000) });
  await h.artifacts.offload(other, 'two', 'read_file', { content: 'x'.repeat(5000) });
  h.documents.set(`quarantine-123-thread-${other}.json`, 'damaged base');
  await h.artifacts.removeOrphans(new Set());
  expect(
    [...h.documents.keys()].filter((name) => name.startsWith(`toolartifact-${thread}-`)),
  ).toHaveLength(0);
  expect(
    [...h.documents.keys()].filter((name) => name.startsWith(`toolartifact-${other}-`)),
  ).toHaveLength(1);
});

test('child outputs retain parent storage ownership across reload and require the exact child scope', async () => {
  const h = harness();
  const child = newLocalChild('explore', 'one', 'model');
  const sibling = newLocalChild('explore', 'one', 'model');
  const raw = await executeWithToolOutput(
    h.artifacts,
    { id: child.id, parentThreadId: thread, workspaceId: 'one' },
    'read_file',
    {},
    new AbortController().signal,
    async () => ({ content: `${'x'.repeat(8000)}TAIL-CHILD-EVIDENCE` }),
  );
  const saved = JSON.parse(raw) as { artifactId: string; child_id: string };
  expect(saved.child_id).toBe(child.id);
  expect([...h.documents.keys()][0]).toContain(`toolartifact-${thread}-`);
  const reloaded = new LocalToolArtifacts(h.port);
  await reloaded.removeOrphans(new Set([thread]));
  const messages: LocalMessage[] = [
    {
      id: 'children',
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      children: [child, sibling],
    },
  ];
  const parent = { id: thread, workspaceId: 'one', messages };
  const read = async (childId: string) =>
    executeWithToolOutput(
      reloaded,
      parent,
      'read_tool_output',
      { artifactId: saved.artifactId, child_id: childId, offset: 7900, limit: 4096 },
      new AbortController().signal,
      async () => {
        throw new Error('Saved output must not dispatch workspace tools.');
      },
    );
  expect((JSON.parse(await read(child.id)) as { content: string }).content).toContain(
    'TAIL-CHILD-EVIDENCE',
  );
  await expect(read(sibling.id)).rejects.toThrow('identity');
  await expect(read(other)).rejects.toThrow('unavailable');
  await reloaded.removeThread(thread);
  expect(h.documents.size).toBe(0);
});
