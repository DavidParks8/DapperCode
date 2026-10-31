jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: jest.fn() }));
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: Object.assign(({ name }: { name: string }) => name, { glyphMap: {} }),
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }));

import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { HostBridgeApiClient } from '@bridge/client/client';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { LocalBridgeWsClient } from '@shell/runtime/LocalBridgeWsClient';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createBridgeTestStore, withAppStore } from '@shell/state/testing';
import { OnDeviceRuntime } from '../../on-device/runtime/runtime';
import { createFakeOnDeviceNative, FakeLlama, FakeNetwork } from '../../on-device/runtime/testing';
import { createRuntimeAgentPort } from '../../on-device/transport/runtimePort';
import { LocalBridgeServer } from '../../on-device/transport/server';
import { LOCAL_WORKSPACE_ROOT } from '../../on-device/transport/wire';
import { WorkspaceFilesScreen } from './Screen';

type Node = ReactTestInstance & {
  props: Record<string, unknown>;
  children: unknown[];
  findAll(predicate: (node: Node) => boolean): Node[];
};

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function text(root: Node): string {
  return root
    .findAll((node) => node.children.every((child) => typeof child === 'string'))
    .map((node) => node.children.join(''))
    .join('\n');
}

const mounted: { tree: ReactTestRenderer; runtime: OnDeviceRuntime }[] = [];

afterEach(async () => {
  await act(async () => {
    for (const { tree, runtime } of mounted.splice(0)) {
      tree.unmount();
      await runtime.dispose();
    }
    await flush();
  });
});

describe('WorkspaceFilesScreen over the real on-device runtime', () => {
  it('lists the workspace root with the empty root path the native module requires', async () => {
    const fake = createFakeOnDeviceNative(new FakeLlama(), {
      files: { 'ws-one:README.md': '# Demo\n', 'ws-one:src/app.ts': 'export const app = 1;\n' },
    });
    const runtime = new OnDeviceRuntime(fake.native, { network: new FakeNetwork() });
    await runtime.initialize();
    const ws = new LocalBridgeWsClient(new LocalBridgeServer(createRuntimeAgentPort(runtime)));
    ws.connect();
    const api = new HostBridgeApiClient({ ws, profileId: LOCAL_PROFILE_ID });
    const store = createBridgeTestStore({ api, ws, bridgeProfileId: 'bridge-1' });
    store.set(localProfileAvailableAtom, true);
    const snapshot = store.get(appStateSnapshotAtom);
    store.set(appStateSnapshotAtom, {
      ...snapshot,
      data: {
        ...snapshot.data,
        bridgeProfiles: { ...snapshot.data.bridgeProfiles, activeProfileId: LOCAL_PROFILE_ID },
      },
    });
    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        withAppStore(
          store,
          <SafeAreaProvider
            initialMetrics={{
              frame: { x: 0, y: 0, width: 390, height: 844 },
              insets: { top: 47, left: 0, right: 0, bottom: 34 },
            }}
          >
            <AppThemeProvider theme={createAppTheme('dark')}>
              <WorkspaceFilesScreen cwd={`${LOCAL_WORKSPACE_ROOT}/Demo`} />
            </AppThemeProvider>
          </SafeAreaProvider>,
        ),
      );
      await flush();
    });
    mounted.push({ tree: tree!, runtime });
    const root = tree!.root as Node;

    expect(fake.calls).toContain('listWorkspaceFiles:["ws-one",""]');
    expect(fake.calls.some((call) => call.startsWith('listWorkspaceFiles:["ws-one","."'))).toBe(
      false,
    );
    expect(text(root)).toContain('README.md');
    expect(text(root)).toContain('src');
    expect(text(root)).not.toMatch(/UnexpectedException|ExpoModulesCore|Paths must stay/u);

    const folder = root.findAll(
      (node) =>
        node.props['accessibilityLabel'] === 'Open folder src' &&
        typeof node.props['onPress'] === 'function',
    )[0];
    await act(async () => {
      (folder?.props['onPress'] as () => void)();
      await flush();
    });
    expect(fake.calls).toContain('listWorkspaceFiles:["ws-one","src"]');
    expect(text(root)).toContain('app.ts');
  });
});
