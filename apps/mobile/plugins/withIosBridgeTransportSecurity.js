const { withInfoPlist } = require('expo/config-plugins');

function withIosBridgeTransportSecurity(config) {
  return withInfoPlist(config, (modConfig) => {
    const ats = (modConfig.modResults.NSAppTransportSecurity ??= {});
    // Bridge hosts are user-configured LAN/VPN addresses, not a fixed domain allowlist.
    ats.NSAllowsArbitraryLoads = true;
    // Their presence overrides NSAllowsArbitraryLoads on iOS, even when set to false.
    delete ats.NSAllowsLocalNetworking;
    delete ats.NSAllowsArbitraryLoadsInWebContent;
    delete ats.NSAllowsArbitraryLoadsForMedia;
    return modConfig;
  });
}

module.exports = withIosBridgeTransportSecurity;
