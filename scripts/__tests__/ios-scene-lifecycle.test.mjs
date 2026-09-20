import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const mobileRoot = fileURLToPath(new URL('../../apps/mobile/', import.meta.url));
const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const plugin = require('./plugins/withIosSceneLifecycle');
const { updateAppDelegate } = plugin;
const legacy = `import Expo
import React
@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?
  var reactNativeFactory: RCTReactNativeFactory?
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let factory = ExpoReactNativeFactory(delegate: ReactNativeDelegate())
    reactNativeFactory = factory
#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
  // Existing URL and universal-link overrides stay owned by the app.
  func existingLinkHandler() {}
}
`;

test('prebuild opts the production app into the native Expo scene lifecycle', () => {
  const app = require('./app.json').expo;
  assert.ok(app.plugins.includes('./plugins/withIosSceneLifecycle'));
  const config = JSON.parse(
    execFileSync('pnpm', ['exec', 'expo', 'config', '--type', 'introspect', '--json'], {
      cwd: mobileRoot,
      env: { ...process.env, EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1' },
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  assert.deepEqual(config._internal.modResults.ios.infoPlist.UIApplicationSceneManifest, {
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [
        {
          UISceneConfigurationName: 'Default Configuration',
          UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
        },
      ],
    },
  });
  assert.deepEqual(config._internal.modResults.ios.infoPlist.NSAppTransportSecurity, {
    NSAllowsArbitraryLoads: true,
  });
});

test('scene startup replaces legacy launch without duplicating React Native or dropping callbacks', () => {
  const migrated = updateAppDelegate({ language: 'swift', contents: legacy });
  assert.match(migrated, /class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider/);
  assert.match(migrated, /reactNativeFactory = factory/);
  assert.match(migrated, /var window: UIWindow\?/);
  assert.match(
    migrated,
    /return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)/,
  );
  assert.match(migrated, /func existingLinkHandler\(\)/);
  assert.doesNotMatch(migrated, /factory\.startReactNative|UIWindow\(frame:/);
  assert.equal(updateAppDelegate({ language: 'swift', contents: migrated }), migrated);
});

test('unexpected native startup fails instead of producing a launch-crashing app', () => {
  assert.throws(
    () => updateAppDelegate({ language: 'objc', contents: legacy }),
    /Swift AppDelegate/,
  );
  assert.throws(
    () =>
      updateAppDelegate({
        language: 'swift',
        contents: legacy.replace('in: window', 'in: customWindow'),
      }),
    /Unsupported AppDelegate startup/,
  );
  assert.throws(
    () =>
      updateAppDelegate({
        language: 'swift',
        contents: `${legacy}\nfactory.startReactNative(withModuleName: "custom", in: otherWindow)`,
      }),
    /Unsupported AppDelegate startup/,
  );
});

test('prebuild refuses to silently replace a custom scene configuration', async () => {
  const { compileModsAsync } = require('expo/config-plugins');
  const config = plugin({
    name: 'Scene test',
    slug: 'scene-test',
    ios: {
      infoPlist: { UIApplicationSceneManifest: { UIApplicationSupportsMultipleScenes: true } },
    },
  });
  await assert.rejects(
    compileModsAsync(config, { projectRoot: mobileRoot, platforms: ['ios'], introspect: true }),
    /custom UIApplicationSceneManifest/,
  );
});
