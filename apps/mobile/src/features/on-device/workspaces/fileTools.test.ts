import { executeFileTool, isFileTool, type FileToolPort } from './fileTools';
import { FILE_TOOL_DEFINITIONS } from './fileToolDefinitions';

const revision = 'a'.repeat(64);

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
  for (const definition of FILE_TOOL_DEFINITIONS) {
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
