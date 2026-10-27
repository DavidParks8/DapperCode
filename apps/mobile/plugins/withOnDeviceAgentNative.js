const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');

function withOnDeviceAgentNative(config) {
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
