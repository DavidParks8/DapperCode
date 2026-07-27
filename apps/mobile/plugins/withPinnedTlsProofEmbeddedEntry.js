const { withAppDelegate } = require('@expo/config-plugins');

const defaultDebugBundle = `#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif`;

const proofDebugBundle = `#if DAPPERCODE_PINNED_TLS_PROOF
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#elseif DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif`;

function withPinnedTlsProofEmbeddedEntry(config) {
  return withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== 'swift') {
      throw new Error('Pinned TLS proof entry requires a Swift AppDelegate');
    }
    if (modConfig.modResults.contents.includes(proofDebugBundle)) {
      return modConfig;
    }
    if (!modConfig.modResults.contents.includes(defaultDebugBundle)) {
      throw new Error('Could not locate the Expo Debug bundle selection in AppDelegate.swift');
    }
    modConfig.modResults.contents = modConfig.modResults.contents.replace(
      defaultDebugBundle,
      proofDebugBundle,
    );
    return modConfig;
  });
}

module.exports = withPinnedTlsProofEmbeddedEntry;
