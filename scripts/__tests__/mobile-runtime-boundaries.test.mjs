import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const mobile = fileURLToPath(new URL('../../apps/mobile/', import.meta.url));
const require = createRequire(path.join(mobile, 'package.json'));
const { ESLint } = require('eslint');
const ts = require('typescript');
const eslint = new ESLint({ cwd: mobile });

async function restrictedImports(filePath, code) {
  const results = await eslint.lintText(code, { filePath: path.join(mobile, filePath) });
  assert.ok(
    !results.flatMap((result) => result.messages).some((message) => message.fatal),
    'the architectural check must parse the supplied source',
  );
  return results.flatMap((result) =>
    result.messages.filter((message) => message.ruleId === 'no-restricted-imports'),
  );
}

test('bridge implementations cannot import the local engine or feature', async () => {
  for (const source of [
    'import { initLlama } from "llama.rn"; void initLlama;',
    'import { GitHubAuthStrategy } from "../../features/on-device/auth/github"; void GitHubAuthStrategy;',
  ]) {
    assert.equal((await restrictedImports('src/bridge/client/client.ts', source)).length, 1);
  }
});

test('shared chat consumers cannot directly import inference or native auth', async () => {
  for (const source of [
    'import { initLlama } from "llama.rn"; void initLlama;',
    'import { GitHubAuthStrategy } from "../../on-device/auth/github"; void GitHubAuthStrategy;',
  ]) {
    assert.equal(
      (await restrictedImports('src/features/chat/screen/useBaseContext.ts', source)).length,
      1,
    );
  }
});

test('local implementations cannot depend on concrete desktop transport clients', async () => {
  assert.equal(
    (
      await restrictedImports(
        'src/features/on-device/auth/github.ts',
        'import { HostBridgeApiClient } from "@bridge/client/client"; void HostBridgeApiClient;',
      )
    ).length,
    1,
  );
});

// The unified shell runs "On this iPhone" through the unchanged bridge client. The local RPC server
// may speak the bridge wire protocol (types, mapping, AG-UI), but only the shell adapter
// (src/shell/runtime/LocalBridgeWsClient.ts) may plug it into the concrete transport.
test('the local RPC server speaks bridge wire types without depending on bridge transports', async () => {
  const server = 'src/features/on-device/transport/server.ts';
  assert.equal(
    (
      await restrictedImports(
        server,
        'import { HostBridgeWsClient } from "@bridge/ws/ws"; void HostBridgeWsClient;',
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await restrictedImports(
        server,
        'import type { RawThread } from "@bridge/mapping/chatMapping"; export type T = RawThread;',
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await restrictedImports(
        'src/shell/runtime/LocalBridgeWsClient.ts',
        'import { HostBridgeWsClient } from "@bridge/ws/ws"; import { LocalBridgeServer } from "../../features/on-device/transport/server"; void HostBridgeWsClient; void LocalBridgeServer;',
      )
    ).length,
    0,
  );
});

test('local implementations can reuse genuinely shared helpers directly', async () => {
  assert.equal(
    (
      await restrictedImports(
        'src/features/on-device/auth/github.ts',
        'import { feedback } from "@shared/feedback"; void feedback;',
      )
    ).length,
    0,
  );
});

test('native product fixture typechecks without generated Expo environment files', () => {
  const configPath = path.join(mobile, 'modules/on-device-agent/tests/tsconfig.json');
  const fixturePath = path.join(mobile, 'modules/on-device-agent/tests/product-entry.tsx');
  const generated = (filename) =>
    filename === path.join(mobile, 'expo-env.d.ts') ||
    filename.startsWith(path.join(mobile, '.expo') + path.sep);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  assert.deepEqual(parsed.errors, []);
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile;
  host.fileExists = (filename) => !generated(filename) && ts.sys.fileExists(filename);
  host.getSourceFile = (filename, ...args) =>
    generated(filename) ? undefined : getSourceFile(filename, ...args);
  const program = ts.createProgram({
    rootNames: parsed.fileNames.filter((filename) => !generated(filename)),
    options: parsed.options,
    host,
  });
  assert.ok(program.getSourceFiles().every((file) => !generated(file.fileName)));
  const fixture = program.getSourceFile(fixturePath);
  assert.ok(fixture, 'the production native fixture must be in the program');
  const diagnostics = [
    ...program.getSyntacticDiagnostics(fixture),
    ...program.getSemanticDiagnostics(fixture),
  ];
  assert.equal(
    ts.formatDiagnostics(diagnostics, {
      getCurrentDirectory: () => mobile,
      getCanonicalFileName: (filename) => filename,
      getNewLine: () => '\n',
    }),
    '',
  );
});
