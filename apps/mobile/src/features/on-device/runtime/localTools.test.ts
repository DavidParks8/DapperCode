import { OnDeviceNativeError } from '../native/services.errors';
import {
  EMPTY_WORKSPACE_SEARCH_NOTE,
  LOCAL_TOOL_DEFINITIONS,
  localToolApproval,
  localToolExecutor,
  localToolKind,
} from './localTools';
import { createFakeOnDeviceNative, FakeLlama } from './testing';
import { toolDefinition } from './toolDefinition';
import { isRecord } from '@shared/records';

const firstRevision = 'a'.repeat(64);
const editedRevision = 'b'.repeat(64);

test('tool definitions declare metadata separately from model schemas', () => {
  const tool = toolDefinition('custom_tool', 'A custom tool.', {}, [], {
    kind: 'think',
    approval: () => 'Use the custom tool',
  });
  expect(tool).toMatchObject({ kind: 'think', approval: expect.any(Function) });
  expect(tool.definition).toEqual({
    type: 'function',
    function: {
      name: 'custom_tool',
      description: 'A custom tool.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  });
  for (const definition of LOCAL_TOOL_DEFINITIONS) {
    expect(Object.keys(definition)).toEqual(['type', 'function']);
    expect(definition).not.toHaveProperty('approval');
    expect(definition).not.toHaveProperty('kind');
  }
});

test('every advertised tool uses the registered category and permission declaration', () => {
  const names: string[] = [];
  const inputs: Readonly<Record<string, unknown>> = {
    web_fetch: { url: 'https://example.com/' },
    web_search: { query: 'Public docs' },
  };
  for (const definition of LOCAL_TOOL_DEFINITIONS) {
    const schema = isRecord(definition) ? definition['function'] : null;
    if (!isRecord(schema) || typeof schema['name'] !== 'string') {
      throw new Error('The model tool schema has no name.');
    }
    const name = schema['name'];
    names.push(name);
    const permission = localToolApproval(name, inputs[name]);
    if (permission) {
      expect(permission.kind).toBe(localToolKind(name));
      expect(permission.summary).not.toBe('');
    }
  }
  expect(new Set(names).size).toBe(names.length);
  expect(localToolApproval('read_file', { path: 'file.txt' })).toBeNull();
  expect(localToolKind('historical_unknown_tool')).toBe('other');
  expect(() => localToolApproval('unregistered_tool', {})).toThrow('not available');
});

function harness() {
  const { native } = createFakeOnDeviceNative(new FakeLlama());
  const read = jest.spyOn(native, 'readWorkspaceFile').mockResolvedValue({
    path: 'source.txt',
    content: 'before',
    revision: firstRevision,
    nextOffset: null,
    totalBytes: 6,
  });
  const edit = jest.spyOn(native, 'editWorkspaceFile').mockResolvedValue(editedRevision);
  const rename = jest.spyOn(native, 'renameWorkspacePath').mockResolvedValue(undefined);
  const remove = jest.spyOn(native, 'removeWorkspacePath').mockResolvedValue(undefined);
  const write = jest.spyOn(native, 'writeWorkspaceFile').mockResolvedValue(firstRevision);
  const execute = localToolExecutor(
    native,
    () => null,
    async () => null,
    () => undefined,
  );
  const signal = new AbortController().signal;
  return { execute, signal, read, edit, rename, remove, write, native };
}

test('apply_patch uses only turn-scoped observations and advances all changed path versions', async () => {
  const h = harness();
  const patch = jest.spyOn(h.native, 'applyWorkspacePatch').mockResolvedValue({
    files: [
      { path: 'source.txt', revision: null },
      { path: 'moved.txt', revision: editedRevision },
      { path: 'added.txt', revision: firstRevision },
    ],
  });
  await h.execute('one', 'read_file', { path: 'source.txt' }, h.signal);
  const input = '*** Begin Patch\n*** Delete File: source.txt\n*** End Patch';
  await h.execute('two', 'apply_patch', { patch: input }, h.signal);
  expect(patch).toHaveBeenLastCalledWith('two', input, {}, expect.any(String));
  await h.execute('one', 'apply_patch', { patch: input }, h.signal);
  expect(patch).toHaveBeenLastCalledWith(
    'one',
    input,
    { 'source.txt': firstRevision },
    expect.any(String),
  );
  await h.execute('one', 'delete_path', { path: 'moved.txt' }, h.signal);
  expect(h.remove).toHaveBeenLastCalledWith('one', 'moved.txt', editedRevision);
  await h.execute('one', 'write_file', { path: 'source.txt', content: 'new' }, h.signal);
  expect(h.write).toHaveBeenLastCalledWith('one', 'source.txt', 'new', null);
});

test('failed patches do not change observed versions or silently reread sources', async () => {
  const h = harness();
  jest
    .spyOn(h.native, 'applyWorkspacePatch')
    .mockRejectedValue(new OnDeviceNativeError('FILE_REVISION_CONFLICT', 'Source changed.'));
  await h.execute('one', 'read_file', { path: 'source.txt' }, h.signal);
  await expect(h.execute('one', 'apply_patch', { patch: 'patch' }, h.signal)).rejects.toMatchObject(
    { code: 'FILE_REVISION_CONFLICT' },
  );
  await h.execute('one', 'delete_path', { path: 'source.txt' }, h.signal);
  expect(h.remove).toHaveBeenLastCalledWith('one', 'source.txt', firstRevision);
  expect(h.read).toHaveBeenCalledTimes(1);
});

test('one turn reads, edits, renames and deletes with trusted latest revisions, not copied hashes', async () => {
  const h = harness();
  await h.execute('workspace', 'read_file', { path: 'source.txt' }, h.signal);
  await h.execute(
    'workspace',
    'edit_file',
    { path: 'source.txt', old_text: 'before', new_text: 'after' },
    h.signal,
  );
  await h.execute(
    'workspace',
    'rename_path',
    { path: 'source.txt', destination: 'destination.txt' },
    h.signal,
  );
  await h.execute('workspace', 'delete_path', { path: 'destination.txt' }, h.signal);
  expect(h.edit).toHaveBeenCalledWith('workspace', 'source.txt', 'before', 'after', firstRevision);
  expect(h.rename).toHaveBeenCalledWith(
    'workspace',
    'source.txt',
    'destination.txt',
    editedRevision,
  );
  expect(h.remove).toHaveBeenCalledWith('workspace', 'destination.txt', editedRevision);
});

test('observed file versions never cross workspace or turn boundaries', async () => {
  const h = harness();
  await h.execute('one', 'read_file', { path: 'source.txt' }, h.signal);
  const args = { path: 'source.txt', old_text: 'before', new_text: 'after' };
  await expect(h.execute('two', 'edit_file', args, h.signal)).rejects.toThrow('revision');
  await expect(h.execute('one', 'edit_file', args, new AbortController().signal)).rejects.toThrow(
    'revision',
  );
  expect(h.edit).not.toHaveBeenCalled();
});

test('an empty workspace search tells the model it is not evidence that something does not exist', async () => {
  const { native } = createFakeOnDeviceNative(new FakeLlama());
  const search = jest.spyOn(native, 'searchWorkspaceFiles');
  const execute = localToolExecutor(
    native,
    () => null,
    async () => null,
    () => undefined,
  );
  const empty = {
    matches: [],
    truncated: false,
    skippedFiles: 0,
    visitedEntries: 12,
    searchedBytes: 4096,
  };
  search.mockResolvedValueOnce(empty);
  await expect(execute('workspace', 'search_files', { query: 'GlassView' })).resolves.toEqual({
    ...empty,
    note: EMPTY_WORKSPACE_SEARCH_NOTE,
  });
  const found = { ...empty, matches: [{ path: 'App.tsx', line: 3, content: '<GlassView />' }] };
  search.mockResolvedValueOnce(found);
  await expect(execute('workspace', 'search_files', { query: 'GlassView' })).resolves.toEqual(
    found,
  );
  expect(search).toHaveBeenCalledWith('workspace', 'GlassView');
  expect(EMPTY_WORKSPACE_SEARCH_NOTE).toContain('not that it does not exist');
  // Telling models to search the web here made them send this project's own symbols to Exa.
  expect(EMPTY_WORKSPACE_SEARCH_NOTE).not.toMatch(/web/i);
});

test('external changes still fail native compare-and-swap without silently refreshing the file', async () => {
  const h = harness();
  await h.execute('workspace', 'read_file', { path: 'source.txt' }, h.signal);
  h.edit.mockRejectedValueOnce(
    new OnDeviceNativeError('FILE_REVISION_CONFLICT', 'The source changed externally.'),
  );
  await expect(
    h.execute(
      'workspace',
      'edit_file',
      { path: 'source.txt', old_text: 'before', new_text: 'after' },
      h.signal,
    ),
  ).rejects.toMatchObject({ code: 'FILE_REVISION_CONFLICT' });
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(h.edit).toHaveBeenCalledWith('workspace', 'source.txt', 'before', 'after', firstRevision);
  expect(h.rename).not.toHaveBeenCalled();
  expect(h.remove).not.toHaveBeenCalled();
});

test('legacy explicit revisions are not replaced with a newer observed version', async () => {
  const h = harness();
  h.read.mockResolvedValueOnce({
    path: 'source.txt',
    content: 'after',
    revision: editedRevision,
    nextOffset: null,
    totalBytes: 5,
  });
  await h.execute('workspace', 'read_file', { path: 'source.txt' }, h.signal);
  await h.execute(
    'workspace',
    'edit_file',
    { path: 'source.txt', old_text: 'after', new_text: 'next', expected_revision: firstRevision },
    h.signal,
  );
  expect(h.edit).toHaveBeenCalledWith('workspace', 'source.txt', 'after', 'next', firstRevision);
});

test('successful deletion forgets the old file version before a later creation', async () => {
  const h = harness();
  await h.execute('workspace', 'read_file', { path: 'source.txt' }, h.signal);
  await h.execute('workspace', 'delete_path', { path: 'source.txt' }, h.signal);
  await h.execute('workspace', 'write_file', { path: 'source.txt', content: 'new' }, h.signal);
  expect(h.write).toHaveBeenCalledWith('workspace', 'source.txt', 'new', null);
});

test('a successful creation supplies the version for the next exact edit', async () => {
  const h = harness();
  await h.execute('workspace', 'write_file', { path: 'source.txt', content: 'before' }, h.signal);
  await h.execute(
    'workspace',
    'edit_file',
    { path: 'source.txt', old_text: 'before', new_text: 'after' },
    h.signal,
  );
  expect(h.edit).toHaveBeenCalledWith('workspace', 'source.txt', 'before', 'after', firstRevision);
  expect(h.read).not.toHaveBeenCalled();
});

test('directory renames invalidate observed child paths instead of reusing stale locations', async () => {
  const h = harness();
  await h.execute('workspace', 'read_file', { path: 'folder/source.txt' }, h.signal);
  await h.execute('workspace', 'rename_path', { path: 'folder', destination: 'moved' }, h.signal);
  const edit = { old_text: 'before', new_text: 'after' };
  await expect(
    h.execute('workspace', 'edit_file', { ...edit, path: 'folder/source.txt' }, h.signal),
  ).rejects.toThrow('revision');
  await expect(
    h.execute('workspace', 'edit_file', { ...edit, path: 'moved/source.txt' }, h.signal),
  ).rejects.toThrow('revision');
  expect(h.edit).not.toHaveBeenCalled();
  expect(h.rename).toHaveBeenCalledWith('workspace', 'folder', 'moved', null);
});

test('an incomplete empty search is never described as no workspace matches', async () => {
  const h = harness();
  const result = {
    matches: [],
    files: [],
    reason: 'bytes' as const,
    nextOffset: null,
    truncated: true,
    skippedFiles: 3,
    excludedEntries: 4,
    visitedEntries: 300,
    searchedBytes: 16 * 1024 * 1024,
  };
  jest.spyOn(h.native, 'queryWorkspaceFiles').mockResolvedValue(result);
  await expect(h.execute('workspace', 'search_files', { query: 'x' }, h.signal)).resolves.toEqual(
    result,
  );
});
