import { executeFileTool, isFileTool, workspacePatchPaths, type FileToolPort } from './fileTools';
import { FILE_TOOL_DEFINITIONS } from './fileToolDefinitions';

const revision = 'a'.repeat(64);

test.each(['write_file', 'edit_file', 'rename_path', 'delete_path'])(
  '%s generation does not require the model to copy opaque revision strings',
  (name) => {
    const definition = FILE_TOOL_DEFINITIONS.find(
      (tool) => tool.definition.function.name === name,
    )?.definition;
    expect(definition?.function.parameters.required).not.toContain('expected_revision');
    expect(definition?.function.parameters.properties).not.toHaveProperty('expected_revision');
  },
);

function port() {
  return {
    listWorkspaceFiles: jest.fn(async () => ({ entries: [], truncated: false })),
    readWorkspaceFile: jest.fn(async () => ({
      path: 'src/main.txt',
      content: 'contents',
      revision,
      nextOffset: null,
      totalBytes: 8,
    })),
    writeWorkspaceFile: jest.fn(async () => revision),
    editWorkspaceFile: jest.fn(async () => revision),
    renameWorkspacePath: jest.fn(async () => undefined),
    removeWorkspacePath: jest.fn(async () => undefined),
    beginWorkspaceOperation: jest.fn(),
    cancelWorkspaceOperation: jest.fn(),
    finishWorkspaceOperation: jest.fn(),
    applyWorkspacePatch: jest.fn(async () => ({ files: [] })),
    queryWorkspaceFiles: jest.fn(async () => ({
      matches: [],
      files: [],
      nextOffset: null,
      reason: 'complete' as const,
      truncated: false,
      skippedFiles: 0,
      excludedEntries: 0,
      visitedEntries: 0,
      searchedBytes: 0,
    })),
    searchWorkspaceFiles: jest.fn(async () => ({
      matches: [],
      truncated: false,
      skippedFiles: 0,
      visitedEntries: 0,
      searchedBytes: 0,
    })),
  } satisfies FileToolPort;
}

test('file tools bind the trusted workspace and return the native JSON result', async () => {
  const native = port();
  const result = await executeFileTool(
    'trusted-workspace',
    'read_file',
    { path: 'src/main.txt' },
    native,
  );
  expect(native.readWorkspaceFile).toHaveBeenCalledWith(
    'trusted-workspace',
    'src/main.txt',
    0,
    3072,
  );
  expect(result).toEqual({
    path: 'src/main.txt',
    content: 'contents',
    revision,
    nextOffset: null,
    totalBytes: 8,
  });
});

test('model discovery and filtered regex calls pass every control to the native owner', async () => {
  const native = port();
  await executeFileTool(
    'trusted',
    'glob_files',
    {
      pattern: 'src/**/*.t?',
      path: 'src',
      file_type: 'ts',
      offset: 20,
      limit: 7,
    },
    native,
  );
  expect(native.queryWorkspaceFiles).toHaveBeenLastCalledWith(
    'trusted',
    null,
    {
      path: 'src',
      include: 'src/**/*.t?',
      fileType: 'ts',
      regex: false,
      caseSensitive: true,
      offset: 20,
      limit: 7,
    },
    expect.any(String),
  );
  await executeFileTool(
    'trusted',
    'search_files',
    {
      query: '^café\\d+$',
      regex: true,
      case_sensitive: false,
      include: '**/*.ts',
      path: 'src',
      file_type: 'ts',
      limit: 3,
      offset: 1,
    },
    native,
  );
  expect(native.queryWorkspaceFiles).toHaveBeenLastCalledWith(
    'trusted',
    '^café\\d+$',
    {
      path: 'src',
      include: '**/*.ts',
      fileType: 'ts',
      regex: true,
      caseSensitive: false,
      offset: 1,
      limit: 3,
    },
    expect.any(String),
  );
});

test.each([
  ['glob_files', { offset: -1 }],
  ['glob_files', { limit: 101 }],
  ['search_files', { query: 'x', regex: 'true' }],
  ['search_files', { query: 'x', case_sensitive: 1 }],
  ['apply_patch', { patch: 'x', revisions: { 'file.txt': revision } }],
])('invalid advanced %s arguments never cross the boundary', async (name, args) => {
  const native = port();
  await expect(executeFileTool('trusted', name, args, native)).rejects.toThrow();
  expect(native.queryWorkspaceFiles).not.toHaveBeenCalled();
  expect(native.applyWorkspacePatch).not.toHaveBeenCalled();
});

test('cancellation reaches native synchronously and always releases the operation token', async () => {
  const native = port();
  const signal = new AbortController();
  let release: (() => void) | undefined;
  native.queryWorkspaceFiles.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            matches: [],
            files: [],
            nextOffset: null,
            reason: 'complete',
            truncated: false,
            skippedFiles: 0,
            excludedEntries: 0,
            visitedEntries: 0,
            searchedBytes: 0,
          });
      }),
  );
  const work = executeFileTool(
    'trusted',
    'glob_files',
    {},
    native,
    undefined,
    undefined,
    signal.signal,
  );
  signal.abort();
  expect(native.cancelWorkspaceOperation).toHaveBeenCalledWith(
    native.beginWorkspaceOperation.mock.calls[0]?.[0],
  );
  release?.();
  await work;
  expect(native.finishWorkspaceOperation).toHaveBeenCalledTimes(1);
  await expect(
    executeFileTool('trusted', 'glob_files', {}, native, undefined, undefined, signal.signal),
  ).rejects.toThrow('cancelled');
  expect(native.beginWorkspaceOperation).toHaveBeenCalledTimes(1);
});

test('model reads are bounded to chunks that fit small local contexts', async () => {
  const native = port();
  await expect(
    executeFileTool('trusted', 'read_file', { path: 'big.txt', limit: 65_536 }, native),
  ).rejects.toThrow('from 1 to 16384');
  await executeFileTool('trusted', 'read_file', { path: 'big.txt', limit: 16_384 }, native);
  expect(native.readWorkspaceFile).toHaveBeenCalledWith('trusted', 'big.txt', 0, 16_384);
});

test('the model cannot select another workspace through extra arguments', async () => {
  const native = port();
  await expect(
    executeFileTool('trusted', 'read_file', { path: 'main.txt', workspaceId: 'other' }, native),
  ).rejects.toThrow('unsupported arguments');
  expect(native.readWorkspaceFile).not.toHaveBeenCalled();
});

test('write and edit tools preserve optimistic revision checks without approval callbacks', async () => {
  const native = port();
  await expect(
    executeFileTool('trusted', 'write_file', { path: 'new.txt', content: 'new' }, native),
  ).resolves.toEqual({ path: 'new.txt', revision });
  expect(native.writeWorkspaceFile).toHaveBeenCalledWith('trusted', 'new.txt', 'new', null);
  await executeFileTool(
    'trusted',
    'edit_file',
    {
      path: 'main.txt',
      old_text: 'old',
      new_text: '',
      expected_revision: revision,
    },
    native,
  );
  expect(native.editWorkspaceFile).toHaveBeenCalledWith('trusted', 'main.txt', 'old', '', revision);
});

test('native failures are not converted into successful tool output', async () => {
  const native = port();
  native.writeWorkspaceFile.mockRejectedValue(new Error('The file changed.'));
  await expect(
    executeFileTool(
      'trusted',
      'write_file',
      {
        path: 'main.txt',
        content: 'new',
        expected_revision: revision,
      },
      native,
    ),
  ).rejects.toThrow('The file changed.');
});

test.each([
  ['read_file', { path: 'main.txt', offset: -1 }],
  ['read_file', { path: 'main.txt', offset: 0.5 }],
  ['read_file', { path: 'main.txt', limit: 65_537 }],
  ['read_file', { path: 4 }],
  ['list_directory', { limit: 0 }],
  ['edit_file', { path: 'main.txt', old_text: 'old', new_text: 'new' }],
  ['write_file', { path: 'main.txt', content: 'new', expected_revision: 'not-a-revision' }],
  ['delete_path', { path: 'main.txt', expected_revision: 'bad' }],
  ['search_files', { query: '' }],
])('invalid %s input fails before native execution', async (name, input) => {
  const native = port();
  await expect(executeFileTool('trusted', name, input, native)).rejects.toThrow();
  for (const method of Object.values(native)) {
    expect(method).not.toHaveBeenCalled();
  }
});

test('unknown tools cannot invoke credentials, processes, or arbitrary native methods', async () => {
  const native = port();
  for (const name of ['storeGitCredential', 'constructor', 'run_command', 'readWorkspaceFile']) {
    await expect(executeFileTool('trusted', name, {}, native)).rejects.toThrow('not available');
  }
  expect(native.readWorkspaceFile).not.toHaveBeenCalled();
});

test('every advertised file tool has a handler and a closed argument schema', () => {
  for (const { definition } of FILE_TOOL_DEFINITIONS) {
    expect(isFileTool(definition.function.name)).toBe(true);
    expect(definition.function.parameters.additionalProperties).toBe(false);
  }
  expect(isFileTool('run_command')).toBe(false);
});

test('directory listing defaults and mutation results are explicit', async () => {
  const native = port();
  await executeFileTool('trusted', 'list_directory', {}, native);
  expect(native.listWorkspaceFiles).toHaveBeenCalledWith('trusted', '', 64);
  await expect(
    executeFileTool(
      'trusted',
      'rename_path',
      {
        path: 'old.txt',
        destination: 'new.txt',
        expected_revision: revision,
      },
      native,
    ),
  ).resolves.toEqual({ path: 'old.txt', destination: 'new.txt' });
  expect(native.renameWorkspacePath).toHaveBeenCalledWith(
    'trusted',
    'old.txt',
    'new.txt',
    revision,
  );
  await expect(
    executeFileTool(
      'trusted',
      'delete_path',
      {
        path: 'new.txt',
        expected_revision: revision,
      },
      native,
    ),
  ).resolves.toEqual({ path: 'new.txt', removed: true });
});

test('patch scope extraction includes all sources/destinations but never hunk content', async () => {
  const native = port();
  const patch = [
    '*** Begin Patch',
    '*** Add File: src/new.txt',
    '+new',
    '*** Update File: src/🙂.txt',
    '*** Move to: moved/🙂.txt',
    '@@ -1 +1 @@',
    '-old',
    '+*** Delete File: not-a-path',
    '*** Delete File: obsolete.txt',
    '*** End Patch',
  ].join('\n');
  expect(workspacePatchPaths(patch)).toEqual([
    'src/new.txt',
    'src/🙂.txt',
    'moved/🙂.txt',
    'obsolete.txt',
  ]);
  await executeFileTool(
    'trusted',
    'apply_patch',
    { patch },
    native,
    undefined,
    new Map([
      ['src/🙂.txt', revision],
      ['obsolete.txt', revision],
      ['unrelated.txt', revision],
    ]),
  );
  expect(native.applyWorkspacePatch).toHaveBeenCalledWith(
    'trusted',
    patch,
    {
      'src/🙂.txt': revision,
      'obsolete.txt': revision,
    },
    expect.any(String),
  );
});

test('rule-loading patch paths are bounded without normalizing away native validation', () => {
  expect(workspacePatchPaths('*** Delete File: ../outside\n*** Delete File: .git/config')).toEqual([
    '../outside',
    '.git/config',
  ]);
  expect(() =>
    workspacePatchPaths(
      Array.from({ length: 65 }, (_, index) => `*** Add File: file-${index}`).join('\n'),
    ),
  ).toThrow('64');
});
