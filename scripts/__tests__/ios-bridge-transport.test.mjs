import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const mobileRoot = fileURLToPath(new URL('../../apps/mobile/', import.meta.url));
const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const app = require('./app.json').expo;

test('Expo prebuild permits native HTTP uploads to user-configured bridge hosts', () => {
  assert.deepEqual(app.ios.infoPlist.NSAppTransportSecurity, { NSAllowsArbitraryLoads: true });
  assert.ok(app.plugins.includes('./plugins/withIosBridgeTransportSecurity'));
  const config = JSON.parse(
    execFileSync('pnpm', ['exec', 'expo', 'config', '--type', 'introspect', '--json'], {
      cwd: mobileRoot,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  assert.deepEqual(config._internal.modResults.ios.infoPlist.NSAppTransportSecurity, {
    NSAllowsArbitraryLoads: true,
  });
});

test('the iOS mod removes template keys that override arbitrary loads', async () => {
  const plugin = require('./plugins/withIosBridgeTransportSecurity');
  const { compileModsAsync } = require('expo/config-plugins');
  const config = plugin({
    name: 'Transport test',
    slug: 'transport-test',
    ios: {
      infoPlist: {
        NSCameraUsageDescription: 'Preserve camera permission',
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: false,
          NSAllowsLocalNetworking: true,
          NSAllowsArbitraryLoadsInWebContent: true,
          NSAllowsArbitraryLoadsForMedia: false,
        },
      },
    },
  });
  const result = await compileModsAsync(config, {
    projectRoot: mobileRoot,
    platforms: ['ios'],
    introspect: true,
  });
  const plist = result._internal.modResults.ios.infoPlist;
  assert.deepEqual(plist.NSAppTransportSecurity, { NSAllowsArbitraryLoads: true });
  assert.equal(plist.NSCameraUsageDescription, 'Preserve camera permission');
});
