const { isDeepStrictEqual } = require('node:util');
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const legacyDelegate = 'class AppDelegate: ExpoAppDelegate {';
const sceneDelegate = 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {';
const legacyStartup = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
`;

function updateAppDelegate({ language, contents }) {
  if (language !== 'swift') {
    throw new Error('iOS scene lifecycle requires the Expo SDK 57 Swift AppDelegate.');
  }
  if (contents.includes(sceneDelegate) && !contents.includes('factory.startReactNative(')) {
    return contents;
  }
  if (
    !contents.includes(legacyDelegate) ||
    !contents.includes(legacyStartup) ||
    contents.split('factory.startReactNative(').length !== 2
  ) {
    throw new Error('Unsupported AppDelegate startup; review the iOS scene lifecycle migration.');
  }
  // Expo's scene delegate owns the window and starts React Native exactly once.
  return contents.replace(legacyDelegate, sceneDelegate).replace(legacyStartup, '');
}

function withIosSceneLifecycle(config) {
  const [major, minor, patch] = require('expo/package.json').version.split('.').map(Number);
  if (major !== 57 || minor !== 0 || !Number.isInteger(patch) || patch < 23) {
    throw new Error(
      'iOS scene lifecycle requires Expo 57.0.23+; review this plugin on SDK upgrades.',
    );
  }
  config = withAppDelegate(config, (modConfig) => {
    modConfig.modResults.contents = updateAppDelegate(modConfig.modResults);
    return modConfig;
  });
  return withInfoPlist(config, (modConfig) => {
    const manifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
          },
        ],
      },
    };
    const existing = modConfig.modResults.UIApplicationSceneManifest;
    // Parsed plist dictionaries have null prototypes; compare their data, not their prototypes.
    if (
      existing !== undefined &&
      !isDeepStrictEqual(JSON.parse(JSON.stringify(existing)), manifest)
    ) {
      throw new Error('Refusing to replace a custom UIApplicationSceneManifest.');
    }
    modConfig.modResults.UIApplicationSceneManifest = manifest;
    return modConfig;
  });
}

module.exports = withIosSceneLifecycle;
module.exports.updateAppDelegate = updateAppDelegate;
