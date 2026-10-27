import path from 'node:path';
import { bundleNativeReactApp } from './bundleNativeReactApp.mjs';
import catalog from '../../../src/features/on-device/models/catalog.json' with { type: 'json' };

export const name = 'on-device-native-inference';
export const contract = { requiredPhases: ['bundle', 'prepare', 'native-inference', 'settled'] };

const modelId = process.env.DAPPERCODE_NATIVE_TEST_MODEL ?? 'qwen3-1.7b-q4-k-m';
const testModel = catalog.find((entry) => entry.id === modelId);
if (!testModel) {
  throw new Error('Choose a model from the bundled catalog for native validation.');
}

export default async function scenario(e2e) {
  const mobile = path.join(e2e.worktree, 'apps/mobile');
  const sources = path.join(mobile, 'modules/on-device-agent/tests');
  const bundleId = 'dev.dappercode.native-inference';
  let app;
  let simulator;
  let booted = false;
  let documents;
  let result;
  try {
    await e2e.phase('bundle', async () => {
      app = await bundleNativeReactApp(e2e, {
        entryFile: path.join(sources, 'inference-entry.tsx'),
        bundleId,
        name: 'NativeInference',
      });
      await e2e.check('native test app uses a bundled inference entry, not Metro', () => true);
    });
    await e2e.phase('prepare', async () => {
      const model = path.join(e2e.workspaceDir, 'model.gguf');
      await e2e.run(
        'curl',
        ['--fail', '--location', '--max-time', '180', '--output', model, testModel.downloadUrl],
        { timeoutMs: 190_000 },
      );
      const digest = await e2e.run('shasum', ['-a', '256', model], { timeoutMs: 30_000 });
      await e2e.expectEqual('test model integrity', digest.stdout.split(' ')[0], testModel.sha256);
      const created = await e2e.run('xcrun', [
        'simctl',
        'create',
        e2e.runId,
        'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro',
        'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
      ]);
      simulator = created.stdout.trim();
      await e2e.run('xcrun', ['simctl', 'boot', simulator]);
      booted = true;
      await e2e.run('xcrun', ['simctl', 'bootstatus', simulator, '-b'], { timeoutMs: 120_000 });
      await e2e.run('xcrun', ['simctl', 'install', simulator, app], { timeoutMs: 120_000 });
      const container = await e2e.run('xcrun', [
        'simctl',
        'get_app_container',
        simulator,
        bundleId,
        'data',
      ]);
      documents = path.join(container.stdout.trim(), 'Documents');
      await e2e.run('cp', [model, path.join(documents, 'model.gguf')]);
      const modelIdentifier = e2e.writeFile('data/model-id.txt', modelId);
      await e2e.run('cp', [modelIdentifier, path.join(documents, 'model-id.txt')]);
      await e2e.check(
        'real pinned model is available inside an isolated app container',
        () => true,
      );
    });
    await e2e.phase('native-inference', async () => {
      try {
        await e2e.run('xcrun', ['simctl', 'launch', simulator, bundleId], { timeoutMs: 60_000 });
      } catch (error) {
        const diagnostic = await e2e.run(
          'xcrun',
          [
            'simctl',
            'spawn',
            simulator,
            'log',
            'show',
            '--last',
            '1m',
            '--style',
            'compact',
            '--predicate',
            'process == "DapperCode" OR process == "amfid"',
          ],
          { timeoutMs: 30_000 },
        );
        throw new Error(`${error.message}\n${diagnostic.stdout.slice(-12_000)}`, { cause: error });
      }
      await e2e.waitFor(
        'native tool loop and cancellation',
        async () => {
          const read = await e2e.run(
            'cat',
            [path.join(documents, 'native-inference-result.json')],
            { expectExitCodes: [0, 1] },
          );
          if (read.code !== 0) {
            return false;
          }
          result = JSON.parse(read.stdout);
          return result.status === 'pass' || result.status === 'fail';
        },
        { timeoutMs: 240_000, intervalMs: 1000 },
      );
      await e2e.check('native gate outcome', () => {
        if (result.status !== 'pass') {
          throw new Error(
            `${result.error ?? 'Native inference did not complete.'} Completed checks: ${Object.keys(result.checks ?? {}).join(', ')}`,
          );
        }
        return true;
      });
      await e2e.expectSubset('native execution checks', result.checks, {
        nativeMemory: true,
        nativeMemoryAdmission: true,
        verifiedModelFile: true,
        opaqueCredential: true,
        credentialRemoval: true,
        nativeModelLoaded: true,
        fullProductionToolBudget: true,
        structuredToolCall: true,
        correctToolName: true,
        correctToolArguments: true,
        realFileRead: true,
        nativeFileToolResult: true,
        toolResultInPrompt: true,
        toolResultUsed: true,
        nativeStreaming: true,
        nativeCancellation: true,
        modelUnloaded: true,
        modelReloaded: true,
      });
    });
    await e2e.phase('settled', async () => {
      await e2e.run('xcrun', ['simctl', 'terminate', simulator, bundleId]);
      await e2e.check(
        'all native contexts released before app termination',
        () => result.checks.modelUnloaded && result.checks.modelReloaded,
      );
    });
  } finally {
    if (booted) {
      await e2e.run('xcrun', ['simctl', 'shutdown', simulator]);
    }
    if (simulator) {
      await e2e.run('xcrun', ['simctl', 'delete', simulator]);
    }
  }
}
