import { createHash } from 'node:crypto';
import { OnDeviceNativeError } from '../native/services.errors';
import {
  localToolApproval,
  localToolExecutor,
  localToolKind,
  LOCAL_TOOL_DEFINITIONS,
} from '../runtime/localTools';
import { createFakeOnDeviceNative, FakeLlama } from '../runtime/testing';
import { executeCodeTool } from './tools';
import { CODE_LIMITS } from './workspace';
import type { CodeWorkspacePort } from './workspace';
import type { LocalDirectoryListing } from '../workspaces/types';
import type { OnDeviceNativeServices } from '../native/services.types';
import * as standalone from 'prettier/standalone';
import { formatCodeFile } from './format';
import type * as AutomaticFormatting from './formatAfterFileEdit';

jest.mock('prettier/standalone', () => {
  // Normal calls use real Prettier; only the unexpected-exception regressions inject failures.
  const real = jest.requireActual<typeof standalone>('prettier/standalone');
  return { ...real, format: jest.fn(real.format) };
});

function memoryWorkspace(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const calls: string[] = [];
  let token = 0;
  const revision = (content: string) => createHash('sha256').update(content).digest('hex');
  const read = (path: string) => {
    const content = files.get(path);
    if (content === undefined) {
      throw new Error('FILE_NOT_FOUND');
    }
    return content;
  };
  const port: CodeWorkspacePort & Pick<OnDeviceNativeServices, 'editWorkspaceFile'> = {
    async getWorkspaceChangeToken() {
      return String(token);
    },
    async listWorkspaceFiles(_workspace, directory, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error('Native directory limit must be 1...1000.');
      }
      calls.push(directory);
      const entries = new Map<string, LocalDirectoryListing['entries'][number]>();
      for (const [path, content] of files) {
        const relative = directory
          ? path.startsWith(`${directory}/`)
            ? path.slice(directory.length + 1)
            : null
          : path;
        if (!relative) {
          continue;
        }
        const [name, nested] = relative.split('/');
        if (name) {
          entries.set(name, {
            name,
            kind: nested ? 'directory' : 'file',
            bytes: nested ? 0 : Buffer.byteLength(content),
          });
        }
      }
      return { entries: [...entries.values()].slice(0, limit), truncated: entries.size > limit };
    },
    async readWorkspaceFile(_workspace, path, offset, limit) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 65_536 ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      ) {
        throw new Error('Native read limit must be 1...65536 and offset non-negative.');
      }
      calls.push(path);
      const content = read(path);
      const bytes = Buffer.from(content);
      if (
        offset > bytes.length ||
        (offset < bytes.length && ((bytes[offset] ?? 0) & 0xc0) === 0x80)
      ) {
        throw new Error('Native read offset must be within the file and on a UTF-8 boundary.');
      }
      let end = Math.min(bytes.length, offset + limit);
      while (end < bytes.length && end > offset && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
        end--;
      }
      return {
        path,
        content: bytes.subarray(offset, end).toString('utf8'),
        revision: revision(content),
        nextOffset: end < bytes.length ? end : null,
        totalBytes: bytes.length,
      };
    },
    async writeWorkspaceFile(_workspace, path, content, expected) {
      if (files.has(path) ? expected !== revision(read(path)) : expected !== null) {
        throw new OnDeviceNativeError('FILE_REVISION_CONFLICT', 'Changed externally.');
      }
      files.set(path, content);
      token++;
      return revision(content);
    },
    async editWorkspaceFile(workspace, path, oldText, newText, expected) {
      const current = read(path);
      if (!current.includes(oldText) || current.indexOf(oldText) !== current.lastIndexOf(oldText)) {
        throw new Error('Expected exactly one occurrence.');
      }
      return port.writeWorkspaceFile(workspace, path, current.replace(oldText, newText), expected);
    },
  };
  const { native } = createFakeOnDeviceNative(new FakeLlama());
  Object.assign(native, port);
  const execute = localToolExecutor(
    native,
    () => null,
    async () => null,
    () => {
      throw new Error('Code tools must not request the network.');
    },
  );
  return {
    files,
    port,
    native,
    calls,
    execute,
    revision,
    tool: (name: string, input: unknown, signal?: AbortSignal) =>
      executeCodeTool('workspace', name, input, port, signal),
  };
}

test('registry and executor expose real multi-file definitions, references, symbols and diagnostics', async () => {
  const h = memoryWorkspace({
    'math.ts': 'export function double(value: number) { return value * 2; }\n',
    'main.ts': 'import { double } from "./math";\nconst result = double("wrong");\n',
    'other.ts': 'export const double = 999;\n',
  });
  const names = LOCAL_TOOL_DEFINITIONS.map(
    (entry) => (entry as { function: { name: string } }).function.name,
  );
  expect(names).toEqual(
    expect.arrayContaining([
      'format_file',
      'code_diagnostics',
      'code_definitions',
      'code_references',
      'code_symbols',
    ]),
  );
  expect(localToolKind('format_file')).toBe('edit');
  expect(localToolKind('code_definitions')).toBe('read');
  expect(localToolApproval('code_references')).toBeNull();
  const signal = new AbortController().signal;
  const definitions = await h.execute(
    'workspace',
    'code_definitions',
    { path: 'main.ts', line: 2, column: 16 },
    signal,
  );
  expect(definitions).toMatchObject({
    engine: 'typescript-language-service',
    files: 3,
    truncated: false,
    results: [{ path: 'math.ts', line: 1, column: 17 }],
  });
  const references = await h.execute(
    'workspace',
    'code_references',
    { path: 'math.ts', line: 1, column: 18 },
    signal,
  );
  expect(references).toMatchObject({
    results: expect.arrayContaining([
      expect.objectContaining({ path: 'math.ts', line: 1 }),
      expect.objectContaining({ path: 'main.ts', line: 1 }),
      expect.objectContaining({ path: 'main.ts', line: 2 }),
    ]),
  });
  expect(JSON.stringify(references)).not.toContain('other.ts');
  expect(await h.tool('code_symbols', { path: 'math.ts' })).toMatchObject({
    results: expect.arrayContaining([
      expect.objectContaining({ name: 'double', kind: 'function', line: 1, column: 17 }),
    ]),
  });
  expect(
    await h.execute('workspace', 'code_diagnostics', { path: 'main.ts' }, signal),
  ).toMatchObject({
    results: [expect.objectContaining({ path: 'main.ts', line: 2, code: 2345, severity: 'error' })],
  });
  // Same executor and signal, fresh native snapshot after the user's edit.
  await h.execute(
    'workspace',
    'edit_file',
    { path: 'main.ts', old_text: '"wrong"', new_text: '42' },
    signal,
  );
  expect(
    await h.execute('workspace', 'code_diagnostics', { path: 'main.ts' }, signal),
  ).toMatchObject({ results: [], truncated: false });
});

test('real compiler reports syntax errors and checks JS with ES2022 standard libraries', async () => {
  const h = memoryWorkspace({
    'broken.ts': 'export const value: = ;',
    'plain.js': 'const values = [1,2].map(n => n.toFixed(2));\nvalues.push(42);\n',
    'modules/a.mts': 'export const answer = 42;',
    'modules/b.mts': 'import {answer} from "./a.mjs";\nanswer;',
  });
  expect(await h.tool('code_diagnostics', { path: 'broken.ts' })).toMatchObject({
    results: expect.arrayContaining([expect.objectContaining({ code: 1110, severity: 'error' })]),
  });
  expect(await h.tool('code_diagnostics', { path: 'plain.js' })).toMatchObject({
    results: [expect.objectContaining({ code: 2345, line: 2 })],
  });
  expect(
    await h.tool('code_definitions', { path: 'modules/b.mts', line: 2, column: 2 }),
  ).toMatchObject({
    results: [expect.objectContaining({ path: 'modules/a.mts', line: 1 })],
  });
});

test('module resolution stays in the snapshot; escapes, URLs and packages cannot read host files', async () => {
  const h = memoryWorkspace({
    'src/local.ts': 'export const secret = 7;',
    'src/main.ts':
      'import {secret} from "./local";\nimport "../local.ts";\nimport {hidden} from "../../outside";\nimport {url} from "https://private.invalid/code";\nimport {readFile} from "fs";\nsecret;',
    'node_modules/private/index.ts': 'throw "must not read";',
    '.git/private.ts': 'throw "must not read";',
  });
  expect(
    await h.tool('code_definitions', { path: 'src/main.ts', line: 6, column: 2 }),
  ).toMatchObject({
    results: [expect.objectContaining({ path: 'src/local.ts' })],
  });
  const result = await h.tool('code_diagnostics', { path: 'src/main.ts' });
  expect(result).toMatchObject({
    results: expect.arrayContaining([
      expect.objectContaining({ code: 2307, line: 3 }),
      expect.objectContaining({ code: 2591, line: 5 }),
    ]),
  });
  expect(
    h.calls.every(
      (path) =>
        !path.includes('outside') &&
        !path.includes('node_modules') &&
        !path.includes('.git') &&
        !path.includes('https:'),
    ),
  ).toBe(true);
  for (const path of [
    '../outside.ts',
    '/absolute.ts',
    'src/../main.ts',
    'src\\main.ts',
    '.git/private.ts',
  ]) {
    await expect(h.tool('code_diagnostics', { path })).rejects.toThrow('workspace-relative');
  }
});

test('formatting uses real language parsers, is idempotent and only changes the requested file', async () => {
  const h = memoryWorkspace({
    'main.ts': 'const value:number={nested:1}.nested',
    'data.json': '{"value":1,"other":[2,3]}',
    'other.ts': 'const other=   1',
  });
  const write = jest.spyOn(h.native, 'writeWorkspaceFile');
  const signal = new AbortController().signal;
  await h.execute('workspace', 'read_file', { path: 'main.ts' }, signal);
  expect(await h.execute('workspace', 'format_file', { path: 'main.ts' }, signal)).toMatchObject({
    changed: true,
  });
  expect(h.files.get('main.ts')).toBe('const value: number = { nested: 1 }.nested;\n');
  expect(await h.execute('workspace', 'format_file', { path: 'main.ts' }, signal)).toMatchObject({
    changed: false,
  });
  expect(write).toHaveBeenCalledTimes(1);
  expect(await h.execute('workspace', 'format_file', { path: 'data.json' }, signal)).toMatchObject({
    changed: true,
  });
  expect(h.files.get('data.json')).toBe('{ "value": 1, "other": [2, 3] }\n');
  expect(h.files.get('other.ts')).toBe('const other=   1');
  // Formatting updates the registry's observed revision, enabling a subsequent revision-safe edit.
  const edit = jest.spyOn(h.native, 'editWorkspaceFile');
  const formattedRevision = h.revision(h.files.get('main.ts')!);
  await h.execute(
    'workspace',
    'edit_file',
    { path: 'main.ts', old_text: 'number', new_text: 'unknown' },
    signal,
  );
  expect(edit).toHaveBeenCalledWith('workspace', 'main.ts', 'number', 'unknown', formattedRevision);
});

test('formatting refuses stale observations and compare-and-swap conflicts without losing edits', async () => {
  const h = memoryWorkspace({ 'main.ts': 'const n=1' });
  const signal = new AbortController().signal;
  await h.execute('workspace', 'read_file', { path: 'main.ts' }, signal);
  h.files.set('main.ts', 'const userEdit=2');
  await expect(
    h.execute('workspace', 'format_file', { path: 'main.ts' }, signal),
  ).rejects.toMatchObject({ code: 'FILE_REVISION_CONFLICT' });
  expect(h.files.get('main.ts')).toBe('const userEdit=2');
  const read = h.port.readWorkspaceFile;
  jest.spyOn(h.port, 'readWorkspaceFile').mockImplementation(async (...args) => {
    const snapshot = await read(...args);
    h.files.set('main.ts', 'const newerEdit=3');
    return snapshot;
  });
  const write = jest.spyOn(h.port, 'writeWorkspaceFile');
  await expect(h.tool('format_file', { path: 'main.ts' })).rejects.toMatchObject({
    code: 'FILE_REVISION_CONFLICT',
  });
  expect(write).toHaveBeenCalledTimes(1);
  expect(h.files.get('main.ts')).toBe('const newerEdit=3');
});

test.each([
  ['script.js', 'const n={value:1}'],
  ['script.jsx', 'const view=<div count={1}/>'],
  ['script.mjs', 'export const n={value:1}'],
  ['script.cjs', 'exports.n={value:1}'],
  ['script.tsx', 'const view=<div count={1}/>'],
  ['script.mts', 'export const n:number=1'],
  ['script.cts', 'const n:number=1'],
])('real Prettier parser supports %s and remains idempotent', async (path, content) => {
  const h = memoryWorkspace({ [path]: content });
  expect(await h.tool('format_file', { path })).toMatchObject({ changed: true });
  expect(await h.tool('format_file', { path })).toMatchObject({ changed: false });
  expect(h.files.get(path)).toContain(';\n');
});

test('unsupported languages, missing files, bad positions and formatter syntax errors reject explicitly', async () => {
  const h = memoryWorkspace({ 'main.ts': 'const n=1', 'broken.ts': 'const = ;' });
  const write = jest.spyOn(h.port, 'writeWorkspaceFile');
  await expect(h.tool('code_diagnostics', { path: 'main.py' })).rejects.toThrow(
    'only JavaScript and TypeScript',
  );
  await expect(h.tool('format_file', { path: 'main.py' })).rejects.toThrow(
    'Formatting supports only',
  );
  await expect(h.tool('code_diagnostics', { path: 'missing.ts' })).rejects.toThrow(
    'missing, excluded',
  );
  await expect(h.tool('format_file', { path: 'missing.ts' })).rejects.toThrow('FILE_NOT_FOUND');
  await expect(h.tool('format_file', { path: 'broken.ts' })).rejects.toMatchObject({
    code: 'CODE_FORMAT_PARSE',
  });
  await expect(
    h.tool('code_definitions', { path: 'main.ts', line: 1, column: 100 }),
  ).rejects.toThrow('beyond');
  await expect(
    h.tool('code_definitions', { path: 'main.ts', line: 99, column: 1 }),
  ).rejects.toThrow('integer');
  await expect(h.tool('code_definitions', { path: 'main.ts' })).rejects.toThrow('required');
  expect(write).not.toHaveBeenCalled();
});

test('project, file, entry, depth and result budgets never return a misleading complete project', async () => {
  const oversized = memoryWorkspace({ 'big.ts': ' '.repeat(CODE_LIMITS.fileBytes + 1) });
  await expect(oversized.tool('code_diagnostics', { path: 'big.ts' })).rejects.toMatchObject({
    code: 'CODE_BUDGET',
  });
  await expect(oversized.tool('format_file', { path: 'big.ts' })).rejects.toMatchObject({
    code: 'CODE_BUDGET',
  });
  const expanded = memoryWorkspace({ 'unicode.ts': `const text="${'é'.repeat(32_760)}"` });
  const write = jest.spyOn(expanded.port, 'writeWorkspaceFile');
  await expect(expanded.tool('format_file', { path: 'unicode.ts' })).rejects.toMatchObject({
    code: 'CODE_BUDGET',
  });
  expect(write).not.toHaveBeenCalled();
  const manyFiles = memoryWorkspace(
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`${i}.ts`, 'export const n = 1;'])),
  );
  await expect(manyFiles.tool('code_diagnostics', { path: '1.ts' })).rejects.toMatchObject({
    code: 'CODE_BUDGET',
  });
  const manyEntries = memoryWorkspace(
    Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`${i}.txt`, ''])),
  );
  await expect(manyEntries.tool('code_diagnostics', { path: 'missing.ts' })).rejects.toMatchObject({
    code: 'CODE_BUDGET',
  });
  const deep = memoryWorkspace({ [`${'dir/'.repeat(14)}main.ts`]: 'export {};' });
  await expect(deep.tool('code_diagnostics', { path: 'main.ts' })).rejects.toMatchObject({
    code: 'CODE_BUDGET',
  });
  const total = memoryWorkspace(
    Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`${i}.ts`, ' '.repeat(60_000)])),
  );
  await expect(total.tool('code_diagnostics', { path: '1.ts' })).rejects.toMatchObject({
    code: 'CODE_BUDGET',
  });
  const noisy = memoryWorkspace({
    'main.ts': Array.from({ length: 80 }, (_, i) => `const value${i}: number = "wrong";`).join(
      '\n',
    ),
  });
  const result = await noisy.tool('code_diagnostics', { path: 'main.ts' });
  expect(result).toMatchObject({ truncated: true });
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(CODE_LIMITS.outputCharacters);
});

test('Stop cancels between native awaits and before formatting writes; retry gets a fresh snapshot', async () => {
  const h = memoryWorkspace({ 'main.ts': 'const n=1' });
  const controller = new AbortController();
  const read = h.port.readWorkspaceFile;
  jest.spyOn(h.port, 'readWorkspaceFile').mockImplementation(async (...args) => {
    const result = await read(...args);
    controller.abort();
    return result;
  });
  const write = jest.spyOn(h.port, 'writeWorkspaceFile');
  await expect(h.tool('format_file', { path: 'main.ts' }, controller.signal)).rejects.toMatchObject(
    { code: 'CODE_CANCELLED' },
  );
  expect(write).not.toHaveBeenCalled();
  await expect(
    h.tool('code_diagnostics', { path: 'main.ts' }, controller.signal),
  ).rejects.toMatchObject({ code: 'CODE_CANCELLED' });
  expect(
    await h.tool('code_diagnostics', { path: 'main.ts' }, new AbortController().signal),
  ).toMatchObject({ results: [] });
  const old = await h.port.getWorkspaceChangeToken('workspace');
  jest.spyOn(h.port, 'getWorkspaceChangeToken').mockResolvedValueOnce(old).mockResolvedValue('new');
  await expect(h.tool('code_diagnostics', { path: 'main.ts' })).rejects.toMatchObject({
    code: 'CODE_WORKSPACE_CHANGED',
  });
});

test('symlink entries are not followed and cooperative deadline overruns fail explicitly', async () => {
  const h = memoryWorkspace({ 'main.ts': 'const n=1;' });
  const list = h.port.listWorkspaceFiles;
  jest.spyOn(h.port, 'listWorkspaceFiles').mockImplementation(async (...args) => {
    const listing = await list(...args);
    return {
      ...listing,
      entries: [...listing.entries, { name: 'escape', kind: 'symlink', bytes: 1 }],
    };
  });
  expect(await h.tool('code_diagnostics', { path: 'main.ts' })).toMatchObject({
    files: 1,
    results: [],
  });
  expect(h.calls).not.toContain('escape');
  const now = jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10_000);
  try {
    await expect(h.tool('format_file', { path: 'main.ts' })).rejects.toMatchObject({
      code: 'CODE_BUDGET',
    });
  } finally {
    now.mockRestore();
  }
});
test('write and edit automatically format supported files and observe the post-format revision', async () => {
  const h = memoryWorkspace({ 'unrelated.ts': 'const leave=1' });
  const signal = new AbortController().signal;
  const edit = jest.spyOn(h.native, 'editWorkspaceFile');
  const write = jest.spyOn(h.native, 'writeWorkspaceFile');
  const first = await h.execute(
    'workspace',
    'write_file',
    { path: 'main.ts', content: 'const n:number=1' },
    signal,
  );
  expect(first).toMatchObject({
    path: 'main.ts',
    revision: h.revision('const n: number = 1;\n'),
    formatting: { status: 'formatted' },
  });
  expect(h.files.get('main.ts')).toBe('const n: number = 1;\n');
  expect(write).toHaveBeenCalledTimes(2);
  const result = await h.execute(
    'workspace',
    'edit_file',
    { path: 'main.ts', old_text: '= 1', new_text: '=2' },
    signal,
  );
  expect(result).toMatchObject({
    revision: h.revision('const n: number = 2;\n'),
    formatting: { status: 'formatted' },
  });
  expect(edit).toHaveBeenCalledWith(
    'workspace',
    'main.ts',
    '= 1',
    '=2',
    h.revision('const n: number = 1;\n'),
  );
  const before = write.mock.calls.length;
  expect(
    await h.execute(
      'workspace',
      'write_file',
      { path: 'main.ts', content: 'const n: number = 2;\n' },
      signal,
    ),
  ).toMatchObject({ formatting: { status: 'unchanged' } });
  expect(write.mock.calls.length).toBe(before + 1);
  expect(
    await h.execute('workspace', 'write_file', { path: 'data.json', content: '{"n":1}' }, signal),
  ).toMatchObject({ formatting: { status: 'formatted' } });
  expect(h.files.get('data.json')).toBe('{ "n": 1 }\n');
  expect(h.files.get('unrelated.ts')).toBe('const leave=1');
});

test('automatic formatting reports parse/budget errors after a successful edit and permits repair', async () => {
  const h = memoryWorkspace({});
  const signal = new AbortController().signal;
  const result = await h.execute(
    'workspace',
    'write_file',
    { path: 'broken.ts', content: 'const = ;' },
    signal,
  );
  expect(result).toMatchObject({
    path: 'broken.ts',
    revision: h.revision('const = ;'),
    formatting: {
      status: 'failed',
      code: 'CODE_FORMAT_PARSE',
      location: { path: 'broken.ts', line: 1, column: 7 },
    },
  });
  expect(h.files.get('broken.ts')).toBe('const = ;');
  expect(
    await h.execute(
      'workspace',
      'edit_file',
      { path: 'broken.ts', old_text: 'const = ;', new_text: 'const fixed:number=1' },
      signal,
    ),
  ).toMatchObject({ formatting: { status: 'formatted' } });
  expect(h.files.get('broken.ts')).toBe('const fixed: number = 1;\n');
  const content = ' '.repeat(65_537);
  expect(
    await h.execute('workspace', 'write_file', { path: 'big.ts', content }, signal),
  ).toMatchObject({
    revision: h.revision(content),
    formatting: { status: 'failed', code: 'CODE_BUDGET' },
  });
  expect(h.files.get('big.ts')).toBe(content);
});

test('automatic formatting explicitly skips unsupported languages and never masks a failed mutation', async () => {
  const h = memoryWorkspace({});
  const read = jest.spyOn(h.native, 'readWorkspaceFile');
  expect(
    await h.execute('workspace', 'write_file', { path: 'notes.txt', content: 'keep' }),
  ).toMatchObject({ formatting: { status: 'unsupported' } });
  expect(read).not.toHaveBeenCalled();
  const failure = new OnDeviceNativeError(
    'FILE_REVISION_CONFLICT',
    'Native write failed, not parsing.',
  );
  jest.spyOn(h.native, 'writeWorkspaceFile').mockRejectedValueOnce(failure);
  await expect(
    h.execute('workspace', 'write_file', { path: 'main.ts', content: 'const n=1' }),
  ).rejects.toBe(failure);
  expect(read).not.toHaveBeenCalled();
});

test('automatic formatting fences cancellation and external edits while retaining successful edit evidence', async () => {
  const h = memoryWorkspace({});
  const controller = new AbortController();
  const write = h.native.writeWorkspaceFile;
  jest.spyOn(h.native, 'writeWorkspaceFile').mockImplementationOnce(async (...args) => {
    const revision = await write(...args);
    controller.abort();
    return revision;
  });
  expect(
    await h.execute(
      'workspace',
      'write_file',
      { path: 'main.ts', content: 'const n=1' },
      controller.signal,
    ),
  ).toMatchObject({
    revision: h.revision('const n=1'),
    formatting: { status: 'cancelled', code: 'CODE_CANCELLED' },
  });
  expect(h.files.get('main.ts')).toBe('const n=1');
  const signal = new AbortController().signal;
  await h.execute('workspace', 'read_file', { path: 'main.ts' }, signal);
  jest.spyOn(h.native, 'writeWorkspaceFile').mockImplementationOnce(async (...args) => {
    const revision = await write(...args);
    h.files.set('main.ts', 'const external=3');
    return revision;
  });
  expect(
    await h.execute('workspace', 'write_file', { path: 'main.ts', content: 'const n=2' }, signal),
  ).toMatchObject({
    revision: h.revision('const n=2'),
    formatting: { status: 'failed', code: 'FILE_REVISION_CONFLICT' },
  });
  expect(h.files.get('main.ts')).toBe('const external=3');
  await expect(
    h.execute(
      'workspace',
      'edit_file',
      { path: 'main.ts', old_text: 'external', new_text: 'other' },
      signal,
    ),
  ).rejects.toMatchObject({ code: 'FILE_REVISION_CONFLICT' });
});

test.each([
  new Error('Parser runtime unavailable'),
  new SyntaxError('A non-parser syntax exception without source location'),
])('non-parser formatter exceptions retain identity and message: %s', async (failure) => {
  const h = memoryWorkspace({ 'main.ts': 'const n=1' });
  const format = jest.mocked(standalone.format).mockRejectedValueOnce(failure);
  try {
    await expect(formatCodeFile(h.port, 'workspace', 'main.ts')).rejects.toBe(failure);
    format.mockRejectedValueOnce(failure);
    expect(
      await h.execute('workspace', 'write_file', {
        path: 'main.ts',
        content: 'const n=2',
        expected_revision: h.revision('const n=1'),
      }),
    ).toMatchObject({
      formatting: { status: 'failed', code: 'CODE_FORMAT_FAILED', message: failure.message },
    });
  } finally {
    format
      .mockReset()
      .mockImplementation(jest.requireActual<typeof standalone>('prettier/standalone').format);
  }
});

test('formatter initialization failure is reported separately from an already completed native edit', async () => {
  const h = memoryWorkspace({ 'main.ts': 'const n=1' });
  const failure = new Error('Formatter initialization unavailable');
  let result: Promise<unknown> | undefined;
  jest.doMock('./format', () => {
    throw failure;
  });
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const module = require('./formatAfterFileEdit') as typeof AutomaticFormatting;
      result = module.formatAfterFileEdit(h.port, 'workspace', {
        path: 'main.ts',
        revision: h.revision('const n=1'),
      });
    });
    await expect(result).resolves.toMatchObject({
      path: 'main.ts',
      revision: h.revision('const n=1'),
      formatting: { status: 'failed', code: 'CODE_FORMAT_FAILED', message: failure.message },
    });
    expect(h.files.get('main.ts')).toBe('const n=1');
  } finally {
    jest.dontMock('./format');
  }
});

test('strict native-port bounds permit code budgets above model schema caps and reject invalid native calls', async () => {
  const initial = Object.fromEntries(
    Array.from({ length: 300 }, (_, index) => [`data${index}.json`, '{}']),
  );
  initial['large.ts'] = `export const value="${'é'.repeat(20_000)}";\n`;
  const h = memoryWorkspace(initial);
  expect(await h.tool('code_diagnostics', { path: 'large.ts' })).toMatchObject({
    results: [],
    files: 1,
    truncated: false,
  });
  expect((await h.port.listWorkspaceFiles('workspace', '', 512)).entries).toHaveLength(301);
  expect(
    (await h.port.readWorkspaceFile('workspace', 'large.ts', 0, 65_536)).nextOffset,
  ).toBeNull();
  await expect(h.port.listWorkspaceFiles('workspace', '', 1001)).rejects.toThrow('1...1000');
  await expect(h.port.readWorkspaceFile('workspace', 'large.ts', 0, 65_537)).rejects.toThrow(
    '1...65536',
  );
});
