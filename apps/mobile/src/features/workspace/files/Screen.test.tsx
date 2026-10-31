jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: jest.fn() }));
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: Object.assign(({ name }: { name: string }) => name, { glyphMap: {} }),
}));

import { router } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { HostBridgeApiClient } from '@bridge/client/client';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { LocalBridgeWsClient } from '@shell/runtime/LocalBridgeWsClient';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createBridgeTestStore, withAppStore } from '@shell/state/testing';
import { LocalBridgeServer } from '../../on-device/transport/server';
import { FakeAgentPort } from '../../on-device/transport/testing';
import { LOCAL_WORKSPACE_ROOT } from '../../on-device/transport/wire';
import { LOCAL_FILE_READ_LIMIT } from '../../on-device/transport/workspaceHandlers';
import { FILES_CHANGE_POLL_MS } from './controller';
import { WorkspaceFilesScreen } from './Screen';

type Node = ReactTestInstance & {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
  parent: Node | null;
  findAll(predicate: (node: Node) => boolean): Node[];
  findAllByType(type: unknown): Node[];
};

const DEMO = `${LOCAL_WORKSPACE_ROOT}/Demo`;
const preventRemove = usePreventRemove as jest.Mock;

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

function find(root: Node, predicate: (node: Node) => boolean, what: string): Node {
  const node = root.findAll(predicate)[0];
  if (!node) {
    throw new Error(`Missing ${what}`);
  }
  return node;
}

function control(root: Node, label: string): Node {
  return find(
    root,
    (node) =>
      (node.props['accessibilityLabel'] === label || node.props['testID'] === label) &&
      typeof node.props['onPress'] === 'function',
    label,
  );
}

function input(root: Node, label: string): Node {
  return find(
    root,
    (node) =>
      node.type === TextInput &&
      (node.props['accessibilityLabel'] === label || node.props['testID'] === label),
    label,
  );
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
  jest.useRealTimers();
});

async function renderFiles(port: FakeAgentPort, cwd: string | null = DEMO) {
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
            <WorkspaceFilesScreen cwd={cwd} />
          </AppThemeProvider>
        </SafeAreaProvider>,
      ),
    );
    await flush();
  });
  mounted.push(tree!);
  return { root: tree!.root as Node };
}

function seeded(): FakeAgentPort {
  const port = new FakeAgentPort();
  port.fileMap.set('ws-one:README.md', '# Demo\n');
  port.fileMap.set('ws-one:src/app.ts', 'export const app = 1;\n');
  return port;
}

describe('WorkspaceFilesScreen', () => {
  beforeEach(() => {
    preventRemove.mockClear();
    (router.back as jest.Mock | undefined)?.mockClear?.();
  });

  it('shows the workspace name at the root and folders by icon, not "." or text prefixes', async () => {
    const { root } = await renderFiles(seeded());
    const title = find(root, (node) => node.props['testID'] === 'files-title', 'title');
    expect(text(title)).toBe('Demo');
    expect(text(root)).toContain('README.md');
    expect(text(root)).toContain('src');
    expect(text(root)).not.toContain('Folder:');
    expect(control(root, 'Open folder src')).toBeDefined();
  });

  it('creates new files in the folder being viewed', async () => {
    const port = seeded();
    const { root } = await renderFiles(port);
    await invoke(control(root, 'Open folder src'));
    expect(text(root)).toContain('app.ts');

    await invoke(control(root, 'files-new'));
    await invoke(input(root, 'files-create-sheet-input'), 'onChangeText', 'util.ts');
    await invoke(control(root, 'files-create-sheet-submit'));

    expect(port.fileMap.has('ws-one:src/util.ts')).toBe(true);
    expect(port.fileMap.has('ws-one:util.ts')).toBe(false);
    // The new file opens in the editor.
    expect(input(root, 'files-editor').props['value']).toBe('');
  });

  it('never drops unsaved edits: closing is refused until the user saves or discards', async () => {
    const port = seeded();
    const { root } = await renderFiles(port);
    await invoke(control(root, 'Open README.md'));
    const editor = input(root, 'files-editor');
    expect(editor.props['value']).toBe('# Demo\n');

    await invoke(editor, 'onChangeText', '# Demo\nMore\n');
    expect(
      find(root, (node) => node.props['testID'] === 'files-dirty-indicator', 'dirty dot'),
    ).toBeDefined();
    expect(preventRemove).toHaveBeenLastCalledWith(true, expect.any(Function));

    await invoke(control(root, 'files-back'));
    expect(input(root, 'files-editor').props['value']).toBe('# Demo\nMore\n');
    expect(text(root)).toContain('You have unsaved edits.');

    await invoke(control(root, 'files-save-banner'));
    expect(port.fileMap.get('ws-one:README.md')).toBe('# Demo\nMore\n');
    expect(preventRemove).toHaveBeenLastCalledWith(false, expect.any(Function));
    expect(text(root)).toContain('Saved README.md.');

    await invoke(control(root, 'files-back'));
    expect(root.findAll((node) => node.props['testID'] === 'files-editor')).toHaveLength(0);
  });

  it('discards edits only when asked and reports the navigation guard inline', async () => {
    const port = seeded();
    const { root } = await renderFiles(port);
    await invoke(control(root, 'Open README.md'));
    await invoke(input(root, 'files-editor'), 'onChangeText', 'changed');

    const guard = preventRemove.mock.calls.at(-1)?.[1] as () => void;
    await act(async () => {
      guard();
      await flush();
    });
    expect(text(root)).toContain('You have unsaved edits.');

    await invoke(control(root, 'files-discard-edits'));
    expect(input(root, 'files-editor').props['value']).toBe('# Demo\n');
    expect(port.fileMap.get('ws-one:README.md')).toBe('# Demo\n');
  });

  it('opens large files read-only with their total size', async () => {
    const port = new FakeAgentPort();
    port.fileMap.set('ws-one:big.log', 'x'.repeat(LOCAL_FILE_READ_LIMIT * 3));
    const { root } = await renderFiles(port);
    await invoke(control(root, 'Open big.log'));

    expect(input(root, 'files-editor').props['editable']).toBe(false);
    expect(text(root)).toContain('Showing the first 64 KB of 192 KB.');
    expect(text(root)).not.toContain('the agent can search');
  });

  it('renames by long press and deletes by swipe action', async () => {
    const port = seeded();
    const { root } = await renderFiles(port);

    const readme = find(
      root,
      (node) =>
        node.props['accessibilityLabel'] === 'Open README.md' &&
        typeof node.props['onLongPress'] === 'function',
      'README row',
    );
    await invoke(readme, 'onLongPress');
    await invoke(input(root, 'files-rename-sheet-input'), 'onChangeText', 'GUIDE.md');
    await invoke(control(root, 'files-rename-sheet-submit'));
    expect(port.fileMap.has('ws-one:GUIDE.md')).toBe(true);
    expect(text(root)).toContain('GUIDE.md');

    await invoke(control(root, 'Delete GUIDE.md'));
    expect(port.fileMap.has('ws-one:GUIDE.md')).toBe(false);
    expect(text(root)).not.toContain('GUIDE.md\n');
  });

  it('refreshes the listing when the workspace change token moves', async () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick'] });
    const port = seeded();
    const { root } = await renderFiles(port);
    expect(text(root)).not.toContain('AGENT.md');

    port.fileMap.set('ws-one:AGENT.md', 'written by the agent');
    await act(async () => {
      jest.advanceTimersByTime(FILES_CHANGE_POLL_MS);
      await flush();
    });
    expect(text(root)).toContain('AGENT.md');
  });

  it('explains a missing workspace instead of showing a native error', async () => {
    const { root } = await renderFiles(new FakeAgentPort(), null);
    expect(text(root)).toContain('Choose a workspace');
    expect(text(root)).not.toMatch(/WORKSPACE_REQUIRED|Exception/u);
  });
});
