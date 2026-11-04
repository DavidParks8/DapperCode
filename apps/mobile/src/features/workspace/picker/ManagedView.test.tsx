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
import { loadManagedWorkspacesAtom } from '../state/managedWorkspaces';
import { formatWorkspaceSize, managedWorkspaceSubtitle } from './ManagedView';
import { WorkspacePickerScreen } from './Screen';

type Node = ReactTestInstance & {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
  findAll(predicate: (node: Node) => boolean): Node[];
};

const DEMO = `${LOCAL_WORKSPACE_ROOT}/Demo`;
const DEMO_LABEL = 'Demo, main · 1 changed · 42 MB · github.com/acme/demo';
const SCRATCH_LABEL = 'Scratch, Not a Git repository · 12 KB';

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
  port.workspaceSizes.set('ws-one', { bytes: 42_000_000, files: 120, truncated: false });
  port.workspaceSizes.set('ws-two', { bytes: 12_288, files: 3, truncated: false });
  return port;
}

describe('managed workspace picker', () => {
  beforeEach(() => {
    (router.back as jest.Mock).mockClear();
  });

  it('lists workspaces with Git metadata and marks the selected one', async () => {
    const { root } = await renderPicker(twoWorkspaces());
    const screen = text(root);
    expect(screen).toContain('main · 1 changed · 42 MB · github.com/acme/demo');
    expect(screen).toContain('Not a Git repository · 12 KB');
    expect(screen).not.toContain('Default workspace');
    expect(screen).not.toContain(' · Selected');
    // Selection is a checkmark on the row, not a " · Selected" suffix.
    expect(control(root, DEMO_LABEL).props['selected']).toBe(true);
    expect(control(root, SCRATCH_LABEL).props['selected']).toBe(false);
  });

  it('loads working-tree state and size after the list and rereads them only when a workspace changes', async () => {
    const port = twoWorkspaces();
    port.workspaceList = [
      ...port.workspaceList,
      { id: 'ws-three', name: 'Broken', isRepository: true },
    ];
    port.workspaceSizes.set('ws-three', { bytes: 3_400_000, files: 50_000, truncated: true });
    const original = port.git.status;
    const originalSize = port.workspaceAdmin.size;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const status = jest.spyOn(port.git, 'status').mockImplementation(async (id) => {
      if (id === 'ws-three') {
        throw new Error('The repository could not be read.');
      }
      await held;
      return original(id);
    });
    const size = jest.spyOn(port.workspaceAdmin, 'size').mockImplementation(async (id) => {
      if (id === 'ws-two') {
        throw new Error('The workspace could not be measured.');
      }
      await held;
      return originalSize(id);
    });
    const { root, store } = await renderPicker(port);
    // The list is usable before any Git status read or size walk finishes.
    expect(text(root)).toContain('main · github.com/acme/demo');
    expect(text(root)).not.toContain('changed');
    expect(text(root)).not.toContain(' MB');

    release();
    await act(flush);
    expect(control(root, DEMO_LABEL).props['selected']).toBe(true);
    // A workspace without Git is never asked for status; every workspace is measured.
    expect(status.mock.calls.map(([id]) => id).sort()).toEqual(['ws-one', 'ws-three']);
    expect(size.mock.calls.map(([id]) => id).sort()).toEqual(['ws-one', 'ws-three', 'ws-two']);
    // An unreadable repository still shows its size, bounded walks read as a lower bound, and an
    // unmeasurable workspace just shows no size.
    expect(control(root, 'Broken, main · Over 3.4 MB · github.com/acme/demo')).toBeTruthy();
    expect(control(root, 'Scratch, Not a Git repository')).toBeTruthy();

    // Reopening without a change reuses the cached state and size; only failed reads run again.
    status.mockClear();
    size.mockClear();
    port.workspaceSizes.set('ws-one', { bytes: 43_000_000, files: 121, truncated: false });
    await act(async () => {
      await store.set(loadManagedWorkspacesAtom);
      await flush();
    });
    expect(status.mock.calls.map(([id]) => id)).toEqual(['ws-three']);
    expect(size.mock.calls.map(([id]) => id)).toEqual(['ws-two']);
    expect(control(root, DEMO_LABEL).props['selected']).toBe(true);

    // A change moves the workspace's change token, so its state and size are read again.
    status.mockImplementation(async (id) => ({
      ...(await original(id)),
      clean: true,
      files: [],
      totalFiles: 0,
    }));
    port.fileMap.set('ws-one:README.md', 'committed');
    await act(async () => {
      await store.set(loadManagedWorkspacesAtom);
      await flush();
    });
    expect(
      control(root, 'Demo, main · Clean · 43 MB · github.com/acme/demo').props['selected'],
    ).toBe(true);
  });

  it('keeps the workspace in use checked and inert', async () => {
    const port = twoWorkspaces();
    const { root, store } = await renderPicker(port);
    const selected = control(root, DEMO_LABEL);
    const button = selected.findAll((node) => node.props['accessibilityRole'] === 'button')[0]!;
    expect(button.props['accessibilityState']).toMatchObject({ selected: true });
    expect(text(root)).toContain('checkmark');

    await invoke(selected);
    expect(port.calls).not.toContain('workspace.select:ws-one');
    expect(router.back).not.toHaveBeenCalled();
    expect(store.get(defaultStartCwdAtom)).toBe(DEMO);

    // Its menu offers no "Use" action; another workspace's menu still does.
    await invoke(control(root, DEMO_LABEL, 'onLongPress'), 'onLongPress');
    expect(root.findAll((node) => node.props['accessibilityLabel'] === 'Use Demo')).toHaveLength(0);
    expect(control(root, 'Rename')).toBeTruthy();
  });

  it('selects a workspace with one tap and records it for first-run setup', async () => {
    const port = twoWorkspaces();
    const { root, store } = await renderPicker(port);
    await invoke(control(root, SCRATCH_LABEL));
    expect(store.get(defaultStartCwdAtom)).toBe(`${LOCAL_WORKSPACE_ROOT}/Scratch`);
    // The runtime's remembered workspace drives the setup checklist and new-chat fallback.
    expect(port.calls).toContain('workspace.select:ws-two');
    expect(port.defaults().workspaceId).toBe('ws-two');
    expect(router.back).toHaveBeenCalled();
  });

  it('stays open and explains a workspace that can no longer be used', async () => {
    const port = twoWorkspaces();
    const { root, store } = await renderPicker(port);
    port.workspaceList = port.workspaceList.filter((entry) => entry.id !== 'ws-two');
    await invoke(control(root, SCRATCH_LABEL));
    expect(store.get(defaultStartCwdAtom)).toBe(DEMO);
    expect(router.back).not.toHaveBeenCalled();
    expect(text(root)).toContain('That workspace is no longer on this iPhone.');
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
    await invoke(control(root, DEMO_LABEL, 'onLongPress'), 'onLongPress');
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
    await invoke(control(root, DEMO_LABEL, 'onLongPress'), 'onLongPress');
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
    const repository = { ...base, isRepository: true, branch: 'dev' };
    const size = { bytes: 42_000_000, files: 9, truncated: false };
    expect(managedWorkspaceSubtitle(repository, { changedFiles: 0, size: null })).toBe(
      'dev · Clean · No remote',
    );
    expect(managedWorkspaceSubtitle(repository, { changedFiles: 3, size })).toBe(
      'dev · 3 changed · 42 MB · No remote',
    );
    expect(managedWorkspaceSubtitle(repository, { changedFiles: null, size })).toBe(
      'dev · 42 MB · No remote',
    );
    expect(
      managedWorkspaceSubtitle({ ...base, isRepository: false }, { changedFiles: 3, size }),
    ).toBe('Not a Git repository · 42 MB');
    expect(
      managedWorkspaceSubtitle(
        { ...base, isRepository: false },
        { changedFiles: null, size: null },
      ),
    ).toBe('Not a Git repository');
  });

  it('formats workspace sizes in decimal units and marks bounded measurements', () => {
    const sized = (bytes: number, truncated = false) =>
      formatWorkspaceSize({ bytes, files: 1, truncated });
    expect(formatWorkspaceSize({ bytes: 0, files: 0, truncated: false })).toBe('Empty');
    expect(sized(200)).toBe('1 KB');
    expect(sized(12_288)).toBe('12 KB');
    expect(sized(999_499)).toBe('999 KB');
    expect(sized(999_500)).toBe('1 MB');
    expect(sized(4_250_000)).toBe('4.3 MB');
    expect(sized(42_000_000)).toBe('42 MB');
    expect(sized(1_340_000_000)).toBe('1.3 GB');
    expect(sized(42_000_000, true)).toBe('Over 42 MB');
  });
});
