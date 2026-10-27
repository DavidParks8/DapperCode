import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const mobile = fileURLToPath(new URL('../../apps/mobile/', import.meta.url));
const require = createRequire(path.join(mobile, 'package.json'));
const { ESLint } = require('eslint');
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
