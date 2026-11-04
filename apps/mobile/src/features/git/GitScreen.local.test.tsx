jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('react-native-gesture-handler', () =>
  jest.requireActual('@shared/testing/gestureHandlerMock'),
);
jest.mock('@expo/vector-icons', () => ({
  Ionicons: Object.assign(({ name }: { name: string }) => name, { glyphMap: {} }),
}));
jest.mock('@shared/feedback', () => ({
  feedback: {
    selection: jest.fn().mockResolvedValue(undefined),
    success: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    warning: jest.fn().mockResolvedValue(undefined),
  },
}));

import { TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { HostBridgeApiClient } from '@bridge/client/client';
import type { Chat } from '@bridge/types/types';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { LocalBridgeWsClient } from '@shell/runtime/LocalBridgeWsClient';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createBridgeTestStore, withAppStore } from '@shell/state/testing';
import { LocalBridgeServer } from '../on-device/transport/server';
import { FakeAgentPort, fakeNativeError } from '../on-device/transport/testing';
import { LOCAL_WORKSPACE_ROOT } from '../on-device/transport/wire';
import type { LocalGitStatus } from '../on-device/workspaces/types';
import { GitScreen } from './GitScreen';

type Node = ReactTestInstance & {
  props: Record<string, unknown>;
  children: unknown[];
  parent: Node | null;
  findAll(predicate: (node: Node) => boolean): Node[];
  findAllByType(type: unknown): Node[];
};

const DEMO = `${LOCAL_WORKSPACE_ROOT}/Demo`;
const chat: Chat = {
  id: 'local-chat',
  title: 'Local chat',
  status: 'complete',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  statusUpdatedAt: '2026-10-01T00:00:00.000Z',
  lastMessagePreview: '',
  cwd: DEMO,
  messages: [],
};

function status(overrides: Partial<LocalGitStatus> = {}): LocalGitStatus {
  return {
    branch: 'main',
    clean: false,
    raw: '?? NOTES.md\n M README.md',
    files: [
      {
        path: 'NOTES.md',
        indexStatus: '?',
        worktreeStatus: '?',
        staged: false,
        unstaged: false,
        untracked: true,
      },
      {
        path: 'README.md',
        indexStatus: ' ',
        worktreeStatus: 'M',
        staged: false,
        unstaged: true,
        untracked: false,
      },
    ],
    truncated: false,
    totalFiles: 2,
    omittedFiles: 0,
    maxFiles: 500,
    maxBytes: 1_000_000,
    stagedFiles: 0,
    hasOrigin: false,
    origin: null,
    upstream: null,
    ahead: null,
    behind: null,
    detached: false,
    unborn: false,
    ...overrides,
  };
}

const WITH_ORIGIN: Partial<LocalGitStatus> = {
  hasOrigin: true,
  origin: 'https://github.com/acme/demo.git',
  upstream: 'origin/main',
  ahead: 2,
  behind: 1,
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

function byLabel(root: Node, label: string): Node {
  const node = root.findAll(
    (candidate) =>
      candidate.props['accessibilityLabel'] === label &&
      (typeof candidate.props['onPress'] === 'function' ||
        typeof candidate.props['onLongPress'] === 'function'),
  )[0];
  if (!node) {
    throw new Error(`Missing control: ${label}`);
  }
  return node;
}

function pressableWithText(root: Node, value: string): Node {
  for (const textNode of root.findAll((node) => node.children.join('') === value)) {
    let current: Node | null = textNode;
    while (current && typeof current.props['onPress'] !== 'function') {
      current = current.parent;
    }
    if (current) {
      return current;
    }
  }
  throw new Error(`Missing pressable: ${value}`);
}

function disabled(node: Node): boolean {
  return node.props['disabled'] === true;
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

async function renderLocalGit(port: FakeAgentPort) {
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
            <GitScreen chat={chat} />
          </AppThemeProvider>
        </SafeAreaProvider>,
      ),
    );
    await flush();
  });
  mounted.push(tree!);
  return { tree: tree!, root: tree!.root as Node };
}

describe('GitScreen on this iPhone', () => {
  it('shows human change labels and lets new files be staged', async () => {
    const port = new FakeAgentPort();
    port.git.status = () => Promise.resolve(status());
    const { root } = await renderLocalGit(port);

    const screen = text(root);
    expect(screen).toContain('New');
    expect(screen).toContain('Modified');
    expect(screen).not.toMatch(/^\?\?$/mu);
    expect(screen).not.toContain('·M');

    // Untracked files used to have no Stage action because native status left `unstaged` false.
    const stageButtons = root.findAll(
      (node) => node.children.join('') === 'Stage' && node.parent !== null,
    );
    expect(stageButtons).toHaveLength(2);
    await invoke(pressableWithText(root, 'Stage'));
    expect(port.calls).toContain('git.stage:["ws-one","NOTES.md"]');
  });

  it('disables commit until something is staged and explains why push and sync are unavailable', async () => {
    const port = new FakeAgentPort();
    port.git.status = () => Promise.resolve(status());
    const { root } = await renderLocalGit(port);

    expect(disabled(pressableWithText(root, 'Stage files first'))).toBe(true);
    expect(disabled(pressableWithText(root, 'Publish branch'))).toBe(true);
    expect(text(root)).toContain(
      'This repository has no origin remote, so there is nowhere to push.',
    );
    expect(disabled(byLabel(root, 'Fetch'))).toBe(true);
    expect(disabled(byLabel(root, 'Pull'))).toBe(true);
    expect(text(root)).toContain('Add an origin remote to fetch and pull.');
    expect(text(root)).toContain('No remote');
  });

  it('blocks push and sync while offline', async () => {
    const port = new FakeAgentPort();
    port.networkValue = 'offline';
    port.git.status = () => Promise.resolve(status(WITH_ORIGIN));
    const { root } = await renderLocalGit(port);

    expect(disabled(pressableWithText(root, 'Push (2)'))).toBe(true);
    expect(text(root)).toContain("You're offline. Connect to the internet to push.");
    expect(disabled(byLabel(root, 'Fetch'))).toBe(true);
    expect(disabled(byLabel(root, 'Pull (1)'))).toBe(true);
  });

  it('shows ahead/behind, fetches, pulls, and explains a diverged pull', async () => {
    const port = new FakeAgentPort();
    port.git.status = () => Promise.resolve(status(WITH_ORIGIN));
    const { root } = await renderLocalGit(port);

    expect(text(root)).toContain('2 ahead, 1 behind');
    expect(text(root)).toContain('origin/main');
    expect(text(root)).toContain('github.com/acme/demo');
    expect(disabled(pressableWithText(root, 'Push (2)'))).toBe(false);

    await invoke(byLabel(root, 'Fetch'));
    expect(port.calls).toContain('git.fetch:["ws-one"]');
    expect(text(root)).toContain('Fetched the latest changes from origin.');

    await invoke(byLabel(root, 'Pull (1)'));
    expect(text(root)).toContain('Fast-forwarded to bbbbbbb.');

    port.git.pull = () =>
      Promise.reject(fakeNativeError('GIT_NON_FAST_FORWARD', 'non-fast-forward'));
    await invoke(byLabel(root, 'Pull (1)'));
    expect(text(root)).toContain('Your branch and its upstream have diverged.');
    expect(text(root)).not.toContain('non-fast-forward');
  });

  it('discards one file by swipe action and all changes only after a deliberate hold', async () => {
    const port = new FakeAgentPort();
    port.git.status = () => Promise.resolve(status());
    const { root } = await renderLocalGit(port);

    await invoke(byLabel(root, 'Discard changes to README.md'));
    expect(port.calls).toContain('git.discard:["ws-one","README.md",true]');
    expect(text(root)).toContain('Discarded changes to README.md.');

    const discardAll = root.findAll(
      (node) =>
        node.props['testID'] === 'git-discard-all' && typeof node.props['onPress'] === 'function',
    )[0]!;
    await invoke(discardAll);
    expect(port.calls.filter((call) => call.startsWith('git.discard:["ws-one",null'))).toEqual([]);
    expect(text(root)).toContain('Touch and hold to discard every unstaged change');
    expect(discardAll.props['delayLongPress']).toBeGreaterThanOrEqual(1000);
    await invoke(discardAll, 'onLongPress');
    expect(port.calls).toContain('git.discard:["ws-one",null,true]');
  });

  it('creates and switches to a new branch from the branch panel', async () => {
    const port = new FakeAgentPort();
    port.git.status = () => Promise.resolve(status());
    const { root } = await renderLocalGit(port);

    await invoke(byLabel(root, 'Change branch'));
    const input = root
      .findAllByType(TextInput)
      .find((node) => node.props['accessibilityLabel'] === 'New branch name')!;
    await invoke(input, 'onChangeText', 'feature/offline');
    await invoke(byLabel(root, 'Create branch'));
    expect(port.calls).toContain('git.createBranch:["ws-one","feature/offline"]');
    expect(text(root)).toContain('Switched to the new branch feature/offline.');
  });

  it('offers Initialize Git instead of a raw error for workspaces without Git', async () => {
    const port = new FakeAgentPort();
    let initialized = false;
    port.git.status = () =>
      initialized
        ? Promise.resolve(status())
        : Promise.reject(fakeNativeError('GIT_NOT_REPOSITORY', 'Native says no repo.'));
    const init = port.git.init;
    port.git.init = async (...args) => {
      initialized = true;
      return init(...args);
    };
    const { root } = await renderLocalGit(port);

    expect(text(root)).toContain("This workspace doesn't use Git yet");
    expect(text(root)).not.toContain('Native says no repo.');

    const origin = root
      .findAllByType(TextInput)
      .find((node) => node.props['accessibilityLabel'] === 'Remote URL, optional')!;
    await invoke(origin, 'onChangeText', 'git@github.com:acme/demo.git');
    expect(text(root)).toContain('Use the HTTPS URL.');
    expect(disabled(pressableWithText(root, 'Initialize Git'))).toBe(true);

    await invoke(origin, 'onChangeText', '');
    await invoke(pressableWithText(root, 'Initialize Git'));
    expect(port.calls).toContain('git.init:["ws-one","main",null]');
    expect(text(root)).not.toContain("This workspace doesn't use Git yet");
    expect(text(root)).toContain('Initialized Git.');
  });

  it('shows the workspace by name with a Files shortcut instead of an editable path', async () => {
    const port = new FakeAgentPort();
    port.git.status = () => Promise.resolve(status());
    const { root } = await renderLocalGit(port);

    expect(
      root
        .findAllByType(TextInput)
        .some((node) => node.props['accessibilityLabel'] === 'Git workspace path'),
    ).toBe(false);
    expect(byLabel(root, 'Browse files in Demo')).toBeDefined();
  });
});
