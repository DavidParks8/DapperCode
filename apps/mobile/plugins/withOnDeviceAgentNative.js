const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { withAppDelegate, withDangerousMod, withEntitlementsPlist } = require('expo/config-plugins');

// Lets on-device models use the larger per-app memory limit Apple grants to apps that need it.
// It is a self-service capability; it raises the iOS limit but does not bypass memory admission.
const INCREASED_MEMORY_LIMIT = 'com.apple.developer.kernel.increased-memory-limit';

const DELEGATE_ANCHOR = '  var reactNativeFactory: RCTReactNativeFactory?\n';
const IMPORT_ANCHOR = 'import React\n';
const BACKGROUND_EVENTS = `
  // On-device model downloads take iOS's background-session completion handler directly: Expo's
  // aggregated subscriber callback never completes it for third-party sessions (SDK 57).
  public override func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    if ModelDownloadEvents.handle(identifier, completionHandler: completionHandler) {
      return
    }
    super.application(
      application,
      handleEventsForBackgroundURLSession: identifier,
      completionHandler: completionHandler)
  }
`;

/** Routes the model download session's relaunch events past Expo's subscriber aggregation. */
function updateAppDelegate({ language, contents }) {
  if (language !== 'swift') {
    throw new Error('On-device model downloads require the Expo SDK 57 Swift AppDelegate.');
  }
  if (contents.includes('ModelDownloadEvents.handle(')) {
    return contents;
  }
  if (
    contents.includes('handleEventsForBackgroundURLSession') ||
    contents.split(DELEGATE_ANCHOR).length !== 2 ||
    contents.split(IMPORT_ANCHOR).length !== 2
  ) {
    throw new Error('Unsupported AppDelegate; review the on-device background-session hook.');
  }
  return contents
    .replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}internal import OnDeviceAgent\n`)
    .replace(DELEGATE_ANCHOR, `${DELEGATE_ANCHOR}${BACKGROUND_EVENTS}`);
}

function withOnDeviceAgentNative(config) {
  config = withAppDelegate(config, (modConfig) => {
    modConfig.modResults.contents = updateAppDelegate(modConfig.modResults);
    return modConfig;
  });
  config = withEntitlementsPlist(config, (modConfig) => {
    modConfig.modResults[INCREASED_MEMORY_LIMIT] = true;
    return modConfig;
  });
  return withDangerousMod(config, [
    'ios',
    async (modConfig) => {
      execFileSync(
        process.execPath,
        [
          path.join(
            modConfig.modRequest.projectRoot,
            'modules/on-device-agent/scripts/build-git.mjs',
          ),
        ],
        { stdio: 'inherit' },
      );
      return modConfig;
    },
  ]);
}

module.exports = withOnDeviceAgentNative;
module.exports.updateAppDelegate = updateAppDelegate;
