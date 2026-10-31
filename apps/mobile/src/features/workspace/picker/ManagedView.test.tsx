jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: Object.assign(({ name }: { name: string }) => name, { glyphMap: {} }),
}));

import { router } from 'expo-router';
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
import { FakeAgentPort } from '../../on-device/transport/testing';
import { LOCAL_WORKSPACE_ROOT } from '../../on-device/transport/wire';
import { managedWorkspaceSubtitle } from './ManagedView';
import { WorkspacePickerScreen } from './Screen';

type Node = ReactTestInstance & {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
  findAll(predicate: (node: Node) => boolean): Node[];
};

const DEMO = `${LOCAL_WORKSPACE_ROOT}/Demo`;

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

function control(root: Node, label: string, handler = 'onPress'): Node {
  const node = root.findAll(
    (candidate) =>
      (candidate.props['accessibilityLabel'] === label || candidate.props['testID'] === label) &&
      typeof candidate.props[handler] === 'function',
  )[0];
  if (!node) {
    throw new Error(`Missing ${label}`);
  }
  return node;
}

function input(root: Node, testID: string): Node {
  const node = root.findAll(
    (candidate) => candidate.type === TextInput && candidate.props['testID'] === testID,
  )[0];
  if (!node) {
    throw new Error(`Missing ${testID}`);
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

async function renderPicker(port: FakeAgentPort) {
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
  store.set(defaultStartCwdAtom, DEMO);
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
            <WorkspacePickerScreen />
          </AppThemeProvider>
        </SafeAreaProvider>,
      ),
    );
    await flush();
  });
  mounted.push(tree!);
  return { root: tree!.root as Node, store };
}

function twoWorkspaces(): FakeAgentPort {
  const port = new FakeAgentPort();
  port.workspaceList = [
    { id: 'ws-one', name: 'Demo', isRepository: true },
    { id: 'ws-two', name: 'Scratch', isRepository: false },
  ];
  return port;
}

describe('managed workspace picker', () => {
  beforeEach(() => {
    (router.back as jest.Mock).mockClear();
  });

  it('lists workspaces with Git metadata and marks the selected one', async () => {
    const { root } = await renderPicker(twoWorkspaces());
    const screen = text(root);
    expect(screen).toContain('main · github.com/acme/demo');
    expect(screen).toContain('Not a Git repository');
    expect(screen).not.toContain('Default workspace');
    expect(screen).not.toContain(' · Selected');
    // Selection is a checkmark on the row, not a " · Selected" suffix.
    expect(control(root, 'Demo, main · github.com/acme/demo').props['selected']).toBe(true);
    expect(control(root, 'Scratch, Not a Git repository').props['selected']).toBe(false);
  });

  it('selects a workspace with one tap', async () => {
    const { root, store } = await renderPicker(twoWorkspaces());
    await invoke(control(root, 'Scratch, Not a Git repository'));
    expect(store.get(defaultStartCwdAtom)).toBe(`${LOCAL_WORKSPACE_ROOT}/Scratch`);
    expect(router.back).toHaveBeenCalled();
  });

  it('creates an empty workspace and uses it', async () => {
    const port = twoWorkspaces();
    const { root, store } = await renderPicker(port);
    await invoke(control(root, 'New workspace'));
    await invoke(input(root, 'workspace-create-sheet-input'), 'onChangeText', 'Notes');
    await invoke(control(root, 'workspace-create-sheet-submit'));
    expect(port.calls).toContain('workspace.create:Notes');
    expect(store.get(defaultStartCwdAtom)).toBe(`${LOCAL_WORKSPACE_ROOT}/Notes`);
  });

  it('renames from the long-press menu and keeps the selection on the renamed workspace', async () => {
    const port = twoWorkspaces();
    const { root, store } = await renderPicker(port);
    await invoke(control(root, 'Demo, main · github.com/acme/demo', 'onLongPress'), 'onLongPress');
    await invoke(control(root, 'Rename'));
    await invoke(input(root, 'workspace-rename-sheet-input'), 'onChangeText', 'Demo app');
    await invoke(control(root, 'workspace-rename-sheet-submit'));
    expect(port.calls).toContain('workspace.rename:ws-one:Demo app');
    expect(store.get(defaultStartCwdAtom)).toBe(`${LOCAL_WORKSPACE_ROOT}/Demo app`);
    expect(text(root)).toContain('Demo app');
  });

  it('deletes by swipe action without a dialog and clears a deleted selection', async () => {
    const port = twoWorkspaces();
    const { root, store } = await renderPicker(port);
    await invoke(control(root, 'Delete workspace Demo'));
    expect(port.calls).toContain('workspace.delete:ws-one');
    expect(store.get(defaultStartCwdAtom)).toBeNull();
    expect(text(root)).not.toContain('github.com/acme/demo');
    expect(text(root)).toContain('Scratch');
  });

  it('offers clone and file browsing', async () => {
    const { root } = await renderPicker(twoWorkspaces());
    await invoke(control(root, 'Clone repository'));
    expect(router.push).toHaveBeenLastCalledWith(
      expect.objectContaining({ pathname: '/profiles/[profileId]/chats/[chatId]/git-checkout' }),
    );
    await invoke(control(root, 'Demo, main · github.com/acme/demo', 'onLongPress'), 'onLongPress');
    await invoke(control(root, 'Browse files'));
    expect(router.push).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pathname: '/profiles/[profileId]/chats/[chatId]/files',
        params: expect.objectContaining({ cwd: DEMO }),
      }),
    );
  });
});

describe('managedWorkspaceSubtitle', () => {
  it('summarizes Git state', () => {
    const base = { name: 'x', path: '/x', branch: null, origin: null };
    expect(managedWorkspaceSubtitle({ ...base, isRepository: false })).toBe('Not a Git repository');
    expect(managedWorkspaceSubtitle({ ...base, isRepository: true, branch: 'dev' })).toBe(
      'dev · No remote',
    );
  });
});
