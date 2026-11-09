const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const compiler = path.join(root, 'src/features/on-device/code-intelligence/generated/compiler.js');
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  // Deliberately no process, Buffer, fs, network, DOM, or React Native/Node polyfills.
  module: { exports: {} },
  require(name) {
    throw new Error(`Unexpected runtime import: ${name}`);
  },
};
const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(readFileSync(compiler, 'utf8'), context, { timeout: 10_000 });
assert.equal(sandbox.module.exports.default.sys, undefined);
assert.equal(typeof sandbox.module.exports.default.createLanguageService, 'function');

const bundle = buildSync({
  stdin: {
    contents:
      'export {executeCodeTool} from "./tools"; export {formatAfterFileEdit} from "./formatAfterFileEdit";',
    resolveDir: path.join(root, 'src/features/on-device/code-intelligence'),
    sourcefile: 'local-code-tools-check.ts',
    loader: 'ts',
  },
  tsconfig: path.join(root, 'tsconfig.json'),
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  metafile: true,
  write: false,
});
assert.ok(Object.values(bundle.metafile.outputs).every((output) => output.imports.length === 0));
sandbox.module = { exports: {} };
vm.runInContext(bundle.outputFiles[0].text, context, { timeout: 10_000 });
const execute = sandbox.module.exports.executeCodeTool;
const files = new Map([
  ['math.ts', 'export function double(n: number) {return n * 2}'],
  ['main.ts', 'import {double} from "./math";\nconst n=double("wrong")'],
]);
let writes = 0;
const native = {
  async getWorkspaceChangeToken() {
    return String(writes);
  },
  async listWorkspaceFiles() {
    return {
      entries: [...files].map(([name, content]) => ({
        name,
        bytes: Buffer.byteLength(content),
        kind: 'file',
      })),
      truncated: false,
    };
  },
  async readWorkspaceFile(_workspace, file) {
    assert.ok(files.has(file), 'Must not read outside the in-memory workspace');
    return {
      content: files.get(file),
      revision: files.get(file),
      totalBytes: Buffer.byteLength(files.get(file)),
      nextOffset: null,
    };
  },
  async writeWorkspaceFile(_workspace, file, content, expected) {
    assert.equal(files.get(file), expected);
    files.set(file, content);
    writes++;
    return content;
  },
};
void (async () => {
  const definition = await execute(
    'isolated',
    'code_definitions',
    { path: 'main.ts', line: 2, column: 12 },
    native,
  );
  assert.equal(definition.results[0].path, 'math.ts');
  const broken = await execute('isolated', 'code_diagnostics', { path: 'main.ts' }, native);
  assert.equal(broken.results[0].code, 2345);
  files.set('main.ts', files.get('main.ts').replace('"wrong"', '42'));
  const recovered = await execute('isolated', 'code_diagnostics', { path: 'main.ts' }, native);
  assert.equal(recovered.results.length, 0);
  const formatted = await execute('isolated', 'format_file', { path: 'main.ts' }, native);
  assert.equal(formatted.changed, true);
  const repeated = await execute('isolated', 'format_file', { path: 'main.ts' }, native);
  assert.equal(repeated.changed, false);
  assert.equal(writes, 1);
  files.set('view.jsx', 'const view=<div count={1}/>');
  const jsx = await execute('isolated', 'format_file', { path: 'view.jsx' }, native);
  assert.equal(jsx.changed, true);
  files.set('data.json', '{"answer":42}');
  const json = await execute('isolated', 'format_file', { path: 'data.json' }, native);
  assert.equal(json.changed, true);
  assert.equal(writes, 3);
  files.set('automatic.ts', 'const n:number=1');
  const automatic = await sandbox.module.exports.formatAfterFileEdit(native, 'isolated', {
    path: 'automatic.ts',
    revision: files.get('automatic.ts'),
  });
  assert.equal(automatic.formatting.status, 'formatted');
  assert.equal(files.get('automatic.ts'), 'const n: number = 1;\n');
  files.set('broken.ts', 'const = ;');
  const failed = await sandbox.module.exports.formatAfterFileEdit(native, 'isolated', {
    path: 'broken.ts',
    revision: files.get('broken.ts'),
  });
  assert.equal(failed.formatting.code, 'CODE_FORMAT_PARSE');
  assert.equal(files.get('broken.ts'), 'const = ;');
  assert.equal(writes, 4);
  console.log(
    'PASS: real compiler + Prettier in browser sandbox; no Node runtime, dynamic code generation, network, or filesystem.',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
