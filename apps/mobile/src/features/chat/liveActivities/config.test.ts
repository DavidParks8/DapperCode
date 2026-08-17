import { readFileSync } from 'node:fs';
import path from 'node:path';

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

  it('evaluates layouts after ActivityKit installs the render environment', () => {
    const packageRoot = path.dirname(require.resolve('expo-widgets/package.json'));
    const rendererSource = readFileSync(
      path.join(packageRoot, 'ios/Widgets/WidgetLiveActivity.swift'),
      'utf8',
    );
    const widgetStart = rendererSource.indexOf('public struct WidgetLiveActivity: Widget');
    const sectionStart = rendererSource.indexOf('private struct LiveActivitySectionView: View');
    const bannerStart = rendererSource.indexOf('private struct LiveActivityBannerView: View');
    const extensionStart = rendererSource.indexOf('extension WidgetConfiguration');

    expect(widgetStart).toBeGreaterThanOrEqual(0);
    expect(sectionStart).toBeGreaterThan(widgetStart);
    expect(bannerStart).toBeGreaterThan(sectionStart);
    expect(extensionStart).toBeGreaterThan(bannerStart);

    const configurationSource = rendererSource.slice(widgetStart, sectionStart);
    const sectionSource = rendererSource.slice(sectionStart, bannerStart);
    const bannerSource = rendererSource.slice(bannerStart, extensionStart);

    expect(configurationSource).not.toContain('@Environment(\\.self)');
    expect(configurationSource).not.toContain('getLiveActivityNodes(');
    for (const renderedViewSource of [sectionSource, bannerSource]) {
      expect(renderedViewSource).toContain('@Environment(\\.self)');
      expect(renderedViewSource).toContain(
        'environment: getLiveActivityEnvironment(environment: env)',
      );
    }
  });
});
