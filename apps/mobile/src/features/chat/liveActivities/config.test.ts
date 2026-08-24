import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createContext, runInContext, runInNewContext } from 'node:vm';

import appConfig from '../../../../app.json';

interface BabelCore {
  transformSync(source: string, options: object): { code?: string | null } | null;
}

const widgetSourcePath = path.resolve(__dirname, '../../../../widgets/DapperCodeAgentActivity.tsx');

function compileProductionWidgetLayout(): string {
  const requireFromPreset = createRequire(require.resolve('babel-preset-expo/package.json'));
  const babel: BabelCore = requireFromPreset('@babel/core');
  const preset: unknown = requireFromPreset('babel-preset-expo');
  const source = readFileSync(widgetSourcePath, 'utf8');
  const result = babel.transformSync(source, {
    filename: widgetSourcePath,
    configFile: false,
    babelrc: false,
    caller: {
      name: 'metro',
      bundler: 'metro',
      platform: 'ios',
      engine: 'hermes',
      isDev: false,
      isNodeModule: false,
      supportsReactCompiler: true,
      supportsStaticESM: false,
    },
    presets: [[preset, {}]],
  });
  const transformed = result?.code;
  if (!transformed) {
    throw new Error('Babel did not produce a widget module');
  }

  const match = transformed.match(/`(function\(props\)\{(?:\\.|[^`])*\})`/u);
  const serializedLayout = match?.[1];
  if (!serializedLayout) {
    throw new Error('Babel did not serialize the Live Activity layout');
  }

  const layout: unknown = runInNewContext(`\`${serializedLayout}\``);
  if (typeof layout !== 'string') {
    throw new Error('Serialized Live Activity layout is not a string');
  }
  return layout;
}

function renderProductionWidgetLayout(layout: string): unknown {
  const packageRoot = path.dirname(require.resolve('expo-widgets/package.json'));
  const runtime = readFileSync(path.join(packageRoot, 'bundle/build/ExpoWidgets.bundle'), 'utf8');
  const context = createContext({});
  runInContext(runtime, context);
  context['__expoWidgetLayout'] = runInContext(`(${layout})`, context);
  context['props'] = { phase: 'working', startedAtEpochMs: 1, updatedAtEpochMs: 1 };
  context['environment'] = { colorScheme: 'dark' };
  return runInContext('__expoWidgetRender(props, environment)', context);
}

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

  it('renders the production-compiled layout in the widget JavaScriptCore runtime', () => {
    const layout = compileProductionWidgetLayout();

    expect(layout).not.toContain('_c(');
    const rendered = renderProductionWidgetLayout(layout);
    expect(rendered).toMatchObject({
      banner: { type: 'ZStackView' },
      compactLeading: { type: 'ImageView' },
      compactTrailing: { type: 'TextView' },
      minimal: { type: 'ImageView' },
      expandedLeading: { type: 'HStackView' },
      expandedTrailing: { type: 'HStackView' },
      expandedBottom: { type: 'VStackView' },
    });

    const serialized = JSON.stringify(rendered);
    expect(serialized).toContain('DapperCode');
    expect(serialized).toContain('Working');
    expect(serialized).toContain('Agent is working');
  });
});
