import appConfig from '../../../../app.json';

describe('iOS Live Activity build configuration', () => {
  it('generates ActivityKit support and the shared app-group entitlement', () => {
    expect(appConfig.expo.ios.infoPlist.NSSupportsLiveActivities).toBe(true);
    expect(appConfig.expo.ios.entitlements['com.apple.security.application-groups']).toEqual([
      'group.com.dappermagna.tethercode',
    ]);
    expect(appConfig.expo.plugins).toContainEqual([
      'expo-widgets',
      {
        bundleIdentifier: 'com.dappermagna.tethercode.widgets',
        groupIdentifier: 'group.com.dappermagna.tethercode',
        enablePushNotifications: false,
        frequentUpdates: false,
      },
    ]);
  });
});
