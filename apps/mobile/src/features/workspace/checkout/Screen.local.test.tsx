jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: jest.fn() }));
jest.mock('react-native-reanimated', () => {
  const rnActual = jest.requireActual('react-native');
  const base = jest.requireActual('@shared/testing/reanimatedMock');
  const passthrough: Record<string, unknown> = {
    duration: () => passthrough,
    easing: () => passthrough,
    reduceMotion: () => passthrough,
  };
  return {
    __esModule: true,
    default: { View: rnActual.View },
    Easing: base.Easing,
    ReduceMotion: base.ReduceMotion,
    FadeIn: passthrough,
    FadeOut: passthrough,
  };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));
jest.mock('@shared/feedback', () => ({
  feedback: {
    success: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    selection: jest.fn().mockResolvedValue(undefined),
  },
}));

import { TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { HostBridgeApiClient } from '@bridge/client/client';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { LocalBridgeWsClient } from '@shell/runtime/LocalBridgeWsClient';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createBridgeTestStore, withAppStore } from '@shell/state/testing';
import { LocalBridgeServer } from '../../on-device/transport/server';
import { FakeAgentPort, fakeNativeError } from '../../on-device/transport/testing';
import { LOCAL_WORKSPACE_ROOT } from '../../on-device/transport/wire';
import type { LocalWorkspace } from '../../on-device/workspaces/types';
import { gitCheckoutParentPathAtom } from '../state/gitCheckout';
import { GitCheckoutScreen } from './Screen';

type Node = ReactTestInstance & {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
  findAll(predicate: (node: Node) => boolean): Node[];
};

async function flush(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
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

function labeled(root: Node, label: string): Node {
  const node = root.findAll(
    (candidate) =>
      candidate.props['accessibilityLabel'] === label &&
      (candidate.type === TextInput || typeof candidate.props['onPress'] === 'function'),
  )[0];
  if (!node) {
    throw new Error(`Missing ${label}`);
  }
  return node;
}

async function invoke(node: Node, handler = 'onPress', ...args: unknown[]): Promise<void> {
  await act(async () => {
    (node.props[handler] as (...values: unknown[]) => unknown)(...args);
    await flush();
  });
}

const mounted: ReactTestRenderer[] = [];

afterEach(async () => {
  await act(async () => {
    for (const tree of mounted.splice(0)) {
      tree.unmount();
    }
    await flush();
  });
});

async function renderLocalCheckout(port: FakeAgentPort) {
  const ws = new LocalBridgeWsClient(new LocalBridgeServer(port));
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
  store.set(gitCheckoutParentPathAtom, LOCAL_WORKSPACE_ROOT);
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
            <GitCheckoutScreen />
          </AppThemeProvider>
        </SafeAreaProvider>,
      ),
    );
    await flush();
  });
  mounted.push(tree!);
  return { root: tree!.root as Node, store };
}

describe('GitCheckoutScreen on this iPhone', () => {
  it('validates HTTPS before cloning and derives the workspace name from the URL', async () => {
    const port = new FakeAgentPort();
    const { root, store } = await renderLocalCheckout(port);

    expect(text(root)).toContain('Clone repository');
    expect(text(root)).not.toContain('Clone into');

    await invoke(labeled(root, 'Repository URL'), 'onChangeText', 'git@github.com:acme/tool.git');
    expect(text(root)).toContain('Use the HTTPS URL.');
    expect(labeled(root, 'Clone repository').props['disabled']).toBe(true);

    await invoke(labeled(root, 'Repository URL'), 'onChangeText', 'not a url');
    expect(text(root)).not.toContain('Invalid URL');

    await invoke(
      labeled(root, 'Repository URL'),
      'onChangeText',
      'https://github.com/acme/tool.git',
    );
    expect(labeled(root, 'Workspace name').props['value']).toBe('tool');
    expect(text(root)).toContain('Creates the workspace “tool”');

    await invoke(labeled(root, 'Clone repository'));
    expect(port.calls).toContain('workspace.clone:tool:https://github.com/acme/tool.git');
    expect(store.get(defaultStartCwdAtom)).toBe(`${LOCAL_WORKSPACE_ROOT}/tool`);
  });

  it('shows clone progress and lets the user stop the transfer', async () => {
    const port = new FakeAgentPort();
    let finish: (workspace: LocalWorkspace) => void = () => undefined;
    port.workspaceAdmin.clone = () =>
      new Promise<LocalWorkspace>((resolve) => {
        finish = resolve;
      });
    port.workspaceAdmin.cloneProgress = () => ({
      active: true,
      cancelled: false,
      completed: 30,
      total: 120,
    });
    const { root } = await renderLocalCheckout(port);
    await invoke(
      labeled(root, 'Repository URL'),
      'onChangeText',
      'https://github.com/acme/tool.git',
    );
    await invoke(labeled(root, 'Clone repository'));

    expect(text(root)).toContain('Receiving files: 30 of 120');
    await invoke(labeled(root, 'Stop cloning'));
    expect(port.calls).toContain('workspace.cancelTransfer');

    await act(async () => {
      finish({ id: 'ws-tool', name: 'tool', isRepository: true });
      await flush();
    });
  });

  it('explains an unauthorized clone in plain language', async () => {
    const port = new FakeAgentPort();
    port.workspaceAdmin.clone = () =>
      Promise.reject(fakeNativeError('GIT_AUTH_FAILED', 'libgit2 auth 401'));
    const { root } = await renderLocalCheckout(port);
    await invoke(
      labeled(root, 'Repository URL'),
      'onChangeText',
      'https://github.com/acme/private.git',
    );
    await invoke(labeled(root, 'Clone repository'));
    expect(text(root)).toContain('Sign in to GitHub in Settings.');
    expect(text(root)).not.toContain('libgit2');
  });
});
