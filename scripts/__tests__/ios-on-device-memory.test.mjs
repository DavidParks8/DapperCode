import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const mobileRoot = fileURLToPath(new URL('../../apps/mobile/', import.meta.url));
const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));

test('prebuild grants on-device inference the increased iOS memory limit', async () => {
  const plugin = require('./plugins/withOnDeviceAgentNative');
  const { compileModsAsync } = require('expo/config-plugins');
  const config = plugin({ name: 'Memory test', slug: 'memory-test', ios: {} });
  // Introspection skips the dangerous native Git build while still evaluating entitlement mods.
  const result = await compileModsAsync(config, {
    projectRoot: mobileRoot,
    platforms: ['ios'],
    introspect: true,
  });
  const entitlements = result._internal.modResults.ios.entitlements;
  assert.equal(entitlements['com.apple.developer.kernel.increased-memory-limit'], true);
  assert.equal(entitlements['com.apple.developer.kernel.extended-virtual-addressing'], undefined);
});
