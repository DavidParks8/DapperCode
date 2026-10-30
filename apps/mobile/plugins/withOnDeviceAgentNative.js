const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { withDangerousMod, withEntitlementsPlist } = require('expo/config-plugins');

// Lets on-device models use the larger per-app memory limit Apple grants to apps that need it.
// It is a self-service capability; it raises the iOS limit but does not bypass memory admission.
const INCREASED_MEMORY_LIMIT = 'com.apple.developer.kernel.increased-memory-limit';

function withOnDeviceAgentNative(config) {
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
