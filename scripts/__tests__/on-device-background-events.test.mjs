import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const { updateAppDelegate } = require('./plugins/withOnDeviceAgentNative');
const delegate = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

test('model download relaunch events reach the session before Expo subscriber aggregation', () => {
  const updated = updateAppDelegate({ language: 'swift', contents: delegate });
  assert.match(updated, /^internal import OnDeviceAgent$/m);
  assert.match(
    updated,
    /handleEventsForBackgroundURLSession identifier: String,[\s\S]*if ModelDownloadEvents\.handle\(identifier, completionHandler: completionHandler\) \{\s*return\s*\}\s*super\.application\(/,
  );
  // The override sits inside AppDelegate, before its first existing member function.
  assert.ok(updated.indexOf('ModelDownloadEvents.handle') < updated.indexOf('didFinishLaunching'));
  assert.equal(updateAppDelegate({ language: 'swift', contents: updated }), updated);
});

test('unexpected AppDelegates are refused instead of silently skipping the hook', () => {
  assert.throws(
    () => updateAppDelegate({ language: 'objc', contents: delegate }),
    /Swift AppDelegate/,
  );
  assert.throws(
    () =>
      updateAppDelegate({
        language: 'swift',
        contents: delegate.replace('var reactNativeFactory', 'var factory'),
      }),
    /Unsupported AppDelegate/,
  );
  assert.throws(
    () =>
      updateAppDelegate({
        language: 'swift',
        contents: `${delegate}// handleEventsForBackgroundURLSession is owned elsewhere\n`,
      }),
    /Unsupported AppDelegate/,
  );
});

test('the native entry point exists and the Expo subscriber path is not used', () => {
  const module = new URL('../../apps/mobile/modules/on-device-agent/', import.meta.url);
  const events = readFileSync(new URL('ios/ModelDownloadEvents.swift', module), 'utf8');
  assert.match(events, /public static func handle\(_ identifier: String, completionHandler:/);
  const config = JSON.parse(readFileSync(new URL('expo-module.config.json', module), 'utf8'));
  assert.equal(config.apple.appDelegateSubscribers, undefined);
});
